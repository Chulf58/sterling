// The dispatch and output axis on OpenCode 2 (board 16f96c84; decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code):
// H20 mechanism-axis delivery on the subagent, question and codex tools, the H22
// dispatch register arms on the subagent tool, H23 output-axis pointers on read
// and shell results, agent_dispatch events, and settlement on the root session
// only. Driven through a stubbed plugin context, as opencode-plugin.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';

let SterlingStore;
let server;
let readDispatchState;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  ({ readDispatchState } = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'dispatch-register.mjs')).href));
});

const git = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function envelope(type) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

// Vocabulary from h23-output-axis.test.mjs: six invented nouns that dominate the
// record's own terms, so a sentence sharing three of them clears all three axis floors.
const DOMAIN_TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const DOMAIN_STATEMENT =
  'No surface may ever silence the breach countdown alarm: breach countdown widget flywheel widget flywheel ' +
  'ballast klaxon ballast klaxon must remain audible regardless of setup context.';
const MATCHING = 'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';
const UNRELATED = 'The invoice export pipeline now writes a CSV header row before every batch of billing rows.';

const antiPattern = (title, extra = {}) => ({
  ...envelope('anti_pattern'),
  title,
  trigger: DOMAIN_TRIGGER,
  guidance: 'guidance',
  wrong_way: 'wrong way',
  right_way: 'right way text',
  source_evidence: 'evidence',
  basis: 'codebase',
  file_keys: [],
  ...extra,
});
const decision = (title) => ({
  ...envelope('decision'),
  title,
  statement: DOMAIN_STATEMENT,
  alternatives_rejected: [{ option: 'a muted klaxon', reason: 'hides the breach' }],
  rationale: 'rationale',
  file_keys: [],
});

/** A git repo with a Sterling store holding one hazard and one decision on the domain vocabulary. */
function makeProject({ config = {}, records = ['hazard', 'decision'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-axis-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture-proj', ...config }));
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'notes.txt'), `${MATCHING}\n`);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  if (records.includes('hazard')) store.create(antiPattern('ALPHA breach countdown widget flywheel ballast klaxon failure'));
  if (records.includes('decision')) store.create(decision('BRAVO breach countdown widget flywheel ballast klaxon ruling'));
  store.close();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function stubCtx(directory, sessions) {
  const hooks = { session: {}, tool: {} };
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => {
        const s = sessions[sessionID];
        if (s instanceof Error) throw s;
        if (!s) throw new Error(`no session ${sessionID}`);
        return { id: sessionID, ...s };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    skill: { transform: async () => ({ dispose: async () => {} }) },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    // No events are fed: settlement is driven through plugin.handlers.event. A pending
    // promise holds no timer, so a test that fails before its cleanup cannot hang the run.
    event: { subscribe: ({ signal } = {}) => ({ async *[Symbol.asyncIterator]() { await new Promise((r) => signal?.addEventListener('abort', r)); } }) },
  };
}

async function setup(dir, sessions = { ses_root: {} }, deps = {}) {
  const plugin = server.createSterlingServer({ claudeOnPath: () => false, configure: async () => {}, syncSession: async () => {}, now: () => new Date().toISOString(), ...deps });
  const ctx = stubCtx(dir, sessions);
  const cleanup = await plugin.setup(ctx);
  return { plugin, ctx, cleanup };
}

/** Run one tool call through execute.before and execute.after; returns the after input. */
async function call(ctx, { tool, input, sessionID = 'ses_root', status = 'completed', content = 'ok', metadata, id = randomUUID() }) {
  const before = { tool, sessionID, agent: 'build', messageID: 'm1', id, input };
  await ctx.hooks.tool['execute.before'](before);
  const after = { tool, sessionID, agent: 'build', messageID: 'm1', id, input: before.input, status };
  if (status === 'completed') after.result = { content: [{ type: 'text', text: content }], ...(metadata ? { metadata } : {}) };
  else after.error = { type: 'unknown', message: 'failed' };
  await ctx.hooks.tool['execute.after'](after);
  return { before, after };
}
const appended = (after) => (after.result?.content ?? []).slice(1).map((p) => p.text).join('\n\n');
const noticeTexts = (dir) => {
  const p = join(dir, server.NOTICES_REL);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).map((n) => n.text) : [];
};
const stateRecords = (dir) => readDispatchState(dir).records.map((r) => r.record);
/** Every dispatch-state record on disk, live and terminal (readDispatchState lists done files without their records). */
const allStateRecords = (dir) => {
  const d = join(dir, '.sterling', 'transient', 'dispatch-state');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : [];
};
const settledPath = (dir) => join(dir, '.sterling', 'transient', 'git-settled.json');

