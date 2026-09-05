// H22 REVIEW-RECEIPT LEDGER PROMOTION (part A of decision
// 12a26ca6-a301-466d-a45c-5e1eeff36694, slug review-receipt-ledger; board
// 7814acc3-bb22-4cc5-abd7-789d6396743f) — SPEC ONLY, red-first.
//
// Spec under test (given by the launching agent, verified against the
// decision record above — not inferred from any implementation):
//
//   At SubagentStop, when the departing register entry's agent_type starts
//   with the literal prefix 'reviewer-' (roster: reviewer-correctness,
//   reviewer-security, reviewer-skeptic, reviewer-performance), the entry is
//   PROMOTED — appended as exactly {agent_type, files, at} (three fields,
//   NOT the register's agent_id/session_id) to a durable ledger at
//   .sterling/review-ledger.json (STORE ROOT — deliberately NOT under
//   .sterling/transient/, so H1's session wipe of the transient tree never
//   touches it) — and THEN removed from the register exactly as today.
//   Non-reviewer entries keep the delete-only path: the register entry is
//   removed, and the ledger file is left completely alone — never created
//   if it did not already exist, never appended to if it did. Ledger reads
//   tolerate a malformed/missing ledger (treated as empty, never a crash;
//   the hook must not exit 2 for this).
//
// scripts/hooks/h22-dispatch-register.mjs ALREADY EXISTS (it implements the
// register append/delete/prune behavior covered by
// scripts/tests/h22-dispatch-register.test.mjs) but, as of this writing, has
// NO notion of a review ledger at all — every promotion-shaped assertion
// below is expected to fail red against today's delete-only SubagentStop
// path: the ledger file this spec expects is never created/appended, so
// existsSync(ledgerPath) or its parsed contents come back false/empty where
// a promoted entry is expected. Confirmed by reading (not modifying)
// scripts/tests/h22-dispatch-register.test.mjs, whose own header states the
// register's SubagentStop is "removes the entry ... ; no match is a clean
// no-op" — no ledger promotion is described there.
//
// Harness idiom (spawnSync + JSON stdin + temp project dir) is adapted from
// scripts/tests/h22-dispatch-register.test.mjs's runHook/h22Input/
// registerPath/writeRegisterRaw helpers WITHOUT importing or modifying that
// file (mirrors the standalone-file convention used by
// scripts/tests/merge-review-receipts-hardening.test.mjs relative to
// scripts/tests/merge-review-receipts.test.mjs). This file seeds the
// register directly via writeRegisterRaw rather than re-deriving the
// transcript-extraction path (that extraction behavior is already covered
// by scripts/tests/h22-dispatch-register.test.mjs and is out of scope here
// — this file is scoped to the NEW ledger-promotion behavior only).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-ledger-'));
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
  const r = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
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
    hook_event_name: 'SubagentStop',
    ...over,
  };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function readRegister(dir) {
  return existsSync(registerPath(dir)) ? JSON.parse(readFileSync(registerPath(dir), 'utf8')) : null;
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

// Store-ROOT ledger — deliberately NOT under .sterling/transient/.
function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function ledgerExists(dir) {
  return existsSync(ledgerPath(dir));
}
function readLedgerRaw(dir) {
  return readFileSync(ledgerPath(dir), 'utf8');
}
function readLedger(dir) {
  return JSON.parse(readLedgerRaw(dir));
}
function writeLedgerRaw(dir, content) {
  writeFileSync(ledgerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

const registerEntry = (agentId, agentType, files, at = new Date().toISOString()) => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: 's1',
  files,
  at,
});

// ===========================================================================
// (1) A single reviewer-class SubagentStop promotes {agent_type, files, at}
//     into the ledger and removes the register entry.
// ===========================================================================

test('H22 ledger: SubagentStop for a reviewer-* entry PROMOTES it into .sterling/review-ledger.json as a v2 entry (schema_version/entry_id/kind/status/started_at/finished_at/reviewer/identity/territory/content_evidence/disposition, per decision 57984926) and removes the register entry', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-1', 'reviewer-correctness', ['src/a.mjs', 'src/b.mjs'], '2026-08-22T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-1', hook_event_name: 'SubagentStop' }), dir);
    // EXPECTED FAILURE SHAPE (today): the hook has no ledger-promotion logic,
    // so it exits 0 exactly as before but ledgerExists(dir) stays false —
    // this assert.ok fires first.
    assert.equal(r.code, 0, r.stderr);
    assert.ok(ledgerExists(dir), 'a durable review ledger is created at .sterling/review-ledger.json (store root)');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    const entry = ledger[0];
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): promotions now write the v2 entry envelope, not the flat six-key shape decision 0408b295 pinned.
    // The flat concerns this pin originally guarded (agent_type/at/base_sha/branch/files/session_id) now live at
    // their v2 homes (reviewer.agent_type, started_at, identity.{base_sha,branch,session_id}, territory.files) —
    // same INTENT (no unexpected extra top-level junk on a promotion), pinned against the ruled contract.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['content_evidence', 'disposition', 'entry_id', 'finished_at', 'identity', 'kind', 'reviewer', 'schema_version', 'started_at', 'status', 'territory'],
      'decision 57984926: every new promotion is a v2 entry — exactly these eleven top-level keys, nothing extra'
    );
    assert.equal(entry.reviewer.agent_type, 'reviewer-correctness');
    assert.deepEqual(entry.territory.files, ['src/a.mjs', 'src/b.mjs']);
    assert.equal(entry.started_at, '2026-08-22T00:00:00.000Z');

    const reg = readRegister(dir);
    assert.deepEqual(reg, [], 'the promoted entry is also removed from the in-flight register, exactly as the pre-existing delete-only path did');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) Multiple reviewer stops accumulate in the ledger (append, in order).
// ===========================================================================

