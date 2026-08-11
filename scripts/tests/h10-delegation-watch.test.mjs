// H10 DELEGATION-WATCH ADVISORY (Stop seam, direct mode only) — the mechanical
// half of decision 677f1639's delegation-check contract. Counts are read from
// the CONDUCTOR'S OWN transcript (input.transcript_path), scanning the WHOLE
// file: over every `type: 'assistant'` entry's `message.content[]` tool_use
// blocks, `hand_reads` = distinct Read `input.file_path` values, `searches` =
// Grep+Glob block count, `dispatches` = Task+Agent block count. It fires when
// `(hand_reads + searches) >= min_hand_work AND dispatches <= max_dispatches`
// (config.delegation_watch, defaults 15 / 0), at most once per session via
// `.sterling/transient/delegation-nagged.json` — riding an existing duty deny
// when one fires the same Stop, otherwise a standalone deny suppressed while
// `stop_hook_active` is true. Fail-open: a missing/unreadable transcript or any
// internal failure yields no advisory, exactly one check_skipped row labeled
// 'delegation-watch', and never touches the session-end duties or their exit
// code.
//
// This file is deliberately a SEPARATE test file, not an edit to
// scripts/tests/hooks-full.test.mjs — it reuses that file's harness style
// (temp project + store fixtures, runHook/makeProject/hookInput) without
// modifying it, mirroring the established scripts/tests/h20-centrality.test.mjs
// precedent for adding new hook coverage without touching the giant battery.
//
// NEW behavior under test — none of this exists yet (the red gate):
//   scripts/hooks/h10-direct-capture.mjs gains the delegation-watch advisory
//   packages/schemas config gains delegation_watch { min_hand_work, max_dispatches }
//
// EXTENSION (H21 companion, decision 677f1639 / dac3d2c6): the same Stop-seam
// scan additionally computes max_batch (largest number of Task/Agent blocks
// inside ONE assistant message) and solo_dispatches (count of assistant
// messages carrying EXACTLY one Task/Agent block), folds the article-writes
// count (read from .sterling/transient/article-writes.json, 0 if absent) into
// the fired advisory text, and writes a report-only observation cell —
// .sterling/transient/delegation-stats.json — on EVERY scan, fired or not.
// None of this exists yet either; these are the new red assertions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  // Map the fixture transcripts' model so H10's unmapped-model gauge warning
  // (its own test lives in hooks-full.test.mjs) stays out of these assertions.
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-deleg-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// EXTENSION helper: same fixture, but with an overridable delegation_watch
// block — needed to let dispatches through (max_dispatches > 0) so a fired
// advisory can be observed WITH nonzero max_batch/solo_dispatches in it.
function makeProjectWithConfig(delegationWatchOverride) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-deleg-cfg-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, delegation_watch: delegationWatchOverride }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

// Writes the conductor's OWN transcript: one low-usage line (keeps the
// independent conductor-pressure classifier at below_soft so it never
// interferes with these assertions) plus one assistant entry carrying
// tool_use blocks for the requested reads/searches/dispatches.
function writeDelegationTranscript(dir, { reads = [], searches = 0, dispatches = 0, inputTokens = 1000 } = {}) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const lines = [];
  lines.push(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: inputTokens, cache_read_input_tokens: 0 }, model: 'claude-fable-5' } }));
  const content = [];
  for (const fp of reads) content.push({ type: 'tool_use', name: 'Read', input: { file_path: fp } });
  for (let i = 0; i < searches; i++) content.push({ type: 'tool_use', name: i % 2 === 0 ? 'Grep' : 'Glob', input: {} });
  for (let i = 0; i < dispatches; i++) content.push({ type: 'tool_use', name: i % 2 === 0 ? 'Task' : 'Agent', input: {} });
  if (content.length) lines.push(JSON.stringify({ type: 'assistant', message: { content } }));
  writeFileSync(p, lines.join('\n') + '\n');
}

