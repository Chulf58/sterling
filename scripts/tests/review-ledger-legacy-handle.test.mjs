// REVIEW-LEDGER `discharge --legacy-handle` — THE GENERATED LEGACY HANDLE
// (board 7dd3200a; decision 57984926, slug review-ledger-v2-lifecycle-refuse-
// flip-and-external-review-design, §3 "FALLBACK NARROWING + DISCHARGE").
//
// SPEC UNDER TEST (§3, verbatim clause):
//   "selector is entry_id (v2) or a generated legacy handle + a SHA-256 digest
//    of the exact ledger bytes as the concurrency token"
// And, from the same decision's alternatives_rejected (in-place v1 migration):
//   "the compatibility adapter reads both shapes and explicit discharge may add
//    lifecycle fields to a v1 entry as a requested transition."
//
// THE GAP THIS CLOSES. review-ledger-discharge.test.mjs flagged the handle as
// ambiguity (b) and pinned nothing about it; the shipped verb then refused every
// v1 entry outright, so a stranded LEGACY receipt had no route out of the ledger
// except the hand deletion §3 forbids. These pins are the handle's contract.
//
// THE INTERFACE UNDER TEST:
//     node scripts/review-ledger.mjs discharge \
//       --legacy-handle receipt-<32 lowercase hex>   # the v1 selector
//       --digest <sha256-hex>  --class <...>  --reason "<single line>"
//
// THE HANDLE IS NOT A NEW IDENTITY. It is the SAME content fingerprint §2
// already stamps as a v1 `Review-Bytes-Waiver` trailer value, exported from the
// shared adapter as legacyReceiptHandle(). These pins IMPORT that function
// rather than re-deriving it: a second copy of the computation in the test would
// pin the test's own arithmetic, not the CLI's, and the whole point of the
// shared helper is that both surfaces speak one identity. What IS pinned
// independently is the handle's SHAPE and its DETERMINISM (L1).
//
// WHY EXACT-FORM-ONLY IS PINNED SO HARD (L4). Discharge overwrites an
// agent-writable evidence record and there is no resurrection verb, so
// anti-pattern no-bounded-trail-guard-for-destructive-addressing (severity
// BLOCK) forbids every forgiving spelling. L4 is the pin that keeps a future
// convenience change — "resolve an unambiguous prefix, like the id ladder does"
// — from landing here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyReceiptHandle } from '../hooks/lib/review-ledger-entry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');
const COMMIT_CLI = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-legacy-handle-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);

// The concurrency token: SHA-256 over the EXACT ledger bytes (§3), read from the
// file rather than from a re-serialization of the fixture object.
const ledgerDigest = (dir) => createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');

function assertNoLedgerResidue(dir, label) {
  const residue = readdirSync(join(dir, '.sterling')).filter((n) => /^review-ledger\.json\..+/.test(n) && !n.endsWith('.lock'));
  assert.deepEqual(residue, [], `${label}: the replace leaves no partial ledger behind — got ${JSON.stringify(residue)}`);
}

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function reviewedByTrailers(dir, sha = 'HEAD') {
  return git(dir, ['log', '-1', `--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)`, sha]).split('\n').filter((l) => l.trim() !== '');
}

// A LEGACY v1 entry: FLAT fields, no schema_version, no entry_id, no lifecycle.
// `session_id` defaults to a session that is genuinely NOT this one, so
// foreign-session is establishable — the shape the stranded live receipt had.
function v1({ agent_type = 'reviewer-correctness', files = ['src/base.mjs'], at = isoAgo(60_000), session_id = 'a-session-that-ended', branch = 'main', blobs = null, extra = {} } = {}) {
  const e = { agent_type, files, at, session_id, branch };
  if (blobs) e.reviewed_state = { blobs, completed_at: at };
  return { ...e, ...extra };
}

// A structurally complete v2 entry — the OTHER selector's territory.
function v2({ entry_id, agent_type = 'reviewer-security', files = ['src/base.mjs'], blobs = {}, at = isoAgo(60_000), session_id = SESSION }) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active', started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch: 'main', base_sha: null },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { status: 'complete', blobs, absent_paths: [], truncated_of: null, failure_reason: null },
    disposition: null,
  };
}

const V2_ID = 'e0000000-0000-4000-8000-00000000000a';
const CODE = 'export const f = 1;\n';

// ===========================================================================
// L1 — THE HANDLE ITSELF. Pure, no CLI: shape and determinism.
// ===========================================================================

// EXPECTED STATE: GREEN once legacyReceiptHandle is exported from the adapter.
// SABOTAGE (determinism half): derive the handle from Date.now(), randomUUID, or
// the commit sha -> the two round-trip comparisons go red. A per-invocation value
// is a fingerprint of nothing and cannot say WHICH receipt is being addressed,
// which is the only thing a selector is for.
// SABOTAGE (discrimination half): drop `files` from the fingerprint inputs -> the
// notEqual arms go red. Territory is what distinguishes two receipts that share
// agent_type AND the dispatch millisecond (the measured shape, file-scoping S9).
test('legacy-handle L1: the handle is receipt-<32 lowercase hex>, deterministic over the receipt content, and DIFFERENT for receipts differing in any identity-bearing field', () => {
  // REPAIR (conductor, 2026-09-01, applied on first red run): v1()'s default
  // `at` is evaluated PER CALL, so two "byte-identical" constructions differ by
  // milliseconds — the determinism arms below must share one pinned instant or
  // the pin is a race. The discrimination arms keep their own values.
  const at = isoAgo(60_000);
  const base = v1({ at });
  const h = legacyReceiptHandle(base);
  assert.match(h, /^receipt-[0-9a-f]{32}$/, `the handle has exactly one spelling — got ${JSON.stringify(h)}`);

  // Determinism: a JSON round trip (what the CLI actually reads) must not move it.
  assert.equal(h, legacyReceiptHandle(JSON.parse(JSON.stringify(base))), 'the same receipt fingerprints identically across a serialize/parse round trip');
  assert.equal(h, legacyReceiptHandle(v1({ at })), 'and identically for an independently-constructed byte-identical receipt');

  // Discrimination: each identity-bearing field moves it.
  assert.notEqual(h, legacyReceiptHandle(v1({ at, agent_type: 'reviewer-security' })), 'agent_type is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at, files: ['src/other.mjs'] })), 'declared territory is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at: isoAgo(120_000) })), 'the dispatch instant is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at, blobs: { 'src/base.mjs': 'a'.repeat(40) } })), 'the recorded blob map is part of the identity');

  // Key ORDER in the ledger file must not move it (both maps are sorted).
  const twoBlobs = { 'src/a.mjs': 'a'.repeat(40), 'src/b.mjs': 'b'.repeat(40) };
  const reversed = { 'src/b.mjs': 'b'.repeat(40), 'src/a.mjs': 'a'.repeat(40) };
  assert.equal(
    legacyReceiptHandle(v1({ at, files: ['src/a.mjs', 'src/b.mjs'], blobs: twoBlobs })),
    legacyReceiptHandle(v1({ at, files: ['src/a.mjs', 'src/b.mjs'], blobs: reversed })),
    'blob key order in the ledger file cannot change the answer'
  );
});