test('H22 ledger: two reviewer-* SubagentStop events accumulate two ledger entries in order', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry('rev-1', 'reviewer-security', ['src/a.mjs'], '2026-08-22T00:00:00.000Z'),
      registerEntry('rev-2', 'reviewer-performance', ['src/b.mjs'], '2026-08-22T00:01:00.000Z'),
    ]);

    let r = runHook(h22Input(dir, { agent_id: 'rev-1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    r = runHook(h22Input(dir, { agent_id: 'rev-2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE (today): readLedger throws (file never created)
    // or, once a partial fix lands, comes back with fewer than 2 entries.
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'both reviewer stops accumulate — the second promotion never clobbers the first');
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): agent_type now lives at reviewer.agent_type on a v2-promoted entry.
    assert.deepEqual(ledger.map((e) => e.reviewer.agent_type), ['reviewer-security', 'reviewer-performance'], 'append order matches stop order');

    assert.deepEqual(readRegister(dir), [], 'both entries removed from the register');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (3) Non-reviewer entries keep the delete-only path: no ledger is ever
//     created for them.
// ===========================================================================

test('H22 ledger: a non-reviewer SubagentStop (agent_type "coder") is delete-only — no ledger file is created at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('c-1', 'coder', ['src/x.mjs'])]);
    assert.equal(ledgerExists(dir), false, 'precondition: no ledger exists yet');

    const r = runHook(h22Input(dir, { agent_id: 'c-1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE (today): this assertion already holds today
    // (the current hook never creates a ledger for anyone) — it is a
    // regression pin, not a red-today assertion, and must keep holding once
    // the promotion path ships.
    assert.equal(ledgerExists(dir), false, 'a non-reviewer promotion must never fabricate a ledger file');
    assert.deepEqual(readRegister(dir), [], 'the register entry is still removed exactly as today');
  } finally {
    cleanup();
  }
});

test('H22 ledger: a non-reviewer SubagentStop leaves a PRE-EXISTING ledger completely untouched (byte-identical)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const preExisting = [{ agent_type: 'reviewer-skeptic', files: ['src/prior.mjs'], at: '2026-08-21T00:00:00.000Z' }];
    writeLedgerRaw(dir, preExisting);
    const before = readLedgerRaw(dir);

    writeRegisterRaw(dir, [registerEntry('c-2', 'coder', ['src/y.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'c-2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE: today's hook does not touch the ledger for any
    // agent_type, so this already holds — a regression pin against an
    // over-eager implementation that appends/rewrites on EVERY stop
    // regardless of agent_type.
    assert.equal(readLedgerRaw(dir), before, 'byte-identical — a non-reviewer stop must not rewrite an existing ledger at all');
    assert.deepEqual(readRegister(dir), [], 'the register entry is still removed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) Prefix boundary: "reviewer" without the trailing hyphen is NOT
//     promoted — the spec's prefix is the literal string 'reviewer-'.
// ===========================================================================

test('H22 ledger: agent_type "reviewer" (no trailing hyphen) does NOT match the reviewer-* prefix — delete-only, no ledger created', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('r-bare', 'reviewer', ['src/z.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'r-bare', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    // EXPECTED FAILURE SHAPE: only fails red if a naive implementation uses a
    // loose "includes/startsWith('reviewer')" match instead of the exact
    // 'reviewer-' prefix; asserted here as a precise boundary pin regardless.
    assert.equal(ledgerExists(dir), false, "'reviewer' alone is not a member of the reviewer-* roster prefix");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (5) Ledger append never clobbers what was already there.
// ===========================================================================

test('H22 ledger: promoting a new reviewer entry APPENDS to a pre-populated ledger — the prior entry survives untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    const priorEntry = { agent_type: 'reviewer-correctness', files: ['src/prior.mjs'], at: '2026-08-20T00:00:00.000Z' };
    writeLedgerRaw(dir, [priorEntry]);

    writeRegisterRaw(dir, [registerEntry('rev-new', 'reviewer-security', ['src/new.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-new', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    // EXPECTED FAILURE SHAPE: today's hook has no ledger at all, so
    // readLedger(dir) either throws (no file) — the promotion path does not
    // exist yet to have produced one.
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'append, not overwrite');
    assert.deepEqual(ledger[0], priorEntry, 'the pre-existing entry is byte-for-byte preserved');
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): ledger[1] is the NEW promotion, so it is v2-shaped (agent_type/files live under
    // reviewer.agent_type/territory.files) — ledger[0] above is the PRE-EXISTING v1 fixture and stays flat, untouched.
    assert.equal(ledger[1].reviewer.agent_type, 'reviewer-security');
    assert.deepEqual(ledger[1].territory.files, ['src/new.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (6) Malformed ledger degrades to empty — never a crash, never exit 2.
// ===========================================================================

test('H22 ledger: a malformed (corrupt JSON) pre-existing ledger is tolerated — treated as empty, promotion still succeeds, hook never exits 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLedgerRaw(dir, '{ this is not valid json at all');
    writeRegisterRaw(dir, [registerEntry('rev-heal', 'reviewer-performance', ['src/heal.mjs'], '2026-08-22T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-heal', hook_event_name: 'SubagentStop' }), dir);
    // EXPECTED FAILURE SHAPE: today's hook does not read/write the ledger at
    // all, so this exit-code assertion trivially holds (0) but the
    // downstream ledger-shape assertions below fail red (no promotion logic
    // exists to recover from the corruption and append).
    assert.notEqual(r.code, 2, 'a corrupt ledger must never cause the hook to deny/crash the spawn boundary');
    assert.equal(r.code, 0, r.stderr);

    let ledger;
    assert.doesNotThrow(() => {
      ledger = JSON.parse(readLedgerRaw(dir));
    }, 'the ledger left behind after recovery must itself be valid JSON');
    assert.ok(Array.isArray(ledger));
    assert.equal(ledger.length, 1, 'the corrupt prior content is discarded (treated as empty), not salvaged into a longer array');
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): the sole surviving entry is the NEW promotion, v2-shaped.
    assert.equal(ledger[0].reviewer.agent_type, 'reviewer-performance');
    assert.deepEqual(ledger[0].territory.files, ['src/heal.mjs']);
  } finally {
    cleanup();
  }
});

test('H22 ledger: a MISSING ledger file is tolerated identically to an empty one on first promotion', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(ledgerExists(dir), false);
    writeRegisterRaw(dir, [registerEntry('rev-first', 'reviewer-skeptic', ['src/first.mjs'], '2026-08-22T00:00:00.000Z')]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-first', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    // EXPECTED FAILURE SHAPE: ledgerExists(dir) stays false today — no
    // promotion logic exists yet to create the file on a missing-ledger first run.
    assert.ok(ledgerExists(dir), 'a first promotion creates the ledger file from nothing');
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): the first-ever promotion is v2-shaped.
    assert.equal(ledger[0].reviewer.agent_type, 'reviewer-skeptic');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (7) An unmatched agent_id at SubagentStop remains a clean no-op for the
//     ledger too (regression pin against the pre-existing no-op contract).
// ===========================================================================

test('H22 ledger: SubagentStop with an unmatched agent_id is a clean no-op — no ledger created, register unchanged', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-x', 'reviewer-correctness', ['src/x.mjs'])]);
    const r = runHook(h22Input(dir, { agent_id: 'nonexistent', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ledgerExists(dir), false, 'no match, no promotion');
    const reg = readRegister(dir);
    assert.equal(reg.length, 1);
    assert.equal(reg[0].agent_id, 'rev-x', 'the unmatched stop leaves the real reviewer entry live, still eligible for a later, matching stop');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUMED REVIEWER — SubagentStop REFRESH of an existing ledger entry
// (board c9f92090, slice 2, spec item (c)). SPEC ONLY, red-first — authored
// from the board record (opened via board_get), not from
// scripts/hooks/h22-dispatch-register.mjs's internals (H4 read wall honored:
// that hook was never opened by this file's author).
//
// SPEC UNDER TEST (board c9f92090, verbatim clause (c)):
//   "a second SubagentStop for the same agent_id REFRESHES the existing
//    ledger entry (finished_at, content_evidence, observed_* as UNION,
//    resume_count incremented) and never changes entry_id, identity.*,
//    reviewer.* or declared territory.files; fail-closed arms: discharged
//    entry -> skipped loudly (unchanged), different branch -> refused with a
//    warning (unchanged), legacy v1 shape -> skipped loudly, consumed
//    (deleted) receipt -> a NEW receipt is minted (correct second round)."
//
// The register entry for a resumed reviewer's SECOND Stop is deliberately
// NOT re-seeded in most pins below: the board's own probe note records that
// the register entry is removed at the FIRST Stop, so a refresh must be
// found via the LEDGER's own identity.agent_id, never via register
// presence — RESUME-CONSUMED is the one arm that re-seeds the register, to
// prove the opposite boundary (neither a register entry nor a matching
// ledger entry -> a genuinely fresh promotion, not a no-op).
//
// SCOPE NOTE (ambiguity flagged, not resolved): observed_files/observed_source
// (decision review-territory-observed-evidence 9500cce1) are deliberately NOT
// asserted here. That mechanism reads stdin.agent_transcript_path via a lib
// this suite does not exercise, and scripts/tests/h22-ledger-v2-entry.test.mjs's
// OWN reviewer-model-provenance pins already read the DIFFERENT
// `transcript_path` key at Stop for a DIFFERENT purpose (model observation) —
// stacking a third transcript-shaped fixture on an already-ambiguous field
// convention risks a wrong-field pin more than it proves anything new. The
// board's parenthetical "observed_* as UNION" is reported, not resolved.
//
// Harness: registerEntry()/writeRegisterRaw()/runHook()/h22Input()/
// readRegister()/readLedger()/readLedgerRaw()/writeLedgerRaw() are this
// file's OWN existing helpers above, reused unmodified. git()/
// makeGitProject() are NEW, added only for RESUME-BRANCH-MISMATCH, adapted
// from scripts/tests/h22-receipt-expiry.test.mjs's makeGitProject idiom
// without importing that file.
// ===========================================================================

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProject(branchName = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-ledger-resume-'));
  git(dir, ['init', '-b', branchName]);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'seed']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// RESUME-CONTROL, placed FIRST: a Stop for a DIFFERENT agent_id must never
// touch an unrelated existing ledger entry. Without this control, a green
// RESUME-1 below is indistinguishable from "any second reviewer Stop
// refreshes the most recent/any existing entry", which would silently
// corrupt an unrelated receipt.
// SABOTAGE: key the refresh match on agent_type (or on "the most recently
// promoted entry") instead of on identity.agent_id — entryA would be
// mutated by entryB's unrelated first-ever Stop, reddening the
// byte-identical assertion below.
// ===========================================================================

test('RESUME-CONTROL (placed FIRST): a Stop for a DIFFERENT agent_id never touches an unrelated existing ledger entry — refresh is keyed on identity, not on "any second reviewer Stop"', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-ctrl-a', 'reviewer-correctness', ['src/a.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-ctrl-a', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const before = readLedger(dir);
    assert.equal(before.length, 1);
    const beforeSnapshot = JSON.stringify(before[0]);

    // A DIFFERENT agent_id's first-ever promotion must never touch A's entry.
    writeRegisterRaw(dir, [registerEntry('rev-ctrl-b', 'reviewer-security', ['src/b.mjs'], '2026-08-22T00:05:00.000Z')]);
    r = runHook(h22Input(dir, { agent_id: 'rev-ctrl-b', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const after = readLedger(dir);
    assert.equal(after.length, 2, 'two distinct entries — not a refresh-in-place of A');
    const aAfter = after.find((e) => e.reviewer?.agent_type === 'reviewer-correctness');
    assert.ok(aAfter, 'the original A entry is still present');
    assert.equal(JSON.stringify(aAfter), beforeSnapshot, "A's entry is byte-identical — a different agent_id's Stop never refreshes it");
    const bAfter = after.find((e) => e.reviewer?.agent_type === 'reviewer-security');
    assert.ok(bAfter, 'B is a genuine NEW promotion');
    assert.ok(!('resume_count' in bAfter), 'a first-ever promotion is never itself a "resume" — resume_count is absent');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUME-1 — RE-CUT (decision 77c5b85a, board c9f92090 clause (b), after the
// H22 receipt-identity fix round).
//
// OLD PREMISE: any second SubagentStop for the same agent_id unconditionally
// RECOMPUTES content_evidence against the file's current on-disk bytes,
// regardless of whether the resumed reviewer's own transcript shows it
// actually re-read the changed path this round. The single assertion this
// used to pin — `assert.notDeepEqual(entry2.content_evidence,
// entry1.content_evidence)` after changing the file with NO transcript
// supplied at all — is satisfiable by a resumed reviewer that never looked
// at the file again: the receipt would silently vouch for bytes nobody
// reviewed.
//
// NEW PREMISE: a changed sha is accepted into content_evidence ONLY when the
// path is among this round's OBSERVED READS (Read/Grep/Glob tool uses in the
// agent transcript at stdin.agent_transcript_path); otherwise the PRIOR sha
// stands, the refusal accumulates into a top-level `rebaseline_refused`
// array on the entry ({path, prior_sha, current_sha, round}), and the
// withholding is disclosed on stderr. A path with no prior sha gets no fresh
// binding either way (nothing to launder there).
//
// CLAIM: the OLD single assertion encoded exactly the laundering the fix
// closes — recomputing evidence with zero proof anyone looked. The three
// tests below replace it: (a) proves the honest path still works (real
// transcript evidence -> real recompute); (b) proves the dishonest path is
// now refused (no evidence -> prior sha stands, refusal disclosed) — this is
// the re-cut assertion itself, now asserting the OPPOSITE of what it used to;
// (c) is the CONTROL, proving (a)/(b) are not simply "always keep the old
// sha" or "always take the new one" in disguise — an unchanged file must
// never need a refusal at all, which only holds if the guard actually
// compares SHAS, not merely "was transcript evidence supplied".
// ===========================================================================

// Minimal tool_use-block transcript writer for the resumed agent's OWN
// transcript (stdin.agent_transcript_path) — mirrors the
// scripts/tests/h22-observed-territory.test.mjs writeToolBlockTranscript
// idiom, reproduced standalone here rather than imported.
function writeAgentTranscript(dir, name, blocks) {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, blocks.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const readBlock = (absPath) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: absPath } }] } });

// SABOTAGE: recompute content_evidence unconditionally on every resume
// regardless of transcript evidence (the OLD behavior) — RESUME-1b below
// goes red (blobs would show the NEW sha, not the prior one; no
// rebaseline_refused record; no REFUSED TO REBASELINE disclosure).
test('RESUME-1a (rebaseline-on-evidence): a resumed reviewer whose OWN transcript shows a Read of the changed path this round gets a genuinely RECOMPUTED sha — no rebaseline_refused', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'resume.mjs'), 'v1 content\n');

    writeRegisterRaw(dir, [registerEntry('rev-resume-a', 'reviewer-correctness', ['src/resume.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-resume-a', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir)[0];
    assert.ok(entry1.entry_id, 'the first promotion is v2-shaped with an entry_id');

    writeFileSync(join(dir, 'src', 'resume.mjs'), 'v2 content, changed after the first review round\n');
    const agentTranscript = writeAgentTranscript(dir, 'agent-a.jsonl', [readBlock(join(dir, 'src', 'resume.mjs'))]);

    r = runHook(h22Input(dir, { agent_id: 'rev-resume-a', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: agentTranscript }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry2 = readLedger(dir)[0];
    assert.equal(entry2.entry_id, entry1.entry_id, 'entry_id is STABLE across a resume refresh');
    assert.deepEqual(entry2.identity, entry1.identity, 'identity.* never changes on refresh');
    assert.deepEqual(entry2.reviewer, entry1.reviewer, 'reviewer.* never changes on refresh');
    assert.deepEqual(entry2.territory.files, entry1.territory.files, 'declared territory.files never changes on refresh');
    assert.ok(Date.parse(entry2.finished_at) >= Date.parse(entry1.finished_at), 'finished_at moves forward');
    assert.equal(entry2.resume_count ?? 0, (entry1.resume_count ?? 0) + 1, 'resume_count increments by exactly one');

    assert.notDeepEqual(entry2.content_evidence, entry1.content_evidence, "WITH real Read evidence this round, content_evidence IS recomputed against the file's current bytes");
    assert.ok(!('rebaseline_refused' in entry2) || entry2.rebaseline_refused.length === 0, 'a genuinely observed rebaseline never accumulates a refusal record for the same path');
  } finally {
    cleanup();
  }
});

// SABOTAGE: ignore transcript evidence and refuse to rebaseline unless the
// content happens to be byte-identical (i.e. flip the guard to "always keep
// the prior sha") — RESUME-1a above goes red instead (no recompute despite
// real evidence), proving these two tests are each other's counter-sabotage.
test('RESUME-1b (rebaseline-refused, THE RE-CUT): a resumed reviewer with NO transcript evidence of re-reading the changed path keeps the PRIOR sha — refusal disclosed, never silently laundering unread bytes', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'resume.mjs'), 'v1 content\n');

    writeRegisterRaw(dir, [registerEntry('rev-resume-b', 'reviewer-correctness', ['src/resume.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-resume-b', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir)[0];
    const priorSha = entry1.content_evidence.blobs['src/resume.mjs'];
    assert.ok(priorSha, 'fixture guard: round 1 recorded a real sha for src/resume.mjs');

    writeFileSync(join(dir, 'src', 'resume.mjs'), 'v2 content, changed after the first review round\n');

    // Deliberately NO agent_transcript_path at all — the resumed reviewer's
    // own transcript offers zero evidence it looked at the changed path
    // again this round.
    r = runHook(h22Input(dir, { agent_id: 'rev-resume-b', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry2 = readLedger(dir)[0];
    assert.equal(entry2.entry_id, entry1.entry_id);
    assert.deepEqual(entry2.identity, entry1.identity);
    assert.deepEqual(entry2.reviewer, entry1.reviewer);
    assert.deepEqual(entry2.territory.files, entry1.territory.files);
    assert.equal(entry2.resume_count ?? 0, (entry1.resume_count ?? 0) + 1, 'resume_count still increments even on a refused rebaseline');

    assert.equal(entry2.content_evidence.blobs['src/resume.mjs'], priorSha, 'THE RE-CUT: without observed-read evidence, the PRIOR sha stands — never the new, unread bytes');
    assert.ok(Array.isArray(entry2.rebaseline_refused), 'a top-level rebaseline_refused array accumulates the refusal');
    const currentSha = entry2.rebaseline_refused[0]?.current_sha;
    assert.notEqual(currentSha, priorSha, 'fixture guard: the file really did change on disk (the refused sha is a genuinely different value)');
    assert.deepEqual(
      entry2.rebaseline_refused,
      [{ path: 'src/resume.mjs', prior_sha: priorSha, current_sha: currentSha, round: 1 }],
      'the refusal record names the path, the sha it kept, the sha it refused, and which resume round'
    );
    assert.match(`${r.stdout}\n${r.stderr}`, /REFUSED TO REBASELINE/, 'the withholding is disclosed by name');
  } finally {
    cleanup();
  }
});

// SABOTAGE: make the "no evidence" branch unconditional (refuse to rebaseline
// even when the file never changed, or fabricate a rebaseline_refused entry
// regardless of whether the sha actually moved) — this control goes red
// either way (a spurious refusal record, or a spurious REFUSED TO REBASELINE
// disclosure with nothing to refuse).
test('RESUME-1c (control): an UNCHANGED file with no transcript evidence never needs a rebaseline refusal — proves the guard compares SHAS, not merely "was transcript evidence supplied"', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'resume.mjs'), 'unchanged content\n');

    writeRegisterRaw(dir, [registerEntry('rev-resume-c', 'reviewer-correctness', ['src/resume.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-resume-c', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir)[0];

    // File is left byte-identical; still no agent_transcript_path.
    r = runHook(h22Input(dir, { agent_id: 'rev-resume-c', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry2 = readLedger(dir)[0];
    assert.deepEqual(entry2.content_evidence, entry1.content_evidence, 'an unchanged file recomputes to the identical sha either way');
    assert.ok(!('rebaseline_refused' in entry2) || entry2.rebaseline_refused.length === 0, 'nothing to refuse when the bytes never moved');
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /REFUSED TO REBASELINE/, 'no spurious refusal disclosure when nothing changed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUME-DISCHARGED (fail-closed arm 1).
// SABOTAGE: ignore status/disposition entirely and refresh any ledger entry
// matching identity.agent_id regardless of lifecycle state — finished_at and
// content_evidence would move, reddening the byte-identical assertion below.
// ===========================================================================

test('RESUME-DISCHARGED (fail-closed): a Stop for an agent_id whose ledger entry is already status:"discharged" with an AUTHENTICATED disposition is skipped loudly — never refreshed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const discharged = {
      schema_version: 2,
      entry_id: 'e1000000-0000-4000-8000-0000000000d1',
      kind: 'roster_receipt',
      status: 'discharged',
      started_at: '2026-08-22T00:00:00.000Z',
      finished_at: '2026-08-22T00:01:00.000Z',
      reviewer: { agent_type: 'reviewer-correctness', model: null, model_family: 'unknown', model_source: 'unknown' },
      identity: { session_id: 's1', branch: 'main', base_sha: 'a'.repeat(40), agent_id: 'rev-discharged' },
      territory: { files: ['src/gone.mjs'], source: 'free-prose-fallback', attribution: 'block' },
      content_evidence: { status: 'unavailable', blobs: {}, absent_paths: ['src/gone.mjs'], truncated_of: null, failure_reason: null },
      disposition: { reason: 'foreign session at discharge time', at: '2026-08-22T00:02:00.000Z', head_sha: 'b'.repeat(40), classifier_version: 1, class: 'foreign-session', facts: {} },
    };
    writeLedgerRaw(dir, [discharged]);
    const before = readLedgerRaw(dir);

    const r = runHook(h22Input(dir, { agent_id: 'rev-discharged', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLedgerRaw(dir), before, 'a DISCHARGED entry is never refreshed — byte-identical, including finished_at and status');
    assert.match(`${r.stdout}\n${r.stderr}`, /discharged/i, 'the skip is disclosed loudly, naming the discharged state, not silent');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUME-BRANCH-MISMATCH (fail-closed arm 2).
// SABOTAGE: omit the branch check from the refresh path — the entry would be
// refreshed regardless of which branch the hook's cwd is on, reddening the
// byte-identical assertion below.
// ===========================================================================

test(
  "RESUME-BRANCH-MISMATCH (fail-closed): a Stop whose CURRENT branch differs from the ledger entry's identity.branch refuses the refresh with a warning — entry unchanged",
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject('main');
    try {
      const entry = {
        schema_version: 2,
        entry_id: 'e2000000-0000-4000-8000-0000000000b1',
        kind: 'roster_receipt',
        status: 'active',
        started_at: '2026-08-22T00:00:00.000Z',
        finished_at: '2026-08-22T00:01:00.000Z',
        reviewer: { agent_type: 'reviewer-correctness', model: null, model_family: 'unknown', model_source: 'unknown' },
        identity: { session_id: 's1', branch: 'sterling/some-other-branch', base_sha: 'c'.repeat(40), agent_id: 'rev-branchmismatch' },
        territory: { files: ['README.md'], source: 'free-prose-fallback', attribution: 'block' },
        content_evidence: { status: 'complete', blobs: { 'README.md': git(dir, ['hash-object', 'README.md']) }, absent_paths: [], truncated_of: null, failure_reason: null },
        disposition: null,
      };
      writeLedgerRaw(dir, [entry]);
      const before = readLedgerRaw(dir);

      const r = runHook(h22Input(dir, { agent_id: 'rev-branchmismatch', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readLedgerRaw(dir), before, "a branch-mismatched entry is never refreshed — the hook's cwd is on 'main', the entry's identity.branch is 'sterling/some-other-branch'");
      assert.match(`${r.stdout}\n${r.stderr}`, /branch/i, 'the refusal names the branch mismatch, not a silent skip');
    } finally {
      cleanup();
    }
  }
);

// ===========================================================================
// RESUME-LEGACY-V1 (fail-closed arm 3): a v1 (flat) ledger entry has no
// identity.agent_id at all to match against — structurally impossible to
// refresh, so it must be left alone rather than crash or be coerced.
// SABOTAGE: fall back to matching on agent_type+at (or any other v1-readable
// pair) against a v1 entry when agent_id is absent — the v1 entry would gain
// finished_at/resume_count, reddening the byte-identical assertion below.
// ===========================================================================

test('RESUME-LEGACY-V1 (fail-closed): a pre-existing v1 (flat) ledger entry has no identity.agent_id to match against — a Stop sharing its agent_type is skipped loudly as a non-match, never mutated', () => {
  const { dir, cleanup } = makeProject();
  try {
    const v1Entry = { agent_type: 'reviewer-correctness', files: ['src/legacy.mjs'], at: '2026-08-20T00:00:00.000Z', session_id: 's1', branch: 'main', base_sha: 'd'.repeat(40) };
    writeLedgerRaw(dir, [v1Entry]);
    const before = readLedgerRaw(dir);

    const r = runHook(h22Input(dir, { agent_id: 'rev-legacy-resume', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLedgerRaw(dir), before, 'a v1 entry (no identity.agent_id field to match by construction) is never mutated by the refresh path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUME-CONSUMED (correct second round): with the ledger holding ZERO
// entries for this agent (as if already consumed by commit-reviewed) but a
// genuinely fresh register entry present (a real re-dispatch), the Stop
// mints a brand-new receipt rather than treating the absence as a no-op.
// SABOTAGE: treat "no matching ledger entry found" as itself a reason to
// skip promotion (conflating "nothing to refresh" with "nothing to do") —
// ledgerExists(dir) would stay false, reddening the length assertion below.
// ===========================================================================

test('RESUME-CONSUMED (correct second round): the ledger holds ZERO entries for this agent (already consumed) but a fresh register entry exists (a genuine re-dispatch) — Stop mints a brand-new receipt, not a no-op', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-second-round', 'reviewer-correctness', ['src/second.mjs'], '2026-08-23T00:00:00.000Z')]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-second-round', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'a genuinely fresh register entry with no prior ledger record mints exactly one NEW receipt');
    const entry = ledger[0];
    assert.ok(entry.entry_id, 'the new receipt is v2-shaped with its own entry_id');
    assert.ok(!('resume_count' in entry), 'a fresh mint (nothing to resume from) never carries resume_count');
    assert.equal(entry.reviewer?.agent_type, 'reviewer-correctness');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// WRONG-TERRITORY REFRESH (board c9f92090, THE LIVE DEFECT — measured live: a
// follow-up message fires a fresh SubagentStart whose register entry is
// re-attributed to the newest message, so a receipt for five paths got a
// concurrent coder's two paths hashed onto it). The fix: the territory
// hashed at refresh is ALWAYS the receipt's OWN territory.files, never a
// register entry's files, whatever the register happens to hold at the
// moment of the resumed Stop.
// SABOTAGE: source the refresh's file set from the LIVE register entry
// matching this agent_id (or its most recent live entry) instead of
// entry.territory.files — content_evidence would include 'zz-other.mjs'
// and/or drop 'a.mjs'/'b.mjs', reddening the assertions below.
// ===========================================================================

test("WRONG-TERRITORY REFRESH: a resumed reviewer whose register is re-seeded with a DIFFERENT (wrong) file set is refreshed against its OWN declared territory, never the register's", () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'a\n');
    writeFileSync(join(dir, 'src', 'b.mjs'), 'b\n');
    writeFileSync(join(dir, 'src', 'zz-other.mjs'), 'zz\n');

    writeRegisterRaw(dir, [registerEntry('rev-wrongterr', 'reviewer-correctness', ['src/a.mjs', 'src/b.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-wrongterr', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir)[0];
    assert.deepEqual([...entry1.territory.files].sort(), ['src/a.mjs', 'src/b.mjs'], 'fixture guard: round 1 declared a.mjs+b.mjs');

    // The measured live defect: the register is re-seeded for the SAME
    // agent_id with a WRONG file set (a follow-up message's fresh Start
    // mis-attributed), PLUS a second live entry for a completely different
    // agent — neither must ever leak into this refresh.
    writeRegisterRaw(dir, [
      registerEntry('rev-wrongterr', 'reviewer-correctness', ['src/zz-other.mjs'], '2026-08-22T00:05:00.000Z'),
      registerEntry('agent-other', 'coder', ['src/unrelated.mjs'], '2026-08-22T00:05:00.000Z'),
    ]);

    r = runHook(h22Input(dir, { agent_id: 'rev-wrongterr', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry2 = readLedger(dir).find((e) => e.entry_id === entry1.entry_id);
    assert.ok(entry2, 'the same receipt (by entry_id) is still present — refreshed in place');
    assert.deepEqual(entry2.territory.files, entry1.territory.files, 'declared territory.files is NEVER overwritten by a re-seeded register entry');

    const evidencePaths = [...Object.keys(entry2.content_evidence.blobs ?? {}), ...(entry2.content_evidence.absent_paths ?? [])].sort();
    assert.deepEqual(
      evidencePaths,
      ['src/a.mjs', 'src/b.mjs'],
      "content_evidence is hashed against the RECEIPT's own territory — never the register's zz-other.mjs, and never leaking in the unrelated agent's files either"
    );
    assert.ok(!('src/zz-other.mjs' in (entry2.content_evidence.blobs ?? {})), 'zz-other.mjs (the WRONG register-sourced file) never appears in content_evidence');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// TERRITORY GUARD (board c9f92090) — defense-in-depth alongside WRONG-
// TERRITORY REFRESH above: if a receipt's OWN evidence ever names a path
// outside its declared territory, or is missing a declared path with no
// failure_reason recorded, the refresh refuses outright rather than
// touching the entry.
//
// AMBIGUITY DISCLOSED, RESOLVED BY A STATED READING: the spec does not name
// the exact trigger mechanism for "the evidence names an undeclared path".
// Under the WRONG-TERRITORY REFRESH fix above, a CORRECT refresh can never
// itself PRODUCE such evidence externally (it is bound strictly to
// entry.territory.files) — so this is read here as a SELF-CONSISTENCY check
// applied to the EXISTING entry before any refresh is attempted: a
// pre-existing v2 entry whose OWN content_evidence already violates its OWN
// declared territory (e.g. from a prior corrupted round, or hand-tampering)
// must be refused, never "fixed up" or silently extended further. Both arms
// below hand-craft exactly that malformed pre-existing state directly into
// the ledger file. Reported, not silently resolved beyond this stated
// reading.
// SABOTAGE (both arms): skip this self-consistency check and refresh the
// malformed entry anyway — the byte-identical assertions go red.
// ===========================================================================

test('TERRITORY GUARD (undeclared path): a pre-existing entry whose content_evidence names a path OUTSIDE its declared territory.files is refused, never refreshed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const malformed = {
      schema_version: 2,
      entry_id: 'e3000000-0000-4000-8000-0000000000g1',
      kind: 'roster_receipt',
      status: 'active',
      started_at: '2026-08-22T00:00:00.000Z',
      finished_at: '2026-08-22T00:01:00.000Z',
      reviewer: { agent_type: 'reviewer-correctness', model: null, model_family: 'unknown', model_source: 'unknown' },
      identity: { session_id: 's1', branch: null, base_sha: null, agent_id: 'rev-guard-undeclared' },
      territory: { files: ['src/a.mjs'], source: 'free-prose-fallback', attribution: 'block' },
      content_evidence: { status: 'complete', blobs: { 'src/a.mjs': 'a'.repeat(40), 'src/zz-extra.mjs': 'b'.repeat(40) }, absent_paths: [], truncated_of: null, failure_reason: null },
      disposition: null,
    };
    writeLedgerRaw(dir, [malformed]);
    const before = readLedgerRaw(dir);

    const r = runHook(h22Input(dir, { agent_id: 'rev-guard-undeclared', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      readLedgerRaw(dir),
      before,
      "an entry whose evidence names an undeclared path ('src/zz-extra.mjs' is outside territory.files ['src/a.mjs']) is never refreshed — byte-identical"
    );
    assert.match(`${r.stdout}\n${r.stderr}`, /does not bind the receipt's DECLARED territory/, 'the refusal names the binding violation');
  } finally {
    cleanup();
  }
});

test('TERRITORY GUARD (omitted path, no failure_reason): a pre-existing entry whose content_evidence is missing a declared path with no failure_reason recorded is refused, never refreshed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const malformed = {
      schema_version: 2,
      entry_id: 'e3000000-0000-4000-8000-0000000000g2',
      kind: 'roster_receipt',
      status: 'active',
      started_at: '2026-08-22T00:00:00.000Z',
      finished_at: '2026-08-22T00:01:00.000Z',
      reviewer: { agent_type: 'reviewer-correctness', model: null, model_family: 'unknown', model_source: 'unknown' },
      identity: { session_id: 's1', branch: null, base_sha: null, agent_id: 'rev-guard-omitted' },
      territory: { files: ['src/a.mjs', 'src/b.mjs'], source: 'free-prose-fallback', attribution: 'block' },
      content_evidence: { status: 'complete', blobs: { 'src/a.mjs': 'a'.repeat(40) }, absent_paths: [], truncated_of: null, failure_reason: null },
      disposition: null,
    };
    writeLedgerRaw(dir, [malformed]);
    const before = readLedgerRaw(dir);

    const r = runHook(h22Input(dir, { agent_id: 'rev-guard-omitted', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      readLedgerRaw(dir),
      before,
      "an entry declaring ['src/a.mjs','src/b.mjs'] but whose evidence covers only 'src/a.mjs', with no failure_reason accounting for 'src/b.mjs', is never refreshed — byte-identical"
    );
    assert.match(`${r.stdout}\n${r.stderr}`, /does not bind the receipt's DECLARED territory/, 'the refusal names the binding violation');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GATE 3b — SESSION IDENTITY (board c9f92090): a resume refresh compares
// identity.session_id against the Stop's OWN session_id, POSITIVE-EVIDENCE-
// ONLY — a genuine, confirmed mismatch (both sides present and different)
// refuses; an absent/null value on EITHER side is not evidence of anything
// and the refresh still proceeds.
// SABOTAGE (mismatch test): drop the session_id comparison from the refresh
// path entirely — the byte-identical assertion goes red.
// SABOTAGE (control test): flip the guard to fail-closed on ANY absence
// (treat missing/null as a mismatch) — the refresh would wrongly refuse,
// reddening the "still increments" assertions below.
// ===========================================================================

test("GATE 3b (SESSION-MISMATCH): a resumed Stop whose session_id genuinely differs from the ledger entry's identity.session_id refuses the refresh — byte-identical, disclosed", () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-sess-mismatch', 'reviewer-correctness', ['src/sess.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-sess-mismatch', session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir)[0];
    assert.equal(entry1.identity.session_id, 's1', 'fixture guard: round 1 recorded session_id s1');
    const before = readLedgerRaw(dir);

    r = runHook(h22Input(dir, { agent_id: 'rev-sess-mismatch', agent_type: 'reviewer-correctness', session_id: 's2', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(readLedgerRaw(dir), before, 'a genuinely different session_id refuses the refresh — byte-identical');
    assert.match(`${r.stdout}\n${r.stderr}`, /session/i, 'the refusal names the session mismatch');
  } finally {
    cleanup();
  }
});

test('GATE 3b (CONTROL, absent/null): a NULL identity.session_id, or a Stop with NO session_id at all, is not evidence of a mismatch — the refresh still proceeds', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Half A: the LEDGER side is null.
    writeRegisterRaw(dir, [registerEntry('rev-sess-null-a', 'reviewer-correctness', ['src/sessA.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-sess-null-a', session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    let ledger = readLedger(dir);
    ledger[0].identity.session_id = null;
    writeLedgerRaw(dir, ledger);
    const entry1a = readLedger(dir)[0];

    r = runHook(h22Input(dir, { agent_id: 'rev-sess-null-a', agent_type: 'reviewer-correctness', session_id: 's9-anything', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry2a = readLedger(dir).find((e) => e.entry_id === entry1a.entry_id);
    assert.equal(entry2a.resume_count ?? 0, (entry1a.resume_count ?? 0) + 1, 'a null identity.session_id never blocks the refresh — resume_count still increments');

    // Half B: the STOP side is absent entirely (no session_id key on stdin).
    writeRegisterRaw(dir, [registerEntry('rev-sess-null-b', 'reviewer-correctness', ['src/sessB.mjs'], '2026-08-22T00:00:00.000Z')]);
    r = runHook(h22Input(dir, { agent_id: 'rev-sess-null-b', session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry1b = readLedger(dir).find((e) => e.identity?.agent_id === 'rev-sess-null-b');
    assert.ok(entry1b, 'fixture guard: round 1 promoted the second scenario');

    const input2b = h22Input(dir, { agent_id: 'rev-sess-null-b', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' });
    delete input2b.session_id;
    r = runHook(input2b, dir);
    assert.equal(r.code, 0, r.stderr);
    const entry2b = readLedger(dir).find((e) => e.entry_id === entry1b.entry_id);
    assert.equal(entry2b.resume_count ?? 0, (entry1b.resume_count ?? 0) + 1, 'a completely absent stdin.session_id never blocks the refresh either — resume_count still increments');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RESUME_COUNT ARMS (board c9f92090): resume_count increments only from a
// genuinely usable (non-negative integer) prior value; an absent prior
// value silently becomes 1; a present but UNUSABLE prior value (a string, a
// negative number, a non-integer) resets to 1 with a loud disclosure rather
// than propagating garbage arithmetic (e.g. "3"+1 via string concatenation,
// or -1+1 silently reading as a fresh mint).
// SABOTAGE: do plain `(resume_count ?? 0) + 1` arithmetic with no usability
// check at all — the UNUSABLE-value assertions below go red (the result is
// NaN, a concatenated string, or 0 for the -1 case) and the UNUSABLE stderr
// disclosure never fires.
// ===========================================================================

test('RESUME_COUNT (absent -> 1, silently): a fresh promotion has no resume_count; its first resume sets it to exactly 1 with no UNUSABLE disclosure', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-rc-absent', 'reviewer-correctness', ['src/rc.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-rc-absent', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!('resume_count' in readLedger(dir)[0]), 'fixture guard: a fresh promotion carries no resume_count');

    r = runHook(h22Input(dir, { agent_id: 'rev-rc-absent', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir)[0];
    assert.equal(entry.resume_count, 1, 'absent -> 1');
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /UNUSABLE resume_count/i, 'an absent prior value is the ordinary case, never disclosed as unusable');
  } finally {
    cleanup();
  }
});

test('RESUME_COUNT (2 -> 3, silently): a genuinely usable non-negative-integer resume_count increments by exactly one with no disclosure', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-rc-two', 'reviewer-correctness', ['src/rc2.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-rc-two', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedger(dir);
    ledger[0].resume_count = 2;
    writeLedgerRaw(dir, ledger);

    r = runHook(h22Input(dir, { agent_id: 'rev-rc-two', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir)[0];
    assert.equal(entry.resume_count, 3, '2 -> 3');
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /UNUSABLE resume_count/i, 'a genuinely usable prior value is never disclosed as unusable');
  } finally {
    cleanup();
  }
});

test('RESUME_COUNT (UNUSABLE arms): a present but unusable prior resume_count ("3" string, -1, 1.5) resets to exactly 1, disclosed by name', () => {
  for (const unusable of ['3', -1, 1.5]) {
    const { dir, cleanup } = makeProject();
    try {
      writeRegisterRaw(dir, [registerEntry('rev-rc-bad', 'reviewer-correctness', ['src/rcbad.mjs'], '2026-08-22T00:00:00.000Z')]);
      let r = runHook(h22Input(dir, { agent_id: 'rev-rc-bad', hook_event_name: 'SubagentStop' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const ledger = readLedger(dir);
      ledger[0].resume_count = unusable;
      writeLedgerRaw(dir, ledger);

      r = runHook(h22Input(dir, { agent_id: 'rev-rc-bad', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const entry = readLedger(dir)[0];
      assert.equal(entry.resume_count, 1, `unusable prior resume_count (${JSON.stringify(unusable)}) resets to exactly 1, never propagated arithmetic`);
      assert.match(`${r.stdout}\n${r.stderr}`, /UNUSABLE resume_count/i, `the reset is disclosed by name for prior value ${JSON.stringify(unusable)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// GATE 4 — LEDGER LOCK TIMEOUT (board c9f92090: "withLedgerLock timeout
// proceeds UNLOCKED today ... the refresh path must SKIP loudly, never take
// the unlocked route, because a whole-array rewrite can clobber a concurrent
// consume"). The ledger lock is shared with scripts/review-ledger.mjs
// discharge (article review-ledger-cli: "shares the ledger lock
// convention"), which uses a directory-based lock carrying an owner token
// (scripts/tests/review-ledger-discharge-hardening.test.mjs, pin P7) —
// reused here, without importing, since neither CLI's internals were opened
// (H4). Two candidate lock directory names are planted (the lock's exact
// filename is not verifiable from outside — same disclosed substitution as
// that P7 pin) so whichever the real implementation uses, this test
// contends with it.
// SABOTAGE: on ledger-lock contention, fall through to the ORIGINAL
// promotion path's pre-existing "write anyway, disclose" unlocked fallback
// instead of skipping the refresh outright — the byte-identical assertion
// goes red.
// ===========================================================================

test('GATE 4: while the review-ledger lock is held externally, a resumed Stop SKIPS the refresh entirely — ledger byte-identical, never written unlocked', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry('rev-gate4', 'reviewer-correctness', ['src/gate4.mjs'], '2026-08-22T00:00:00.000Z')]);
    let r = runHook(h22Input(dir, { agent_id: 'rev-gate4', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const before = readLedgerRaw(dir);

    const now = new Date();
    const LOCK_NAMES = ['review-ledger.json.lock', 'review-ledger.lock'];
    const planted = LOCK_NAMES.map((name) => {
      const lockDir = join(dir, '.sterling', name);
      mkdirSync(lockDir, { recursive: true });
      const tokenPath = join(lockDir, 'owner.json');
      writeFileSync(tokenPath, JSON.stringify({ pid: 999_999, host: 'another-machine', at: now.toISOString() }));
      utimesSync(tokenPath, now, now);
      utimesSync(lockDir, now, now);
      return { lockDir, tokenPath };
    });

    r = runHook(h22Input(dir, { agent_id: 'rev-gate4', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop' }), dir);

    assert.equal(r.code, 0, `a ledger lock timeout is disclosed, never denies the spawn — stderr: ${r.stderr}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — the refresh was skipped, never written unlocked');
    assert.match(`${r.stdout}\n${r.stderr}`, /NEVER written unlocked/, 'the skip is disclosed by the exact contract wording');

    for (const p of planted) {
      assert.ok(existsSync(p.lockDir), 'the foreign lock is left untouched, never stolen');
    }
  } finally {
    cleanup();
  }
});
