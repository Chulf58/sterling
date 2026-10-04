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
let createDomain;
let server;
let readDispatchState;
before(async () => {
  ({ SterlingStore, createDomain } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
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
        // 2.0.22: a session carries its location; settlement handles only this location's sessions.
        return { id: sessionID, location: { directory }, ...s };
      },
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    permission: { hook: async () => {} },
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

test('H20 and H23 read the mounted domains through the subject fan, with the plugin opener', async () => {
  const domainDb = join(tmpdir(), `sterling-oc-axis-domain-${randomUUID()}`, 'sterling.db');
  const p = makeProject({ records: [], config: { stack_tags: ['alpha'], domain_paths: { alpha: domainDb } } });
  try {
    mkdirSync(dirname(domainDb), { recursive: true });
    createDomain('alpha', 'Alpha reactor facts', domainDb);
    const d = new SterlingStore(domainDb);
    d.create({ ...antiPattern('DELTA domain breach countdown widget flywheel ballast klaxon failure'), scope: 'domain:alpha' });
    d.close();
    const opened = [];
    const { ctx, cleanup } = await setup(p.dir, { ses_root: {} }, { openStore: (dbPath) => (opened.push(dbPath), new SterlingStore(dbPath)) });
    const { after } = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/implementor', description: 'fix', prompt: `Fix the breach alarm: ${MATCHING}` }, metadata: { sessionID: 'ses_child1', status: 'completed' } });
    assert.match(appended(after), /DELTA domain breach countdown/, 'H20 delivers the domain hazard');
    const read = await call(ctx, { tool: 'read', sessionID: 'ses_other', input: { path: join(p.dir, 'notes.txt') }, content: MATCHING });
    assert.match(appended(read.after), /→ HAZARD anti_pattern 'DELTA domain breach countdown/, 'H23 points at the domain hazard');
    assert.ok(opened.includes(domainDb), "the domain store was opened through the plugin's opener");
    await cleanup?.();
  } finally {
    p.cleanup();
    rmSync(dirname(domainDb), { recursive: true, force: true });
  }
});

test('a configured domain file that is not SQLite: H20 and H23 still deliver the project hazard, each with one stderr line', async () => {
  // Task-end review 2026-10-03: a bad domain made openSubjectFan throw, so the project hazard was lost too.
  const domainDb = join(tmpdir(), `sterling-oc-axis-junk-${randomUUID()}`, 'sterling.db');
  const p = makeProject({ records: ['hazard'], config: { stack_tags: ['junk'], domain_paths: { junk: domainDb } } });
  const writes = [];
  const realWrite = process.stderr.write;
  try {
    mkdirSync(dirname(domainDb), { recursive: true });
    writeFileSync(domainDb, 'this is not a sqlite database, just text '.repeat(50));
    const { ctx, cleanup } = await setup(p.dir);
    process.stderr.write = (chunk, ...rest) => (String(chunk).includes('DEGRADED subject fan') ? (writes.push(String(chunk)), true) : realWrite.call(process.stderr, chunk, ...rest));
    const { after } = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/implementor', description: 'fix', prompt: `Fix the breach alarm: ${MATCHING}` }, metadata: { sessionID: 'ses_child1', status: 'completed' } });
    const read = await call(ctx, { tool: 'read', sessionID: 'ses_other', input: { path: join(p.dir, 'notes.txt') }, content: MATCHING });
    process.stderr.write = realWrite;
    assert.match(appended(after), /ALPHA breach countdown widget flywheel ballast klaxon failure/, 'H20 still delivers the project hazard');
    assert.match(appended(read.after), /→ HAZARD anti_pattern 'ALPHA breach countdown/, 'H23 still points at the project hazard');
    assert.equal(writes.filter((w) => /^H20: DEGRADED subject fan: domain 'junk'/.test(w)).length, 1, writes.join(''));
    assert.equal(writes.filter((w) => /^H23: DEGRADED subject fan: domain 'junk'/.test(w)).length, 1, writes.join(''));
    await cleanup?.();
  } finally {
    process.stderr.write = realWrite;
    p.cleanup();
    rmSync(dirname(domainDb), { recursive: true, force: true });
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
    // The session's directory is read first (finding opencode-execution-events-carry-no-location-cross-project-settlement-october-2026), so that read is what fails.
    assert.match(noticeTexts(p.dir).join('\n'), /could not read which project session ses_broken belongs to.*session store down/s);

    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.notEqual(readFileSync(settledPath(p.dir), 'utf8'), baseline, 'the root session settles');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a background child whose session.get throws still closes its dispatch and raises no settlement-skipped notice', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir, { ses_root: {}, ses_bg: new Error('session store down') });
    const bg = { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm', id: 'call_bg', input: { agent: 'sterling/scout', description: 'bg', prompt: 'x', background: true } };
    await ctx.hooks.tool['execute.before'](bg);
    await ctx.hooks.tool['execute.after']({ ...bg, status: 'completed', result: { content: 'started', metadata: { sessionID: 'ses_bg', status: 'running' } } });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_bg' } });
    assert.ok(stateRecords(p.dir).every((r) => r.tool_use_id !== 'call_bg'), 'the register owns the child, so its end closes the dispatch without a directory lookup');
    assert.doesNotMatch(noticeTexts(p.dir).join('\n'), /settlement skipped/, 'no settlement-skipped notice for a child session');
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

// --- review-fix round: background dispatch ends, agent names, register rounds -

const registerRows = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'dispatch-register.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const bgCall = (id, child, prompt = 'edit src/a.mjs', agent = 'sterling/implementor') => ({
  before: { tool: 'subagent', sessionID: 'ses_root', agent: 'build', messageID: 'm', id, input: { agent, description: 'bg', prompt, background: true } },
  result: { content: 'started', metadata: { sessionID: child, status: 'running' } },
});

test('a background child dispatch also ends when its execution fails or is interrupted', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir, { ses_root: {}, ses_f: { parentID: 'ses_root' }, ses_i: { parentID: 'ses_root' } });
    for (const [id, child] of [['call_f', 'ses_f'], ['call_i', 'ses_i']]) {
      const { before, result } = bgCall(id, child);
      await ctx.hooks.tool['execute.before'](before);
      await ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result });
    }
    await plugin.handlers.event({ type: 'session.execution.failed', data: { sessionID: 'ses_f' } });
    await plugin.handlers.event({ type: 'session.execution.interrupted', data: { sessionID: 'ses_i' } });
    assert.deepEqual(stateRecords(p.dir).filter((r) => !r.terminal).map((r) => r.tool_use_id), [], 'both background dispatches ended');
    assert.ok(registerRows(p.dir).every((r) => r.ended), 'their register rounds ended');
    assert.equal(server.liveDispatch(p.dir).live, false);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a background child that ends before its subagent call returns is ended when the call binds it', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir, { ses_root: {}, ses_fast: { parentID: 'ses_root' } });
    const { before, result } = bgCall('call_fast', 'ses_fast');
    await ctx.hooks.tool['execute.before'](before);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fast' } });
    await ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result });
    assert.deepEqual(stateRecords(p.dir).filter((r) => !r.terminal).map((r) => r.tool_use_id), [], 'the late bind ends the dispatch');
    assert.ok(registerRows(p.dir).every((r) => r.ended), 'and its register round');
    assert.equal(server.liveDispatch(p.dir).live, false, 'nothing holds settlement');

    // A resumed child (same session id, a new call) ended earlier is NOT ended by that old end.
    const again = bgCall('call_fast_2', 'ses_fast');
    await ctx.hooks.tool['execute.before'](again.before);
    await ctx.hooks.tool['execute.after']({ ...again.before, status: 'completed', result: again.result });
    assert.ok(stateRecords(p.dir).some((r) => r.tool_use_id === 'call_fast_2' && !r.terminal), 'an end from before this call does not end it');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the first root context of a process sweeps dispatch records a dead process left live, and the hold notice names the remedy', async () => {
  const p = makeProject({ records: [] });
  try {
    const first = await setup(p.dir, { ses_root: {}, ses_dead: { parentID: 'ses_root' } });
    await first.plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    const { before, result } = bgCall('call_dead', 'ses_dead');
    await first.ctx.hooks.tool['execute.before'](before);
    await first.ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result });
    writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 5;\n');
    git(p.dir, ['commit', '-qam', 'change']);
    await first.plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.match(noticeTexts(p.dir).join('\n'), /not advanced because[^\n]*restart OpenCode/, 'the hold notice names the manual remedy');
    await first.cleanup?.();

    // A new process: its child context does not sweep, its first root context does.
    const second = await setup(p.dir, { ses_root2: {}, ses_kid: { parentID: 'ses_root2' } });
    await second.ctx.hooks.session.context({ sessionID: 'ses_kid', agent: 'sterling/scout', system: [], messages: [], tools: {} });
    assert.ok(stateRecords(p.dir).some((r) => r.tool_use_id === 'call_dead' && !r.terminal), 'a child context does not sweep');
    const root2 = { sessionID: 'ses_root2', agent: 'build', system: [], messages: [], tools: {} };
    await second.ctx.hooks.session.context(root2);
    assert.ok(stateRecords(p.dir).every((r) => r.terminal), 'the stale record is terminal after the sweep');
    assert.match(root2.system.map((x) => x.text).join('\n'), /DEAD-DISPATCH RESIDUE \(OpenCode process start\): 1 dispatch record/, 'the sweep says how many records it ended');
    assert.equal(existsSync(join(p.dir, '.sterling', 'transient', 'dispatch-register.json')), false, 'the register is cleared, as H1 clears it');
    assert.equal(server.liveDispatch(p.dir).live, false);
    await second.cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('a live background implementor registers a round from its brief, and a second implementor brief on the same file gets DISPATCH OVERLAP', async () => {
  const p = makeProject({ records: [] });
  try {
    const { ctx, cleanup } = await setup(p.dir, { ses_root: {}, ses_impl: { parentID: 'ses_root' } });
    const { before, result } = bgCall('call_impl', 'ses_impl', 'Implement the change in src/a.mjs and add tests.');
    await ctx.hooks.tool['execute.before'](before);
    await ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result });
    const row = registerRows(p.dir).find((r) => r.agent_id === 'ses_impl');
    assert.deepEqual(row?.files, ['src/a.mjs']);
    assert.equal(row?.agent_type, 'implementor', 'the register holds the role, not the sterling/ name');
    assert.equal(row?.session_id, 'ses_root');
    assert.ok(!row.ended);

    const { after } = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/implementor', description: 'second', prompt: 'Refactor src/a.mjs.' }, metadata: { sessionID: 'ses_impl2', status: 'completed' } });
    assert.match(appended(after), /DISPATCH OVERLAP \(advisory\)[^\n]*src\/a\.mjs ← implementor:ses_impl/);

    const scout = await call(ctx, { tool: 'subagent', input: { agent: 'sterling/scout', description: 'look', prompt: 'Map who calls src/a.mjs.' }, metadata: { sessionID: 'ses_sc', status: 'completed' } });
    assert.doesNotMatch(appended(scout.after), /DISPATCH OVERLAP/, 'a sterling/scout brief is read-only once its name is normalised');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('the root-session gate fails closed when session.get resolves to null or a different session', async () => {
  const { rootSessionGate } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'dispatch.mjs')).href);
  const p = makeProject({ records: [] });
  try {
    for (const info of [null, {}, { id: 'ses_other' }]) {
      const gate = await rootSessionGate(p.dir, { session: { get: async () => info }, sessionID: 'ses_x', parents: new Map() });
      assert.equal(gate.settle, false, JSON.stringify(info));
      assert.match(gate.why ?? '', /ses_x/, 'the why names the session it could not confirm');
    }
    assert.deepEqual(await rootSessionGate(p.dir, { session: { get: async () => ({ id: 'ses_x' }) }, sessionID: 'ses_x', parents: new Map() }), { settle: true });
  } finally {
    p.cleanup();
  }
});

