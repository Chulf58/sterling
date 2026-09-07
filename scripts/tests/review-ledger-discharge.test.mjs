// REVIEW-LEDGER `discharge` — THE EXPLICIT LIFECYCLE VERB (R1 PIN RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession, projected by the R1 contract
// sheet (§1.2 lifecycle, §1.4 codes, §3.1 the CLI, §6 A5/A7/A9). Where the sheet
// and the decision differ the decision wins.
//
// WHAT THIS FILE PINS: the verb's SELECTOR, its CONCURRENCY TOKEN, its LIFECYCLE
// preconditions, its structured `--json` contract, and the two classes whose
// facts are proved from identity (foreign-session / foreign-branch) or from git
// (no-live-territory). The superseded / unattributable / legacy classes are
// pinned in review-ledger-superseded-classes.test.mjs and
// review-ledger-legacy-handle.test.mjs.
//
// CONVENTIONS (contract sheet §4):
//   * a refusal is asserted by its `[code]` token in stderr, or by `--json`'s
//     `code` field — never by sentence text;
//   * required FACTS are asserted as fields;
//   * exit 0 = ok, exit 1 = refusal; a refused discharge leaves the ledger
//     BYTE-IDENTICAL and no partial file behind.
//
// RETIRED IN THIS RE-CUT (each with its reason):
//   RETIRED: D2's /digest|checksum|sha-?256|changed|stale/i prose match — converted to [ledger_digest_mismatch].
//   RETIRED: D3's /class/i prose match — converted to [class_unknown].
//   RETIRED: D7's /entr|selector|not found|no match/i prose match — converted to [entry_not_found].
//   RETIRED: D8's /reason/i prose match — a missing flag is now [argument_invalid] with facts.flag.
//   RETIRED: D4 and D4-CONTROL's "the ledger is [] afterwards" assertions — a spend no longer DELETES; it sets status 'consumed' with consumption{commit_sha}, so deletion-as-consumption is retired outright.
//   RETIRED: D5b's four-verb resurrection sweep — collapsed to one unknown-verb arm, since every unknown verb is one code ([argument_invalid]) and the extra spellings were duplicate permutations.
//   RETIRED: D6b/D6c's per-arm prose alternations — converted to [no_live_territory_disproved] (facts.live_paths) and [class_not_applicable].
//   RETIRED: D6c's legacy-v1 arm — a v1 entry is not addressable by --entry-id at all; that boundary is review-ledger-legacy-handle's, not this file's.
//   RETIRED: the header's ambiguity register (a)-(e) and its interface-assumption block — the contract sheet fixes the flags, the codes and the facts, so there is nothing left to assume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');
const COMMIT_CLI = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

// A refusal/disclosure is identified by its code token, never by its sentence.
const token = (c) => new RegExp('\\[' + c + '\\]');
// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-discharge-'));
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

// THE CONCURRENCY TOKEN: SHA-256 over the EXACT ledger bytes, never over a
// re-serialization of the parsed entries.
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
function commitFile(dir, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
}
const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// `--json` mode: EXACTLY ONE object on stdout. JSON.parse throws on trailing
// junk, so a successful parse of the whole stream IS the one-object assertion.
function runLedgerJson(dir, args, env = ENV_SESSION) {
  const r = runLedger(dir, [...args, '--json'], env);
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    parseError = e;
  }
  return { ...r, json, parseError };
}

function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function reviewedByTrailers(dir, sha = 'HEAD') {
  return git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]).split('\n').filter((l) => l.trim() !== '');
}

