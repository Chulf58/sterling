// Background maintenance worker launcher and runner core
// (scripts/hooks/lib/maintenance-worker.mjs; decision
// maintenance-queue-background-haiku-worker-simple-redesign). Every test
// injects spawn (and the git probe): nothing here starts a real claude, a real
// runner, or reads a real repo's status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  hasEvidence,
  gitState,
  judgedVerdicts,
  rotateJournal,
  WORKER_RUN_BUDGET_USD,
  buildWorkerArgs,
  dirtyPaths,
  maybeLaunchMaintenanceWorker,
  handoffVerdicts,
  workerWriteCount,
  findStamp,
  selectBatch,
  RUN_BATCH_MAX,
  STAMP_KEY,
  WORKER_CAPABILITY,
  WORKER_LANES,
  POLICY_VERSION,
  resolveMcpConfig,
  rotateIfLarge,
  runWorker,
  streamJournal,
  unjudgedWorkerItems,
  workerBreakage,
  workerPaths,
  workerPrompt,
  WORKER_TOOLS,
  WORKER_DISALLOWED_TOOLS,
  BACKOFF_MS,
  BATCH_MIN_ITEMS,
  BATCH_MAX_WAIT_MS,
  DEBOUNCE_MS,
  LOCK_STALE_MS,
  ROTATE_BYTES,
} from '../hooks/lib/maintenance-worker.mjs';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const ITEM = (id, keys = ['src/a.mjs']) => ({ id, system_reason: 'reconcile_needed', text: `reconcile article '${id}'`, file_keys: keys });
const HEAD = 'a'.repeat(40);
/** A fake git for the launcher: `rev-parse HEAD --show-prefix` answers HEAD and
 *  `prefix`; `status` answers `porcelain`. Every call is recorded. */
function fakeGit({ head = HEAD, prefix = '', porcelain = '', revParse = null, status = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args.includes('rev-parse')) return revParse ?? { status: 0, stdout: `${head}\n${prefix}\n` };
    return status ?? { status: 0, stdout: porcelain };
  };
  fn.calls = calls;
  return fn;
}
const CLEAN_GIT = fakeGit();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-mworker-'));
  const plugin = join(base, 'plugin');
  const project = join(base, 'project');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'templates'), { recursive: true });
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"sterling"}');
  writeFileSync(
    join(plugin, '.claude-plugin', 'sterling-mcp.json'),
    JSON.stringify({ mcpServers: { sterling: { command: '/usr/bin/node', args: ['/clone/packages/mcp-server/dist/main.js', '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'] } } })
  );
  writeFileSync(join(plugin, 'templates', 'maintenance-worker-prompt.md'), 'PROMPT BODY');
  writeFileSync(join(plugin, 'scripts', 'maintenance-worker-run.mjs'), '// runner stub, never executed by these tests\n');
  mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
  return { plugin, project, paths: workerPaths(join(base, 'project')), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A fake spawn recording each call; the returned child is an inert emitter. */
function fakeSpawn({ pid = 4242, throws = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (throws) throw throws;
    const child = new EventEmitter();
    child.pid = pid;
    child.unref = () => {
      child.unrefed = true;
    };
    calls.at(-1).child = child;
    return child;
  };
  return { fn, calls };
}

function launch(fx, over = {}) {
  return maybeLaunchMaintenanceWorker({
    root: fx.project,
    config: null,
    items: [ITEM('i1'), ITEM('i2', ['src/b.mjs'])],
    trigger: 'stop',
    now: NOW,
    pluginRoot: fx.plugin,
    env: {},
    isAlive: () => false,
    spawnSync: CLEAN_GIT,
    ...over,
  });
}

const writeState = (fx, state) => writeFileSync(fx.paths.state, JSON.stringify(state));
const journalLine = (fx, entry) => appendFileSync(fx.paths.journal, JSON.stringify(entry) + '\n');

test('skips when no open reconcile_needed item is unjudged, and never spawns', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    assert.deepEqual(launch(fx, { items: [], spawn: sp.fn }), { launched: false, reason: 'queue_empty' });
    assert.equal(sp.calls.length, 0);
    assert.equal(existsSync(fx.paths.lock), false, 'no lock taken');
  } finally {
    fx.cleanup();
  }
});

test('[finding 3] an item handed off (needs_conductor) in the JSONL for its CURRENT file_keys is not launchable; a re-mint that adds a path makes it launchable again', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'a', verdict: 'needs_conductor', file_keys: ['src/x.mjs'], reason: 'new flag', evidence: true, capability: WORKER_CAPABILITY });
    journalLine(fx, { kind: 'verdict', item_id: 'b', verdict: 'needs_conductor', file_keys: ['src/y.mjs'], reason: 'r', evidence: true, capability: WORKER_CAPABILITY });
    appendFileSync(fx.paths.journal, '{"torn line\n');
    const items = [ITEM('a', ['src/x.mjs']), ITEM('b', ['src/z.mjs', 'src/y.mjs']), ITEM('c')];
    const seen = [];
    const store = { count: (f) => (seen.push(['count', f]), items.length), query: (f) => (seen.push(['query', f]), items) };
    const out = unjudgedWorkerItems(store, fx.project).map((t) => t.id);
    assert.deepEqual(out, ['b', 'c'], "a is judged for its current keys; b's keys widened since its verdict; c was never judged");
    assert.deepEqual(seen[1], ['query', { types: ['todo'], source: 'system', cap: 3 }], 'the query cap IS the count, so it cannot truncate');
    assert.ok(workerPrompt(fx.plugin, fx.project).includes('ALREADY JUDGED (skip each'), 'the child is told which items to skip');
    assert.ok(workerPrompt(fx.plugin, fx.project).includes('- a needs_conductor file_keys ["src/x.mjs"]'));
  } finally {
    fx.cleanup();
  }
});

test('takes the lock, spawns ONE detached runner with log stdio, token and budget, and a second launch is refused while it lives', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn({ pid: 4242 });
    const r = launch(fx, { spawn: sp.fn });
    assert.equal(r.launched, true, JSON.stringify(r));
    assert.equal(sp.calls.length, 1);
    const call = sp.calls[0];
    const lock = JSON.parse(readFileSync(fx.paths.lock, 'utf8'));
    assert.equal(call.cmd, process.execPath);
    assert.deepEqual(call.args, [join(fx.plugin, 'scripts', 'maintenance-worker-run.mjs'), '--project', fx.project, '--trigger', 'stop', '--token', lock.token, '--budget-usd', '5']);
    assert.equal(call.opts.detached, true);
    assert.equal(call.opts.stdio[0], 'ignore');
    assert.equal(typeof call.opts.stdio[1], 'number', 'stdout goes to the log fd');
    assert.equal(call.opts.stdio[1], call.opts.stdio[2], 'stderr goes to the same log fd');
    assert.equal(call.opts.env.STERLING_MAINTENANCE_WORKER, '1', 'the child is marked so it can never launch another worker');
    assert.equal(call.child.unrefed, true);
    assert.equal(lock.pid, 4242);

    const sp2 = fakeSpawn();
    const again = launch(fx, { spawn: sp2.fn, now: NOW + DEBOUNCE_MS * 10, isAlive: (pid) => pid === 4242 });
    assert.deepEqual(again, { launched: false, reason: 'already_running' });
    assert.equal(sp2.calls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test('recovers a stale lock: a dead pid, or a live pid older than LOCK_STALE_MS, or unreadable content', () => {
  const fx = fixture();
  try {
    writeFileSync(fx.paths.lock, JSON.stringify({ pid: 999999, started_at: new Date(NOW - 60_000).toISOString(), token: 'old' }));
    const r = launch(fx, { spawn: fakeSpawn({ pid: 5151 }).fn, isAlive: () => false });
    assert.equal(r.launched, true, 'a dead pid frees the slot');
    assert.equal(JSON.parse(readFileSync(fx.paths.lock, 'utf8')).pid, 5151);

    writeFileSync(fx.paths.lock, JSON.stringify({ pid: 5151, started_at: new Date(NOW - LOCK_STALE_MS - 1).toISOString(), token: 'old' }));
    rmSync(fx.paths.lastLaunch);
    assert.equal(launch(fx, { spawn: fakeSpawn({ pid: 6262 }).fn, isAlive: () => true }).launched, true, 'an over-age lock is stale even when its pid answers (pid reuse)');

    writeFileSync(fx.paths.lock, 'not json');
    rmSync(fx.paths.lastLaunch);
    assert.equal(launch(fx, { spawn: fakeSpawn().fn }).launched, true, 'an unreadable lock is stale');
  } finally {
    fx.cleanup();
  }
});

test('[finding 5] stale-lock takeover is atomic: while one taker holds the takeover mutex a second gets nothing, and a lock re-judged live inside the mutex is left alone', () => {
  const fx = fixture();
  try {
    const stale = { pid: 1, started_at: new Date(NOW - 60_000).toISOString(), token: 'old' };
    writeFileSync(fx.paths.lock, JSON.stringify(stale));
    mkdirSync(fx.paths.takeover); // another hook is mid-takeover
    assert.equal(acquireLock(fx.paths, { pid: 2, started_at: new Date(NOW).toISOString() }, NOW, () => false), null, 'the second taker backs off');
    assert.equal(JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token, 'old', 'and removes nothing');
    rmSync(fx.paths.takeover, { recursive: true });

    // The first taker won: its fresh lock is what a late second taker now sees.
    const t1 = acquireLock(fx.paths, { pid: 3, started_at: new Date(NOW).toISOString() }, NOW, () => false);
    assert.ok(t1, 'the stale lock is taken over');
    assert.equal(JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token, t1, 'the winner verified its own token');
    assert.equal(existsSync(fx.paths.takeover), false, 'the mutex is released');
    const t2 = acquireLock(fx.paths, { pid: 4, started_at: new Date(NOW).toISOString() }, NOW, (pid) => pid === 3);
    assert.equal(t2, null, "a second taker finds the winner's lock live and never removes it");
    assert.equal(JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token, t1);
  } finally {
    fx.cleanup();
  }
});

test('debounce: a burst inside DEBOUNCE_MS starts one worker; after the window a new one may start', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    assert.equal(launch(fx, { spawn: sp.fn, trigger: 'commit' }).launched, true);
    rmSync(fx.paths.lock); // the first worker finished quickly
    assert.deepEqual(launch(fx, { spawn: sp.fn, trigger: 'commit', now: NOW + 1000 }), { launched: false, reason: 'debounced' });
    assert.deepEqual(launch(fx, { spawn: sp.fn, trigger: 'stop', now: NOW + DEBOUNCE_MS - 1 }), { launched: false, reason: 'debounced' });
    assert.equal(sp.calls.length, 1);
    assert.equal(launch(fx, { spawn: sp.fn, now: NOW + DEBOUNCE_MS + 1 }).launched, true);
    assert.equal(sp.calls.length, 2);
  } finally {
    fx.cleanup();
  }
});

test('[finding 2a] an item with an uncommitted change to any file_key is not launchable; only clean items count, via ONE git status call without a shell', () => {
  const fx = fixture();
  try {
    const dirtyA = fakeGit({ porcelain: ' M src/a.mjs\0R  src/new.mjs\0src/b.mjs\0' });
    const sp = fakeSpawn();
    assert.deepEqual(launch(fx, { spawn: sp.fn, spawnSync: dirtyA }), { launched: false, reason: 'none_eligible' }, 'a.mjs is modified and b.mjs is the source of a staged rename');
    const statusCalls = dirtyA.calls.filter((c) => c.args.includes('status'));
    assert.equal(statusCalls.length, 1, 'ONE status call');
    assert.equal(statusCalls[0].cmd, 'git');
    assert.deepEqual(statusCalls[0].args, ['-C', fx.project, 'status', '--porcelain', '-z', '--untracked-files=all', '--', 'src/a.mjs', 'src/b.mjs']);
    assert.equal(statusCalls[0].opts.shell, undefined, 'no shell');
    assert.equal(sp.calls.length, 0);

    const r = launch(fx, { spawn: sp.fn, items: [ITEM('i1'), ITEM('i3', ['src/c.mjs'])], spawnSync: fakeGit({ porcelain: ' M src/a.mjs\0' }) });
    assert.equal(r.launched, true);
    assert.equal(r.items, 1, 'only the clean item counts');
    assert.deepEqual([...dirtyPaths(fx.project, ['x'], () => ({ status: 128, stdout: '' })) ?? ['null']], ['null'], 'a git failure is null, not "clean"');
  } finally {
    fx.cleanup();
  }
});

test('builds the probed claude argv: Sonnet 5.5, medium effort, librarian, dontAsk, every tool named, every write denied, strict MCP, stream-json + verbose, budget cap', () => {
  const fx = fixture();
  try {
    const mcpConfig = resolveMcpConfig(fx.plugin, fx.project);
    assert.deepEqual(JSON.parse(mcpConfig), {
      mcpServers: { sterling: { command: '/usr/bin/node', args: ['/clone/packages/mcp-server/dist/main.js', '--store', `${fx.project}/.sterling/sterling.db`] } },
    }, "the plugin's own wiring, with ${CLAUDE_PROJECT_DIR} bound to THIS project's store");
    const args = buildWorkerArgs({ prompt: 'P', mcpConfig });
    assert.deepEqual(args, [
      '-p', 'P',
      '--model', 'claude-sonnet-5-5',
      '--effort', 'medium',
      '--agent', 'librarian',
      '--permission-mode', 'dontAsk',
      '--allowedTools', WORKER_TOOLS.join(','),
      '--disallowedTools', WORKER_DISALLOWED_TOOLS.join(','),
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-budget-usd', '5',
    ]);
    // CHANGED (GitHub #56, decision maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet,
    // ruling (3) and design (c)): the update-shaped knowledge writes, knowledge_query and knowledge_schema
    // join under both mounted names, plus WebSearch and WebFetch; still no board_update.
    const both = (t) => [`mcp__sterling__${t}`, `mcp__plugin_sterling_sterling__${t}`];
    assert.deepEqual(WORKER_TOOLS, [
      'mcp__sterling__maintenance_query', 'mcp__sterling__knowledge_get', 'mcp__sterling__maintenance_remove',
      ...both('knowledge_line_ref_fix'),
      ...['knowledge_update', 'knowledge_edit', 'knowledge_append', 'knowledge_array_remove', 'knowledge_query', 'knowledge_schema'].flatMap(both),
      'Read', 'Grep', 'WebSearch', 'WebFetch',
    ], '[finding 3] no board_update');
    for (const banned of ['--bare', 'bypassPermissions', '--plugin-dir', '--dangerously-skip-permissions']) {
      assert.ok(!args.includes(banned), `${banned} is never passed`);
    }
  } finally {
    fx.cleanup();
  }
});

