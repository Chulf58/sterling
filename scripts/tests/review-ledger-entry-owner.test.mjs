// R1 GROUP B — UNIT PINS FOR THE RECEIPT/LEDGER SHAPE OWNER
// scripts/hooks/lib/review-ledger-entry.mjs is THE ONE parser authority for
// the ReceiptV2 / ExternalReview / legacy-v1 shapes and for ledger IO.
// Contract source: decision `review-receipt-rebuild-invariant-three-owner-
// modules-tri-state-liveness-receipt-bound-supersession` + contract sheet
// §1.2, §1.4 and amendments A3/A5/A9 (which override §1-§5).
//
// WHAT THIS FILE PINS (contracts, never prose):
//   - the export surface: the owner's names exist, and the six collapsed
//     names do NOT (one parser per shape, no second authority);
//   - classifyLedgerEntry's four kinds and the single malformed code;
//   - parseReceipt is v2-ONLY, composed of the five exported sub-parsers;
//   - A3: a missing content_evidence.basis on a pre-rebuild v2 entry READS as
//     'stop-time-worktree-snapshot' (compatible parsing, not a second adapter);
//   - receiptCoveredPaths = declared normalized territory.files WITH usable
//     byte evidence (A9) — a declared path without a blob is NOT covered;
//   - receiptIsSpendable's closed code set, one fixture per code, control first;
//   - adaptLegacyEntry as the ONLY v1 reader: 'legacy', receipt-<32hex> handle,
//     never rewrites its input, never spendable;
//   - readLedger's tri-state availability and that a corrupt read never
//     mutates or truncates the file;
//   - A5: ONE owner-mkdir lock, NO age takeover, NO force — refusal carries
//     code 'ledger_lock_held' and names the dir + owner.
//
// RETIRED (behaviours the rebuild decision removes; named here so the review
// can see what was dropped rather than silently lost):
//   RETIRED: normalizeLedgerEntry pins — five validators for one entry shape
//     collapse into classifyLedgerEntry/parseReceipt.
//   RETIRED: dischargeMarkerClass / isAuthenticatedDischarge pins — the two
//     authenticity notions collapse: a disposition either parses or the entry
//     is malformed.
//   RETIRED: v1ReceiptFingerprint pins — folded into adaptLegacyEntry's handle.
//   RETIRED: receiptBlobEvidence / receiptBlobMap pins — the blob map is
//     receipt.content_evidence.blobs, read through parseContentEvidence.
//
// RE-CUT: R1-B32* — lock is async-only; the sync/throws form was a wrong pin (2026-09-07)
//
// The module is imported as a NAMESPACE, deliberately: a missing named export
// must fail an assertion, not crash the file at link time.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER_PATH = join(root, 'scripts', 'hooks', 'lib', 'review-ledger-entry.mjs');

let owner = null;
let importError = null;
before(async () => {
  try {
    owner = await import(pathToFileURL(OWNER_PATH).href);
  } catch (e) {
    importError = e;
  }
});