// EXTENSION helper: same low-usage preamble, then reads/searches lumped into
// one assistant message (as above) followed by ONE SEPARATE assistant message
// PER ENTRY of dispatchBatches — each message carrying that many Task/Agent
// blocks. This is what lets max_batch (largest single-message batch) and
// solo_dispatches (messages with exactly one block) differ from each other and
// from the flat total dispatch count the original helper produces.
function writeDelegationTranscriptBatched(dir, { reads = [], searches = 0, dispatchBatches = [], inputTokens = 1000 } = {}) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const lines = [];
  lines.push(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: inputTokens, cache_read_input_tokens: 0 }, model: 'claude-fable-5' } }));
  const content = [];
  for (const fp of reads) content.push({ type: 'tool_use', name: 'Read', input: { file_path: fp } });
  for (let i = 0; i < searches; i++) content.push({ type: 'tool_use', name: i % 2 === 0 ? 'Grep' : 'Glob', input: {} });
  if (content.length) lines.push(JSON.stringify({ type: 'assistant', message: { content } }));
  let n = 0;
  for (const batchSize of dispatchBatches) {
    const batchContent = [];
    for (let i = 0; i < batchSize; i++) {
      batchContent.push({ type: 'tool_use', name: n % 2 === 0 ? 'Task' : 'Agent', input: {} });
      n++;
    }
    lines.push(JSON.stringify({ type: 'assistant', message: { content: batchContent } }));
  }
  writeFileSync(p, lines.join('\n') + '\n');
}

function distinctPaths(dir, n) {
  return Array.from({ length: n }, (_, i) => join(dir, 'src', `f${i}.mjs`));
}

function touchRegister(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: NOW }))));
}

function seedArticleWrites(dir, sessionId, count) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'article-writes.json'), JSON.stringify({ session_id: sessionId, count }));
}

function statsOf(dir) {
  const p = join(dir, '.sterling', 'transient', 'delegation-stats.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// --------------------------- (a) fire + once-per-session ---------------------------

test('H10 delegation watch: fires at >=min_hand_work distinct hand-reads with 0 dispatches, naming all three counts; an immediately repeated Stop releases (marker spent)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) });
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 2, 'over-threshold hand-work with zero dispatches and no pending duties fires the standalone advisory');
    assert.match(first.stderr, /H10 delegation watch:/, 'message carries the required prefix');
    assert.match(first.stderr, /\b16\b/, 'names the distinct hand-read file count');
    assert.match(first.stderr, /search/i, 'names the search count');
    assert.match(first.stderr, /dispatch/i, 'names the dispatch count');
    assert.match(first.stderr, /once per session/i, 'states it fires once per session');

    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'marker spent — an immediately repeated Stop releases');
    assert.doesNotMatch(second.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (b) a dispatch suppresses it ---------------------------

test('H10 delegation watch: a single Agent dispatch suppresses the advisory even over the hand-work threshold', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 20), dispatches: 1 });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'dispatches(1) exceeds max_dispatches(0) default — never fires regardless of hand-work volume');
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (c) distinctness ---------------------------

test('H10 delegation watch: distinct file_path counting — 20 reads of the SAME file never crosses the threshold', () => {
  const { dir, cleanup } = makeProject();
  try {
    const same = join(dir, 'src', 'shared.mjs');
    writeDelegationTranscript(dir, { reads: Array.from({ length: 20 }, () => same) });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, '20 non-distinct reads count as ONE distinct file — below the 15 default');
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (d) searches count toward the threshold ---------------------------

test('H10 delegation watch: Grep/Glob searches count toward the hand-work threshold alongside reads', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 10), searches: 6 });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, '10 distinct reads + 6 searches = 16 >= the 15 default — fires');
    assert.match(r.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (e) rides a duty nag ---------------------------

test('H10 delegation watch: rides a capture duty nag in ONE deny; the following Stop carries no standalone delegation block', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) });
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(first.code, 2, 'the capture duty alone already denies');
    assert.match(first.stderr, /nothing was captured/, 'capture duty nag present');
    assert.match(first.stderr, /H10 delegation watch:/, 'delegation text rides the SAME deny');

    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(second.code, 0, 'second Stop releases — the delegation marker was already spent riding the first deny');
    assert.doesNotMatch(second.stderr, /H10 delegation watch:/, 'no standalone delegation block follows');
  } finally {
    cleanup();
  }
});

// --------------------------- (f) stop_hook_active suppression ---------------------------