test("the COMMITTED plugin wiring resolves with no placeholder left: ${CLAUDE_PLUGIN_ROOT} binds to the plugin root, ${CLAUDE_PROJECT_DIR} to the project", () => {
  // The committed .claude-plugin/sterling-mcp.json names the bundle through
  // ${CLAUDE_PLUGIN_ROOT}; Claude Code expands that only for a plugin's own MCP
  // config, so an unbound placeholder handed to the headless child via
  // --mcp-config would start no server at all.
  const fx = fixture();
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    writeFileSync(join(fx.plugin, '.claude-plugin', 'sterling-mcp.json'), readFileSync(join(repoRoot, '.claude-plugin', 'sterling-mcp.json'), 'utf8'));
    const resolved = resolveMcpConfig(fx.plugin, fx.project);
    assert.doesNotMatch(resolved, /\$\{CLAUDE_[A-Z_]+\}/, 'every placeholder is bound');
    const entry = JSON.parse(resolved).mcpServers.sterling;
    assert.equal(entry.command, 'node');
    assert.ok(entry.args.includes(`${fx.plugin}/mcp/sterling-mcp.mjs`), `the bundle resolves under the plugin root: ${entry.args}`);
    // The committed wiring launches with --project <root> (89fa1568: routing picks
    // SQLite or Postgres from the project's config), so the project the store
    // resolves under is the value that follows --project, and no --store path is passed.
    assert.equal(entry.args[entry.args.indexOf('--project') + 1], fx.project, `the store resolves under the project: ${entry.args}`);
    assert.ok(!entry.args.includes('--store'), `no SQLite --store path is passed: ${entry.args}`);
  } finally {
    fx.cleanup();
  }
});

test('a missing plugin wiring names the plugin tree as incomplete, never "run /sterling:init in the clone"', () => {
  const fx = fixture();
  try {
    rmSync(join(fx.plugin, '.claude-plugin', 'sterling-mcp.json'));
    assert.throws(() => resolveMcpConfig(fx.plugin, fx.project), (e) => /cannot read the plugin MCP wiring/.test(e.message) && /reinstall the plugin/.test(e.message) && !/sterling:init/.test(e.message));
  } finally {
    fx.cleanup();
  }
});

test('[finding 4] --disallowedTools names every record-shaping store write, every board and config write plus Write, Edit and Bash, and none is also allowed', () => {
  // CHANGED (GitHub #56, design (c)): update, append, edit and array_remove moved to the grant; the
  // record-shaping writes stay denied.
  const expected = [
    ...['create', 'retire', 'supersede', 'split', 'extract', 'promote', 'link'].map((v) => `mcp__sterling__knowledge_${v}`),
    ...['add', 'remove', 'update', 'edit'].map((v) => `mcp__sterling__board_${v}`),
    'mcp__sterling__config_set',
    'mcp__sterling__domain_describe',
    'Write',
    'Edit',
    'Bash',
  ];
  assert.deepEqual(WORKER_DISALLOWED_TOOLS, expected);
  assert.equal(WORKER_TOOLS.filter((t) => WORKER_DISALLOWED_TOOLS.includes(t)).length, 0);
});

test('kill switch: maintenance_worker.enabled false, the test-run env flag, and the inside-worker flag each stop the launch', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    assert.deepEqual(launch(fx, { spawn: sp.fn, config: { maintenance_worker: { enabled: false } } }), { launched: false, reason: 'disabled' });
    assert.deepEqual(launch(fx, { spawn: sp.fn, env: { STERLING_MAINTENANCE_WORKER_DISABLE: '1' } }), { launched: false, reason: 'disabled_env' });
    assert.deepEqual(launch(fx, { spawn: sp.fn, env: { STERLING_MAINTENANCE_WORKER: '1' } }), { launched: false, reason: 'inside_worker' });
    assert.equal(sp.calls.length, 0);
    assert.equal(launch(fx, { spawn: sp.fn, config: { maintenance_worker: { enabled: true } } }).launched, true, 'enabled true launches');
  } finally {
    fx.cleanup();
  }
});

test('[no daily cap] a large prior spend today (even the Dome Farmer 4.874 of 5, or 50 USD) still launches, with the per-run budget of WORKER_RUN_BUDGET_USD; a stale daily_budget_usd in config is ignored (decision maintenance-worker-notices-session-start-only-and-no-sliver-launch, point 3)', () => {
  const fx = fixture();
  try {
    for (const spend of [4.874, 5, 50]) {
      const sp = fakeSpawn();
      rmSync(fx.paths.lastLaunch, { force: true });
      rmSync(fx.paths.lock, { force: true });
      writeState(fx, { spend: { '2026-09-29': spend } });
      const r = launch(fx, { spawn: sp.fn, config: { maintenance_worker: { daily_budget_usd: 3 } } });
      assert.equal(r.launched, true, `spend ${spend} does not block a launch`);
      assert.equal(sp.calls[0].args.at(-1), String(WORKER_RUN_BUDGET_USD), 'every launch gets the full per-run cap, never a remainder');
    }
    assert.equal(WORKER_RUN_BUDGET_USD, 5, 'CHANGED (GitHub #56, design (g)): the per-run cap rose from $2 to $5');
  } finally {
    fx.cleanup();
  }
});

test('[finding 1+8] back-off: no relaunch for BACKOFF_MS after a failed run (error_max_budget included); the reason goes to the log, never to a hook line; the relaunch after it is silent too', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const at = new Date(NOW - 60_000).toISOString();
    writeState(fx, { spend: {}, last_run: { ok: false, at, error: 'error result (error_max_budget_usd)' } });
    const r = launch(fx, { spawn: sp.fn });
    assert.equal(r.reason, 'backoff');
    assert.equal(r.line, undefined, 'no hook line: the ruling keeps worker status out of Stop and commit output');
    assert.match(readFileSync(fx.paths.log, 'utf8'), /backoff: last run FAILED at .*error_max_budget_usd.*backing off, no relaunch before/);
    assert.equal(sp.calls.length, 0);
    const later = launch(fx, { spawn: sp.fn, now: Date.parse(at) + BACKOFF_MS + 1 });
    assert.equal(later.launched, true);
    assert.equal(later.line, undefined, 'a launch after the back-off prints nothing either');
  } finally {
    fx.cleanup();
  }
});

test('a spawn failure is logged (never printed), frees the lock, and never throws', () => {
  const fx = fixture();
  try {
    const r = launch(fx, { spawn: fakeSpawn({ throws: new Error('spawn EACCES') }).fn });
    assert.equal(r.launched, false);
    assert.equal(r.reason, 'error');
    assert.equal(r.line, undefined);
    assert.match(r.detail, /launch FAILED \(spawn: spawn EACCES\)/);
    assert.equal(r.detail.split('\n').length, 1, 'exactly one line');
    assert.match(readFileSync(fx.paths.log, 'utf8'), /error: launch FAILED \(spawn: spawn EACCES\)/);
    assert.equal(existsSync(fx.paths.lock), false, 'the slot is freed for the next trigger');

    rmSync(fx.paths.state, { force: true }); // a launcher failure arms the back-off (M2); each case here starts clean
    const broken = launch(fx, { spawn: fakeSpawn().fn, pluginRoot: join(fx.plugin, 'nope'), now: NOW + DEBOUNCE_MS * 2 });
    assert.match(broken.detail, /launch FAILED \(cannot read the plugin MCP wiring/, 'a broken install is loud in the hook, not silent in a detached process');

    rmSync(fx.paths.state, { force: true });
    const storeFail = launch(fx, { items: undefined, store: { count: () => { throw new Error('db locked'); } }, spawn: fakeSpawn().fn });
    assert.match(storeFail.detail, /launch FAILED \(db locked\)/);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ runner core

/** A fake claude child for runWorker: emits stream-json `events`, then closes with `code`. */
function fakeClaude(events, { code = 0, hang = false } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (sig) => {
      child.killed = sig;
      setImmediate(() => child.emit('close', null));
    };
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
      child.stdout.emit('data', text.slice(0, 40)); // a line split across chunks
      child.stdout.emit('data', text.slice(40));
      if (!hang) child.emit('close', code);
    });
    return child;
  };
  return { fn, calls };
}

const toolOk = (toolId) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } });
const toolErr = (toolId, text = 'Error: not found') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: true }] } });
const toolUse = (toolId, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name, input }] } });
const removeCall = (toolId, itemId) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'mcp__sterling__maintenance_remove', input: { id: itemId } }] } });
const removeResult = (toolId, text, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: isError }] } });
const resultEvent = (over) => ({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.25, permission_denials: [], ...over });
const readJournal = (fx) => readFileSync(fx.paths.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const quiet = { log: () => {} };

test('[finding 7] runWorker journals every maintenance_remove call and result from the stream, then the verdicts; the lock is released', async () => {
  const fx = fixture();
  try {
    const result = [
      '{"item_id":"11111111-1111-1111-1111-111111111111","article":"a","verdict":"closed","reason":"article already names the new flag"}',
      '{"item_id":"22222222-2222-2222-2222-222222222222","article":"b","verdict":"needs_conductor","file_keys":["src/b.mjs"],"reason":"new refusal not described"}',
    ].join('\n');
    const sp = fakeClaude([
      { type: 'system', subtype: 'init' },
      toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'bbbbbbbb-0000-0000-0000-000000000000' }),
      toolOk('k1'),
      toolUse('r1', 'Read', { file_path: 'src/b.mjs' }),
      toolOk('r1'),
      removeCall('t1', '11111111-1111-1111-1111-111111111111'),
      removeResult('t1', removedText('11111111-1111-1111-1111-111111111111')),
      removeCall('t2', '33333333-3333-3333-3333-333333333333'),
      removeResult('t2', 'refused: worktree differs from HEAD', true),
      resultEvent({ result }),
    ]);
    writeState(fx, { spend: { '2026-09-29': 1 } });
    writeFileSync(fx.paths.lock, JSON.stringify({ pid: process.pid, started_at: new Date(NOW).toISOString(), token: 'tok' }));
    writeFileSync(
      fx.paths.eligible,
      JSON.stringify({
        token: 'tok',
        head: HEAD,
        run_id: RUN_ID,
        items: [
          { id: '11111111-1111-1111-1111-111111111111', file_keys: ['src/a.mjs'], feature_link: null, slug: null },
          { id: '22222222-2222-2222-2222-222222222222', file_keys: ['src/b.mjs'], feature_link: 'bbbbbbbb-0000-0000-0000-000000000000', slug: 'b' },
        ],
      })
    );
    const code = await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: sp.fn, trigger: 'stop', token: 'tok', budgetUsd: 2, now: () => NOW, ...quiet });
    assert.equal(code, 0);
    assert.equal(sp.calls[0].cmd, 'claude');
    assert.ok(sp.calls[0].args[1].startsWith('PROMPT BODY\n'), 'the shipped prompt file leads the -p argument');
    const lines = readJournal(fx);
    assert.deepEqual(lines.map((l) => l.kind), ['tool_call', 'tool_call', 'verdict', 'verdict', 'run_summary']);
    assert.deepEqual([lines[0].item_id, lines[0].is_error, lines[0].result], ['11111111-1111-1111-1111-111111111111', false, removedText('11111111-1111-1111-1111-111111111111')]);
    assert.deepEqual(lines[0].stamp, { run_id: RUN_ID, item_id: '11111111-1111-1111-1111-111111111111', resolved: ['11111111-1111-1111-1111-111111111111'] });
    assert.equal(lines[1].is_error, true, 'a refused close is on record too');
    assert.deepEqual([lines[0].item_file_keys_at_launch, lines[1].item_file_keys_at_launch], [['src/a.mjs'], null], 'an id not in eligible.json journals null');
    assert.equal(lines[3].verdict, 'needs_conductor');
    assert.equal(lines[3].capability, WORKER_CAPABILITY, 'a handoff carries the capability marker');
    assert.equal(lines[4].remove_calls, 2);
    assert.deepEqual([...handoffVerdicts(fx.project).keys()], ['22222222-2222-2222-2222-222222222222']);
    const state = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.equal(state.spend, undefined, 'no per-day spend accounting: a legacy spend map is dropped, not carried');
    assert.equal(state.last_run.cost_usd, 0.25, 'the run keeps its own reported cost');
    assert.equal(state.last_run.ok, true);
    assert.equal(existsSync(fx.paths.lock), false, 'the lock is released when the child exits');
  } finally {
    fx.cleanup();
  }
});

test('runWorker: a non-zero exit, an error_max_budget result or a permission denial is recorded as a FAILED run, never a silent success', async () => {
  const fx = fixture();
  try {
    const denied = fakeClaude([resultEvent({ permission_denials: [{ tool_name: 'mcp__sterling__maintenance_remove' }] })]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: denied.fn, trigger: 'commit' }), 1);
    assert.match(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.error, /1 permission denial/);

    const budget = fakeClaude([resultEvent({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.01 })]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: budget.fn, trigger: 'stop' }), 1);
    const st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.match(st.last_run.error, /error_max_budget_usd/);
    assert.equal(st.last_run.cost_usd, 2.01, 'a failed run still records its reported cost');

    const crashed = fakeClaude(['not json'], { code: 3 });
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: crashed.fn, trigger: 'stop' }), 1);
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.match(last.error, /exit 3/);
    assert.match(last.error, /no stream-json result event/);
  } finally {
    fx.cleanup();
  }
});