function mod() {
  if (!owner) assert.fail(`scripts/hooks/lib/review-ledger-entry.mjs failed to import: ${importError?.message ?? 'unknown'}`);
  return owner;
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ledger-owner-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ledgerFile = (dir) => join(dir, '.sterling', 'review-ledger.json');
const lockDirOf = (dir) => join(dir, '.sterling', 'review-ledger.lock');
const writeLedgerRaw = (dir, content) => writeFileSync(ledgerFile(dir), typeof content === 'string' ? content : JSON.stringify(content));

const SHA40 = (c) => String(c).repeat(40).slice(0, 40);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// A complete, valid, spendable ReceiptV2 (contract sheet §1.2). Every fixture
// below varies EXACTLY ONE field from this base, so a verdict has one cause.
function receiptV2(over = {}) {
  return {
    schema_version: 2,
    entry_id: '11111111-2222-4333-8444-555555555555',
    kind: 'roster_receipt',
    status: 'active',
    started_at: '2026-09-07T00:00:00.000Z',
    finished_at: '2026-09-07T00:10:00.000Z',
    reviewer: { agent_type: 'reviewer-correctness', model: 'claude-x', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: 's1', branch: 'main', base_sha: SHA40('a'), agent_id: 'rev-1' },
    territory: { files: ['src/a.mjs'], source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot',
      status: 'complete',
      blobs: { 'src/a.mjs': SHA40('b') },
      absent_paths: [],
    },
    ...over,
  };
}

const SPEND_CTX = { session_id: 's1', branch: 'main' };

const externalReview = (over = {}) => ({
  schema_version: 2,
  entry_id: '99999999-2222-4333-8444-555555555555',
  kind: 'external_review',
  status: 'active',
  recorded_at: '2026-09-07T00:00:00.000Z',
  provider: 'codex',
  thread_id: '01a07af6',
  round: 1,
  note: 'contract round',
  files: ['scripts/review-ledger.mjs'],
  disposition: null,
  ...over,
});

// The pre-v2 flat shape, exactly as consumer ledgers still carry it.
const legacyV1 = (over = {}) => ({
  agent_type: 'reviewer-correctness',
  files: ['src/legacy.mjs'],
  at: '2026-08-20T00:00:00.000Z',
  session_id: 's0',
  branch: 'main',
  base_sha: SHA40('d'),
  ...over,
});

// ===========================================================================
// R1-B20 — EXPORT SURFACE. One parser authority per shape means the collapsed
// names must be GONE, not merely unused.
// SABOTAGE: keep `export { normalizeLedgerEntry }` (or any other retired name)
// as a thin alias during the rebuild — the second half of this test goes red
// while every behavioural pin below stays green, which is exactly why the
// absence is pinned separately from the behaviour.
// ===========================================================================

test('R1-B20: the shape owner exports exactly the rebuilt surface, and the six collapsed names are gone', () => {
  const m = mod();
  const FUNCTIONS = [
    'classifyLedgerEntry',
    'parseReceipt',
    'parseDisposition',
    'parseContentEvidence',
    'parseObservedEvidence',
    'parseReservation',
    'parseConsumption',
    'adaptLegacyEntry',
    'receiptCoveredPaths',
    'receiptIsSpendable',
    'normalizeReceiptPath',
    'isUsableBlobSha',
    'legacyReceiptHandle',
    'readLedger',
    'writeLedger',
    'ledgerDigest',
    'withLedgerLock',
    // A13: the code-path classifier is homed HERE, beside receiptCoveredPaths,
    // because deciding which staged paths need review coverage is a
    // shape-owner concern — not a trailer or register one.
    'isCodePath',
  ];
  for (const name of FUNCTIONS) {
    assert.equal(typeof m[name], 'function', `${name} is exported as a function by the shape owner`);
  }
  assert.ok(m.LEGACY_HANDLE_PATTERN instanceof RegExp, 'LEGACY_HANDLE_PATTERN is an exported RegExp');

  for (const gone of ['normalizeLedgerEntry', 'dischargeMarkerClass', 'isAuthenticatedDischarge', 'v1ReceiptFingerprint', 'receiptBlobEvidence', 'receiptBlobMap']) {
    assert.equal(m[gone], undefined, `${gone} is REMOVED — a surviving alias would be a second authority for a shape this module already owns`);
  }
});

// ===========================================================================
// R1-B21 — classifyLedgerEntry's four kinds. Each arm is a DIFFERENT input
// class, so no arm can be satisfied by a classifier that returns one constant.
// SABOTAGE: route a v1 entry through parseReceipt (drop the schema_version
// discriminator) — the 'legacy' arm goes red while 'receipt' stays green.
// ===========================================================================

test('R1-B21: classifyLedgerEntry returns receipt | external_review | legacy | malformed, and malformed carries code ledger_entry_malformed', () => {
  const { classifyLedgerEntry } = mod();

  const r = classifyLedgerEntry(receiptV2());
  assert.equal(r.kind, 'receipt');
  assert.equal(r.receipt.entry_id, '11111111-2222-4333-8444-555555555555');

  const x = classifyLedgerEntry(externalReview());
  assert.equal(x.kind, 'external_review');
  assert.equal(x.entry.thread_id, '01a07af6');

  const l = classifyLedgerEntry(legacyV1());
  assert.equal(l.kind, 'legacy', 'a flat v1 entry is classified legacy — never parsed as a receipt');

  const bad = classifyLedgerEntry({ nonsense: true });
  assert.equal(bad.kind, 'malformed');
  assert.equal(bad.code, 'ledger_entry_malformed');
  assert.ok(bad.facts && typeof bad.facts === 'object', 'a malformed classification carries facts, never a bare message');

  // A13: a non-uuid entry_id makes the entry malformed. An entry_id is the
  // spend/discharge/trailer ADDRESS — an unaddressable receipt cannot be
  // bound to a commit, so admitting one would create evidence nothing can
  // point at.
  // SABOTAGE: accept any non-empty string as an entry_id — this arm goes red
  // while every other classification arm stays green.
  const badId = classifyLedgerEntry(receiptV2({ entry_id: 'not-a-uuid' }));
  assert.equal(badId.kind, 'malformed');
  assert.equal(badId.code, 'ledger_entry_malformed');
});

// ===========================================================================
// R1-B22 — parseReceipt is v2-ONLY. A v1 entry reaching it must be refused,
// not quietly adapted: adaptLegacyEntry is the ONLY v1 reader.
// SABOTAGE: make parseReceipt fall back to adaptLegacyEntry on a missing
// schema_version — this test goes red while R1-B21's legacy arm stays green.
// ===========================================================================

test('R1-B22: parseReceipt refuses anything that is not schema_version 2 — the v1 shape reaches it never', () => {
  const { parseReceipt } = mod();
  for (const notV2 of [legacyV1(), receiptV2({ schema_version: 1 }), receiptV2({ schema_version: '2' })]) {
    const out = parseReceipt(notV2);
    assert.notEqual(out?.ok, true, `parseReceipt must refuse ${JSON.stringify(notV2.schema_version)}`);
  }
  const ok = parseReceipt(receiptV2());
  assert.equal(ok.ok, true, 'CONTROL: a genuine v2 receipt parses — the refusals above are not "refuse everything"');
});

// ===========================================================================
// R1-B23 — A3 (amendment, overrides §1.2): a pre-rebuild v2 entry whose
// content_evidence has NO `basis` key reads as 'stop-time-worktree-snapshot'.
// The CONTROL arm (an explicit basis) is first, so a green default arm cannot
// mean "basis is hardcoded for everything".
// SABOTAGE: refuse a missing basis as malformed (or leave it undefined) —
// the default arm goes red while the explicit arm stays green.
// ===========================================================================

test('R1-B23 (A3): content_evidence.basis defaults to stop-time-worktree-snapshot when absent on a pre-rebuild v2 entry', () => {
  const { parseContentEvidence, parseReceipt } = mod();

  const explicit = parseContentEvidence({ basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: {}, absent_paths: [] });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.value.basis, 'stop-time-worktree-snapshot', 'CONTROL: an explicit basis is preserved');

  const missing = parseContentEvidence({ status: 'complete', blobs: { 'src/a.mjs': SHA40('b') }, absent_paths: [] });
  assert.equal(missing.ok, true, 'a missing basis is compatible, never malformed');
  assert.equal(missing.value.basis, 'stop-time-worktree-snapshot', 'A3: the absent basis READS as the Stop-time worktree snapshot');

  const wholeEntry = parseReceipt(receiptV2({ content_evidence: { status: 'complete', blobs: { 'src/a.mjs': SHA40('b') }, absent_paths: [] } }));
  assert.equal(wholeEntry.ok, true, 'the compatibility lives INSIDE parseReceipt — not in a second adapter');
  assert.equal(wholeEntry.receipt.content_evidence.basis, 'stop-time-worktree-snapshot');
});

