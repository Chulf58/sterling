// H1 SessionStart — session-boundary register residue conversion.
//
// Spec under test (given by the launching agent, not inferred from implementation):
// three per-project transient register files under <project>/.sterling/transient/ —
// touches.json ({path, at}[] written by H7), session-events.json ({kind, detail, at}[]
// written by H16 and others), and capture-nagged.json (a marker object) — leak into the
// next session when the session that wrote them died without a terminal Stop. H1 must,
// on SessionStart source 'startup' or 'clear', convert that residue: if no durable record
// (decision / anti_pattern / note / feature_article / research_finding /
// disconfirmed_hypothesis — including a derived_unconfirmed one) was created/updated at or
// after the EARLIEST timestamp across touches[].at and session-events[].at, mint exactly one
// system todo (source 'system', system_reason 'capture_owed', text containing the phrase
// 'session-boundary residue', file_keys = deduped touched paths capped at 20, and — when a
// session-events capture_pending event is present — the item text also carries that event's
// detail verbatim). Either way, all three register files are deleted afterwards. A pre-existing
// OPEN capture_owed todo suppresses minting a second (dedup). source 'resume'/'compact' leave
// the registers completely untouched and mint nothing. Malformed register content must not
// crash H1 (a soft hook) — it still clears the files and conservatively mints the (deduped)
// capture_owed item, since the debt cannot be verified. A project with only
// capture-nagged.json (no touches, no events) has that marker deleted silently, no todo. Other
// transient files (pressure-nagged.json, conductor-pressure.json, etc.) are never touched by
// this behavior.
//
// This file follows scripts/tests/hooks-full.test.mjs's harness style (runHook / hookInput /
// envelope / makeProject) so it can run in isolation. H1 does not exist with this behavior yet
// — every test below is expected to FAIL against the current H1.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

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

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1res-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// --------------------------- H1 invocation ---------------------------

function h1(dir, source, envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function additionalContext(res) {
  return res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : undefined;
}

const RESIDUE_PHRASE = /session-boundary residue/;

// --------------------------- register fixtures ---------------------------

const TOUCHES = ['.sterling', 'transient', 'touches.json'];
const EVENTS = ['.sterling', 'transient', 'session-events.json'];
const NAGGED = ['.sterling', 'transient', 'capture-nagged.json'];
const PRESSURE_NAGGED = ['.sterling', 'transient', 'pressure-nagged.json'];
const CONDUCTOR_PRESSURE = ['.sterling', 'transient', 'conductor-pressure.json'];

function regPath(dir, rel) {
  return join(dir, ...rel);
}
function writeReg(dir, rel, content) {
  const p = regPath(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
}
function regExists(dir, rel) {
  return existsSync(regPath(dir, rel));
}
function readRegRaw(dir, rel) {
  const p = regPath(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function writeTouches(dir, entries) {
  writeReg(dir, TOUCHES, entries);
}
function writeEvents(dir, entries) {
  writeReg(dir, EVENTS, entries);
}
function writeNagged(dir, obj = { nagged_at: NOW }) {
  writeReg(dir, NAGGED, obj);
}

const cpEvent = (detail, at) => ({ kind: 'capture_pending', detail, at });

// --------------------------- durable-record fixtures ---------------------------

function decisionAt(store, at) {
  return store.create({ ...envelope('decision', at), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
}
function derivedUnconfirmedDecisionAt(store, at) {
  return store.create({ ...envelope('decision', at), title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', derived_unconfirmed: true });
}
function antiPatternAt(store, at) {
  return store.create({
    ...envelope('anti_pattern', at),
    title: 't',
    trigger: 'trig',
    guidance: 'g',
    wrong_way: 'w',
    right_way: 'r',
    source_evidence: 'e',
    basis: 'codebase',
    file_keys: [],
  });
}
function featureArticleAt(store, at, slug = 'feat-x') {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'src/a.mjs', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'created' }],
    live_test_refs: [],
  });
}
function researchFindingAt(store, at) {
  return store.create({
    ...envelope('research_finding', at),
    question: 'q?',
    answer: 'a',
    source_urls: ['https://example.com/x'],
    source_date: at.slice(0, 10),
    capture_date: at.slice(0, 10),
  });
}
function disconfirmedAt(store, at) {
  return store.create({ ...envelope('disconfirmed_hypothesis', at), question: 'q?', rejected_answer: 'no', evidence: 'ev' });
}

function existingOpenCaptureOwed(store, text = 'session-boundary residue: earlier session') {
  return store.create({ ...envelope('todo'), text, source: 'system', system_reason: 'capture_owed', author: 'system' });
}

function captureOwedItems(store) {
  return store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');
}

// --------------------------- tests ---------------------------

const T1 = '2026-06-10T10:00:00.000Z';
const T1_MINUS = '2026-06-10T09:59:59.000Z';
const T1_PLUS = '2026-06-10T10:00:01.000Z';

test('AC1a: unmet residue mints exactly one capture_owed todo naming the residue, carrying deduped touched paths + the capture_pending detail verbatim; registers cleared', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouches(dir, [
      { path: 'src/a.mjs', at: T1 },
      { path: 'src/b.mjs', at: T1_PLUS },
    ]);
    writeEvents(dir, [cpEvent('commit wave-2 — decisions drafted, riding the gated commit', T1_PLUS)]);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    assert.match(additionalContext(r) ?? '', RESIDUE_PHRASE, 'the conductor is told a conversion happened');

    const items = captureOwedItems(store);
    assert.equal(items.length, 1, 'exactly one capture_owed item minted');
    assert.equal(items[0].source, 'system');
    assert.match(items[0].text, RESIDUE_PHRASE, "the item text names the residue phrase");
    assert.match(items[0].text, /commit wave-2 — decisions drafted, riding the gated commit/, 'the capture_pending detail is carried verbatim');
    assert.deepEqual([...items[0].file_keys].sort(), ['src/a.mjs', 'src/b.mjs']);

    assert.equal(regExists(dir, TOUCHES), false, 'touches.json cleared');
    assert.equal(regExists(dir, EVENTS), false, 'session-events.json cleared');
  } finally {
    cleanup();
  }
});

test('AC1a: source=clear triggers the same conversion as source=startup', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
    const r = h1(dir, 'clear');
    assert.equal(r.code, 0, r.stderr);
    assert.match(additionalContext(r) ?? '', RESIDUE_PHRASE);
    assert.equal(captureOwedItems(store).length, 1);
    assert.equal(regExists(dir, TOUCHES), false);
  } finally {
    cleanup();
  }
});

