// REGRESSION: H19's file-touch decision pointers printed "[standing]" for a
// decision another record supersedes (the H19 half of the Dome Farmer
// 2026-10-02 incident, board 7e4850cf sub-item (c); the H20 half is pinned in
// h20-superseded-decision.test.mjs). The incident shape: the newer decision
// was created with links[{rel:'supersedes'}], which writes the edge but leaves
// the target active and live, so its own `authority: standing` still renders.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-10-02T12:00:00.000Z';
const FILE = 'game/sim/day_clock.gd';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-knowledge-delivery.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const envelope = (type) => ({
  id: randomUUID(),
  type,
  created_at: NOW,
  updated_at: NOW,
  author: 'conductor',
  status: 'active',
  superseded_by: null,
  links: [],
  scope: 'project',
  stack_tags: [],
});

const article = (slug) => ({
  ...envelope('feature_article'),
  slug,
  title: slug,
  what_it_does: `${slug} does the ${slug} thing`,
  intended_behavior: `${slug} intends`,
  files: [{ path: FILE, role: 'owner' }],
  current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
  dependencies: { relies_on: [], relied_by: [] },
  state: 'active',
  version: 1,
  history: [],
  live_test_refs: [],
});

const decision = (slug, statement, extra = {}) => ({
  ...envelope('decision'),
  slug,
  title: statement,
  statement,
  alternatives_rejected: [],
  rationale: `${statement} rationale`,
  authority: 'standing',
  file_keys: [FILE],
  ...extra,
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-superseded-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.create(article('day-clock'));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const postRead = (dir) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, FILE) },
  session_id: 's1',
  cwd: dir,
});

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// A record's own pointer line ends its pointer with `(knowledge_get <full id>)`.
const lineOf = (ctx, rec) => ctx.split('\n').find((l) => l.includes(`(knowledge_get ${rec.id})`));

const OLD_SLUG = 'one-day-is-150-seconds-peacetime-is-8-days';
const NEW_SLUG = 'fifteen-minute-day-one-third-night-game-speeds';

test('H19 file touch: a decision another record supersedes is never labelled [standing] and names its superseder', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const oldRec = store.create(decision(OLD_SLUG, 'One day is 150 seconds and peacetime is 8 days.'));
    const newRec = store.create(
      decision(NEW_SLUG, 'One day is 900 seconds and peacetime is about 2 days.', { links: [{ rel: 'supersedes', target_id: oldRec.id }] })
    );
    assert.equal(store.get(oldRec.id).status, 'active', 'precondition: the incident shape leaves the old record active');
    const ctx = ctxOf(runHook(postRead(dir), dir));
    const oldLine = lineOf(ctx, oldRec);
    assert.ok(oldLine, `the superseded decision is still pointed at (its edge may be partial):\n${ctx}`);
    assert.doesNotMatch(oldLine, /\[standing\]/, `a superseded decision must not read as standing:\n${oldLine}`);
    assert.ok(oldLine.includes(`SUPERSEDED, whole or in part, by ${NEW_SLUG} (${newRec.id.slice(0, 8)})`), `names the superseder:\n${oldLine}`);
    const newLine = lineOf(ctx, newRec);
    assert.ok(newLine, `the superseder is delivered:\n${ctx}`);
    assert.match(newLine, /\[standing\]/, 'the live superseder keeps its authority');
    assert.doesNotMatch(newLine, /SUPERSEDED/);
  } finally {
    cleanup();
  }
});