// ===========================================================================
// R1-B34 — territory.source and territory.attribution are CLOSED ENUMS, and
// the shape owner is where that is enforced. An unvalidated source is how an
// 'unattributable' receipt becomes spendable by accident: every downstream
// guard (receiptIsSpendable's receipt_unattributable arm, the discharge
// classes, supersession's coverage rules) branches on these two strings, so a
// junk value does not fail loudly — it falls through whichever branch the
// implementation happens to write last. A malformed entry is refused at
// CLASSIFICATION, so receiptIsSpendable is never consulted at all: there is no
// receipt to consult.
// CONTROL FIRST: all six valid (source, attribution) pairs parse, so a green
// refusal arm cannot mean "territory never validates".
// SABOTAGE: copy territory through unvalidated (today's behaviour) — every
// refusal arm goes red while the control stays green.
// ===========================================================================

test('R1-B34: parseReceipt validates territory.source and territory.attribution as closed enums; a bad value is ledger_entry_malformed naming the field', () => {
  const { parseReceipt, classifyLedgerEntry } = mod();

  for (const source of ['review-territory', 'free-prose-fallback', 'unattributable']) {
    for (const attribution of ['block', 'union']) {
      const ok = parseReceipt(receiptV2({ territory: { files: ['src/a.mjs'], source, attribution } }));
      assert.equal(ok.ok, true, `CONTROL: (${source}, ${attribution}) is a valid pair`);
      assert.equal(ok.receipt.territory.source, source);
      assert.equal(ok.receipt.territory.attribution, attribution);
    }
  }

  const BAD = [
    ['absent', undefined],
    ['a junk string', 'review_territory'],
    ['an object', { source: 'review-territory' }],
  ];

  for (const [label, badValue] of BAD) {
    const territory = { files: ['src/a.mjs'], attribution: 'block' };
    if (badValue !== undefined) territory.source = badValue;
    const raw = receiptV2({ territory });

    assert.notEqual(parseReceipt(raw).ok, true, `territory.source ${label} does not parse`);
    const classified = classifyLedgerEntry(raw);
    assert.equal(classified.kind, 'malformed', `territory.source ${label} is malformed at classification — never a receipt, so spendability is never consulted`);
    assert.equal(classified.code, 'ledger_entry_malformed');
    assert.equal(classified.facts.field, 'territory.source', 'the facts name WHICH field, so the operator is not left grepping the entry');
  }

  for (const [label, badValue] of BAD) {
    const territory = { files: ['src/a.mjs'], source: 'review-territory' };
    if (badValue !== undefined) territory.attribution = badValue;
    const raw = receiptV2({ territory });

    assert.notEqual(parseReceipt(raw).ok, true, `territory.attribution ${label} does not parse`);
    const classified = classifyLedgerEntry(raw);
    assert.equal(classified.kind, 'malformed', `territory.attribution ${label} is malformed at classification`);
    assert.equal(classified.code, 'ledger_entry_malformed');
    assert.equal(classified.facts.field, 'territory.attribution');
  }
});

// ===========================================================================
// R1-B34b — 'none' JOINS THE ATTRIBUTION ENUM (and 'union' stays for legacy).
// Since decision 7c515e52, H22 writes attribution 'none' for an unattributable
// or RESUMED Start — the case where there is no dispatch slot to attribute the
// review to — and it never writes 'union' any more. 'union' therefore stays
// ACCEPTED for entries already in consumer ledgers, while 'none' must parse or
// every receipt the current H22 writes is malformed at classification: not
// merely unspendable, but INVISIBLE, because a malformed entry never becomes a
// receipt at all. That is the shape of an outage, not a degradation.
//
// `attribution_case` rides beside it as the READABLE reason ('no-slot'), so the
// distinction between "attributed to nobody because there was no slot" and a
// junk value is legible downstream rather than inferred.
//
// THE CONTROL IS 'bogus', PLACED SECOND AND LOAD-BEARING: widening an enum by
// removing its validation would make this whole test green while re-opening
// exactly the hole R1-B34 exists to close (an unvalidated attribution falls
// through whichever branch the implementation wrote last). So the arms must
// disagree: 'none' parses, 'bogus' is malformed naming the field.
// ===========================================================================

// EXPECTED TODAY: RED. The closed set is block|union, so 'none' does not parse: the first
// assertion below (`ok.ok === true`) fires, and R1-B34's own BAD-value loop stays green
// throughout — which is why this is a separate arm rather than another entry in that loop.
// SABOTAGE (the widening this pin authorises, done wrong): drop the attribution validation
// instead of adding 'none' to the set -> the 'bogus' control reds while every 'none' assertion
// goes green. That single pair of results is the difference between admitting one new value and
// re-opening the enum.
// SABOTAGE (dropping the reason): admit 'none' but discard attribution_case -> the
// attribution_case assertion reds alone; without it 'no-slot' is indistinguishable from any
// other reason a receipt ended up attributed to nobody.
// SABOTAGE (the legacy half): replace 'union' with 'none' in the set rather than adding to it
// -> the 'union' arm reds; every union-attributed entry in a consumer ledger would become
// malformed on upgrade.
test('R1-B34b (7c515e52): territory.attribution accepts "none" with attribution_case "no-slot" and still accepts legacy "union" — while "bogus" stays ledger_entry_malformed {field:"territory.attribution"}', () => {
  const { parseReceipt, classifyLedgerEntry } = mod();

  const noSlot = receiptV2({ territory: { files: ['src/a.mjs'], source: 'unattributable', attribution: 'none', attribution_case: 'no-slot' } });
  const ok = parseReceipt(noSlot);
  assert.equal(ok.ok, true, 'a receipt H22 writes for a resumed or unattributable Start must PARSE — a malformed entry is not an unspendable receipt, it is no receipt at all');
  assert.equal(ok.receipt.territory.attribution, 'none', 'and the value survives parsing, readable downstream');
  assert.equal(ok.receipt.territory.attribution_case, 'no-slot', 'beside the CASE that explains it — "attributed to nobody because there was no slot" is a fact, not an inference');
  assert.equal(classifyLedgerEntry(noSlot).kind, 'receipt', 'so it is classified as a receipt, never malformed');

  const legacyUnion = parseReceipt(receiptV2({ territory: { files: ['src/a.mjs'], source: 'review-territory', attribution: 'union' } }));
  assert.equal(legacyUnion.ok, true, 'CONTROL (legacy): "union" is no longer written but is still ACCEPTED — consumer ledgers already carry it');
  assert.equal(legacyUnion.receipt.territory.attribution, 'union');

  const raw = receiptV2({ territory: { files: ['src/a.mjs'], source: 'review-territory', attribution: 'bogus' } });
  assert.notEqual(parseReceipt(raw).ok, true, 'CONTROL (the enum is still CLOSED): an unknown attribution does not parse');
  const classified = classifyLedgerEntry(raw);
  assert.equal(classified.kind, 'malformed', 'admitting "none" must not be implemented by deleting the validation');
  assert.equal(classified.code, 'ledger_entry_malformed');
  assert.equal(classified.facts.field, 'territory.attribution', 'and the facts still name WHICH field');
});

