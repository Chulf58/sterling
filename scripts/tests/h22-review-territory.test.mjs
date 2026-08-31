// H22 STRUCTURED REVIEW TERRITORY — SPEC ONLY, red-first.
// Governing decision: knowledge_get 8f137474-3ba0-4040-bb7d-28e4e608060c
// (slug review-territory-structured-receipt-files, board 0770ca72).
//
// Spec under test (pinned from the decision record + the launching agent's
// contract, NOT inferred from scripts/hooks/h22-dispatch-register.mjs — that
// file was not read beyond what was already necessary to locate the existing
// H22 test harness pattern in scripts/tests/h22-dispatch-register.test.mjs
// and scripts/tests/h22-review-ledger.test.mjs, which this file's helpers
// mirror without modifying either):
//
//   1. A dispatch block prompt may carry a line
//      `REVIEW-TERRITORY: ["path/a.mjs", "path/b.mjs"]` (JSON array of
//      repo-relative POSIX paths; anchored at line start, case-sensitive).
//   2. When H22 attributes a block (any attribution mode) and that block's
//      prompt contains a REVIEW-TERRITORY line, the entry's files[] comes
//      ONLY from the parsed array — free-prose extraction over the same
//      prompt is NOT used. The entry gains files_source: "review-territory".
//   3. REVIEW-TERRITORY: [] is an explicit, valid empty declaration:
//      files: [] and files_source: "review-territory" (never conflated
//      with "no marker at all").
//   4. No marker: behaves exactly as today (free-prose extraction) and the
//      entry gains files_source: "free-prose-fallback".
//   5. A malformed declaration (unparseable JSON / non-array / non-string
//      elements) is NOT silently ignored: falls back to free-prose
//      extraction, files_source: "free-prose-fallback", PLUS a loud stderr
//      line naming the malformed declaration (H22 never denies).
//   6. No filesystem-existence filtering of declared paths.
//   7. SubagentStop reviewer-* ledger promotion copies files_source into the
//      receipt unchanged.
//
// TODAY (pre-fix): h22-dispatch-register.mjs has no notion of
// REVIEW-TERRITORY at all. It extracts path-like tokens from the raw prompt
// text via a context-free regex (confirmed by scripts/tests/
// h22-dispatch-register.test.mjs's own fixtures) and writes no `files_source`
// field on any entry (confirmed by scripts/tests/h22-review-ledger.test.mjs's
// six-key ledger-entry pin, which does not include files_source). Because the
// regex scans the WHOLE prompt string with no awareness of the marker, it
// also matches path-like substrings sitting INSIDE a REVIEW-TERRITORY JSON
// array today — that is part of why several RED assertions below fail on the
// file LIST, not only on the new `files_source` field.
//
// CONTROL-FIRST DISCIPLINE: the CONTROL test is placed first and is the only
// test in this file expected to be GREEN against today's code — it proves
// the free-prose extraction pipeline itself is untouched, which is the
// necessary premise for every RED pin that follows (a pin that failed only
// because the base extraction broke would prove nothing about the new
// marker logic). It deliberately asserts nothing about `files_source` (that
// field does not exist today at all, so no assertion mentioning it could be
// green pre-fix); the fallback case's `files_source` labeling is pinned
// separately, RED, immediately after it.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// Shared harness (mirrors scripts/tests/h22-dispatch-register.test.mjs and
// scripts/tests/h22-review-ledger.test.mjs; reused, not modified).
// ---------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-territory-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [H22_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function h22Input(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStart',
    ...over,
  };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function readRegister(dir) {
  return JSON.parse(readFileSync(registerPath(dir), 'utf8'));
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const taskLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const taskBlock = (name, prompt) => ({ type: 'tool_use', name, input: { prompt } });
// Typed variant (mirrors scripts/tests/h22-attribution.test.mjs's local
// taskBlockTyped) — carries subagent_type so several blocks in one message
// can be forced into the SAME-TYPE union path for the multi-block arms below.
const taskBlockTyped = (name, subagent_type, prompt) => ({ type: 'tool_use', name, input: { subagent_type, prompt } });
function multiDispatch(dir, blocks) {
  writeParentTranscript(dir, [taskLine(blocks)]);
}

// Store-root ledger — deliberately NOT under .sterling/transient/ (mirrors
// scripts/tests/h22-review-ledger.test.mjs).
function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function ledgerExists(dir) {
  return existsSync(ledgerPath(dir));
}
function readLedger(dir) {
  return JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
}
function registerEntry(agentId, agentType, files, filesSource, at = new Date().toISOString()) {
  return { agent_id: agentId, agent_type: agentType, session_id: 's1', files, files_source: filesSource, at };
}

function singleDispatch(dir, prompt) {
  writeParentTranscript(dir, [taskLine([taskBlock('Task', prompt)])]);
}

function entryFor(dir, agentId) {
  const reg = readRegister(dir);
  const entry = reg.find((e) => e.agent_id === agentId);
  assert.ok(entry, `entry for ${agentId} was appended to the register`);
  return entry;
}

// ===========================================================================
// (T-CONTROL) CONTROL, PLACED FIRST: no marker at all — free-prose extraction
// over the whole prompt is completely unaffected by the new marker-parsing
// logic. Passes today for a DIFFERENT, simpler reason than every test below
// it: nothing here exercises REVIEW-TERRITORY parsing at all.
//
// EXPECTED STATE: GREEN today and after the fix.
// SABOTAGE THAT MUST NOT FLIP THIS RED: none — this is the regression net.
// But it DOES catch one dangerous class of bug on its own: an
// implementation that treats "no REVIEW-TERRITORY line found" as though it
// were "an empty declaration was found" (conflating absence with `[]`, the
// exact conflation item 3 warns against) would empty this entry's files to
// [] instead of leaving free-prose extraction alone — that single-line
// mistake (short-circuiting to files: [] whenever the marker regex fails to
// match, instead of falling through to the pre-existing extractor) is what
// this control would catch if introduced.
// ===========================================================================

test('(T-control) CONTROL: a block prompt with no REVIEW-TERRITORY marker still yields free-prose extraction, completely unaffected', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = 'Please review scripts/foo-review.mjs and note scripts/decoy-analysis.mjs was discussed earlier.';
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-control' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-control');
    assert.deepEqual(
      [...entry.files].sort(),
      ['scripts/decoy-analysis.mjs', 'scripts/foo-review.mjs'],
      'free-prose extraction over the whole prompt is unaffected when no marker is present'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T-control-fallback-source) contract item 4's other half: the no-marker
// case gains files_source: "free-prose-fallback" — a brand-new field, so
// this one CANNOT be green today (the field does not exist at all), unlike
// the control above which asserts only pre-existing behavior.
//
// EXPECTED RED today: `files_source` is undefined on today's entry. Fails at
// `assert.equal(entry.files_source, 'free-prose-fallback')`.
// SABOTAGE: after landing the fix, delete the `files_source: 'free-prose-fallback'`
// assignment on the no-marker branch (leave the field unset for that branch
// only) — flips this back to RED without touching the marker-present branches.
// ===========================================================================

test('(contract item 4) a no-marker prompt records files_source: "free-prose-fallback" (new field)', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'Please review scripts/foo-review.mjs, no special declaration here.');
    const r = runHook(h22Input(dir, { agent_id: 'agent-nomarker' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-nomarker');
    assert.equal(entry.files_source, 'free-prose-fallback');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T1) marker with two declared paths: files[] comes ONLY from the array; a
// decoy path present in the surrounding prose is ignored entirely.
//
// EXPECTED RED today: today's context-free regex scans the WHOLE prompt, so
// it matches the two declared paths (they are valid path-like substrings
// even inside JSON syntax) AND the decoy path in the trailing sentence,
// producing a THREE-element files list. Fails first at the `deepEqual`
// against the two-element expected list (three != two), and again at
// `entry.files_source` (undefined today).
// SABOTAGE: remove the "prefer REVIEW-TERRITORY over free-prose when a
// marker line is present" precedence check (always run free-prose
// extraction regardless of a marker) — the decoy path leaks back in and
// `!entry.files.includes('scripts/decoy-analysis.mjs')` goes false.
// ===========================================================================

test('(T1) marker with two declared paths: files[] is exactly those two; a decoy path in the surrounding prose is ignored', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Please review the recent diff for correctness.',
      'REVIEW-TERRITORY: ["packages/mcp-server/src/auth.ts", "packages/schemas/src/auth.ts"]',
      'FYI scripts/decoy-analysis.mjs was mentioned in an earlier, unrelated message.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t1' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t1');
    assert.deepEqual(
      [...entry.files].sort(),
      ['packages/mcp-server/src/auth.ts', 'packages/schemas/src/auth.ts'],
      'files[] comes only from the parsed REVIEW-TERRITORY array'
    );
    assert.ok(!entry.files.includes('scripts/decoy-analysis.mjs'), 'a decoy path in the surrounding prose is never included once a marker is present');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T2) marker with an explicit empty array: files: [] and
// files_source: "review-territory" — NOT conflated with "no marker at all"
// (which would fall back to free-prose and pick up the decoy path).
//
// EXPECTED RED today: today's regex still matches the decoy path in the
// trailing sentence, producing files: ['scripts/decoy-analysis.mjs'] instead
// of []. Fails at `assert.deepEqual(entry.files, [])`.
// SABOTAGE: treat `REVIEW-TERRITORY: []` as though the marker were
// absent/malformed and fall through to free-prose extraction instead of
// honoring the explicit empty declaration — this is exactly the test this
// pin exists to catch.
// ===========================================================================

test('(T2) marker with an explicit empty array is a valid declaration: files: [], files_source: "review-territory"', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'This is an audit-only pass; no specific files are pre-declared.',
      'REVIEW-TERRITORY: []',
      'scripts/decoy-analysis.mjs is referenced here for context only.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t2' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t2');
    assert.deepEqual(entry.files, [], 'an explicit REVIEW-TERRITORY: [] is a deliberate empty declaration, not "no declaration"');
    assert.equal(entry.files_source, 'review-territory', 'the empty declaration still records provenance as review-territory, never free-prose-fallback');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T3) malformed declarations: unparseable JSON, valid-but-non-array JSON,
// and a valid array with a non-string element. All three must fall back to
// free-prose extraction (files_source: "free-prose-fallback") AND cause a
// loud stderr line naming the malformed declaration — H22 never denies, but
// it must never silently swallow a broken declaration either.
//
// EXPECTED RED today for all three variants: today's hook has no
// REVIEW-TERRITORY awareness at all, so `entry.files_source` is undefined
// (fails the equality assertion) and stderr is empty (fails both stderr
// `match` assertions). The `files.includes(decoy)` assertion is expected to
// already hold today (the decoy is picked up by the pre-existing regex
// regardless), so it is NOT the RED trigger — noted per-test below.
// SABOTAGE (shared): swallow the JSON.parse failure / skip the
// Array.isArray-and-every-element-is-a-string validation and silently treat
// the result as an empty review-territory declaration (files: [],
// files_source: 'review-territory') instead of falling back to free-prose
// with a warning — flips `files_source` back to 'review-territory' and
// removes the stderr warning, without changing the files LIST enough to be
// caught by casual inspection.
// ===========================================================================

function assertMalformedFallback(dir, agentId, prompt, decoyPath) {
  const r = runHook(h22Input(dir, { agent_id: agentId }), dir);
  assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even on a malformed declaration');
  const entry = entryFor(dir, agentId);
  assert.ok(entry.files.includes(decoyPath), 'fallback recovers the free-prose path when the declaration is unusable (expected to already hold today)');
  assert.equal(entry.files_source, 'free-prose-fallback', 'a malformed declaration is never silently treated as a valid review-territory declaration');
  assert.match(r.stderr, /REVIEW-TERRITORY/, 'the malformed declaration is named loudly on stderr, not silently swallowed');
  return r;
}

test('(T3a) malformed: unparseable JSON falls back to free-prose extraction and warns loudly, naming the bad line', () => {
  const { dir, cleanup } = makeProject();
  try {
    const badLine = 'REVIEW-TERRITORY: [not-json';
    const prompt = ['Please review the changes below.', badLine, 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
    singleDispatch(dir, prompt);
    const r = assertMalformedFallback(dir, 'agent-t3a', prompt, 'scripts/decoy-analysis.mjs');
    assert.match(r.stderr, /\[not-json/, 'the warning names the actual malformed content, not a generic message');
  } finally {
    cleanup();
  }
});

test('(T3b) malformed: valid JSON that is not an array falls back to free-prose extraction and warns loudly', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Please review the changes below.', 'REVIEW-TERRITORY: {"a": 1}', 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
    singleDispatch(dir, prompt);
    assertMalformedFallback(dir, 'agent-t3b', prompt, 'scripts/decoy-analysis.mjs');
  } finally {
    cleanup();
  }
});

test('(T3c) malformed: an array containing a non-string element falls back to free-prose extraction and warns loudly', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Please review the changes below.', 'REVIEW-TERRITORY: ["scripts/ok.mjs", 42]', 'scripts/decoy-analysis.mjs is the actual file to review.'].join(
      '\n'
    );
    singleDispatch(dir, prompt);
    assertMalformedFallback(dir, 'agent-t3c', prompt, 'scripts/decoy-analysis.mjs');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T4) a declared REVIEW-TERRITORY path that does not exist anywhere on disk
// survives into files[] unchanged — no filesystem-existence filtering.
//
// EXPECTED RED today: the free-prose regex would ALSO happen to match this
// exact path-like substring inside the JSON array text, so `entry.files`
// today may coincidentally already equal the expected one-element array —
// that assertion is NOT what makes this test RED. The RED trigger is
// `entry.files_source`, which is undefined today (files_source does not
// exist as a field at all pre-fix).
// SABOTAGE: add an `fs.existsSync` filter after parsing the declared array
// that drops any path not present on disk — flips `entry.files` from
// `['scripts/this-file-does-not-exist-anywhere.mjs']` to `[]`.
// ===========================================================================

test('(T4) a declared path that does not exist on disk survives into files[] unchanged — no filesystem-existence filtering', () => {
  const { dir, cleanup } = makeProject();
  try {
    const declaredPath = 'scripts/this-file-does-not-exist-anywhere.mjs';
    assert.equal(existsSync(join(dir, declaredPath)), false, 'precondition: the declared path genuinely does not exist in this fixture project');
    const prompt = ['Please review the deleted/renamed file below.', `REVIEW-TERRITORY: ["${declaredPath}"]`].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t4' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t4');
    assert.deepEqual(entry.files, [declaredPath], 'a declared path with no existence check keeps a legitimately-reviewed deleted/renamed file reviewable');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T5) SubagentStop reviewer-* ledger promotion copies files_source into the
// receipt unchanged. Reachable via the same seed-the-register-directly
// pattern scripts/tests/h22-review-ledger.test.mjs already uses for the
// promotion path (that file does not re-derive the transcript-extraction
// path either — promotion is exercised independently of how `files`/
// `files_source` were originally computed).
//
// EXPECTED RED today: the current promotion path builds the ledger entry as
// exactly {agent_type, files, at, base_sha, branch, session_id} (six keys,
// per decision review-ledger-receipt-expiry / 0408b295's pin in
// scripts/tests/h22-review-ledger.test.mjs) — `files_source` is never copied,
// so `entry.files_source` on the promoted ledger record is undefined. Fails
// at `assert.equal(entry.files_source, 'review-territory')`.
// SABOTAGE: omit `files_source` from the object literal that builds the
// promoted ledger entry at SubagentStop (copy every other field, drop this
// one) — the six-key shape stays intact but this pin goes red.
// ===========================================================================

test('(T5) SubagentStop promotion copies files_source into the review-ledger receipt unchanged', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry('rev-rt-1', 'reviewer-correctness', ['packages/mcp-server/src/auth.ts'], 'review-territory', '2026-08-28T00:00:00.000Z'),
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-rt-1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a review ledger receipt was promoted');
    const ledger = readLedger(dir);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): a v2-promoted entry carries files/files_source at territory.files/territory.source. Dual-shape
    // lookup preserves this test's substance (decision 8f137474's structured-territory extraction, unchanged) for
    // either shape.
    const entry = ledger.find((e) => {
      const files = e.territory?.files ?? e.files;
      return Array.isArray(files) && files.includes('packages/mcp-server/src/auth.ts');
    });
    assert.ok(entry, 'the promoted receipt is present in the ledger');
    assert.equal(entry.territory?.source ?? entry.files_source, 'review-territory', 'files_source travels unchanged from the register entry to the promoted ledger receipt');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T5b) COMPANION ARM to T5, requested by review: a reviewer-* dispatch that
// was NEVER marker-declared (files_source: "free-prose-fallback" on the
// register entry) must promote that SAME value into the ledger — a
// hardcoded 'review-territory' in the promotion path passes T5 alone but
// fails this arm, which is exactly why the two arms exist together.
//
// EXPECTED RED today: files_source does not exist as a field at all
// pre-fix, so the promoted entry's `files_source` is undefined. Fails at
// `assert.equal(entry.files_source, 'free-prose-fallback')`.
// SABOTAGE: hardcode `files_source: 'review-territory'` in the promotion
// object literal instead of copying `entry.files_source` — T5 (which seeds
// 'review-territory') would stay green, but this arm goes red.
// ===========================================================================

test('(T5b) SubagentStop promotion of a free-prose-fallback reviewer entry copies files_source: "free-prose-fallback" unchanged (companion to T5, catches a hardcoded value)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry('rev-rt-2', 'reviewer-security', ['scripts/decoy-analysis.mjs'], 'free-prose-fallback', '2026-08-28T00:01:00.000Z'),
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-rt-2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a review ledger receipt was promoted');
    const ledger = readLedger(dir);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): a v2-promoted entry carries files/files_source at territory.files/territory.source. Dual-shape
    // lookup preserves this test's substance for either shape.
    const entry = ledger.find((e) => {
      const files = e.territory?.files ?? e.files;
      return Array.isArray(files) && files.includes('scripts/decoy-analysis.mjs');
    });
    assert.ok(entry, 'the promoted receipt is present in the ledger');
    assert.equal(entry.territory?.source ?? entry.files_source, 'free-prose-fallback', 'a fallback-sourced register entry must never be promoted as though it were review-territory-sourced');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T6b) CONTROL, PLACED FIRST for the attribution-copy pair: a LEGACY
// register entry with NO `attribution` key at all must promote to a ledger
// entry that ALSO has no `attribution` key — never fabricated. This is
// GREEN both today (today's promotion never writes an `attribution` key for
// ANY input, so absence trivially holds) and after the fix (a correct
// implementation only copies the key when the source has it).
//
// EXPECTED STATE: GREEN today and after the fix.
// SABOTAGE: after landing the fix, always write `attribution: entry.attribution ?? 'union'`
// (fabricate a default when absent) — flips this control red, while leaving
// (T6a) below unaffected (it always supplies a real attribution value).
// ===========================================================================

test('(T6b) CONTROL: a legacy register entry with no `attribution` key promotes to a ledger entry with no `attribution` key either — never fabricated', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { agent_id: 'rev-legacy', agent_type: 'reviewer-correctness', session_id: 's1', files: ['src/legacy.mjs'], at: '2026-08-28T00:02:00.000Z' },
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-legacy', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedger(dir);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): a v2-promoted entry carries files/attribution at territory.files/territory.attribution. Dual-shape
    // lookup preserves this CONTROL's substance (no fabricated attribution) for either shape.
    const entry = ledger.find((e) => {
      const files = e.territory?.files ?? e.files;
      return Array.isArray(files) && files.includes('src/legacy.mjs');
    });
    assert.ok(entry, 'the promoted receipt is present in the ledger');
    const attributionHome = entry.territory ?? entry;
    assert.ok(!('attribution' in attributionHome), 'a legacy source entry lacking attribution must never gain a fabricated attribution key on promotion');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T6a) NEW PIN: the ledger receipt also carries the register entry's
// `attribution` value (e.g. 'union', the shape this harness's untyped
// taskBlock() naturally produces) — RED until the parallel coder lands it.
//
// EXPECTED RED today: today's promotion writes a fixed six-key object
// (agent_type/files/at/base_sha/branch/session_id per decision 0408b295)
// that never includes `attribution` for any input. Fails at
// `assert.equal(entry.attribution, 'union')` (undefined today).
// SABOTAGE: drop the `attribution: entry.attribution` copy from the
// promotion object literal (leave everything else) — flips this back red
// without touching (T6b)'s legacy-absence guarantee.
// ===========================================================================

test('(T6a) SubagentStop promotion copies the register entry\'s attribution value ("union") into the ledger receipt', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { agent_id: 'rev-attr', agent_type: 'reviewer-performance', session_id: 's1', files: ['src/attr.mjs'], files_source: 'free-prose-fallback', attribution: 'union', at: '2026-08-28T00:03:00.000Z' },
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-attr', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedger(dir);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): a v2-promoted entry carries files/attribution at territory.files/territory.attribution.
    const entry = ledger.find((e) => {
      const files = e.territory?.files ?? e.files;
      return Array.isArray(files) && files.includes('src/attr.mjs');
    });
    assert.ok(entry, 'the promoted receipt is present in the ledger');
    assert.equal(entry.territory?.attribution ?? entry.attribution, 'union', 'the register entry\'s attribution value is copied unchanged into the ledger receipt');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T7) COVERAGE GAP, multi-block arm: two same-type blocks in one dispatch
// message, ONE carries a valid REVIEW-TERRITORY declaration, the OTHER is
// plain prose with a sibling path and no marker at all. Per this spec, the
// entry's files must be EXACTLY the declared array — the sibling block's
// free-prose path is dropped entirely, files_source: "review-territory".
//
// EXPECTED RED today: today's per-block union merges the free-prose
// extraction of BOTH blocks regardless of any marker, so `entry.files`
// would be a TWO-element array (the declared path text also matches the
// plain-path regex, plus the sibling's prose path) instead of the expected
// one-element declared array. Fails at the `deepEqual` (2 != 1) and at
// `entry.files_source` (undefined today).
// SABOTAGE: when unioning several same-type blocks, never let a per-block
// REVIEW-TERRITORY override that BLOCK's contribution to the union — always
// union raw free-prose extraction across every block regardless of markers
// — the sibling's prose path leaks back into `entry.files`.
// ===========================================================================

test('(T7) multi-block: one same-type block declares REVIEW-TERRITORY, its sibling is plain prose — files[] is exactly the declared array, sibling prose dropped', () => {
  const { dir, cleanup } = makeProject();
  try {
    multiDispatch(dir, [
      taskBlockTyped('Task', 'coder', 'REVIEW-TERRITORY: ["packages/mcp-server/src/decl.ts"]\nPlease focus review on the declared scope only.'),
      taskBlockTyped('Task', 'coder', 'Also see scripts/sibling-prose.mjs for background context, no declaration here.'),
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t7', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t7');
    assert.deepEqual(entry.files, ['packages/mcp-server/src/decl.ts'], 'files[] is exactly the declared array; the sibling block\'s free-prose path is dropped entirely');
    assert.ok(!entry.files.includes('scripts/sibling-prose.mjs'), 'the marker-less sibling block never contributes a free-prose path once a co-block declaration exists');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T7b) COVERAGE GAP, valid+malformed siblings: one same-type block declares
// a VALID REVIEW-TERRITORY, its sibling carries a MALFORMED one. Per the
// review request: the declared (valid) array wins, and exactly ONE stderr
// warning fires (naming the malformed sibling's content) — no duplicate and
// no silent swallow.
//
// EXPECTED RED today: today has no REVIEW-TERRITORY awareness at all, so
// `entry.files` unions BOTH blocks' free-prose matches (the valid block's
// declared path plus the malformed sibling's other mentioned path,
// 'scripts/sibling-malformed.mjs') instead of the expected one-element
// valid array, `entry.files_source` is undefined, and stderr is empty
// (zero occurrences of the malformed content, not exactly one). Fails at
// the `deepEqual`, the `files_source` equality, and the occurrence-count
// assertion.
// SABOTAGE: when a valid declaration wins over a malformed sibling, warn
// once PER BLOCK instead of once per malformed declaration encountered (or
// vice versa: suppress the warning entirely because "another block already
// supplied files") — either change flips the occurrence-count assertion
// away from exactly 1.
// ===========================================================================

test('(T7b) multi-block: a valid REVIEW-TERRITORY sibling wins over a malformed one — declared array wins, exactly one stderr warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    multiDispatch(dir, [
      taskBlockTyped('Task', 'coder', 'REVIEW-TERRITORY: ["packages/mcp-server/src/decl.ts"]\nFocus on the declared scope.'),
      taskBlockTyped('Task', 'coder', 'REVIEW-TERRITORY: [not-json\nAlso scripts/sibling-malformed.mjs is unrelated context.'),
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t7b', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even with a malformed sibling declaration');
    const entry = entryFor(dir, 'agent-t7b');
    assert.deepEqual(entry.files, ['packages/mcp-server/src/decl.ts'], 'the valid declared array wins over the malformed sibling');
    assert.ok(!entry.files.includes('scripts/sibling-malformed.mjs'), 'the malformed sibling never contributes a free-prose fallback path once a valid co-block declaration wins');
    assert.equal(entry.files_source, 'review-territory');
    const occurrences = (r.stderr.match(/\[not-json/g) || []).length;
    assert.equal(occurrences, 1, 'exactly one stderr warning names the malformed sibling declaration — never zero (swallowed) and never duplicated');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P-path-shape) a declared path that is NOT repo-relative POSIX shape
// (parent traversal, absolute, or backslash-separated) is MALFORMED, not a
// valid declaration: falls back to free-prose extraction, files_source:
// "free-prose-fallback", plus a loud stderr warning — NEVER an authoritative
// files[] rewrite with files_source: "review-territory". This targets a
// specific implementation gap: JSON.parse succeeding + every element being a
// string is NOT sufficient validation — each string must also be checked for
// path shape.
//
// EXPECTED RED today (all three variants): `files_source` does not exist as
// a field at all pre-fix, so `entry.files_source` is undefined — fails the
// `assert.equal(entry.files_source, 'free-prose-fallback')` assertion. The
// decoy-inclusion assertion is expected to already hold today (the decoy
// sentence is picked up by the pre-existing regex regardless), so it is NOT
// the RED trigger. The stderr `match` assertion also fails today (nothing is
// emitted).
// SABOTAGE (shared across all three): after JSON.parse succeeds and every
// element is confirmed a string, skip validating each string's PATH SHAPE
// (no '..' traversal segment, no leading '/', no backslash) — the malformed
// path is accepted as a legitimate declaration, producing
// files_source: 'review-territory' with the bad path echoed into files[]
// instead of falling back with a warning.
// ===========================================================================

function assertPathShapeRejected(dir, agentId, badPath) {
  const prompt = ['Please review the diff below.', `REVIEW-TERRITORY: ["${badPath}"]`, 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
  singleDispatch(dir, prompt);
  const r = runHook(h22Input(dir, { agent_id: agentId }), dir);
  assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even on a path-shape-invalid declaration');
  const entry = entryFor(dir, agentId);
  assert.ok(entry.files.includes('scripts/decoy-analysis.mjs'), 'fallback recovers the free-prose path when the declared path shape is invalid');
  assert.equal(entry.files_source, 'free-prose-fallback', 'a path-shape-invalid declaration is never treated as authoritative review-territory');
  assert.match(r.stderr, /REVIEW-TERRITORY/, 'the rejected declaration is named loudly on stderr, not silently accepted');
  return r;
}

test('(P-path-shape-a) REVIEW-TERRITORY with a parent-traversal path ("../outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = assertPathShapeRejected(dir, 'agent-path-a', '../outside.mjs');
    assert.match(r.stderr, /\.\.\/outside\.mjs/, 'the warning names the actual rejected path');
  } finally {
    cleanup();
  }
});

test('(P-path-shape-b) REVIEW-TERRITORY with an absolute path ("/absolute/outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertPathShapeRejected(dir, 'agent-path-b', '/absolute/outside.mjs');
  } finally {
    cleanup();
  }
});

test('(P-path-shape-c) REVIEW-TERRITORY with a backslash-separated path ("scripts\\\\hooks\\\\outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertPathShapeRejected(dir, 'agent-path-c', 'scripts\\\\hooks\\\\outside.mjs');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P-newline-marker) the marker is anchored at line start AND requires the
// JSON array on the SAME line (per contract item 1: `REVIEW-TERRITORY: [...]`
// is one line). "REVIEW-TERRITORY:" followed by a newline and the array on
// the NEXT line is therefore NOT a declaration at all — it behaves as
// no-marker: free-prose extraction, files_source: "free-prose-fallback".
// Per the current contract reading, this should ALSO never be treated as
// "malformed" (no warning) — it simply never matched the marker shape in the
// first place, unlike (P-path-shape) or (T3) where a marker line WAS
// recognized and then rejected. Pinned as written; if a landed
// implementation instead warns here, that is a genuine reportable divergence
// from this reading, not a reason to weaken this assertion.
//
// EXPECTED RED today: `entry.files_source` is undefined (the field does not
// exist pre-fix) — fails `assert.equal(entry.files_source, 'free-prose-fallback')`.
// The files-list assertion is expected to already hold BOTH today and after
// the fix (free-prose extraction is unaffected either way, since no
// same-line marker exists to intercept it) — it is a regression net nested
// inside a RED pin, not itself the RED trigger. The no-warning assertion is
// expected to hold after a correct fix; if it fails, that failure IS the
// signal to report the divergence.
// SABOTAGE: loosen the marker-matching regex to span across a newline (e.g.
// match "REVIEW-TERRITORY:" followed by optional whitespace/newlines then
// the array on a LATER line) instead of requiring the array on the same
// line — flips `entry.files` to the single declared path and
// `entry.files_source` to 'review-territory', failing both assertions that
// currently expect the unaffected free-prose union.
// ===========================================================================

test('(P-newline-marker) "REVIEW-TERRITORY:" with the array on the NEXT line is not a declaration — behaves as no-marker (free-prose fallback, ideally no warning)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Please review the diff below.',
      'REVIEW-TERRITORY:',
      '["packages/mcp-server/src/newline.ts"]',
      'scripts/decoy-analysis.mjs is mentioned here for context.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-newline' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-newline');
    assert.deepEqual(
      [...entry.files].sort(),
      ['packages/mcp-server/src/newline.ts', 'scripts/decoy-analysis.mjs'],
      'free-prose extraction over the whole prompt is unaffected — the split-line marker never intercepts it'
    );
    assert.equal(entry.files_source, 'free-prose-fallback', 'a marker split across lines is not a declaration at all — it is the ordinary no-marker case');
    assert.doesNotMatch(r.stderr, /REVIEW-TERRITORY/, 'per the current contract reading this is not a recognized-then-rejected marker, so no warning should fire — a failure here is a reportable divergence, not a reason to weaken this assertion');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DISCLOSED AS UNPINNED — multiple REVIEW-TERRITORY lines within a SINGLE
// block's prompt (e.g. two separate `REVIEW-TERRITORY: [...]` lines in one
// dispatch prompt). Requested precedence to pin: "first marker wins".
// NOT PINNED: the governing contract (decision 8f137474, items 1-7, and the
// launching brief's 7-item list) never specifies a precedence rule for two
// marker lines in one prompt — it describes exactly one marker per block
// throughout. Pinning "first wins" (or "last wins") here would fabricate a
// behavior the spec never authorized, which this role's anti-invention
// constraint forbids. This is left for a follow-up decision record naming
// the intended precedence before it is pinned.
// ===========================================================================
