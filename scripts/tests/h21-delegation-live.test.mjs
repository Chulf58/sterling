// H21 MID-SESSION DELEGATION WATCH (decision 9042abeb, closing the deferral in
// 8b00e77a on observed under-correction — user-approved 2026-08-10). A NEW
// conductor-side PreToolUse hook, advisory-only, NEVER denies (the H19 lesson,
// bf87898c: a hook can see a call fired but never whether a dac3d2c6 exception
// applies, so it cannot gate — only measure and surface).
//
// THREE mechanisms in one hook (scripts/hooks/h21-delegation-live.mjs):
//   (A) ARTICLE-WRITE WATCH — every conductor-hand-run knowledge_update /
//       knowledge_append / knowledge_edit (either MCP prefix) gets a one-line
//       additionalContext advisory citing decision dac3d2c6 + its three
//       exceptions + a running per-session count in
//       .sterling/transient/article-writes.json.
//   (B) HAND-WORK STREAK — Read/Grep/Glob accumulate a transient streak
//       (distinct read paths + search count) in
//       .sterling/transient/hand-work-streak.json; crossing
//       config.delegation_watch.streak_threshold (default 10) injects ONE
//       moment-3 advisory (decision 677f1639) per streak episode.
//   (C) STREAK RESET — a Task/Agent dispatch resets the hand-work streak (a
//       fresh episode can nag again later in the session) but NEVER resets
//       the article-writes count, which is a whole-session tally.
//
// SUBAGENT EXCLUSION: input.agent_id present -> exit 0, no output, no files
// touched at all (Layer-0 finding 1c526e6d: subagent hook stdin always
// carries agent_id on this CLI).
//
// Fail-open throughout (P5, but advisory-only so nothing is ever silently
// ungated): a corrupt transient file or config -> exit 0, never exit 2, never
// a throw; an advisory is not required on the degraded path.
//
// NONE OF scripts/hooks/h21-delegation-live.mjs EXISTS YET — this is the red
// gate for that file, plus the packages/schemas config.delegation_watch.
// streak_threshold field and the hooks/hooks.json PreToolUse registration
// (matcher coverage test at the bottom of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeProject(config = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h21-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', ...over };
}

function additionalContextOf(r) {
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.additionalContext ?? null;
}

function articleWritesOf(dir) {
  const p = join(dir, '.sterling', 'transient', 'article-writes.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function streakOf(dir) {
  const p = join(dir, '.sterling', 'transient', 'hand-work-streak.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

const readOf = (dir, file) => ({ tool_name: 'Read', tool_input: { file_path: join(dir, file) } });
const grepOf = () => ({ tool_name: 'Grep', tool_input: { pattern: 'x' } });
const globOf = () => ({ tool_name: 'Glob', tool_input: { pattern: '**/*.mjs' } });
// Payloads sit ABOVE write_bytes_advise (2000) since the size-weighting change
// (board 25b89890): these pins assert the advisory's content/counting for writes
// that DO qualify — sub-threshold silence is h21-precision.test.mjs's territory.
const BULKY = 'x'.repeat(2400);
const knowledgeUpdate = (prefix = 'mcp__sterling__') => ({ tool_name: `${prefix}knowledge_update`, tool_input: { fields: BULKY } });
const knowledgeAppend = (prefix = 'mcp__sterling__') => ({ tool_name: `${prefix}knowledge_append`, tool_input: { entries: BULKY } });
const knowledgeEdit = (prefix = 'mcp__sterling__') => ({ tool_name: `${prefix}knowledge_edit`, tool_input: { replace: BULKY } });
const taskOf = () => ({ tool_name: 'Task', tool_input: {} });
const agentOf = () => ({ tool_name: 'Agent', tool_input: {} });

// --------------------------- common behavior ---------------------------

test('H21: agent_id present -> exit 0, NO output at all, and no transient files are created', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('h21-delegation-live.mjs', hookInput(dir, { ...knowledgeUpdate(), agent_id: 'a1' }), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'subagent-originated call skipped entirely — no advisory emitted');
    assert.equal(articleWritesOf(dir), null, 'no article-writes.json written for a subagent call');

    const r2 = runHook('h21-delegation-live.mjs', hookInput(dir, { ...readOf(dir, 'src/a.mjs'), agent_id: 'a1' }), dir);
    assert.equal(r2.code, 0);
    assert.equal(r2.stdout, '');
    assert.equal(streakOf(dir), null, 'no hand-work-streak.json written for a subagent call');
  } finally {
    cleanup();
  }
});

test('H21: never exits 2, across every tool_name this hook cares about', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const call of [knowledgeUpdate(), readOf(dir, 'src/a.mjs'), grepOf(), globOf(), taskOf(), agentOf(), { tool_name: 'Edit', tool_input: {} }]) {
      const r = runHook('h21-delegation-live.mjs', hookInput(dir, call), dir);
      assert.notEqual(r.code, 2, `${call.tool_name} must never deny — H21 is advisory-only`);
    }
  } finally {
    cleanup();
  }
});

