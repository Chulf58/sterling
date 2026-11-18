// The Overpass availability check on the OpenCode plugin (GitHub #257, #258, #281; user-ruled
// 2026-11-17 "Check and refuse loudly (Recommended)", keeping decision
// overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice's
// no-fallback rule): while Overpass is effective, each routed tier model is looked up in
// OpenCode's model list. A missing route refuses the dispatch before it starts, skips the
// maintenance worker launch and is named on the session's prompt; a list that cannot be read
// is UNKNOWN, never OFF or missing; the next check recovers on its own.
// Every fixture is a fresh temp project; nothing reads this repo's .sterling/.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let server;
let overpass;
let worker;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  overpass = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'overpass.mjs')).href);
  worker = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'worker.mjs')).href);
});

const ON = { mode: 'work', overpass: { enabled: true } };
// OpenCode 2.1.2's ctx.model.list() shape: { location, data: [Model.Info] }.
const model = (providerID, id) => ({ providerID, id, variants: [] });
const DIRECT = [model('anthropic', 'claude-opus-5-5'), model('openai', 'gpt-6.1-sol')];
const TIERS = ['agentic-auto', 'agentic-high', 'agentic-premium', 'agentic-premium-max', 'agentic-conductor'].map((t) => model('overpass', t));

function makeProject(config, { withGit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-avail-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', ...config }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (withGit) {
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n.opencode/\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    }
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The plugin context; `inventory.list` is what ctx.model.list() answers, changeable mid-test. */
function stubCtx(directory, inventory) {
  const hooks = { session: {}, tool: {}, permission: {} };
  const queue = [];
  let wake = null;
  const transform = async () => ({ dispose: async () => {} });
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async (name, fn) => void (hooks.permission[name] = fn) },
    command: { transform },
    skill: { transform },
    mcp: { transform },
    model: { list: () => inventory.list() },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            if (queue.length) yield queue.shift();
            else await new Promise((r) => (wake = r));
          }
        },
      }),
    },
  };
}

async function setup(dir, data, deps = {}) {
  const inventory = { list: async () => ({ location: { directory: dir }, data: inventory.data }), data };
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {}, ...deps });
  const ctx = stubCtx(dir, inventory);
  const cleanup = await plugin.setup(ctx);
  const before = async (args, id) => {
    const input = { tool: 'subagent', id, sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'fixture lane', prompt: 'Change the fixture file.', ...args } };
    await ctx.hooks.tool['execute.before'](input);
    return input;
  };
  const dispatch = async (args, id = 'call_1') => {
    const input = await before(args, id);
    const after = { ...input, status: 'completed', result: { content: [{ type: 'text', text: 'lane done' }], metadata: {} } };
    await ctx.hooks.tool['execute.after'](after);
    return { args: input.input, result: after.result.content.map((p) => p.text).join('\n') };
  };
  const prompt = async (sessionID = 'ses_root') => {
    const input = { sessionID, messageID: 'msg_u', prompt: { text: 'next' }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(input);
    return input.prompt.text;
  };
  return { plugin, ctx, inventory, before, dispatch, prompt, cleanup };
}
const notices = (dir) => {
  const p = join(dir, server.NOTICES_REL);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).map((n) => n.text).join('\n') : '';
};
const REMEDIES = [/credential/, /\/reload/, /OVERPASS-BYPASS: <reason>/, /"overpass": \{"enabled": false\}/];

