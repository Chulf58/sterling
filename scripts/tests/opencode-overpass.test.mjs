// The Overpass toggle on the OpenCode plugin (packages/opencode-plugin/src/overpass.mjs,
// axis.mjs, server.mjs; decision
// overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice,
// points 2, 3, 4, 6 and 8): the subagent dispatch pin, the .opencode/opencode.json agent
// overlay and its exact undo, the session line, and the open-session mismatch notice.
// Every fixture is a fresh temp project; nothing reads this repo's .sterling/.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let server;
let overpass;
let opState;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  overpass = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'overpass.mjs')).href);
  opState = await import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'operating-state.mjs')).href);
});

const ON = { mode: 'work', overpass: { enabled: true } };
const OC_REL = '.opencode/opencode.json';

/** A Sterling project with `config`, an empty store and, when given, a .opencode/opencode.json value or raw text. */
function makeProject(config, opencodeJson) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-overpass-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, config);
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (opencodeJson !== undefined) {
    mkdirSync(join(dir, '.opencode'), { recursive: true });
    writeFileSync(join(dir, OC_REL), typeof opencodeJson === 'string' ? opencodeJson : `${JSON.stringify(opencodeJson, null, 2)}\n`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const writeConfig = (dir, config) => writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify({ project_name: 'fixture-proj', ...config }));
const readOc = (dir) => JSON.parse(readFileSync(join(dir, OC_REL), 'utf8'));
const resOn = (extra = {}) => ({ configured: true, effective: true, conductorRouted: true, provider: 'overpass', conductorModel: 'overpass/agentic-conductor', laneModel: 'overpass/agentic-high', ...extra });
const resOff = { configured: false, effective: false, conductorRouted: false, provider: 'overpass', conductorModel: 'overpass/agentic-conductor', laneModel: 'overpass/agentic-high' };

/** The plugin context surfaces the paths under test use: hooks, session.get, the event stream. */
function stubCtx(directory) {
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
    model: { list: async () => [] },
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
    emit(ev) {
      queue.push(ev);
      wake?.();
    },
  };
}

async function setup(dir) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {} });
  const ctx = stubCtx(dir);
  const cleanup = await plugin.setup(ctx);
  // One subagent call through execute.before and execute.after; returns its live input and result text.
  const dispatch = async (args, id = 'call_1') => {
    const input = { tool: 'subagent', id, sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'fixture lane', prompt: 'Change the fixture file.', ...args } };
    await ctx.hooks.tool['execute.before'](input);
    const after = { ...input, status: 'completed', result: { content: [{ type: 'text', text: 'lane done' }], metadata: {} } };
    await ctx.hooks.tool['execute.after'](after);
    return { args: input.input, result: after.result.content.map((p) => p.text).join('\n') };
  };
  const step = async (sessionID, agent, model) => {
    ctx.emit({ type: 'session.step.started', data: { sessionID, assistantMessageID: 'msg_a', agent, model } });
    await plugin.idle();
  };
  const prompt = async (sessionID) => {
    const input = { sessionID, messageID: 'msg_u', prompt: { text: 'next' }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(input);
    return input.prompt.text;
  };
  return { plugin, ctx, dispatch, step, prompt, cleanup };
}
const notices = (dir) => {
  const p = join(dir, server.NOTICES_REL);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).map((n) => n.text).join('\n') : '';
};

// ── dispatch pin ──────────────────────────────────────────────────────────────