test('[finding 6] a hung child is killed after the timeout and recorded as a failed run; its streamed closes stay on record', async () => {
  const fx = fixture();
  try {
    const hung = fakeClaude([removeCall('t1', 'aaaa'), removeResult('t1', 'Closed')], { hang: true });
    const code = await runWorker({ ...eligibleRun(fx, []), spawn: hung.fn, trigger: 'stop', timeoutMs: 30 });
    assert.equal(code, 1);
    assert.equal(hung.calls[0].child.killed, 'SIGTERM');
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, false);
    assert.match(last.error, /killed after 0 min timeout/);
    assert.equal(readJournal(fx)[0].item_id, 'aaaa');
    assert.equal(existsSync(fx.paths.lock), false);
  } finally {
    fx.cleanup();
  }
});

test('[finding 5] the runner refuses to run when the lock token is not its own', async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.paths.lock, JSON.stringify({ pid: 1, started_at: new Date(NOW).toISOString(), token: 'someone-else' }));
    const sp = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: sp.fn, token: 'mine', ...quiet }), 1);
    assert.equal(sp.calls.length, 0);
    assert.equal(JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token, 'someone-else', "another worker's lock is never released");
  } finally {
    fx.cleanup();
  }
});

test('[finding 9] the log and the JSONL rotate to a single .1 backup past ROTATE_BYTES; owes-prose verdicts in the backup still count', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'old', verdict: 'needs_conductor', file_keys: ['k'], evidence: true, capability: WORKER_CAPABILITY });
    appendFileSync(fx.paths.journal, 'x'.repeat(ROTATE_BYTES));
    writeFileSync(`${fx.paths.journal}.1`, 'previous backup');
    rotateIfLarge(fx.paths.journal);
    assert.equal(existsSync(fx.paths.journal), false);
    assert.ok(statSync(`${fx.paths.journal}.1`).size > ROTATE_BYTES, 'the single backup is replaced');
    assert.deepEqual([...handoffVerdicts(fx.project).keys()], ['old']);
    writeFileSync(fx.paths.log, 'small');
    rotateIfLarge(fx.paths.log);
    assert.equal(readFileSync(fx.paths.log, 'utf8'), 'small', 'a small file is left alone');
    rotateIfLarge(join(fx.project, 'missing'));
  } finally {
    fx.cleanup();
  }
});

test('streamJournal: a maintenance_remove with no result before the stream ends is still journalled', () => {
  const entries = [];
  const s = streamJournal((e) => entries.push(e));
  s.feed(JSON.stringify(removeCall('t9', 'zzz')) + '\n');
  s.end();
  assert.deepEqual(entries, [{ kind: 'tool_call', tool: 'maintenance_remove', item_id: 'zzz', item_file_keys_at_launch: null, is_error: null, result: 'no result before the run ended' }]);
});

test('streamJournal: a maintenance_remove line carries the launch-time file_keys in full even when result is truncated; null when the id was not offered', () => {
  const entries = [];
  const keys = ['src/a.mjs', 'src/b/'.repeat(120)];
  const s = streamJournal((e) => entries.push(e), () => {}, new Map([['aaa', keys], ['ccc', ['src/c.mjs']]]));
  const long = JSON.stringify({ removed: 'aaa', artifact_evidence: [{ id: 'x', title: 'y'.repeat(600) }] });
  s.feed([removeCall('t1', 'aaa'), removeResult('t1', long), removeCall('t2', 'bbb'), removeResult('t2', '{"removed":"bbb"}'), removeCall('t3', 'ccc')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  s.end();
  assert.equal(entries[0].result.length, 400, 'result keeps its existing truncation');
  assert.deepEqual(entries[0].item_file_keys_at_launch, keys, 'file_keys are recorded in full, beyond the truncated result');
  assert.equal(entries[1].item_file_keys_at_launch, null, 'an id not in eligible.json is null');
  assert.deepEqual(entries[2].item_file_keys_at_launch, ['src/c.mjs'], 'the no-result line carries them too');
  assert.equal(entries[2].is_error, null);
});

test('runWorker --dry-run prints the argv and spawns nothing', async () => {
  const fx = fixture();
  try {
    const printed = [];
    const code = await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: () => assert.fail('dry run must not spawn'), dryRun: true, out: (s) => printed.push(s) });
    assert.equal(code, 0);
    const out = JSON.parse(printed[0]);
    assert.equal(out.dry_run, true);
    assert.equal(out.command, 'claude');
    assert.deepEqual(out.argv.slice(2, 6), ['--model', 'claude-sonnet-5-5', '--effort', 'medium']);
    assert.equal(existsSync(fx.paths.lock), false);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ re-check residuals (N1-N4, PARTIAL 2 and 9)

test('[N1] a run with no result event (crashed, killed, hung) records an unknown cost (null), never $0, and no spend map', async () => {
  const fx = fixture();
  try {
    const crashed = fakeClaude(['not json'], { code: 1 });
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: crashed.fn, budgetUsd: 1.5 }), 1);
    let st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.equal(st.last_run.cost_usd, null, 'the reported cost stays unknown');
    assert.equal(st.last_run.charged_usd, undefined, 'nothing is charged against a cap that no longer exists');
    assert.equal(st.spend, undefined);

    const hung = fakeClaude([], { hang: true });
    await runWorker({ ...eligibleRun(fx, []), spawn: hung.fn, timeoutMs: 20 });
    st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.equal(st.last_run.ok, false);
    assert.equal(st.last_run.cost_usd, null);

    const ok = fakeClaude([resultEvent({ total_cost_usd: 0.1 })]);
    await runWorker({ ...eligibleRun(fx, []), spawn: ok.fn });
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.cost_usd, 0.1, 'a reported cost is recorded as reported');
  } finally {
    fx.cleanup();
  }
});

test('[N2] a refused close becomes a refused verdict keyed by id, file_keys and HEAD; the item is skipped until one of them changes, and the prompt lists it', async () => {
  const fx = fixture();
  try {
    const refusedId = 'rrrr';
    const sp = fakeSpawn();
    assert.equal(launch(fx, { spawn: sp.fn, items: [ITEM(refusedId)] }).launched, true);
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    const child = fakeClaude([
      removeCall('t1', refusedId),
      removeResult('t1', 'maintenance_remove: item names a path the owning record does not claim', true),
      removeCall('t2', 'not-eligible'),
      removeResult('t2', 'refused', true),
      removeCall('t3', 'pppp'),
      removeResult('t3', 'The user denied permission to use this tool', true),
      resultEvent({}),
    ]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, token, budgetUsd: 2, now: () => NOW, ...quiet }), 0);
    const refused = readJournal(fx).filter((l) => l.kind === 'verdict' && l.verdict === 'refused');
    assert.deepEqual(refused.map((l) => [l.item_id, l.head, l.file_keys]), [[refusedId, HEAD, ['src/a.mjs']]], 'only the eligible item; a permission denial is not a server refusal');
    assert.equal(judgedVerdicts(fx.project).get(refusedId).verdict, 'refused');

    const later = NOW + DEBOUNCE_MS * 2;
    const sp2 = fakeSpawn();
    assert.deepEqual(launch(fx, { spawn: sp2.fn, items: [ITEM(refusedId)], now: later }), { launched: false, reason: 'none_eligible' }, 'same id, keys and HEAD: skipped');
    assert.equal(launch(fx, { spawn: sp2.fn, items: [ITEM(refusedId, ['src/a.mjs', 'src/z.mjs'])], now: later }).launched, true, 'new file_keys: launchable');
    rmSync(fx.paths.lock);
    rmSync(fx.paths.lastLaunch);
    assert.equal(launch(fx, { spawn: sp2.fn, items: [ITEM(refusedId)], now: later, spawnSync: fakeGit({ head: 'b'.repeat(40) }) }).launched, true, 'a new HEAD: launchable');
    assert.match(workerPrompt(fx.plugin, fx.project), new RegExp(`- ${refusedId} refused file_keys \\["src/a.mjs"\\] at HEAD ${HEAD}`));
  } finally {
    fx.cleanup();
  }
});

test('[N3] the runner records a malformed or zero --budget-usd as a failed run with state written', async () => {
  const fx = fixture();
  try {
    for (const bad of ['0', 'abc', '', 0.001]) {
      rmSync(fx.paths.state, { force: true });
      const child = fakeClaude([resultEvent({})]);
      assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: child.fn, budgetUsd: bad }), 1, `budget ${JSON.stringify(bad)}`);
      assert.equal(child.calls.length, 0, 'nothing runs');
      const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
      assert.equal(last.ok, false);
      assert.match(last.error, /invalid --budget-usd/);
      assert.equal(existsSync(fx.paths.lock), false);
    }
  } finally {
    fx.cleanup();
  }
});

test('[N4] any git failure (E2BIG, no HEAD, non-zero exit) counts every item dirty: no spawn, and the reason is logged, not printed', () => {
  const fx = fixture();
  try {
    const cases = [
      fakeGit({ status: { error: Object.assign(new Error('spawnSync git E2BIG'), { code: 'E2BIG' }), status: null } }),
      fakeGit({ revParse: { status: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD' } }),
      fakeGit({ status: { status: 128, stdout: '' } }),
    ];
    for (const git of cases) {
      rmSync(fx.paths.state, { force: true }); // each failure arms the back-off (M2); every case starts clean
      const sp = fakeSpawn();
      const r = launch(fx, { spawn: sp.fn, spawnSync: git });
      assert.equal(r.reason, 'git_failed');
      assert.equal(r.line, undefined);
      assert.match(r.detail, /git could not report HEAD or the working-tree state .* every queue item counts as dirty and no worker starts/);
      assert.match(readFileSync(fx.paths.log, 'utf8'), /git_failed: git could not report HEAD/);
      assert.equal(sp.calls.length, 0);
      assert.equal(existsSync(fx.paths.lock), false);
    }
  } finally {
    fx.cleanup();
  }
});

test('[N4] a project root in a subdirectory of the git top-level: porcelain paths are matched to file_keys through the prefix (fake and real git)', () => {
  const fx = fixture();
  try {
    const sub = fakeGit({ prefix: 'app/', porcelain: ' M app/src/a.mjs\0 M other/src/b.mjs\0' });
    const r = launch(fx, { spawn: fakeSpawn().fn, spawnSync: sub });
    assert.equal(r.launched, true);
    assert.equal(r.items, 1, 'src/a.mjs (app/src/a.mjs) is dirty; src/b.mjs is clean — other/src/b.mjs is outside the project');

    const top = mkdtempSync(join(tmpdir(), 'sterling-mworker-git-'));
    try {
      const g = (args, cwd = top) => {
        const res = realSpawnSync('git', args, { cwd, encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        return res.stdout;
      };
      g(['init', '-q']);
      g(['config', 'user.email', 't@t']);
      g(['config', 'user.name', 't']);
      mkdirSync(join(top, 'app', 'src'), { recursive: true });
      writeFileSync(join(top, 'app', 'src', 'a.mjs'), '1\n');
      writeFileSync(join(top, 'app', 'src', 'b.mjs'), '1\n');
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'init']);
      writeFileSync(join(top, 'app', 'src', 'a.mjs'), '2\n');
      const root = join(top, 'app');
      const state = gitState(root);
      assert.equal(state.prefix, 'app/');
      assert.match(state.head, /^[0-9a-f]{40}$/);
      assert.deepEqual([...dirtyPaths(root, ['src/a.mjs', 'src/b.mjs'], undefined, state.prefix)], ['src/a.mjs']);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('[PARTIAL 2] the child gets ONLY the eligible (clean, unjudged) item ids; the runner refuses an eligible list from another launch', async () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'judged', verdict: 'needs_conductor', file_keys: ['src/j.mjs'], evidence: true, capability: WORKER_CAPABILITY });
    const items = [ITEM('clean', ['src/c.mjs']), ITEM('dirty', ['src/a.mjs']), ITEM('judged', ['src/j.mjs'])];
    assert.equal(launch(fx, { spawn: fakeSpawn().fn, items, spawnSync: fakeGit({ porcelain: ' M src/a.mjs\0' }) }).launched, true);
    const eligible = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    assert.equal(eligible.token, token);
    assert.equal(eligible.head, HEAD);
    assert.deepEqual(eligible.items, [{ id: 'clean', lane: 'reconcile_needed', file_keys: ['src/c.mjs'], feature_link: null, slug: 'clean' }], 'ids, lane, keys and the article identity the evidence gate needs');

    const child = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, token, budgetUsd: 2, ...quiet }), 0);
    const prompt = child.calls[0].args[1];
    const section = prompt.slice(prompt.indexOf('ELIGIBLE'), prompt.indexOf('ALREADY JUDGED'));
    assert.match(section, /- clean lane reconcile_needed target none file_keys/);
    assert.doesNotMatch(section, /- dirty |- judged /, 'dirty and judged items are not offered');

    writeFileSync(fx.paths.lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token: 'second' }));
    const other = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: other.fn, token: 'second', budgetUsd: 2, ...quiet }), 1);
    assert.equal(other.calls.length, 0);
    assert.match(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.error, /eligible-item list is missing or belongs to another launch/);
  } finally {
    fx.cleanup();
  }
});

test('[PARTIAL 9] one run writes at most the log cap to maintenance-worker.log, while the JSONL still journals every tool call', async () => {
  const fx = fixture();
  try {
    const events = [];
    for (let i = 0; i < 20; i++) events.push(removeCall(`t${i}`, `item-${i}`), removeResult(`t${i}`, 'Closed as ALREADY-PAID'));
    events.push(resultEvent({}));
    const written = [];
    const child = fakeClaude(events);
    await runWorker({ ...eligibleRun(fx, []), spawn: child.fn, logCapBytes: 500, log: (t) => written.push(t) });
    const text = written.join('');
    const note = text.indexOf('[maintenance-worker-run: log truncated at 500 bytes');
    assert.ok(note > 0, 'the truncation is announced once');
    assert.equal(note, 501, 'exactly the cap was written before the note');
    assert.equal(readJournal(fx).filter((l) => l.kind === 'tool_call').length, 20);
  } finally {
    fx.cleanup();
  }
});