// ===========================================================================
// R1-B24 — A9: receiptCoveredPaths is declared territory WITH usable byte
// evidence. A declared path with no blob (or an unusable one) is NOT covered.
// CONTROL FIRST: a fully-evidenced receipt covers its declared path, so a
// green "not covered" arm cannot mean "covers nothing, ever".
// SABOTAGE: return territory.files verbatim (drop the blob-usability filter)
// — the two negative arms go red while the control stays green. That is the
// laundering route this pin exists to close: a declared-but-unhashed path
// would otherwise count as reviewed bytes at spend time.
// ===========================================================================

test('R1-B24 (A9): receiptCoveredPaths = declared normalized paths that HAVE usable byte evidence — declared-without-blob is not covered', () => {
  const { receiptCoveredPaths } = mod();

  assert.deepEqual(receiptCoveredPaths(receiptV2()), ['src/a.mjs'], 'CONTROL: a declared path with a usable blob is covered');

  const noBlob = receiptV2({
    territory: { files: ['src/a.mjs', 'src/no-evidence.mjs'], source: 'review-territory', attribution: 'block' },
  });
  assert.deepEqual(receiptCoveredPaths(noBlob), ['src/a.mjs'], 'a declared path with no blob at all is NOT covered');

  const unusableBlob = receiptV2({
    territory: { files: ['src/a.mjs', 'src/bad.mjs'], source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'partial', blobs: { 'src/a.mjs': SHA40('b'), 'src/bad.mjs': 'not-a-sha' }, absent_paths: [] },
  });
  assert.deepEqual(receiptCoveredPaths(unusableBlob), ['src/a.mjs'], 'a blob that is not a usable sha is no evidence — the path is not covered');

  const undeclaredBlob = receiptV2({
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: { 'src/a.mjs': SHA40('b'), 'src/never-declared.mjs': SHA40('c') }, absent_paths: [] },
  });
  assert.deepEqual(receiptCoveredPaths(undeclaredBlob), ['src/a.mjs'], 'evidence for an UNDECLARED path never widens coverage');
});

// A13: DELETIONS ARE COVERABLE. A declared path recorded in absent_paths was
// genuinely observed at Stop — "this file was not there" is evidence, and a
// reviewed deletion would otherwise be permanently uncoverable.
// SABOTAGE: keep coverage as blob-backed-only (the pre-A13 rule) — the
// deletion arm goes red while every arm in R1-B24 stays green, and a reviewed
// deletion can never be committed without a waiver.
// SABOTAGE (the opposite): treat any declared path as covered once absent_paths
// is non-empty — the still-uncovered arm below goes red.
test('R1-B24b (A13): a declared path listed in absent_paths IS covered — a reviewed deletion is evidence, not a coverage gap', () => {
  const { receiptCoveredPaths } = mod();

  const withDeletion = receiptV2({
    territory: { files: ['src/a.mjs', 'src/deleted.mjs', 'src/no-evidence.mjs'], source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot',
      status: 'partial',
      blobs: { 'src/a.mjs': SHA40('b') },
      absent_paths: ['src/deleted.mjs'],
    },
  });
  assert.deepEqual(
    receiptCoveredPaths(withDeletion).sort(),
    ['src/a.mjs', 'src/deleted.mjs'],
    'coverage is blob-backed paths UNION absent_paths'
  );
  assert.ok(!receiptCoveredPaths(withDeletion).includes('src/no-evidence.mjs'), 'a declared path with NEITHER a blob nor an absence record is still uncovered');
});

// A13: isCodePath is the ONE predicate deciding which staged paths need review
// coverage. It lives here beside receiptCoveredPaths so coverage has a single
// authority; the sheet fixes the two pinned examples.
// SABOTAGE: classify by "is it tracked by git" instead of by the configured
// code globs — the docs arm goes red, and every documentation-only commit
// starts demanding a review receipt.
test('R1-B25d (A13): isCodePath classifies src/**/*.mjs as code and docs/**/*.md as non-code', () => {
  const { isCodePath } = mod();
  const config = {};
  assert.equal(isCodePath('src/a.mjs', config), true, 'CONTROL: a source file is code');
  assert.equal(isCodePath('docs/notes.md', config), false, 'a documentation file is not code — it needs no review coverage');
});

// ===========================================================================
// R1-B25 — receiptIsSpendable's closed code set (§1.2 + A9). Each fixture
// varies exactly ONE field from the spendable base, so each verdict has one
// possible cause and no code's arm can be satisfied by another's condition.
// CONTROL FIRST: the base receipt IS spendable — without it, every {ok:false}
// arm below is equally satisfied by "nothing is ever spendable".
// SABOTAGE: return {ok:true} unconditionally — every arm but the control goes
// red. SABOTAGE (per-code): drop the `identity.session_id == null` check and
// let a null session fall through to the foreign-session comparison — the
// receipt_identity_unknown arm goes red with code receipt_foreign_session,
// which is precisely the 'unknown is not foreign' confusion the decision
// names.
// ===========================================================================

