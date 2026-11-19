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

// The conductor is routed here: conductor_bypass is false explicitly, because it defaults to true since
// 2026-10-23 (user-ruled, 'Defaults + reset + bypass ON'). The default itself is pinned in the session-line and mismatch-notice tests.
// The canonical shape (decision settings-redesign-build-shape-one-legacy-to-canonical-config): each agent's one
// model in config.models, an Overpass tier written overpass/<tier>; the conductor and Plan have their own entries.
const TIER_MODELS = {
  conductor: { model: 'overpass/agentic-conductor' },
  plan: { model: 'overpass/agentic-high' },
  implementor: { model: 'overpass/agentic-auto', effort: 'medium' },
  'implementor-hard': { model: 'overpass/agentic-premium', effort: 'xhigh' },
  researcher: { model: 'overpass/agentic-high' },
  reviewer: { model: 'overpass/agentic-high' },
  scout: { model: 'overpass/agentic-auto', effort: 'high' },
  librarian: { model: 'overpass/agentic-auto', effort: 'high' },
  preflight: { model: 'overpass/agentic-auto', effort: 'high' },
  sparring: { model: 'overpass/agentic-premium-max', effort: 'xhigh' },
  'maintenance-worker': { model: 'overpass/agentic-auto', effort: 'high' },
};
const ON = { models: TIER_MODELS };
// The legacy shape (work mode, enabled), still read through the transform by the session line.
const LEGACY_ON = { mode: 'work', overpass: { enabled: true, conductor_bypass: false } };
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
// The resolution the overlay is written from (overpass.mjs overpassResolution): the Plan and conductor selections.
const resOn = ({ provider = 'overpass', conductor = true } = {}) => ({ provider, effective: true, roles: {}, plan: { model: `${provider}/agentic-high`, tier: true }, conductor: conductor ? { model: `${provider}/agentic-conductor`, tier: true } : null });
const resOff = { provider: 'overpass', effective: false, roles: {}, plan: null, conductor: null };

const LISTED_TIERS = ['overpass', 'overpass-agentic'].flatMap((providerID) =>
  ['agentic-auto', 'agentic-auto-roles', 'agentic-conductor', 'agentic-fast', 'agentic-high', 'agentic-max', 'agentic-premium', 'agentic-premium-max'].map((id) => ({ providerID, id, variants: [] }))
);

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
    // Changed with the Overpass availability check (GitHub #257, #258, #281): this list was
    // empty, which now reads as UNKNOWN and adds an UNKNOWN line to every routed dispatch, so
    // it lists every tier these tests route to, on both providers they use, as OpenCode 2.1.2
    // returns it ({ location, data }). The missing, UNKNOWN and recovery cases are pinned in
    // opencode-overpass-availability.test.mjs.
    model: { list: async () => ({ location: { directory }, data: LISTED_TIERS }) },
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

async function setup(dir, env = {}) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env });
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

const SOL = 'openai/gpt-6.1-sol#high';

// ── dispatch model (config.models; decisions one-model-per-agent-an-agent-has-a-single-model-not-a-claude
// and overpass-tiers-are-ordinary-model-choices-in-each-agent-s-pi) ──

test('dispatch: an agent on an Overpass tier runs on it; a model the call names is kept as a pin, with a line naming what config gives', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir);
  try {
    const plain = await s.dispatch({});
    assert.equal(plain.args.model, 'overpass/agentic-auto');
    assert.match(plain.result, /MODEL: this dispatch runs on overpass\/agentic-auto, from config\.models\.implementor, the Overpass tier overpass\/agentic-auto on provider 'overpass' with effort medium/);
    const explicit = await s.dispatch({ model: 'openai/gpt-6.1-sol#high' }, 'call_2');
    assert.equal(explicit.args.model, 'openai/gpt-6.1-sol#high', 'the call\'s own model is its pin, not replaced');
    assert.match(explicit.result, /MODEL: kept openai\/gpt-6\.1-sol#high as the call named; .* gives overpass\/agentic-auto/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('dispatch: config.overpass.provider maps the tier; a legacy effective Overpass routes through the same transform', async () => {
  const p = makeProject({ ...ON, overpass: { provider: 'overpass-agentic' } });
  const s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({})).args.model, 'overpass-agentic/agentic-auto');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
  const q = makeProject({ mode: 'work', overpass: { enabled: true, provider: 'overpass-agentic' } });
  const t = await setup(q.dir);
  try {
    assert.equal((await t.dispatch({})).args.model, 'overpass-agentic/agentic-auto', 'legacy work mode + enabled gives the implementor its tier');
    assert.equal((await t.dispatch({ agent: 'sterling/implementor-hard' }, 'call_2')).args.model, 'overpass-agentic/agentic-premium');
  } finally {
    await t.cleanup();
    q.cleanup();
  }
});

