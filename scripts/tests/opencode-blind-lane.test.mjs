// STERLING-DELIVERY: off on OpenCode (decision blind-lane-sterling-delivery-off-brief-line,
// point 4; GitHub #88 slice B). A child session whose brief carries the line gets no store
// records from child staging, the file-touch and shell delivery or the output axis (H23);
// an on sibling and the root session are unchanged; a child whose policy cannot be
// established beside an off lane is held back. The policy map is a cache: a process that
// never saw the child's context hook reads the brief again through ctx.session.context.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-13T12:00:00.000Z';

let SterlingStore;
let server;
let OFF;
let HELD;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  ({ DELIVERY_OFF_NOTICE: OFF, DELIVERY_HELD_BACK_NOTICE: HELD } = await import(pathToFileURL(join(repo, 'scripts', 'hooks', 'lib', 'dispatch-prompt.mjs')).href));
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
const envelope = (type) => ({ id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] });

// The H23 vocabulary of opencode-axis.test.mjs: a sentence sharing three of these nouns clears the axis floors.
const TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const MATCHING = 'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';
const A_CONTENT = 'export const a = 1;\n';

/** A git repo whose store has an article owning src/a.mjs, a hazard on it, and an unscoped H23 hazard. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-blind-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj' }));
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), A_CONTENT);
  writeFileSync(join(dir, 'notes.txt'), `${MATCHING}\n`);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.create({
    ...envelope('feature_article'),
    slug: 'alpha-feature',
    title: 'alpha-feature title',
    what_it_does: 'alpha-feature does the thing',
    intended_behavior: 'x',
    files: [{ path: 'src/a.mjs', role: 'impl' }],
    file_baselines: { 'src/a.mjs': sha(A_CONTENT) },
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
  });
  store.create({ ...envelope('anti_pattern'), slug: 'alpha-hazard', title: 'Hazard alpha-hazard', trigger: 'Editing the thing without care', right_way: 'Edit with care', wrong_way: 'Edit in a hurry', guidance: 'g', source_evidence: 'fixture', severity: 'warn', file_keys: ['src/a.mjs'] });
  store.create({ ...envelope('anti_pattern'), title: 'ECHO breach countdown widget flywheel ballast klaxon failure', trigger: TRIGGER, guidance: 'g', wrong_way: 'w', right_way: 'r', source_evidence: 'e', basis: 'codebase', file_keys: [] });
  store.close();
  for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) git(dir, args);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The plugin context stub: `sessions` answers session.get, `contexts` answers session.context (an Error throws). */
function stubCtx(directory, sessions, contexts) {
  const hooks = { session: {}, tool: {} };
  const answer = (map, sessionID, what) => {
    const s = map[sessionID];
    if (s instanceof Error) throw s;
    if (s === undefined) throw new Error(`no ${what} for ${sessionID}`);
    return s;
  };
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory }, ...answer(sessions, sessionID, 'session') }),
      context: async ({ sessionID }) => answer(contexts, sessionID, 'context'),
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async () => {} },
    command: { transform: async () => ({ dispose: async () => {} }) },
    skill: { transform: async () => ({ dispose: async () => {} }) },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    event: { subscribe: ({ signal } = {}) => ({ async *[Symbol.asyncIterator]() { await new Promise((r) => signal?.addEventListener('abort', r)); } }) },
  };
}

async function setup(dir, sessions, contexts = {}) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, now: () => new Date().toISOString() });
  const ctx = stubCtx(dir, sessions, contexts);
  const cleanup = await plugin.setup(ctx);
  return { ctx, cleanup };
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

/** One child turn: the prompt hook, then the context hook; returns everything the model sees from Sterling. */
async function turn(ctx, sessionID, brief, agent = 'sterling/implementor') {
  const p = { sessionID, messageID: 'msg_turn', prompt: { text: '' }, delivery: 'immediate' };
  await ctx.hooks.session.prompt(p);
  const ci = { sessionID, agent, system: [], messages: brief === null ? [] : [userMsg(brief)], tools: {} };
  await ctx.hooks.session.context(ci);
  return [...ci.system.map((x) => x.text), p.prompt.text].join('\n');
}

/** One tool call through execute.before and execute.after; returns what Sterling appended to the result. */
async function call(ctx, sessionID, tool, input, content = 'ok') {
  const id = randomUUID();
  await ctx.hooks.tool['execute.before']({ tool, sessionID, agent: 'build', messageID: 'm1', id, input });
  const after = { tool, sessionID, agent: 'build', messageID: 'm1', id, input, status: 'completed', result: { content: [{ type: 'text', text: content }] } };
  await ctx.hooks.tool['execute.after'](after);
  return after.result.content
    .slice(1)
    .map((x) => x.text)
    .filter((t) => !t.startsWith('STERLING CONTEXT (added by the Sterling plugin'))
    .join('\n\n');
}

const OFF_BRIEF = 'Edit src/a.mjs so the thing works.\nSTERLING-DELIVERY: off\n';
const ON_BRIEF = 'Edit src/a.mjs so the thing works.\n';
const CHILDREN = { ses_root: {}, ses_off: { parentID: 'ses_root' }, ses_on: { parentID: 'ses_root' } };