test('AC1b/AC1e: a durable record at/after the earliest residue timestamp pays the debt — no todo minted, additionalContext silent; the boundary is exact (>=), not (>)', () => {
  // exact equality with the earliest timestamp satisfies
  const exact = makeProject();
  try {
    writeTouches(exact.dir, [{ path: 'src/a.mjs', at: T1 }]);
    decisionAt(exact.store, T1);
    const r = h1(exact.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, 'nothing was converted — the debt was already paid');
    assert.equal(captureOwedItems(exact.store).length, 0);
    assert.equal(regExists(exact.dir, TOUCHES), false, 'registers still clear even when the debt is already paid');
  } finally {
    exact.cleanup();
  }
  // strictly after the earliest timestamp satisfies
  const after = makeProject();
  try {
    writeTouches(after.dir, [{ path: 'src/a.mjs', at: T1 }]);
    decisionAt(after.store, T1_PLUS);
    const r = h1(after.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(captureOwedItems(after.store).length, 0);
  } finally {
    after.cleanup();
  }
  // strictly BEFORE the earliest timestamp does NOT satisfy — the debt still mints
  const before_ = makeProject();
  try {
    writeTouches(before_.dir, [{ path: 'src/a.mjs', at: T1 }]);
    decisionAt(before_.store, T1_MINUS);
    const r = h1(before_.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.match(additionalContext(r) ?? '', RESIDUE_PHRASE);
    assert.equal(captureOwedItems(before_.store).length, 1, 'a record predating the residue does not pay the debt');
  } finally {
    before_.cleanup();
  }
});

test('AC1b: every declared durable record TYPE pays the debt — decision, anti_pattern, feature_article, research_finding, disconfirmed_hypothesis', () => {
  const creators = [
    ['decision', decisionAt],
    ['anti_pattern', antiPatternAt],
    ['feature_article', (store, at) => featureArticleAt(store, at)],
    ['research_finding', researchFindingAt],
    ['disconfirmed_hypothesis', disconfirmedAt],
  ];
  for (const [label, create] of creators) {
    const { dir, store, cleanup } = makeProject();
    try {
      writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
      create(store, T1_PLUS);
      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.equal(captureOwedItems(store).length, 0, `${label} created after the residue must satisfy the debt`);
      assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, `${label}: nothing converted`);
      assert.equal(regExists(dir, TOUCHES), false, `${label}: registers still clear`);
    } finally {
      cleanup();
    }
  }
});

test('AC1b: a derived_unconfirmed record still counts as durable capture, even though it is hidden from default retrieval', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
    const hidden = derivedUnconfirmedDecisionAt(store, T1_PLUS);
    // sanity: confirm this record really is hidden from default query, so a false
    // pass here could not be explained by H1 merely finding it the normal way
    assert.equal(store.query({ types: ['decision'], cap: 10 }).length, 0, 'fixture sanity: derived_unconfirmed is hidden from default query');
    assert.equal(store.query({ types: ['decision'], include_unconfirmed: true, cap: 10 }).some((d) => d.id === hidden.id), true);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(captureOwedItems(store).length, 0, 'a derived_unconfirmed record still pays the residue debt');
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE);
    // 1c: cleared in the satisfied case too — without this the test passes trivially
    // against an H1 that lacks the behavior entirely.
    assert.equal(regExists(dir, TOUCHES), false, 'touches register cleared in the satisfied case');
  } finally {
    cleanup();
  }
});