// A ReceiptV2 per contract sheet §1.2. `basis` is present because the rebuilt
// parser reads a MISSING basis as this same value (A3) — a fixture that omitted
// it would pin the compatibility path, not the ordinary one.
function v2({
  entry_id,
  agent_type = 'reviewer-security',
  files,
  blobs = {},
  base_sha = null,
  session_id = SESSION,
  branch = 'main',
  agent_id = 'agent-0001',
  source = 'review-territory',
  status = 'active',
  disposition = null,
  reservation = undefined,
  consumption = undefined,
  at = isoAgo(60_000),
}) {
  const e = {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status,
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id },
    territory: { files, source, attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    disposition,
  };
  if (reservation) e.reservation = reservation;
  if (consumption) e.consumption = consumption;
  return e;
}

const TARGET_ID = 'd0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'd0000000-0000-4000-8000-00000000000b';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';

// A bystander no pin ever discharges — every write is checked against it.
const bystander = (base_sha) => v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });

// ===========================================================================
// R1-C01 — THE HAPPY PATH (CONTROL, PLACED FIRST).
// Every refusal pin in this file would be satisfied identically by a verb that
// refuses EVERYTHING. Without this green, none of them carries a verdict.
// ===========================================================================

// SABOTAGE (preservation): implement discharge as a splice -> `after.length === 2`
// and the evidence deepEquals go red.
// SABOTAGE (disposition): flip status and leave disposition null -> the
// class/reason/head_sha/classifier_version assertions go red while status stays
// green. Two independent guards, both load-bearing.
test('R1-C01 (CONTROL, first): a v2 receipt is discharged by entry_id under a matching digest — evidence preserved, status discharged, disposition{class,reason,at,head_sha,classifier_version:2,facts} recorded', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({
      entry_id: TARGET_ID,
      files: ['src/base.mjs'],
      blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
      base_sha: head,
      session_id: 'a-session-that-ended', // genuinely foreign, so the class's facts hold
    });
    const other = bystander(head);
    writeLedger(dir, [target, other]);

    const reason = 'session ended before the receipt could be spent';
    const tMin = Date.now() - 1_000;
    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', reason]);
    assert.equal(r.code, 0, `a well-formed discharge exits 0 — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.parseError, null, `--json emits exactly one parseable JSON object and nothing else — stdout=${JSON.stringify(r.stdout)}`);
    assert.equal(r.json.ok, true, `the object reports ok:true — got ${JSON.stringify(r.json)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — discharge preserves the record — got ${JSON.stringify(after)}`);
    const discharged = after.find((e) => e.entry_id === TARGET_ID);
    assert.deepEqual(after.find((e) => e.entry_id === BYSTANDER_ID), other, 'the bystander is byte-for-byte untouched — a discharge writes exactly one entry');

    for (const k of ['reviewer', 'territory', 'content_evidence', 'identity']) {
      assert.deepEqual(discharged[k], target[k], `${k} survives the state flip unchanged — the evidence IS the point`);
    }
    assert.equal(discharged.started_at, target.started_at, 'started_at preserved');
    assert.equal(discharged.finished_at, target.finished_at, 'finished_at preserved');
    assert.equal(discharged.status, 'discharged', 'the status flips to discharged');

    const d = discharged.disposition;
    assert.equal(d.class, 'foreign-session', 'the class is recorded');
    assert.equal(d.reason, reason, 'the conductor-supplied reason is recorded verbatim');
    assert.equal(d.head_sha, git(dir, ['rev-parse', 'HEAD']), 'head_sha pins WHEN in history the discharge was decided');
    assert.equal(d.classifier_version, 2, `classifier_version is the rebuild's 2 — got ${JSON.stringify(d.classifier_version)}`);
    assert.ok(d.facts && typeof d.facts === 'object', `the underlying facts are recorded as an object — got ${JSON.stringify(d.facts)}`);
    const at = Date.parse(d.at);
    assert.ok(Number.isFinite(at) && at >= tMin && at <= Date.now() + 1_000, `disposition.at is the moment of the discharge, not a copied review timestamp — got ${JSON.stringify(d.at)}`);

    assertNoLedgerResidue(dir, 'R1-C01');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C02 — THE STRUCTURED CONTRACT ITSELF (§3.1).
// ===========================================================================

// SABOTAGE: print the refusal sentence on stdout beside the JSON (a banner, a
// log line, a second object) -> the parse of the whole stream throws and the
// parseError assertion goes red. The caller substitutes stdout into a JSON
// reader, so anything else on it corrupts the answer rather than decorating it.
// SECOND SABOTAGE: drop the `[code]` token from the human rendering -> only the
// stderr token assertion goes red; the two renderings are independent guards.
test('R1-C02: every verb answers `--json` with exactly ONE object — {ok:true,...} at exit 0, {ok:false,code,facts,message} at exit 1 — and human mode renders the same code as a [code] token', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);
    const stale = createHash('sha256').update('not the ledger bytes').digest('hex');
    const args = ['discharge', '--entry-id', TARGET_ID, '--digest', stale, '--class', 'foreign-session', '--reason', 'a refusal, structurally'];

    const j = runLedgerJson(dir, args);
    assert.equal(j.code, 1, `a refusal exits 1, never 2 and never 0 — stdout=${j.stdout} stderr=${flat(j.stderr)}`);
    assert.equal(j.parseError, null, `--json emits exactly one parseable object on a REFUSAL too — stdout=${JSON.stringify(j.stdout)}`);
    assert.equal(j.json.ok, false, `ok:false — got ${JSON.stringify(j.json)}`);
    assert.equal(j.json.code, 'ledger_digest_mismatch', `the refusal names its code as a FIELD — got ${JSON.stringify(j.json)}`);
    assert.ok(j.json.facts && typeof j.json.facts === 'object', `facts is an object — got ${JSON.stringify(j.json.facts)}`);
    assert.equal(typeof j.json.message, 'string', `message is a string — got ${JSON.stringify(j.json.message)}`);

    const h = runLedger(dir, args);
    assert.equal(h.code, 1, 'human mode agrees on the exit code');
    assert.match(h.stderr, /REFUSED/, `human mode renders the refusal verb — stderr=${flat(h.stderr)}`);
    assert.match(h.stderr, token('ledger_digest_mismatch'), `and carries the SAME code as a [code] token — stderr=${flat(h.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C03 / R1-C04 / R1-C05 / R1-C06 — THE REFUSAL FAMILY. Each fixture is
// R1-C01's with EXACTLY ONE thing wrong; everything else is correct, so a green
// cannot come from a different cause.
// ===========================================================================

// SABOTAGE: accept the digest whenever it is merely PRESENT, or compare it
// against a re-serialization of the parsed ledger instead of the bytes on disk
// -> the concurrent write stops being detected, exit 0, the status flips, and
// the code/byte-identical assertions go red.
test('R1-C03: a STALE digest is REFUSED with [ledger_digest_mismatch] — nothing written, the ledger byte-identical, the entry still active', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
    writeLedger(dir, [target]);
    const staleDigest = ledgerDigest(dir);
    // A CONCURRENT WRITER lands between the read and the discharge — the race
    // the token exists for.
    writeLedger(dir, [target, bystander(head)]);
    const before = readLedgerRaw(dir);
    assert.notEqual(staleDigest, ledgerDigest(dir), 'fixture guard: the ledger genuinely changed');

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', staleDigest, '--class', 'foreign-session', '--reason', 'stale token must not be honoured']);
    assert.equal(r.code, 1, `a stale concurrency token REFUSES — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'ledger_digest_mismatch', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a refused discharge writes nothing at all');
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', 'and the target is still active');
    assertNoLedgerResidue(dir, 'R1-C03');
  } finally {
    cleanup();
  }
});

// SABOTAGE: record whatever --class string is supplied without checking it
// against the closed class set -> exit 0 and the entry flips under a made-up
// class -> code/status/byte-identical go red. P5: unknown signals halt.
test('R1-C04: an UNRECOGNIZED --class is REFUSED with [class_unknown]; an UNKNOWN VERB is REFUSED with [argument_invalid] — there is still no undischarge/restore verb', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }), bystander(head)]);
    const before = readLedgerRaw(dir);

    // Everything else is CORRECT, so the class is the only possible cause.
    const bad = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'because-i-said-so', '--reason', 'an unrecognized class is never honoured']);
    assert.equal(bad.code, 1, `stdout=${bad.stdout} stderr=${flat(bad.stderr)}`);
    assert.equal(bad.json.code, 'class_unknown', `got ${JSON.stringify(bad.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'NOTHING is written on the refusal path');

    // THE ABSENCE OF A RESURRECTION VERB, pinned as today. A discharged entry
    // that could be returned to active would make the record round-trippable and
    // therefore worthless; the correction is re-dispatching a reviewer.
    const verb = runLedgerJson(dir, ['undischarge', '--entry-id', TARGET_ID]);
    assert.equal(verb.code, 1, `an unknown verb halts loudly — stdout=${verb.stdout} stderr=${flat(verb.stderr)}`);
    assert.equal(verb.json.code, 'argument_invalid', `an unknown verb is a usage error — got ${JSON.stringify(verb.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'and writes nothing');
  } finally {
    cleanup();
  }
});

