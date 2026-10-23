// The OpenCode dispatch model resolver (packages/opencode-plugin/src/dispatch-model.mjs;
// decision subagent-model-choice-on-opencode-conductor-states-dispatch): the MODEL-INTENT
// brief line, the pure resolver over config.models, and the dispatch seam in axis.mjs
// with Overpass off and on. Every fixture is a fresh temp project; nothing reads this
// repo's .sterling/.
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
const OPUS = 'anthropic/claude-opus-5-5#high';
const SOL = 'openai/gpt-6.1-sol#high';
const ASTRA = 'openai/gpt-6-astra#high';
const brief = (intent) => `Do the work.\n${intent ? `MODEL-INTENT: ${intent}\n` : ''}Do not modify the worktree.`;

// ── the intent line ───────────────────────────────────────────────────────────

test('intent: none, hard, review-of and fallback are read from an unfenced line-start marker', () => {
  assert.deepEqual(dm.parseIntent('Just work.'), { kind: 'normal' });
  assert.deepEqual(dm.parseIntent(undefined), { kind: 'normal' });
  assert.deepEqual(dm.parseIntent(brief('hard')), { kind: 'hard' });
  assert.deepEqual(dm.parseIntent(brief(' review-of=openai ')), { kind: 'review-of', author: 'openai' });
  assert.deepEqual(dm.parseIntent(brief('fallback=openai provider not logged in')), { kind: 'fallback', reason: 'openai provider not logged in' });
  assert.deepEqual(dm.parseIntent('Quote: the line MODEL-INTENT: hard is mid-sentence.'), { kind: 'normal' }, 'not a line start');
  assert.deepEqual(dm.parseIntent('Example:\n```\nMODEL-INTENT: hard\n```\n'), { kind: 'normal' }, 'fenced text is quoted, not a marker');
});

test('intent: a repeated line, an unknown value, an empty fallback reason or a bad provider refuses', () => {
  for (const [prompt, why] of [
    [`${brief('hard')}\nMODEL-INTENT: hard`, /it has 2 of them/],
    [brief('hrad'), /its value "hrad" is not one of/],
    [brief('fallback=  '), /the fallback gives no reason/],
    [brief('review-of=Terra Model'), /review-of names "Terra Model", which is not a provider id/],
  ]) {
    assert.throws(() => dm.parseIntent(prompt), (e) => {
      assert.match(e.message, /^Sterling refused this subagent dispatch: its brief carries a MODEL-INTENT line but /);
      assert.match(e.message, why);
      return true;
    }, prompt);
  }
});

// ── the pure resolver ─────────────────────────────────────────────────────────

const ref = (role, intent, config = {}, mode = null) => {
  const r = dm.resolveDispatchModel(role, dm.parseIntent(brief(intent)), config, mode);
  return r?.ref ?? r;
};

test('resolver: the shipped defaults reproduce the models the conductor named before (hobby)', () => {
  assert.equal(ref('implementor', null), SONNET);
  assert.equal(ref('implementor', 'hard'), OPUS, 'hard -> models.implementor.hard_task (Opus 5.5)');
  assert.equal(ref('reviewer', null), SOL);
  assert.equal(ref('sparring', null), ASTRA);
  assert.equal(ref('researcher', null), 'anthropic/claude-sonnet-5-5#medium');
  assert.equal(ref('scout', null), 'anthropic/claude-sonnet-5-5#low');
  assert.equal(ref('librarian', null), 'anthropic/claude-haiku-5-5#low');
  assert.equal(ref('reviewer', 'hard'), SOL, 'a role with no hard_task keeps its normal model');
});

test('resolver: review-of pairs the reviewer off the author family in hobby mode; work mode keeps Sol for every pre-PR review', () => {
  assert.equal(ref('reviewer', 'review-of=openai', {}, 'hobby'), OPUS, 'Terra-written work gets the Opus reviewer');
  assert.equal(ref('reviewer', 'review-of=anthropic', {}, 'hobby'), SOL, 'Claude-written work gets Sol');
  assert.equal(ref('reviewer', 'review-of=openai', {}, 'work'), SOL, 'work mode: Sol-before-PR wins over the pairing');
  assert.equal(ref('reviewer', 'review-of=openai', { mode: 'hobby' }), OPUS, 'mode read from the config when not given');
  assert.equal(ref('reviewer', 'review-of=openai', { mode: 'work' }), SOL);
  const none = dm.resolveDispatchModel('reviewer', { kind: 'review-of', author: 'anthropic' }, { models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'anthropic/claude-opus-5-5' } } }, 'hobby');
  assert.equal(none.ref, OPUS);
  assert.match(none.note, /CROSS-FAMILY NOT POSSIBLE/, 'a pairing that cannot be met says so');
  assert.match(dm.resolveDispatchModel('reviewer', { kind: 'review-of', author: 'openai' }, { mode: 'later' }).problem, /config\.mode is "later"/);
});