test('H21: a corrupt article-writes.json fails open (exit 0, never 2, never a throw)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'article-writes.json'), '{ not json');
    const r = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    assert.equal(r.code, 0, `corrupt transient state must fail open, not crash: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H21: a corrupt hand-work-streak.json fails open (exit 0, never 2, never a throw)', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'hand-work-streak.json'), '[not json at all');
    const r = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir);
    assert.equal(r.code, 0, `corrupt transient state must fail open, not crash: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H21: a corrupt .sterling/config.json fails open (exit 0, never 2) even while building a hand-work streak', () => {
  const { dir, cleanup } = makeProject(null);
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not json');
    for (let i = 0; i < 12; i++) {
      const r = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, `src/f${i}.mjs`)), dir);
      assert.notEqual(r.code, 2, `read #${i} must never deny on a corrupt config`);
    }
  } finally {
    cleanup();
  }
});

// --------------------------- (A) article-write watch ---------------------------

test('H21 article-write watch: fires on knowledge_update, citing decision dac3d2c6, its three exceptions, and the running count', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    assert.equal(r.code, 0);
    const ctx = additionalContextOf(r);
    assert.ok(ctx, 'an additionalContext advisory must be emitted on the very first article write');
    assert.match(ctx, /dac3d2c6/, 'cites the article-application-is-librarian-shaped decision');
    assert.match(ctx, /small authored creat/i, 'names exception 1: small authored creates');
    assert.match(ctx, /live adjudication/i, 'names exception 2: a write needing live adjudication');
    assert.match(ctx, /single small-record touch/i, 'names exception 3: a single small-record touch');
    assert.match(ctx, /\b1\b/, 'the running count for this session (1) is stated');

    const writes = articleWritesOf(dir);
    assert.ok(writes, 'article-writes.json must be created');
    assert.equal(writes.session_id, 's1');
    assert.equal(writes.count, 1);
  } finally {
    cleanup();
  }
});

test('H21 article-write watch: covers knowledge_append and knowledge_edit too, under the mcp__plugin_sterling_sterling__ prefix as well', () => {
  const { dir, cleanup } = makeProject();
  try {
    // decision h21-downgraded-to-once-per-session: only the FIRST qualifying write
    // advises, so verb/prefix coverage is proven by the first advisory + the count.
    let r = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeEdit('mcp__plugin_sterling_sterling__')), dir);
    assert.ok(additionalContextOf(r), 'knowledge_edit under the PLUGIN prefix fires the advisory (anti-pattern 837015c4)');
    r = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeAppend()), dir);
    assert.equal(additionalContextOf(r), null, 'knowledge_append is still COUNTED but stays silent — once per session (decision h21-downgraded-to-once-per-session)');
    const writes = articleWritesOf(dir);
    assert.equal(writes.count, 2, 'both calls incremented the same running count');
  } finally {
    cleanup();
  }
});

test('H21 article-write watch: counts EVERY call but advises only ONCE per session (decision h21-downgraded-to-once-per-session)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const first = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    const firstCtx = additionalContextOf(first);
    assert.ok(firstCtx, 'the FIRST call advises');
    assert.match(firstCtx, /once per session/i, 'the advisory discloses its once-per-session ceiling');
    runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    const third = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    assert.equal(additionalContextOf(third), null, 'the THIRD call stays silent — the advisory already fired this session');
    assert.equal(articleWritesOf(dir).count, 3, 'the running count still increments on every call');
  } finally {
    cleanup();
  }
});

test('H21 article-write watch: a DIFFERENT session_id resets the count to start fresh', () => {
  const { dir, cleanup } = makeProject();
  try {
    runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir); // s1, count -> 1
    runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir); // s1, count -> 2
    assert.equal(articleWritesOf(dir).count, 2);

    const r = runHook('h21-delegation-live.mjs', hookInput(dir, { ...knowledgeUpdate(), session_id: 's2' }), dir);
    const ctx = additionalContextOf(r);
    assert.match(ctx, /\b1\b/, 'a new session_id starts the running count over at 1, not continuing at 3');
    const writes = articleWritesOf(dir);
    assert.equal(writes.session_id, 's2');
    assert.equal(writes.count, 1);
  } finally {
    cleanup();
  }
});

test('H21 article-write watch: an unrelated tool_name never triggers it (no advisory, no file)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('h21-delegation-live.mjs', hookInput(dir, { tool_name: 'Edit', tool_input: {} }), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'Edit is not an article-write tool — no advisory');
    assert.equal(articleWritesOf(dir), null);
  } finally {
    cleanup();
  }
});

