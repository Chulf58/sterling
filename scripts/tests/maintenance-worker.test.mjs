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
  owesProseVerdicts,
  resolveMcpConfig,
  rotateIfLarge,
  runWorker,
  streamJournal,
  unjudgedReconcileItems,
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

test('[finding 3] an item judged owes_prose in the JSONL for its CURRENT file_keys is not launchable; a re-mint that adds a path makes it launchable again', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'a', verdict: 'owes_prose', file_keys: ['src/x.mjs'], reason: 'new flag', evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'b', verdict: 'owes_prose', file_keys: ['src/y.mjs'], reason: 'r', evidence: true });
    appendFileSync(fx.paths.journal, '{"torn line\n');
    const items = [ITEM('a', ['src/x.mjs']), ITEM('b', ['src/z.mjs', 'src/y.mjs']), ITEM('c')];
    const seen = [];
    const store = { count: (f) => (seen.push(['count', f]), items.length), query: (f) => (seen.push(['query', f]), items) };
    const out = unjudgedReconcileItems(store, fx.project).map((t) => t.id);
    assert.deepEqual(out, ['b', 'c'], "a is judged for its current keys; b's keys widened since its verdict; c was never judged");
    assert.deepEqual(seen[1], ['query', { types: ['todo'], source: 'system', cap: 3 }], 'the query cap IS the count, so it cannot truncate');
    assert.ok(workerPrompt(fx.plugin, fx.project).includes('ALREADY JUDGED (skip each'), 'the child is told which items to skip');
    assert.ok(workerPrompt(fx.plugin, fx.project).includes('- a owes_prose file_keys ["src/x.mjs"]'));
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
    assert.deepEqual(call.args, [join(fx.plugin, 'scripts', 'maintenance-worker-run.mjs'), '--project', fx.project, '--trigger', 'stop', '--token', lock.token, '--budget-usd', '2']);
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

test('builds the probed claude argv: Sonnet 5.5, low effort, librarian, dontAsk, every tool named, every write denied, strict MCP, stream-json + verbose, budget cap', () => {
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
      '--max-budget-usd', '2',
    ]);
    // CHANGED (point 4, line references): the two mounted names of knowledge_line_ref_fix join the
    // allowlist; every other entry, and the absence of board_update, is unchanged.
    assert.deepEqual(WORKER_TOOLS, ['mcp__sterling__maintenance_query', 'mcp__sterling__knowledge_get', 'mcp__sterling__maintenance_remove', 'mcp__sterling__knowledge_line_ref_fix', 'mcp__plugin_sterling_sterling__knowledge_line_ref_fix', 'Read', 'Grep'], '[finding 3] no board_update');
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