test('dispatch pin: while effective a subagent call runs on the lane model, and an explicit model is replaced', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir);
  try {
    const plain = await s.dispatch({});
    assert.equal(plain.args.model, 'overpass/agentic-high');
    assert.doesNotMatch(plain.result, /OVERPASS/, 'no line when the call named no model');
    const explicit = await s.dispatch({ model: 'openai/gpt-6.1-sol#high' }, 'call_2');
    assert.equal(explicit.args.model, 'overpass/agentic-high', 'the toggle wins over the call');
    assert.match(explicit.result, /OVERPASS: this dispatch ran on overpass\/agentic-high, not openai\/gpt-6\.1-sol#high/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('dispatch pin: a custom provider id routes to <provider>/agentic-high', async () => {
  const p = makeProject({ mode: 'work', overpass: { enabled: true, provider: 'overpass-agentic' } });
  const s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({ model: 'anthropic/claude-opus-5-5' })).args.model, 'overpass-agentic/agentic-high');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('dispatch pin: off, or on in hobby mode, leaves the call alone', async () => {
  for (const config of [{ mode: 'work' }, { mode: 'work', overpass: { enabled: false } }, { overpass: { enabled: true } }, { mode: 'hobby', overpass: { enabled: true } }]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      const named = await s.dispatch({ model: 'anthropic/claude-sonnet-5' });
      assert.equal(named.args.model, 'anthropic/claude-sonnet-5', JSON.stringify(config));
      assert.doesNotMatch(named.result, /OVERPASS/);
      const unnamed = await s.dispatch({}, 'call_2');
      assert.equal(Object.hasOwn(unnamed.args, 'model'), false, JSON.stringify(config));
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

test('dispatch pin: the Claude Code host never routes (resolver), so the pin is a no-op there', () => {
  const p = makeProject(ON);
  try {
    // The plugin only runs on OpenCode; the shared resolver is what keeps Claude Code out.
    const claude = JSON.parse(readFileSync(join(p.dir, '.sterling', 'config.json'), 'utf8'));
    const line = opState.overpassLine({ config: claude, configUnreadable: false, host: 'claude' });
    assert.match(line, /NOT IN EFFECT — overpass applies on OpenCode only; the host is 'claude'/);
    assert.deepEqual(overpass.dispatchPin({ ...resOn(), effective: false }, { model: 'x/y' }), { model: null, line: null });
  } finally {
    p.cleanup();
  }
});

// Deliberately changed in the fix round (Sol review, CRITICAL): the earlier version of this
// test asserted that the call went ahead on its own model with a warning line, which is
// the direct-provider fallback the decision forbids. The call must be refused.
test('dispatch pin: an unreadable Overpass setting refuses the dispatch, never runs it on its own model', async () => {
  for (const [config, why] of [
    [{ mode: 'work', overpass: { enabled: 'yes' } }, /config\.overpass\.enabled is "yes" — it must be true or false/],
    [{ mode: 'work', overpass: { enabled: true, provider: 'a/b' } }, /config\.overpass\.provider is "a\/b"/],
    ['{ "mode": "work", ', /could not be read \(/],
  ]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      const input = { tool: 'subagent', id: 'call_x', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: 'p', model: 'anthropic/claude-sonnet-5' } };
      await assert.rejects(s.ctx.hooks.tool['execute.before'](input), (e) => {
        assert.match(e.message, /^Sterling refused this subagent dispatch: the Overpass setting in \.sterling\/config\.json could not be read/);
        assert.match(e.message, why);
        assert.match(e.message, /Fix that value in \.sterling\/config\.json \(TUI System tab\), or set "overpass": \{"enabled": false\}/);
        return true;
      }, JSON.stringify(config));
      assert.equal(input.input.model, 'anthropic/claude-sonnet-5', 'the call is not touched, it is stopped');
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

// ── opencode.json overlay ─────────────────────────────────────────────────────

const USER_OC = {
  $schema: 'https://opencode.ai/config.json',
  permission: { edit: { '.sterling/sterling.db*': 'deny' } },
  agent: {
    'sterling/conductor': { model: 'anthropic/claude-opus-5-5', variant: 'medium', permission: { edit: { '.sterling/sterling.db*': 'deny' } } },
    'my-agent': { model: 'openai/gpt-6.1-sol', variant: 'high' },
  },
  default_agent: 'sterling/conductor',
};

test('overlay: written for plan and the conductor, user keys kept, then undone exactly when off', () => {
  const p = makeProject(ON, USER_OC);
  try {
    assert.equal(overpass.convergeOverlay(p.dir, resOn()).changed, true);
    const on = readOc(p.dir);
    assert.deepEqual(on.agent.plan, { model: 'overpass/agentic-high' });
    assert.deepEqual(on.agent['sterling/conductor'], { model: 'overpass/agentic-conductor', permission: USER_OC.agent['sterling/conductor'].permission }, 'variant taken out while the tier is set');
    assert.deepEqual(on.agent['my-agent'], USER_OC.agent['my-agent'], 'another agent entry untouched');
    assert.equal(on.default_agent, 'sterling/conductor');
    assert.deepEqual(on.permission, USER_OC.permission);
    assert.ok(existsSync(join(p.dir, overpass.OVERLAY_REL)), 'ownership recorded');

    assert.equal(overpass.convergeOverlay(p.dir, resOff).changed, true);
    assert.deepEqual(readOc(p.dir), USER_OC, 'the user model and variant come back, plan entry Sterling created is gone');
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false, 'ownership file removed when nothing is owned');
  } finally {
    p.cleanup();
  }
});

test('overlay: no write when nothing changes (a hand-formatted file stays byte-identical)', () => {
  const handText = '{\n    "agent": {\n        "my-agent": { "model": "a/b" }\n    }\n}\n';
  const p = makeProject({ mode: 'work' }, handText);
  try {
    assert.equal(overpass.convergeOverlay(p.dir, resOff).changed, false);
    assert.equal(readFileSync(join(p.dir, OC_REL), 'utf8'), handText, 'off with nothing owned never touches the file');
    overpass.convergeOverlay(p.dir, resOn());
    const path = join(p.dir, OC_REL);
    const text = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const own = readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8');
    assert.deepEqual(overpass.convergeOverlay(p.dir, resOn()), { changed: false, notes: [] });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(statSync(path).mtimeMs, mtime);
    assert.equal(readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8'), own);
  } finally {
    p.cleanup();
  }
});

test('overlay: conductor bypass omits the conductor entry, and turning bypass on removes it', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn({ conductorRouted: false }));
    const bypass = readOc(p.dir);
    assert.deepEqual(bypass.agent['sterling/conductor'], USER_OC.agent['sterling/conductor'], 'conductor keeps its own entry');
    assert.equal(bypass.agent.plan.model, 'overpass/agentic-high');

    overpass.convergeOverlay(p.dir, resOn());
    assert.equal(readOc(p.dir).agent['sterling/conductor'].model, 'overpass/agentic-conductor');
    overpass.convergeOverlay(p.dir, resOn({ conductorRouted: false }));
    assert.deepEqual(readOc(p.dir).agent['sterling/conductor'], USER_OC.agent['sterling/conductor'], 'bypass undoes the conductor entry exactly');
  } finally {
    p.cleanup();
  }
});

test('overlay: a model the user changes while on is theirs, kept on undo; a provider switch rewrites the tier', () => {
  const p = makeProject(ON, { agent: {} });
  try {
    overpass.convergeOverlay(p.dir, resOn());
    overpass.convergeOverlay(p.dir, resOn({ provider: 'overpass-agentic', laneModel: 'overpass-agentic/agentic-high', conductorModel: 'overpass-agentic/agentic-conductor' }));
    assert.equal(readOc(p.dir).agent.plan.model, 'overpass-agentic/agentic-high');
    const oc = readOc(p.dir);
    oc.agent.plan.model = 'anthropic/claude-opus-5-5';
    writeFileSync(join(p.dir, OC_REL), JSON.stringify(oc));
    const out = overpass.convergeOverlay(p.dir, resOff);
    assert.equal(readOc(p.dir).agent.plan.model, 'anthropic/claude-opus-5-5', 'the hand edit stays');
    assert.match(out.notes.join('\n'), /agent\.plan\.model is "anthropic\/claude-opus-5-5", not the overpass-agentic\/agentic-high Sterling wrote, so it is yours and stays/);
    assert.deepEqual(readOc(p.dir).agent['sterling/conductor'], undefined, 'the conductor entry Sterling created is gone');
  } finally {
    p.cleanup();
  }
});

test('overlay: an invalid opencode.json or ownership file is loud and nothing is written', () => {
  const p = makeProject(ON, '{ not json');
  try {
    assert.throws(() => overpass.convergeOverlay(p.dir, resOn()), /\.opencode\/opencode\.json is not valid JSON/);
    assert.equal(readFileSync(join(p.dir, OC_REL), 'utf8'), '{ not json');
    writeFileSync(join(p.dir, OC_REL), '{}\n');
    writeFileSync(join(p.dir, overpass.OVERLAY_REL), '[]');
    assert.throws(() => overpass.convergeOverlay(p.dir, resOn()), /overpass-overlay\.json is not an object/);
    assert.equal(readFileSync(join(p.dir, OC_REL), 'utf8'), '{}\n');
  } finally {
    p.cleanup();
  }
});

/** A writeFileAtomic seam whose temp write fails for opencode.json only, `times` times. */
function failingOcWrites(dir, times = 1) {
  let left = times;
  return {
    writeFile: (path, content) => {
      if (left > 0 && path.startsWith(join(dir, OC_REL))) {
        left--;
        throw new Error('injected opencode.json write failure');
      }
      writeFileSync(path, content);
    },
  };
}

test('overlay: a failed opencode.json write while turning off is retried, never left as tier models', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    const on = readFileSync(join(p.dir, OC_REL), 'utf8');
    assert.throws(() => overpass.convergeOverlay(p.dir, resOff, { fs: failingOcWrites(p.dir) }), /injected opencode\.json write failure/);
    assert.equal(readFileSync(join(p.dir, OC_REL), 'utf8'), on, 'the failed write left the file as it was');
    assert.ok(existsSync(join(p.dir, overpass.OVERLAY_REL)), 'ownership survives the failed write');
    assert.equal(overpass.convergeOverlay(p.dir, resOff).changed, true, 'the next convergence retries the undo');
    assert.deepEqual(readOc(p.dir), USER_OC);
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false);
  } finally {
    p.cleanup();
  }
});