test('provider missing: the session is told Overpass is ON but not available, and a dispatch is refused with the fix steps', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir, DIRECT);
  try {
    const text = await s.prompt();
    assert.match(text, /Overpass ON but not available/);
    assert.match(text, /overpass\/agentic-auto/);
    assert.match(text, /provider 'overpass'/);
    let input;
    await assert.rejects(
      (async () => {
        input = { tool: 'subagent', id: 'call_x', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: 'p', model: 'openai/gpt-6.1-sol' } };
        await s.ctx.hooks.tool['execute.before'](input);
      })(),
      (e) => {
        assert.match(e.message, /^Sterling refused this subagent dispatch: Overpass is ON but its route overpass\/agentic-auto for sterling\/implementor is not available/);
        assert.match(e.message, /OpenCode lists no model from the provider 'overpass'/);
        for (const re of REMEDIES) assert.match(e.message, re);
        return true;
      }
    );
    assert.equal(input.input.model, 'openai/gpt-6.1-sol', 'a refused call is stopped, not rerouted');
    assert.match(notices(p.dir) + readFileSync(join(p.dir, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /route overpass\/agentic-auto/, 'the refusal is logged');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('tier missing on a loaded provider: the dispatch is refused naming the tier, while a dispatch to a loaded tier runs', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir, [...DIRECT, model('overpass', 'agentic-high')]);
  try {
    await assert.rejects(s.before({}, 'call_impl'), (e) => {
      assert.match(e.message, /route overpass\/agentic-auto for sterling\/implementor is not available/);
      assert.match(e.message, /the provider 'overpass' is loaded, but OpenCode lists no tier 'agentic-auto' on it \(it lists agentic-high\)/);
      return true;
    });
    const reviewer = await s.dispatch({ agent: 'sterling/reviewer' }, 'call_rev');
    assert.equal(reviewer.args.model, 'overpass/agentic-high');
    assert.doesNotMatch(reviewer.result, /UNKNOWN|not available/);
    const text = await s.prompt();
    assert.match(text, /Overpass ON but not available/);
    assert.match(text, /overpass\/agentic-auto \(/, 'the missing route is named');
    assert.doesNotMatch(text.split('Overpass ON but not available')[1], /overpass\/agentic-high \(/, 'a loaded route is not listed as missing');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('inventory timeout or failure: UNKNOWN on the session, and the dispatch goes to its tier with an UNKNOWN line, never refused and never rerouted', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir, TIERS, { modelListTimeoutMs: 30 });
  try {
    s.inventory.list = () => new Promise(() => {});
    const text = await s.prompt();
    assert.match(text, /Overpass ON, availability UNKNOWN/);
    assert.match(text, /timed out after 30 ms/);
    assert.doesNotMatch(text, /not available|Overpass: OFF/);
    const sent = await s.dispatch({ model: 'openai/gpt-6.1-sol' });
    assert.equal(sent.args.model, 'overpass/agentic-auto');
    assert.match(sent.result, /Overpass availability UNKNOWN: OpenCode's model list could not be read \(the model list timed out after 30 ms\); this dispatch was sent to overpass\/agentic-auto unchecked/);

    s.inventory.list = async () => {
      throw new Error('provider registry busy');
    };
    const failed = await s.dispatch({}, 'call_2');
    assert.equal(failed.args.model, 'overpass/agentic-auto');
    assert.match(failed.result, /availability UNKNOWN: OpenCode's model list could not be read \(provider registry busy\)/);

    // A list with no model at all is a list OpenCode has not filled yet (the session itself runs on one), so UNKNOWN too.
    s.inventory.list = async () => ({ data: [] });
    const empty = await s.dispatch({}, 'call_3');
    assert.equal(empty.args.model, 'overpass/agentic-auto');
    assert.match(empty.result, /availability UNKNOWN: OpenCode's model list lists no model at all/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('OVERPASS-BYPASS with a loaded model runs while the Overpass provider is missing', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir, DIRECT);
  try {
    const sent = await s.dispatch({ model: 'openai/gpt-6.1-sol', prompt: 'Review it.\nOVERPASS-BYPASS: Sol review lane' });
    assert.equal(sent.args.model, 'openai/gpt-6.1-sol');
    assert.match(sent.result, /OVERPASS-BYPASS: Overpass bypassed for this dispatch/);
    assert.doesNotMatch(sent.result, /refused|not available/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('recovery: once the tier model is listed, the next dispatch runs and the session is told it is available again', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir, DIRECT);
  try {
    assert.match(await s.prompt(), /Overpass ON but not available/);
    await assert.rejects(s.before({}, 'call_1'), /not available/);
    s.inventory.data = [...DIRECT, ...TIERS];
    const sent = await s.dispatch({}, 'call_2');
    assert.equal(sent.args.model, 'overpass/agentic-auto');
    assert.doesNotMatch(sent.result, /UNKNOWN|not available/);
    const text = await s.prompt();
    assert.match(text, /Overpass is available again: every routed tier model is loaded/);
    assert.doesNotMatch(await s.prompt(), /STERLING OVERPASS/, 'an unchanged state is not repeated');
    assert.doesNotMatch(await s.prompt('ses_other'), /STERLING OVERPASS/, 'a session that never saw a problem gets no line');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('session line: shown once per session per state, never while Overpass is off or every route is loaded', async () => {
  for (const [config, data] of [[{ mode: 'work' }, DIRECT], [ON, [...DIRECT, ...TIERS]]]) {
    const p = makeProject(config);
    const s = await setup(p.dir, data);
    try {
      assert.doesNotMatch(await s.prompt(), /STERLING OVERPASS/, JSON.stringify(config));
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
  const p = makeProject(ON);
  const s = await setup(p.dir, DIRECT);
  try {
    assert.match(await s.prompt(), /Overpass ON but not available/);
    assert.doesNotMatch(await s.prompt(), /Overpass ON but not available/, 'the same state is not repeated to the same session');
    assert.match(await s.prompt('ses_new'), /Overpass ON but not available/, 'a new session is told at its start');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('worker launch: a missing maintenance-worker route skips the launch with a notice; recovery launches it', () => {
  const p = makeProject(ON);
  try {
    const launches = [];
    let inventory = overpass.readInventory({ list: DIRECT });
    const launchWorkerFor = worker.createWorkerLaunch({
      openStore: (path) => new SterlingStore(path),
      claudeOnPath: () => false,
      opencodeBin: () => '/opt/opencode/bin/opencode',
      launchWorker: (o) => launches.push(o),
      nodeOnPath: () => true,
      execPath: process.execPath,
      inventoryFor: () => inventory,
    });
    launchWorkerFor(p.dir, '2026-11-17T10:00:00.000Z');
    assert.deepEqual(launches, []);
    const text = notices(p.dir);
    assert.match(text, /the maintenance worker did not run: Overpass is ON but its route overpass\/agentic-auto for the maintenance worker is not available/);
    for (const re of [/credential/, /\/reload/, /"overpass": \{"enabled": false\}/]) assert.match(text, re);

    inventory = overpass.readInventory({ list: TIERS });
    launchWorkerFor(p.dir, '2026-11-17T10:01:00.000Z');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].workerModel, 'overpass/agentic-auto');

    // UNKNOWN (no list read for this launch) launches unchecked and logs it, never skips.
    inventory = null;
    launchWorkerFor(p.dir, '2026-11-17T10:02:00.000Z');
    assert.equal(launches.length, 2);
    assert.match(readFileSync(join(p.dir, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /maintenance worker: Overpass availability UNKNOWN \(no model list was read for this launch\); launching on overpass\/agentic-auto unchecked/);
  } finally {
    p.cleanup();
  }
});

test('worker launch through settlement: the plugin reads the model list before it settles and skips a worker whose route is missing', async () => {
  const p = makeProject(ON, { withGit: true });
  const launches = [];
  const s = await setup(p.dir, DIRECT, { launchWorker: (o) => launches.push(o), opencodeBin: () => '/opt/opencode/bin/opencode' });
  try {
    // The first settlement only records the tree as it stands and launches nothing (settle.mjs).
    await s.plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    await s.plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.deepEqual(launches, []);
    assert.match(notices(p.dir), /the maintenance worker did not run: Overpass is ON but its route overpass\/agentic-auto/);
    s.inventory.data = TIERS;
    await s.plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.equal(launches.length, 1, 'the next settlement after the route loads launches the worker');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});