test('[finding 4] --disallowedTools names every store, board and config write plus Write, Edit and Bash, and none is also allowed', () => {
  const expected = [
    ...['create', 'update', 'append', 'edit', 'array_remove', 'retire', 'supersede', 'split', 'extract', 'promote', 'link'].map((v) => `mcp__sterling__knowledge_${v}`),
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
    assert.equal(WORKER_RUN_BUDGET_USD, 2);
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
      '{"item_id":"22222222-2222-2222-2222-222222222222","article":"b","verdict":"owes_prose","file_keys":["src/b.mjs"],"reason":"new refusal not described"}',
    ].join('\n');
    const sp = fakeClaude([
      { type: 'system', subtype: 'init' },
      toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'bbbbbbbb-0000-0000-0000-000000000000' }),
      toolOk('k1'),
      toolUse('r1', 'Read', { file_path: 'src/b.mjs' }),
      toolOk('r1'),
      removeCall('t1', '11111111-1111-1111-1111-111111111111'),
      removeResult('t1', 'Closed as ALREADY-PAID'),
      removeCall('t2', '33333333-3333-3333-3333-333333333333'),
      removeResult('t2', 'refused: worktree differs from HEAD', true),
      resultEvent({ result }),
    ]);
    writeState(fx, { spend: { '2026-09-29': 1 } });
    writeFileSync(fx.paths.lock, JSON.stringify({ pid: process.pid, started_at: new Date(NOW).toISOString(), token: 'tok' }));
    writeFileSync(fx.paths.eligible, JSON.stringify({ token: 'tok', head: HEAD, items: [{ id: '22222222-2222-2222-2222-222222222222', file_keys: ['src/b.mjs'], feature_link: 'bbbbbbbb-0000-0000-0000-000000000000', slug: 'b' }] }));
    const code = await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: sp.fn, trigger: 'stop', token: 'tok', budgetUsd: 2, now: () => NOW, ...quiet });
    assert.equal(code, 0);
    assert.equal(sp.calls[0].cmd, 'claude');
    assert.ok(sp.calls[0].args[1].startsWith('PROMPT BODY\n'), 'the shipped prompt file leads the -p argument');
    const lines = readJournal(fx);
    assert.deepEqual(lines.map((l) => l.kind), ['tool_call', 'tool_call', 'verdict', 'verdict', 'run_summary']);
    assert.deepEqual([lines[0].item_id, lines[0].is_error, lines[0].result], ['11111111-1111-1111-1111-111111111111', false, 'Closed as ALREADY-PAID']);
    assert.equal(lines[1].is_error, true, 'a refused close is on record too');
    assert.deepEqual([lines[0].item_file_keys_at_launch, lines[1].item_file_keys_at_launch], [null, null], 'ids not in eligible.json journal null');
    assert.equal(lines[3].verdict, 'owes_prose');
    assert.equal(lines[4].remove_calls, 2);
    assert.deepEqual([...owesProseVerdicts(fx.project).keys()], ['22222222-2222-2222-2222-222222222222']);
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
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: denied.fn, trigger: 'commit', ...quiet }), 1);
    assert.match(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.error, /1 permission denial/);

    const budget = fakeClaude([resultEvent({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.01 })]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: budget.fn, trigger: 'stop', ...quiet }), 1);
    const st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.match(st.last_run.error, /error_max_budget_usd/);
    assert.equal(st.last_run.cost_usd, 2.01, 'a failed run still records its reported cost');

    const crashed = fakeClaude(['not json'], { code: 3 });
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: crashed.fn, trigger: 'stop', ...quiet }), 1);
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
    const code = await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: hung.fn, trigger: 'stop', timeoutMs: 30, ...quiet });
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
    journalLine(fx, { kind: 'verdict', item_id: 'old', verdict: 'owes_prose', file_keys: ['k'], evidence: true });
    appendFileSync(fx.paths.journal, 'x'.repeat(ROTATE_BYTES));
    writeFileSync(`${fx.paths.journal}.1`, 'previous backup');
    rotateIfLarge(fx.paths.journal);
    assert.equal(existsSync(fx.paths.journal), false);
    assert.ok(statSync(`${fx.paths.journal}.1`).size > ROTATE_BYTES, 'the single backup is replaced');
    assert.deepEqual([...owesProseVerdicts(fx.project).keys()], ['old']);
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
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: crashed.fn, budgetUsd: 1.5, now: () => NOW, ...quiet }), 1);
    let st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.equal(st.last_run.cost_usd, null, 'the reported cost stays unknown');
    assert.equal(st.last_run.charged_usd, undefined, 'nothing is charged against a cap that no longer exists');
    assert.equal(st.spend, undefined);

    const hung = fakeClaude([], { hang: true });
    await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: hung.fn, budgetUsd: 2, timeoutMs: 20, now: () => NOW, ...quiet });
    st = JSON.parse(readFileSync(fx.paths.state, 'utf8'));
    assert.equal(st.last_run.ok, false);
    assert.equal(st.last_run.cost_usd, null);

    const ok = fakeClaude([resultEvent({ total_cost_usd: 0.1 })]);
    await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: ok.fn, budgetUsd: 2, now: () => NOW, ...quiet });
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
      assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, budgetUsd: bad, ...quiet }), 1, `budget ${JSON.stringify(bad)}`);
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
      assert.match(r.detail, /git could not report HEAD or the working-tree state .* every reconcile item counts as dirty and no worker starts/);
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
    journalLine(fx, { kind: 'verdict', item_id: 'judged', verdict: 'owes_prose', file_keys: ['src/j.mjs'], evidence: true });
    const items = [ITEM('clean', ['src/c.mjs']), ITEM('dirty', ['src/a.mjs']), ITEM('judged', ['src/j.mjs'])];
    assert.equal(launch(fx, { spawn: fakeSpawn().fn, items, spawnSync: fakeGit({ porcelain: ' M src/a.mjs\0' }) }).launched, true);
    const eligible = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    const token = JSON.parse(readFileSync(fx.paths.lock, 'utf8')).token;
    assert.equal(eligible.token, token);
    assert.equal(eligible.head, HEAD);
    assert.deepEqual(eligible.items, [{ id: 'clean', file_keys: ['src/c.mjs'], feature_link: null, slug: 'clean' }], 'ids, keys and the article identity the evidence gate needs');

    const child = fakeClaude([resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, token, budgetUsd: 2, ...quiet }), 0);
    const prompt = child.calls[0].args[1];
    const section = prompt.slice(prompt.indexOf('ELIGIBLE'), prompt.indexOf('ALREADY JUDGED'));
    assert.match(section, /- clean file_keys/);
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
    await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: child.fn, budgetUsd: 2, logCapBytes: 500, log: (t) => written.push(t) });
    const text = written.join('');
    const note = text.indexOf('[maintenance-worker-run: log truncated at 500 bytes');
    assert.ok(note > 0, 'the truncation is announced once');
    assert.equal(note, 501, 'exactly the cap was written before the note');
    assert.equal(readJournal(fx).filter((l) => l.kind === 'tool_call').length, 20);
  } finally {
    fx.cleanup();
  }
});

