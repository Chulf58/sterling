// The OpenCode dispatch model resolver (packages/opencode-plugin/src/dispatch-model.mjs;
// decisions one-model-per-agent-an-agent-has-a-single-model-not-a-claude and
// settings-redesign-build-shape-one-legacy-to-canonical-config): the routing read from
// config.models, the pure resolver, and the dispatch seam in axis.mjs. Every agent has ONE
// canonical model; there is no MODEL-INTENT line. Every fixture is a fresh temp project;
// nothing reads this repo's .sterling/.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let server;
let dm;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  dm = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'dispatch-model.mjs')).href);
});

const SONNET = 'anthropic/claude-sonnet-5-5#high';
// The plain implementor's default effort is medium (decision overpass-default-effort-per-role-high-for-agentic-auto-roles, v2).
const IMPL_SONNET = 'anthropic/claude-sonnet-5-5#medium';
const OPUS = 'anthropic/claude-opus-5-5#high';
const SOL = 'openai/gpt-6.1-sol#high';
const TERRA = 'openai/gpt-5.6-terra';

// ── the pure resolver ─────────────────────────────────────────────────────────

const ref = (role, config = {}) => {
  const r = dm.resolveDispatchModel(role, dm.projectRouting(config));
  return r?.ref ?? r;
};

test('resolver: the shipped defaults give each role its one canonical model, effort as the variant', () => {
  assert.equal(ref('implementor'), IMPL_SONNET);
  assert.equal(ref('implementor-hard'), OPUS, 'sterling/implementor-hard is its own role');
  assert.equal(ref('reviewer'), OPUS);
  assert.equal(ref('sparring'), OPUS);
  assert.equal(ref('researcher'), 'anthropic/claude-sonnet-5-5#medium');
  assert.equal(ref('scout'), 'anthropic/claude-sonnet-5-5#low');
  assert.equal(ref('librarian'), 'anthropic/claude-haiku-5-5#low');
  assert.equal(ref('preflight'), 'anthropic/claude-sonnet-5-5#low');
});

test('resolver: config wins over defaults; model and effort stay separate until composed; an unset effort sends no variant', () => {
  const cfg = { models: {
    implementor: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
    reviewer: { model: 'openai/gpt-6.1-sol', effort: 'xhigh' },
    scout: { model: 'anthropic/claude-sonnet-5-5' },
  } };
  assert.equal(ref('implementor', cfg), 'openai/gpt-5.6-terra#medium', 'Terra as the implementor choice via config');
  assert.equal(ref('reviewer', cfg), 'openai/gpt-6.1-sol#xhigh');
  assert.equal(ref('scout', cfg), 'anthropic/claude-sonnet-5-5');
  const r = dm.resolveDispatchModel('implementor', dm.projectRouting(cfg));
  assert.deepEqual({ model: r.model, variant: r.variant, overpass: r.overpass }, { model: 'openai/gpt-5.6-terra', variant: 'medium', overpass: false });
  assert.equal(ref('researcher', cfg), 'anthropic/claude-sonnet-5-5#medium', 'a role the config leaves out keeps its default');
});

test('resolver: a legacy file and its canonical form give the same answer (the transform, not a second reader)', () => {
  const legacy = { models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'anthropic/claude-opus-5-5' }, scout: { model: 'claude-sonnet-5-5', effort: 'low' } } };
  const canonical = { models: { reviewer: { model: 'anthropic/claude-opus-5-5', effort: 'high' }, scout: { model: 'anthropic/claude-sonnet-5-5', effort: 'low' } } };
  for (const role of ['reviewer', 'scout', 'implementor']) assert.equal(ref(role, legacy), ref(role, canonical), role);
  assert.equal(ref('reviewer', legacy), OPUS);
});

test('resolver: an unconfigured agent is left alone; an invalid entry is a problem, never a guess', () => {
  assert.equal(dm.resolveDispatchModel('general', dm.projectRouting({})), null);
  assert.equal(dm.resolveDispatchModel(undefined, dm.projectRouting({})), null);
  const bad = dm.resolveDispatchModel('scout', dm.projectRouting({ models: { scout: { model: 'no slash or catalog' } } }));
  assert.match(bad.problem, /config\.models\.scout\.model/);
  assert.match(dm.resolveDispatchModel('reviewer', dm.projectRouting({ models: 'none' })).problem, /config\.models is "none", not an object/);
  assert.equal(dm.resolveDispatchModel('reviewer', dm.projectRouting({ models: { scout: { model: 'no slash or catalog' } } })).ref, OPUS, 'one bad entry does not take another role down');
});