test('H10 delegation watch: stop_hook_active suppresses the standalone deny; a later Stop without the flag still fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) });
    const suppressed = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop', stop_hook_active: true }), dir);
    assert.equal(suppressed.code, 0, 'stop_hook_active suppresses the standalone advisory (no deny loops)');
    assert.doesNotMatch(suppressed.stderr, /H10 delegation watch:/);

    const later = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(later.code, 2, 'the marker was not spent while suppressed — a later Stop of the same session still fires');
    assert.match(later.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (g) fail-open on missing transcript ---------------------------

test('H10 delegation watch: missing transcript fails open — no advisory, exactly one check_skipped row labeled delegation-watch, duties unaffected', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // No transcript file is ever written at t/s1.jsonl, and no touches/duties
    // are pending either — the only thing under test is the degradation path.
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'missing transcript never blocks; no duties were pending either');
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/, 'no advisory without counts to report');
    const skipped = store.listCheckSkipped().filter((c) => c.check_name === 'delegation-watch');
    assert.equal(skipped.length, 1, 'exactly one check_skipped row recorded for the missing transcript');
  } finally {
    cleanup();
  }
});

// --------------------------- (h) marker from a different session ---------------------------

test("H10 delegation watch: a marker written by a DIFFERENT session_id never suppresses this session's advisory", () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'delegation-nagged.json'), JSON.stringify({ session_id: 'other-session', at: NOW }));
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir); // default session_id is 's1'
    assert.equal(r.code, 2, "a different session's spent marker does not suppress this session's advisory");
    assert.match(r.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (i) sidechain exclusion (review fix, f21e106) ---------------------------

test("H10 delegation watch: isSidechain assistant entries are never counted as conductor hand-work", () => {
  const { dir, cleanup } = makeProject();
  try {
    // 16 distinct reads, but every one of them inside a sidechain entry — the
    // conductor itself did nothing. Subagent turns live in separate agent-*.jsonl
    // files today (verified 2026-08-10); this pins the defensive guard anyway.
    const p = join(dir, 't', 's1.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    const content = distinctPaths(dir, 16).map((fp) => ({ type: 'tool_use', name: 'Read', input: { file_path: fp } }));
    const lines = [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0 }, model: 'claude-fable-5' }, isSidechain: false }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content } }),
      JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'conductor turn' }] } }),
    ];
    writeFileSync(p, lines.join('\n') + '\n');
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, "a sidechain's 16 reads are not the conductor's hand-work — no advisory");
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/);
  } finally {
    cleanup();
  }
});

// --------------------------- (j) loud shape-drift skip (review fix, f21e106) ---------------------------

test('H10 delegation watch: assistant entries with no content arrays record check_skipped format_unparseable instead of dying silently', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Transcript exists and parses, but NO assistant entry carries a content
    // array — the shape the scan depends on has drifted. A silent null would
    // leave the watch permanently dead with no trail (P5).
    const p = join(dir, 't', 's1.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    const lines = [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0 }, model: 'claude-fable-5' } }),
      JSON.stringify({ type: 'assistant', message: { body: 'a shape the scan does not know' } }),
    ];
    writeFileSync(p, lines.join('\n') + '\n');
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'shape drift never blocks and never fires the advisory');
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/);
    const skipped = store.listCheckSkipped().filter((c) => c.check_name === 'delegation-watch');
    assert.equal(skipped.length, 1, 'exactly one check_skipped row for the drifted shape');
    assert.ok(JSON.stringify(skipped[0]).includes('format_unparseable'), 'the row names format_unparseable as the reason');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// EXTENSION (H21 companion): max_batch / solo_dispatches / article_writes
// folded into the advisory text, and delegation-stats.json written on EVERY
// scan (fired or not) as a latest-value observation cell. None of this exists
// yet — the red gate for this slice.
// ===========================================================================

// --------------------------- (k) max_batch / solo_dispatches computed correctly ---------------------------

test('H10 delegation watch: max_batch is the largest single-message Task/Agent batch; solo_dispatches counts messages with exactly one block', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Three separate assistant messages dispatch in batches of 3, 1, 1: total
    // dispatches = 5 (> max_dispatches default 0, so the advisory itself does
    // NOT fire — mirrors precedent test (b) — but the stats cell must still
    // reflect the batch shape correctly).
    writeDelegationTranscriptBatched(dir, { reads: distinctPaths(dir, 16), dispatchBatches: [3, 1, 1] });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'dispatches(5) exceeds max_dispatches(0) — the advisory does not fire');
    const stats = statsOf(dir);
    assert.ok(stats, 'delegation-stats.json must exist after any scan, fired or not');
    assert.equal(stats.session_id, 's1');
    assert.equal(stats.hand_reads, 16);
    assert.equal(stats.searches, 0);
    assert.equal(stats.dispatches, 5, 'total Task/Agent blocks across all three messages');
    assert.equal(stats.max_batch, 3, 'the largest SINGLE-message batch, not the total');
    assert.equal(stats.solo_dispatches, 2, 'two messages carried exactly one Task/Agent block');
    assert.ok(stats.at, 'the observation carries a timestamp');
  } finally {
    cleanup();
  }
});