test('earliest timestamp is the true MINIMUM across touches.json AND session-events.json, not either register alone', () => {
  const EARLY = '2026-06-10T09:00:00.000Z'; // from session-events
  const LATE_TOUCH = '2026-06-10T10:00:00.000Z'; // from touches
  const BETWEEN = '2026-06-10T09:30:00.000Z'; // after EARLY, before LATE_TOUCH

  // a record between the two — satisfies only if the TRUE earliest (EARLY, from
  // session-events) is used; a touches-only reading of "earliest" would wrongly
  // treat 09:30 as too early against a 10:00 floor and mint a spurious todo.
  const between = makeProject();
  try {
    writeTouches(between.dir, [{ path: 'src/a.mjs', at: LATE_TOUCH }]);
    writeEvents(between.dir, [cpEvent('riding a commit', EARLY)]);
    decisionAt(between.store, BETWEEN);
    const r = h1(between.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(captureOwedItems(between.store).length, 0, 'satisfied against the TRUE (session-events-sourced) earliest timestamp');
  } finally {
    between.cleanup();
  }

  // a record just BEFORE the true earliest (09:00) still fails, pinning that the
  // floor really is 09:00 and not something looser
  const stillBefore = makeProject();
  try {
    writeTouches(stillBefore.dir, [{ path: 'src/a.mjs', at: LATE_TOUCH }]);
    writeEvents(stillBefore.dir, [cpEvent('riding a commit', EARLY)]);
    decisionAt(stillBefore.store, '2026-06-10T08:59:59.000Z');
    const r = h1(stillBefore.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(captureOwedItems(stillBefore.store).length, 1, 'a record before the true earliest does not satisfy');
  } finally {
    stillBefore.cleanup();
  }
});

test('AC1d: an existing OPEN capture_owed todo suppresses minting a second — registers still clear', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
    const pre = existingOpenCaptureOwed(store);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const items = captureOwedItems(store);
    assert.equal(items.length, 1, 'still exactly one open capture_owed item — no duplicate minted');
    assert.equal(items[0].id, pre.id, 'the pre-existing item is untouched, not replaced');
    assert.equal(regExists(dir, TOUCHES), false, 'registers still cleared despite the dedup suppression');
  } finally {
    cleanup();
  }
});

test('AC2: source=resume leaves all three registers COMPLETELY untouched and mints nothing, even with unmet debt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const touchesContent = [{ path: 'src/a.mjs', at: T1 }];
    const eventsContent = [cpEvent('riding a commit', T1)];
    const naggedContent = { nagged_at: T1 };
    writeTouches(dir, touchesContent);
    writeEvents(dir, eventsContent);
    writeNagged(dir, naggedContent);

    const r = h1(dir, 'resume');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, 'resume never converts residue');
    assert.equal(captureOwedItems(store).length, 0, 'nothing minted on resume');

    assert.equal(regExists(dir, TOUCHES), true, 'touches.json survives resume');
    assert.equal(regExists(dir, EVENTS), true, 'session-events.json survives resume');
    assert.equal(regExists(dir, NAGGED), true, 'capture-nagged.json survives resume');
    assert.deepEqual(JSON.parse(readRegRaw(dir, TOUCHES)), touchesContent, 'touches.json content is byte-for-byte untouched');
    assert.deepEqual(JSON.parse(readRegRaw(dir, EVENTS)), eventsContent, 'session-events.json content is byte-for-byte untouched');
    assert.deepEqual(JSON.parse(readRegRaw(dir, NAGGED)), naggedContent, 'capture-nagged.json content is byte-for-byte untouched');
  } finally {
    cleanup();
  }
});