test('resolver: fallback runs on the role\'s Claude model with its effort', () => {
  assert.equal(ref('reviewer', 'fallback=openai not logged in'), OPUS);
  assert.equal(ref('sparring', 'fallback=Astra capped'), OPUS);
  assert.equal(ref('implementor', 'fallback=x'), SONNET);
});

test('resolver: config wins over defaults; effort becomes the variant; hard_task takes a Claude id or a provider ref', () => {
  const cfg = { models: {
    implementor: { model: 'claude-sonnet-5-5', effort: 'medium', opencode_model: 'openai/gpt-5.6-terra', hard_task: { model: 'openai/gpt-6.1-sol', effort: 'xhigh' } },
    reviewer: { model: 'claude-opus-5-5', effort: 'low' },
    researcher: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'claude-opus-5-5' } },
  } };
  assert.equal(ref('implementor', null, cfg), 'openai/gpt-5.6-terra#medium', 'Terra as the implementor choice via config');
  assert.equal(ref('implementor', 'hard', cfg), 'openai/gpt-6.1-sol#xhigh', 'hard_task effort wins over the role effort');
  assert.equal(ref('reviewer', null, cfg), 'openai/gpt-6.1-sol#low', 'a live entry written without opencode_model still gets the Sol field default');
  assert.equal(ref('researcher', 'hard', cfg), 'anthropic/claude-opus-5-5#high', 'hard_task without effort takes the role effort');
  const r = dm.resolveDispatchModel('implementor', { kind: 'normal' }, cfg);
  assert.deepEqual({ model: r.model, variant: r.variant }, { model: 'openai/gpt-5.6-terra', variant: 'medium' }, 'model and effort stay separate until composed');
});

test('resolver: an unconfigured agent is left alone; an invalid entry is a problem, never a guess', () => {
  assert.equal(dm.resolveDispatchModel('general', { kind: 'normal' }, {}), null);
  assert.equal(dm.resolveDispatchModel(undefined, { kind: 'normal' }, {}), null);
  for (const [config, why] of [
    [{ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol#high' } } }, /config\.models\.reviewer\.opencode_model: opencode_model must be <provider>\/<model>/],
    [{ models: { implementor: { model: 'claude-sonnet-5-5' } } }, /config\.models\.implementor\.effort/],
    [{ models: 'none' }, /config\.models is "none", not an object/],
  ]) {
    const role = Object.keys(config.models ?? {})[0] ?? 'reviewer';
    assert.match(dm.resolveDispatchModel(typeof config.models === 'string' ? 'reviewer' : role, { kind: 'normal' }, config).problem, why, JSON.stringify(config));
  }
  const badHard = dm.resolveDispatchModel('implementor', { kind: 'hard' }, { models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'not a model' } } } });
  assert.match(badHard.problem, /hard_task\.model is "not a model", neither a Claude model id nor <provider>\/<model>/);
  assert.equal(dm.resolveDispatchModel('implementor', { kind: 'normal' }, { models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'not a model' } } } }).ref, SONNET, 'a bad hard_task only matters on a hard dispatch');
});

// ── the dispatch step (precedence) ────────────────────────────────────────────