test('resolver: an overpass/<tier> model maps through config.overpass.provider and sends no variant; a bad provider or block throws', () => {
  const tier = dm.resolveDispatchModel('reviewer', dm.projectRouting({ overpass: { provider: 'gw' }, models: { reviewer: { model: 'overpass/agentic-high', effort: 'xhigh' } } }));
  assert.deepEqual({ model: tier.model, variant: tier.variant, ref: tier.ref, overpass: tier.overpass }, { model: 'gw/agentic-high', variant: undefined, ref: 'gw/agentic-high', overpass: true });
  assert.match(tier.note, /Overpass tier overpass\/agentic-high on provider 'gw' with effort xhigh sent as the request's reasoning effort/);
  assert.equal(dm.resolveDispatchModel('scout', dm.projectRouting({ models: { scout: { model: 'overpass/agentic-auto' } } })).ref, 'overpass/agentic-auto', 'the default provider is overpass');
  assert.throws(() => dm.projectRouting({ overpass: { provider: 'a/b' } }), /config\.overpass\.provider is "a\/b"/);
  assert.throws(() => dm.projectRouting({ overpass: 'on' }), /config\.overpass is "on"/);
});

test('resolver: a role with two unresolved legacy models is a conflict; a resume or an unrelated role is not', () => {
  const routing = dm.projectRouting({ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } });
  assert.deepEqual(dm.resolveDispatchModel('reviewer', routing), { conflict: true });
  assert.equal(dm.resolveDispatchModel('scout', routing).ref, 'anthropic/claude-sonnet-5-5#low');
  assert.equal(dm.conflictRefusal('reviewer'), 'Sterling refused this subagent dispatch: role reviewer has two models; run /sterling:update to choose. Nothing was sent, on either model.');
});

// ── the dispatch step (precedence) ────────────────────────────────────────────

test('dispatchModel: an unnamed call gets the resolved model; a named call keeps its pin and is told what config gives', () => {
  const routing = dm.projectRouting({ models: { reviewer: { model: 'openai/gpt-6.1-sol', effort: 'high' } } });
  const unnamed = dm.dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'Review.' });
  assert.equal(unnamed.model, SOL);
  assert.equal(unnamed.resolved, true);
  assert.equal(unnamed.overpass, false);
  assert.match(unnamed.line, /^MODEL: this dispatch runs on openai\/gpt-6\.1-sol#high, from config\.models\.reviewer\.$/);
  const named = dm.dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'Review.', model: 'anthropic/claude-fable-5-1' });
  assert.equal(named.model, null, 'a model the call names is kept, never replaced');
  assert.match(named.line, /kept anthropic\/claude-fable-5-1 as the call named; .* gives openai\/gpt-6\.1-sol#high/);
  assert.equal(dm.dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'x', model: SOL }).line, null, 'no line when the named model is what config gives');
});

test('dispatchModel: MODEL-INTENT and OVERPASS-BYPASS lines are plain text now, never parsed or refused', () => {
  const routing = dm.projectRouting({});
  for (const line of ['MODEL-INTENT: hard', 'MODEL-INTENT: nonsense', 'MODEL-INTENT: fallback=x', 'OVERPASS-BYPASS:']) {
    const pin = dm.dispatchModel(routing, { agent: 'sterling/implementor', prompt: `Do it.\n${line}\n` });
    assert.equal(pin.model, IMPL_SONNET, line);
    assert.equal(pin.notice, undefined, line);
  }
  assert.equal(dm.parseIntent, undefined, 'the intent parser is gone');
});