test('R1-B25: receiptIsSpendable — control is spendable; each unspendable shape returns its own code', () => {
  const { receiptIsSpendable } = mod();

  assert.deepEqual(receiptIsSpendable(receiptV2(), SPEND_CTX), { ok: true }, 'CONTROL (first): a complete, active, attributable, same-session/branch receipt is spendable');

  const cases = [
    ['receipt_not_active', receiptV2({ status: 'discharged', disposition: { class: 'superseded', reason: 'r', at: '2026-09-07T01:00:00.000Z', head_sha: SHA40('e'), classifier_version: 2, facts: {} } })],
    ['receipt_unattributable', receiptV2({ territory: { files: ['src/a.mjs'], source: 'unattributable', attribution: 'block' } })],
    ['receipt_identity_unknown', receiptV2({ identity: { session_id: null, branch: 'main', base_sha: SHA40('a'), agent_id: 'rev-1' } })],
    ['receipt_identity_unknown', receiptV2({ identity: { session_id: 's1', branch: null, base_sha: SHA40('a'), agent_id: 'rev-1' } })],
    ['receipt_foreign_session', receiptV2({ identity: { session_id: 's-other', branch: 'main', base_sha: SHA40('a'), agent_id: 'rev-1' } })],
    ['receipt_foreign_branch', receiptV2({ identity: { session_id: 's1', branch: 'sterling/other', base_sha: SHA40('a'), agent_id: 'rev-1' } })],
  ];
  for (const [code, receipt] of cases) {
    const verdict = receiptIsSpendable(receipt, SPEND_CTX);
    assert.equal(verdict.ok, false, `expected unspendable for ${code}`);
    assert.equal(verdict.code, code, `the ONE varied field yields exactly ${code}`);
  }
});

// A null session or branch makes a receipt DEFICIENT, not MALFORMED: it parses
// (it is real evidence of a real review) and is refused only at SPEND. Pinning
// both halves matters — a parser that rejected it outright would erase the
// evidence, and a spender that accepted it would read 'unknown' as 'local'.
// SABOTAGE: refuse a null identity.session_id inside parseReceipt — the parse
// half goes red while R1-B25's receipt_identity_unknown arm keeps passing for
// the wrong reason (an unparseable entry is not a spendable one either).
test('R1-B25c: a v2 receipt with a null session_id or branch PARSES — it is deficient at spend time, never malformed at read time', () => {
  const { parseReceipt } = mod();
  for (const identity of [
    { session_id: null, branch: 'main', base_sha: SHA40('a'), agent_id: 'rev-1' },
    { session_id: 's1', branch: null, base_sha: SHA40('a'), agent_id: 'rev-1' },
    { session_id: null, branch: null, base_sha: null, agent_id: 'rev-1' },
  ]) {
    assert.equal(parseReceipt(receiptV2({ identity })).ok, true, `identity ${JSON.stringify(identity)} is deficient, not malformed`);
  }
});

// A4: resume_count and the refresh residue are GONE from the shape. Whether
// the owner refuses a stale entry carrying one or simply drops it is the
// coder's call; what is pinned is that it NEVER survives into a receipt a
// consumer can read.
// SABOTAGE: pass unknown top-level keys through untouched — this goes red, and
// with it the guarantee that a receipt's shape is what the sheet says it is.
test('R1-B29b (A4): resume_count never survives parsing — the refresh residue cannot re-enter through a stale ledger', () => {
  const { parseReceipt } = mod();
  const out = parseReceipt(receiptV2({ resume_count: 3 }));
  assert.ok(!out.ok || !('resume_count' in out.receipt), 'a receipt carrying resume_count either does not parse or parses without it — never with it');
});

test('R1-B25b: a reserved and a consumed receipt are both receipt_not_active — status, never a lifecycle guess', () => {
  const { receiptIsSpendable } = mod();
  const reserved = receiptV2({ status: 'reserved', reservation: { nonce: 'n1', at: '2026-09-07T00:20:00.000Z', index_blobs: { 'src/a.mjs': SHA40('b') }, operation: 'commit-reviewed' } });
  const consumed = receiptV2({ status: 'consumed', consumption: { commit_sha: SHA40('f'), consumed_at: '2026-09-07T00:30:00.000Z', nonce: 'n1' } });
  assert.equal(receiptIsSpendable(reserved, SPEND_CTX).code, 'receipt_not_active');
  assert.equal(receiptIsSpendable(consumed, SPEND_CTX).code, 'receipt_not_active');
});

// ===========================================================================
// R1-B26 — adaptLegacyEntry is the ONLY v1 reader: a stable receipt-<32hex>
// handle, never a rewrite of its input, never spendable. ONE fixture per
// legacy shape (the v1 construction fixtures elsewhere are retired in favour
// of this pin).
// SABOTAGE: have adaptLegacyEntry normalize its argument in place (assign
// entry.schema_version = 2, or attach the handle to the input object) — the
// no-mutation assertion goes red while the handle assertions stay green; that
// mutation is how a "read" silently rewrites durable evidence.
// ===========================================================================

