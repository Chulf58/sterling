// COMMIT-REVIEWED — MALFORMED v2 CONTENT EVIDENCE (R1 pin re-cut, group D).
// ONE ARM PER DISTINCT FAILURE, per the R1 brief.
//
// AUTHORITY: contract sheet §1.2 — `scripts/hooks/lib/review-ledger-entry.mjs` is THE shape
// owner; `classifyLedgerEntry(raw)` yields `{kind:'malformed', code:'ledger_entry_malformed',
// facts}` for anything `parseReceipt`/`parseContentEvidence` cannot parse, and §6 A9 —
// `receiptCoveredPaths` = declared paths that have a USABLE blob, so a recorded-but-unusable
// sha leaves the path UNCOVERED rather than mismatched. Decision 24dc4c63: an unusable
// PRESENT value is never read as a genuine ABSENCE.
//
// RETIRED: M3a/M3b (v1 regression guards) — v1 receipts are never spendable (24dc4c63); the
//   one surviving legacy pin is commit-reviewed.test.mjs R1-D09.
// RETIRED: M2's number and boolean arms — same distinct failure (blobs is not a path map) and
//   the same code as the string arm; the ARRAY arm survives because `typeof [] === 'object'`
//   is a separate guard hole, not a separate permutation of one.
// RETIRED: M4 (blobs === null, "either reading") — adjudicated here to the same class:
//   PRESENT-and-not-an-object is malformed, so the ambiguity arm is a duplicate permutation.
// RETIRED: M5's string/number/array trio — one arm survives (R1-D59) for the distinct
//   failure "the whole content_evidence VALUE is not an object"; the three value shapes are
//   permutations of it.
// RETIRED: the MALFORMED_VOCAB word-class assertion and the `REVIEWED BYTES` anchor —
//   converted to the [ledger_entry_malformed] / [coverage_incomplete] code tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const token = (c) => new RegExp('\\[' + c + '\\]');
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-v2-malformed-'));
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
const entryById = (dir, id) => (readLedger(dir) ?? []).find((e) => e.entry_id === id);

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
function indexBlob(dir, relPath) {
  const out = git(dir, ['ls-files', '-s', '--', relPath]);
  const m = out.match(/^\d+ ([0-9a-f]{40}) \d+\t/);
  assert.ok(m, `fixture guard: ${relPath} must be staged in the index — got ${out}`);
  return m[1];
}
function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}

// `OMIT` removes a key entirely — the whole subject here is a PRESENT value being read as an
// ABSENCE, so the absence fixture must be a real absence.
const OMIT = Symbol('omit-the-key');

function v2({
  entry_id, agent_type, files, blobs = {}, base_sha, content_evidence: ceOverride,
  evidence_status = 'complete', at = isoAgo(60_000),
}) {
  const content_evidence = {
    basis: 'stop-time-worktree-snapshot', status: evidence_status, blobs,
    absent_paths: [], truncated_of: null, failure_reason: null,
  };
  if (blobs === OMIT) delete content_evidence.blobs;
  const entry = {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha, agent_id: 'agent-fixture' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence,
    disposition: null,
  };
  if (ceOverride !== undefined) {
    if (ceOverride === OMIT) delete entry.content_evidence;
    else entry.content_evidence = ceOverride;
  }
  return entry;
}

const NEW = 'export const f = 2; // the bytes actually staged\n';

// Every malformed arm asserts the same three invariants; naming them once keeps each arm
// about its OWN distinct failure.
function assertRefusedMalformed(dir, r, base, before, label) {
  assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] a REFUSAL, never a crash — node exits 1 on an uncaught throw too — stderr=${flat(r.stderr)}`);
  const combined = `${r.stdout}\n${r.stderr}`;
  assert.match(combined, token('ledger_entry_malformed'), `[${label}] the malformed SHAPE is named — reporting it as absent evidence reproduces the very conflation this class exists to remove — stderr=${flat(r.stderr)}`);
  assert.match(combined, token('no_spendable_receipt'), `[${label}] and it is never a candidate — stderr=${flat(r.stderr)}`);
  assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[${label}] no commit`);
  assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical — a malformed entry is never repaired by being read`);
}

// ===========================================================================
// R1-D55 / R1-D56 — BOTH CONTROLS, BEFORE ANY MALFORMED ARM.
// The verdict "this run refused" has more than one possible cause: D55 proves the
// family's fixture COMMITS when the blobs value is usable, and D56 proves a genuine
// ABSENCE is not reported as malformed. Without the pair, an unconditional-refuse
// implementation passes every arm below.
// ===========================================================================

// EXPECTED: RED today only on the consumed-status assertion (today's spend deletes).
// SABOTAGE: treat any inspected content_evidence as malformed (invert the object test) ->
// this control refuses while the malformed arms stay green — the signature of an over-broad fix.
test('R1-D55 (CONTROL, first): a v2 receipt with a PROPER {path: sha} blobs map matching the index commits and is consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '55000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D55 well-formed blobs map']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today a blobs-less receipt is GRANDFATHERED and stamps, so the
// no-trailer and byte-identical assertions fire.
// SABOTAGE (the over-correction half): classify a genuinely ABSENT blobs key as malformed ->
// the [ledger_entry_malformed] token appears and the doesNotMatch assertion reds, while the
// arms below stay green. Absence and malformation carry different remedies: absence needs a
// fresh review round, malformation needs the entry repaired or discharged.
test('R1-D56 (CONTROL, second): a v2 receipt whose blobs KEY is absent is an evidence ABSENCE, not a malformation — never spent, refused [no_spendable_receipt] WITHOUT [ledger_entry_malformed]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const entry = v2({ entry_id: '56000000-0000-4000-8000-000000000001', agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], blobs: OMIT, base_sha: base, evidence_status: 'unavailable' });
    assert.ok(!('blobs' in entry.content_evidence), 'fixture guard: the blobs KEY is absent, not present-and-empty');
    writeLedger(dir, [entry]);
    assert.doesNotMatch(readLedgerRaw(dir), /"blobs"/, 'fixture guard: the serialized ledger carries no blobs key at all');
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D56 absent blobs key']);
    assert.equal(r.code, 1, `a receipt with no byte evidence covers nothing, so it can carry no commit — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.match(combined, token('no_spendable_receipt'), `stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(combined, token('ledger_entry_malformed'), `an absence is not a malformation — stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir, base), [], 'nothing was stamped anywhere');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the adapter maps an unusable blobs value to `undefined`, the receipt