test('a torn notices file cannot reject the event handler, so the subscription loop survives', async () => {
  const p = makeProject({ records: [] });
  try {
    const { plugin, cleanup } = await setup(p.dir, { ses_root: {} });
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(p.dir, server.NOTICES_REL), '[{"torn"');
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_unknown' } });
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /settle skipped: .*session ses_unknown .*could not read which directory the session belongs to/);
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

// A record with scope domain:<name> lives in that domain's own store, so the
// settlement duty reads cover the project store and every mounted domain store
// (GitHub issue #12; the H10 side is h10-research-duty-domain-finding.test.mjs).
function makeDomainProject({ domain = 'store' } = {}) {
  const domainDb = join(tmpdir(), `sterling-oc-duty-domain-${randomUUID()}`, 'sterling.db');
  const p = makeProject({ records: [], config: { stack_tags: ['alpha'], domain_paths: { alpha: domainDb } } });
  if (domain !== 'missing') mkdirSync(dirname(domainDb), { recursive: true });
  if (domain === 'store') createDomain('alpha', 'Alpha reactor facts', domainDb);
  if (domain === 'junk') writeFileSync(domainDb, 'this is not a sqlite database, just text '.repeat(50));
  // `logged` is the line this project's MCP server adds to the domain-write
  // ledger after a domain-scoped write; a record written with logged:false is
  // one another project put in the shared store (decision
  // domain-record-duty-credit-comes-from-a-per-project-write-ledger).
  const ledgerPath = join(p.dir, '.sterling', 'transient', 'knowledge-writes.json');
  const writeDomain = (record, { logged = true } = {}) => {
    const at = new Date().toISOString();
    const d = new SterlingStore(domainDb);
    const made = d.create({ ...envelope(record.type), ...record, created_at: at, updated_at: at, scope: 'domain:alpha' });
    d.close();
    if (!logged) return;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lines = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
    writeFileSync(ledgerPath, JSON.stringify([...lines, { id: made.id, type: made.type, at }]));
  };
  return { ...p, domainDb, ledgerPath, writeDomain, cleanup: () => (p.cleanup(), rmSync(dirname(domainDb), { recursive: true, force: true })) };
}

/** Settle, edit src/a.mjs, settle again: the notices the edit's settlement raised. */
async function settleAnEdit(p, deps = {}, beforeSecondSettle = () => {}) {
  const { plugin, cleanup } = await setup(p.dir, { ses_root: {} }, deps);
  await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
  writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 2;\n');
  beforeSecondSettle();
  await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
  await cleanup?.();
  return noticeTexts(p.dir).join('\n');
}

test('settlement: a mounted domain with no store on disk is skipped and never created', async () => {
  const p = makeDomainProject({ domain: 'missing' });
  try {
    const text = await settleAnEdit(p);
    assert.match(text, /capture owed: 1 changed file/, 'nothing paid the duty');
    assert.doesNotMatch(text, /could not be read|settlement failed/, 'a missing domain store is not a failure');
    assert.equal(existsSync(p.domainDb), false, 'the domain store was not created');
    assert.equal(existsSync(dirname(p.domainDb)), false, 'nor its directory');
  } finally {
    p.cleanup();
  }
});

test('settlement: an unreadable domain store raises its own notice and pays nothing', async () => {
  const p = makeDomainProject({ domain: 'junk' });
  try {
    const text = await settleAnEdit(p);
    assert.match(text, /capture owed: 1 changed file/, 'the unreadable domain pays nothing');
    assert.match(text, /Sterling settlement: domain store\(s\) 'alpha' \(.+\) could not be read; a record written there was not counted toward the capture and research duties\./);
    assert.doesNotMatch(text, /settlement failed/, 'the settlement itself completes');
  } finally {
    p.cleanup();
  }
});

test('settlement: a domain store whose close throws does not fail the settlement or lose the capture it holds', async () => {
  const p = makeDomainProject();
  try {
    let domainCloses = 0;
    const openStore = (dbPath) => {
      const real = new SterlingStore(dbPath);
      if (dbPath !== p.domainDb) return real;
      return { query: (q) => real.query(q), close: () => (real.close(), (domainCloses += 1), assert.fail('domain close boom')) };
    };
    const text = await settleAnEdit(p, { openStore }, () => p.writeDomain({ type: 'decision', title: 'a is two', statement: 's', alternatives_rejected: [], rationale: 'r' }));
    assert.ok(domainCloses >= 1, 'the domain store was closed');
    assert.doesNotMatch(text, /settlement failed/, 'CLOSE-ERROR-FAILS-SETTLEMENT SHAPE if this matches');
    assert.doesNotMatch(text, /capture owed/, 'the decision read before the close still pays the duty');
    assert.match(readFileSync(join(p.dir, server.LOG_REL), 'utf8'), /settle: domain store 'alpha' did not close cleanly \(domain close boom\)/, 'the close error is logged, not dropped');
  } finally {
    p.cleanup();
  }
});

test('settlement: a domain-scoped research_finding written after the research dispatch pays the research duty', async () => {
  const p = makeDomainProject();
  try {
    const { ctx, plugin, cleanup } = await setup(p.dir);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    await call(ctx, { tool: 'subagent', id: 'call_r1', input: { agent: 'sterling/researcher', description: 'r', prompt: 'how does settlement work' }, metadata: { sessionID: 'ses_rchild', status: 'completed' } });
    p.writeDomain({ type: 'research_finding', question: 'how does settlement work?', answer: 'per execution', source_urls: ['https://example.com/x'], source_date: '2026-10-02', capture_date: '2026-10-02' });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.doesNotMatch(noticeTexts(p.dir).join('\n'), /research owed/, 'the finding in the mounted domain store pays the duty');
    await cleanup?.();
  } finally {
    p.cleanup();
  }
});

test('settlement: a domain-scoped decision written after the edit pays the capture duty; without one the duty is raised', async () => {
  for (const captured of [false, true]) {
    const p = makeDomainProject();
    try {
      const { plugin, cleanup } = await setup(p.dir);
      await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
      writeFileSync(join(p.dir, 'src', 'a.mjs'), 'export const a = 2;\n');
      if (captured) p.writeDomain({ type: 'decision', title: 'a is two', statement: 's', alternatives_rejected: [], rationale: 'r' });
      await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
      const text = noticeTexts(p.dir).join('\n');
      if (captured) assert.doesNotMatch(text, /capture owed/, 'the decision in the mounted domain store pays the duty');
      else assert.match(text, /capture owed: 1 changed file/, 'control: the edit raises the duty');
      await cleanup?.();
    } finally {
      p.cleanup();
    }
  }
});

test('settlement: a domain record this project did not log pays neither duty, and settlement never clears the ledger', async () => {
  const decision = { type: 'decision', title: 'a is two', statement: 's', alternatives_rejected: [], rationale: 'r' };
  const foreign = makeDomainProject();
  try {
    const text = await settleAnEdit(foreign, {}, () => foreign.writeDomain(decision, { logged: false }));
    assert.match(text, /capture owed: 1 changed file/, 'FOREIGN-WRITE-PAYS SHAPE if this is missing: another project\'s domain write must not pay this project');
    assert.equal(existsSync(foreign.ledgerPath), false, 'settlement does not create a ledger');
  } finally {
    foreign.cleanup();
  }

  const research = makeDomainProject();
  try {
    const { ctx, plugin, cleanup } = await setup(research.dir);
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    await call(ctx, { tool: 'subagent', id: 'call_r1', input: { agent: 'sterling/researcher', description: 'r', prompt: 'how does settlement work' }, metadata: { sessionID: 'ses_rchild', status: 'completed' } });
    research.writeDomain({ type: 'research_finding', question: 'how does settlement work?', answer: 'per execution', source_urls: ['https://example.com/x'], source_date: '2026-10-02', capture_date: '2026-10-02' }, { logged: false });
    await plugin.handlers.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
    assert.match(noticeTexts(research.dir).join('\n'), /research owed/, 'an unlogged domain finding does not pay the research duty');
    await cleanup?.();
  } finally {
    research.cleanup();
  }

  const own = makeDomainProject();
  try {
    let ledgerBefore;
    const text = await settleAnEdit(own, {}, () => {
      own.writeDomain(decision);
      ledgerBefore = readFileSync(own.ledgerPath, 'utf8');
    });
    assert.doesNotMatch(text, /capture owed/, 'control: the logged write pays');
    assert.equal(readFileSync(own.ledgerPath, 'utf8'), ledgerBefore, 'the settlement that consumed the write leaves the ledger byte-identical');
  } finally {
    own.cleanup();
  }
});

test('settlement: a domain-write ledger that cannot be read raises its own notice and pays nothing', async () => {
  const p = makeDomainProject();
  try {
    const text = await settleAnEdit(p, {}, () => {
      p.writeDomain({ type: 'decision', title: 'a is two', statement: 's', alternatives_rejected: [], rationale: 'r' });
      writeFileSync(p.ledgerPath, '{ not json');
    });
    assert.match(text, /capture owed: 1 changed file/, 'nothing pays through an unreadable ledger');
    assert.match(text, /Sterling settlement: the domain-write ledger \.sterling\/transient\/knowledge-writes\.json could not be read \(.+\); no domain-scoped record was counted toward the capture and research duties\./);
    assert.doesNotMatch(text, /settlement failed/, 'the settlement itself completes');
  } finally {
    p.cleanup();
  }
});

test('the maintenance worker child never sweeps: a parent\'s live background implementor stays live', async () => {
  const p = makeProject({ records: [] });
  try {
    const parent = await setup(p.dir, { ses_root: {}, ses_impl: { parentID: 'ses_root' } });
    const { before, result } = bgCall('call_live_impl', 'ses_impl');
    await parent.ctx.hooks.tool['execute.before'](before);
    await parent.ctx.hooks.tool['execute.after']({ ...before, status: 'completed', result });
    const worker = await setup(p.dir, { ses_worker: {} }, { env: { STERLING_MAINTENANCE_WORKER: '1' } });
    const ci = { sessionID: 'ses_worker', agent: 'build', system: [], messages: [], tools: {} };
    await worker.ctx.hooks.session.context(ci);
    assert.ok(ci.system.length, 'the worker child still gets its context');
    assert.ok(stateRecords(p.dir).some((r) => r.tool_use_id === 'call_live_impl' && !r.terminal), "the parent's dispatch is still live");
    assert.ok(registerRows(p.dir).some((r) => r.agent_id === 'ses_impl' && !r.ended), 'and its register round');
    assert.equal(server.liveDispatch(p.dir).live, true);
    await worker.cleanup?.();
    await parent.cleanup?.();
  } finally {
    p.cleanup();
  }
});