test('child staging: an off brief stages no records and says so; an on sibling and the root session are unchanged', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir, CHILDREN);
    const off = await turn(ctx, 'ses_off', OFF_BRIEF);
    assert.ok(off.includes(OFF), 'the off notice is in the staged context');
    assert.doesNotMatch(off, /alpha-feature|alpha-hazard/, 'no record reaches the off child');
    assert.doesNotMatch(off, /STERLING DISPATCH STAGING/);

    const on = await turn(ctx, 'ses_on', ON_BRIEF);
    assert.match(on, /alpha-feature/, 'the on sibling is staged as before');
    assert.ok(!on.includes(OFF) && !on.includes(HELD));

    const root = await turn(ctx, 'ses_root', OFF_BRIEF, 'build');
    assert.ok(!root.includes(OFF) && !root.includes(HELD), 'a root session is never blinded, whatever its first message says');
    assert.match(await call(ctx, 'ses_root', 'read', { path: 'src/a.mjs' }), /alpha-feature/, 'the root still gets file-touch delivery');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a STERLING-DELIVERY line after the 20,000-character staging cap is still honoured', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir, CHILDREN);
    const long = `${ON_BRIEF}${'filler text about src/a.mjs '.repeat(1000)}\nSTERLING-DELIVERY: off`;
    assert.ok(long.indexOf('STERLING-DELIVERY') > 20_000, 'the directive sits past the cap');
    const off = await turn(ctx, 'ses_off', long);
    assert.ok(off.includes(OFF));
    assert.doesNotMatch(off, /alpha-feature|alpha-hazard/);
    assert.equal(await call(ctx, 'ses_off', 'read', { path: 'src/a.mjs' }), '', 'the notice was given at staging, and no record follows');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('tool-time delivery: read, edit, shell and H23 deliver nothing to the off child while its on sibling gets records', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir, CHILDREN);
    await turn(ctx, 'ses_off', OFF_BRIEF);
    // A brief naming no governed file, so staging leaves src/a.mjs for the file-touch delivery.
    await turn(ctx, 'ses_on', 'Tidy the repository.\n');
    for (const [tool, input] of [
      ['read', { path: 'src/a.mjs' }],
      ['edit', { path: join(p.dir, 'src', 'a.mjs') }],
      ['shell', { command: 'cat src/a.mjs' }],
      ['patch', { patchText: '*** Begin Patch\n*** Update File: src/a.mjs\n*** End Patch' }],
    ]) {
      const got = await call(ctx, 'ses_off', tool, input);
      assert.doesNotMatch(got, /alpha-feature|alpha-hazard|STERLING KNOWLEDGE/, `${tool} delivers no record to the off child`);
    }
    const h23 = await call(ctx, 'ses_off', 'read', { path: join(p.dir, 'notes.txt') }, MATCHING);
    assert.doesNotMatch(h23, /H23|ECHO/, 'the output axis is suppressed for the off child');

    assert.match(await call(ctx, 'ses_on', 'read', { path: 'src/a.mjs' }), /alpha-hazard/, 'the on sibling still gets its file-touch delivery');
    assert.match(await call(ctx, 'ses_on', 'shell', { command: 'cat notes.txt' }, MATCHING), /STERLING OUTPUT-AXIS DELIVERY \(H23\)/, 'and its output axis');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('cache miss: a process that never saw the child\'s context reads its brief through session.context and suppresses', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir, CHILDREN, { ses_off: [userMsg(OFF_BRIEF)], ses_on: [userMsg(ON_BRIEF)] });
    const first = await call(ctx, 'ses_off', 'read', { path: 'src/a.mjs' });
    assert.equal(first, OFF, 'the off notice, once, and no record');
    const second = await call(ctx, 'ses_off', 'shell', { command: 'cat src/a.mjs' });
    assert.equal(second, '', 'the notice is not repeated and still no record');
    assert.match(await call(ctx, 'ses_on', 'read', { path: 'src/a.mjs' }), /alpha-feature/, 'a rehydrated on child delivers as before');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('an unreadable brief beside an off sibling is held back; without one it is unchanged', async () => {
  const p = makeProject();
  try {
    const sessions = { ...CHILDREN, ses_x: { parentID: 'ses_root' }, ses_y: { parentID: 'ses_other' } };
    const { ctx, cleanup } = await setup(p.dir, sessions, { ses_x: new Error('context unavailable'), ses_y: new Error('context unavailable') });
    assert.match(await call(ctx, 'ses_y', 'read', { path: 'src/a.mjs' }), /alpha-feature/, 'no off lane exists yet: unchanged');
    await turn(ctx, 'ses_off', OFF_BRIEF);
    const held = await call(ctx, 'ses_x', 'read', { path: 'src/a.mjs' });
    assert.equal(held, HELD, 'held back and disclosed, no record');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('an unreadable brief while the parent has a live off dispatch on record is held back (dispatch state, no cache)', async () => {
  const p = makeProject();
  try {
    const sessions = { ...CHILDREN, ses_kid: { parentID: 'ses_root' } };
    const { ctx, cleanup } = await setup(p.dir, sessions, { ses_kid: new Error('context unavailable') });
    // The root's subagent call is still running (foreground): Pre wrote the off record, no Post has bound a child yet.
    await ctx.hooks.tool['execute.before']({ tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm1', id: 'call_1', input: { agent: 'sterling/implementor', description: 'd', prompt: OFF_BRIEF } });
    assert.equal(await call(ctx, 'ses_kid', 'read', { path: 'src/a.mjs' }), HELD);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a session that cannot be classified is held back only while an off lane may exist', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir, CHILDREN);
    assert.match(await call(ctx, 'ses_unknown1', 'read', { path: 'src/a.mjs' }), /alpha-feature/, 'no off lane: unchanged');
    await turn(ctx, 'ses_off', OFF_BRIEF);
    assert.equal(await call(ctx, 'ses_unknown2', 'read', { path: 'src/a.mjs' }), HELD);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});
