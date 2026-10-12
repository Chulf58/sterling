// Conductor context pressure on OpenCode (GitHub #82, packages/opencode-plugin/src/pressure.mjs):
// fill measured from session.step.* events, H10's soft note and hard warning appended once
// to the root session's next prompt, and a once-per-session note when nothing can be measured.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let server;
let pressure;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  pressure = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'pressure.mjs')).href);
});

const MODEL = { providerID: 'anthropic', id: 'claude-test' };

/** A Sterling project whose config maps claude-test to a 100k window (soft 35%, hard 50%). */
function makeProject(contextWatch = { windows: { 'claude-test': 100_000 }, conductor: { soft_pct: 35, hard_pct: 50 } }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-pressure-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', context_watch: contextWatch }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The plugin context surfaces the pressure path uses: session hooks, session.get, model.list and the event stream. */
function stubCtx(directory, sessions, models) {
  const hooks = { session: {}, tool: {}, permission: {} };
  const queue = [];
  let wake = null;
  const transform = async () => ({ dispose: async () => {} });
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => {
        if (!sessions[sessionID]) throw new Error(`no session ${sessionID}`);
        return { id: sessionID, location: { directory }, ...sessions[sessionID] };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async (name, fn) => void (hooks.permission[name] = fn) },
    command: { transform },
    skill: { transform },
    mcp: { transform },
    model: { list: async () => models },
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

async function setup(dir, { sessions = { ses_1: {} }, models = [] } = {}) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {} });
  const ctx = stubCtx(dir, sessions, models);
  const cleanup = await plugin.setup(ctx);
  // One OpenCode turn of `sessionID`: a step on `model` that ends with `tokens`, then the execution end.
  const turn = async (tokens, { sessionID = 'ses_1', model = MODEL } = {}) => {
    ctx.emit({ type: 'session.step.started', data: { sessionID, assistantMessageID: 'msg_a', agent: 'sterling/conductor', model } });
    ctx.emit({ type: 'session.step.ended', data: { sessionID, assistantMessageID: 'msg_a', finish: 'stop', cost: 0, ...(tokens === undefined ? {} : { tokens }) } });
    ctx.emit({ type: 'session.execution.failed', data: { sessionID, error: { type: 'aborted', message: 'test' } } });
    await plugin.idle();
  };
  // The text the next prompt of `sessionID` carries after the hook ran.
  const prompt = async (text = 'next', sessionID = 'ses_1') => {
    const input = { sessionID, messageID: 'msg_u', prompt: { text }, delivery: 'immediate' };
    await ctx.hooks.session.prompt(input);
    return input.prompt.text;
  };
  return { ctx, plugin, turn, prompt, cleanup };
}

const used = (n) => ({ input: n - 3000, output: 900, reasoning: 0, cache: { read: 2000, write: 1000 } });
// The pressure line(s) a prompt carries; the volatile Sterling context appended beside them (context.mjs) is not counted.
const added = (text) => text.split('\n\n').filter((part) => part.startsWith('Sterling context')).join('\n\n');

test('stepFillTokens sums input + cache.read + cache.write, as H10 sums input and both cache counts', () => {
  assert.equal(pressure.stepFillTokens({ input: 10, output: 99, reasoning: 7, cache: { read: 20, write: 5 } }), 35);
  assert.equal(pressure.stepFillTokens({ input: 0, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }), null, 'an all-zero step is no reading');
  assert.equal(pressure.stepFillTokens(undefined), null);
  assert.equal(pressure.stepFillTokens({ input: 5, cache: {} }), null, 'a missing cache count is no reading');
});