test('dispatchModel: invalid config keeps the call\'s model with a loud line and notice; an unconfigured agent is left alone', () => {
  const bad = dm.projectRouting({ models: { reviewer: { model: 'no slash or catalog', effort: 'high' } } });
  const named = dm.dispatchModel(bad, { agent: 'sterling/reviewer', prompt: 'x', model: 'anthropic/claude-opus-5-5' });
  assert.equal(named.model, null);
  assert.match(named.line, /^MODEL: config\.models is invalid \(config\.models\.reviewer\.model: .*\), so this dispatch was not given a model from it and kept anthropic\/claude-opus-5-5 as the call named/);
  assert.match(named.notice, /^Sterling models: config\.models is invalid/);
  const unnamed = dm.dispatchModel(bad, { agent: 'sterling/reviewer', prompt: 'x' });
  assert.equal(unnamed.model, null);
  assert.match(unnamed.line, /runs on the agent's own model/);
  assert.deepEqual(dm.dispatchModel(dm.projectRouting({}), { agent: 'general', prompt: 'x' }), { model: null, line: null });
});

test('dispatchModel: a two-model role refuses on either model, a named one included; a resume and other roles are not refused', () => {
  const routing = dm.projectRouting({ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } });
  assert.throws(() => dm.dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'x' }), /^Error: Sterling refused this subagent dispatch: role reviewer has two models; run \/sterling:update to choose\. Nothing was sent, on either model\.$/);
  assert.throws(() => dm.dispatchModel(routing, { agent: 'sterling/reviewer', prompt: 'x', model: SOL }), /two models/);
  assert.equal(dm.dispatchModel(routing, { agent: 'sterling/reviewer', sessionID: 'ses_1', prompt: 'x' }).model, null);
  assert.equal(dm.dispatchModel(routing, { agent: 'sterling/scout', prompt: 'x' }).model, 'anthropic/claude-sonnet-5-5#low');
});

// ── the seam: axis.mjs through the plugin ─────────────────────────────────────

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-dispatch-model-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify({ project_name: 'fixture-proj', ...config }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function stubCtx(directory) {
  const hooks = { session: {}, tool: {}, permission: {} };
  const transform = async () => ({ dispose: async () => {} });
  return {
    hooks,
    location: { directory },
    session: { hook: async (name, fn) => void (hooks.session[name] = fn), get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }) },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async (name, fn) => void (hooks.permission[name] = fn) },
    command: { transform },
    skill: { transform },
    mcp: { transform },
    model: { list: async () => [] },
    event: { subscribe: ({ signal } = {}) => ({ async *[Symbol.asyncIterator]() { while (!signal?.aborted) await new Promise((r) => setTimeout(r, 50)); } }) },
  };
}

async function withPlugin(config, fn) {
  const p = makeProject(config);
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {} });
  const ctx = stubCtx(p.dir);
  const cleanup = await plugin.setup(ctx);
  let n = 0;
  const dispatch = async (args) => {
    const input = { tool: 'subagent', id: `call_${++n}`, sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'fixture lane', prompt: 'Change the fixture file.', ...args } };
    await ctx.hooks.tool['execute.before'](input);
    const after = { ...input, status: 'completed', result: { content: [{ type: 'text', text: 'lane done' }], metadata: {} } };
    await ctx.hooks.tool['execute.after'](after);
    return { args: input.input, result: after.result.content.map((x) => x.text).join('\n') };
  };
  const notices = () => {
    const path = join(p.dir, server.NOTICES_REL);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).map((x) => x.text).join('\n') : '';
  };
  try {
    await fn({ dispatch, ctx, notices });
  } finally {
    await cleanup?.();
    p.cleanup();
  }
}