test('[PARTIAL 9] rotating the JSONL carries standing needs_conductor and refused verdicts forward, so a second rotation loses none', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'o', verdict: 'needs_conductor', file_keys: ['a'], evidence: true, capability: WORKER_CAPABILITY });
    journalLine(fx, { kind: 'verdict', item_id: 'r', verdict: 'refused', file_keys: ['b'], head: HEAD, evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'c', verdict: 'needs_conductor', file_keys: ['c'], evidence: true, capability: WORKER_CAPABILITY });
    journalLine(fx, { kind: 'verdict', item_id: 'c', verdict: 'closed' });
    appendFileSync(fx.paths.journal, 'x'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    appendFileSync(fx.paths.journal, 'y'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    const v = judgedVerdicts(fx.project);
    assert.deepEqual([...v.keys()].sort(), ['o', 'r'], 'both standing verdicts survive two rotations; the closed one is not resurrected');
    assert.equal(v.get('r').head, HEAD);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ evidence gate (live run 2026-09-29: 12 guessed owes_prose verdicts)

/** Lock + eligible list for a token-bound runWorker call. */
function eligibleRun(fx, items, token = 'tok', head = HEAD) {
  writeFileSync(fx.paths.lock, JSON.stringify({ pid: process.pid, started_at: new Date(NOW).toISOString(), token }));
  writeFileSync(fx.paths.eligible, JSON.stringify({ token, head, items, policy_version: 1, run_id: RUN_ID, policy_items: items.map((t) => ({ id: t.id, lane: t.lane ?? 'reconcile_needed', target_id: t.feature_link ?? null, file_keys: t.file_keys })) }));
  return { root: fx.project, pluginRoot: fx.plugin, token, budgetUsd: 2, now: () => NOW, ...quiet };
}
const RUN_ID = 'run-test-1';
/** A successful maintenance_remove receipt as the worker's server returns it: stamped with the run and the removed item. */
const removedText = (item, runId = RUN_ID) => JSON.stringify({ removed: item, [STAMP_KEY]: { run_id: runId, item_id: item, resolved: [item] } });
const owes = (id, slug) => JSON.stringify({ item_id: id, article: slug, verdict: 'needs_conductor', file_keys: ['ignored-by-the-gate'], reason: 'the article does not name the new flag' });

test('[gate] a needs_conductor verdict stands only when the stream shows a SUCCESSFUL knowledge_get on its article AND a successful Read/Grep covering one of its files; otherwise it is journalled unjudged/no evidence', async () => {
  const fx = fixture();
  try {
    const item = (id, keys) => ({ id, file_keys: keys, feature_link: `${id.toLowerCase().repeat(8)}-1111-2222-3333-444444444444`, slug: `art-${id.toLowerCase()}` });
    const items = [
      item('A', ['src/a.mjs']),
      item('B', ['src/b.mjs']),
      item('C', ['src/c.mjs']),
      item('D', ['lib/d.mjs']),
      item('E', ['tools/e.mjs']),
      item('F', ['cfg/f.mjs']),
      item('G', ['bin/g.mjs']),
    ];
    const child = fakeClaude([
      // A: slug + a Grep on its own file (absolute path)
      toolUse('1', 'mcp__sterling__knowledge_get', { id: 'art-a' }), toolOk('1'),
      toolUse('2', 'Grep', { pattern: 'x', path: join(fx.project, 'src', 'a.mjs') }), toolOk('2'),
      // B: 8-char prefix, but no read covering src/b.mjs
      toolUse('3', 'mcp__sterling__knowledge_get', { id: 'bbbbbbbb' }), toolOk('3'),
      // C: file read, but no article
      toolUse('4', 'Read', { file_path: 'src/c.mjs' }), toolOk('4'),
      // D: article + a Grep over the DIRECTORY that holds lib/d.mjs (conductor ruling: counts)
      toolUse('5', 'mcp__sterling__knowledge_get', { id: 'dddddddd-1111-2222-3333-444444444444' }), toolOk('5'),
      toolUse('6', 'Grep', { pattern: 'x', path: join(fx.project, 'lib') }), toolOk('6'),
      // E: article + a Grep over a directory holding NONE of its keys
      toolUse('7', 'mcp__sterling__knowledge_get', { id: 'art-e' }), toolOk('7'),
      toolUse('8', 'Grep', { pattern: 'x', path: 'docs' }), toolOk('8'),
      // F: an ERRORED knowledge_get + a good Read
      toolUse('9', 'mcp__sterling__knowledge_get', { id: 'art-f' }), toolErr('9', "knowledge_get: no record 'art-f'"),
      toolUse('10', 'Read', { file_path: 'cfg/f.mjs' }), toolOk('10'),
      // G: a good knowledge_get + an ERRORED Read, and a call with no result at all
      toolUse('11', 'mcp__sterling__knowledge_get', { id: 'art-g' }), toolOk('11'),
      toolUse('12', 'Read', { file_path: 'bin/g.mjs' }), toolErr('12', 'File does not exist.'),
      toolUse('13', 'Grep', { pattern: 'x', path: 'bin' }),
      resultEvent({ result: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => owes(id, `art-${id.toLowerCase()}`)).concat(owes('Z', 'not-eligible')).join('\n') }),
    ]);
    assert.equal(await runWorker({ ...eligibleRun(fx, items), spawn: child.fn }), 0);
    const verdicts = readJournal(fx).filter((l) => l.kind === 'verdict');
    assert.deepEqual(verdicts.map((v) => [v.item_id, v.verdict, v.evidence ?? null, v.reason]), [
      ['A', 'needs_conductor', true, 'the article does not name the new flag'],
      ['B', 'unjudged', null, 'no evidence'],
      ['C', 'unjudged', null, 'no evidence'],
      // CHANGED (conductor ruling 2026-09-29): D was 'unjudged' when a directory Grep never counted; a
      // successful Grep over a directory that holds one of the item's file_keys now counts as file evidence.
      ['D', 'needs_conductor', true, 'the article does not name the new flag'],
      ['E', 'unjudged', null, 'no evidence'],
      ['F', 'unjudged', null, 'no evidence'],
      ['G', 'unjudged', null, 'no evidence'],
      ['Z', 'unjudged', null, 'no evidence'],
    ]);
    assert.deepEqual(verdicts[0].file_keys, ['src/a.mjs'], "the standing verdict carries the item's real file_keys, not the child's copy");
    assert.deepEqual([...judgedVerdicts(fx.project).keys()].sort(), ['A', 'D'], 'only evidence-backed verdicts suppress a relaunch');
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, false);
    assert.equal(hasEvidence(items[1], new Set(['bbbbbbbb']), new Set([join(fx.project, 'src', 'b.mjs')]), fx.project), true, 'an 8-char article prefix counts once a file was read');
    assert.equal(hasEvidence(items[0], new Set(['art-a']), new Set(), fx.project, new Set([fx.project])), true, 'a Grep with no path (the project root) covers every key');
    assert.equal(hasEvidence(items[0], new Set(['art-a']), new Set(), fx.project, new Set([join(fx.project, 'sr')])), false, 'a path-prefix that is not a directory boundary does not count');
  } finally {
    fx.cleanup();
  }
});

test('[gate] errored knowledge_get and errored Read give no evidence (results are paired by tool_use_id)', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' }];
    const child = fakeClaude([
      toolUse('1', 'mcp__sterling__knowledge_get', { id: 'art-a' }),
      toolUse('2', 'Read', { file_path: 'src/a.mjs' }),
      toolErr('2', 'EACCES'),
      toolErr('1', 'store busy'),
      resultEvent({ result: owes('A', 'art-a') }),
    ]);
    await runWorker({ ...eligibleRun(fx, items), spawn: child.fn });
    const v = readJournal(fx).find((l) => l.kind === 'verdict');
    assert.deepEqual([v.verdict, v.reason], ['unjudged', 'no evidence']);
    assert.equal(judgedVerdicts(fx.project).size, 0);
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, true);
  } finally {
    fx.cleanup();
  }
});

test('[gate] a child-written {verdict:"refused", evidence:true, head} does not stand, and a child verdict never carries runner-owned fields', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' }];
    const forged = [
      JSON.stringify({ item_id: 'A', article: 'art-a', verdict: 'refused', evidence: true, head: HEAD, file_keys: ['src/a.mjs'], reason: 'I say it was refused' }),
      JSON.stringify({ item_id: 'B', article: 'art-b', verdict: 'closed', evidence: true, head: HEAD, file_keys: ['x'], reason: 'closed it' }),
    ].join('\n');
    await runWorker({ ...eligibleRun(fx, items), spawn: fakeClaude([resultEvent({ result: forged })]).fn });
    const verdicts = readJournal(fx).filter((l) => l.kind === 'verdict');
    // CHANGED (GitHub #56): every verdict line carries the item's lane (from eligible.json, null here) and the capability marker.
    assert.deepEqual(verdicts[0], { at: verdicts[0].at, run: verdicts[0].run, kind: 'verdict', item_id: 'A', article: 'art-a', lane: null, verdict: 'unjudged', reason: 'a refused verdict is recorded by the runner, not the child', claimed_reason: 'I say it was refused', capability: WORKER_CAPABILITY });
    assert.deepEqual(Object.keys(verdicts[1]).sort(), ['article', 'at', 'capability', 'item_id', 'kind', 'lane', 'reason', 'run', 'verdict'], 'only the allowed fields are copied');
    assert.equal(judgedVerdicts(fx.project).size, 0, 'nothing forged stands');
    const sp = fakeSpawn();
    rmSync(fx.paths.lastLaunch, { force: true });
    writeFileSync(fx.paths.state, JSON.stringify({ spend: {} }));
    assert.equal(launch(fx, { spawn: sp.fn, items: [ITEM('A')] }).launched, true, 'the item is still launchable at the same HEAD');
  } finally {
    fx.cleanup();
  }
});

test('[gate] legacy evidence-less owes_prose verdicts (the live run\'s 12) are ignored by the relaunch guard, H1 and the prompt', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'legacy', verdict: 'owes_prose', file_keys: ['src/a.mjs'], reason: 'Not verified: I did not read the files or the article.' });
    // CHANGED (GitHub #56, change (ix)): 'gated' was an evidence-backed owes_prose; a standing handoff is now a
    // needs_conductor verdict with the capability marker (the re-judge of old owes_prose has its own test).
    journalLine(fx, { kind: 'verdict', item_id: 'gated', verdict: 'needs_conductor', file_keys: ['src/b.mjs'], evidence: true, capability: WORKER_CAPABILITY });
    assert.deepEqual([...judgedVerdicts(fx.project).keys()], ['gated']);
    assert.deepEqual([...handoffVerdicts(fx.project).keys()], ['gated'], 'H1 counts only gated verdicts');
    const store = { count: () => 2, query: () => [ITEM('legacy', ['src/a.mjs']), ITEM('gated', ['src/b.mjs'])] };
    assert.deepEqual(unjudgedWorkerItems(store, fx.project).map((t) => t.id), ['legacy'], 'the legacy item is launchable again');
    const r = launch(fx, { spawn: fakeSpawn().fn, items: [ITEM('legacy', ['src/a.mjs'])] });
    assert.equal(r.launched, true);
    assert.doesNotMatch(workerPrompt(fx.plugin, fx.project), /- legacy /, 'nor listed as already judged');
  } finally {
    fx.cleanup();
  }
});

test('[no progress] a run with 0 evidence-backed verdicts and 0 closes backs off 30 minutes like a failure, silently (log only); a run with a close does not', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' }];
    const guessed = fakeClaude([resultEvent({ result: owes('A', 'art-a') })]);
    assert.equal(await runWorker({ ...eligibleRun(fx, items), spawn: guessed.fn }), 0, 'the run itself succeeded');
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, true);
    assert.equal(last.no_progress, true);

    const sp = fakeSpawn();
    const blocked = launch(fx, { spawn: sp.fn, now: Date.parse(last.at) + 60_000 });
    assert.equal(blocked.reason, 'backoff');
    assert.equal(blocked.line, undefined, 'no hook line for a routine no-progress back-off');
    assert.match(readFileSync(fx.paths.log, 'utf8'), /backoff: worker made no progress in its last run at .* \(0 evidence-backed verdicts, 0 closes\) — backing off, no relaunch before/);
    assert.equal(sp.calls.length, 0);
    const after = launch(fx, { spawn: sp.fn, now: Date.parse(last.at) + BACKOFF_MS + 1 });
    assert.equal(after.launched, true);
    assert.equal(after.line, undefined, 'the relaunch after the back-off prints nothing');

    const closing = fakeClaude([removeCall('t1', 'A'), removeResult('t1', removedText('A')), resultEvent({})]);
    await runWorker({ ...eligibleRun(fx, items, 'tok2'), spawn: closing.fn });
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, false, 'a successful close is progress');
    const refusing = fakeClaude([removeCall('t1', 'A'), removeResult('t1', 'refused: worktree differs', true), resultEvent({})]);
    await runWorker({ ...eligibleRun(fx, items, 'tok3'), spawn: refusing.fn });
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, false, 'a recorded refusal is progress (the item is now judged for this HEAD)');
  } finally {
    fx.cleanup();
  }
});

test('[gate] JSONL rotation carries forward only evidence:true verdicts', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'legacy', verdict: 'owes_prose', file_keys: ['a'] });
    journalLine(fx, { kind: 'verdict', item_id: 'gated', verdict: 'needs_conductor', file_keys: ['b'], evidence: true, capability: WORKER_CAPABILITY });
    journalLine(fx, { kind: 'verdict', item_id: 'refused', verdict: 'refused', file_keys: ['c'], head: HEAD, evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'unj', verdict: 'unjudged', reason: 'no evidence' });
    appendFileSync(fx.paths.journal, 'x'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    const carried = readJournal(fx);
    assert.deepEqual(carried.map((l) => [l.item_id, l.verdict, l.evidence]).sort(), [['gated', 'needs_conductor', true], ['refused', 'refused', true]]);
    appendFileSync(fx.paths.journal, 'y'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    assert.deepEqual([...judgedVerdicts(fx.project).keys()].sort(), ['gated', 'refused'], 'the legacy verdict is gone after the second rotation, the gated ones survive');
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ silence + breakage record

test('[silent] no launcher outcome carries a hook line: launched, queue empty, already running, and backed off', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const launched = launch(fx, { spawn: sp.fn });
    assert.equal(launched.launched, true);
    assert.equal('line' in launched, false);
    const empty = launch(fx, { spawn: sp.fn, items: [] });
    assert.equal(empty.reason, 'queue_empty');
    const running = launch(fx, { spawn: sp.fn, isAlive: () => true, now: NOW + DEBOUNCE_MS * 2 });
    assert.equal(running.reason, 'already_running');
    writeState(fx, { last_run: { ok: false, at: new Date(NOW - 60_000).toISOString(), error: 'exit 1' } });
    const backedOff = launch(fx, { spawn: sp.fn });
    assert.equal(backedOff.reason, 'backoff');
    for (const r of [empty, running, backedOff]) assert.equal('line' in r, false, r.reason);
  } finally {
    fx.cleanup();
  }
});