test('below the soft threshold nothing is appended', async () => {
  const p = makeProject();
  const { prompt, turn, cleanup } = await setup(p.dir);
  try {
    assert.equal(added(await prompt()), '', 'nothing has run yet');
    await turn(used(34_000));
    assert.equal(added(await prompt()), '');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('the soft note fires once at soft_pct and is not repeated on later turns', async () => {
  const p = makeProject();
  const { prompt, turn, cleanup } = await setup(p.dir);
  try {
    await turn(used(35_000));
    const line = added(await prompt());
    assert.match(line, /^Sterling context pressure: fill 35\.0% ≥ soft threshold 35% → prefer finishing open work, delegate reads to subagents\. \(once per session\)$/);
    await turn(used(40_000));
    assert.equal(added(await prompt()), '', 'soft is spent for the session');
    await turn(used(42_000));
    assert.equal(added(await prompt()), '');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('the hard warning fires once per session at hard_pct, after the soft note or on its own', async () => {
  const p = makeProject();
  const { prompt, turn, cleanup } = await setup(p.dir, { sessions: { ses_1: {}, ses_2: {} } });
  try {
    await turn(used(36_000));
    assert.match(added(await prompt()), /soft threshold 35%/);
    await turn(used(50_000));
    assert.match(added(await prompt()), /^Sterling context warning: fill 50\.0% of the 100000-token window is past the 50% target → finish the open work and commit it; delegate reads and mechanical work to subagents \(P1\)\. \(once per session\)$/);
    await turn(used(70_000));
    assert.equal(added(await prompt()), '', 'hard is spent for the session');
    // A second session that jumps straight past hard gets the hard warning only, once.
    await turn(used(60_000), { sessionID: 'ses_2' });
    assert.match(added(await prompt('next', 'ses_2')), /^Sterling context warning: fill 60\.0%/);
    await turn(used(65_000), { sessionID: 'ses_2' });
    assert.equal(added(await prompt('next', 'ses_2')), '');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('with no token data the not-measured note is said once per session', async () => {
  const p = makeProject();
  const { prompt, turn, cleanup } = await setup(p.dir);
  try {
    await turn(undefined);
    assert.match(added(await prompt()), /^Sterling context pressure: not measured for this session \(OpenCode reported no token usage for this session's turns to the plugin\), so no soft or hard context-pressure line will appear; watch the session's length yourself\. \(once per session\)$/);
    await turn({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    assert.equal(added(await prompt()), '', 'the note is once per session');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('the line goes into the prompt only, never into the system prompt the context hook rebuilds each request', async () => {
  const p = makeProject();
  const { ctx, prompt, turn, cleanup } = await setup(p.dir);
  try {
    await turn(used(55_000));
    assert.match(added(await prompt()), /Sterling context warning/);
    for (let i = 0; i < 2; i++) {
      const ci = { sessionID: 'ses_1', agent: 'build', system: [{ type: 'text', text: 'base system' }], messages: [], tools: {} };
      await ctx.hooks.session.context(ci);
      const system = ci.system.map((s) => s.text).join('\n');
      assert.doesNotMatch(system, /Sterling context (warning|pressure)/);
    }
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test("a model with no context_watch.windows entry is measured against OpenCode's model list, and the line says so", async () => {
  const p = makeProject({ windows: {}, conductor: { soft_pct: 35, hard_pct: 50 } });
  const models = [{ id: 'gpt-x', modelID: 'gpt-x', providerID: 'openai', limit: { context: 200_000, output: 32_000 } }];
  const { prompt, turn, cleanup } = await setup(p.dir, { models });
  try {
    await turn(used(80_000), { model: { providerID: 'openai', id: 'gpt-x' } });
    assert.match(added(await prompt()), /^Sterling context pressure: fill 40\.0% ≥ soft threshold 35% → .*\. \(window from OpenCode's model list\) \(once per session\)$/);
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('a model in neither the config nor the model list falls back to windows.default and names it', async () => {
  const p = makeProject({ windows: { default: 1_000_000 }, conductor: { soft_pct: 35, hard_pct: 50 } });
  const { prompt, turn, cleanup } = await setup(p.dir);
  try {
    await turn(used(500_000), { model: { providerID: 'x', id: 'unknown' } });
    assert.match(added(await prompt()), /fill 50\.0% of the 1000000-token window .*\(window from context_watch\.windows\.default\) \(once per session\)$/);
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});

test('a child (subagent) session gets no pressure line', async () => {
  const p = makeProject();
  const { prompt, turn, cleanup } = await setup(p.dir, { sessions: { ses_1: {}, ses_child: { parentID: 'ses_1' } } });
  try {
    await turn(used(60_000), { sessionID: 'ses_child' });
    assert.equal(added(await prompt('next', 'ses_child')), '');
  } finally {
    await cleanup?.();
    p.cleanup();
  }
});