test('seam: each role\'s model comes from config.models whatever the mode, and is reported on the result', async () => {
  for (const config of [{}, { mode: 'hobby' }, { mode: 'work' }]) {
    await withPlugin(config, async ({ dispatch }) => {
      const impl = await dispatch({});
      assert.equal(impl.args.model, IMPL_SONNET, JSON.stringify(config));
      assert.match(impl.result, /MODEL: this dispatch runs on anthropic\/claude-sonnet-5-5#medium/);
      assert.equal((await dispatch({ agent: 'sterling/implementor-hard' })).args.model, OPUS);
      assert.equal((await dispatch({ agent: 'sterling/reviewer' })).args.model, OPUS);
      assert.equal((await dispatch({ agent: 'sterling/sparring' })).args.model, OPUS);
      const kept = await dispatch({ model: 'anthropic/claude-fable-5-1' });
      assert.equal(kept.args.model, 'anthropic/claude-fable-5-1', 'the named model is kept');
      assert.match(kept.result, /MODEL: kept anthropic\/claude-fable-5-1 as the call named/);
    });
  }
  await withPlugin({ models: { reviewer: { model: 'openai/gpt-6.1-sol', effort: 'high' }, implementor: { model: TERRA, effort: 'medium' } } }, async ({ dispatch }) => {
    assert.equal((await dispatch({ agent: 'sterling/reviewer' })).args.model, SOL);
    assert.equal((await dispatch({})).args.model, `${TERRA}#medium`);
  });
});

test('seam: a brief\'s MODEL-INTENT or OVERPASS-BYPASS line is plain text; it neither refuses nor changes the model', async () => {
  await withPlugin({}, async ({ dispatch }) => {
    for (const [i, line] of ['MODEL-INTENT: hard', 'MODEL-INTENT: hrad', 'MODEL-INTENT: review-of=openai', 'OVERPASS-BYPASS:'].entries()) {
      const out = await dispatch({ prompt: `Do the work.\n${line}\n` }, `call_${i}`);
      assert.equal(out.args.model, IMPL_SONNET, line);
      assert.doesNotMatch(out.result, /OVERPASS-BYPASS|MODEL-INTENT/, line);
    }
    const named = await dispatch({ model: OPUS, prompt: 'Do it.\nOVERPASS-BYPASS: needs Opus\n' }, 'call_n');
    assert.equal(named.args.model, OPUS, 'a model the call names is the pin, marker or not');
  });
});

test('seam: an Overpass tier is sent mapped through the provider and unchecked-for-variant; a named call keeps its own model', async () => {
  await withPlugin({ overpass: { provider: 'overpass' }, models: { implementor: { model: 'overpass/agentic-auto', effort: 'high' } } }, async ({ dispatch }) => {
    const plain = await dispatch({});
    assert.equal(plain.args.model, 'overpass/agentic-auto', 'no variant on a tier');
    assert.match(plain.result, /MODEL: this dispatch runs on overpass\/agentic-auto, from config\.models\.implementor, the Overpass tier overpass\/agentic-auto on provider 'overpass' with effort high/);
    const named = await dispatch({ model: 'anthropic/claude-opus-5-5' }, 'call_2');
    assert.equal(named.args.model, 'anthropic/claude-opus-5-5');
    assert.match(named.result, /MODEL: kept anthropic\/claude-opus-5-5 as the call named/);
  });
});

test('seam: a two-model role refuses the dispatch and leaves the call untouched; invalid config.models keeps the call and notices loud', async () => {
  await withPlugin({ models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra' } } }, async ({ ctx }) => {
    const input = { tool: 'subagent', id: 'call_bad', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: 'x' } };
    await assert.rejects(ctx.hooks.tool['execute.before'](input), /^Error: Sterling refused this subagent dispatch: role implementor has two models; run \/sterling:update to choose\./);
    assert.equal(Object.hasOwn(input.input, 'model'), false, 'a refused call is not touched');
  });
  await withPlugin({ models: { implementor: { model: 'no slash or catalog', effort: 'high' } } }, async ({ dispatch, notices }) => {
    const named = await dispatch({ model: 'anthropic/claude-sonnet-5-5' });
    assert.equal(named.args.model, 'anthropic/claude-sonnet-5-5', 'the dispatch still runs, on its own model');
    assert.match(named.result, /MODEL: config\.models is invalid \(config\.models\.implementor\.model/);
    assert.match(notices(), /Sterling models: config\.models is invalid/);
  });
});

test('seam: an unreadable config leaves the call alone with the UNKNOWN line', async () => {
  await withPlugin('{ "mode": ', async ({ dispatch }) => {
    const unnamed = await dispatch({});
    assert.equal(Object.hasOwn(unnamed.args, 'model'), false);
    assert.match(unnamed.result, /Model routing UNKNOWN: \.sterling\/config\.json could not be read/);
  });
});

// ── the variant guard (user-ruled 2026-10-23, "Send for all, verify live") ──

const LIST = [
  { providerID: 'openai', id: 'gpt-6.1-sol', variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] },
  { providerID: 'anthropic', id: 'claude-opus-5-5', variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
  { providerID: 'anthropic', id: 'claude-haiku-5-5', variants: [] },
  { providerID: 'anthropic', modelID: 'claude-sonnet-5-5', id: 'claude-sonnet-5-5', variants: ['low', 'high'] },
];

test('variant guard: a listed variant is kept; an unlisted one is dropped with a note; an unlisted model or unreadable list is not checked', () => {
  assert.deepEqual(dm.checkVariant(SOL, LIST), { model: SOL, note: null });
  assert.deepEqual(dm.checkVariant('anthropic/claude-sonnet-5-5#high', LIST), { model: 'anthropic/claude-sonnet-5-5#high', note: null }, 'string variants count');
  const haiku = dm.checkVariant('anthropic/claude-haiku-5-5#low', LIST);
  assert.equal(haiku.model, 'anthropic/claude-haiku-5-5');
  assert.match(haiku.note, /variant low dropped: OpenCode lists no variants for anthropic\/claude-haiku-5-5/);
  assert.match(dm.checkVariant('anthropic/claude-sonnet-5-5#medium', LIST).note, /lists only low, high/);
  assert.deepEqual(dm.checkVariant('openai/gpt-6-astra#high', LIST), { model: 'openai/gpt-6-astra#high', note: "(variant high not checked: openai/gpt-6-astra is not in OpenCode's model list)" });
  assert.match(dm.checkVariant(SOL, null, new Error('boom')).note, /not checked: OpenCode's model list could not be read: boom/);
  assert.deepEqual(dm.checkVariant('anthropic/claude-opus-5-5', LIST), { model: 'anthropic/claude-opus-5-5', note: null }, 'no variant, nothing to check');
});

test('seam: the plugin checks a resolved variant against ctx.model.list and drops one the model lacks', async () => {
  const p = makeProject({});
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {} });
  const ctx = stubCtx(p.dir);
  // The real 2.1.2 shape: ctx.model.list() resolves to { location, data: [Model.Info] }, not an array.
  ctx.model.list = async () => ({ location: { directory: p.dir }, data: LIST });
  const cleanup = await plugin.setup(ctx);
  try {
    const run = async (args, id) => {
      const input = { tool: 'subagent', id, sessionID: 'ses_root', input: { description: 'd', prompt: 'p', ...args } };
      await ctx.hooks.tool['execute.before'](input);
      const after = { ...input, status: 'completed', result: { content: [{ type: 'text', text: 'done' }], metadata: {} } };
      await ctx.hooks.tool['execute.after'](after);
      return { model: input.input.model, text: after.result.content.map((x) => x.text).join('\n') };
    };
    const lib = await run({ agent: 'sterling/librarian' }, 'c1');
    assert.equal(lib.model, 'anthropic/claude-haiku-5-5', 'the variant is dropped, the dispatch still runs');
    assert.match(lib.text, /variant low dropped/);
    const rev = await run({ agent: 'sterling/reviewer' }, 'c2');
    assert.equal(rev.model, OPUS);
    assert.doesNotMatch(rev.text, /variant/);
    const named = await run({ agent: 'sterling/librarian', model: 'anthropic/claude-haiku-5-5#low' }, 'c3');
    assert.equal(named.model, 'anthropic/claude-haiku-5-5#low', 'a model the call names is not touched by the guard');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('seam: a model list that never settles cannot stall the dispatch; the variant is kept and marked not checked (Sol review, MEDIUM)', async () => {
  const p = makeProject({});
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {} });
  const ctx = stubCtx(p.dir);
  ctx.model.list = () => new Promise(() => {});
  const cleanup = await plugin.setup(ctx);
  try {
    const input = { tool: 'subagent', id: 'c_hang', sessionID: 'ses_root', input: { agent: 'sterling/reviewer', description: 'd', prompt: 'p' } };
    const started = Date.now();
    await ctx.hooks.tool['execute.before'](input);
    const waited = Date.now() - started;
    assert.ok(waited < 5000, `the dispatch went ahead after ${waited} ms`);
    assert.equal(input.input.model, OPUS);
    const after = { ...input, status: 'completed', result: { content: [{ type: 'text', text: 'done' }], metadata: {} } };
    await ctx.hooks.tool['execute.after'](after);
    assert.match(after.result.content.map((x) => x.text).join('\n'), /variant high not checked: OpenCode's model list could not be read: the model list timed out after 2000 ms/);
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('model list shape: modelListItems unwraps { location, data } and accepts a bare array; anything else is left for the guard to refuse', () => {
  assert.deepEqual(dm.modelListItems({ location: {}, data: LIST }), LIST);
  assert.deepEqual(dm.modelListItems(LIST), LIST);
  assert.equal(dm.modelListItems(undefined), undefined);
  assert.deepEqual(dm.modelListItems({ location: {} }), { location: {} });
  assert.match(dm.checkVariant(SOL, dm.modelListItems({ location: {} })).note, /could not be read/);
  assert.deepEqual(dm.checkVariant(SOL, dm.modelListItems({ location: {}, data: LIST })), { model: SOL, note: null });
});

test('seam: a bare-array ctx.model.list still works', async () => {
  const p = makeProject({});
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, env: {} });
  const ctx = stubCtx(p.dir);
  ctx.model.list = async () => LIST;
  const cleanup = await plugin.setup(ctx);
  try {
    const input = { tool: 'subagent', id: 'c_arr', sessionID: 'ses_root', input: { agent: 'sterling/librarian', description: 'd', prompt: 'p' } };
    await ctx.hooks.tool['execute.before'](input);
    assert.equal(input.input.model, 'anthropic/claude-haiku-5-5', 'the unlisted variant is dropped');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

// ── resuming a subagent session (board 25acfbe4) ─────────────────────────────

test('resume: a call with a sessionID keeps the session\'s own model; a named model is the caller\'s pin', () => {
  const routing = dm.projectRouting({});
  const plain = dm.dispatchModel(routing, { agent: 'sterling/implementor', sessionID: 'ses_warm', prompt: 'Continue.' });
  assert.deepEqual(plain, { model: null, line: 'MODEL: resumed session keeps its own model (config.models is not applied).' });
  assert.deepEqual(dm.dispatchModel(routing, { agent: 'sterling/implementor', sessionID: 'ses_warm', prompt: 'Continue.', model: OPUS }), { model: null, line: null });
  assert.equal(dm.dispatchModel(routing, { agent: 'sterling/implementor', sessionID: '', prompt: 'x' }).model, IMPL_SONNET, 'an empty sessionID is a new dispatch');
});

test('seam: resuming leaves the model unset, in every mode and on a tier too', async () => {
  for (const config of [{}, { mode: 'work' }, { models: { implementor: { model: 'overpass/agentic-auto' } } }]) {
    await withPlugin(config, async ({ dispatch }) => {
      const resumed = await dispatch({ sessionID: 'ses_warm' });
      assert.equal(Object.hasOwn(resumed.args, 'model'), false, JSON.stringify(config));
      assert.match(resumed.result, /MODEL: resumed session keeps its own model/);
    });
  }
});

// GitHub #310 review round: a config written by v0.19.155 may carry an exact agy_model id. The routing is
// read through the legacy-to-canonical transform, so the stale value must not read as an invalid config.
test('legacy agy_model ids in config.models resolve exactly as a clean config', () => {
  const entry = (opencode, agy) => ({ model: 'claude-opus-5-5', effort: 'high', opencode_model: opencode, agy_model: agy });
  const legacy = { models: { reviewer: entry('anthropic/claude-opus-5-5', 'gemini-4-hydrogen-high'), sparring: entry('anthropic/claude-opus-5-5', 'claude-opus-5-5-high') } };
  const clean = { models: { reviewer: entry('anthropic/claude-opus-5-5', undefined), sparring: entry('anthropic/claude-opus-5-5', undefined) } };
  for (const role of ['reviewer', 'sparring']) assert.equal(ref(role, legacy), ref(role, clean), role);
  assert.equal(ref('reviewer', legacy), OPUS);
  const call = dm.dispatchModel(dm.projectRouting(legacy), { agent: 'sterling/reviewer', prompt: 'x' });
  assert.equal(call.model, OPUS, 'the dispatch gets its model, with no invalid-config notice');
  assert.equal(call.notice ?? null, null);
});