// --------------------------- (B) hand-work streak ---------------------------

test('H21 hand-work streak: Read accumulates distinct file_path values; the SAME path twice counts once', () => {
  const { dir, cleanup } = makeProject();
  try {
    const target = join(dir, 'src', 'a.mjs');
    runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir);
    runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir); // same path again
    const streak = streakOf(dir);
    assert.ok(streak);
    assert.equal(streak.read_paths.length, 1, 'the same file_path read twice is one distinct entry');
    assert.equal(streak.read_paths[0], target, 'the recorded path matches the read file_path');

    runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/b.mjs')), dir); // a genuinely different path
    assert.equal(streakOf(dir).read_paths.length, 2, 'a distinct path grows the streak');
  } finally {
    cleanup();
  }
});

test('H21 hand-work streak: Grep/Glob increment a separate search counter', () => {
  const { dir, cleanup } = makeProject();
  try {
    runHook('h21-delegation-live.mjs', hookInput(dir, grepOf()), dir);
    runHook('h21-delegation-live.mjs', hookInput(dir, globOf()), dir);
    const streak = streakOf(dir);
    assert.ok(streak);
    assert.equal(streak.searches, 2);
    assert.equal(streak.read_paths.length, 0);
  } finally {
    cleanup();
  }
});

test('H21 hand-work streak: below config.delegation_watch.streak_threshold, no advisory; at/above it, exactly ONE advisory naming decision 677f1639 and the measured streak', () => {
  const { dir, cleanup } = makeProject();
  try {
    // default streak_threshold is 10 (packages/schemas default): 9 distinct
    // reads must stay silent, the 10th crosses it.
    for (let i = 0; i < 9; i++) {
      const r = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, `src/f${i}.mjs`)), dir);
      assert.equal(additionalContextOf(r), null, `read #${i + 1} of 9 must stay silent (below threshold)`);
    }
    const tenth = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/f9.mjs')), dir);
    const ctx = additionalContextOf(tenth);
    assert.ok(ctx, 'the 10th distinct read crosses the default streak_threshold — exactly one advisory');
    assert.match(ctx, /677f1639/, 'cites the delegation-check decision');
    assert.match(ctx, /moment 3/i, 'names the moment-3 framing (hand-work needing only its conclusion is a dispatch)');
    assert.match(ctx, /\b10\b/, 'the measured streak number (10) is stated');

    const streak = streakOf(dir);
    assert.equal(streak.nagged, true, 'nagged is set true once the advisory has fired');
  } finally {
    cleanup();
  }
});

test('H21 hand-work streak: once nagged, further reads/searches in the SAME episode emit no further advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (let i = 0; i < 10; i++) runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, `src/f${i}.mjs`)), dir);
    assert.equal(streakOf(dir).nagged, true, 'threshold already crossed and nagged');

    const after1 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/f10.mjs')), dir);
    assert.equal(additionalContextOf(after1), null, 'no repeat advisory for the 11th distinct read');
    const after2 = runHook('h21-delegation-live.mjs', hookInput(dir, grepOf()), dir);
    assert.equal(additionalContextOf(after2), null, 'no repeat advisory for a subsequent search either');
  } finally {
    cleanup();
  }
});

test('H21 hand-work streak: config.delegation_watch.streak_threshold is tunable — a lowered threshold fires earlier', () => {
  const { dir, cleanup } = makeProject({ ...CONFIG, delegation_watch: { streak_threshold: 3 } });
  try {
    const r1 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir);
    assert.equal(additionalContextOf(r1), null);
    const r2 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/b.mjs')), dir);
    assert.equal(additionalContextOf(r2), null);
    const r3 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/c.mjs')), dir);
    const ctx = additionalContextOf(r3);
    assert.ok(ctx, 'threshold 3 crossed on the 3rd distinct read');
    assert.match(ctx, /\b3\b/);
  } finally {
    cleanup();
  }
});

test('H21 hand-work streak: a DIFFERENT session_id starts a fresh episode (nagged resets, streak resets)', () => {
  const { dir, cleanup } = makeProject({ ...CONFIG, delegation_watch: { streak_threshold: 2 } });
  try {
    runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir);
    const fires = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/b.mjs')), dir);
    assert.ok(additionalContextOf(fires), 'threshold 2 crossed in session s1');
    assert.equal(streakOf(dir).nagged, true);

    const fresh = runHook('h21-delegation-live.mjs', hookInput(dir, { ...readOf(dir, 'src/c.mjs'), session_id: 's2' }), dir);
    assert.equal(additionalContextOf(fresh), null, 'a new session_id starts a fresh streak — one read is below threshold 2 again');
    const streak = streakOf(dir);
    assert.equal(streak.session_id, 's2');
    assert.equal(streak.nagged, false, 'nagged resets for the new session');
    assert.equal(streak.read_paths.length, 1);
  } finally {
    cleanup();
  }
});