test('[breakage] the run summary records the MCP server status from the init event; a server that is not connected fails the run with a named reason, an unreported status does not', async () => {
  const fx = fixture();
  try {
    const down = fakeClaude([{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'sterling', status: 'failed' }] }, resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: down.fn }), 1);
    let last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, false);
    assert.equal(last.mcp_status, 'failed');
    assert.match(last.error, /MCP server 'sterling' not connected \(failed\)/);
    assert.equal(readJournal(fx).at(-1).mcp_status, 'failed', 'the journal summary carries it too');

    const up = fakeClaude([{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'sterling', status: 'connected' }] }, resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: up.fn }), 0);
    last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.ok, last.mcp_status], [true, 'connected']);

    // L3: only an explicit failed/disconnected status, or a non-connected status with no
    // successful sterling tool call, is breakage. 'pending' is unknown when the stream shows the server worked.
    const initWith = (status) => ({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'sterling', status }] });
    const pendingWorked = fakeClaude([initWith('pending'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolOk('k1'), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: pendingWorked.fn }), 0, 'pending + a successful sterling call is not broken');
    last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.ok, last.error, last.mcp_status], [true, null, 'pending']);

    const pendingIdle = fakeClaude([initWith('pending'), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: pendingIdle.fn }), 1, 'pending and no successful sterling call is broken');
    assert.match(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.error, /MCP server 'sterling' not connected \(pending/);

    const pendingErrored = fakeClaude([initWith('pending'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolErr('k1'), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: pendingErrored.fn }), 1, 'an errored sterling call is not a success');

    const disconnected = fakeClaude([initWith('disconnected'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolOk('k1'), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: disconnected.fn }), 1, 'an explicit disconnected status is broken');

    const closedWhilePending = fakeClaude([initWith('pending'), removeCall('t1', 'A'), removeResult('t1', removedText('A')), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: closedWhilePending.fn }), 0, 'a successful maintenance_remove is a successful sterling call');

    const silent = fakeClaude([{ type: 'system', subtype: 'init' }, resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, []), spawn: silent.fn }), 0, 'no mcp_servers in the init event is unknown, not broken');
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.mcp_status, null);
  } finally {
    fx.cleanup();
  }
});

test('[breakage] workerBreakage names a broken last run (non-zero exit, error result, permission denial, MCP not connected, timeout) and nothing for a routine one', () => {
  for (const error of ['exit 3', "error result (error_max_budget_usd)", '1 permission denial(s)', "MCP server 'sterling' not connected (failed)", 'killed after 20 min timeout']) {
    assert.deepEqual(workerBreakage({ ok: false, at: 'T', error }), { at: 'T', reason: error }, error);
  }
  assert.deepEqual(workerBreakage({ ok: false, at: 'T', error: null }), { at: 'T', reason: 'unknown error' });
  for (const routine of [null, undefined, { ok: true, at: 'T', error: null, no_progress: true }, { ok: true, at: 'T', no_progress: false }]) assert.equal(workerBreakage(routine), null);
});

// ------------------------------------------------------------ review fixes (M1, M2, L4, end to end)

test('[M1] a refusal of an item that already has a refused verdict for the same file_keys is not progress: the second run at a new HEAD is no_progress and arms the back-off', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'R', file_keys: ['src/a.mjs'], feature_link: null, slug: null }];
    const refuse = () => fakeClaude([removeCall('t1', 'R'), removeResult('t1', 'refused: the owning record does not claim this path', true), resultEvent({})]);
    assert.equal(await runWorker({ ...eligibleRun(fx, items, 'tok1', HEAD), spawn: refuse().fn }), 0);
    let last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.no_progress, last.refused_verdicts], [false, 1], 'the first refusal is new information: progress');

    const head2 = 'b'.repeat(40);
    assert.equal(await runWorker({ ...eligibleRun(fx, items, 'tok2', head2), spawn: refuse().fn }), 0);
    last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.no_progress, last.refused_verdicts], [true, 1], 'the same item refused again for the same file_keys is not progress');
    assert.equal(judgedVerdicts(fx.project).get('R').head, head2, 'the verdict still moves to the new HEAD');

    const sp = fakeSpawn();
    const r = launch(fx, { spawn: sp.fn, items: [ITEM('R')], spawnSync: fakeGit({ head: 'c'.repeat(40) }) });
    assert.equal(r.reason, 'backoff', 'a third commit no longer relaunches at once');
    assert.equal(sp.calls.length, 0);

    // A refusal for DIFFERENT file_keys than the standing verdict is new information again.
    const wider = [{ id: 'R', file_keys: ['src/a.mjs', 'src/z.mjs'], feature_link: null, slug: null }];
    assert.equal(await runWorker({ ...eligibleRun(fx, wider, 'tok3', head2), spawn: refuse().fn }), 0);
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, false);
  } finally {
    fx.cleanup();
  }
});

test('[M2] a failure to start (git cannot answer, a broken install) is recorded as a failed last_run: workerBreakage names it and the next launch backs off', () => {
  for (const [name, over, reason, match] of [
    ['git failed', { spawnSync: fakeGit({ revParse: { status: 128, stdout: '' } }) }, 'git_failed', /git could not report HEAD/],
    ['broken install', { pluginRoot: 'nope' }, 'error', /launch FAILED \(cannot read the plugin MCP wiring/],
  ]) {
    const fx = fixture();
    try {
      const sp = fakeSpawn();
      const first = launch(fx, { spawn: sp.fn, ...(over.pluginRoot ? { pluginRoot: join(fx.plugin, 'nope') } : over) });
      assert.equal(first.reason, reason, name);
      const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
      assert.equal(last.ok, false, name);
      assert.match(last.error, match, name);
      assert.equal(last.error, first.detail, 'the recorded error is the launcher detail');
      assert.deepEqual(workerBreakage(last), { at: last.at, reason: last.error });
      const next = launch(fx, { spawn: sp.fn, spawnSync: CLEAN_GIT, pluginRoot: fx.plugin, now: NOW + DEBOUNCE_MS * 2 });
      assert.equal(next.reason, 'backoff', `${name}: the next Stop does not retry at once`);
      assert.equal(sp.calls.length, 0);
    } finally {
      fx.cleanup();
    }
  }
});

test('[L4] when the launcher cannot write maintenance-worker.log for a failing launch, the log error is folded into last_run.error (and log_error), with no new output channel', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.paths.log); // a directory in the log's place: appendFileSync throws EISDIR
    const r = launch(fx, { spawn: fakeSpawn().fn, spawnSync: fakeGit({ revParse: { status: 128, stdout: '' } }) });
    assert.equal(r.reason, 'git_failed');
    assert.match(r.log_error, /EISDIR/);
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.match(last.error, /git could not report HEAD.*could not write maintenance-worker\.log \(EISDIR/);
    assert.equal('line' in r, false);
  } finally {
    fx.cleanup();
  }
});

test('[end to end] a crashed run (no result event, non-zero exit) is recorded, and the next launch inside the window backs off, silently', async () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    assert.equal(launch(fx, { spawn: sp.fn }).launched, true);
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    const crashed = fakeClaude(['not json'], { code: 1 });
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: crashed.fn, token, budgetUsd: 2, now: () => NOW, ...quiet }), 1);
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, false);
    assert.match(last.error, /exit 1.*no stream-json result event/);
    const later = launch(fx, { spawn: sp.fn, now: NOW + DEBOUNCE_MS * 2 });
    assert.equal(later.reason, 'backoff');
    assert.equal('line' in later, false);
    assert.equal(sp.calls.length, 1, 'only the first launch spawned');
    assert.equal(launch(fx, { spawn: sp.fn, now: NOW + BACKOFF_MS + 1 }).launched, true, 'after the window it relaunches');
  } finally {
    fx.cleanup();
  }
});

// ---- batching, database-locked retry-later, line-reference fixes, prompt (0.18.33 lane) ----

const aged = (id, ageMs, keys = [`src/${id}.mjs`]) => ({ ...ITEM(id, keys), created_at: new Date(NOW - ageMs).toISOString() });
const MIN = 60_000;

test('[batching] fewer than BATCH_MIN_ITEMS eligible items whose oldest is younger than BATCH_MAX_WAIT_MS do not launch: a quiet, logged "batching" outcome that arms no back-off and takes no debounce or lock', () => {
  assert.equal(BATCH_MIN_ITEMS, 5);
  assert.equal(BATCH_MAX_WAIT_MS, 30 * MIN);
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const items = ['a', 'b', 'c', 'd'].map((id, i) => aged(id, (i + 1) * MIN));
    const r = launch(fx, { spawn: sp.fn, items });
    assert.equal(r.launched, false);
    assert.equal(r.reason, 'batching');
    assert.equal(r.line, undefined, 'no hook line');
    assert.equal(sp.calls.length, 0);
    assert.equal(existsSync(fx.paths.lock), false, 'no lock taken');
    assert.equal(existsSync(fx.paths.lastLaunch), false, 'no debounce armed');
    assert.equal(existsSync(fx.paths.state), false, 'not recorded as a run: no no_progress, no back-off');
    assert.match(readFileSync(fx.paths.log, 'utf8'), /batching: 4 of 5 eligible items, oldest waited 4m of 30m/);
    // the very next trigger is still not blocked by anything the batching outcome left behind
    const next = launch(fx, { spawn: sp.fn, items: [...items, aged('e', 2 * MIN)], now: NOW + 1000 });
    assert.equal(next.launched, true, JSON.stringify(next));
  } finally {
    fx.cleanup();
  }
});