test('overlay: a failed write during a provider change never records the old tier as the user model', () => {
  const p = makeProject(ON, USER_OC);
  const other = resOn({ provider: 'overpass-agentic', laneModel: 'overpass-agentic/agentic-high', conductorModel: 'overpass-agentic/agentic-conductor' });
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, other, { fs: failingOcWrites(p.dir) }), /injected/);
    overpass.convergeOverlay(p.dir, other);
    assert.equal(readOc(p.dir).agent['sterling/conductor'].model, 'overpass-agentic/agentic-conductor');
    overpass.convergeOverlay(p.dir, resOff);
    assert.deepEqual(readOc(p.dir), USER_OC, 'turning off restores the user model, not a tier');
  } finally {
    p.cleanup();
  }
});

test('overlay: an interrupted update whose opencode.json write landed is finalized, not read as a hand edit', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    // The ownership write after the opencode.json write fails: the pending record stays.
    let ocWritten = false;
    const fs = {
      writeFile: (path, content) => {
        if (path.startsWith(join(p.dir, OC_REL))) ocWritten = true;
        else if (ocWritten && path.startsWith(join(p.dir, overpass.OVERLAY_REL))) throw new Error('injected ownership write failure');
        writeFileSync(path, content);
      },
    };
    const other = resOn({ provider: 'overpass-agentic', laneModel: 'overpass-agentic/agentic-high', conductorModel: 'overpass-agentic/agentic-conductor' });
    assert.throws(() => overpass.convergeOverlay(p.dir, other, { fs }), /injected ownership write failure/);
    assert.ok(JSON.parse(readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8')).pending, 'pending record left');
    assert.deepEqual(overpass.convergeOverlay(p.dir, other), { changed: false, notes: [] }, 'settled with no second opencode.json write');
    assert.equal(JSON.parse(readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8')).pending, undefined);
    overpass.convergeOverlay(p.dir, resOff);
    assert.deepEqual(readOc(p.dir), USER_OC);
  } finally {
    p.cleanup();
  }
});

test('overlay: a git-tracked opencode.json is refused, as the installer refuses it', () => {
  const p = makeProject(ON, { agent: {} });
  try {
    const git = (...args) => spawnSync('git', args, { cwd: p.dir, encoding: 'utf8' });
    git('init', '-q');
    git('add', OC_REL);
    assert.throws(() => overpass.convergeOverlay(p.dir, resOn()), /is tracked by git/);
    assert.deepEqual(readOc(p.dir), { agent: {} });
  } finally {
    p.cleanup();
  }
});

test('overlay: the plugin converges it at setup and each turn, following a config change', async () => {
  const p = makeProject({ mode: 'work' }, USER_OC);
  const s = await setup(p.dir);
  try {
    assert.deepEqual(readOc(p.dir), USER_OC, 'off at setup: untouched');
    writeConfig(p.dir, ON);
    await s.prompt('ses_root');
    assert.equal(readOc(p.dir).agent.plan.model, 'overpass/agentic-high');
    writeConfig(p.dir, { mode: 'hobby', overpass: { enabled: true } });
    await s.prompt('ses_root');
    assert.deepEqual(readOc(p.dir), USER_OC);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
  const q = makeProject(ON, { agent: {} });
  const t = await setup(q.dir);
  try {
    assert.equal(readOc(q.dir).agent['sterling/conductor'].model, 'overpass/agentic-conductor', 'converged at setup');
  } finally {
    await t.cleanup();
    q.cleanup();
  }
});

// ── session line ──────────────────────────────────────────────────────────────

test('session line: ON, bypass, not in effect, off, invalid and unknown', () => {
  const line = (config, host = 'opencode', configUnreadable = false) => opState.overpassLine({ config, configUnreadable, host });
  assert.match(line(ON), /^Overpass: ON \(provider 'overpass'.*the conductor runs on overpass\/agentic-conductor; every subagent lane, the Plan agent and the maintenance worker run on overpass\/agentic-high\./);
  assert.match(line({ mode: 'work', overpass: { enabled: true, conductor_bypass: true, provider: 'overpass-agentic' } }), /^Overpass: ON \(provider 'overpass-agentic'.*the conductor is bypassed \(config\.overpass\.conductor_bypass\) and keeps its direct model pin; .* run on overpass-agentic\/agentic-high/);
  assert.match(line({ mode: 'hobby', overpass: { enabled: true } }), /^Overpass: CONFIGURED BUT NOT IN EFFECT — overpass applies in work mode only; the project mode is 'hobby'/);
  assert.match(line({ overpass: { enabled: true } }), /NOT IN EFFECT — overpass applies in work mode only; the project mode is 'hobby'/, 'absent mode is hobby');
  assert.match(line({ mode: 'work' }), /^Overpass: OFF \(config\.overpass\.enabled/);
  assert.equal(line({ mode: 'hobby' }), '', 'not offered in hobby mode: silent');
  assert.equal(line(null), '', 'absent config is the hobby default');
  assert.equal(line({ mode: 'work' }, 'claude'), '', 'not offered on Claude Code');
  assert.match(line({ mode: 'work', overpass: 'on' }), /^Overpass: INVALID — config\.overpass is "on"/);
  assert.match(line(null, 'opencode', true), /^Overpass: UNKNOWN — .*NOT the off default/);
});

test('session line: the OpenCode operating-state lines carry it beside Project mode', async () => {
  const mod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'operating-state.mjs')).href);
  const p = makeProject(ON);
  try {
    const { lines } = mod.operatingStateLines(p.dir, null);
    const i = lines.findIndex((l) => l.startsWith('Project mode:'));
    assert.match(lines[i + 1], /^Overpass: ON/);
  } finally {
    p.cleanup();
  }
});

// ── open-session notice ───────────────────────────────────────────────────────

const OPUS = { providerID: 'anthropic', id: 'claude-opus-5-5' };
const NOTICE = /STERLING OVERPASS: Overpass is ON but this session runs on (\S+): pick (\S+) in \/models or start a new session\./;

test('mismatch notice: a conductor or Plan session on another model is told every turn; a matching one is not', async () => {
  const p = makeProject(ON, { agent: {} });
  const s = await setup(p.dir);
  try {
    await s.step('ses_c', 'sterling/conductor', OPUS);
    for (let turn = 0; turn < 2; turn++) {
      const m = (await s.prompt('ses_c')).match(NOTICE);
      assert.ok(m, `turn ${turn}`);
      assert.deepEqual([m[1], m[2]], ['anthropic/claude-opus-5-5', 'overpass/agentic-conductor']);
    }
    await s.step('ses_p', 'plan', OPUS);
    assert.match(await s.prompt('ses_p'), /runs on anthropic\/claude-opus-5-5: pick overpass\/agentic-high/);
    await s.step('ses_ok', 'sterling/conductor', { providerID: 'overpass', id: 'agentic-conductor' });
    assert.doesNotMatch(await s.prompt('ses_ok'), NOTICE);
    await s.step('ses_impl', 'sterling/implementor', OPUS);
    assert.doesNotMatch(await s.prompt('ses_impl'), NOTICE, 'only conductor and Plan sessions');
    assert.doesNotMatch(await s.prompt('ses_unseen'), NOTICE, 'no model seen yet: nothing claimed');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('mismatch notice: silent when the conductor is bypassed or Overpass is off', async () => {
  for (const config of [{ mode: 'work', overpass: { enabled: true, conductor_bypass: true } }, { mode: 'work' }, { mode: 'hobby', overpass: { enabled: true } }]) {
    const p = makeProject(config, { agent: {} });
    const s = await setup(p.dir);
    try {
      await s.step('ses_c', 'sterling/conductor', OPUS);
      assert.doesNotMatch(await s.prompt('ses_c'), NOTICE, JSON.stringify(config));
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

test('mismatch notice: the agent from the context hook counts when the step event names none', async () => {
  const p = makeProject(ON, { agent: {} });
  const s = await setup(p.dir);
  try {
    await s.ctx.hooks.session.context({ sessionID: 'ses_x', agent: 'plan', system: [], messages: [] });
    await s.step('ses_x', undefined, OPUS);
    assert.match(await s.prompt('ses_x'), /pick overpass\/agentic-high/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});