test('[PARTIAL 9] rotating the JSONL carries standing owes_prose and refused verdicts forward, so a second rotation loses none', () => {
  const fx = fixture();
  try {
    journalLine(fx, { kind: 'verdict', item_id: 'o', verdict: 'owes_prose', file_keys: ['a'], evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'r', verdict: 'refused', file_keys: ['b'], head: HEAD, evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'c', verdict: 'owes_prose', file_keys: ['c'], evidence: true });
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
  writeFileSync(fx.paths.eligible, JSON.stringify({ token, head, items }));
  return { root: fx.project, pluginRoot: fx.plugin, token, budgetUsd: 2, now: () => NOW, ...quiet };
}
const owes = (id, slug) => JSON.stringify({ item_id: id, article: slug, verdict: 'owes_prose', file_keys: ['ignored-by-the-gate'], reason: 'the article does not name the new flag' });

test('[gate] an owes_prose verdict stands only when the stream shows a SUCCESSFUL knowledge_get on its article AND a successful Read/Grep covering one of its files; otherwise it is journalled unjudged/no evidence', async () => {
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
      ['A', 'owes_prose', true, 'the article does not name the new flag'],
      ['B', 'unjudged', null, 'no evidence'],
      ['C', 'unjudged', null, 'no evidence'],
      // CHANGED (conductor ruling 2026-09-29): D was 'unjudged' when a directory Grep never counted; a
      // successful Grep over a directory that holds one of the item's file_keys now counts as file evidence.
      ['D', 'owes_prose', true, 'the article does not name the new flag'],
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
    assert.deepEqual(verdicts[0], { at: verdicts[0].at, run: verdicts[0].run, kind: 'verdict', item_id: 'A', article: 'art-a', verdict: 'unjudged', reason: 'a refused verdict is recorded by the runner, not the child', claimed_reason: 'I say it was refused' });
    assert.deepEqual(Object.keys(verdicts[1]).sort(), ['article', 'at', 'item_id', 'kind', 'reason', 'run', 'verdict'], 'only the allowed fields are copied');
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
    journalLine(fx, { kind: 'verdict', item_id: 'gated', verdict: 'owes_prose', file_keys: ['src/b.mjs'], evidence: true });
    assert.deepEqual([...judgedVerdicts(fx.project).keys()], ['gated']);
    assert.deepEqual([...owesProseVerdicts(fx.project).keys()], ['gated'], 'H1 counts only gated verdicts');
    const store = { count: () => 2, query: () => [ITEM('legacy', ['src/a.mjs']), ITEM('gated', ['src/b.mjs'])] };
    assert.deepEqual(unjudgedReconcileItems(store, fx.project).map((t) => t.id), ['legacy'], 'the legacy item is launchable again');
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

    const closing = fakeClaude([removeCall('t1', 'A'), removeResult('t1', 'Closed as ALREADY-PAID'), resultEvent({})]);
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
    journalLine(fx, { kind: 'verdict', item_id: 'gated', verdict: 'owes_prose', file_keys: ['b'], evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'refused', verdict: 'refused', file_keys: ['c'], head: HEAD, evidence: true });
    journalLine(fx, { kind: 'verdict', item_id: 'unj', verdict: 'unjudged', reason: 'no evidence' });
    appendFileSync(fx.paths.journal, 'x'.repeat(300) + '\n');
    rotateJournal(fx.project, 200);
    const carried = readJournal(fx);
    assert.deepEqual(carried.map((l) => [l.item_id, l.verdict, l.evidence]).sort(), [['gated', 'owes_prose', true], ['refused', 'refused', true]]);
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
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: down.fn, ...quiet }), 1);
    let last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, false);
    assert.equal(last.mcp_status, 'failed');
    assert.match(last.error, /MCP server 'sterling' not connected \(failed\)/);
    assert.equal(readJournal(fx).at(-1).mcp_status, 'failed', 'the journal summary carries it too');

    const up = fakeClaude([{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'sterling', status: 'connected' }] }, resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: up.fn, ...quiet }), 0);
    last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.ok, last.mcp_status], [true, 'connected']);

    // L3: only an explicit failed/disconnected status, or a non-connected status with no
    // successful sterling tool call, is breakage. 'pending' is unknown when the stream shows the server worked.
    const initWith = (status) => ({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'sterling', status }] });
    const pendingWorked = fakeClaude([initWith('pending'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolOk('k1'), resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: pendingWorked.fn, ...quiet }), 0, 'pending + a successful sterling call is not broken');
    last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.deepEqual([last.ok, last.error, last.mcp_status], [true, null, 'pending']);

    const pendingIdle = fakeClaude([initWith('pending'), resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: pendingIdle.fn, ...quiet }), 1, 'pending and no successful sterling call is broken');
    assert.match(JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run.error, /MCP server 'sterling' not connected \(pending/);

    const pendingErrored = fakeClaude([initWith('pending'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolErr('k1'), resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: pendingErrored.fn, ...quiet }), 1, 'an errored sterling call is not a success');

    const disconnected = fakeClaude([initWith('disconnected'), toolUse('k1', 'mcp__sterling__knowledge_get', { id: 'x' }), toolOk('k1'), resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: disconnected.fn, ...quiet }), 1, 'an explicit disconnected status is broken');

    const closedWhilePending = fakeClaude([initWith('pending'), removeCall('t1', 'A'), removeResult('t1', 'Closed'), resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: closedWhilePending.fn, ...quiet }), 0, 'a successful maintenance_remove is a successful sterling call');

    const silent = fakeClaude([{ type: 'system', subtype: 'init' }, resultEvent({})]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, spawn: silent.fn, ...quiet }), 0, 'no mcp_servers in the init event is unknown, not broken');
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
    assert.match(readFileSync(fx.paths.log, 'utf8'), /batching: 4 of 5 eligible reconcile items, oldest waited 4m of 30m/);
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
    assert.match(readFileSync(fx.paths.log, 'utf8'), /batching: 1 of 5 eligible reconcile items, oldest waited 1m of 30m/);
    assert.equal(sp.calls.length, 0);

    // an old item already judged owes_prose (evidence-backed) for its CURRENT file_keys: it neither
    // makes the batch nor supplies the age, so the lone young item still batches
    journalLine(fx, { kind: 'verdict', item_id: 'judged', verdict: 'owes_prose', file_keys: ['src/judged.mjs'], evidence: true });
    const judged = launch(fx, { spawn: sp.fn, items: [aged('judged', 2 * BATCH_MAX_WAIT_MS), aged('young', MIN)] });
    assert.equal(judged.reason, 'batching');
    assert.equal(readFileSync(fx.paths.log, 'utf8').split('batching: 1 of 5 eligible reconcile items, oldest waited 1m of 30m').length - 1, 2, 'the judged item did not count: both launches logged 1 of 5');
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
    assert.equal(unjudgedReconcileItems(store, fx.project, HEAD).length, 1, 'the item stays eligible');
    const last = JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;
    assert.equal(last.ok, true, 'a locked database is not a failed run');
    assert.equal(last.refused_verdicts, 0);
    assert.equal(last.busy_calls, 1);
    // the tool call itself is still on record
    assert.equal(lines.filter((l) => l.kind === 'tool_call' && l.is_error === true).length, 2);
    // the retry after the lock clears closes it and is progress
    await busyRun(fx, items, [removeCall('t1', 'A'), removeResult('t1', BUSY_TEXT, true), removeCall('t2', 'A'), removeResult('t2', 'Closed as ALREADY-PAID')], 'tok2');
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
const fixOk = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'updated what_it_does' }] } });
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
    await run('t3', [...evidenceForA(), lineFix('f3', {}), fixOk('f3'), removeCall('c1', 'A'), removeResult('c1', 'Closed as ALREADY-PAID')]);
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

test('[prompt] the shipped prompt no longer invites an early stop, keeps the evidence wording, and documents the busy retry and the line-reference tool', () => {
  const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'maintenance-worker-prompt.md'), 'utf8');
  assert.doesNotMatch(prompt, /short of budget/i);
  assert.doesNotMatch(prompt, /STOP and leave the remaining items/);
  assert.match(prompt, /judge every listed item/i);
  assert.match(prompt, /never stamped owes_prose without reading/i);
  assert.match(prompt, /A verdict needs evidence\. Before you report owes_prose, you must have called knowledge_get on the item's article AND either Read one of the item's file_keys or run Grep/);
  assert.match(prompt, /database is locked/i);
  assert.match(prompt, /retry that call once/i);
  assert.match(prompt, /mcp__sterling__knowledge_line_ref_fix/);
  assert.match(prompt, /anchor/);
  // CHANGED (review): the tool lost its resolves argument; the item is closed only with the attested maintenance_remove.
  assert.doesNotMatch(prompt, /resolves/);
  assert.match(prompt, /close it ONLY with maintenance_remove/);
  assert.match(prompt, /quotes right next to that reference/);
});