test('[batching] BATCH_MIN_ITEMS eligible items launch even when all are young', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const r = launch(fx, { spawn: sp.fn, items: ['a', 'b', 'c', 'd', 'e'].map((id) => aged(id, MIN)) });
    assert.equal(r.launched, true, JSON.stringify(r));
    assert.equal(r.items, 5);
    assert.equal(sp.calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test('[batching] one eligible item launches once it has waited BATCH_MAX_WAIT_MS (and not a minute earlier)', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const young = launch(fx, { spawn: sp.fn, items: [aged('a', BATCH_MAX_WAIT_MS - MIN)] });
    assert.equal(young.reason, 'batching');
    const old = launch(fx, { spawn: sp.fn, items: [aged('a', BATCH_MAX_WAIT_MS)] });
    assert.equal(old.launched, true, JSON.stringify(old));
    assert.equal(sp.calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test('[batching] the wait is the OLDEST eligible item\'s; items dirty or judged do not count toward the batch or its age', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    // one old item, but it is dirty: only the young clean one is eligible
    const dirtyGit = fakeGit({ porcelain: ' M src/old.mjs\0' });
    const r = launch(fx, { spawn: sp.fn, spawnSync: dirtyGit, items: [aged('old', 2 * BATCH_MAX_WAIT_MS), aged('young', MIN)] });
    assert.equal(r.reason, 'batching');
    assert.match(readFileSync(fx.paths.log, 'utf8'), /batching: 1 of 5 eligible items, oldest waited 1m of 30m/);
    assert.equal(sp.calls.length, 0);

    // an old item already handed off (evidence-backed) for its CURRENT file_keys: it neither
    // makes the batch nor supplies the age, so the lone young item still batches
    journalLine(fx, { kind: 'verdict', item_id: 'judged', verdict: 'needs_conductor', file_keys: ['src/judged.mjs'], evidence: true, capability: WORKER_CAPABILITY });
    const judged = launch(fx, { spawn: sp.fn, items: [aged('judged', 2 * BATCH_MAX_WAIT_MS), aged('young', MIN)] });
    assert.equal(judged.reason, 'batching');
    assert.equal(readFileSync(fx.paths.log, 'utf8').split('batching: 1 of 5 eligible items, oldest waited 1m of 30m').length - 1, 2, 'the judged item did not count: both launches logged 1 of 5');
    // four young clean items plus the judged one is still 4 eligible, not 5
    const four = launch(fx, { spawn: sp.fn, items: [aged('judged', 2 * BATCH_MAX_WAIT_MS), ...['a', 'b', 'c', 'd'].map((id) => aged(id, MIN))] });
    assert.equal(four.reason, 'batching');
    assert.equal(sp.calls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test('[batching] an item without a usable created_at counts as already waited: the batch check never strands work it cannot date', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const r = launch(fx, { spawn: sp.fn, items: [{ ...ITEM('a'), created_at: 'not a date' }] });
    assert.equal(r.launched, true, JSON.stringify(r));
  } finally {
    fx.cleanup();
  }
});

test('[batching] back-off, lock and debounce still come first: a young batch under back-off reports backoff, not batching', () => {
  const fx = fixture();
  try {
    writeState(fx, { last_run: { ok: true, no_progress: true, at: new Date(NOW - MIN).toISOString(), error: null } });
    const r = launch(fx, { spawn: fakeSpawn().fn, items: [aged('a', MIN)] });
    assert.equal(r.reason, 'backoff');
  } finally {
    fx.cleanup();
  }
});

const BUSY_TEXT = 'Error: SqliteError: database is locked';
const busyRun = (fx, items, events, token = 'tok') => runWorker({ ...eligibleRun(fx, items, token), spawn: fakeClaude([...events, resultEvent({})]).fn });

test('[busy] a maintenance_remove that fails with a locked database is retry-later: no refused verdict, not judged, the item stays eligible, and a repeat remove that succeeds closes it', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' }];
    // CHANGED (review): the third phrasing, 'store is busy, try again', was retry-later while BUSY_RE
    // matched a bare "busy". The pattern is narrowed to the two real SQLite lock texts, because a
    // bare "busy" also matched a genuine refusal that merely names a file such as busy-indicator.ts.
    // That phrasing is now a refusal (see the busy-indicator test below).
    for (const text of [BUSY_TEXT, 'SQLITE_BUSY: cannot start a transaction']) {
      await busyRun(fx, items, [removeCall('t1', 'A'), removeResult('t1', text, true)]);
    }
    const lines = readJournal(fx);
    const verdicts = lines.filter((l) => l.kind === 'verdict');
    assert.equal(verdicts.filter((v) => v.verdict === 'refused').length, 0, 'never a refused verdict');
    assert.equal(verdicts.filter((v) => v.evidence === true).length, 0, 'no evidence:true stamp');
    assert.deepEqual(verdicts.map((v) => [v.item_id, v.verdict]), [['A', 'busy'], ['A', 'busy']]);
    assert.equal(judgedVerdicts(fx.project).size, 0, 'judgedVerdicts ignores a busy verdict');
    const store = { count: () => 1, query: () => [ITEM('A')] };
    assert.equal(unjudgedWorkerItems(store, fx.project, HEAD).length, 1, 'the item stays eligible');
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, true, 'a locked database is not a failed run');
    assert.equal(last.refused_verdicts, 0);
    assert.equal(last.busy_calls, 1);
    // the tool call itself is still on record
    assert.equal(lines.filter((l) => l.kind === 'tool_call' && l.is_error === true).length, 2);
    // the retry after the lock clears closes it and is progress
    await busyRun(fx, items, [removeCall('t1', 'A'), removeResult('t1', BUSY_TEXT, true), removeCall('t2', 'A'), removeResult('t2', removedText('A'))], 'tok2');
    const after = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(after.no_progress, false);
    assert.equal(after.closes_ok, 1);
    assert.equal(after.refused_verdicts, 0);
  } finally {
    fx.cleanup();
  }
});

test('[busy] a refusal whose text merely contains "busy" (a file named busy-indicator.ts) or a bare "store is busy" is a refused verdict, not retry-later', async () => {
  const fx = fixture();
  try {
    const items = [
      { id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' },
      { id: 'B', file_keys: ['src/b.mjs'], feature_link: 'bbbbbbbb-1111-2222-3333-444444444444', slug: 'art-b' },
    ];
    await busyRun(fx, items, [removeCall('t1', 'A'), removeResult('t1', 'refused: src/busy-indicator.ts differs from HEAD', true), removeCall('t2', 'B'), removeResult('t2', 'store is busy, try again', true)]);
    assert.deepEqual([...judgedVerdicts(fx.project)].map(([id, v]) => [id, v.verdict]), [['A', 'refused'], ['B', 'refused']]);
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.refused_verdicts, 2);
    assert.equal(last.busy_calls, 0);
  } finally {
    fx.cleanup();
  }
});

test('[busy] a real refusal is still a refused verdict, and a locked-database remove neither counts as a new refusal nor stands as one', async () => {
  const fx = fixture();
  try {
    const items = [
      { id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' },
      { id: 'B', file_keys: ['src/b.mjs'], feature_link: 'bbbbbbbb-1111-2222-3333-444444444444', slug: 'art-b' },
    ];
    await busyRun(fx, items, [removeCall('t1', 'A'), removeResult('t1', BUSY_TEXT, true), removeCall('t2', 'B'), removeResult('t2', 'refused: worktree differs from HEAD', true)]);
    assert.deepEqual([...judgedVerdicts(fx.project).keys()], ['B']);
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.refused_verdicts, 1);
    assert.equal(last.busy_calls, 1);
  } finally {
    fx.cleanup();
  }
});

const LINK = 'aaaaaaaa-1111-2222-3333-444444444444';
const lineFix = (id, input) => toolUse(id, 'mcp__sterling__knowledge_line_ref_fix', { id: LINK, field: 'what_it_does', find: 'src/a.mjs:10', replace: 'src/a.mjs:14', anchor: 'export const a', ...input });
const stampedText = (item = 'A', runId = RUN_ID, extra = {}) => JSON.stringify({ ok: true, ...extra, [STAMP_KEY]: { run_id: runId, item_id: item } });
const fixOk = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: stampedText() }] } });
/** The evidence the gate wants for item A: a good knowledge_get on its article and a good Read of its file. */
const evidenceForA = () => [toolUse('e1', 'mcp__sterling__knowledge_get', { id: LINK }), toolOk('e1'), toolUse('e2', 'Read', { file_path: 'src/a.mjs' }), toolOk('e2')];
const ITEM_A = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' }];
const lastRun = (fx) => JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;

test('[line-ref] the argv allows knowledge_line_ref_fix under both mounted names and neither is denied', () => {
  const args = buildWorkerArgs({ prompt: 'P', mcpConfig: '{}' });
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
  for (const name of ['mcp__sterling__knowledge_line_ref_fix', 'mcp__plugin_sterling_sterling__knowledge_line_ref_fix']) {
    assert.ok(allowed.includes(name), `${name} is allowed`);
    assert.ok(!denied.includes(name), `${name} is not denied`);
  }
  assert.equal(denied.filter((d) => /line_ref/.test(d)).length, 0);
  assert.equal(allowed.filter((t) => denied.includes(t)).length, 0);
});

test('[line-ref] the stream journal records each knowledge_line_ref_fix call with its result (no resolves field); a fix alone is not progress, and a tool refusal is not an error of the run', async () => {
  const fx = fixture();
  try {
    const sp = fakeClaude([
      ...evidenceForA(),
      lineFix('f1', {}),
      fixOk('f1'),
      lineFix('f2', { find: 'src/a.mjs:20', replace: 'src/a.mjs:25', resolves: 'A' }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f2', content: 'refused: anchor not on line 25 at HEAD', is_error: true }] } },
      resultEvent({}),
    ]);
    assert.equal(await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: sp.fn }), 0, 'a tool refusal leaves the run ok');
    const lines = readJournal(fx);
    const fixes = lines.filter((l) => l.tool === 'knowledge_line_ref_fix');
    assert.equal(fixes.length, 2);
    assert.deepEqual(fixes.map((l) => [l.kind, l.article_id, l.field, l.find, l.replace, l.is_error]), [
      ['tool_call', LINK, 'what_it_does', 'src/a.mjs:10', 'src/a.mjs:14', false],
      ['tool_call', LINK, 'what_it_does', 'src/a.mjs:20', 'src/a.mjs:25', true],
    ]);
    // CHANGED (review): the tool no longer takes resolves, so the journal no longer records it, even if a child passes one.
    assert.ok(fixes.every((l) => !('resolves' in l)), 'no resolves field on a fix call');
    assert.match(fixes[1].result, /anchor not on line 25/);
    assert.equal(lines.filter((l) => l.kind === 'verdict').length, 0, 'a refused fix never becomes a refused verdict');
    const last = lastRun(fx);
    assert.equal(last.ok, true);
    assert.equal(last.line_ref_fixes_ok, 1);
    assert.equal(last.line_ref_fixes, 2);
    // CHANGED (ping-pong loop): a successful, evidenced fix used to make the run progress. A fix alone is
    // never progress now: the server accepts 2->4 then 4->2, so counting it would loop a $2 run forever.
    assert.equal(last.no_progress, true, 'a fix alone is never progress');
    assert.equal(last.refused_verdicts, 0);
  } finally {
    fx.cleanup();
  }
});

test('[line-ref] a fix on its own is never progress: with or without the evidence, real or no-op, by uuid or by slug, the run is no_progress but the fix is still journalled and counted', async () => {
  const cases = [
    ['no evidence at all', [lineFix('f1', {}), fixOk('f1')]],
    ['knowledge_get only, no file read', [toolUse('e1', 'mcp__sterling__knowledge_get', { id: LINK }), toolOk('e1'), lineFix('f1', {}), fixOk('f1')]],
    ['a no-op fix (find === replace)', [...evidenceForA(), lineFix('f1', { replace: 'src/a.mjs:10' }), fixOk('f1')]],
    ['a fix on an article that is not an eligible item', [...evidenceForA(), lineFix('f1', { id: 'cccccccc-1111-2222-3333-444444444444' }), fixOk('f1')]],
    ['an evidenced real fix', [...evidenceForA(), lineFix('f1', {}), fixOk('f1')]],
    // CHANGED (ping-pong loop): this was the "fix by slug with a directory Grep is progress" case. Its intent flips:
    // even a fully evidenced fix is no_progress, because the server accepts 2->4 then 4->2 and progress would loop.
    ['a fix by slug with a directory Grep as file evidence', [toolUse('e1', 'mcp__sterling__knowledge_get', { id: 'art-a' }), toolOk('e1'), toolUse('e2', 'Grep', { pattern: 'x', path: 'src' }), toolOk('e2'), lineFix('f1', { id: 'art-a' }), fixOk('f1')]],
  ];
  for (const [name, events] of cases) {
    const fx = fixture();
    try {
      await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: fakeClaude([...events, resultEvent({})]).fn });
      assert.equal(lastRun(fx).no_progress, true, name);
      assert.equal(lastRun(fx).line_ref_fixes_ok, 1, `${name}: the fix is still journalled and counted as a call`);
    } finally {
      fx.cleanup();
    }
  }
});

test('[line-ref] ping-pong: two runs that each make an evidenced fix (2->4, then 4->2) and never close are both no_progress, and the launch after them backs off; a fix plus a successful close is still progress', async () => {
  const fx = fixture();
  try {
    const run = (token, events) => runWorker({ ...eligibleRun(fx, ITEM_A, token), spawn: fakeClaude([...events, resultEvent({})]).fn });
    await run('t1', [...evidenceForA(), lineFix('f1', { find: 'src/a.mjs:2', replace: 'src/a.mjs:4' }), fixOk('f1')]);
    assert.equal(lastRun(fx).no_progress, true);
    await run('t2', [...evidenceForA(), lineFix('f2', { find: 'src/a.mjs:4', replace: 'src/a.mjs:2' }), fixOk('f2')]);
    const second = lastRun(fx);
    assert.equal(second.no_progress, true, 'the second fix is no more progress than the first');
    assert.equal(second.line_ref_fixes_ok, 1);
    const sp = fakeSpawn();
    const blocked = launch(fx, { spawn: sp.fn, items: [ITEM('A')], now: Date.parse(second.at) + 60_000 });
    assert.equal(blocked.reason, 'backoff');
    assert.equal(sp.calls.length, 0);
    // fix, then the attested close: progress through closes_ok
    await run('t3', [...evidenceForA(), lineFix('f3', {}), fixOk('f3'), removeCall('c1', 'A'), removeResult('c1', removedText('A'))]);
    const closed = lastRun(fx);
    assert.equal(closed.no_progress, false);
    assert.equal(closed.closes_ok, 1);
    assert.equal(closed.line_ref_fixes_ok, 1);
  } finally {
    fx.cleanup();
  }
});

test('[line-ref] only refused fixes and no other progress is still no_progress; the plugin-mounted name is journalled the same; an unanswered fix is journalled at the end', async () => {
  const fx = fixture();
  try {
    const items = [{ id: 'A', file_keys: ['src/a.mjs'], feature_link: 'aaaaaaaa-1111-2222-3333-444444444444', slug: 'art-a' }];
    const refused = fakeClaude([
      { ...lineFix('f1', {}), message: { content: [{ type: 'tool_use', id: 'f1', name: 'mcp__plugin_sterling_sterling__knowledge_line_ref_fix', input: { id: 'x', field: 'what_it_does' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'refused', is_error: true }] } },
      lineFix('f2', {}),
      resultEvent({}),
    ]);
    await runWorker({ ...eligibleRun(fx, items), spawn: refused.fn });
    const lines = readJournal(fx).filter((l) => l.tool === 'knowledge_line_ref_fix');
    assert.deepEqual(lines.map((l) => l.is_error), [true, null]);
    assert.equal(lines[1].result, 'no result before the run ended');
    assert.equal(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.no_progress, true);
  } finally {
    fx.cleanup();
  }
});

test('[line-ref] streamJournal counts successful fixes and answers them as sterling calls', () => {
  const journalled = [];
  const s = streamJournal((e) => journalled.push(e));
  s.feed([lineFix('f1', {}), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'ok' }] } }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out = s.end();
  assert.equal(out.lineRefFixes, 1);
  assert.equal(out.lineRefFixesOk, 1);
  assert.equal(out.sterlingOk, 1);
});

test('[prompt] the shipped prompt works every lane, keeps the evidence and busy-retry rules, the line-reference tool, resolves only on the completing write, expected_version, the directory rule and the handoff report', () => {
  const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'maintenance-worker-prompt.md'), 'utf8');
  assert.doesNotMatch(prompt, /short of budget/i);
  assert.doesNotMatch(prompt, /STOP and leave the remaining items/);
  assert.match(prompt, /work every listed item/i);
  assert.match(prompt, /database is locked/i);
  assert.match(prompt, /retry that call once/i);
  assert.match(prompt, /mcp__sterling__knowledge_line_ref_fix/);
  assert.match(prompt, /quotes right next to that reference/);
  assert.match(prompt, /The fix tool closes nothing; after it, close the item with maintenance_remove/);
  // CHANGED (GitHub #56): the worker writes the factual refresh and claims resolves, but only on the completing write.
  for (const lane of WORKER_LANES) assert.match(prompt, new RegExp(`^- ${lane}\\. Read:`, 'm'), `${lane} has its evidence and completion rule`);
  assert.match(prompt, /pass `resolves: \[<the item's full id>\]` on the ONE write that completes the repair, and only if the PAID standard holds after it/);
  assert.match(prompt, /Never put `resolves` on an intermediate edit/);
  assert.match(prompt, /Pass `expected_version`/);
  assert.match(prompt, /SAME DIRECTORY/);
  assert.match(prompt, /set BOTH `source_date` and `capture_date`/);
  assert.match(prompt, /a web page never re-proves a measured local behaviour/);
  assert.match(prompt, /domain-held target/);
  assert.match(prompt, /"worker policy refused".*Hand the item off with the refusal text as the reason/s);
  assert.match(prompt, /"verdict":"needs_conductor"/);
  assert.match(prompt, /"verdict":"retry"/);
  assert.doesNotMatch(prompt, /owes_prose/, 'the old verdict name is gone from the work order');
});

// ------------------------------------------------------------ GitHub #56: every lane, the factual refresh, the policy, chaining
// (decision maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet)