// --------------------------- (C) streak reset via dispatch ---------------------------

test('H21 streak reset: a Task dispatch resets read_paths/searches/nagged to empty; no output', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (let i = 0; i < 10; i++) runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, `src/f${i}.mjs`)), dir);
    assert.equal(streakOf(dir).nagged, true, 'nagged before the dispatch');

    const r = runHook('h21-delegation-live.mjs', hookInput(dir, taskOf()), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'Task dispatch produces no output of its own');
    const streak = streakOf(dir);
    assert.deepEqual(streak.read_paths, []);
    assert.equal(streak.searches, 0);
    assert.equal(streak.nagged, false);
  } finally {
    cleanup();
  }
});

test('H21 streak reset: an Agent dispatch resets the streak, but a second episode stays SILENT — the once-per-session latch survives the reset (decision h21-downgraded-to-once-per-session)', () => {
  const { dir, cleanup } = makeProject({ ...CONFIG, delegation_watch: { streak_threshold: 2 } });
  try {
    runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/a.mjs')), dir);
    const first = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/b.mjs')), dir);
    assert.ok(additionalContextOf(first), 'first episode crosses threshold 2 and nags');

    runHook('h21-delegation-live.mjs', hookInput(dir, agentOf()), dir); // reset

    const afterReset1 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/c.mjs')), dir);
    assert.equal(additionalContextOf(afterReset1), null, 'below threshold again after the reset');
    const afterReset2 = runHook('h21-delegation-live.mjs', hookInput(dir, readOf(dir, 'src/d.mjs')), dir);
    assert.equal(additionalContextOf(afterReset2), null, 'a SECOND episode crossing the threshold stays silent — the once-per-session latch survives the episode reset (decision h21-downgraded-to-once-per-session)');
  } finally {
    cleanup();
  }
});

test('H21 streak reset: article-writes count is NOT touched by a Task/Agent dispatch — it is a whole-session tally', () => {
  const { dir, cleanup } = makeProject();
  try {
    runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    assert.equal(articleWritesOf(dir).count, 2);

    runHook('h21-delegation-live.mjs', hookInput(dir, taskOf()), dir);
    assert.equal(articleWritesOf(dir).count, 2, 'a dispatch must not reset the article-write tally');

    const r = runHook('h21-delegation-live.mjs', hookInput(dir, knowledgeUpdate()), dir);
    // decision h21-downgraded-to-once-per-session: the tally continues across the
    // dispatch, but the advisory fired on write #1 already, so this one is silent —
    // the count assertion below is what pins the whole-session tally now.
    assert.equal(additionalContextOf(r), null, 'no repeat advisory — once per session');
    assert.equal(articleWritesOf(dir).count, 3, 'the count continues from 2 -> 3 across the dispatch, not restarting at 1');
  } finally {
    cleanup();
  }
});

// --------------------------- matcher coverage (hooks.json registration) ---------------------------
//
// H11 lesson (anti-pattern 837015c4): a direct-invocation hook test bypasses
// the platform's OWN matcher entirely, so the registration itself must be
// asserted against the shipped hooks/hooks.json — never inferred from the
// hook script working when invoked by hand.

test('hooks.json: h21-delegation-live is registered on PreToolUse with matchers covering BOTH MCP knowledge-tool prefixes, Read|Grep|Glob, and Task|Agent', () => {
  const hooksJson = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const entries = (hooksJson.hooks?.PreToolUse ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('h21-delegation-live.mjs'))
  );
  assert.ok(entries.length > 0, 'hooks.json must register h21-delegation-live.mjs on PreToolUse');

  const matchers = entries.map((e) => new RegExp(e.matcher));
  const requiredTools = [
    'mcp__sterling__knowledge_update',
    'mcp__sterling__knowledge_append',
    'mcp__sterling__knowledge_edit',
    'mcp__plugin_sterling_sterling__knowledge_update',
    'mcp__plugin_sterling_sterling__knowledge_append',
    'mcp__plugin_sterling_sterling__knowledge_edit',
    'Read',
    'Grep',
    'Glob',
    'Task',
    'Agent',
  ];
  for (const tool of requiredTools) {
    assert.ok(
      matchers.some((m) => m.test(tool)),
      `h21's PreToolUse matcher(s) must cover ${tool} — else the register silently never fires for it (anti-pattern 837015c4, the plugin-prefix silent miss)`
    );
  }
});