// SABOTAGE: fall back to "the only entry" / "the first entry" when the selector
// matches nothing -> the bystander is discharged and the status assertions go
// red. A forgiving selector on a destroying operation is exactly what
// anti-pattern no-bounded-trail-guard-for-destructive-addressing forbids.
// SECOND SABOTAGE: resolve an ambiguous id to matches[0] -> the ambiguous arm's
// code assertion goes red while the not-found arm stays green.
test('R1-C05: an entry_id matching NO entry is [entry_not_found]; an entry_id matching TWO entries is [entry_selector_ambiguous] — nothing is discharged in either case', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [bystander(head)]);
    let before = readLedgerRaw(dir);
    const miss = runLedgerJson(dir, ['discharge', '--entry-id', 'ffffffff-0000-4000-8000-00000000ffff', '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'no such entry']);
    assert.equal(miss.code, 1, `stdout=${miss.stdout} stderr=${flat(miss.stderr)}`);
    assert.equal(miss.json.code, 'entry_not_found', `got ${JSON.stringify(miss.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.equal(readLedger(dir)[0].status, 'active', 'the ONLY entry present is not discharged as a consolation prize');

    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }),
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-correctness', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }),
    ]);
    before = readLedgerRaw(dir);
    const amb = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'two entries answer to this id']);
    assert.equal(amb.code, 1, `stdout=${amb.stdout} stderr=${flat(amb.stderr)}`);
    assert.equal(amb.json.code, 'entry_selector_ambiguous', `choosing either of two indistinguishable targets is choosing at random on a write that cannot be undone — got ${JSON.stringify(amb.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'and NEITHER is discharged');
  } finally {
    cleanup();
  }
});

// SABOTAGE: default a missing/empty --reason to '' or 'discharged' and proceed
// -> exit 0 with an empty accountability record -> code and byte-identical go
// red. The reason IS the accountability that explicit discharge exists for.
test('R1-C06: a MISSING or EMPTY --reason is [argument_invalid] with facts.flag naming the flag — an accountability record with no reason is not an accountability record', { skip: GIT_SKIP }, () => {
  for (const [label, extra] of [['missing', []], ['empty', ['--reason', '']]]) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', ...extra]);
      assert.equal(r.code, 1, `[${label}] a discharge without a reason REFUSES — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'argument_invalid', `[${label}] got ${JSON.stringify(r.json)}`);
      assert.match(String(r.json.facts.flag), /reason/, `[${label}] facts.flag NAMES the offending flag, so the operator is not left guessing which argument — got ${JSON.stringify(r.json.facts)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C07 — THE CLASS MUST BE PROVED, NOT ASSERTED (§1.4 class_not_applicable).
// ===========================================================================

// EXPECTED: R1-C01 and R1-C08 are this family's controls — a genuinely foreign
// identity discharges, so a green here cannot be explained by "foreign-* refuses
// everything".
// SABOTAGE: record the asserted class without verifying it -> all four arms
// discharge -> code/status go red.
// SECOND SABOTAGE: implement the check as `identity?.session_id !== currentSession`
// -> the missing and empty arms discharge (undefined and '' both compare
// unequal) while the equal arms stay refused. UNKNOWN IS NEVER FOREIGN: deleting
// one field of an agent-writable ledger must not make a receipt dischargeable.
test('R1-C07: foreign-session / foreign-branch are [class_not_applicable] when the recorded identity EQUALS this side\'s, and when it is MISSING or EMPTY — unknown is not foreign', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'session-equal', cls: 'foreign-session', patch: (e) => { e.identity.session_id = SESSION; } },
    { label: 'branch-equal', cls: 'foreign-branch', patch: (e, b) => { e.identity.branch = b; } },
    { label: 'session-unknown', cls: 'foreign-session', patch: (e) => { delete e.identity.session_id; } },
    { label: 'branch-unknown', cls: 'foreign-branch', patch: (e) => { e.identity.branch = ''; } },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      assert.equal(branch, 'main', 'fixture guard: the repo really is on main');
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head });
      arm.patch(target, branch);
      writeLedger(dir, [target, bystander(head)]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', arm.cls, '--reason', `${arm.label}: the class must be proved from the record`]);
      assert.equal(r.code, 1, `[${arm.label}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'class_not_applicable', `[${arm.label}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical`);
      assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${arm.label}] the receipt stays active and spendable`);
      assertNoLedgerResidue(dir, `R1-C07/${arm.label}`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: require the identity fields to be present AND refuse whenever they
// are (an over-tight fix that never accepts foreign-*) -> both arms here go red
// while R1-C07 stays green. That result pair is the signature of an over-narrow
// fix and no single pin can see it.
test('R1-C08 (CONTROL for R1-C07): a PRESENT identity that genuinely differs discharges — foreign-session on a foreign session_id, foreign-branch on a foreign branch', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'foreign-session', cls: 'foreign-session', patch: (e) => { e.identity.session_id = 'a-session-that-ended'; } },
    { label: 'foreign-branch', cls: 'foreign-branch', patch: (e) => { e.identity.branch = 'feature/elsewhere'; } },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head });
      arm.patch(target);
      writeLedger(dir, [target, bystander(head)]);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', arm.cls, '--reason', `${arm.label}: earned where this commit cannot spend it`]);
      assert.equal(r.code, 0, `[${arm.label}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
      assert.equal(entry.status, 'discharged', `[${arm.label}] the entry is discharged`);
      assert.equal(entry.disposition.class, arm.cls, `[${arm.label}] under the class it was verified as`);
      assert.deepEqual(entry.identity, target.identity, `[${arm.label}] with the identity evidence preserved verbatim`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C09 — LIFECYCLE PRECONDITIONS (§3.1: "Refuses reserved/consumed entries").
// This replaces the retired mid-commit write-back family: the two-phase spend
// closes that race by RESERVING, so the contract to pin is the refusal, not an
// ordering of writes.
// ===========================================================================

// SABOTAGE: check only `status === 'discharged'` before discharging -> both arms
// flip a reserved or consumed entry and the code/status assertions go red.
// Discharging a RESERVED entry retires evidence a commit is mid-flight on;
// discharging a CONSUMED one rewrites the record of a commit that already exists.
// SABOTAGE (facts half): refuse without facts.status -> the facts assertion goes
// red alone; the operator must be told WHICH state blocked them, since the two
// have different remedies (reconcile vs nothing).
test('R1-C09: a RESERVED or CONSUMED entry is [entry_not_active] with facts.status naming the state — the ledger is byte-identical and the entry keeps its reservation/consumption', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'reserved', patch: { status: 'reserved', reservation: { nonce: 'n-1', at: isoAgo(5_000), index_blobs: {}, operation: 'commit-reviewed' } } },
    { label: 'consumed', patch: { status: 'consumed', consumption: { commit_sha: 'a'.repeat(40), consumed_at: isoAgo(5_000), nonce: 'n-1' } } },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended', ...arm.patch })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', `${arm.label}: not the verb's to retire`]);
      assert.equal(r.code, 1, `[${arm.label}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'entry_not_active', `[${arm.label}] got ${JSON.stringify(r.json)}`);
      assert.equal(r.json.facts.status, arm.label, `[${arm.label}] facts.status names the blocking state — got ${JSON.stringify(r.json.facts)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C10 — A CORRUPT LEDGER IS NEVER TRUNCATED.
// ===========================================================================

// SABOTAGE: open the ledger for writing before parsing it (or write `[]` on a
// parse failure) -> the byte-identical assertion goes red. An unreadable
// evidence file is a refusal, never an invitation to start a fresh one.
test('R1-C10: a CORRUPT ledger is [ledger_corrupt] and its bytes are left exactly as found — never truncated, never replaced with an empty array', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(ledgerPath(dir), '{not json');
    const before = readLedgerRaw(dir);
    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', createHash('sha256').update(before).digest('hex'), '--class', 'foreign-session', '--reason', 'corrupt ledger']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'ledger_corrupt', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the corrupt bytes survive for a human to inspect');
    assertNoLedgerResidue(dir, 'R1-C10');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C11 — --covering BELONGS TO `superseded` ONLY (§3.1).
// ===========================================================================

// SABOTAGE: parse --covering generically and ignore it for other classes -> the
// code assertion goes red. A set-cover argument silently ignored reads to the
// operator as a set cover that was VERIFIED, which is the laundering route the
// explicit-only rule exists to close.
test('R1-C11: --covering on any class but superseded is [covering_not_allowed] — never silently ignored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }), bystander(head)]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--covering', BYSTANDER_ID, '--reason', 'a covering set means nothing to this class']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'covering_not_allowed', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C12 / R1-C13 — NO-LIVE-TERRITORY IS CONCLUSIVE OR IT IS NOTHING.
// The class compares EVERY DECLARED path (not only the blob-backed covered set)
// against base/index/worktree — the existing contract, kept.
// ===========================================================================

// PLACED FIRST as R1-C13's control: without it, every no-live refusal is
// satisfied by a classifier that refuses the class unconditionally.
// SABOTAGE: classify no-live by comparing base_sha to HEAD, or by an empty
// `git status --porcelain` -> with HEAD deliberately moved past base_sha the
// classifier says unknown and refuses -> the exit-0 assertion goes red. Both
// shortcuts pass a naive fixture where base_sha == HEAD, which is why this one
// moves HEAD.
test('R1-C12 (CONTROL, first): no-live-territory SUCCEEDS when every declared path is back at its base bytes — even though HEAD has advanced past base_sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances; laneA untouched
    stageChange(dir, 'src/laneA.mjs', OTHER);
    stageChange(dir, 'src/laneA.mjs', CODE); // a genuine round trip
    assert.equal(stagedBlob(dir, 'src/laneA.mjs'), git(dir, ['rev-parse', `${baseSha}:src/laneA.mjs`]), 'fixture guard: the declared path is back at its base-state blob');
    assert.notEqual(baseSha, git(dir, ['rev-parse', 'HEAD']), 'fixture guard: HEAD has genuinely moved past base_sha');

    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], base_sha: baseSha }), bystander(baseSha)]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'the reviewed change was reverted; nothing of it remains to commit']);
    assert.equal(r.code, 0, `a conclusive no-live classification succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.equal(entry.status, 'discharged', 'the entry is discharged');
    assert.equal(entry.disposition.class, 'no-live-territory', 'under the class it was classified as');
    assert.deepEqual(entry.territory.files, ['src/laneA.mjs'], 'with its territory evidence preserved');
  } finally {
    cleanup();
  }
});

// SABOTAGE: classify from the paths that DO match base and ignore the ones that
// do not (an `.some()` where every declared path is required) -> both arms
// discharge a receipt whose territory is still live, and the code/status
// assertions go red. Discharging live territory destroys the requirement that
// the work be reviewed before it commits.
// TWO ARMS because a MODIFIED path and a DELETED path are different comparisons
// and one guard need not cover the other; laneB is at base in both, so a
// classifier that ORs across paths concludes no-live and reddens.
// SABOTAGE (facts half): refuse without facts.live_paths -> that assertion alone
// goes red, and the operator is sent to git to find which path blocked them.
test('R1-C13: no-live-territory is [no_live_territory_disproved] with facts.live_paths when ANY declared path differs from base — modified or deleted', { skip: GIT_SKIP }, () => {
  for (const arm of ['modified', 'deleted']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, 'src/laneA.mjs', CODE);
      commitFile(dir, 'src/laneB.mjs', CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER);

      if (arm === 'modified') {
        stageChange(dir, 'src/laneA.mjs', OTHER);
      } else {
        unlinkSync(join(dir, 'src', 'laneA.mjs'));
        git(dir, ['add', '-A']); // a deletion is a difference from base, not a revert
      }

      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs', 'src/laneB.mjs'], base_sha: baseSha })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', `${arm} territory must not classify as no-live`]);
      assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'no_live_territory_disproved', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.deepEqual(r.json.facts.live_paths, ['src/laneA.mjs'], `[${arm}] facts.live_paths names exactly the path that is still live — got ${JSON.stringify(r.json.facts)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      assert.equal(readLedger(dir)[0].status, 'active', `[${arm}] and the receipt stays spendable`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: run the comparison on whatever the entry declares without first
// asking whether the class's preconditions hold -> both arms discharge and the
// code assertions go red. The fixtures are otherwise CLEAN — the declared path
// really is at base state in each — so the only possible cause of a refusal is
// the failed precondition, never a live-territory finding.
// TWO ARMS, two DIFFERENT preconditions: free-prose territory has
// measured-unreliable paths, so its "nothing live" verdict is about the wrong
// files; a null base_sha has nothing conclusive to compare against.
test('R1-C14: no-live-territory is [class_not_applicable] when a precondition fails — free-prose territory or an absent base_sha — even though the declared path IS at base state', { skip: GIT_SKIP }, () => {
  for (const arm of ['free-prose', 'no-base-sha']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, 'src/laneA.mjs', CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER); // laneA untouched: genuinely at base state

      const entry =
        arm === 'free-prose'
          ? v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], base_sha: baseSha, source: 'free-prose-fallback' })
          : v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], base_sha: null });
      writeLedger(dir, [entry]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', `${arm}: preconditions for no-live are not met`]);
      assert.equal(r.code, 1, `[${arm}] any ambiguity yields unknown, never no-live — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'class_not_applicable', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C15 — A DISCHARGED RECEIPT IS INVISIBLE TO SPENDING, AND SURVIVES IT.
// ===========================================================================

// PLACED FIRST as R1-C16's control, and it must pass for the OPPOSITE reason:
// two ACTIVE receipts both stamp and both reach status 'consumed'.
// SABOTAGE: dedupe stamped receipts by agent_type, or stamp only the first
// eligible receipt -> one trailer instead of two -> red, and R1-C16's green is
// exposed as meaningless.
// NOTE THE RE-CUT: a spend no longer removes the entry. It sets status
// 'consumed' with consumption.commit_sha, so the ledger keeps the whole history
// and `[]` is no longer the shape of a successful spend.
test('R1-C15 (CONTROL, first): two ACTIVE receipts covering the staged file are BOTH stamped and BOTH end at status "consumed" bound to the new commit — a spend never deletes an entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs, base_sha: head }),
      v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'R1-C15 control: both active']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security'], 'both ACTIVE receipts are stamped');
    const sha = git(dir, ['rev-parse', 'HEAD']);
    for (const e of readLedger(dir)) {
      assert.equal(e.status, 'consumed', `every spent receipt ends CONSUMED, not removed — got ${JSON.stringify(e)}`);
      assert.equal(e.consumption.commit_sha, sha, 'bound to the commit that spent it');
    }
  } finally {
    cleanup();
  }
});

// SABOTAGE: stop reading `status` in the eligibility filter -> the discharged
// receipt is stamped and the trailer deepEqual goes red.
// SABOTAGE (the dangerous half): filter discharged entries out of the STAMPED
// set but not out of the write-back -> the trailer assertion stays green while
// the survival deepEqual goes red. Silently destroying preserved evidence is
// exactly what "deletion is never silent" forbids, and the trailer pin alone
// cannot see it.
test('R1-C16: a DISCHARGED receipt covering the staged file is neither stamped nor spent, and survives the commit byte-identical with its disposition intact', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const dischargedEntry = v2({
      entry_id: TARGET_ID,
      files: ['src/laneA.mjs'],
      blobs,
      base_sha: head,
      status: 'discharged',
      disposition: { class: 'foreign-session', reason: 'the session that produced it ended', at: isoAgo(30_000), head_sha: head, classifier_version: 2, facts: { recorded_session: 'a-session-that-ended' } },
    });
    writeLedger(dir, [dischargedEntry, v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head })]);

    const r = runCommitReviewed(dir, ['-m', 'R1-C16 discharged is not spendable']);
    assert.equal(r.code, 0, `an active receipt covers the diff, so the commit lands — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'a discharged receipt never earns a Reviewed-By-Agent trailer — that would be an attestation from evidence already ruled unspendable');
    const after = readLedger(dir);
    assert.deepEqual(
      after.find((e) => e.entry_id === TARGET_ID),
      dischargedEntry,
      `the discharged entry survives the spend byte-identical — preserved evidence is never collateral of a consume — got ${JSON.stringify(after)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C17 — NO SECOND FLIP.
// ===========================================================================

// SABOTAGE: make a repeat discharge idempotent by REWRITING the disposition ->
// the deepEqual goes red while status stays 'discharged'. A silently rewritten
// disposition is a second state flip wearing the first one's clothes: a later,
// weaker justification overwrites the recorded one with no trace.
test('R1-C17: a second discharge of an already-discharged entry is [entry_not_active] — the original disposition survives verbatim', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const other = bystander(head);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }), other]);

    const firstReason = 'the original, accountable justification';
    const first = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', firstReason]);
    assert.equal(first.code, 0, `the first discharge succeeds — stdout=${first.stdout} stderr=${flat(first.stderr)}`);
    const afterFirst = readLedger(dir).find((e) => e.entry_id === TARGET_ID);

    // A FRESH digest — the ledger legitimately changed — so a refusal here can
    // only be about the repeat, never about a stale token.
    const second = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'a different, later justification']);
    assert.equal(second.code, 1, `stdout=${second.stdout} stderr=${flat(second.stderr)}`);
    assert.equal(second.json.code, 'entry_not_active', `got ${JSON.stringify(second.json)}`);
    assert.equal(second.json.facts.status, 'discharged', `facts.status names the state — got ${JSON.stringify(second.json.facts)}`);

    const afterSecond = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.deepEqual(afterSecond.disposition, afterFirst.disposition, `the ORIGINAL disposition survives verbatim — got ${JSON.stringify(afterSecond.disposition)}`);
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === BYSTANDER_ID), other, 'and the bystander is still untouched');
  } finally {
    cleanup();
  }
});