const laneItem = (id, lane, ageMin, extra = {}) => ({ id, system_reason: lane, text: `item ${id}`, file_keys: [`src/${id}.mjs`], created_at: new Date(NOW - ageMin * 60_000).toISOString(), ...extra });

test('[#56 batch] selectBatch is bounded, round-robin across the worker lanes in their order, and oldest first within a lane', () => {
  const items = [
    ...Array.from({ length: 20 }, (_, i) => laneItem(`r${i}`, 'reconcile_needed', 100 - i)),
    laneItem('s-new', 'stale_research', 5),
    laneItem('s-old', 'stale_research', 50),
    laneItem('a1', 'article_missing', 10),
    laneItem('x1', 'capture_owed', 999),
  ];
  const batch = selectBatch(items, 6);
  assert.deepEqual(batch.map((t) => t.id), ['r0', 's-old', 'a1', 'r1', 's-new', 'r2'], 'one per lane per round; the deep lane cannot starve the others; capture_owed is not a worker lane');
  assert.equal(selectBatch(items).length, RUN_BATCH_MAX, 'the default bound');
  const undated = selectBatch([laneItem('dated', 'state_review', 60), { ...laneItem('undated', 'state_review', 0), created_at: undefined }], 1);
  assert.deepEqual(undated.map((t) => t.id), ['undated'], 'an undated item counts as oldest, as the batching check does');
});

test('[#56 batch] the launcher offers the child only the bounded batch, but batches on every eligible item', () => {
  const fx = fixture();
  try {
    const items = Array.from({ length: RUN_BATCH_MAX + 3 }, (_, i) => laneItem(`r${i}`, 'reconcile_needed', 1));
    const r = launch(fx, { spawn: fakeSpawn().fn, items });
    assert.deepEqual([r.launched, r.items, r.eligible], [true, RUN_BATCH_MAX, RUN_BATCH_MAX + 3]);
    const eligible = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    assert.equal(eligible.items.length, RUN_BATCH_MAX);
    assert.equal(eligible.policy_items.length, RUN_BATCH_MAX);
    assert.equal(eligible.queue_snapshot.length, RUN_BATCH_MAX + 3);
  } finally {
    fx.cleanup();
  }
});

test('[#56 policy] the launcher writes the batch policy into eligible.json (the shape of scripts/tests/fixtures/worker-policy.json) and the run hands it to the server as argv in the MCP config', async () => {
  const fx = fixture();
  try {
    const items = [
      laneItem('r1', 'reconcile_needed', 40, { feature_link: 'f-r1', text: "reconcile article 'art-r1' — changed" }),
      laneItem('s1', 'stale_research', 40, { feature_link: 'f-s1', file_keys: [], text: "re-verify research finding 'find-s1' — source_date old" }),
      laneItem('m1', 'article_missing', 40),
      laneItem('c1', 'capture_owed', 40),
    ];
    assert.equal(launch(fx, { spawn: fakeSpawn().fn, items }).launched, true);
    const eligible = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    const lockToken = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    // The shared fixture's shape (slice A): the old fields stay, the policy sits beside them.
    assert.equal(eligible.token, lockToken, 'the policy token is the lock token');
    assert.equal(eligible.head, HEAD);
    assert.equal(eligible.host, 'claude');
    assert.equal(eligible.policy_version, POLICY_VERSION);
    assert.equal(typeof eligible.run_id, 'string');
    assert.ok(eligible.run_id.length > 0);
    assert.deepEqual(eligible.policy_items, [
      { id: 'r1', lane: 'reconcile_needed', target_id: 'f-r1', file_keys: ['src/r1.mjs'] },
      { id: 's1', lane: 'stale_research', target_id: 'f-s1', file_keys: [] },
      { id: 'm1', lane: 'article_missing', target_id: null, file_keys: ['src/m1.mjs'] },
    ], "one policy item per batch item; capture_owed is not the worker's");
    assert.deepEqual(eligible.items.map((t) => [t.id, t.lane, t.feature_link, t.slug]), [['r1', 'reconcile_needed', 'f-r1', 'art-r1'], ['s1', 'stale_research', 'f-s1', 'find-s1'], ['m1', 'article_missing', null, null]]);
    assert.deepEqual(eligible.queue_snapshot.map((t) => t.id), ['r1', 's1', 'm1'], 'every eligible item, for the chained launch');

    const child = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, token: lockToken, budgetUsd: 2, now: () => NOW, ...quiet }), 0);
    const args = child.calls[0].args;
    const server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.sterling;
    assert.deepEqual(server.args.slice(-4), ['--worker-policy', fx.paths.eligible, '--worker-token', lockToken], 'policy path and token reach the server as argv');
    assert.ok(server.args[server.args.length - 3].startsWith('/'), 'the policy path is absolute');
    assert.ok(!Object.keys(child.calls[0].opts.env).some((k) => /POLICY/.test(k)), 'never as ambient env');
    assert.match(args[1], /- s1 lane stale_research target f-s1 file_keys \[\]/);
    assert.throws(() => resolveMcpConfig(fx.plugin, fx.project, { path: 'relative/eligible.json', token: 't' }), /absolute/);
    assert.throws(() => resolveMcpConfig(fx.plugin, fx.project, { path: fx.paths.eligible, token: '' }), /token/);
  } finally {
    fx.cleanup();
  }
});

test('[#56 fail closed] a run without the launcher token is refused and recorded; nothing is spawned', async () => {
  const fx = fixture();
  try {
    const child = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, budgetUsd: 2, now: () => NOW, ...quiet }), 1);
    assert.equal(child.calls.length, 0);
    assert.match(lastRun(fx).error, /no launch token/);
  } finally {
    fx.cleanup();
  }
});

const writeCall = (id, tool, input) => toolUse(id, `mcp__sterling__${tool}`, input);
const writeResult = (id, text, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] } });

test('[#56 stamp] a successful knowledge write without this run\'s stamp fails the run as "unpoliced write"; a stamped one is journalled and is progress; a refused write is neither', async () => {
  const cases = [
    ['no stamp', JSON.stringify({ ok: true, id: LINK, version: 4 }), false],
    ['a stamp from another run', stampedText('A', 'run-other'), false],
    ['a stamp for an item outside the batch', stampedText('Z'), false],
    ["this run's stamp", stampedText('A', RUN_ID, { id: LINK, version: 4 }), true],
  ];
  for (const [name, text, policed] of cases) {
    const fx = fixture();
    try {
      const child = fakeClaude([
        ...evidenceForA(),
        writeCall('w1', 'knowledge_edit', { id: LINK, field: 'files[path=src/a.mjs].role', find: 'old', replace: 'new' }),
        writeResult('w1', text),
        writeCall('w2', 'knowledge_update', { id: LINK, body: { state: 'built' }, expected_version: 3 }),
        writeResult('w2', "worker policy refused knowledge_update: rule 'field_not_allowed' — state. Policy item(s): A. Nothing was written.", true),
        resultEvent({}),
      ]);
      const code = await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: child.fn, relaunch: () => ({ launched: false, reason: 'test' }) });
      const last = lastRun(fx);
      const writes = readJournal(fx).filter((l) => l.kind === 'tool_call');
      assert.deepEqual(writes.map((l) => [l.tool, l.is_error]), [['knowledge_edit', false], ['knowledge_update', true]], name);
      assert.equal(writes[1].unpoliced, undefined, `${name}: a refused write is not checked for a stamp`);
      if (policed) {
        assert.equal(code, 0, name);
        assert.equal(last.ok, true, name);
        assert.deepEqual(writes[0].stamp, { run_id: RUN_ID, item_id: 'A', resolved: [] });
        assert.equal(last.writes_ok, 1);
        assert.equal(last.unpoliced_writes, 0);
        assert.equal(last.no_progress, false, 'a landed factual edit is progress');
      } else {
        assert.equal(code, 1, name);
        assert.equal(last.ok, false, name);
        assert.match(last.error, /unpoliced write: 1 successful knowledge write\(s\) without this run's worker_stamp \(knowledge_edit on aaaaaaaa/, name);
        assert.equal(writes[0].unpoliced, true, name);
        assert.equal(last.writes_ok, 0, name);
        assert.ok(workerBreakage(last), `${name}: H1 names the broken run`);
      }
    } finally {
      fx.cleanup();
    }
  }
  assert.equal(STAMP_KEY, 'worker_stamp');
  assert.deepEqual(findStamp('prefix {"worker_stamp":{"run_id":"r","item_id":"i","resolved":["i"]}} suffix'), { run_id: 'r', item_id: 'i', resolved: ['i'] }, 'a wrapped receipt (an OpenCode execute output) still yields its stamp');
  assert.deepEqual(findStamp(JSON.stringify({ receipt: { worker_stamp: { run_id: 'r', item_id: 'i' } } })), { run_id: 'r', item_id: 'i', resolved: [] }, 'a nested stamp counts; one without resolved closed nothing');
  assert.equal(findStamp('updated what_it_does'), null);
  assert.equal(findStamp(JSON.stringify({ worker_stamp: { run_id: 'r' } })), null, 'a stamp without an item is no stamp');
});

test('[#56 resolves] a closure comes from the server receipt: a stamp whose resolved names the item closes it; a write that asked to resolve it but came back retained does not', async () => {
  const join = { id: LINK, field: 'files', entries: [{ path: 'src/a.mjs', role: 'x' }], resolves: ['A'] };
  const cases = [
    ['resolved by the server', ['A'], 1],
    ['retained by the server (a partial article_missing join)', [], 0],
  ];
  for (const [name, resolved, closes] of cases) {
    const fx = fixture();
    try {
      const child = fakeClaude([
        ...evidenceForA(),
        writeCall('w1', 'knowledge_append', join),
        writeResult('w1', JSON.stringify({ ok: true, [STAMP_KEY]: { run_id: RUN_ID, item_id: 'A', resolved } })),
        resultEvent({ result: JSON.stringify({ item_id: 'A', lane: 'reconcile_needed', verdict: 'closed', reason: 'files[] role refreshed' }) }),
      ]);
      assert.equal(await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: child.fn, relaunch: () => ({ launched: false, reason: 'test' }) }), 0, name);
      const last = lastRun(fx);
      assert.deepEqual([last.ok, last.resolves_closed, last.writes_ok, last.no_progress], [true, closes, 1, false], name);
      assert.deepEqual(readJournal(fx).find((l) => l.tool === 'knowledge_append').resolves, ['A'], `${name}: the request is journalled as sent`);
    } finally {
      fx.cleanup();
    }
  }
});

