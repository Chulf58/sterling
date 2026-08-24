// H21 ONCE-PER-SESSION (spec-only, adversarial, red-first — scripts/hooks/
// h21-delegation-live.mjs is being changed in parallel and is NOT read while
// authoring these tests). Decision [h21-downgraded-to-once-per-session]
// (knowledge_get ad8f3085-ba86-43a8-b98c-aa44e3e6cd6e; board 5011466a): each
// H21 advisory KIND — (A) article-write bytes, (B) hand-work streak — fires
// AT MOST ONCE PER SESSION. Thresholds are unchanged (write_bytes_advise
// 2000 / session_bytes_advise 8000 / streak_threshold 10, all documented
// defaults per the sibling h21-delegation-live.test.mjs and
// h21-precision.test.mjs fixtures already in this directory). The message
// text is unchanged except it MAY note "(once per session)" — that note is
// optional, so these pins never assert its presence, only the advisory's
// presence/absence and its pre-existing content markers.
//
// THIS IS A SETTLED-RULING-CHANGE PIN, NOT A FRESH FEATURE: the sibling
// h21-precision.test.mjs's AC3 ("a burst of several large hand-run store
// writes in a row ... still advises on EACH one") is the exact prior
// behavior this decision overrides for the article-write-bytes kind. A
// naive implementation that only ports AC3 forward (or that only resets the
// streak arm's existing `nagged` flag via Task/Agent dispatch, per the older
// "fresh episode can nag again" behavior in h21-delegation-live.test.mjs)
// will fail pin 2 / the dispatch-reset adversarial pin below — that is the
// point: the marker must be a whole-SESSION latch, not an episode latch.
//
// All assertions are made on the hook's actual stdout (additionalContext),
// never on a state-file flag this test sets itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

function runHook(input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h21-delegation-live.mjs')], {
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h21-once-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function hookInput(dir, sessionId, over = {}) {
  return {
    session_id: sessionId,
    transcript_path: join(dir, 't', `${sessionId}.jsonl`),
    cwd: dir,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    ...over,
  };
}

function additionalContextOf(r) {
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.additionalContext ?? null;
}

// Pads a tool_input to (at least) `bytes` serialized characters via a single
// `content` field, with wide margins from thresholds (mirrors
// h21-precision.test.mjs's fixture assumption).
function payloadOfSize(bytes) {
  const overhead = 13;
  const padLen = Math.max(0, bytes - overhead);
  return { content: 'x'.repeat(padLen) };
}

const sizedUpdate = (bytes, prefix = 'mcp__sterling__') => ({
  tool_name: `${prefix}knowledge_update`,
  tool_input: payloadOfSize(bytes),
});
const readOf = (dir, file) => ({ tool_name: 'Read', tool_input: { file_path: join(dir, file) } });
const taskOf = () => ({ tool_name: 'Task', tool_input: {} });

// Over the default write_bytes_advise (2000) — an unambiguous single-call
// trigger for the article-write-bytes kind.
const OVER_WRITE_THRESHOLD = 2500;
// Default streak_threshold is 10 distinct reads (documented default).
const STREAK_THRESHOLD = 10;

function crossStreak(dir, sessionId, prefix = 'f') {
  let last;
  for (let i = 0; i < STREAK_THRESHOLD; i++) {
    last = runHook(hookInput(dir, sessionId, readOf(dir, `src/${prefix}${i}.mjs`)), dir);
  }
  return last; // the crossing call (10th distinct read)
}

// --------------------------- pin 1: CONTROL ---------------------------

test('PIN1 (control): a first qualifying article-write-bytes trigger in a fresh session DOES fire the advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.equal(r.code, 0);
    const ctx = additionalContextOf(r);
    assert.ok(ctx, 'the first over-threshold write in a fresh session must produce an advisory');
    assert.match(ctx, /byte/i, 'advisory content is still framed by size, per the unchanged-message clause');
    assert.match(ctx, /dac3d2c6/, 'advisory still cites decision dac3d2c6, per the unchanged-message clause');
  } finally {
    cleanup();
  }
});

// --------------------------- pin 2: same kind, same session, no repeat ---------------------------

test('PIN2: a SECOND qualifying article-write-bytes trigger in the SAME session produces NO second advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const first = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.ok(additionalContextOf(first), 'setup: the first over-threshold write must fire (control precondition)');

    const second = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.equal(
      additionalContextOf(second),
      null,
      'a second over-threshold write in the same session must stay silent — this is the exact case the prior AC3 regression guarantee ("still advises on EACH one") explicitly required to fire, and this decision supersedes it'
    );
  } finally {
    cleanup();
  }
});