test('AC2: source=compact also leaves the registers untouched and mints nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
    writeEvents(dir, [cpEvent('riding a commit', T1)]);
    const r = h1(dir, 'compact');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE);
    assert.equal(captureOwedItems(store).length, 0);
    assert.equal(regExists(dir, TOUCHES), true, 'touches.json survives compact');
    assert.equal(regExists(dir, EVENTS), true, 'session-events.json survives compact');
  } finally {
    cleanup();
  }
});

test('AC3: no register files present → no todo minted, no crash, additionalContext carries no residue mention', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    assert.equal(regExists(dir, TOUCHES), false);
    assert.equal(regExists(dir, EVENTS), false);
    assert.equal(regExists(dir, NAGGED), false);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.out, 'H1 still emits normal JSON output');
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, 'nothing to convert, nothing said');
    assert.equal(captureOwedItems(store).length, 0);
  } finally {
    cleanup();
  }
});

test('AC4: malformed touches.json does not crash H1 — it still clears the registers and conservatively mints the capture_owed item (unverifiable debt stays loud)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeReg(dir, TOUCHES, '{ this is not valid json'); // H7 writes untrusted bytes; H1 must tolerate
    const r = h1(dir, 'startup');
    assert.notEqual(r.code, 1, 'a parse failure must not crash a Node process (non-zero-but-not-1 or 0 both acceptable; 1 signals an uncaught throw)');
    assert.equal(r.code, 0, 'H1 is a soft hook — it never blocks the session even on malformed residue');
    assert.doesNotMatch(r.stderr, /SyntaxError|Unexpected token|TypeError|Cannot read/i, 'no uncaught exception surfaced');

    assert.match(additionalContext(r) ?? '', RESIDUE_PHRASE, 'unverifiable debt is conservatively converted, loudly');
    assert.equal(captureOwedItems(store).length, 1, 'the conservative capture_owed item is minted');
    assert.equal(regExists(dir, TOUCHES), false, 'the malformed register is cleared like any other on this terminal path');
  } finally {
    cleanup();
  }
});

test('AC4: malformed content still mints EVEN WHEN a durable record exists — the debt is unverifiable, so it stays conservative, not silently trusted', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeReg(dir, TOUCHES, 'not json at all');
    decisionAt(store, NOW); // a recent decision — would satisfy a normal (parseable) residue check
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(captureOwedItems(store).length, 1, 'malformed content cannot be verified against any durable record, so it still mints');
  } finally {
    cleanup();
  }
});

test('AC4: malformed content still respects the capture_owed dedup — no second item minted', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeReg(dir, TOUCHES, '{{{not json');
    const pre = existingOpenCaptureOwed(store);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const items = captureOwedItems(store);
    assert.equal(items.length, 1, 'dedup still applies to the conservative malformed-content mint');
    assert.equal(items[0].id, pre.id);
    assert.equal(regExists(dir, TOUCHES), false);
  } finally {
    cleanup();
  }
});

test('AC5: only capture-nagged.json exists (no touches, no events) — the marker is deleted silently, no todo minted', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeNagged(dir, { nagged_at: T1 });
    assert.equal(regExists(dir, TOUCHES), false);
    assert.equal(regExists(dir, EVENTS), false);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, 'silent — nothing was converted');
    assert.equal(captureOwedItems(store).length, 0, 'no todo minted for a bare nag marker with nothing behind it');
    assert.equal(regExists(dir, NAGGED), false, 'the marker itself is still deleted');
  } finally {
    cleanup();
  }
});