// reads as recorded-nothing, the grandfather clause applies and the run COMMITS (exit 0).
// SABOTAGE (the whole defect, one line): map an unusable blobs value to `undefined` instead
// of surfacing it as malformed -> the CLI reads absence -> exit 0 -> red.
// SECOND SABOTAGE (the disclosure half): drop the entry as unspendable but never name the
// malformed shape -> only the [ledger_entry_malformed] assertion reds, which is the half
// that stops an operator inheriting the adapter's own wrong model.
test('R1-D57: content_evidence.blobs is the STRING "junk" — a PRESENT non-object value is [ledger_entry_malformed], never a grandfathered absence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: '57000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: 'junk', base_sha: base })]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"blobs":"junk"/, 'fixture guard: the serialized ledger really carries a STRING blobs value');

    const r = runCommitReviewed(dir, ['-m', 'D57 blobs is a string']);
    assertRefusedMalformed(dir, r, base, before, 'string');
  } finally { cleanup(); }
});

// A SEPARATE GUARD HOLE, not a permutation of D57: `typeof [] === 'object'` is TRUE, so an
// object-typeof fix passes D57 and still admits this one.
// EXPECTED: RED today, same cause as D57.
// SABOTAGE: guard with `typeof blobs === 'object'` alone (no Array.isArray, no null check)
// -> this arm commits while D57 refuses -> exactly one arm red, which is the signature of a
// partial fix and the only reason this arm exists separately.
test('R1-D58: content_evidence.blobs is an ARRAY — an object-typed container whose keys are indices is still [ledger_entry_malformed]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: '58000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: ['array'], base_sha: base })]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"blobs":\["array"\]/, 'fixture guard: the serialized ledger really carries an ARRAY blobs value');

    const r = runCommitReviewed(dir, ['-m', 'D58 blobs is an array']);
    assertRefusedMalformed(dir, r, base, before, 'array');
  } finally { cleanup(); }
});

// THE SAME HOLE ONE NESTING LEVEL UP — a distinct failure, because the D57/D58 guard sits
// INSIDE content_evidence and is never reached when the whole value is unusable.
// EXPECTED: RED today — a non-object content_evidence normalizes to null, blobs reads as
// undefined, the grandfather clause applies and the run commits.
// SABOTAGE (the depth half): apply the fix only to the inner `blobs` value and leave the
// outer normalization untouched -> D57/D58 go green while this arm stays red. That result
// pair is what this arm exists to make visible, and no pin above can produce it.
test('R1-D59: the WHOLE content_evidence value is a non-object — [ledger_entry_malformed] one nesting level up, never a grandfathered absence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: '59000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], base_sha: base, content_evidence: 'junk' })]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"content_evidence":"junk"/, 'fixture guard: the serialized entry really carries a non-object content_evidence');

    const r = runCommitReviewed(dir, ['-m', 'D59 content_evidence is a string']);
    assertRefusedMalformed(dir, r, base, before, 'outer');
  } finally { cleanup(); }
});

// A DISTINCT FAILURE WITH A DISTINCT CODE (A9): the map parses, but the VALUE for a staged
// declared path is not a usable sha — so that path has no byte evidence and is UNCOVERED.
// EXPECTED: RED today — today a non-40-hex value is treated as no-evidence and grandfathered
// (or refused as a bytes mismatch), never as a coverage hole.
// SABOTAGE: let a non-40-hex value into the comparison as if usable -> it can never equal a
// real sha, so the run refuses with [receipt_bytes_mismatch] instead -> the code assertion
// reds while the exit code stays 1. Same verdict, wrong diagnosis and wrong remedy: a
// mismatch is waivable with --waive-bytes, a coverage hole is not.
test('R1-D60 (A9): a blobs VALUE that is not a usable 40-hex sha leaves its staged path UNCOVERED — [coverage_incomplete] with facts.uncovered, not a bytes mismatch and not a malformation', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: '60000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': 'not-a-sha' }, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D60 unusable sha value', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `a refusal, never a crash — stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'coverage_incomplete', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.uncovered, ['src/laneA.mjs'], `got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});