test('PIN2b (adversarial, kind B): the hand-work-streak kind also latches for the whole SESSION, surviving a Task dispatch reset of the streak counters', () => {
  const { dir, cleanup } = makeProject();
  try {
    const first = crossStreak(dir, 's1', 'a');
    const firstCtx = additionalContextOf(first);
    assert.ok(firstCtx, 'setup: crossing the streak threshold the first time must fire (control precondition)');
    assert.match(firstCtx, /677f1639/, 'setup: the streak advisory cites decision 677f1639');

    // A Task dispatch resets the streak's read/search counters (existing,
    // unchanged mechanism (C)) but must NOT reset the once-per-session latch
    // for this advisory kind — a naive port that only clears the old
    // per-episode `nagged` flag would let this second episode nag again,
    // which is exactly the noise this decision retires.
    runHook(hookInput(dir, 's1', taskOf()), dir);

    const second = crossStreak(dir, 's1', 'b');
    assert.equal(
      additionalContextOf(second),
      null,
      'crossing the streak threshold again in a FRESH episode of the SAME session must stay silent — once-per-session outlives the dispatch-triggered episode reset'
    );
  } finally {
    cleanup();
  }
});

// --------------------------- pin 3: kinds gate independently ---------------------------

test('PIN3: kind A (article-write bytes) having already fired does NOT suppress kind B (hand-work streak)\'s first fire in the same session', () => {
  const { dir, cleanup } = makeProject();
  try {
    const a = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.ok(additionalContextOf(a), 'setup: kind A fires first in this session');

    const b = crossStreak(dir, 's1', 'c');
    const bCtx = additionalContextOf(b);
    assert.ok(bCtx, "kind B's first qualifying crossing must still fire even though kind A already fired earlier in this same session — the two kinds gate independently");
    assert.match(bCtx, /677f1639/, 'the independent kind-B advisory still carries its own content marker');
  } finally {
    cleanup();
  }
});

test('PIN3b: the reverse order also holds — kind B firing first does not suppress kind A\'s first fire', () => {
  const { dir, cleanup } = makeProject();
  try {
    const b = crossStreak(dir, 's1', 'd');
    assert.ok(additionalContextOf(b), 'setup: kind B fires first in this session');

    const a = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    const aCtx = additionalContextOf(a);
    assert.ok(aCtx, "kind A's first qualifying write must still fire even though kind B already fired earlier in this same session");
    assert.match(aCtx, /byte/i, 'the independent kind-A advisory still carries its own content marker');
  } finally {
    cleanup();
  }
});

// --------------------------- pin 4: a new session refires ---------------------------

test('PIN4: a NEW session (fresh session_id/state) fires the article-write-bytes advisory again — the marker is session-scoped, not durable', () => {
  const { dir, cleanup } = makeProject();
  try {
    const s1First = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.ok(additionalContextOf(s1First), 'setup: kind A fires once in session s1');
    const s1Second = runHook(hookInput(dir, 's1', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    assert.equal(additionalContextOf(s1Second), null, 'setup: confirms the once-per-session suppression is active within s1');

    const s2First = runHook(hookInput(dir, 's2', sizedUpdate(OVER_WRITE_THRESHOLD)), dir);
    const ctx = additionalContextOf(s2First);
    assert.ok(ctx, 'a fresh session_id (s2) must fire the advisory again on its own first qualifying write — the once-per-session marker never persists across sessions');
    assert.match(ctx, /byte/i, 'the fresh-session advisory still carries the unchanged content marker');
  } finally {
    cleanup();
  }
});

test('PIN4b (kind B): a NEW session also refires the hand-work-streak advisory on its own first crossing', () => {
  const { dir, cleanup } = makeProject();
  try {
    const s1First = crossStreak(dir, 's1', 'e');
    assert.ok(additionalContextOf(s1First), 'setup: kind B fires once in session s1');
    const s1Second = crossStreak(dir, 's1', 'f');
    assert.equal(additionalContextOf(s1Second), null, 'setup: confirms suppression within s1 for a second fresh episode');

    const s2First = crossStreak(dir, 's2', 'g');
    const ctx = additionalContextOf(s2First);
    assert.ok(ctx, 'a fresh session_id (s2) must fire the streak advisory again on its own first crossing');
    assert.match(ctx, /677f1639/, 'the fresh-session streak advisory still carries the unchanged content marker');
  } finally {
    cleanup();
  }
});