test('R1-B26: adaptLegacyEntry yields kind legacy with a receipt-<32hex> handle, never rewrites its input, and is never spendable', () => {
  const { adaptLegacyEntry, legacyReceiptHandle, LEGACY_HANDLE_PATTERN, receiptIsSpendable, classifyLedgerEntry } = mod();

  const input = legacyV1();
  const snapshot = JSON.stringify(input);

  const out = adaptLegacyEntry(input);
  assert.equal(out.kind, 'legacy');
  assert.match(out.handle, /^receipt-[0-9a-f]{32}$/, 'the handle is the discharge address for a v1 entry');
  assert.match(out.handle, LEGACY_HANDLE_PATTERN, 'LEGACY_HANDLE_PATTERN is the exported matcher for that same handle');
  assert.equal(out.agent_type, 'reviewer-correctness');
  assert.deepEqual(out.files, ['src/legacy.mjs']);
  assert.equal(out.branch, 'main');
  assert.ok(['active', 'discharged'].includes(out.status), 'a legacy entry carries only the two lifecycle states v1 could express');

  assert.equal(JSON.stringify(input), snapshot, 'reading a v1 entry NEVER rewrites it — the input object is untouched');

  assert.equal(adaptLegacyEntry(legacyV1()).handle, out.handle, 'the handle is deterministic for identical v1 bytes');
  assert.notEqual(adaptLegacyEntry(legacyV1({ files: ['src/other.mjs'] })).handle, out.handle, 'a different v1 entry gets a different handle');

  assert.equal(legacyReceiptHandle(legacyV1()), out.handle, 'legacyReceiptHandle is the same address, exported for the CLI');

  assert.notEqual(classifyLedgerEntry(legacyV1()).kind, 'receipt', 'a legacy entry is never presented as a spendable receipt');
  const asIfSpendable = receiptIsSpendable(legacyV1(), SPEND_CTX);
  assert.notEqual(asIfSpendable?.ok, true, 'a v1 entry can never be spent — it is dischargeable via --legacy-handle only');
});

// ===========================================================================
// R1-B27 — normalizeReceiptPath / isUsableBlobSha, the two primitives every
// coverage and byte comparison depends on.
// STATED READING (reported, not silently invented): normalization is POSIX
// repo-relative — a leading './' is stripped and backslashes become forward
// slashes; the function is idempotent.
// SABOTAGE (isUsableBlobSha): accept any non-empty string — the 39/41-hex and
// non-hex arms go red, and R1-B24's unusable-blob arm goes red with it.
// ===========================================================================

test('R1-B27: normalizeReceiptPath is idempotent POSIX-repo-relative; isUsableBlobSha accepts only a 40-hex blob', () => {
  const { normalizeReceiptPath, isUsableBlobSha } = mod();

  assert.equal(normalizeReceiptPath('src/a.mjs'), 'src/a.mjs', 'CONTROL: an already-normal path is unchanged');
  assert.equal(normalizeReceiptPath('./src/a.mjs'), 'src/a.mjs');
  assert.equal(normalizeReceiptPath('src\\a.mjs'), 'src/a.mjs');
  assert.equal(normalizeReceiptPath(normalizeReceiptPath('./src\\a.mjs')), 'src/a.mjs', 'idempotent');

  assert.equal(isUsableBlobSha(SHA40('a')), true, 'CONTROL: a 40-hex blob is usable');
  for (const bad of ['', null, undefined, 40, SHA40('a').slice(0, 39), SHA40('a') + 'a', 'z'.repeat(40), '   ']) {
    assert.equal(isUsableBlobSha(bad), false, `not a usable blob sha: ${JSON.stringify(bad)}`);
  }
});

// ===========================================================================
// R1-B28 — the observed-evidence tri-state survives the parser unchanged:
// ABSENT means "could not observe", [] means "observed nothing". Collapsing
// them is the exact false-corroboration this convention exists to prevent.
// SABOTAGE: default observed_files to [] inside parseObservedEvidence — the
// absent arm goes red while the empty arm stays green.
// ===========================================================================

test('R1-B28: parseReceipt preserves the observed tri-state — absent stays absent, [] stays [], reads stay reads-only', () => {
  const { parseReceipt } = mod();

  const absent = parseReceipt(receiptV2());
  assert.equal(absent.ok, true);
  assert.ok(!('observed_files' in absent.receipt), 'ABSENT observed_files is preserved as absent — never fabricated as []');
  assert.ok(!('observed_source' in absent.receipt), 'observed_source is likewise absent when nothing was observed');

  const observedNothing = parseReceipt(receiptV2({ observed_files: [], observed_reads: [], observed_source: 'subagent-transcript' }));
  assert.equal(observedNothing.ok, true);
  assert.deepEqual(observedNothing.receipt.observed_files, [], 'observed-and-found-nothing is preserved as []');
  assert.deepEqual(observedNothing.receipt.observed_reads, []);
  assert.equal(observedNothing.receipt.observed_source, 'subagent-transcript');

  const observed = parseReceipt(
    receiptV2({ observed_files: ['src/a.mjs', 'src/w.mjs'], observed_reads: ['src/a.mjs'], observed_source: 'subagent-transcript', observed_truncated: true })
  );
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.receipt.observed_reads, ['src/a.mjs'], 'observed_reads is reads-only — the write-only path never leaks in');
  assert.equal(observed.receipt.observed_truncated, true, 'observed_truncated is carried only when true');
});

// ===========================================================================
// R1-B29 — the lifecycle sub-parsers. A disposition either PARSES or the entry
// is malformed: there is no authenticity notion left to satisfy separately
// (dischargeMarkerClass / isAuthenticatedDischarge are retired), and a new
// disposition is classifier_version 2.
// A11 SETTLES THE SECTIONS: `disposition` is PRESENT as null on every
// non-discharged receipt; `reservation`/`consumption` are ABSENT unless the
// status requires them; status 'reserved' without a reservation (or 'consumed'
// without a consumption) is MALFORMED — fail closed.
// SABOTAGE: accept a status 'reserved' entry with no reservation — the
// missing-section arm goes red while every complete arm stays green; a
// reservation-less 'reserved' receipt is one no reconcile could ever resolve.
// ===========================================================================