test('AC6: other transient files (pressure-nagged.json, conductor-pressure.json) are never deleted by residue conversion', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTouches(dir, [{ path: 'src/a.mjs', at: T1 }]);
    writeReg(dir, PRESSURE_NAGGED, { nagged_at: T1 });
    writeReg(dir, CONDUCTOR_PRESSURE, { level: 'below_soft', fill_pct: 10 });

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);

    assert.equal(regExists(dir, TOUCHES), false, 'the governed register is cleared');
    assert.equal(regExists(dir, PRESSURE_NAGGED), true, 'pressure-nagged.json is untouched — not one of the three governed registers');
    assert.equal(regExists(dir, CONDUCTOR_PRESSURE), true, 'conductor-pressure.json is untouched — not one of the three governed registers');
  } finally {
    cleanup();
  }
});

// ---- FIX C (upgrade-polish, 2026-08-21; decision h17-enforcement-stamp-conductor-
// attested-dirt, knowledge_get 6e132e19-0da1-47c2-9fa5-710bc7365014): the
// conductor-attested enforcement stamp (.sterling/transient/enforcement-stamp.json,
// written by scripts/enforcement-stamp.mjs) is transient, P4 lifecycle-bound state
// scoped to ONE session — H1 deletes it at SessionStart. It is NOT one of the
// three residue registers above: it carries no capture debt of its own, so its
// deletion must never mint a capture_owed item or the RESIDUE_PHRASE mention.
//
// SPEC POINT THE EXISTING FIXTURES CANNOT RESOLVE (disclosed, not improvised):
// the three residue registers deliberately leave source='resume'/'compact'
// COMPLETELY untouched (AC2 above), while the governing decision states the
// stamp is deleted "at SessionStart" unqualified by source. Whether the stamp
// follows the residue registers' resume/compact exemption, or is deleted
// unconditionally on every SessionStart source, is not pinned by the brief
// handed to this test-writer. The test below asserts only the UNAMBIGUOUS case
// (source='startup', where every plausible reading agrees the stamp is deleted)
// and leaves resume/compact deliberately untested rather than encoding a guess.
const STAMP = ['.sterling', 'transient', 'enforcement-stamp.json'];

test('FIX C: H1 deletes the conductor-attested enforcement stamp at SessionStart (startup), minting no residue debt from it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeReg(dir, STAMP, [{ path: 'hooks/x.mjs', sha256: 'deadbeef', at: T1 }]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    // EXPECTED FAILURE TODAY: H1 has no knowledge of this file yet, so it
    // survives — this assertion fires (actual true, expected false).
    assert.equal(regExists(dir, STAMP), false, 'the stamp is deleted on startup (P4 lifecycle)');
    assert.doesNotMatch(additionalContext(r) ?? '', RESIDUE_PHRASE, 'the stamp is not a residue register — no capture debt is minted from it');
    assert.equal(captureOwedItems(store).length, 0, 'deleting the stamp mints nothing');
  } finally {
    cleanup();
  }
});

test('AC1a boundary: touched paths in file_keys are deduped and capped at 20', () => {
  // dedup: 5 unique paths, each touched twice — no cap involved
  const dedup = makeProject();
  try {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push({ path: `src/f${i}.mjs`, at: T1 });
      entries.push({ path: `src/f${i}.mjs`, at: T1_PLUS });
    }
    writeTouches(dedup.dir, entries);
    const r = h1(dedup.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const items = captureOwedItems(dedup.store);
    assert.equal(items.length, 1);
    assert.deepEqual(
      [...items[0].file_keys].sort(),
      Array.from({ length: 5 }, (_, i) => `src/f${i}.mjs`).sort(),
      'duplicate touches of the same path collapse to one file_key entry'
    );
  } finally {
    dedup.cleanup();
  }

  // cap: 25 distinct paths, only 20 survive into file_keys
  const capped = makeProject();
  try {
    const entries = Array.from({ length: 25 }, (_, i) => ({ path: `src/g${i}.mjs`, at: T1 }));
    writeTouches(capped.dir, entries);
    const r = h1(capped.dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const items = captureOwedItems(capped.store);
    assert.equal(items.length, 1);
    assert.equal(items[0].file_keys.length, 20, 'file_keys is capped at 20 even with 25 distinct touched paths');
    const capSet = new Set(items[0].file_keys);
    assert.equal(capSet.size, 20, 'the capped set itself has no duplicates');
    for (const k of items[0].file_keys) {
      assert.match(k, /^src\/g\d+\.mjs$/, 'every capped entry is one of the touched paths');
    }
  } finally {
    capped.cleanup();
  }
});