test('H19 file touch CONTROL: a decision with no inbound supersedes edge keeps [standing] and no SUPERSEDED note', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decision(OLD_SLUG, 'One day is 150 seconds and peacetime is 8 days.'));
    const ctx = ctxOf(runHook(postRead(dir), dir));
    const line = lineOf(ctx, d);
    assert.ok(line, `the decision is delivered:\n${ctx}`);
    assert.match(line, /\[standing\]/);
    assert.doesNotMatch(ctx, /SUPERSEDED/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// H19 dispatch staging (scripts/hooks/lib/stage-brief.mjs): the path channel
// (decisions on a file the brief names) and the subject channel (decisions the
// brief's vocabulary matches). A dispatch is declared through H22's real
// PreToolUse seam, then SubagentStart stages the brief.
// ---------------------------------------------------------------------------

function stage(dir, prompt) {
  const transcript = join(dir, 'no-such-parent-transcript.jsonl');
  const pre = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `toolu_sup_${randomUUID().slice(0, 8)}`,
      tool_input: { subagent_type: 'general-purpose', prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: transcript,
      prompt_id: 'p1',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  assert.notEqual(pre.status, 2, `PreToolUse never denies: ${pre.stderr}`);
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-dispatch-staging.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'SubagentStart',
      session_id: 's1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'p1',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const SUBJECT_PROMPT = 'Investigate: how long is one farm day in seconds, and how many farm days does peacetime last before the breach?';
const SUBJECT_OLD = 'One farm day lasts 150 seconds and peacetime lasts 8 farm days before the breach.';
const SUBJECT_NEW = 'One farm day lasts 900 seconds and peacetime lasts about 2 farm days before the breach.';

for (const [channel, prompt, fileKeys, oldStatement, newStatement] of [
  ['path', `Change the day length in ${FILE}.`, [FILE], 'One day is 150 seconds and peacetime is 8 days.', 'One day is 900 seconds and peacetime is about 2 days.'],
  ['subject', SUBJECT_PROMPT, [], SUBJECT_OLD, SUBJECT_NEW],
]) {
  test(`H19 staging, ${channel} channel: a superseded decision is never labelled [standing] and names its superseder`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      const oldRec = store.create(decision(OLD_SLUG, oldStatement, { file_keys: fileKeys }));
      const newRec = store.create(
        decision(NEW_SLUG, newStatement, { file_keys: fileKeys, links: [{ rel: 'supersedes', target_id: oldRec.id }] })
      );
      const ctx = ctxOf(stage(dir, prompt));
      const oldLine = lineOf(ctx, oldRec);
      assert.ok(oldLine, `the superseded decision is staged:\n${ctx}`);
      assert.doesNotMatch(oldLine, /\[standing\]/, `a superseded decision must not read as standing:\n${oldLine}`);
      assert.ok(oldLine.includes(`SUPERSEDED, whole or in part, by ${NEW_SLUG} (${newRec.id.slice(0, 8)})`), `names the superseder:\n${oldLine}`);
      const newLine = lineOf(ctx, newRec);
      assert.ok(newLine, `the superseder is staged:\n${ctx}`);
      assert.match(newLine, /\[standing\]/);
      assert.doesNotMatch(newLine, /SUPERSEDED/);
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// OpenCode file-touch delivery (packages/opencode-plugin/src/delivery.mjs),
// driven through the server plugin's tool.execute.before/after hooks.
// ---------------------------------------------------------------------------

function stubCtx(directory) {
  const hooks = { session: {}, tool: {} };
  return {
    hooks,
    location: { directory },
    session: {
      hook: async (name, fn) => void (hooks.session[name] = fn),
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: Date.now() } }),
    },
    tool: { hook: async (name, fn) => void (hooks.tool[name] = fn) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    skill: { transform: async () => ({ dispose: async () => {} }) },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) await new Promise((r) => setTimeout(r, 20));
        },
      }),
    },
  };
}

