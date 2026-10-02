// The maintenance worker's OpenCode runner (board item Parity P8;
// scripts/hooks/lib/maintenance-worker-opencode.mjs). Event shapes come from a
// live `opencode run --standalone --format json` on OpenCode 2.0.21
// (fixtures/opencode-run-events.jsonl, long strings cut). Every test injects
// spawn: nothing here starts a real opencode or claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judgedVerdicts, maybeLaunchMaintenanceWorker, runWorker, workerPaths } from '../hooks/lib/maintenance-worker.mjs';
import { OPENCODE_DENIED_MCP, opencodeStreamJournal } from '../hooks/lib/maintenance-worker-opencode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const HEAD = 'b'.repeat(40);
const ARTICLE = '11111111-2222-4333-8444-555555555555';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-mworker-oc-'));
  const plugin = join(base, 'plugin');
  const project = join(base, 'project');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'templates'), { recursive: true });
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"sterling"}');
  writeFileSync(
    join(plugin, '.claude-plugin', 'sterling-mcp.json'),
    JSON.stringify({ mcpServers: { sterling: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/sterling-mcp.mjs', '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'] } } })
  );
  writeFileSync(join(plugin, 'templates', 'maintenance-worker-prompt.md'), 'PROMPT BODY');
  writeFileSync(join(plugin, 'scripts', 'maintenance-worker-run.mjs'), '// runner stub, never executed by these tests\n');
  mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
  return { base, plugin, project, paths: workerPaths(project), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A fake `opencode run` child: writes `events` as JSON lines, then closes with `code`. */
function fakeOpencode(events, { code = 0 } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    calls.push({ cmd, args, opts });
    setImmediate(() => {
      const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
      child.stdout.emit('data', text.slice(0, 50)); // a line split across chunks
      child.stdout.emit('data', text.slice(50));
      child.emit('close', code);
    });
    return child;
  };
  return { fn, calls };
}

// Builders in the measured shape (see the fixture): one tool_use per finished call.
let seq = 0;
const part = (tool, state) => ({ type: 'tool_use', sessionID: 'ses_x', part: { partID: `prt_${++seq}`, sessionID: 'ses_x', messageID: `msg_${seq}`, type: 'tool', id: `call_${seq}`, tool, state } });
const sterling = (name, input, status = 'completed', output = 'ok') =>
  part('execute', { status: 'completed', input: { code: `await tools.sterling.${name}(...)` }, output, metadata: { metadata: { toolCalls: [{ tool: `sterling.${name}`, status, input }], truncated: false } } });
const read = (path, status = 'completed') => part('read', status === 'completed' ? { status, input: { path }, output: `Read file ${path}` } : { status, input: { path }, error: `File not found: ${path}` });
const grep = (path) => part('grep', { status: 'completed', input: { pattern: 'x', path }, output: 'Found 1 matches' });
const text = (t, messageID = 'msg_final') => ({ type: 'text', sessionID: 'ses_x', part: { id: 'prt_t', messageID, type: 'text', text: t } });
const stepFinish = (cost) => ({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', cost } });
const readJournal = (fx) => readFileSync(fx.paths.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastRun = (fx) => JSON.parse(readFileSync(fx.paths.state, 'utf8')).last_run;

/** Lock + eligible.json the way the launcher writes them for the opencode host. */
function opencodeRun(fx, items, { model = 'anthropic/claude-sonnet-5-5', token = 'tok' } = {}) {
  writeFileSync(fx.paths.lock, JSON.stringify({ pid: process.pid, started_at: new Date(NOW).toISOString(), token }));
  writeFileSync(fx.paths.eligible, JSON.stringify({ token, head: HEAD, host: 'opencode', opencode_bin: '/opt/oc/opencode.exe', opencode_model: model, items }));
  return { root: fx.project, pluginRoot: fx.plugin, token, budgetUsd: 2, now: () => NOW, log: () => {} };
}
const ITEM = { id: 'item-a', file_keys: ['src/a.mjs'], feature_link: ARTICLE, slug: 'probe-article' };
const owes = (id = ITEM.id) => JSON.stringify({ item_id: id, article: 'probe-article', verdict: 'owes_prose', file_keys: ['forged'], reason: 'the article misses the new flag' });

test('the measured OpenCode 2.0.21 events parse: an inner sterling call counts by its OWN status, errored reads are no evidence, a remove is journalled with its text, the last message is the result', () => {
  const lines = readFileSync(join(here, 'fixtures', 'opencode-run-events.jsonl'), 'utf8');
  const observed = [];
  const journal = [];
  const stream = opencodeStreamJournal((e) => journal.push(e), (name, input) => observed.push([name, input]));
  stream.feed(lines);
  const out = stream.end();
  assert.deepEqual(observed, [
    ['mcp__sterling__knowledge_get', { id: ARTICLE }],
    ['Read', { file_path: 'src/a.mjs' }],
    ['Grep', { path: 'proj/src' }],
  ], 'the knowledge_get the model caught as an error and both errored reads are not evidence');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].tool, 'maintenance_remove');
  assert.equal(journal[0].item_id, 'deadbeef-0000-4000-8000-000000000000');
  assert.equal(journal[0].is_error, true);
  assert.match(journal[0].result, /^ERROR: maintenance_remove: no record/);
  assert.equal(out.removes, 1);
  assert.equal(out.closedOk, 0);
  assert.equal(out.sterlingOk, 1);
  // The fixture ends with a provider error event (free tier 403).
  assert.equal(out.result.is_error, true);
  assert.match(out.result.subtype, /provider\.auth/);
  assert.equal(out.result.result, 'KIWI-31');
  assert.equal(out.result.total_cost_usd, 0);
});

test('[gate] an OpenCode run with knowledge_get on the article and a read of its file gives an evidence-backed verdict; the argv, model, config and PWD are the runner\'s', async () => {
  const fx = fixture();
  try {
    const child = fakeOpencode([sterling('knowledge_get', { id: ARTICLE }), read('src/a.mjs'), stepFinish(0.12), text(owes()), stepFinish(0.03)]);
    assert.equal(await runWorker({ ...opencodeRun(fx, [ITEM]), spawn: child.fn }), 0);
    const [call] = child.calls;
    assert.equal(call.cmd, '/opt/oc/opencode.exe');
    assert.deepEqual(call.args.slice(0, 7), ['run', '--standalone', '--format', 'json', '--auto', '--model', 'anthropic/claude-sonnet-5-5']);
    assert.match(call.args[7], /^PROMPT BODY/);
    assert.match(call.args[7], /HOST NOTE \(OpenCode\)/);
    assert.match(call.args[7], /item-a/, 'the eligible list reaches the prompt');
    assert.equal(call.opts.env.PWD, fx.project, 'the session directory follows PWD (measured)');
    assert.equal(call.opts.env.STERLING_MAINTENANCE_WORKER, '1');
    assert.equal(call.opts.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    const config = JSON.parse(call.opts.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, 'anthropic/claude-sonnet-5-5');
    assert.deepEqual(config.mcp.sterling, { type: 'local', command: ['node', join(fx.plugin, 'mcp', 'sterling-mcp.mjs'), '--store', join(fx.project, '.sterling', 'sterling.db')], enabled: true });
    for (const k of ['shell', 'edit', 'write', 'patch', 'subagent', ...OPENCODE_DENIED_MCP]) assert.equal(config.permission[k], 'deny', k);
    for (const k of ['sterling_maintenance_remove', 'sterling_knowledge_get', 'sterling_knowledge_line_ref_fix', 'read', 'grep', 'execute']) assert.equal(config.permission[k], undefined, `${k} stays allowed`);

    const verdicts = readJournal(fx).filter((l) => l.kind === 'verdict');
    assert.deepEqual(verdicts.map((v) => [v.item_id, v.verdict, v.evidence ?? null]), [['item-a', 'owes_prose', true]]);
    assert.deepEqual(verdicts[0].file_keys, ['src/a.mjs'], 'file_keys are the runner\'s, never the child\'s');
    assert.deepEqual([...judgedVerdicts(fx.project).keys()], ['item-a']);
    const run = lastRun(fx);
    assert.equal(run.ok, true);
    assert.equal(run.host, 'opencode');
    assert.equal(run.evidenced_verdicts, 1);
    assert.equal(run.no_progress, false);
    assert.equal(run.cost_usd, 0.15);
  } finally {
    fx.cleanup();
  }
});

test('[gate] an OpenCode verdict without a successful tool result is refused: an errored inner knowledge_get, an errored read, or no tool call at all leaves it unjudged and the run no_progress', async () => {
  const cases = {
    'inner call errored (the model caught it, so the execute itself completed)': [sterling('knowledge_get', { id: ARTICLE }, 'error', '{"ok":false}'), read('src/a.mjs')],
    'read errored': [sterling('knowledge_get', { id: ARTICLE }), read('src/a.mjs', 'error')],
    'read never finished': [sterling('knowledge_get', { id: ARTICLE }), part('read', { status: 'running', input: { path: 'src/a.mjs' } })],
    'grep of another directory only': [sterling('knowledge_get', { id: ARTICLE }), grep('docs')],
    'no tool call': [],
  };
  for (const [name, events] of Object.entries(cases)) {
    const fx = fixture();
    try {
      const child = fakeOpencode([...events, text(owes())]);
      assert.equal(await runWorker({ ...opencodeRun(fx, [ITEM]), spawn: child.fn }), 0, name);
      const verdicts = readJournal(fx).filter((l) => l.kind === 'verdict');
      assert.deepEqual(verdicts.map((v) => [v.item_id, v.verdict, v.reason, v.evidence ?? null]), [['item-a', 'unjudged', 'no evidence', null]], name);
      assert.equal(judgedVerdicts(fx.project).size, 0, `${name}: nothing suppresses a relaunch`);
      assert.equal(lastRun(fx).no_progress, true, name);
    } finally {
      fx.cleanup();
    }
  }
});

test('[gate] a child-written refused verdict does not stand on OpenCode either; a refused remove in the stream is the runner\'s refused verdict, a successful one a close', async () => {
  const fx = fixture();
  try {
    const items = [ITEM, { ...ITEM, id: 'item-b', file_keys: ['src/b.mjs'] }];
    const child = fakeOpencode([
      sterling('maintenance_remove', { id: 'item-a' }, 'error', 'ERROR: maintenance_remove: src/a.mjs differs from HEAD'),
      sterling('maintenance_remove', { id: 'item-b' }, 'completed', '{"removed":true}'),
      text(JSON.stringify({ item_id: 'item-b', verdict: 'refused', evidence: true, head: 'forged' })),
    ]);
    assert.equal(await runWorker({ ...opencodeRun(fx, items), spawn: child.fn }), 0);
    const j = readJournal(fx);
    assert.deepEqual(j.filter((l) => l.kind === 'tool_call').map((l) => [l.item_id, l.is_error]), [['item-a', true], ['item-b', false]]);
    const verdicts = j.filter((l) => l.kind === 'verdict');
    assert.deepEqual(verdicts.map((v) => [v.item_id, v.verdict, v.evidence ?? null]), [['item-a', 'refused', true], ['item-b', 'unjudged', null]]);
    assert.equal(verdicts[0].head, HEAD, 'the refused verdict carries the launch HEAD');
    assert.equal(lastRun(fx).closes_ok, 1);
  } finally {
    fx.cleanup();
  }
});

test('an OpenCode provider error or a non-zero exit is a FAILED run with a named reason, never a silent success', async () => {
  const fx = fixture();
  try {
    const err = { type: 'error', sessionID: 'ses_x', error: { type: 'provider.auth', message: "OpenCode's free tier can only be used from within OpenCode", status: 403 } };
    assert.equal(await runWorker({ ...opencodeRun(fx, [ITEM]), spawn: fakeOpencode([err], { code: 1 }).fn }), 1);
    const run = lastRun(fx);
    assert.equal(run.ok, false);
    assert.match(run.error, /exit 1/);
    assert.match(run.error, /error result \(error \(provider\.auth: OpenCode's free tier/);
    assert.equal(run.cost_usd, null);

    assert.equal(await runWorker({ ...opencodeRun(fx, [ITEM]), spawn: fakeOpencode([], { code: 0 }).fn }), 1);
    assert.match(lastRun(fx).error, /no final text or error event from opencode run/);
  } finally {
    fx.cleanup();
  }
});

test('[decision opencode-maintenance-worker-refuses-without-a-configured-model] with no model recorded the OpenCode runner refuses: nothing spawned, a failed run naming the key, never OpenCode\'s default model; --dry-run prints the opencode argv and env', async () => {
  const fx = fixture();
  try {
    const child = fakeOpencode([text('{"verdict":"none","reason":"x"}')]);
    assert.equal(await runWorker({ ...opencodeRun(fx, [ITEM], { model: null }), spawn: child.fn }), 1);
    assert.equal(child.calls.length, 0, 'no opencode run starts without a model');
    assert.equal(lastRun(fx).ok, false);
    assert.match(lastRun(fx).error, /maintenance_worker\.opencode_model is not set/);

    const printed = [];
    opencodeRun(fx, [ITEM]);
    assert.equal(await runWorker({ root: fx.project, pluginRoot: fx.plugin, token: 'tok', dryRun: true, spawn: () => assert.fail('dry run must not spawn'), out: (s) => printed.push(s) }), 0);
    const dry = JSON.parse(printed[0]);
    assert.equal(dry.host, 'opencode');
    assert.equal(dry.command, '/opt/oc/opencode.exe');
    assert.equal(dry.argv[0], 'run');
    assert.equal(dry.env.PWD, fx.project);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ launcher

const fakeGit = (cmd, args) => (args.includes('rev-parse') ? { status: 0, stdout: `${HEAD}\n\n` } : { status: 0, stdout: '' });
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    return child;
  };
  return { fn, calls };
}
const launch = (fx, over = {}) =>
  maybeLaunchMaintenanceWorker({
    root: fx.project,
    config: null,
    items: Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, system_reason: 'reconcile_needed', text: `reconcile article 'a${i}'`, file_keys: [`src/${i}.mjs`] })),
    trigger: 'stop',
    now: NOW,
    pluginRoot: fx.plugin,
    env: {},
    isAlive: () => false,
    spawnSync: fakeGit,
    ...over,
  });

test('the launcher records the opencode host, binary and configured model in the eligible list; with no host it stays claude', () => {
  const fx = fixture();
  try {
    const sp = fakeSpawn();
    const r = launch(fx, { host: 'opencode', opencodeBin: '/opt/oc/opencode.exe', config: { maintenance_worker: { opencode_model: ' openai/gpt-5.6-terra ' } }, spawn: sp.fn });
    assert.equal(r.launched, true);
    assert.equal(r.host, 'opencode');
    const eligible = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    assert.equal(eligible.host, 'opencode');
    assert.equal(eligible.opencode_bin, '/opt/oc/opencode.exe');
    assert.equal(eligible.opencode_model, 'openai/gpt-5.6-terra');

    rmSync(fx.paths.lock, { force: true });
    rmSync(fx.paths.lastLaunch, { force: true });
    assert.equal(launch(fx, { spawn: fakeSpawn().fn }).host, 'claude');
    const plain = JSON.parse(readFileSync(fx.paths.eligible, 'utf8'));
    assert.equal(plain.host, 'claude');
    assert.equal(plain.opencode_bin, undefined);
  } finally {
    fx.cleanup();
  }
});

test('the launcher refuses loudly an opencode host with no binary, a malformed opencode_model, or an unknown host: recorded as a failed launch, nothing spawned', () => {
  for (const [over, re] of [
    [{ host: 'opencode' }, /needs the path of the opencode binary/],
    // Decision opencode-maintenance-worker-refuses-without-a-configured-model: no fallback to OpenCode's default model.
    [{ host: 'opencode', opencodeBin: '/opt/oc/opencode.exe' }, /maintenance_worker\.opencode_model is not set/],
    [{ host: 'opencode', opencodeBin: '/opt/oc/opencode.exe', config: { maintenance_worker: {} } }, /maintenance_worker\.opencode_model is not set/],
    [{ host: 'opencode', opencodeBin: '/opt/oc/opencode.exe', config: { maintenance_worker: { opencode_model: 42 } } }, /opencode_model must be a provider\/model string/],
    [{ host: 'gemini' }, /unknown runner host 'gemini'/],
  ]) {
    const fx = fixture();
    try {
      const sp = fakeSpawn();
      const r = launch(fx, { ...over, spawn: sp.fn });
      assert.equal(r.reason, 'error');
      assert.match(r.detail, re);
      assert.equal(sp.calls.length, 0);
      assert.equal(lastRun(fx).ok, false, 'a failure to start is a recorded failed run (H1 names it)');
      assert.equal(existsSync(fx.paths.lock), false);
    } finally {
      fx.cleanup();
    }
  }
});

// ------------------------------------------------------------ OpenCode plugin host selection

const worker = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'worker.mjs')).href);
const NOTICES = '.sterling/transient/opencode-notices.json';
const notices = (dir) => (existsSync(join(dir, NOTICES)) ? JSON.parse(readFileSync(join(dir, NOTICES), 'utf8')).map((n) => n.text) : []);

test('the OpenCode plugin picks the host: claude on PATH -> claude; else the OpenCode binary it runs in -> opencode; neither -> a loud skip once', () => {
  const fx = fixture();
  try {
    const openStore = () => ({ close() {} });
    const seen = [];
    const launchWorker = (o) => {
      seen.push({ host: o.host, opencodeBin: o.opencodeBin });
      return { launched: true, reason: 'launched' };
    };
    const at = new Date(NOW).toISOString();
    writeFileSync(join(fx.project, '.sterling', 'config.json'), JSON.stringify({ maintenance_worker: { opencode_model: 'openai/gpt-5.6-terra' } }));
    worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker, execPath: '/opt/oc/opencode.exe', nodeOnPath: () => true })(fx.project, at);
    worker.createWorkerLaunch({ openStore, claudeOnPath: () => false, launchWorker, execPath: '/opt/oc/opencode.exe', nodeOnPath: () => true })(fx.project, at);
    assert.deepEqual(seen, [{ host: undefined, opencodeBin: undefined }, { host: 'opencode', opencodeBin: '/opt/oc/opencode.exe' }]);

    assert.equal(worker.opencodeBinDefault('/opt/oc/opencode.exe'), '/opt/oc/opencode.exe');
    assert.equal(worker.opencodeBinDefault('/usr/bin/node'), null, 'under node there is no OpenCode binary to run');
    assert.equal(worker.opencodeBinDefault('/usr/bin/bun'), null);

    const neither = worker.createWorkerLaunch({ openStore, claudeOnPath: () => false, opencodeBin: () => null, launchWorker, execPath: '/usr/bin/node' });
    neither(fx.project, at);
    neither(fx.project, at);
    assert.equal(seen.length, 2, 'nothing launches with neither runner');
    const skip = notices(fx.project).filter((t) => /maintenance worker did not run/.test(t));
    assert.equal(skip.length, 1, 'one notice per process');
    assert.match(skip[0], /neither `claude` nor an OpenCode binary/);
    assert.match(readFileSync(join(fx.project, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /no maintenance runner on this machine/);
  } finally {
    fx.cleanup();
  }
});

test('[decision opencode-maintenance-worker-refuses-without-a-configured-model] on the opencode host with no maintenance_worker.opencode_model the plugin refuses loudly: no launch, one notice naming the key, one log line; the claude host needs no model', () => {
  const fx = fixture();
  try {
    const openStore = () => ({ close() {} });
    const seen = [];
    const launchWorker = (o) => {
      seen.push(o.host ?? 'claude');
      return { launched: true, reason: 'launched' };
    };
    const at = new Date(NOW).toISOString();
    const noModel = worker.createWorkerLaunch({ openStore, claudeOnPath: () => false, launchWorker, execPath: '/opt/oc/opencode.exe', nodeOnPath: () => true });
    noModel(fx.project, at);
    noModel(fx.project, at);
    assert.deepEqual(seen, [], 'nothing launches without a configured model');
    const refused = notices(fx.project).filter((t) => /maintenance worker did not run/.test(t));
    assert.equal(refused.length, 1, 'one notice per process');
    assert.match(refused[0], /maintenance_worker\.opencode_model/);
    const log = readFileSync(join(fx.project, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8');
    assert.equal(log.match(/opencode_model is not set/g).length, 1, 'one log line');

    worker.createWorkerLaunch({ openStore, claudeOnPath: () => true, launchWorker, execPath: '/opt/oc/opencode.exe', nodeOnPath: () => true })(fx.project, at);
    assert.deepEqual(seen, ['claude'], 'the claude path is unchanged: no model needed');
  } finally {
    fx.cleanup();
  }
});