test('R1-B29: parseDisposition / parseReservation / parseConsumption parse their complete shapes and refuse the incomplete ones', () => {
  const { parseDisposition, parseReservation, parseConsumption, parseReceipt } = mod();

  const disposition = { class: 'superseded', reason: 'newer receipt covers it', at: '2026-09-07T01:00:00.000Z', head_sha: SHA40('e'), classifier_version: 2, facts: { form: 'entry' } };
  const d = parseDisposition(disposition);
  assert.equal(d.ok, true, 'a complete disposition parses — with no authentication marker of any kind required');
  assert.equal(d.value.classifier_version, 2);
  assert.notEqual(parseDisposition({ reason: 'no class at all' }).ok, true, 'a disposition missing its class does not parse');

  const reservation = { nonce: 'n1', at: '2026-09-07T00:20:00.000Z', index_blobs: { 'src/a.mjs': SHA40('b') }, operation: 'commit-reviewed' };
  assert.equal(parseReservation(reservation).ok, true);
  assert.notEqual(parseReservation({ ...reservation, index_blobs: 'junk' }).ok, true, 'a non-object index_blobs does not parse');

  const consumption = { commit_sha: SHA40('f'), consumed_at: '2026-09-07T00:30:00.000Z', nonce: 'n1' };
  assert.equal(parseConsumption(consumption).ok, true);
  assert.notEqual(parseConsumption({ ...consumption, commit_sha: 'not-a-sha' }).ok, true, 'a consumption whose commit_sha is not a sha does not parse');

  assert.equal(parseReceipt(receiptV2()).receipt.disposition, null, 'A11: disposition is PRESENT as null on every non-discharged receipt');
  assert.equal(parseReceipt(receiptV2({ status: 'reserved', reservation })).ok, true, 'CONTROL: status reserved WITH its reservation parses');
  assert.notEqual(parseReceipt(receiptV2({ status: 'reserved' })).ok, true, 'status reserved with NO reservation does not parse');
  assert.notEqual(parseReceipt(receiptV2({ status: 'consumed' })).ok, true, 'status consumed with NO consumption does not parse');
  assert.notEqual(parseReceipt(receiptV2({ status: 'discharged' })).ok, true, 'status discharged with NO disposition does not parse');
  assert.notEqual(parseReceipt(receiptV2({ status: 'invented' })).ok, true, 'status is a closed enum: active|reserved|consumed|discharged');
});

// ===========================================================================
// R1-B33 (A11) — finished_at/started_at are REQUIRED STRINGS but are NOT
// required to parse as dates: the evidence is recorded as it was captured, and
// a receipt whose clock is unreadable is still a receipt of a real review. The
// consequence is pushed to the surfaces that need an ORDER — spend discloses
// receipt_age_unverifiable, supersession refuses superseder_not_newer — rather
// than destroying the record at read time. A NON-STRING is malformed.
// CONTROL FIRST: an ordinary ISO timestamp parses, so a green admit-arm cannot
// mean "timestamps are not validated at all".
// SABOTAGE: reject an unparseable finished_at inside parseReceipt — the admit
// arm goes red, and with it the only route by which such a receipt could ever
// be discharged or superseded (an unparseable entry is unaddressable).
// ===========================================================================

test('R1-B33 (A11): parseReceipt ADMITS an unparseable finished_at (a string that is not a date) and REFUSES a non-string', () => {
  const { parseReceipt } = mod();

  assert.equal(parseReceipt(receiptV2()).ok, true, 'CONTROL: an ordinary ISO finished_at parses');

  const unparseable = parseReceipt(receiptV2({ finished_at: 'not-a-date-at-all' }));
  assert.equal(unparseable.ok, true, 'an unparseable finished_at is ADMITTED — the age problem surfaces at spend, not at read');
  assert.equal(unparseable.receipt.finished_at, 'not-a-date-at-all', 'and it is recorded exactly as captured, never normalized or blanked');

  for (const notAString of [null, 1_757_000_000_000, { at: '2026-09-07' }]) {
    assert.notEqual(parseReceipt(receiptV2({ finished_at: notAString })).ok, true, `a non-string finished_at is malformed: ${JSON.stringify(notAString)}`);
  }
});

// ===========================================================================
// R1-B30 — readLedger's tri-state availability. `corrupt` must never be
// confused with `absent` (nothing owed) or with `ok` (an empty array), and a
// corrupt READ must leave the bytes exactly as they were.
// SABOTAGE: return {availability:'ok', entries: []} on a JSON parse failure —
// the corrupt arms go red while absent and ok stay green; that conflation is
// what lets a corrupt ledger be silently overwritten.
// ===========================================================================

test('R1-B30: readLedger reports ok | absent | corrupt, never throws, and a corrupt read leaves the file byte-identical', () => {
  const { readLedger } = mod();

  const a = makeProject();
  try {
    const absent = readLedger(a.dir);
    assert.equal(absent.availability, 'absent');
    assert.deepEqual(absent.entries, [], 'an absent ledger has no entries');
  } finally {
    a.cleanup();
  }

  const b = makeProject();
  try {
    writeLedgerRaw(b.dir, [receiptV2(), externalReview(), legacyV1()]);
    const raw = readFileSync(ledgerFile(b.dir), 'utf8');
    const ok = readLedger(b.dir);
    assert.equal(ok.availability, 'ok');
    assert.equal(ok.raw, raw, 'raw is the exact file bytes — the digest is computed over them, not over a re-serialization');
    assert.deepEqual(ok.entries.map((e) => e.kind), ['receipt', 'external_review', 'legacy'], 'entries come back CLASSIFIED by the one authority');
  } finally {
    b.cleanup();
  }

  for (const corruptBytes of ['{ this is not valid json at all', '{"not":"an array"}']) {
    const c = makeProject();
    try {
      writeLedgerRaw(c.dir, corruptBytes);
      let out;
      assert.doesNotThrow(() => {
        out = readLedger(c.dir);
      }, 'readLedger never throws — a corrupt ledger is a verdict, not an exception');
      assert.equal(out.availability, 'corrupt', `unreadable JSON and a non-array are both 'corrupt': ${corruptBytes}`);
      assert.deepEqual(out.entries, []);
      assert.equal(readFileSync(ledgerFile(c.dir), 'utf8'), corruptBytes, 'reading a corrupt ledger never repairs, truncates or rewrites it');
    } finally {
      c.cleanup();
    }
  }
});

// ===========================================================================
// R1-B31 — writeLedger round-trips through readLedger; ledgerDigest is a
// stable hash over the raw bytes.
// SABOTAGE: have ledgerDigest hash a re-serialization (JSON.stringify of the
// parsed entries) instead of the raw string — the two-space-formatted arm
// below goes red, which is the case where a digest handed to `discharge
// --digest` would stop matching the file it was read from.
// ===========================================================================