// --- H20 -------------------------------------------------------------------

test('H20 on the subagent tool: a brief matching a stored hazard gets the mechanism-axis delivery on its result, once per session', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir);
    const brief = `Fix the breach alarm: ${MATCHING}`;
    const { after } = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/implementor', description: 'fix', prompt: brief }, metadata: { sessionID: 'ses_child1', status: 'completed' } });
    const text = appended(after);
    assert.match(text, /STERLING MECHANISM-AXIS DELIVERY \(H20\) — you have just dispatched 'sterling\/implementor'/);
    assert.match(text, /ALPHA breach countdown/, 'the hazard reaches the dispatching session');
    assert.match(text, /matched on: /);
    assert.doesNotMatch(text, /SendMessage/, 'no Claude-only correction route');
    const again = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/implementor', description: 'fix', prompt: brief }, metadata: { sessionID: 'ses_child2', status: 'completed' } });
    assert.doesNotMatch(appended(again.after), /ALPHA breach countdown/, 'a record delivered this session is not repeated');
    const unrelated = await call(ctx, { tool: 'subagent', sessionID: 'ses_other', input: { agent: 'sterling/implementor', description: 'x', prompt: UNRELATED }, metadata: { sessionID: 'ses_child3', status: 'completed' } });
    assert.doesNotMatch(appended(unrelated.after), /H20/, 'silent when nothing matches');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('H20 on the question tool: a ruling match is a post-answer audit and never denies (Claude H20 removed its deny rung, h20-mechanism-axis.mjs:435-441)', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir);
    const questions = [{ question: `Should the breach klaxon stay audible? ${MATCHING}`, header: 'Klaxon', options: [{ label: 'Mute it', description: 'silence the breach countdown widget' }, { label: 'Keep it', description: 'flywheel ballast stays' }] }];
    const before = { tool: 'question', sessionID: 'ses_root', agent: 'build', messageID: 'm1', id: 'q1', input: { questions } };
    await assert.doesNotReject(ctx.hooks.tool['execute.before'](before), 'the question is never denied');
    const after = { ...before, status: 'completed', result: { content: [{ type: 'text', text: 'User has answered your questions' }] } };
    await ctx.hooks.tool['execute.after'](after);
    const text = appended(after);
    assert.match(text, /you have just put a CHOICE TO THE USER/);
    assert.match(text, /POST-ANSWER AUDIT, NOT A GATE/);
    assert.match(text, /DECISIONS for this subject/);
    assert.match(text, /\([0-9a-f]{8}\)/, 'decision lines are name (id8)');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('H20 on the codex tool: the configured model is pinned into the call, a call-site model wins, and the consult carriage rides the result', async () => {
  const p = makeProject({ config: { sparring_partner: { enabled: true, model: 'gpt-test-model' } } });
  try {
    const { ctx, cleanup } = await setup(p.dir);
    const { before, after } = await call(ctx, { tool: 'codex_codex', input: { prompt: `Review this: ${MATCHING}`, sandbox: 'read-only' } });
    assert.equal(before.input.model, 'gpt-test-model', 'an omitted model is filled from config.sparring_partner.model');
    const text = appended(after);
    assert.match(text, /STERLING CODEX MODEL PIN \(H20\) — model "gpt-test-model" injected/);
    assert.match(text, /you are about to CONSULT the sparring partner/);

    const explicit = await call(ctx, { tool: 'codex_codex', sessionID: 'ses_2', input: { prompt: UNRELATED, model: 'gpt-call-site' } });
    assert.equal(explicit.before.input.model, 'gpt-call-site', 'the call-site model is never replaced');
    assert.match(appended(explicit.after), /names model "gpt-call-site" EXPLICITLY/);

    const reply = await call(ctx, { tool: 'codex_codex-reply', sessionID: 'ses_3', input: { prompt: UNRELATED, threadId: 't1' } });
    assert.equal(reply.before.input.model, undefined, 'codex-reply takes no model argument');
    assert.match(appended(reply.after), /this tool takes no model argument/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('H20 delivers nothing on a failed call and keeps the record eligible', async () => {
  const p = makeProject();
  try {
    const { ctx, cleanup } = await setup(p.dir);
    const input = { agent: 'sterling/implementor', description: 'fix', prompt: `Fix it: ${MATCHING}` };
    await call(ctx, { tool: 'subagent', input, status: 'error' });
    const { after } = await call(ctx, { tool: 'subagent', input, metadata: { sessionID: 'ses_c', status: 'completed' } });
    assert.match(appended(after), /ALPHA breach countdown/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

// --- H22 -------------------------------------------------------------------

test('H22 on the subagent tool: Pre records the dispatch, Post binds the child session, a finished child ends it, and a failure is terminal', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, cleanup } = await setup(p.dir);
    const id = 'call_sub_1';
    const before = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm1', id, input: { agent: 'sterling/scout', description: 'look', prompt: 'find src/a.mjs' } };
    await ctx.hooks.tool['execute.before'](before);
    let rec = stateRecords(p.dir).find((r) => r.tool_use_id === id);
    assert.equal(rec?.session_id, 'ses_root');
    assert.equal(rec?.subagent_type, 'sterling/scout');
    assert.ok(!rec.post_binding && !rec.terminal, 'pending until the call returns');
    await ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result: { content: 'done', metadata: { sessionID: 'ses_child', status: 'completed' } } });
    rec = allStateRecords(p.dir).find((r) => r.tool_use_id === id);
    assert.equal(rec?.post_binding?.agent_id, 'ses_child', 'Post binds the child session id');
    assert.ok(rec?.terminal, 'a foreground subagent has finished when its call returns');

    const bg = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm2', id: 'call_sub_bg', input: { agent: 'sterling/scout', description: 'bg', prompt: 'look around', background: true } };
    await ctx.hooks.tool['execute.before'](bg);
    await ctx.hooks.tool['execute.after']({ ...bg, status: 'completed', result: { content: 'started', metadata: { sessionID: 'ses_bg', status: 'running' } } });
    rec = stateRecords(p.dir).find((r) => r.tool_use_id === 'call_sub_bg');
    assert.equal(rec?.post_binding?.agent_id, 'ses_bg');
    assert.ok(!rec.terminal, 'a background subagent stays live after its call returns');

    const failed = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm3', id: 'call_sub_fail', input: { agent: 'sterling/scout', description: 'f', prompt: 'x' } };
    await ctx.hooks.tool['execute.before'](failed);
    await ctx.hooks.tool['execute.after']({ ...failed, status: 'error', error: { type: 'unknown', message: 'boom' } });
    rec = allStateRecords(p.dir).find((r) => r.tool_use_id === 'call_sub_fail');
    assert.ok(rec?.terminal, 'a failed dispatch is terminal');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

// --- H23 -------------------------------------------------------------------

test('H23 on read and shell results: matching output gets one advisory hazard pointer; listings, owned files and unrelated output stay silent', async () => {
  const p = makeProject({ records: ['hazard'] });
  try {
    const s = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
    s.create(antiPattern('CHARLIE breach countdown widget flywheel ballast klaxon failure'));
    s.create({
      ...envelope('feature_article'),
      slug: 'owned-src',
      title: 'owned src',
      what_it_does: 'owns src/a.mjs',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'created' }],
      live_test_refs: [],
    });
    s.close();
    const { ctx, cleanup } = await setup(p.dir);
    const read = await call(ctx, { tool: 'read', input: { path: join(p.dir, 'notes.txt') }, content: MATCHING });
    const text = appended(read.after);
    assert.match(text, /ADVISORY \(not an error\) — STERLING OUTPUT-AXIS DELIVERY \(H23\)/, "beside the H19 delivery for the unowned file");
    assert.equal((text.match(/→ HAZARD anti_pattern/g) ?? []).length, 1, 'one pointer line');
    assert.match(text, /\(\+1 more matched\)/, 'the remainder is disclosed');

    const shell = await call(ctx, { tool: 'shell', input: { command: 'cat build.log' }, content: MATCHING });
    assert.match(appended(shell.after), /H23/, 'the second hazard is pointed at on the next matching output');
    const third = await call(ctx, { tool: 'shell', input: { command: 'cat build.log' }, content: MATCHING });
    assert.doesNotMatch(appended(third.after), /H23/, 'each hazard is pointed at once per session');

    const listing = await call(ctx, { tool: 'shell', sessionID: 'ses_l', input: { command: 'git log --oneline' }, content: MATCHING });
    assert.doesNotMatch(appended(listing.after), /H23/, 'VCS and listing output is skipped');
    const owned = await call(ctx, { tool: 'read', sessionID: 'ses_o', input: { path: 'src/a.mjs' }, content: MATCHING });
    assert.doesNotMatch(appended(owned.after), /H23/, 'a read of owned territory is left to H19');
    const quiet = await call(ctx, { tool: 'shell', sessionID: 'ses_q', input: { command: 'cat x' }, content: UNRELATED });
    assert.doesNotMatch(appended(quiet.after), /H23/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

// --- agent_dispatch events and settlement ----------------------------------

test('a completed research subagent writes an agent_dispatch event, and the research duty then fires at settlement', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    await call(ctx, { tool: 'subagent', id: 'call_r1', input: { agent: 'sterling/researcher', description: 'r', prompt: 'how does settlement work' }, metadata: { sessionID: 'ses_rchild', status: 'completed' } });
    await call(ctx, { tool: 'subagent', id: 'call_r2', input: { agent: 'sterling/scout', description: 's', prompt: 'x' }, status: 'error' });
    const events = JSON.parse(readFileSync(join(p.dir, '.sterling', 'transient', 'session-events.json'), 'utf8'));
    assert.deepEqual(events.map(({ kind, detail, agent_id, tool_use_id }) => ({ kind, detail, agent_id, tool_use_id })), [
      { kind: 'agent_dispatch', detail: 'sterling/researcher', agent_id: 'ses_rchild', tool_use_id: 'call_r1' },
    ], 'completed dispatches only, in the H16 shape');
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.match(noticeTexts(p.dir).join('\n'), /research owed: research ran \(sterling\/researcher\)/, 'the OpenCode agent name counts as the researcher');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('settlement runs only on the root session: a child-session event, a live child in the dispatch register, and an unreadable session are skipped', async () => {
  const p = makeProject({ records: [] });
  try {
    const sessions = { ses_root: {}, ses_child: { parentID: 'ses_root' }, ses_bg: {}, ses_broken: new Error('session store down') };
    const { ctx, plugin, cleanup } = await setup(p.dir, sessions);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    const baseline = readFileSync(settledPath(p.dir), 'utf8');
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 2;\n');
    git(p.dir, ['commit', '-qam', 'change']);

    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'a child session (parentID) does not settle');

    // ses_bg has no parentID in this stub, but the register binds it as a live child.
    const bg = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm', id: 'call_bg', input: { agent: 'sterling/scout', description: 'bg', prompt: 'x', background: true } };
    await ctx.hooks.tool['execute.before'](bg);
    await ctx.hooks.tool['execute.after']({ ...bg, status: 'completed', result: { content: 'started', metadata: { sessionID: 'ses_bg', status: 'running' } } });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_bg' } });
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'a live child in the dispatch register does not settle');
    assert.ok(stateRecords(p.dir).every((r) => r.tool_use_id !== 'call_bg'), 'its execution end closes the background dispatch');

    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_broken' } });
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'a session that cannot be checked does not settle');
    assert.match(noticeTexts(p.dir).join('\n'), /could not check whether session ses_broken is a child.*session store down/s);

    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.notEqual(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'the root session settles');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('settlement does not advance while an OpenCode subagent is live in the dispatch state', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir, { ses_root: {}, ses_bg: { parentID: 'ses_root' } });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    const baseline = readFileSync(settledPath(p.dir), 'utf8');
    const bg = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm', id: 'call_live', input: { agent: 'sterling/implementor', description: 'bg', prompt: 'edit src/a.mjs', background: true } };
    await ctx.hooks.tool['execute.before'](bg);
    await ctx.hooks.tool['execute.after']({ ...bg, status: 'completed', result: { content: 'started', metadata: { sessionID: 'ses_bg', status: 'running' } } });
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 3;\n');
    git(p.dir, ['commit', '-qam', 'change']);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.equal(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'the snapshot holds while the subagent runs');
    assert.match(noticeTexts(p.dir).join('\n'), /not advanced because .*ses_bg/s);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_bg' } });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.notEqual(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'it advances once the child has ended');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});