// ===========================================================================
// L0 — THE HAPPY PATH (CONTROL, PLACED FIRST). Every refusal pin in this file
// would be satisfied identically by a CLI that refuses --legacy-handle
// unconditionally, which is exactly what shipped before board 7dd3200a. Without
// L0 green, no refusal pin here carries a verdict.
// ===========================================================================

// EXPECTED STATE: RED before the handle selector exists — the CLI refuses every
// unknown flag's invocation for a missing --entry-id, so `r.code === 0` fires.
// SABOTAGE (preservation half): implement the legacy discharge as a splice -> the
// length-2 and evidence assertions go red. §3's "deletion is never silent".
// SABOTAGE (no-migration half): rewrite the entry into the v2 envelope while
// discharging it -> the schema_version/evidence assertions go red. §3 REJECTED
// in-place migration ("a bulk rewrite of an agent-writable evidence file is an
// unreviewable write") while licensing only the added lifecycle fields.
// SABOTAGE (disposition half): flip status without writing a disposition -> the
// five named-key assertions go red while status stays green. Three independent
// guards; all three are load-bearing.
test('legacy-handle L0 (CONTROL, first): a LEGACY v1 receipt is discharged by --legacy-handle — evidence PRESERVED byte-for-byte, still a v1 entry, status+disposition ADDED, bystander untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') } });
    const bystander = v1({ agent_type: 'reviewer-bystander', files: ['src/elsewhere.mjs'], at: isoAgo(90_000) });
    writeLedger(dir, [target, bystander]);

    const handle = legacyReceiptHandle(target);
    const reason = 'the session that earned this receipt ended; it can never be spent here';
    const tMin = Date.now() - 1_000;

    const r = runLedger(dir, ['discharge', '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', reason]);
    assert.equal(r.code, 0, `a well-formed legacy discharge must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.ok(Array.isArray(after), `the ledger is still valid JSON holding an array — raw=${flat(readLedgerRaw(dir))}`);
    assert.equal(after.length, 2, `NOTHING is deleted — a discharge preserves the record — got ${JSON.stringify(after)}`);
    assert.deepEqual(after[1], bystander, 'the bystander entry is byte-for-byte untouched — this verb writes exactly one entry');

    const d = after[0];
    // NO MIGRATION: it is still a v1 entry, and every original field survives.
    assert.equal(d.schema_version, undefined, 'the entry is NOT migrated to v2 — §3 rejected in-place migration outright');
    assert.equal(d.entry_id, undefined, 'and gains no invented entry_id');
    for (const k of ['agent_type', 'files', 'at', 'session_id', 'branch', 'reviewed_state']) {
      assert.deepEqual(d[k], target[k], `${k} is preserved exactly as it was on disk`);
    }
    // THE ADDED LIFECYCLE FIELDS — the "requested transition" §3 licenses.
    assert.equal(d.status, 'discharged', 'the status flips to discharged');
    assert.ok(d.disposition && typeof d.disposition === 'object', `the disposition object is recorded, never left null — got ${JSON.stringify(d.disposition)}`);
    assert.equal(d.disposition.reason, reason, 'the conductor-supplied reason is recorded verbatim');
    assert.equal(d.disposition.class, 'foreign-session', 'the recognized class is recorded');
    assert.equal(d.disposition.head_sha, git(dir, ['rev-parse', 'HEAD']), 'head_sha pins WHEN in history the discharge was decided');
    assert.ok(
      d.disposition.classifier_version !== undefined && d.disposition.classifier_version !== null && String(d.disposition.classifier_version) !== '',
      `classifier_version is recorded — got ${JSON.stringify(d.disposition.classifier_version)}`
    );
    const at = Date.parse(d.disposition.at);
    assert.ok(Number.isFinite(at) && at >= tMin && at <= Date.now() + 1_000, `disposition.at is the moment of the discharge — got ${JSON.stringify(d.disposition.at)}`);

    // The report names the selector that was actually used.
    const report = JSON.parse(r.stdout);
    assert.equal(report.legacy_handle, handle, 'the report echoes the handle it acted on');
    assert.equal(report.entry_id, null, 'and reports no entry_id — a v1 entry has none');

    assertNoLedgerResidue(dir, 'L0');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L2 — THE DISCHARGE ACTUALLY TAKES EFFECT. Without this pin, L0 is satisfied by
// a verb that writes two fields nobody reads: §3 requires that "H1, spending,
// amend spending, fallback selection and counts all ignore discharged entries",
// and a v1 discharge that leaves the receipt spendable is a no-op wearing a
// success report. THE CONTROL RUNS FIRST because L2's verdict ("refuses after
// the discharge") has a second possible cause — the fixture was never spendable.
// ===========================================================================

// EXPECTED STATE: GREEN today — an ordinary v1 receipt covering the staged file
// with matching bytes commits and is consumed.
// SABOTAGE: break the fixture's blob match -> the reviewed-bytes gate refuses ->
// red here, and L2's green is exposed as meaningless.
test('legacy-handle L2-0 (CONTROL, first): the SAME v1 receipt, NOT discharged, is stamped and consumed normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const receipt = v1({ files: ['src/laneA.mjs'], session_id: SESSION, blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } });
    writeLedger(dir, [receipt]);

    const r = runCommitReviewed(dir, ['-m', 'L2 control: an ordinary v1 receipt spends']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the v1 receipt is stamped');
    assert.deepEqual(readLedger(dir), [], 'and consumed');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED before the adapter authenticates a legacy discharge pair —
// dischargeMarkerClass returns 'v1-no-lifecycle' for every v1 entry, so the
// receipt still spends and the `code !== 0` assertion fires.
// SABOTAGE: honor a BARE status:'discharged' on a v1 entry (drop the disposition
// half of the pair) -> frozen pin P4a in review-ledger-discharge-hardening goes
// red. The two pins are read together: L2 requires the AUTHENTICATED pair to
// take effect, P4a requires the bare field NOT to.
// SABOTAGE (destruction half): exclude the discharged v1 entry from spending but
// not from the consume write -> the survival assertion goes red while the refusal
// stays green. That is the dangerous half — silently destroying preserved
// evidence is what §3's "deletion is never silent" forbids.
test('legacy-handle L2: after a legacy discharge the receipt is NOT spendable — commit-reviewed refuses, the entry SURVIVES with its disposition, and it is not re-disclosed as merely foreign', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const receipt = v1({ files: ['src/laneA.mjs'], session_id: 'a-session-that-ended', blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } });
    writeLedger(dir, [receipt]);

    const disc = runLedger(dir, [
      'discharge', '--legacy-handle', legacyReceiptHandle(receipt), '--digest', ledgerDigest(dir),
      '--class', 'foreign-session', '--reason', 'earned in a session that has ended',
    ]);
    assert.equal(disc.code, 0, `precondition: the discharge succeeds — stdout=${disc.stdout} stderr=${flat(disc.stderr)}`);

    const headBefore = git(dir, ['rev-parse', 'HEAD']);
    const c = runCommitReviewed(dir, ['-m', 'L2: a discharged v1 receipt must not carry a commit']);
    assert.notEqual(c.code, 0, `a discharged receipt is the only receipt, so the commit REFUSES — stdout=${c.stdout} stderr=${flat(c.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'and no commit was created');

    const after = readLedger(dir);
    assert.equal(after.length, 1, `the discharged entry survives the refusal — got ${JSON.stringify(after)}`);
    assert.equal(after[0].status, 'discharged', 'still discharged');
    assert.equal(after[0].disposition.reason, 'earned in a session that has ended', 'with its accountable reason intact');
    assert.doesNotMatch(
      c.stderr,
      /FOREIGN RECEIPT/,
      `an ADJUDICATED receipt is not re-reported as an un-judged foreign one — that would re-open a settled decision at every commit — stderr=${flat(c.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L3 / L4 / L5 — THE REFUSAL FAMILY. Each fixture supplies a CORRECT value for
// everything except the one thing under test, so a green cannot come from a
// different cause.
// ===========================================================================

// EXPECTED STATE: RED before the selector exists.
// SABOTAGE: fall back to "the only legacy entry" / "the first entry" when the
// handle matches nothing -> the bystander is discharged and the status/
// byte-identical assertions go red. A forgiving selector on a state-changing
// operation is the shape anti-pattern no-bounded-trail-guard-for-destructive-
// addressing forbids; here it would discharge a bystander as a consolation prize.
test('legacy-handle L3: a well-formed handle matching NO entry is REFUSED — no other entry is discharged in its place, the ledger byte-identical, and the refusal NAMES the handles that do exist', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const present = v1({});
    writeLedger(dir, [present]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--legacy-handle', `receipt-${'0'.repeat(32)}`, '--digest', ledgerDigest(dir),
      '--class', 'foreign-session', '--reason', 'no such receipt',
    ]);
    assert.notEqual(r.code, 0, `an unknown selector must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a refused discharge writes nothing at all');
    assert.notEqual(readLedger(dir)[0].status, 'discharged', 'the ONLY entry present is not discharged as a consolation prize');
    assert.match(r.stderr, /handle|selector|no match|not found|NO LEGACY/i, `the refusal names the addressing failure — stderr=${flat(r.stderr)}`);
    // DISCOVERY: a handle is DERIVED, never stored, so this refusal is the one
    // place a conductor can read the real one. A selector nobody can discover is
    // a selector nobody can use.
    assert.ok(
      r.stderr.includes(legacyReceiptHandle(present)),
      `the refusal lists the legacy handles that DO exist, in full — stderr=${flat(r.stderr)}`
    );
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED before the selector exists (every arm exits non-zero for
// the wrong reason — a missing --entry-id — but the byte-identical and
// non-discharged assertions still hold, so watch the /prefix|exact/i wording
// assertion, which a missing-entry-id refusal does not satisfy).
// SABOTAGE (the one this pin exists for): resolve an unambiguous PREFIX, trim
// whitespace, or lowercase the input "for convenience" -> the corresponding arm
// discharges the entry and its assertions go red. Every arm below is a spelling a
// conductor could plausibly paste; the point is that NONE of them resolves,
// because this call destroys and offers no resurrection.
test('legacy-handle L4: an ABBREVIATED, PREFIX, BARE-HEX, UPPERCASED or WHITESPACE-PADDED handle is REFUSED — the selector is never widened to find something close', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({});
    writeLedger(dir, [target]);
    const before = readLedgerRaw(dir);
    const good = legacyReceiptHandle(target);

    const arms = [
      ['8-char prefix (the id ladder\'s shape — deliberately NOT honored here)', good.slice(0, 'receipt-'.length + 8)],
      ['half the fingerprint', good.slice(0, 'receipt-'.length + 16)],
      ['one character short', good.slice(0, good.length - 1)],
      ['bare hex, no receipt- prefix', good.slice('receipt-'.length)],
      ['uppercased hex', `receipt-${good.slice('receipt-'.length).toUpperCase()}`],
      ['whitespace padded', ` ${good} `],
      ['trailing junk', `${good}x`],
    ];
    for (const [label, bad] of arms) {
      const r = runLedger(dir, ['discharge', '--legacy-handle', bad, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', `[${label}] must not resolve`]);
      assert.notEqual(r.code, 0, `[${label}] must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical`);
      assert.notEqual(readLedger(dir)[0].status, 'discharged', `[${label}] the entry is NOT discharged`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] a refusal, not a crash — stderr=${flat(r.stderr)}`);
    }
    // The SHAPE refusals teach the rule — a reader has to learn that the
    // forgiving forms Sterling honors elsewhere are deliberately absent here.
    const shapeRefusal = runLedger(dir, ['discharge', '--legacy-handle', good.slice(0, 20), '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'x']);
    assert.match(
      shapeRefusal.stderr,
      /prefix|exact|abbrevia/i,
      `the refusal explains that this selector is never prefix-resolved — stderr=${flat(shapeRefusal.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED before the selector exists.
// SABOTAGE: pick matches[0] on a collision -> exit 0, one of the two entries
// flips, and the code/byte-identical assertions go red. Two receipts that
// fingerprint identically are indistinguishable to this selector, so choosing
// either is choosing at random on a call that overwrites evidence.
test('legacy-handle L5: two v1 entries producing the SAME handle are AMBIGUOUS — the refusal names BOTH and nothing is written', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const at = isoAgo(60_000);
    const a = v1({ at });
    const b = v1({ at }); // byte-identical content => identical fingerprint
    assert.equal(legacyReceiptHandle(a), legacyReceiptHandle(b), 'fixture guard: these two receipts genuinely collide');
    writeLedger(dir, [a, b]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(a), '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'ambiguous target']);
    assert.notEqual(r.code, 0, `an ambiguous selector must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'NEITHER entry is discharged and the ledger is byte-identical');
    assert.match(r.stderr, /ambiguous|collision|2 /i, `the refusal is about the ambiguity — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /index 0/, `and names the first colliding entry — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /index 1/, `and the second — a refusal that names only one of two is not a disambiguation aid — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L6 — THE TWO SELECTORS DO NOT LEAK INTO EACH OTHER. §3 gives each schema
// version its own selector; a v2 entry reachable by handle (or a v1 entry
// discharged through --entry-id) would make the schema-version guard decorative.
// ===========================================================================

// EXPECTED STATE: RED before the selector exists (arm (a) exits non-zero for the
// wrong reason; arms (b)-(e) are new wording/behavior).
// SABOTAGE (arm a): compute the handle over EVERY entry rather than only legacy
// ones -> a v2 entry becomes handle-addressable -> the v2 bystander's
// byte-identical assertion goes red. Keeping the candidate sets disjoint by
// schema version is what stops one selector from owning the other's entries.
// SABOTAGE (arm c): let one selector silently win when both are given -> the
// refusal assertion goes red, and a mistyped flag could discharge an entry the
// conductor never looked at.
test('legacy-handle L6: the two selectors are DISJOINT and MUTUALLY EXCLUSIVE — v2 entries are unreachable by handle, a v1 entry hit by --entry-id is redirected to its handle, and neither "both" nor "neither" is accepted', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const legacy = v1({});
    const modern = v2({ entry_id: V2_ID });
    writeLedger(dir, [legacy, modern]);
    const before = readLedgerRaw(dir);
    const handle = legacyReceiptHandle(legacy);

    // (a) A handle NEVER addresses a v2 entry — not even one whose content would
    //     fingerprint to the value supplied.
    const a = runLedger(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(modern), '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'v2 must be unreachable by handle']);
    assert.notEqual(a.code, 0, `[a] a v2 entry is not handle-addressable — stdout=${a.stdout} stderr=${flat(a.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, '[a] ledger byte-identical');
    assert.equal(readLedger(dir)[1].status, 'active', '[a] the v2 entry is untouched and still active');

    // (b) Both selectors at once — two possible targets is no target.
    const b = runLedger(dir, ['discharge', '--entry-id', V2_ID, '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'two targets']);
    assert.notEqual(b.code, 0, `[b] both selectors must REFUSE — stdout=${b.stdout} stderr=${flat(b.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, '[b] ledger byte-identical — neither target is discharged');
    assert.match(b.stderr, /both|exclusive|one/i, `[b] the refusal is about the double selector — stderr=${flat(b.stderr)}`);

    // (c) Neither selector — a discharge with no target.
    const c = runLedger(dir, ['discharge', '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'no target']);
    assert.notEqual(c.code, 0, `[c] no selector must REFUSE — stdout=${c.stdout} stderr=${flat(c.stderr)}`);
    assert.match(c.stderr, /selector|entry-id|legacy-handle/i, `[c] the refusal names what is missing — stderr=${flat(c.stderr)}`);

    // (d) --entry-id against a LEGACY entry that happens to carry an entry_id
    //     field (D6c's fixture shape) still refuses — and now REDIRECTS, naming
    //     the handle to re-run with, rather than dead-ending as it used to.
    const legacyWithId = { ...v1({}), entry_id: 'ffffffff-0000-4000-8000-00000000ffff' };
    writeLedger(dir, [legacyWithId]);
    const d = runLedger(dir, ['discharge', '--entry-id', 'ffffffff-0000-4000-8000-00000000ffff', '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'wrong selector for a v1 entry']);
    assert.notEqual(d.code, 0, `[d] the v2 selector does not address a v1 entry — stdout=${d.stdout} stderr=${flat(d.stderr)}`);
    assert.notEqual(readLedger(dir)[0].status, 'discharged', '[d] and nothing is discharged');
    assert.ok(
      d.stderr.includes(legacyReceiptHandle(legacyWithId)),
      `[d] the refusal names THE HANDLE to re-run with — a dead-end refusal here is what stranded the receipt this feature exists for — stderr=${flat(d.stderr)}`
    );

    // (e) --entry-id on a real v2 entry still works, unchanged (regression guard:
    //     the v2 path must not be collateral of the new arm).
    writeLedger(dir, [legacy, modern]);
    const e = runLedger(dir, ['discharge', '--entry-id', V2_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-branch', '--reason', 'v2 selector still works'], { STERLING_SESSION_ID: SESSION });
    // modern's branch is 'main' and the fixture repo is on 'main', so
    // foreign-branch is CONTRADICTED — the refusal proves the v2 path is still
    // being evaluated on its own merits, not swallowed by the new selector.
    assert.notEqual(e.code, 0, `[e] a contradicted class still refuses on the v2 path — stderr=${flat(e.stderr)}`);
    assert.match(e.stderr, /branch/i, `[e] and refuses for the CLASS reason, not an addressing one — stderr=${flat(e.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L7 — CLASS PRECONDITIONS AND THE CONCURRENCY TOKEN still bind on the legacy
// arm. A new selector must not become a second, laxer door into the same write.
// ===========================================================================

// EXPECTED STATE: RED before the selector exists.
// SABOTAGE (no-live arm): let verifyNoLiveTerritory judge a v1 entry on its FLAT
// files_source (decision 8f137474 shipped that field pre-v2, so a legacy entry
// CAN carry 'review-territory') -> the no-live arm discharges and goes red. §3
// makes "v2 roster receipt" the FIRST precondition of that class.
// SABOTAGE (digest arm): verify the token outside the lock, or against a
// re-serialization of the parsed ledger -> the stale-digest arm discharges. That
// is exactly the race §3 rejected mtime for.
test('legacy-handle L7: on the legacy arm a STALE digest, an UNRECOGNIZED class, a CONTRADICTED foreign class, an EMPTY reason and --class no-live-territory each REFUSE — the new selector is not a laxer door', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // A legacy entry carrying the FLAT files_source, so the no-live arm cannot
    // pass merely by failing the structured-territory test.
    const target = v1({ session_id: 'a-session-that-ended', extra: { files_source: 'review-territory', base_sha: git(dir, ['rev-parse', 'HEAD']) } });
    writeLedger(dir, [target]);
    const handle = legacyReceiptHandle(target);
    const good = ledgerDigest(dir);
    const before = readLedgerRaw(dir);

    const arms = [
      ['stale digest', ['--digest', createHash('sha256').update('not the ledger').digest('hex'), '--class', 'foreign-session', '--reason', 'stale'], /digest|checksum|sha-?256|changed|stale/i],
      ['unrecognized class', ['--digest', good, '--class', 'because-i-said-so', '--reason', 'bad class'], /class/i],
      ['contradicted foreign-branch', ['--digest', good, '--class', 'foreign-branch', '--reason', 'same branch'], /branch/i],
      ['empty reason', ['--digest', good, '--class', 'foreign-session', '--reason', ''], /reason/i],
      ['no-live-territory on a v1 entry', ['--digest', good, '--class', 'no-live-territory', '--reason', 'v1 cannot be no-live'], /no-live|v2|precondition|structur|territor/i],
    ];
    for (const [label, extra, wording] of arms) {
      const r = runLedger(dir, ['discharge', '--legacy-handle', handle, ...extra]);
      assert.notEqual(r.code, 0, `[${label}] must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical`);
      assert.notEqual(readLedger(dir)[0].status, 'discharged', `[${label}] the entry stays active`);
      assert.match(r.stderr, wording, `[${label}] the refusal names its own cause — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] a refusal, not a crash — stderr=${flat(r.stderr)}`);
    }
    assertNoLedgerResidue(dir, 'L7');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L8 — NO SECOND FLIP ON THE LEGACY ARM (§3: "NO resurrection command"). The
// legacy arm has its own already-discharged path, and it must not become a way
// to overwrite a recorded justification with a later, weaker one.
// ===========================================================================

// EXPECTED STATE: RED before the selector exists (the FIRST discharge fails).
// SABOTAGE: make the legacy repeat idempotent by REWRITING the disposition -> the
// reason-preservation assertion goes red while status stays 'discharged'. A
// silently rewritten disposition is a second state flip wearing the first's
// clothes.
// SABOTAGE (the opposite direction): refuse the FIRST discharge because the entry
// carries a bare status:'discharged' -> the first arm goes red. A bare marker on a
// v1 entry is not a lifecycle state (frozen pin P4a proves it still spends), so
// treating it as one would re-strand exactly the receipt this feature frees.
test('legacy-handle L8: a stray bare status:"discharged" on a v1 entry is still DISCHARGEABLE (and the overwrite is disclosed), while a REAL prior discharge is never flipped twice nor its justification rewritten', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const stray = v1({ extra: { status: 'discharged' } }); // a bare extra field, no disposition
    writeLedger(dir, [stray]);
    const handle = legacyReceiptHandle(stray);

    const firstReason = 'the original, accountable justification';
    const first = runLedger(dir, ['discharge', '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', firstReason]);
    assert.equal(first.code, 0, `a bare unauthenticated marker does not block a real discharge — stdout=${first.stdout} stderr=${flat(first.stderr)}`);
    assert.match(first.stderr, /bare status|stray|no disposition/i, `and the overwrite of the stray field is DISCLOSED, never silent — stderr=${flat(first.stderr)}`);
    const afterFirst = readLedger(dir)[0];
    assert.equal(afterFirst.disposition.reason, firstReason, 'precondition: the real justification is recorded');

    // A FRESH digest — the ledger legitimately changed — so a refusal here can
    // only be about the repeat, never about a stale token.
    const second = runLedger(dir, ['discharge', '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'foreign-branch', '--reason', 'a different, later justification']);
    assert.doesNotMatch(second.stderr, /TypeError|ReferenceError/, `a repeat discharge must never crash — stderr=${flat(second.stderr)}`);
    const afterSecond = readLedger(dir)[0];
    assert.equal(afterSecond.status, 'discharged', 'the status is still discharged — never toggled, never re-flipped');
    assert.deepEqual(
      afterSecond.disposition,
      afterFirst.disposition,
      `the ORIGINAL disposition survives verbatim — a repeat may refuse or no-op, but never overwrite the recorded justification: ${JSON.stringify(afterSecond.disposition)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L9 — A REFUSAL NEVER CLAIMS A WRITE (roster review LOW-1).
//
// The legacy arm prints one DISCLOSURE that is a claim about a WRITE: that a
// stray, unauthenticated `status:'discharged'` on the target entry is being
// REPLACED with an authenticated marker. Every refusal in this verb promises
// "nothing written", so that line must be unreachable on every refusing path —
// it was printed beside the marker check, above the class verdict, so a
// contradicted class or an unresolvable identity told the conductor a
// replacement had happened over a byte-identical ledger. The conduct rule is
// no-false-action-claims, and it bites hardest here because the reader's next
// move is to trust the ledger state the line describes.
//
// THE CONTROL RUNS FIRST. L9's verdict ("the line is absent") is satisfied
// trivially by deleting the disclosure altogether, which would lose a real
// signal — L9-0 is the same fixture with a class that HOLDS, so the line must be
// PRESENT there and its claim must be TRUE.
// ===========================================================================

// EXPECTED STATE: GREEN once the disclosure sits below the verdict.
// SABOTAGE: delete the disclosure entirely -> this control goes red while L9
// stays green, which is how "moved below the verdict" is told apart from
// "removed". SECOND SABOTAGE: print the line but skip the disposition write ->
// the reason assertion goes red; the claim must be true, not merely made.
test('legacy-handle L9-0 (CONTROL, first): on a SUCCEEDING legacy discharge the stray-marker disclosure IS printed, and the replacement it claims really happened', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // Foreign session => 'foreign-session' genuinely holds, so the verdict passes.
    const stray = v1({ session_id: 'a-session-that-ended', extra: { status: 'discharged' } });
    writeLedger(dir, [stray]);

    const r = runLedger(dir, [
      'discharge', '--legacy-handle', legacyReceiptHandle(stray), '--digest', ledgerDigest(dir),
      '--class', 'foreign-session', '--reason', 'the real, accountable justification',
    ]);
    assert.equal(r.code, 0, `the discharge succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /bare status|stray/i, `the stray marker being overwritten is DISCLOSED, never silent — stderr=${flat(r.stderr)}`);
    const after = readLedger(dir)[0];
    assert.equal(after.status, 'discharged', 'and the claimed replacement really happened');
    assert.equal(after.disposition.reason, 'the real, accountable justification', 'with the authenticated disposition in place of the bare marker');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED while the disclosure sits above the class verdict — every
// arm refuses, the ledger stays byte-identical, and the line is printed anyway.
// SABOTAGE (the one this pin exists for): move the console.error back beside the
// marker check, or drop the `verdict.ok` ordering -> every arm's doesNotMatch
// assertion goes red. The ledger assertions are deliberately paired with the
// stderr ones in each arm: a green here must mean "refused AND said nothing about
// a write", never "said nothing because it wrote".
// ARM COVERAGE is by REFUSAL DEPTH, because the disclosure must be below ALL of
// them: the digest check (earliest), the class verdict (latest, and the one the
// finding named), and the identity-unknown path in between.
test('legacy-handle L9: when a legacy discharge REFUSES, the stray-marker "REPLACES" disclosure is never printed — a refusal that claims a write is a false action claim', { skip: GIT_SKIP }, () => {
  const arms = [
    // Same session AND same branch as the fixture repo => both foreign classes
    // are CONTRADICTED and refuse at the verdict — the finding's own shape.
    ['contradicted foreign-session', { session_id: SESSION, branch: 'main' }, 'foreign-session', (dir) => ledgerDigest(dir)],
    ['contradicted foreign-branch', { session_id: SESSION, branch: 'main' }, 'foreign-branch', (dir) => ledgerDigest(dir)],
    // No recorded identity => UNKNOWN IS NOT FOREIGN, refuses before a verdict is
    // available at all.
    ['identity unknown', { session_id: '', branch: '' }, 'foreign-session', (dir) => ledgerDigest(dir)],
    // A stale token refuses at the very top of the critical section, long before
    // the entry is even resolved.
    ['stale digest', { session_id: 'a-session-that-ended' }, 'foreign-session', () => createHash('sha256').update('not the ledger bytes').digest('hex')],
  ];
  for (const [label, identity, cls, digestOf] of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const stray = v1({ ...identity, extra: { status: 'discharged' } });
      writeLedger(dir, [stray]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--legacy-handle', legacyReceiptHandle(stray), '--digest', digestOf(dir),
        '--class', cls, '--reason', `[${label}] this invocation must write nothing`,
      ]);
      assert.notEqual(r.code, 0, `[${label}] must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical — nothing was written`);
      assert.equal(readLedger(dir)[0].disposition, undefined, `[${label}] and no disposition was recorded`);
      // THE PIN: having written nothing, the CLI must not have said it did.
      assert.doesNotMatch(
        r.stderr,
        /REPLACES the stray marker|replaces the stray/i,
        `[${label}] a refusal must never claim the stray marker was replaced — nothing was written — stderr=${flat(r.stderr)}`
      );
      assert.doesNotMatch(
        r.stderr,
        /bare status/i,
        `[${label}] the stray-marker disclosure belongs BELOW the class verdict, so no refusing path reaches it — stderr=${flat(r.stderr)}`
      );
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] a refusal, not a crash — stderr=${flat(r.stderr)}`);
      assertNoLedgerResidue(dir, `L9 ${label}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// L10 — THE TWO SELECTORS' CANDIDATE SETS ARE SCHEMA-DISJOINT (Codex review
// MED-1, thread 01a05c7b).
//
// `entry_id` is meaningful ONLY inside the v2 envelope. On a legacy entry it is
// an unowned stray field — and the ledger is agent-writable, so ANYTHING can add
// one. While the v2 arm matched every object carrying the id, a single stray key
// on a v1 entry joined the candidate set, made the selector AMBIGUOUS, and
// BLOCKED the discharge of a perfectly valid v2 receipt: a one-key denial of
// service against the other selector, needing no forged v2 entry at all.
//
// THE CONTROL RUNS FIRST because L10's verdict ("the v2 entry discharges") is
// satisfied by any CLI that ignores the stray — including one that ignores
// schema version entirely and got lucky on ordering. L10-0 is the same fixture
// with no stray at all, so it must pass for the plain reason.
// ===========================================================================

// EXPECTED STATE: GREEN — this is D0's shape with a single-entry ledger.
// SABOTAGE: break the v2 arm's selection outright -> this goes red and L10's
// green means nothing.
test('legacy-handle L10-0 (CONTROL, first): with no stray present, --entry-id discharges the v2 entry plainly', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeLedger(dir, [v2({ entry_id: V2_ID, session_id: 'a-session-that-ended' })]);
    const r = runLedger(dir, ['discharge', '--entry-id', V2_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'plain v2 discharge']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir)[0].status, 'discharged');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED while the v2 arm matches every object carrying the id — the
// stray joins the candidate set, the selector reports AMBIGUOUS, and `r.code === 0`
// fires in BOTH orderings.
// SABOTAGE (the one this pin exists for): drop the isLegacyEntry filter from the
// v2 selection loop -> both arms go red. BOTH ORDERINGS ARE ASSERTED because a
// first-match implementation passes one and fails the other, and a single-order
// fixture would call that a pass half the time.
// SECOND SABOTAGE: fix the ambiguity by preferring the FIRST v2 entry found while
// still admitting v1 candidates -> the stray-untouched assertion still holds but
// the ambiguity is masked rather than removed; the L10b arm below (two v1 strays,
// no v2 at all) is what catches that, since a lenient arm would discharge one.
test('legacy-handle L10: a LEGACY entry carrying the same entry_id as a real v2 entry never joins the v2 candidate set — the v2 receipt discharges, the stray is untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    for (const [label, order] of [['stray first', 'stray-first'], ['v2 first', 'v2-first']]) {
      const stray = { ...v1({}), entry_id: V2_ID }; // an unowned stray field on a v1 entry
      const real = v2({ entry_id: V2_ID, session_id: 'a-session-that-ended' });
      writeLedger(dir, order === 'stray-first' ? [stray, real] : [real, stray]);

      const r = runLedger(dir, ['discharge', '--entry-id', V2_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', `[${label}] the v2 entry is the target`]);
      assert.equal(r.code, 0, `[${label}] a stray v1 entry_id must not block a valid v2 discharge — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

      const after = readLedger(dir);
      const dischargedV2 = after.find((e) => e.schema_version === 2);
      const untouchedV1 = after.find((e) => e.schema_version !== 2);
      assert.equal(dischargedV2.status, 'discharged', `[${label}] the V2 entry is the one discharged`);
      assert.equal(untouchedV1.status, undefined, `[${label}] the v1 stray is NOT discharged — it was never a candidate`);
      assert.equal(untouchedV1.disposition, undefined, `[${label}] and gains no disposition`);
      assert.equal(JSON.parse(r.stdout).schema_version, 2, `[${label}] the report says which shape was written`);
    }
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED while v1 entries are v2 candidates — two of them collide,
// and the refusal talks about duplicate ids rather than redirecting to handles.
// SABOTAGE: make the zero-match refusal a bare "not found" with no diagnostic ->
// the handle assertions go red, and a conductor holding a v1 entry with a stray id
// is dead-ended exactly as before the handle existed. The diagnostic must NOT
// promote a target: the code/status assertions are what pin that it stays a
// refusal.
test('legacy-handle L10b: --entry-id matching ONLY legacy entries refuses (never discharges one) and REDIRECTS to each of their handles', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const a = { ...v1({}), entry_id: V2_ID };
    const b = { ...v1({ agent_type: 'reviewer-other' }), entry_id: V2_ID };
    writeLedger(dir, [a, b]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, ['discharge', '--entry-id', V2_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'v1 entries are not v2 addresses']);
    assert.notEqual(r.code, 0, `no v2 entry carries this id, so the selector matches nothing — REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a legacy entry is never discharged through the v2 selector');
    assert.ok(r.stderr.includes(legacyReceiptHandle(a)), `the refusal redirects to the FIRST stray's handle — stderr=${flat(r.stderr)}`);
    assert.ok(r.stderr.includes(legacyReceiptHandle(b)), `and to the SECOND's — a redirect naming only one of two sends the conductor at the wrong receipt — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /legacy|handle/i, `and explains that entry_id is not a v1 address — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED while `v2_deficient` is consulted on the legacy arm — the
// stray key routes the entry into the deficiency refusal.
// SABOTAGE: drop the `legacyHandle === null` guard from the deficiency check ->
// red. `v2_deficient` is computed BY the adapter for a v2 entry but is just
// another writer-supplied key on a v1 one (the adapter returns a legacy entry
// untouched), so honoring it here re-strands the receipt with one key — the same
// laundering family as the dischargeMarkerClass finding, pointed the other way.
test('legacy-handle L10c: a stray v2_deficient key on a LEGACY entry does not block its discharge — that field is only trustworthy on a v2 entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    for (const stray of [true, false]) {
      const legacy = { ...v1({}), v2_deficient: stray };
      writeLedger(dir, [legacy]);
      const r = runLedger(dir, [
        'discharge', '--legacy-handle', legacyReceiptHandle(legacy), '--digest', ledgerDigest(dir),
        '--class', 'foreign-session', '--reason', `a stray v2_deficient:${stray} must not refuse a v1 discharge`,
      ]);
      assert.equal(r.code, 0, `[v2_deficient:${stray}] the legacy discharge must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedger(dir)[0].status, 'discharged', `[v2_deficient:${stray}] and the entry is discharged`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L11 — A REPEATED SELECTOR FLAG REFUSES, NEVER FIRST-WINS (Codex review MED-2).
//
// argv parsing returns the FIRST occurrence's value while the validation only
// asks whether the flag is PRESENT, so `--legacy-handle X --legacy-handle Y`
// silently acted on X while the caller was looking at Y. That is the same
// forgiving-address defect L4 closes one level up, arriving through the argument
// parser instead of through the handle's spelling — and it is the shape a
// copy-paste retry produces naturally.
// ===========================================================================

// EXPECTED STATE: RED while the parser first-wins — the FIRST arm discharges
// entry A (exit 0) while the caller named B last.
// SABOTAGE (the "surely identical values are fine" relaxation): accept a repeat
// when both values are EQUAL -> the identical-repeat arm goes red. A duplicated
// flag means the caller does not know what they typed, and equality of two values
// this CLI never asked for is not evidence of intent.
// SABOTAGE (over-correction): refuse ANY repeated flag, including --reason or
// --class -> the CONTROL at the end goes red if it catches a legitimate single
// invocation; the scope here is deliberately the two SELECTORS, which are the
// destructive-addressing surface.
test('legacy-handle L11: a selector flag given more than once is REFUSED naming the duplication — never silently resolved to the first (or last) occurrence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const a = v1({});
    const b = v1({ agent_type: 'reviewer-other' });
    writeLedger(dir, [a, b, v2({ entry_id: V2_ID, session_id: 'a-session-that-ended' })]);
    const before = readLedgerRaw(dir);

    const arms = [
      ['--legacy-handle twice, DIFFERENT values', ['--legacy-handle', legacyReceiptHandle(a), '--legacy-handle', legacyReceiptHandle(b)]],
      ['--legacy-handle twice, IDENTICAL values', ['--legacy-handle', legacyReceiptHandle(a), '--legacy-handle', legacyReceiptHandle(a)]],
      ['--entry-id twice', ['--entry-id', V2_ID, '--entry-id', 'e0000000-0000-4000-8000-00000000000b']],
      ['--entry-id three times', ['--entry-id', V2_ID, '--entry-id', V2_ID, '--entry-id', V2_ID]],
    ];
    for (const [label, selector] of arms) {
      const r = runLedger(dir, ['discharge', ...selector, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', `[${label}] must write nothing`]);
      assert.notEqual(r.code, 0, `[${label}] a repeated selector must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical — no occurrence wins`);
      assert.match(r.stderr, /given \d+ times|repeat|more than one|duplicat/i, `[${label}] the refusal NAMES the duplication rather than some downstream symptom — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] a refusal, not a crash — stderr=${flat(r.stderr)}`);
    }
    // CONTROL, LAST: exactly one selector still works on this same ledger, so the
    // refusals above are about the REPETITION and not about the fixture.
    const ok = runLedger(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(a), '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'exactly one selector']);
    assert.equal(ok.code, 0, `a single selector still discharges — stdout=${ok.stdout} stderr=${flat(ok.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN. SABOTAGE: move the console.error back above the write
// (either position it previously held) -> `claim > rename` goes red.
// WHY A SOURCE PIN: the behaviour it guards is only reachable when
// writeFileSync/renameSync THROWS, and that throw cannot be provoked from a
// fixture — the ledger lock is a directory inside .sterling, so a read-only
// .sterling fails at the lock's mkdirSync and never reaches the write at all
// (measured: EACCES on review-ledger.lock). The tmp filename embeds the pid, so
// it cannot be pre-occupied either, and chmod-on-a-directory is a no-op on
// native Windows. A behavioural pin over that fixture would pass vacuously —
// green with the disclosure back in the wrong place — which is worse than none.
test('legacy-handle L12: the stray-marker replacement claim is emitted only AFTER the atomic replace — a write that throws must not leave a completed-write claim on stderr', () => {
  const src = readFileSync(join(root, 'scripts', 'review-ledger.mjs'), 'utf8');
  const rename = src.indexOf('renameSync(tmpPath, ledgerFilePath)');
  const claim = src.indexOf('REPLACES the stray marker');
  assert.ok(rename > 0, 'anchor: the atomic replace is present');
  assert.ok(claim > 0, 'anchor: the replacement disclosure is present');
  assert.ok(
    claim > rename,
    `the disclosure claims a COMPLETED write, so it must sit below renameSync — a throw from writeFileSync/renameSync (permissions, full disk) is not a ` +
      `Refusal, propagates out of withLedgerLock and is re-raised at the call site, leaving the ledger byte-identical after stderr already announced the ` +
      `replacement. Found the claim at ${claim}, the rename at ${rename}.`
  );
});