test('R1-B31: writeLedger round-trips and ledgerDigest is a stable sha256 over the RAW bytes', () => {
  const { writeLedger, readLedger, ledgerDigest } = mod();
  const { dir, cleanup } = makeProject();
  try {
    writeLedger(dir, [receiptV2()]);
    const after = readLedger(dir);
    assert.equal(after.availability, 'ok');
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].kind, 'receipt');

    assert.equal(ledgerDigest(after.raw), sha256(after.raw), 'the digest is sha256 over exactly the bytes read');
    assert.equal(ledgerDigest(after.raw), ledgerDigest(after.raw), 'deterministic');

    const reformatted = JSON.stringify(JSON.parse(after.raw), null, 2);
    assert.notEqual(ledgerDigest(reformatted), ledgerDigest(after.raw), 'different bytes, different digest — the digest addresses bytes, not parsed content');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B32 — A5: ONE owner-mkdir lock, NO age takeover, NO force flag. A lock
// whose owner cannot be verified DEAD ON THIS HOST is a refusal naming the dir
// and the owner; the lock is left in place, never stolen.
//
// RE-CUT 2026-09-07 (fix forward, visible): the lock primitive is ASYNC ONLY —
// withOwnerMkdirLock/withLedgerLock ALWAYS return a promise, and a held lock
// REJECTS with the refusal object. The first cut of these four called it
// synchronously and used assert.throws; that was a WRONG PIN, not a stricter
// one, and it was doubly dangerous: `assert.throws` around a call that returns
// a rejected promise passes NOTHING (no throw is observed), so all three
// refusal arms would have gone GREEN against an implementation that never
// refused at all — a hollow pin on the one guard that keeps two writers off
// the durable ledger. The control arm would have "passed" too, comparing a
// Promise to 'result' only in its own assertion. Pinned async here, matching
// the register owner's own file.
//
// CONTROL FIRST (no lock present): withLedgerLock runs fn and resolves with its
// value — without it, the refusal arms are equally satisfied by "always
// rejects".
// SABOTAGE: restore an age-based takeover (`if (Date.now() - owner.at >
// staleMs) steal`) — the STALE-BUT-ALIVE arm goes red (it would take the lock
// and run fn) while the foreign-host arm may stay green, which is why the two
// are pinned separately.
// ===========================================================================

test('R1-B32 (A5): withLedgerLock CONTROL — it returns a PROMISE, runs fn under the lock, and resolves with fn\'s value', async () => {
  const { withLedgerLock } = mod();
  const { dir, cleanup } = makeProject();
  try {
    let ran = false;
    const pending = withLedgerLock(dir, () => {
      ran = true;
      assert.ok(existsSync(lockDirOf(dir)), 'fn runs while the lock directory is held');
      return 'result';
    });
    assert.ok(typeof pending?.then === 'function', 'the lock primitive is async-only — it always returns a promise, never a bare value');

    const value = await pending;
    assert.equal(ran, true);
    assert.equal(value, 'result', "withLedgerLock resolves with fn's result");
    assert.equal(existsSync(lockDirOf(dir)), false, 'the lock is released afterwards');
  } finally {
    cleanup();
  }
});

test('R1-B32b (A5): a lock whose owner pid is ALIVE on this host REJECTS with ledger_lock_held however old it is — no age takeover, no steal', async () => {
  const { withLedgerLock } = mod();
  const { dir, cleanup } = makeProject();
  try {
    const lockDir = lockDirOf(dir);
    mkdirSync(lockDir, { recursive: true });
    // This process is provably alive on this host, and the timestamp is a year
    // old: age alone must never authorise a takeover.
    const owner = { pid: process.pid, host: hostname(), at: '2025-09-07T00:00:00.000Z', nonce: 'n-old' };
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));

    let ran = false;
    await assert.rejects(
      withLedgerLock(dir, () => {
        ran = true;
      }),
      (err) => {
        assert.equal(err.code, 'ledger_lock_held');
        assert.equal(err.facts.lock_dir, lockDir, 'the refusal names the lock directory the operator must inspect');
        assert.equal(err.facts.owner.pid, owner.pid);
        assert.equal(err.facts.owner.host, owner.host);
        return true;
      }
    );
    assert.equal(ran, false, 'fn never runs under a held lock');
    assert.equal(existsSync(lockDir), true, 'the foreign lock is left exactly where it was — never stolen');
  } finally {
    cleanup();
  }
});

test('R1-B32c (A5): a lock owned by a DIFFERENT host REJECTS — liveness there is unverifiable, and unverifiable is never dead', async () => {
  const { withLedgerLock } = mod();
  const { dir, cleanup } = makeProject();
  try {
    const lockDir = lockDirOf(dir);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 999_999, host: `${hostname()}-somewhere-else`, at: new Date().toISOString(), nonce: 'n-foreign' }));

    await assert.rejects(
      withLedgerLock(dir, () => 'must not run'),
      (err) => err.code === 'ledger_lock_held'
    );
    assert.equal(existsSync(lockDir), true, 'never stolen from another host, whatever its pid says');
  } finally {
    cleanup();
  }
});

test('R1-B32d (A5): a lock whose owner pid is verified DEAD on this host is taken over — the refusals above are not "always rejects"', async () => {
  const { withLedgerLock } = mod();
  const { dir, cleanup } = makeProject();
  try {
    // A pid that has provably exited: spawn a trivial child, let it finish,
    // then use its pid. (Pid reuse would have to happen in the microseconds
    // between exit and this call for the fixture to lie.)
    const dead = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
    assert.ok(dead.pid, 'fixture guard: the probe child reported a pid');

    const lockDir = lockDirOf(dir);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: dead.pid, host: hostname(), at: new Date().toISOString(), nonce: 'n-dead' }));

    let ran = false;
    await withLedgerLock(dir, () => {
      ran = true;
    });
    assert.equal(ran, true, 'an owner verified dead on THIS host releases the lock — this is the only sanctioned takeover');
  } finally {
    cleanup();
  }
});