test('dispatchModel: an unnamed call gets the resolved model; a named call keeps its pin and is told what config gives', () => {
  const unnamed = dm.dispatchModel({}, { agent: 'sterling/reviewer', prompt: brief('') });
  assert.equal(unnamed.model, SOL);
  assert.match(unnamed.line, /^MODEL: this dispatch runs on openai\/gpt-6\.1-sol#high, from config\.models\.reviewer\.$/);
  const named = dm.dispatchModel({}, { agent: 'sterling/reviewer', prompt: brief('review-of=openai'), model: 'anthropic/claude-fable-5-1' });
  assert.equal(named.model, null, 'a model the call names is never replaced off Overpass');
  assert.match(named.line, /kept anthropic\/claude-fable-5-1 as the call named; .* gives anthropic\/claude-opus-5-5#high/);
  assert.equal(dm.dispatchModel({}, { agent: 'sterling/reviewer', prompt: 'x', model: SOL }).line, null, 'no line when the named model is what config gives');
});

test('dispatchModel: a fallback is announced as a notice, named or not', () => {
  const resolved = dm.dispatchModel({}, { agent: 'sterling/reviewer', prompt: brief('fallback=openai not logged in') });
  assert.equal(resolved.model, OPUS);
  assert.equal(resolved.notice, `Sterling models: fallback dispatch on ${OPUS} (reason: openai not logged in).`);
  const named = dm.dispatchModel({}, { agent: 'sterling/sparring', prompt: brief('fallback=Astra capped'), model: 'anthropic/claude-fable-5-1' });
  assert.equal(named.model, null);
  assert.match(named.notice, /fallback dispatch on anthropic\/claude-fable-5-1 \(reason: Astra capped\)/);
});

test('dispatchModel: invalid config keeps the call\'s model with a loud line and notice; an unconfigured agent with an intent says so', () => {
  const bad = { models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'x#y' } } };
  const named = dm.dispatchModel(bad, { agent: 'sterling/reviewer', prompt: 'x', model: 'anthropic/claude-opus-5-5' });
  assert.equal(named.model, null);
  assert.match(named.line, /^MODEL: config\.models is invalid \(config\.models\.reviewer\.opencode_model: .*\), so this dispatch was not given a model from it and kept anthropic\/claude-opus-5-5 as the call named/);
  assert.match(named.notice, /^Sterling models: config\.models is invalid/);
  const unnamed = dm.dispatchModel(bad, { agent: 'sterling/reviewer', prompt: 'x' });
  assert.equal(unnamed.model, null);
  assert.match(unnamed.line, /runs on the agent's own model/);
  assert.deepEqual(dm.dispatchModel({}, { agent: 'general', prompt: 'x' }), { model: null, line: null });
  assert.match(dm.dispatchModel({}, { agent: 'general', prompt: brief('hard') }).line, /MODEL-INTENT line was not applied: the agent "general" has no config\.models entry/);
});

// ── the seam: axis.mjs through the plugin, Overpass off and on ───────────────

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

test('seam: Overpass off (hobby and work) sets each role\'s model from config.models and reports it on the result', async () => {
  for (const config of [{}, { mode: 'hobby', overpass: { enabled: true } }, { mode: 'work' }]) {
    await withPlugin(config, async ({ dispatch }) => {
      const impl = await dispatch({});
      assert.equal(impl.args.model, SONNET, JSON.stringify(config));
      assert.match(impl.result, /MODEL: this dispatch runs on anthropic\/claude-sonnet-5-5#high/);
      assert.equal((await dispatch({ prompt: brief('hard') })).args.model, OPUS);
      assert.equal((await dispatch({ agent: 'sterling/reviewer', prompt: brief('') })).args.model, SOL);
      assert.equal((await dispatch({ agent: 'sterling/sparring', prompt: brief('') })).args.model, ASTRA);
      const pairing = (await dispatch({ agent: 'sterling/reviewer', prompt: brief('review-of=openai') })).args.model;
      assert.equal(pairing, config.mode === 'work' ? SOL : OPUS, `pairing by mode: ${JSON.stringify(config)}`);
      const kept = await dispatch({ model: 'anthropic/claude-opus-5-5' });
      assert.equal(kept.args.model, 'anthropic/claude-opus-5-5', 'the named model is kept');
      assert.match(kept.result, /MODEL: kept anthropic\/claude-opus-5-5 as the call named/);
    });
  }
});

test('seam: Overpass on keeps the tier and OVERPASS-BYPASS exactly; an intent line is ignored, even a malformed one', async () => {
  await withPlugin({ mode: 'work', overpass: { enabled: true } }, async ({ dispatch }) => {
    const plain = await dispatch({ prompt: brief('hard') });
    assert.equal(plain.args.model, 'overpass/agentic-premium');
    assert.doesNotMatch(plain.result, /MODEL:/);
    assert.equal((await dispatch({ agent: 'sterling/reviewer', prompt: brief('review-of=openai'), model: SOL })).args.model, 'overpass/agentic-high');
    assert.equal((await dispatch({ prompt: brief('hrad') })).args.model, 'overpass/agentic-premium', 'no refusal while Overpass decides');
    const bypass = await dispatch({ model: OPUS, prompt: `${brief('hard')}\nOVERPASS-BYPASS: needs Opus` });
    assert.equal(bypass.args.model, OPUS);
    assert.match(bypass.result, /OVERPASS-BYPASS: Overpass bypassed for this dispatch/);
  });
});

test('seam: a malformed intent line refuses the dispatch off Overpass; invalid config.models keeps the call and notices loud', async () => {
  await withPlugin({}, async ({ ctx }) => {
    const input = { tool: 'subagent', id: 'call_bad', sessionID: 'ses_root', input: { agent: 'sterling/implementor', description: 'd', prompt: brief('hrad') } };
    await assert.rejects(ctx.hooks.tool['execute.before'](input), /^Error: Sterling refused this subagent dispatch: its brief carries a MODEL-INTENT line but its value "hrad"/);
    assert.equal(Object.hasOwn(input.input, 'model'), false, 'a refused call is not touched');
  });
  await withPlugin({ models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra#high' } } }, async ({ dispatch, notices }) => {
    const named = await dispatch({ model: 'anthropic/claude-sonnet-5-5' });
    assert.equal(named.args.model, 'anthropic/claude-sonnet-5-5', 'the dispatch still runs, on its own model');
    assert.match(named.result, /MODEL: config\.models is invalid \(config\.models\.implementor\.opencode_model/);
    assert.match(notices(), /Sterling models: config\.models is invalid/);
  });
});

test('seam: an unreadable config leaves the call alone with the existing UNKNOWN line, as before', async () => {
  await withPlugin('{ "mode": ', async ({ dispatch }) => {
    const unnamed = await dispatch({ prompt: brief('hard') });
    assert.equal(Object.hasOwn(unnamed.args, 'model'), false);
    assert.match(unnamed.result, /Overpass routing UNKNOWN/);
  });
});