test('OpenCode file touch: a superseded decision is never labelled [standing] and names its superseder', async () => {
  const server = await import(pathToFileURL(join(root, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  const { dir, store, cleanup } = makeProject();
  let teardown;
  try {
    mkdirSync(join(dir, 'game', 'sim'), { recursive: true });
    writeFileSync(join(dir, FILE), 'extends Node\n');
    const oldRec = store.create(decision(OLD_SLUG, 'One day is 150 seconds and peacetime is 8 days.'));
    const newRec = store.create(
      decision(NEW_SLUG, 'One day is 900 seconds and peacetime is about 2 days.', { links: [{ rel: 'supersedes', target_id: oldRec.id }] })
    );
    const ctx = stubCtx(dir);
    teardown = await server.createSterlingServer({ claudeOnPath: () => false }).setup(ctx);
    const call = { tool: 'read', sessionID: 'ses_1', id: 'c1', input: { path: FILE } };
    await ctx.hooks.tool['execute.before'](call);
    const after = { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'read' }] } };
    await ctx.hooks.tool['execute.after'](after);
    assert.equal(after.result.content.length, 2, 'the delivery was appended to the tool result');
    const text = after.result.content[1].text;
    const oldLine = lineOf(text, oldRec);
    assert.ok(oldLine, `the superseded decision is delivered:\n${text}`);
    assert.doesNotMatch(oldLine, /\[standing\]/, `a superseded decision must not read as standing:\n${oldLine}`);
    assert.ok(oldLine.includes(`SUPERSEDED, whole or in part, by ${NEW_SLUG} (${newRec.id.slice(0, 8)})`), `names the superseder:\n${oldLine}`);
    assert.match(lineOf(text, newRec), /\[standing\]/);
  } finally {
    await teardown?.();
    cleanup();
  }
});

// ---- pure helpers: a failed lookup and the ranking ---------------------------

test('withInboundSupersedes: one record whose lookup throws is marked supersession-unknown and the others still come back', async () => {
  const { withInboundSupersedes, authorityMarker, statusAnnotation } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  const store = {
    inboundSupersedes(id) {
      if (id === 'bad') throw new Error('SQLITE_BUSY: database is locked');
      return id === 'old' ? [{ id: 'cccccccc-0000-0000-0000-000000000000', slug: 'newer-ruling', status: 'active' }] : [];
    },
  };
  const recs = [
    { id: 'old', status: 'active', authority: 'standing' },
    { id: 'bad', status: 'active', authority: 'standing' },
    { id: 'fine', status: 'active', authority: 'standing' },
  ].map((r) => withInboundSupersedes(store, r));
  assert.equal(recs.length, 3, 'one failed lookup loses no record');
  assert.equal(recs[0].inbound_supersedes[0].slug, 'newer-ruling');
  assert.equal(recs[1].supersession_unknown, 'SQLITE_BUSY: database is locked');
  assert.equal(authorityMarker(recs[1]), '', 'an unknown supersession never renders [standing]');
  assert.equal(statusAnnotation(recs[1]), ' [supersession UNKNOWN (the lookup failed: SQLITE_BUSY: database is locked): read it before relying on this]');
  assert.equal(authorityMarker(recs[2]), '[standing] ');
  assert.equal(statusAnnotation(recs[2]), '');
});

test('rankFileDecisionPointers: a standing decision with inbound supersedes, or an unknown supersession, ranks as unstated authority', async () => {
  const { rankFileDecisionPointers } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  const d = (id, authority, extra = {}) => ({ id, authority, file_keys: [FILE], updated_at: NOW, ...extra });
  const superseded = d('z-superseded', 'standing', { inbound_supersedes: [{ id: 'x', slug: 'x', status: 'active' }] });
  const unknown = d('y-unknown', 'standing', { supersession_unknown: 'boom' });
  const unstated = d('c-unstated', undefined, { updated_at: '2026-10-01T00:00:00.000Z' });
  const live = d('d-live', 'standing');
  const sessionScoped = d('e-session', 'session_scoped');
  const ranked = rankFileDecisionPointers([sessionScoped, superseded, unknown, unstated, live]).map((x) => x.id);
  assert.equal(ranked[0], 'd-live', 'the live standing ruling leads');
  assert.equal(ranked.at(-1), 'e-session', 'a self-declared session_scoped still ranks below the unstated rung');
  assert.deepEqual(ranked.slice(1, 4).sort(), ['c-unstated', 'y-unknown', 'z-superseded'], 'superseded and unknown share the unstated rung (their ids would sort them first on the standing rung)');
});