test('dispatch: with no agent on a tier the call is not routed through Overpass, in any mode', async () => {
  for (const config of [{}, { mode: 'work' }, { mode: 'work', overpass: { enabled: false } }, { mode: 'hobby', overpass: { enabled: true } }]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      const named = await s.dispatch({ model: 'anthropic/claude-sonnet-5' });
      assert.equal(named.args.model, 'anthropic/claude-sonnet-5', JSON.stringify(config));
      const unnamed = await s.dispatch({}, 'call_2');
      assert.equal(unnamed.args.model, 'anthropic/claude-sonnet-5-5#medium', JSON.stringify(config));
      assert.doesNotMatch(unnamed.result, /Overpass tier|OVERPASS/);
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

test('dispatch: the Claude Code host never shows an Overpass-tier agent as in effect (session line)', () => {
  // Changed with the cutover: Overpass is no setting, so the line names the agents whose one model is an overpass/<tier>.
  const line = opState.overpassLine({ config: { mode: 'work', overpass: { enabled: true } }, configUnreadable: false, host: 'claude' });
  assert.match(line, /^Overpass: NOT IN EFFECT — .*overpass\/agentic-auto.*only OpenCode can run/);
});

// A config whose model settings cannot be carried refuses the dispatch (a throw out of
// execute.before), because letting it run could put it on another provider; a whole config
// that cannot be parsed does not (it carries the UNKNOWN line, next test).
test('dispatch: an invalid Overpass block refuses the dispatch, never runs it on its own model', async () => {
  for (const [config, why] of [
    [{ mode: 'work', overpass: { enabled: 'yes' } }, /config\.overpass\.enabled is "yes" — it must be true or false/],
    [{ overpass: { provider: 'a/b' } }, /config\.overpass\.provider is "a\/b"/],
    [{ overpass: 'on' }, /config\.overpass is "on"/],
  ]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      const input = { tool: 'subagent', id: 'call_x', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: 'p', model: 'anthropic/claude-sonnet-5' } };
      await assert.rejects(s.ctx.hooks.tool['execute.before'](input), (e) => {
        assert.match(e.message, /^Sterling refused this subagent dispatch: the model settings in \.sterling\/config\.json cannot be read/);
        assert.match(e.message, why);
        assert.match(e.message, /Fix that value in \.sterling\/config\.json \(TUI System tab\), then dispatch again\./);
        return true;
      }, JSON.stringify(config));
      assert.equal(input.input.model, 'anthropic/claude-sonnet-5', 'the call is not touched, it is stopped');
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

test('dispatch: a role with two unresolved models refuses the dispatch, whatever model the call names', async () => {
  const p = makeProject({ models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra' } } });
  const s = await setup(p.dir);
  try {
    for (const model of [undefined, 'openai/gpt-5.6-terra']) {
      const input = { tool: 'subagent', id: 'call_x', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: 'p', ...(model ? { model } : {}) } };
      await assert.rejects(s.ctx.hooks.tool['execute.before'](input), /role implementor has two models; run \/sterling:update to choose/);
    }
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('dispatch: a config that cannot be read or parsed lets the dispatch run unrouted, with a loud UNKNOWN line', async () => {
  for (const [config, why] of [
    ['{ "mode": "work", ', /could not be read \(.*JSON/],
    ['[1, 2]', /could not be read \(it is not a JSON object\)/],
  ]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      const named = await s.dispatch({ model: 'anthropic/claude-sonnet-5' });
      assert.equal(named.args.model, 'anthropic/claude-sonnet-5', `the call keeps its model: ${config}`);
      assert.match(named.result, /Model routing UNKNOWN: \.sterling\/config\.json could not be read \(/);
      assert.match(named.result, why);
      assert.match(named.result, /dispatches get no model from config\.models, Overpass tiers included, until it is fixed\./);
      const unnamed = await s.dispatch({}, 'call_2');
      assert.equal(Object.hasOwn(unnamed.args, 'model'), false, 'no model is invented for a call that named none');
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

// The OVERPASS-BYPASS brief line is gone (a model the call names is the pin), so its marker tests
// became this one: the line is plain text, never parsed, never refused, in or out of a fence.
test('dispatch: an OVERPASS-BYPASS line is plain text; a named model is kept with or without it, an unnamed call still gets its tier', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir);
  try {
    const kept = await s.dispatch({ model: SOL, prompt: 'Review the diff.\nOVERPASS-BYPASS: cross-family review\n' });
    assert.equal(kept.args.model, SOL);
    assert.doesNotMatch(kept.result, /OVERPASS-BYPASS|bypassed/);
    assert.equal(notices(p.dir), '', 'no bypass notice');
    for (const [i, prompt] of ['OVERPASS-BYPASS:', 'OVERPASS-BYPASS:   \n', '```\nOVERPASS-BYPASS: x\n```', 'OVERPASS-BYPASS: a\nOVERPASS-BYPASS:'].entries()) {
      const out = await s.dispatch({ prompt }, `call_${i}`);
      assert.equal(out.args.model, 'overpass/agentic-auto', JSON.stringify(prompt));
    }
    assert.equal(overpass.bypassMarker, undefined, 'the marker reader is gone');
    assert.equal(overpass.dispatchPin, undefined);
    assert.equal(overpass.laneRoute, undefined);
  } finally {
    await s.cleanup();
    p.cleanup();
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
  const p = makeProject({}, handText);
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
    overpass.convergeOverlay(p.dir, resOn({ conductor: false }));
    const bypass = readOc(p.dir);
    assert.deepEqual(bypass.agent['sterling/conductor'], USER_OC.agent['sterling/conductor'], 'conductor keeps its own entry');
    assert.equal(bypass.agent.plan.model, 'overpass/agentic-high');

    overpass.convergeOverlay(p.dir, resOn());
    assert.equal(readOc(p.dir).agent['sterling/conductor'].model, 'overpass/agentic-conductor');
    overpass.convergeOverlay(p.dir, resOn({ conductor: false }));
    assert.deepEqual(readOc(p.dir).agent['sterling/conductor'], USER_OC.agent['sterling/conductor'], 'bypass undoes the conductor entry exactly');
  } finally {
    p.cleanup();
  }
});

test('overlay: a model the user changes while on is theirs, kept on undo; a provider switch rewrites the tier', () => {
  const p = makeProject(ON, { agent: {} });
  try {
    overpass.convergeOverlay(p.dir, resOn());
    overpass.convergeOverlay(p.dir, resOn({ provider: 'overpass-agentic' }));
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
  const other = resOn({ provider: 'overpass-agentic' });
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
    const other = resOn({ provider: 'overpass-agentic' });
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

/** A writeFileAtomic seam that lets the opencode.json write land, then fails the ownership write after it. */
function failingOwnershipAfterOc(dir) {
  let ocWritten = false;
  return {
    writeFile: (path, content) => {
      if (path.startsWith(join(dir, OC_REL))) ocWritten = true;
      else if (ocWritten && path.startsWith(join(dir, overpass.OVERLAY_REL))) throw new Error('injected ownership write failure');
      writeFileSync(path, content);
    },
  };
}

/** The user edits every agent entry by hand: a `description` added and the keys put in reverse order. */
function handEditEntries(dir, extra = {}) {
  const oc = readOc(dir);
  for (const [name, entry] of Object.entries(oc.agent)) {
    oc.agent[name] = Object.fromEntries([['description', `mine ${name}`], ...Object.entries({ ...entry, ...(extra[name] ?? {}) }).reverse()]);
  }
  writeFileSync(join(dir, OC_REL), `${JSON.stringify(oc, null, 2)}\n`);
}

const OTHER = resOn({ provider: 'overpass-agentic' });

test('overlay: an interrupted provider change, then a hand edit of other keys, still restores the user model on off', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, OTHER, { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    handEditEntries(p.dir);
    overpass.convergeOverlay(p.dir, resOff);
    const oc = readOc(p.dir);
    const conductor = oc.agent['sterling/conductor'];
    assert.equal(conductor.model, 'anthropic/claude-opus-5-5', 'the user model is back, not a tier');
    assert.equal(conductor.variant, 'medium', 'the user variant is back');
    assert.equal(conductor.description, 'mine sterling/conductor', 'the hand edit stays');
    assert.deepEqual(oc.agent.plan, { description: 'mine plan' }, 'the tier model Sterling created is gone, the hand edit stays');
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false);
  } finally {
    p.cleanup();
  }
});

test('overlay: an interrupted first enable, then a hand edit of other keys, still restores the user model and variant on off', () => {
  const p = makeProject(ON, USER_OC);
  try {
    assert.throws(() => overpass.convergeOverlay(p.dir, resOn(), { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    assert.equal(readOc(p.dir).agent['sterling/conductor'].model, 'overpass/agentic-conductor', 'the opencode.json write landed');
    handEditEntries(p.dir);
    overpass.convergeOverlay(p.dir, resOff);
    const oc = readOc(p.dir);
    const conductor = oc.agent['sterling/conductor'];
    assert.equal(conductor.model, 'anthropic/claude-opus-5-5', 'the original model is not lost');
    assert.equal(conductor.variant, 'medium', 'the original variant is not lost');
    assert.deepEqual(oc.agent.plan, { description: 'mine plan' });
  } finally {
    p.cleanup();
  }
});

test('overlay: an interrupted first enable, then a hand-added variant, is still read as landed on off', () => {
  const p = makeProject(ON, USER_OC);
  try {
    assert.throws(() => overpass.convergeOverlay(p.dir, resOn(), { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    handEditEntries(p.dir, { 'sterling/conductor': { variant: 'low' } });
    overpass.convergeOverlay(p.dir, resOff);
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.equal(conductor.model, 'anthropic/claude-opus-5-5', 'the model Sterling wrote is undone');
    assert.equal(conductor.variant, 'low', 'the variant chosen since is the latest choice and stays');
  } finally {
    p.cleanup();
  }
});

/** The user sets agent `name`'s model and variant by hand. */
function handSet(dir, name, fields) {
  const oc = readOc(dir);
  oc.agent[name] = { ...oc.agent[name], ...fields };
  writeFileSync(join(dir, OC_REL), `${JSON.stringify(oc, null, 2)}\n`);
}

test('overlay: an interrupted provider change, then a hand edit back to the old tier with a variant, is the user edit on off (board 6d48a936)', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, OTHER, { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    assert.equal(readOc(p.dir).agent['sterling/conductor'].model, 'overpass-agentic/agentic-conductor', 'the opencode.json write landed');
    handSet(p.dir, 'sterling/conductor', { model: 'overpass/agentic-conductor', variant: 'low' });
    const out = overpass.convergeOverlay(p.dir, resOff);
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.equal(conductor.model, 'overpass/agentic-conductor', 'the model the user set stays');
    assert.equal(conductor.variant, 'low', 'the variant the user set stays');
    assert.match(out.notes.join('\n'), /agent\.sterling\/conductor .*anthropic\/claude-opus-5-5.*medium/, 'the note names the model and variant from before Overpass');
    assert.equal(readOc(p.dir).agent.plan, undefined, 'the plan entry Sterling created is still undone');
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false);
  } finally {
    p.cleanup();
  }
});

test('overlay: a recovery note survives a later failed write until a convergence succeeds and returns it', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, OTHER, { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    handSet(p.dir, 'sterling/conductor', { model: 'overpass/agentic-conductor', variant: 'low' });
    assert.throws(() => overpass.convergeOverlay(p.dir, resOff, { fs: failingOcWrites(p.dir) }), /injected opencode\.json write failure/);
    const out = overpass.convergeOverlay(p.dir, resOff);
    assert.match(out.notes.join('\n'), /agent\.sterling\/conductor .*anthropic\/claude-opus-5-5.*medium/, 'the note from the failed turn-off is delivered, naming the values from before Overpass');
    assert.equal(out.notes.filter((n) => /before Overpass/.test(n)).length, 1, 'delivered once');
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.deepEqual([conductor.model, conductor.variant], ['overpass/agentic-conductor', 'low'], 'the hand edit stays');
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false, 'nothing left once the note is delivered');
    assert.deepEqual(overpass.convergeOverlay(p.dir, resOff), { changed: false, notes: [] }, 'not delivered twice');
  } finally {
    p.cleanup();
  }
});

test('overlay: exact-before hand edit is read as not landed: turn-off restores the direct model (authorized ambiguity)', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, OTHER, { fs: failingOwnershipAfterOc(p.dir) }), /injected ownership write failure/);
    handSet(p.dir, 'sterling/conductor', { model: 'overpass/agentic-conductor' });
    overpass.convergeOverlay(p.dir, resOff);
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.deepEqual([conductor.model, conductor.variant], ['anthropic/claude-opus-5-5', 'medium'], 'owned fields exactly as before the write read as not landed, so the pre-Overpass model and variant come back');
  } finally {
    p.cleanup();
  }
});

test('overlay: a failed undo, then a hand-changed variant on the tier entry, leaves the entry to the user and names the old values', () => {
  const p = makeProject(ON, USER_OC);
  try {
    overpass.convergeOverlay(p.dir, resOn());
    assert.throws(() => overpass.convergeOverlay(p.dir, resOff, { fs: failingOcWrites(p.dir) }), /injected opencode\.json write failure/);
    handSet(p.dir, 'sterling/conductor', { variant: 'low' });
    const out = overpass.convergeOverlay(p.dir, resOff);
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.deepEqual([conductor.model, conductor.variant], ['overpass/agentic-conductor', 'low'], 'an owned field changed by hand after an unconfirmed write is never overwritten');
    assert.match(out.notes.join('\n'), /agent\.sterling\/conductor .*anthropic\/claude-opus-5-5.*medium/, 'the values to put back by hand are named, not dropped silently');
    assert.equal(readOc(p.dir).agent.plan, undefined, 'the untouched plan entry is undone as usual');
  } finally {
    p.cleanup();
  }
});

test('overlay: a git-tracked opencode.json is not written and the skip is reported, not thrown', () => {
  const p = makeProject(ON, { agent: {} });
  try {
    const git = (...args) => spawnSync('git', args, { cwd: p.dir, encoding: 'utf8' });
    git('init', '-q');
    git('add', OC_REL);
    const out = overpass.convergeOverlay(p.dir, resOn());
    assert.equal(out.skippedTracked, true);
    assert.equal(out.changed, false);
    assert.deepEqual(readOc(p.dir), { agent: {} });
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false, 'no ownership or pending record is written');
  } finally {
    p.cleanup();
  }
});

const trackOc = (dir, ...more) => {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', OC_REL, ...more);
  return git;
};
const noticeEntries = (dir) => {
  const f = join(dir, server.NOTICES_REL);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
};

test('overlay: a file that becomes tracked after Sterling wrote the overlay keeps its entries and ownership, and names them', () => {
  const p = makeProject(ON, { agent: { plan: { model: 'anthropic/claude-opus-5-5' } } });
  try {
    overpass.convergeOverlay(p.dir, resOn());
    const git = trackOc(p.dir);
    const fileBefore = readFileSync(join(p.dir, OC_REL), 'utf8');
    const ownBefore = readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8');
    const out = overpass.convergeOverlay(p.dir, resOff);
    assert.equal(out.skippedTracked, true);
    assert.deepEqual(out.stranded.map((e) => e.name).sort(), ['plan', 'sterling/conductor']);
    const text = overpass.strandedNotice(out.stranded);
    assert.match(text, /agent\.plan \(model "overpass\/agentic-high"; before Overpass: model "anthropic\/claude-opus-5-5"/);
    assert.doesNotMatch(text, /untrack|git rm|failed/i);
    assert.equal(readFileSync(join(p.dir, OC_REL), 'utf8'), fileBefore, 'the tracked file is not written');
    assert.equal(readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8'), ownBefore, 'ownership is kept for the restore');
    git('rm', '-q', '--cached', OC_REL);
    overpass.convergeOverlay(p.dir, resOff);
    assert.equal(readOc(p.dir).agent.plan.model, 'anthropic/claude-opus-5-5', 'untracked again: the normal restore proceeds');
  } finally {
    p.cleanup();
  }
});

test('overlay: off with a tracked opencode.json and nothing of Sterling in it is silent', () => {
  const p = makeProject({}, { agent: {} });
  try {
    trackOc(p.dir);
    assert.deepEqual(overpass.convergeOverlay(p.dir, resOff), { changed: false, notes: [] });
  } finally {
    p.cleanup();
  }
});

test('overlay: a tracked file that already holds the tier models gets no ownership record and still reports the skip', () => {
  const held = { agent: { plan: { model: 'overpass/agentic-high' }, 'sterling/conductor': { model: 'overpass/agentic-conductor' } } };
  const p = makeProject(ON, held);
  try {
    trackOc(p.dir);
    const out = overpass.convergeOverlay(p.dir, resOn());
    assert.equal(out.skippedTracked, true);
    assert.equal(existsSync(join(p.dir, overpass.OVERLAY_REL)), false, 'no ownership is created for a tracked file');
    assert.deepEqual(readOc(p.dir), held);
  } finally {
    p.cleanup();
  }
});

test('overlay: Overpass turned off after the file became tracked says what to restore, in the plugin', async () => {
  const p = makeProject(ON, { agent: { plan: { model: 'anthropic/claude-opus-5-5' } } });
  const s = await setup(p.dir);
  try {
    await s.prompt('ses_root');
    assert.equal(readOc(p.dir).agent.plan.model, 'overpass/agentic-high');
    trackOc(p.dir);
    writeConfig(p.dir, {});
    await s.prompt('ses_root');
    assert.equal(readOc(p.dir).agent.plan.model, 'overpass/agentic-high', 'never written while tracked');
    const said = notices(p.dir);
    assert.match(said, /still holds models Sterling wrote: .*agent\.plan .*anthropic\/claude-opus-5-5/);
    assert.doesNotMatch(said, /untrack|git rm|failed/i);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('overlay: a tracked config session is not told to switch the conductor or Plan model', async () => {
  const p = makeProject(ON, { agent: {} });
  trackOc(p.dir);
  const s = await setup(p.dir);
  try {
    await s.step('ses_c', 'sterling/conductor', OPUS);
    const text = await s.prompt('ses_c');
    assert.doesNotMatch(text, /pick \S+ in \/models|STERLING OVERPASS: Overpass is ON/);
    await s.step('ses_p', 'plan', OPUS);
    assert.doesNotMatch(await s.prompt('ses_p'), /pick \S+ in \/models/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('overlay: repeated prompts with a tracked config leave one keyed notice', async () => {
  const p = makeProject(ON, { agent: {} });
  trackOc(p.dir);
  const s = await setup(p.dir);
  try {
    const shown = [];
    for (let i = 0; i < 3; i++) shown.push(await s.prompt('ses_root'));
    const entries = noticeEntries(p.dir).filter((n) => /tracked by git/.test(n.text));
    assert.ok(entries.length > 0 && entries.every((n) => n.key === 'overpass-tracked-overlay'), 'every re-minted notice carries the key');
    assert.equal(entries.filter((n) => !n.shown_at).length <= 1, true, 'at most one unshown copy waits');
    const copies = shown.join('\n').match(/tracked by git/g) ?? [];
    assert.equal(copies.length, 1, `the session is shown it once: ${JSON.stringify(shown)}`);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('overlay: with a tracked opencode.json the notice is informational and dispatches still route', async () => {
  const p = makeProject(ON, { agent: {} });
  const git = (...args) => spawnSync('git', args, { cwd: p.dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', OC_REL);
  const s = await setup(p.dir);
  try {
    await s.prompt('ses_root');
    assert.deepEqual(readOc(p.dir), { agent: {} }, 'no file write');
    const said = notices(p.dir);
    assert.match(said, /so the conductor and Plan run on the models that file gives them, not on their config\.models selections/);
    assert.match(said, /Subagent dispatches still get their models from config\.models/);
    assert.doesNotMatch(said, /untrack|git rm|failed/i);
    assert.equal((await s.dispatch({})).args.model, 'overpass/agentic-auto', 'dispatches still get their config.models model');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('overlay: the plugin converges it at setup and each turn, following a config change', async () => {
  const p = makeProject({}, USER_OC);
  const s = await setup(p.dir);
  try {
    assert.deepEqual(readOc(p.dir), USER_OC, 'no selection at setup: untouched');
    writeConfig(p.dir, ON);
    await s.prompt('ses_root');
    assert.equal(readOc(p.dir).agent.plan.model, 'overpass/agentic-high');
    writeConfig(p.dir, {});
    await s.prompt('ses_root');
    assert.deepEqual(readOc(p.dir), USER_OC, 'the selections gone: undone exactly');
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

test('session line: ON, not in effect, silent, invalid and unknown', () => {
  // Changed with the cutover (item G, decisions overpass-tiers-are-ordinary-model-choices-in-each-agent-s-pi and
  // settings-that-replace-project-mode-merge-path-reviewer-count): Overpass is no toggle. An agent is routed when its one model is an
  // overpass/<tier>, which a legacy work-mode config with Overpass on migrates to (the migration's effectiveness rule is pinned in
  // canonical-config.test.ts), so the line lists the routed agents and the old ON/BYPASS/OFF wording is gone.
  const line = (config, host = 'opencode', configUnreadable = false) => opState.overpassLine({ config, configUnreadable, host });
  assert.match(line(LEGACY_ON), /^Overpass: ON \(provider 'overpass', config\.models — TUI System tab\) — overpass\/agentic-auto at effort medium \(implementor\), overpass\/agentic-premium at effort xhigh \(implementor-hard\)/);
  assert.match(line({ mode: 'work', overpass: { enabled: true, provider: 'overpass-agentic' } }), /^Overpass: ON \(provider 'overpass-agentic'/);
  assert.match(line({ mode: 'work', overpass: { enabled: true, roles: { reviewer: { tier: 'agentic-max', effort: 'xhigh' } } } }), /overpass\/agentic-max at effort xhigh \(reviewer\)/, 'an explicit role tier and effort are carried');
  assert.equal(line({ mode: 'hobby', overpass: { enabled: true } }), '', 'a legacy hobby project with Overpass on was not effective: it migrates to no tiers, so the line is silent');
  assert.equal(line({ mode: 'work' }), '', 'no agent on a tier: silent');
  assert.equal(line(null), '', 'absent config: silent');
  assert.equal(line({ mode: 'work' }, 'claude'), '', 'not offered on Claude Code');
  assert.match(line({ mode: 'work', overpass: 'on' }), /^Overpass: INVALID — .*config\.overpass is "on"/);
  assert.match(line(null, 'opencode', true), /^Overpass: UNKNOWN — .*NOT the off default/);
});

// Changed in the second fix round: the Overpass line sat between Project mode and Handoff
// files, which broke handoff-setting.test.mjs's pinned order (the handoff line follows the
// mode line). It now follows the Storage line.
test('session line: the OpenCode operating-state lines carry it after Storage', async () => {
  const mod = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'operating-state.mjs')).href);
  const p = makeProject(LEGACY_ON);
  try {
    const { lines } = mod.operatingStateLines(p.dir, null);
    const i = lines.findIndex((l) => l.startsWith('Storage:'));
    assert.match(lines[i + 1], /^Overpass: ON/);
  } finally {
    p.cleanup();
  }
});

// ── open-session notice ───────────────────────────────────────────────────────

const OPUS = { providerID: 'anthropic', id: 'claude-opus-5-5' };
const NOTICE = /STERLING MODELS: config\.models gives this agent (\S+), but this session runs on (\S+): pick (\S+) in \/models or start a new session\./;

test('mismatch notice: a conductor or Plan session on another model is told every turn; a matching one is not', async () => {
  const p = makeProject(ON, { agent: {} });
  const s = await setup(p.dir);
  try {
    await s.step('ses_c', 'sterling/conductor', OPUS);
    for (let turn = 0; turn < 2; turn++) {
      const m = (await s.prompt('ses_c')).match(NOTICE);
      assert.ok(m, `turn ${turn}`);
      assert.deepEqual([m[2], m[1]], ['anthropic/claude-opus-5-5', 'overpass/agentic-conductor']);
      assert.equal(m[3], m[1]);
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

test('mismatch notice: silent when the conductor has no selection', async () => {
  for (const config of [{}, { models: { implementor: { model: 'overpass/agentic-auto' } } }, { mode: 'work', overpass: { enabled: true } }]) {
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

// ── per-role tier and effort (config.overpass.roles) ─────────────────────────

const ROLES_ON = { models: { ...TIER_MODELS, reviewer: { model: 'overpass/agentic-max', effort: 'xhigh' }, implementor: { model: 'overpass/agentic-auto', effort: 'high' }, scout: { model: 'overpass/agentic-fast' } } };
const REVIEWER_HIGH = { models: { ...TIER_MODELS, reviewer: { model: 'overpass/agentic-high', effort: 'high' } } };
const LANE = { providerID: 'overpass', id: 'agentic-high' };
// The implementor role's default lane model (ruled default change 2026-10-22: agentic-premium; 2026-10-23: agentic-auto, implementor-hard took agentic-premium).
const IMPL_LANE = { providerID: 'overpass', id: 'agentic-auto' };

/** One model request through the context hook in session `sessionID`; returns its options afterwards. */
async function request(s, agent, model, options = {}, sessionID = 'ses_lane') {
  const input = { sessionID, agent, model, system: [], messages: [], options, tools: {} };
  await s.ctx.hooks.session.context(input);
  return input.options;
}
/** Child sessions answer session.get with their parentID: `parentOf[id]`, else ses_root for every ses_child*. */
function childSessions(s, parentOf = {}) {
  s.ctx.session.get = async ({ sessionID }) => {
    const parentID = parentOf[sessionID] ?? (sessionID.startsWith('ses_child') ? 'ses_root' : undefined);
    return { id: sessionID, location: { directory: s.ctx.location.directory }, ...(parentID ? { parentID } : {}) };
  };
}
/** A subagent call's execute.before only (the child runs while the call is open); returns the hook input. */
async function begin(s, args, id, parent = 'ses_root') {
  const input = { tool: 'subagent', id, sessionID: parent, input: { description: 'fixture lane', prompt: 'Change the fixture file.', ...args } };
  await s.ctx.hooks.tool['execute.before'](input);
  return input;
}
/** OpenCode 2.1.2's subagent progress report naming the child, before the child is prompted. */
async function progress(s, id, child, parent = 'ses_root') {
  s.ctx.emit({ type: 'session.tool.progress', data: { sessionID: parent, assistantMessageID: 'msg_a', id, metadata: { sessionID: child, status: 'running' } } });
  await s.plugin.idle();
}
/** The call's execute.after, its result naming the child as OpenCode's does. */
async function finish(s, input, child) {
  await s.ctx.hooks.tool['execute.after']({ ...input, status: 'completed', result: { content: [{ type: 'text', text: 'lane done' }], metadata: { sessionID: child, status: 'completed' } } });
}
/** A dispatch of `agent`, linked to `child` by the progress event; returns the call input. */
async function linkedLane(s, agent, child, id, extra = {}) {
  const input = await begin(s, { agent, ...extra }, id);
  await progress(s, id, child);
  return input;
}
const has = (options) => Object.hasOwn(options, 'reasoningEffort');

test('roles: each agent runs on its own tier; an agent with no model is left alone, and a named model is kept', async () => {
  const p = makeProject(ROLES_ON);
  const s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({ agent: 'sterling/reviewer' })).args.model, 'overpass/agentic-max');
    assert.equal((await s.dispatch({ agent: 'sterling/scout' }, 'call_2')).args.model, 'overpass/agentic-fast');
    assert.equal((await s.dispatch({ agent: 'sterling/implementor' }, 'call_3')).args.model, 'overpass/agentic-auto');
    assert.equal((await s.dispatch({ agent: 'sterling/researcher' }, 'call_4')).args.model, 'overpass/agentic-high');
    assert.equal(Object.hasOwn((await s.dispatch({ agent: 'general' }, 'call_5')).args, 'model'), false, 'no config.models entry: no model is invented');
    const named = await s.dispatch({ agent: 'sterling/reviewer', model: 'overpass/agentic-high' }, 'call_6');
    assert.equal(named.args.model, 'overpass/agentic-high', 'the named model is the pin');
    assert.match(named.result, /MODEL: kept overpass\/agentic-high as the call named; .* gives overpass\/agentic-max/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('roles: sterling/sparring and sterling/implementor-hard are their own roles, each on its own tier', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({ agent: 'sterling/sparring' })).args.model, 'overpass/agentic-premium-max');
    assert.equal((await s.dispatch({ agent: 'sterling/reviewer' }, 'call_2')).args.model, 'overpass/agentic-high', 'the reviewer is not the sparring role');
    assert.equal((await s.dispatch({ agent: 'sterling/implementor-hard' }, 'call_3')).args.model, 'overpass/agentic-premium');
    assert.equal((await s.dispatch({ agent: 'sterling/implementor' }, 'call_4')).args.model, 'overpass/agentic-auto');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
  const q = makeProject({ models: { sparring: { model: 'overpass/agentic-max' }, 'implementor-hard': { model: 'overpass/agentic-premium-max' }, implementor: { model: 'overpass/agentic-high' } } });
  const t = await setup(q.dir);
  try {
    assert.equal((await t.dispatch({ agent: 'sterling/sparring' })).args.model, 'overpass/agentic-max');
    assert.equal((await t.dispatch({ agent: 'sterling/implementor-hard' }, 'call_2')).args.model, 'overpass/agentic-premium-max');
    assert.equal((await t.dispatch({ agent: 'sterling/implementor' }, 'call_3')).args.model, 'overpass/agentic-high', 'the implementor keeps its own tier');
    assert.equal((await t.dispatch({ agent: 'sterling/implementor', prompt: 'Do it.\nMODEL-INTENT: hard' }, 'call_4')).args.model, 'overpass/agentic-high', 'an intent line is plain text now');
  } finally {
    await t.cleanup();
    q.cleanup();
  }
});

test('roles: an unknown role or field refuses the dispatch like any invalid Overpass block', async () => {
  for (const [roles, why] of [
    [{ conductor: { effort: 'high' } }, /unknown role "conductor"/],
    [{ reviewer: { model: 'openai/x' } }, /unknown field "model"/],
  ]) {
    const p = makeProject({ mode: 'work', overpass: { enabled: true, roles } });
    const s = await setup(p.dir);
    try {
      await assert.rejects(s.dispatch({ agent: 'sterling/reviewer' }), why);
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

// GitHub #202: CH.Core's config.overpass.roles, written by a 0.19.116 dashboard and refused
// by a 0.19.113 plugin. This build knows all five roles; a role from a still newer
// Sterling ('future-role') stands in for the three 0.19.113 did not know.
const ISSUE_202_ROLES = { 'maintenance-worker': { tier: 'agentic-auto' }, 'implementor-hard': { tier: 'agentic-premium' }, scout: { tier: 'agentic-auto' }, preflight: { tier: 'agentic-auto' }, librarian: { tier: 'agentic-auto' } };

test('roles (#202): the issue\'s exact roles block dispatches on this build; a role a newer Sterling wrote is refused naming this plugin\'s version and opencode plugin update then /reload', async () => {
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const exact = makeProject({ mode: 'work', overpass: { enabled: true, provider: 'overpass', conductor_bypass: true, roles: ISSUE_202_ROLES } });
  const ok = await setup(exact.dir);
  try {
    const { args } = await ok.dispatch({ agent: 'sterling/scout' });
    assert.equal(args.model, 'overpass/agentic-auto', 'the scout runs on the tier the issue\'s config set');
  } finally {
    await ok.cleanup();
    exact.cleanup();
  }
  const newer = makeProject({ mode: 'work', overpass: { enabled: true, provider: 'overpass', conductor_bypass: true, roles: { ...ISSUE_202_ROLES, 'future-role': { tier: 'agentic-auto' } } } });
  const s = await setup(newer.dir);
  try {
    await assert.rejects(s.dispatch({ agent: 'sterling/reviewer' }), (e) => {
      assert.match(e.message, /unknown role "future-role"/);
      assert.ok(e.message.includes(`This Sterling plugin is version ${version} and does not know the role "future-role"`), e.message);
      assert.ok(e.message.includes('Run `opencode plugin update`, then /reload'), e.message);
      return true;
    });
  } finally {
    await s.cleanup();
    newer.cleanup();
  }
});

test('roles (#202): an invalid value on a known role keeps the plain refusal, with no update advice', () => {
  const msg = overpass.overpassRefusal(new Error('config.overpass.roles.reviewer.effort is "loud"'), { version: '9.9.9' });
  assert.doesNotMatch(msg, /opencode plugin update|9\.9\.9/);
  assert.match(msg, /Fix that value in \.sterling\/config\.json/);
});

// Changed 2026-10-24 (decision overpass-default-effort-per-role-high-for-agentic-auto-roles, GitHub #203):
// was "unset roles sends no reasoningEffort". An unset role now sends its default effort (implementor
// high, implementor-hard and sparring xhigh); reviewer and researcher have none and still send nothing.
test('effort: an unset role sends its default effort; reviewer and researcher send none', async () => {
  const p = makeProject(ON);
  const s = await setup(p.dir);
  try {
    childSessions(s);
    const lanes = [
      ['sterling/implementor', IMPL_LANE, 'medium'],
      ['sterling/implementor-hard', { providerID: 'overpass', id: 'agentic-premium' }, 'xhigh'],
      ['sterling/sparring', { providerID: 'overpass', id: 'agentic-premium-max' }, 'xhigh'],
      ['sterling/scout', IMPL_LANE, 'high'],
      ['sterling/reviewer', LANE, undefined],
      ['sterling/researcher', LANE, undefined],
    ];
    for (const [i, [agent, model, effort]] of lanes.entries()) {
      await linkedLane(s, agent, `ses_child${i}`, `call_${i}`);
      assert.equal((await request(s, agent, model, {}, `ses_child${i}`)).reasoningEffort, effort, agent);
    }
    assert.equal(has(await request(s, 'plan', LANE)), false);
    assert.equal(has(await request(s, 'sterling/conductor', LANE)), false);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('effort: set on a linked role lane on exactly its lane model, replacing any effort already there', async () => {
  const p = makeProject(ROLES_ON);
  const s = await setup(p.dir);
  try {
    childSessions(s);
    await linkedLane(s, 'sterling/implementor', 'ses_child1', 'call_1');
    assert.equal((await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child1')).reasoningEffort, 'high');
    assert.equal((await request(s, 'sterling/implementor', IMPL_LANE, { reasoningEffort: 'xhigh', temperature: 1 }, 'ses_child1')).reasoningEffort, 'high', 'an exact override, not a minimum');
    assert.equal((await request(s, 'sterling/implementor', IMPL_LANE, { temperature: 1 }, 'ses_child1')).temperature, 1, 'other options are kept');
    const noOptions = { sessionID: 'ses_child1', agent: 'sterling/implementor', model: IMPL_LANE, system: [], messages: [] };
    await s.ctx.hooks.session.context(noOptions);
    assert.equal(noOptions.options?.reasoningEffort, 'high');
    await linkedLane(s, 'sterling/reviewer', 'ses_child2', 'call_2');
    assert.equal((await request(s, 'sterling/reviewer', { providerID: 'overpass', id: 'agentic-max' }, {}, 'ses_child2')).reasoningEffort, 'xhigh');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('effort: a call that names another model than its role\'s tier never gets the role effort', async () => {
  const p = makeProject(REVIEWER_HIGH);
  const s = await setup(p.dir);
  try {
    childSessions(s);
    const call = await linkedLane(s, 'sterling/reviewer', 'ses_child1', 'call_1', { model: SOL });
    assert.equal(call.input.model, SOL, 'the named model is the pin');
    assert.equal(has(await request(s, 'sterling/reviewer', { providerID: 'openai', id: 'gpt-6.1-sol' }, {}, 'ses_child1')), false, 'a request on the pinned model');
    // Not linked yet: unknown, so no effort, even on the tier model.
    await begin(s, { agent: 'sterling/reviewer', model: SOL }, 'call_2');
    assert.equal(has(await request(s, 'sterling/reviewer', LANE, {}, 'ses_child2')), false, 'unlinked');
    // A plain sibling open at the same time does not make the unlinked child known.
    await begin(s, { agent: 'sterling/reviewer' }, 'call_3');
    assert.equal(has(await request(s, 'sterling/reviewer', LANE, {}, 'ses_child2')), false, 'ambiguous between siblings');
    await progress(s, 'call_3', 'ses_child3');
    assert.equal((await request(s, 'sterling/reviewer', LANE, {}, 'ses_child3')).reasoningEffort, 'high', 'the plain sibling, once linked');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});
// Changed in the second fix round (conductor ruling after the Sol re-check): this test
// asserted the removed parent-plus-role fallback, which gave an unlinked child the effort
// when every open dispatch of its parent and role was plain. A child now gets none until
// it is linked to its own dispatch.
test('effort: a child not linked yet gets none; once linked to its own plain dispatch it gets the effort; an unknown child gets none', async () => {
  const p = makeProject(ROLES_ON);
  const s = await setup(p.dir);
  try {
    childSessions(s);
    await begin(s, { agent: 'sterling/implementor' }, 'call_1');
    assert.equal(has(await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child1')), false, 'not linked yet, even with only plain dispatches open');
    await progress(s, 'call_1', 'ses_child1');
    assert.equal((await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child1')).reasoningEffort, 'high', 'linked');
    assert.equal(has(await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_lane')), false, 'a session with no parent');
    assert.equal(has(await request(s, 'sterling/reviewer', { providerID: 'overpass', id: 'agentic-max' }, {}, 'ses_child9')), false, 'no reviewer dispatch');
    await finish(s, await begin(s, { agent: 'sterling/implementor' }, 'call_2'), 'ses_child2');
    assert.equal((await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child2')).reasoningEffort, 'high', 'linked by execute.after');
    s.ctx.session.get = async () => {
      throw new Error('session store unavailable');
    };
    await linkedLane(s, 'sterling/implementor', 'ses_child7', 'call_7');
    assert.equal(has(await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child7')), false, 'parent unreadable: fail safe');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /no per-role reasoning effort for session ses_child7: its parent session could not be read/);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('effort: after a restart a child linked before it gets none, even with a sibling open; a newly linked child does', async () => {
  const p = makeProject(REVIEWER_HIGH);
  const first = await setup(p.dir);
  let second = null;
  try {
    childSessions(first);
    await linkedLane(first, 'sterling/reviewer', 'ses_child1', 'call_1');
    assert.equal((await request(first, 'sterling/reviewer', LANE, {}, 'ses_child1')).reasoningEffort, 'high');
    await first.cleanup();
    second = await setup(p.dir);
    childSessions(second);
    await begin(second, { agent: 'sterling/reviewer' }, 'call_2');
    assert.equal(has(await request(second, 'sterling/reviewer', LANE, {}, 'ses_child1')), false, 'the child linked before the restart');
    await progress(second, 'call_2', 'ses_child2');
    assert.equal((await request(second, 'sterling/reviewer', LANE, {}, 'ses_child2')).reasoningEffort, 'high', 'the sibling, once linked');
  } finally {
    await second?.cleanup();
    p.cleanup();
  }
});
test('effort: the same call id under two parents never crosses; a link or a child under the wrong parent gets none (Sol re-check, HIGH)', async () => {
  const p = makeProject(REVIEWER_HIGH);
  const s = await setup(p.dir);
  try {
    childSessions(s, { ses_childA: 'ses_root', ses_childB: 'ses_rootB', ses_childX: 'ses_rootB' });
    await begin(s, { agent: 'sterling/reviewer' }, 'call_1', 'ses_root');
    await begin(s, { agent: 'sterling/reviewer' }, 'call_1', 'ses_rootB');
    await progress(s, 'call_1', 'ses_childA', 'ses_root');
    assert.equal((await request(s, 'sterling/reviewer', LANE, {}, 'ses_childA')).reasoningEffort, 'high', "A's child");
    assert.equal(has(await request(s, 'sterling/reviewer', LANE, {}, 'ses_childB')), false, "B's child is not linked by A's progress event");
    await progress(s, 'call_1', 'ses_childB', 'ses_rootB');
    assert.equal((await request(s, 'sterling/reviewer', LANE, {}, 'ses_childB')).reasoningEffort, 'high', "B's child");
    // A progress event naming B's call under the wrong parent links nothing.
    await begin(s, { agent: 'sterling/reviewer' }, 'call_2', 'ses_rootB');
    await progress(s, 'call_2', 'ses_childX', 'ses_root');
    assert.equal(has(await request(s, 'sterling/reviewer', LANE, {}, 'ses_childX')), false, 'linked under the wrong parent');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});
test('effort: a child whose actual parent differs from its linked dispatch\'s parent gets none', async () => {
  const p = makeProject(REVIEWER_HIGH);
  const s = await setup(p.dir);
  try {
    childSessions(s, { ses_child1: 'ses_other' });
    await linkedLane(s, 'sterling/reviewer', 'ses_child1', 'call_1');
    assert.equal(has(await request(s, 'sterling/reviewer', LANE, {}, 'ses_child1')), false);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('lane dispatches: an evicted link is unknown, never matched to a plain sibling (Sol re-check, CRITICAL)', () => {
  const lanes = overpass.createLaneDispatches();
  lanes.noteDispatch('ses_root', 'call_old', { agent: 'sterling/reviewer', prompt: 'Review.' });
  lanes.linkChild('ses_root', 'call_old', 'ses_child_old');
  assert.deepEqual(lanes.dispatchOf('ses_child_old', 'ses_root', 'sterling/reviewer'), { role: 'reviewer' });
  for (let i = 0; i < 520; i++) {
    lanes.noteDispatch('ses_root', `call_${i}`, { agent: 'sterling/reviewer', prompt: 'Review.' });
    lanes.linkChild('ses_root', `call_${i}`, `ses_child_${i}`);
  }
  lanes.noteDispatch('ses_root', 'call_open', { agent: 'sterling/reviewer', prompt: 'Review.' });
  assert.equal(lanes.dispatchOf('ses_child_old', 'ses_root', 'sterling/reviewer'), null, 'evicted: unknown');
  assert.deepEqual(lanes.dispatchOf('ses_child_519', 'ses_root', 'sterling/reviewer'), { role: 'reviewer' });
  assert.equal(lanes.dispatchOf('ses_child_519', 'ses_root', 'sterling/scout'), null, 'another role');
  assert.equal(lanes.dispatchOf('ses_child_519', 'ses_rootB', 'sterling/reviewer'), null, 'another parent');
});
test('lane dispatches: a call that ends without a child is dropped; one already linked keeps its child', () => {
  const lanes = overpass.createLaneDispatches();
  lanes.noteDispatch('ses_root', 'call_1', { agent: 'sterling/reviewer', prompt: 'Review.' });
  lanes.endCall('ses_root', 'call_1', null);
  lanes.linkChild('ses_root', 'call_1', 'ses_child1');
  assert.equal(lanes.dispatchOf('ses_child1', 'ses_root', 'sterling/reviewer'), null, 'dropped, so a late link finds nothing');
  lanes.noteDispatch('ses_root', 'call_2', { agent: 'sterling/reviewer', prompt: 'Review.' });
  lanes.linkChild('ses_root', 'call_2', 'ses_child2');
  lanes.endCall('ses_root', 'call_2', 'ses_child_other');
  assert.deepEqual(lanes.dispatchOf('ses_child2', 'ses_root', 'sterling/reviewer'), { role: 'reviewer' });
  assert.equal(lanes.dispatchOf('ses_child_other', 'ses_root', 'sterling/reviewer'), null);
});

test('effort: never set for another model, a call that named its own model, an unmapped agent, Plan, the worker or a role with no effort', async () => {
  const p = makeProject(ROLES_ON);
  const s = await setup(p.dir);
  try {
    childSessions(s);
    await linkedLane(s, 'sterling/implementor', 'ses_child1', 'call_1');
    await linkedLane(s, 'sterling/reviewer', 'ses_child2', 'call_2');
    await linkedLane(s, 'sterling/scout', 'ses_child3', 'call_3');
    await linkedLane(s, 'sterling/researcher', 'ses_child4', 'call_4');
    await linkedLane(s, 'general', 'ses_child5', 'call_5');
    await linkedLane(s, 'sterling/implementor', 'ses_child6', 'call_6', { model: 'overpass/agentic-conductor' });
    await linkedLane(s, 'sterling/implementor', 'ses_child7', 'call_7', { model: 'overpass/agentic-auto' });
    const cases = [
      ['sterling/implementor', { providerID: 'openai', id: 'gpt-6.1-sol' }, 'ses_child1', 'a direct model'],
      ['sterling/implementor', { providerID: 'overpass', id: 'agentic-conductor' }, 'ses_child6', 'a call that named an overpass model of its own'],
      // restored (item-G review loop 3): a call that names exactly its role's tier still named it, so no role effort
      ['sterling/implementor', { providerID: 'overpass', id: 'agentic-auto' }, 'ses_child7', 'a call that named its own role tier'],
      ['sterling/reviewer', LANE, 'ses_child2', 'a reviewer on agentic-high while its tier is agentic-max'],
      ['sterling/implementor', { providerID: 'overpass-agentic', id: 'agentic-high' }, 'ses_child1', 'another provider with the same id'],
      ['sterling/implementor', undefined, 'ses_child1', 'no model on the request'],
      ['general', LANE, 'ses_child5', 'an unmapped agent'],
      ['plan', LANE, 'ses_plan', 'Plan'],
      ['sterling-maintenance-worker', LANE, 'ses_worker', 'the maintenance worker'],
      ['sterling/conductor', { providerID: 'overpass', id: 'agentic-conductor' }, 'ses_root', 'the conductor'],
      // Changed 2026-10-24: the scout now has a default effort (high), so a request off its tier model is the case left.
      ['sterling/scout', LANE, 'ses_child3', 'a role on a model that is not its tier model'],
      ['sterling/researcher', LANE, 'ses_child4', 'a role with no entry'],
    ];
    for (const [agent, model, sessionID, why] of cases) assert.equal(has(await request(s, agent, model, {}, sessionID)), false, why);
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('effort: never set while no agent is on an Overpass tier', async () => {
  for (const config of [{}, { models: { implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } } }, { mode: 'hobby', overpass: { enabled: true } }]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      childSessions(s);
      await linkedLane(s, 'sterling/implementor', 'ses_child1', 'call_1');
      assert.equal(has(await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child1')), false, JSON.stringify(config));
      assert.equal(notices(p.dir), '', 'nothing to report');
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});
test('effort: an invalid overpass block or an unreadable config sends none and says so once, each in its own words (Sol review, MEDIUM)', async () => {
  for (const [config, words] of [
    [{ mode: 'work', overpass: { enabled: true, roles: { conductor: { effort: 'high' } } } }, /Sterling Overpass: no per-role reasoning effort is sent: the Overpass setting in \.sterling\/config\.json is invalid \(config\.overpass\.roles has the unknown role "conductor"/],
    ['{ not json', /Sterling Overpass: no per-role reasoning effort is sent: Model routing UNKNOWN: \.sterling\/config\.json could not be read/],
  ]) {
    const p = makeProject(config);
    const s = await setup(p.dir);
    try {
      for (let i = 0; i < 3; i++) assert.equal(has(await request(s, 'sterling/implementor', IMPL_LANE, {}, 'ses_child1')), false);
      const said = notices(p.dir).split('\n').filter((line) => /no per-role reasoning effort/.test(line));
      assert.equal(said.length, 1, `reported once: ${said.join(' | ')}`);
      assert.match(said[0], words);
    } finally {
      await s.cleanup();
      p.cleanup();
    }
  }
});

// Ruled 2026-10-24 (option a, decision overpass-default-effort-per-role-high-for-agentic-auto-roles): the worker's
// effort reaches its requests through the plugin's context hook inside the worker child, from the environment the
// launch set (maintenance-worker-opencode.mjs opencodeEnv), never as `opencode run --variant`.
test('effort: inside the maintenance worker child, the launch\'s effort applies to requests on exactly its model', async () => {
  const p = makeProject(ON);
  const env = { STERLING_MAINTENANCE_WORKER: '1', STERLING_MAINTENANCE_WORKER_EFFORT: 'high', STERLING_MAINTENANCE_WORKER_EFFORT_MODEL: 'overpass/agentic-auto' };
  const s = await setup(p.dir, env);
  try {
    childSessions(s);
    const worker = 'sterling-maintenance-worker';
    assert.equal((await request(s, worker, IMPL_LANE, {}, 'ses_worker')).reasoningEffort, 'high', 'the worker route model gets the effort');
    assert.equal((await request(s, worker, IMPL_LANE, { reasoningEffort: 'max' }, 'ses_worker')).reasoningEffort, 'high', 'it replaces an effort already there, as requestEffort does');
    assert.equal(has(await request(s, worker, LANE, {}, 'ses_worker')), false, 'another model gets none');
    assert.equal(has(await request(s, worker, { providerID: 'overpass-agentic', id: 'agentic-auto' }, {}, 'ses_worker')), false, 'another provider with the same id gets none');
    assert.equal(has(await request(s, worker, undefined, {}, 'ses_worker')), false, 'no model, no effort');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
  assert.equal(overpass.workerRequestEffort({ STERLING_MAINTENANCE_WORKER_EFFORT: 'loud', STERLING_MAINTENANCE_WORKER_EFFORT_MODEL: 'overpass/agentic-auto' }, IMPL_LANE), null, 'an unknown effort is never sent');
  assert.equal(overpass.workerRequestEffort({ STERLING_MAINTENANCE_WORKER_EFFORT: 'high' }, IMPL_LANE), null, 'no model in the environment, no effort');
  // Outside the worker child the same variables mean nothing: the per-role path decides.
  const q = makeProject({ mode: 'hobby' });
  const t = await setup(q.dir, { STERLING_MAINTENANCE_WORKER_EFFORT: 'high', STERLING_MAINTENANCE_WORKER_EFFORT_MODEL: 'overpass/agentic-auto' });
  try {
    assert.equal(has(await request(t, 'sterling-maintenance-worker', IMPL_LANE, {}, 'ses_worker')), false);
  } finally {
    await t.cleanup();
    q.cleanup();
  }
});

test('roles: the maintenance worker has its own models entry, which no agent name reaches', () => {
  const p = makeProject({ models: { 'maintenance-worker': { model: 'overpass/agentic-premium', effort: 'high' }, implementor: { model: 'overpass/agentic-auto', effort: 'medium' } } });
  try {
    const res = overpass.projectOverpass(p.dir);
    assert.deepEqual(res.roles['maintenance-worker'], { model: 'overpass/agentic-premium', effort: 'high' });
    assert.deepEqual(res.roles.implementor, { model: 'overpass/agentic-auto', effort: 'medium' });
    assert.equal(res.effective, true);
    // the worker's own agent name is not the role's key, so a request of its session is not routed as a role
    assert.equal(overpass.requestEffort(res, 'sterling-maintenance-worker', { providerID: 'overpass', id: 'agentic-premium' }, { role: 'maintenance-worker' }), null);
    assert.equal(overpass.requestEffort(res, 'sterling/implementor', { providerID: 'overpass', id: 'agentic-auto' }, { role: 'implementor' }), 'medium');
  } finally {
    p.cleanup();
  }
});
test('roles: Plan and the conductor come from models.plan and models.conductor, and only when selected', () => {
  const p = makeProject({ models: { plan: { model: 'overpass/agentic-high' }, implementor: { model: 'overpass/agentic-auto' } } });
  try {
    const res = overpass.projectOverpass(p.dir);
    assert.deepEqual(overpass.desiredOverlay(res), { plan: { model: 'overpass/agentic-high' } }, 'no conductor selection, no conductor entry');
    assert.equal(overpass.expectedSessionModel(res, 'plan'), 'overpass/agentic-high');
    assert.equal(overpass.expectedSessionModel(res, 'sterling/conductor'), null);
    assert.equal(res.roles.plan, undefined, 'Plan is not a dispatch role');
  } finally {
    p.cleanup();
  }
});

test('overlay: a non-tier conductor model writes its effort as the variant; the prior variant comes back on undo', () => {
  const p = makeProject({ models: { conductor: { model: 'openai/gpt-6.1-sol', effort: 'high' } } }, USER_OC);
  try {
    const res = overpass.projectOverpass(p.dir);
    assert.deepEqual(overpass.desiredOverlay(res), { 'sterling/conductor': { model: 'openai/gpt-6.1-sol', variant: 'high' } });
    assert.equal(res.effective, false, 'a direct model is not an Overpass route');
    overpass.convergeOverlay(p.dir, res);
    const conductor = readOc(p.dir).agent['sterling/conductor'];
    assert.deepEqual([conductor.model, conductor.variant], ['openai/gpt-6.1-sol', 'high']);
    assert.equal(JSON.parse(readFileSync(join(p.dir, overpass.OVERLAY_REL), 'utf8')).agent['sterling/conductor'].wroteVariant, 'high', 'recorded so undo knows the variant is Sterling\'s');
    overpass.convergeOverlay(p.dir, resOff);
    assert.deepEqual(readOc(p.dir), USER_OC, 'the user model and variant come back');
    assert.equal(overpass.mismatchNotice(res, 'sterling/conductor', 'anthropic/claude-opus-5-5').includes('pick openai/gpt-6.1-sol in /models'), true, 'the open-session notice covers a direct model too');
  } finally {
    p.cleanup();
  }
});
test('effort: the conductor and Plan selections on a tier keep their effort and send it on their own session requests, on exactly that tier model (item-G review finding 4)', async () => {
  const p = makeProject({ models: { conductor: { model: 'overpass/agentic-conductor', effort: 'high' }, plan: { model: 'overpass/agentic-high', effort: 'max' } } });
  const s = await setup(p.dir);
  try {
    const res = overpass.projectOverpass(p.dir);
    assert.deepEqual(res.conductor, { model: 'overpass/agentic-conductor', tier: true, effort: 'high' });
    assert.deepEqual(res.plan, { model: 'overpass/agentic-high', tier: true, effort: 'max' });
    assert.deepEqual(overpass.desiredOverlay(res), { plan: { model: 'overpass/agentic-high' }, 'sterling/conductor': { model: 'overpass/agentic-conductor' } }, 'a tier effort is never written as a variant');
    assert.equal(overpass.requestEffort(res, 'sterling/conductor', { providerID: 'overpass', id: 'agentic-conductor' }, null), 'high');
    assert.equal(overpass.requestEffort(res, 'plan', { providerID: 'overpass', id: 'agentic-high' }, null), 'max');
    assert.equal((await request(s, 'sterling/conductor', { providerID: 'overpass', id: 'agentic-conductor' }, {}, 'ses_root')).reasoningEffort, 'high');
    assert.equal((await request(s, 'plan', { providerID: 'overpass', id: 'agentic-high' }, {}, 'ses_plan')).reasoningEffort, 'max');
    assert.equal(has(await request(s, 'sterling/conductor', { providerID: 'anthropic', id: 'claude-opus-5-5' }, {}, 'ses_root')), false, 'another model is never touched');
    assert.equal(has(await request(s, 'plan', { providerID: 'overpass', id: 'agentic-conductor' }, {}, 'ses_plan')), false, "Plan never takes the conductor's tier effort");
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});

test('custom agents: an adopted agent dispatched by its served name gets its custom-<slug> model, effort, route and conflict refusal; a renamed source follows (item-G review finding 7)', async () => {
  const { syncCustomAgents } = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'custom-agent-render.mjs')).href);
  const KEY = 'custom-team-scout';
  const src = (name) => `---\nname: ${name}\ndescription: Scouts the team folders\n---\nFind things.\n`;
  const p = makeProject({ models: { [KEY]: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  mkdirSync(join(p.dir, 'agent-sources'), { recursive: true });
  writeFileSync(join(p.dir, 'agent-sources', `${KEY}.md`), src('helper'));
  const render = (config) => syncCustomAgents(p.dir, config, { hosts: ['opencode'] });
  render({ models: { [KEY]: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  assert.ok(existsSync(join(p.dir, '.opencode', 'agents', 'helper.md')));
  let s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({ agent: 'helper' })).args.model, 'openai/gpt-6.1-sol#high', 'the served name resolves through its config key');
    // a tier with an effort: the route is the tier, and the linked lane's request carries the effort
    writeConfig(p.dir, { models: { [KEY]: { model: 'overpass/agentic-premium', effort: 'max' } } });
    childSessions(s);
    assert.equal((await s.dispatch({ agent: 'helper' }, 'call_2')).args.model, 'overpass/agentic-premium');
    await linkedLane(s, 'helper', 'ses_child1', 'call_3');
    assert.equal((await request(s, 'helper', { providerID: 'overpass', id: 'agentic-premium' }, {}, 'ses_child1')).reasoningEffort, 'max');
    // an unresolved two-model legacy entry refuses the dispatch by its served name
    writeConfig(p.dir, { models: { [KEY]: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } });
    await assert.rejects(s.dispatch({ agent: 'helper' }, 'call_4'), /refused this subagent dispatch: .*custom-team-scout/);
  } finally {
    await s.cleanup();
  }
  // rename the source: the served name moves, the old name no longer maps
  writeConfig(p.dir, { models: { [KEY]: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  writeFileSync(join(p.dir, 'agent-sources', `${KEY}.md`), src('aide'));
  render({ models: { [KEY]: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  assert.ok(!existsSync(join(p.dir, '.opencode', 'agents', 'helper.md')));
  s = await setup(p.dir);
  try {
    assert.equal((await s.dispatch({ agent: 'aide' })).args.model, 'openai/gpt-6.1-sol#high');
    assert.equal((await s.dispatch({ agent: 'helper' }, 'call_2')).args.model, undefined, 'the old served name maps to nothing');
  } finally {
    await s.cleanup();
    p.cleanup();
  }
});