test('[#56 remove stamp] a successful maintenance_remove without this run\'s stamp, or with a stamp naming another item, is an unpoliced write: the run fails and the item is not counted closed', async () => {
  const items = [...ITEM_A, { id: 'B', file_keys: ['src/b.mjs'], feature_link: null, slug: null }];
  const cases = [
    ['no stamp', 'Closed as ALREADY-PAID'],
    ['a stamp from another run', removedText('A', 'run-other')],
    ['a stamp naming another batch item', removedText('B')],
  ];
  for (const [name, text] of cases) {
    const fx = fixture();
    try {
      const child = fakeClaude([removeCall('c1', 'A'), removeResult('c1', text), resultEvent({})]);
      assert.equal(await runWorker({ ...eligibleRun(fx, items), spawn: child.fn, relaunch: () => ({ launched: false, reason: 'test' }) }), 1, name);
      const last = lastRun(fx);
      assert.equal(last.ok, false, name);
      assert.match(last.error, /unpoliced write: 1 successful knowledge write\(s\) without this run's worker_stamp \(maintenance_remove on A\)/, name);
      assert.equal(last.unpoliced_writes, 1, name);
      assert.equal(readJournal(fx).find((l) => l.tool === 'maintenance_remove').unpoliced, true, name);
    } finally {
      fx.cleanup();
    }
  }
});

test('[#56 budget] a budget cap reached after progress is a normal end; without progress it is still a failure', async () => {
  const fx = fixture();
  try {
    const capped = (events) => fakeClaude([...events, resultEvent({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.02 })], { code: 1 });
    const progressed = capped([removeCall('c1', 'A'), removeResult('c1', removedText('A'))]);
    assert.equal(await runWorker({ ...eligibleRun(fx, ITEM_A), spawn: progressed.fn, relaunch: () => ({ launched: false, reason: 'test' }) }), 0);
    let last = lastRun(fx);
    assert.deepEqual([last.ok, last.error, last.budget_capped, last.no_progress, last.cost_usd], [true, null, true, false, 5.02]);
    assert.equal(workerBreakage(last), null, 'H1 shows no FAILED note for it');

    const idle = capped([]);
    assert.equal(await runWorker({ ...eligibleRun(fx, ITEM_A, 'tok2'), spawn: idle.fn }), 1);
    last = lastRun(fx);
    assert.equal(last.ok, false);
    assert.match(last.error, /exit 1; error result \(error_max_budget_usd\)/);
  } finally {
    fx.cleanup();
  }
});

test('[#56 chain] a run that closed an item with eligible work left re-enters the launcher with what is left, after releasing the lock; no progress, nothing left or a failed run does not', async () => {
  const fx = fixture();
  try {
    const armWithSnapshot = (token, snapshot) => {
      const opts = eligibleRun(fx, ITEM_A, token);
      const e = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
      writeFileSync(fx.paths.eligible, JSON.stringify({ ...e, queue_snapshot: snapshot }));
      return opts;
    };
    const snapshot = [{ id: 'A', system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'] }, { id: 'B', system_reason: 'state_review', file_keys: ['src/b.mjs'] }];
    const calls = [];
    const relaunch = (items) => {
      calls.push({ items: items.map((t) => t.id), lockHeld: existsSync(fx.paths.lock) });
      return { launched: true, reason: 'launched' };
    };
    const closing = fakeClaude([removeCall('c1', 'A'), removeResult('c1', removedText('A')), resultEvent({})]);
    assert.equal(await runWorker({ ...armWithSnapshot('t1', snapshot), spawn: closing.fn, relaunch }), 0);
    assert.deepEqual(calls, [{ items: ['B'], lockHeld: false }], 'the closed item is dropped, and the relaunch comes after the lock is released');
    assert.deepEqual(readJournal(fx).filter((l) => l.kind === 'chain').map((l) => [l.launched, l.items_left]), [[true, 1]]);

    const idle = fakeClaude([resultEvent({ result: owes('A', 'art-a') })]);
    await runWorker({ ...armWithSnapshot('t2', snapshot), spawn: idle.fn, relaunch });
    assert.equal(calls.length, 1, 'no progress: no chain (the back-off applies instead)');

    const lastOne = fakeClaude([removeCall('c1', 'A'), removeResult('c1', removedText('A')), resultEvent({})]);
    await runWorker({ ...armWithSnapshot('t3', [snapshot[0]]), spawn: lastOne.fn, relaunch });
    assert.equal(calls.length, 1, 'nothing left: no chain');

    const failed = fakeClaude([removeCall('c1', 'A'), removeResult('c1', removedText('A')), resultEvent({ permission_denials: [{ tool_name: 'Bash' }] })]);
    await runWorker({ ...armWithSnapshot('t4', snapshot), spawn: failed.fn, relaunch });
    assert.equal(calls.length, 1, 'a failed run does not chain');
  } finally {
    fx.cleanup();
  }
});

test('[#56 chain] multi-run: an edit that does not close its item, an evidence-backed handoff and a close each let the chain go on, and every item an earlier run was offered stays out of it', async () => {
  const fx = fixture();
  try {
    const item = (id) => ({ id, file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' });
    const snap = (ids) => ids.map((id) => ({ id, system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK }));
    const arm = (token, batch, snapshot, attempted) => {
      const opts = eligibleRun(fx, batch.map(item), token);
      const e = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
      writeFileSync(fx.paths.eligible, JSON.stringify({ ...e, queue_snapshot: snap(snapshot), chain_attempted: attempted }));
      return opts;
    };
    const calls = [];
    const relaunch = (items, chain) => {
      calls.push({ items: items.map((t) => t.id), attempted: chain.attempted });
      return { launched: true, reason: 'launched' };
    };
    // Run 1: a stamped edit on A that closes nothing. A stays open, but the chain moves past it.
    const edit = [...evidenceForA(), writeCall('w1', 'knowledge_update', { id: LINK, body: { what_it_does: 'x.' }, expected_version: 2 }), writeResult('w1', stampedText('A'))];
    await runWorker({ ...arm('t1', ['A'], ['A', 'B', 'C'], []), spawn: fakeClaude([...edit, resultEvent({})]).fn, relaunch });
    assert.equal(lastRun(fx).resolves_closed, 0);
    assert.deepEqual(calls.at(-1), { items: ['B', 'C'], attempted: ['A'] }, 'the edited, unclosed item is not offered again in this chain');

    // Run 2: only an evidence-backed handoff. The snapshot still names A; the carried attempts keep it out.
    await runWorker({ ...arm('t2', ['B'], ['A', 'B', 'C'], ['A']), spawn: fakeClaude([...evidenceForA(), resultEvent({ result: owes('B', 'art-a') })]).fn, relaunch });
    assert.equal(lastRun(fx).evidenced_verdicts, 1);
    assert.equal(lastRun(fx).no_progress, false, 'an evidence-backed handoff is progress');
    assert.deepEqual(calls.at(-1), { items: ['C'], attempted: ['A', 'B'] });

    // Run 3: a close with nothing left that this chain has not been offered: the chain ends.
    await runWorker({ ...arm('t3', ['C'], ['A', 'B', 'C'], ['A', 'B']), spawn: fakeClaude([removeCall('c1', 'C'), removeResult('c1', removedText('C')), resultEvent({})]).fn, relaunch });
    assert.equal(lastRun(fx).closes_ok, 1);
    assert.equal(calls.length, 2, 'nothing left: no third relaunch');
  } finally {
    fx.cleanup();
  }
});

test('[#56 chain] the default relaunch goes through the real launcher inside the debounce window, spawns the next runner for the items no run of the chain was offered, and carries the attempted ids in eligible.json; the runner\'s inside-worker flag does not block it', async () => {
  const fx = fixture();
  const prevEnv = process.env.STERLING_MAINTENANCE_WORKER;
  const prevDisable = process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
  try {
    // 13 items: the first batch holds 12 (RUN_BATCH_MAX), so one is left for the chain.
    const items = Array.from({ length: 13 }, (_, i) => laneItem(`a${i + 1}`, 'reconcile_needed', 100 - i));
    assert.equal(launch(fx, { spawn: fakeSpawn().fn, items }).launched, true);
    const first = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    assert.equal(first.policy_items.length, RUN_BATCH_MAX);
    assert.deepEqual(first.chain_attempted, [], 'an external trigger starts the chain with no attempts');
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    const runner = fakeSpawn({ pid: 5151 });
    const spawn = (cmd, args, opts) =>
      cmd === process.execPath ? runner.fn(cmd, args, opts) : fakeClaude([removeCall('c1', 'a1'), removeResult('c1', removedText('a1', first.run_id)), resultEvent({})]).fn(cmd, args, opts);
    process.env.STERLING_MAINTENANCE_WORKER = '1'; // the runner's own environment carries the flag
    // The npm test preload sets the test-run guard; this test injects every spawn, so it lifts it.
    delete process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
    // The launch above wrote last-launch at NOW, so the chained launch below is inside the debounce window.
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn, token, budgetUsd: 2, now: () => NOW, spawnSync: CLEAN_GIT, ...quiet }), 0);
    assert.deepEqual(readJournal(fx).filter((l) => l.kind === 'chain').map((l) => [l.launched, l.reason, l.items_left]), [[true, 'launched', 1]], 'a chained launch is not debounced');
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].args[4], 'chain', 'the chained run carries trigger chain');
    assert.equal(runner.calls[0].opts.env.STERLING_MAINTENANCE_WORKER, '1', 'the launcher marks the new runner again');
    const next = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    assert.deepEqual(next.policy_items.map((t) => t.id), ['a13'], 'only the item no run of this chain was offered');
    assert.deepEqual([...next.chain_attempted].sort(), first.policy_items.map((t) => t.id).sort(), 'the attempted ids travel with the chain');

    // An external trigger past the debounce starts over: no carried attempts.
    rmSync(fx.paths.lock, { force: true });
    const fresh = launch(fx, { spawn: fakeSpawn().fn, items: items.slice(1), now: NOW + DEBOUNCE_MS + 1 });
    assert.equal(fresh.launched, true);
    assert.deepEqual(JSON.parse(readFileSync(fx.paths.eligible, 'utf8')).chain_attempted, []);
  } finally {
    if (prevEnv === undefined) delete process.env.STERLING_MAINTENANCE_WORKER;
    else process.env.STERLING_MAINTENANCE_WORKER = prevEnv;
    if (prevDisable === undefined) delete process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
    else process.env.STERLING_MAINTENANCE_WORKER_DISABLE = prevDisable;
    fx.cleanup();
  }
});

test('[#56 lock] a failure after the lock is taken (writing eligible.json) releases the lock and is logged; the spawn never happens', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.paths.eligible, { recursive: true }); // a directory where the file goes: the write throws EISDIR
    const sp = fakeSpawn();
    const r = launch(fx, { spawn: sp.fn });
    assert.equal(r.launched, false);
    assert.equal(r.reason, 'error');
    assert.match(r.detail, /launch FAILED \(write the launch files: EISDIR/);
    assert.equal(sp.calls.length, 0);
    assert.equal(existsSync(fx.paths.lock), false, 'the slot is freed for the next trigger');
  } finally {
    fx.cleanup();
  }
});

test('[#56 handoff] a needs_conductor verdict needs a reason; a temporary failure is a retry, never a standing handoff; a worker-policy refusal is a handoff whatever it names', async () => {
  const fx = fixture();
  try {
    const items = [
      { id: 'A', lane: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' },
      { id: 'B', lane: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' },
      { id: 'C', lane: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' },
      { id: 'D', lane: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' },
      { id: 'E', lane: 'reconcile_needed', file_keys: ['src/a.mjs'], feature_link: LINK, slug: 'art-a' },
    ];
    const v = (id, verdict, reason) => JSON.stringify({ item_id: id, verdict, ...(reason === undefined ? {} : { reason }) });
    const child = fakeClaude([
      ...evidenceForA(),
      resultEvent({
        result: [
          v('A', 'needs_conductor', 'the article does not describe the new --dry-run flag'),
          v('B', 'needs_conductor'),
          v('C', 'needs_conductor', 'knowledge_update failed: version conflict (expected_version 3, found 4)'),
          v('D', 'retry', 'SQLITE_BUSY: database is locked'),
          v('E', 'needs_conductor', "worker policy refused knowledge_update: rule 'expected_version_required' — missing. Policy item(s): E. Nothing was written."),
        ].join('\n'),
      }),
    ]);
    await runWorker({ ...eligibleRun(fx, items), spawn: child.fn });
    const verdicts = readJournal(fx).filter((l) => l.kind === 'verdict');
    assert.deepEqual(verdicts.map((l) => [l.item_id, l.verdict, l.evidence ?? null]), [
      ['A', 'needs_conductor', true],
      ['B', 'unjudged', null],
      ['C', 'retry', null],
      ['D', 'retry', null],
      ['E', 'needs_conductor', true],
    ]);
    assert.ok(verdicts.every((l) => l.capability === WORKER_CAPABILITY));
    assert.deepEqual([...handoffVerdicts(fx.project).keys()].sort(), ['A', 'E'], 'only the standing handoffs');
    assert.equal(lastRun(fx).retry_verdicts, 2);
  } finally {
    fx.cleanup();
  }
});

test('[#56 evidence] each lane needs its own reads: stale_research a re-check, refresh_reference its file, article_missing a file and an owner search', () => {
  const root = '/p';
  const files = new Set(['/p/src/a.mjs']);
  const none = new Set();
  const art = new Set(['f-1']);
  const item = (lane, keys = ['src/a.mjs']) => ({ id: 'i', lane, file_keys: keys, feature_link: 'f-1' });
  assert.equal(hasEvidence(item('stale_research', []), art, none, root, none, { web: true }), true, 'finding read and a web re-check');
  assert.equal(hasEvidence(item('stale_research', []), art, files, root), true, 'finding read and a local re-check');
  assert.equal(hasEvidence(item('stale_research', []), art, none, root), false, 'the finding alone re-checks nothing');
  assert.equal(hasEvidence(item('refresh_reference'), art, files, root), true);
  assert.equal(hasEvidence(item('refresh_reference'), art, none, root, none, { web: true }), false, 'a web page does not stand in for the reference\'s own file');
  assert.equal(hasEvidence(item('refresh_reference', []), art, none, root, none, { web: true }), true, 'a reference with no file is re-checked on the web');
  assert.equal(hasEvidence(item('article_missing'), none, files, root, none, { queried: true }), true);
  assert.equal(hasEvidence(item('article_missing'), none, files, root), false, 'no owner search');
  assert.equal(hasEvidence(item('state_review'), art, none, root), false, 'state_review needs the files too');
  assert.equal(hasEvidence(item('state_review'), art, files, root), true);
});

test('[#56 rotation] a needs_conductor verdict keeps its reason, lane and capability through two rotations, and the write count survives as a carried count', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'h', lane: 'stale_research', verdict: 'needs_conductor', file_keys: [], reason: 'the measured latency changed: 40ms is now 90ms', evidence: true, capability: WORKER_CAPABILITY });
    journalLine(fx, { kind: 'tool_call', tool: 'knowledge_update', is_error: false, stamp: { run_id: 'r', item_id: 'x' } });
    journalLine(fx, { kind: 'tool_call', tool: 'knowledge_edit', is_error: false, stamp: { run_id: 'r', item_id: 'y' } });
    journalLine(fx, { kind: 'tool_call', tool: 'knowledge_edit', is_error: true });
    appendFileSync(fx.paths.journal, 'x'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    appendFileSync(fx.paths.journal, 'y'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    const h = handoffVerdicts(fx.project).get('h');
    assert.deepEqual(h, { keys: '[]', reason: 'the measured latency changed: 40ms is now 90ms', lane: 'stale_research' });
    assert.equal(judgedVerdicts(fx.project).get('h').capability, WORKER_CAPABILITY);
    assert.deepEqual(workerWriteCount(fx.project), { count: 2, path: '.sterling/maintenance-worker.jsonl' });
  } finally {
    fx.cleanup();
  }
});

test('[#56 re-judge] an owes_prose verdict from the judge-only worker is judged once more: it does not stand, the item launches, and the new needs_conductor verdict then stands', async () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'A', verdict: 'owes_prose', file_keys: ['src/a.mjs'], reason: 'old judge-only verdict', evidence: true });
    assert.equal(judgedVerdicts(fx.project).size, 0, 'no capability marker: not a standing verdict');
    const store = { count: () => 1, query: () => [ITEM('A', ['src/a.mjs'])] };
    assert.deepEqual(unjudgedWorkerItems(store, fx.project).map((t) => t.id), ['A']);
    const r = launch(fx, { spawn: fakeSpawn().fn, items: [{ ...ITEM('A', ['src/a.mjs']), created_at: new Date(NOW - BATCH_MAX_WAIT_MS).toISOString() }] });
    assert.equal(r.launched, true, 'launchable again');
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    // the launcher's item carries the slug 'A' (from its text) and no feature_link: the evidence is by slug
    const getBySlug = fakeClaude([toolUse('g', 'mcp__sterling__knowledge_get', { id: 'A' }), toolOk('g'), toolUse('r', 'Read', { file_path: 'src/a.mjs' }), toolOk('r'), resultEvent({ result: JSON.stringify({ item_id: 'A', verdict: 'needs_conductor', reason: 'a new refusal path the article does not describe' }) })]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: getBySlug.fn, token, budgetUsd: 2, now: () => NOW, ...quiet }), 0);
    const v = judgedVerdicts(fx.project).get('A');
    assert.deepEqual([v.verdict, v.capability, v.reason], ['needs_conductor', WORKER_CAPABILITY, 'a new refusal path the article does not describe']);
    rmSync(fx.paths.lastLaunch);
    assert.equal(launch(fx, { spawn: fakeSpawn().fn, items: [ITEM('A', ['src/a.mjs'])] }).reason, 'queue_empty', 'judged once: the handoff now stands');
  } finally {
    fx.cleanup();
  }
});