// --------------------------- (l) stats cell written even when the advisory does not fire ---------------------------

test('H10 delegation watch: delegation-stats.json is written on a scan BELOW threshold too — a report-only cell, not gated on firing', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 5), searches: 2 });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'well under the 15 default — no advisory');
    assert.doesNotMatch(r.stderr, /H10 delegation watch:/);
    const stats = statsOf(dir);
    assert.ok(stats, 'the observation cell is written regardless of whether the advisory fired');
    assert.equal(stats.hand_reads, 5);
    assert.equal(stats.searches, 2);
    assert.equal(stats.dispatches, 0);
    assert.equal(stats.max_batch, 0, 'no dispatch messages at all — max_batch is 0, not undefined/NaN');
    assert.equal(stats.solo_dispatches, 0);
    assert.equal(stats.article_writes, 0, 'no article-writes.json present — reads as 0, not missing/undefined');
  } finally {
    cleanup();
  }
});

// --------------------------- (m) fired advisory text folds in article_writes / max_batch / solo_dispatches ---------------------------

test('H10 delegation watch: when the advisory fires, its text names the article-writes count, max_batch, and solo_dispatches', () => {
  const { dir, cleanup } = makeProject();
  try {
    seedArticleWrites(dir, 's1', 4);
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) }); // 0 dispatches — fires per precedent (a)
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, 'over-threshold hand-work with 0 dispatches still fires');
    assert.match(r.stderr, /H10 delegation watch:/);
    assert.match(r.stderr, /\b4\b/, 'the article-writes count (4) is named in the fired advisory');
    const stats = statsOf(dir);
    assert.ok(stats, 'the stats cell is written on a firing scan too');
    assert.equal(stats.article_writes, 4, 'the seeded article-writes count is read into the stats cell');
    assert.equal(stats.max_batch, 0, 'zero dispatches in this scenario — max_batch is 0');
    assert.equal(stats.solo_dispatches, 0);
  } finally {
    cleanup();
  }
});

// --------------------------- (n) article_writes reads 0 when the file is absent ---------------------------

test('H10 delegation watch: article-writes.json absent reads as 0 everywhere (advisory and stats cell), never a crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    // no seedArticleWrites call — the file genuinely does not exist
    writeDelegationTranscript(dir, { reads: distinctPaths(dir, 16) });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2);
    const stats = statsOf(dir);
    assert.equal(stats.article_writes, 0, 'absent article-writes.json reads as 0, not undefined/null/crash');
  } finally {
    cleanup();
  }
});

// --------------------------- (o) a NONZERO max_batch/solo_dispatches on a FIRING scan names both in the text ---------------------------

test('H10 delegation watch: a fired advisory with dispatches WITHIN the configured allowance names nonzero max_batch and solo_dispatches', () => {
  // max_dispatches raised to 5 so dispatches=5 does not suppress firing (unlike
  // the default-0 precedent test (b)) — letting max_batch/solo_dispatches be
  // genuinely nonzero on a scan that DOES fire, so the fired-text assertion is
  // not vacuously true from the all-zero case in test (m).
  const { dir, cleanup } = makeProjectWithConfig({ min_hand_work: 15, max_dispatches: 5 });
  try {
    writeDelegationTranscriptBatched(dir, { reads: distinctPaths(dir, 16), dispatchBatches: [3, 1, 1] });
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 2, '16 reads >= 15 min_hand_work AND dispatches(5) <= max_dispatches(5) — fires');
    assert.match(r.stderr, /H10 delegation watch:/);
    assert.match(r.stderr, /\b3\b/, 'the largest single-message batch (3) is named');
    assert.match(r.stderr, /\b2\b/, 'the solo-dispatch count (2) is named');
    const stats = statsOf(dir);
    assert.equal(stats.max_batch, 3);
    assert.equal(stats.solo_dispatches, 2);
    assert.equal(stats.dispatches, 5);
  } finally {
    cleanup();
  }
});
