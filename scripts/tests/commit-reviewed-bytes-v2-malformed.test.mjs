// COMMIT-REVIEWED — REVIEWED-BYTES GATE: **v2 MALFORMED content_evidence.blobs**
// (board f55ab3e9, objective consumer-feedback-2026-08-28; decision 57984926,
// slug review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §2).
//
// THE DEFECT THIS FILE SPECIFIES: a v2 receipt whose content_evidence.status is
// 'complete' but whose `blobs` value is PRESENT AND NOT A USABLE OBJECT (the
// string "junk", the number 42, an array) is currently GRANDFATHERED and the
// commit lands. The compatibility adapter (scripts/hooks/lib/review-ledger-entry.mjs)
// maps an unusable blobs value to `undefined`, which erases the
// PRESENT-vs-ABSENT distinction, so commit-reviewed.mjs's evidence classifier
// reads "this receipt recorded nothing" — the one shape §2 says to grandfather —
// when the truth is "this receipt recorded something unusable", which §2 calls
// INCONSISTENT and refuses.
//
// THE GOVERNING CLAUSES (decision 57984926 §2, opened with knowledge_get, quoted
// so the pins are not anchored to a paraphrase):
//   "a covered path whose evidence is partial/truncated/inconsistent also
//    refuses"
//   "v1 receipts with usable blobs are ENFORCED (grandfather only genuinely
//    absent evidence — schema absence does not imply blob absence)"
// THE ADJUDICATION (board f55ab3e9, launching brief): a v2 entry whose
// content_evidence.blobs is PRESENT but not a usable object is INCONSISTENT
// evidence -> REFUSE when the receipt covers a staged changed path, mirroring
// the v1 present-but-not-object class shipped in the S2b-2/S2b-3 fix rounds; the
// adapter must SURFACE that shape distinctly instead of collapsing it to
// `undefined`.
//
// WHY A NEW FILE: commit-reviewed-bytes-refuse.test.mjs is FROZEN and
// commit-reviewed-bytes-refuse-hardening.test.mjs pins the S2b-2 fix round; both
// are built around today's adapter contract, and this change moves that contract.
// Nothing here edits or weakens either suite.
//
// SPEC-ONLY, RED-FIRST. H4 read wall honored: this file's author never Read nor
// content-Grepped scripts/commit-reviewed.mjs or
// scripts/hooks/lib/review-ledger-entry.mjs. Only SIBLING TEST files were read —
// commit-reviewed-bytes-refuse-hardening.test.mjs in full (harness + fixture
// conventions, per the brief) and two targeted greps of the frozen
// commit-reviewed-bytes-refuse.test.mjs for its established OUTPUT VOCABULARY
// ("REVIEWED BYTES" as the refusal anchor, "NO CONTENT EVIDENCE" as the
// grandfather-disclosure anchor), so no assertion here invents a message string.
//
// ADAPTER CONTRACT, PINNED END-TO-END ONLY: the brief declares no interface for
// review-ledger-entry.mjs (no exported name, no return shape), so "the adapter
// surfaces the shape distinctly" is specified here through the ONLY declared
// entry point — the CLI's observable verdict, exit code, ledger bytes and
// disclosure. Inventing an adapter signature would be inventing an interface.
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// readLedgerRaw()/stageChange()/hashBytes()/stagedBlob()/
// stageChangedSinceReview()/runCommitReviewed()/trailerValues()/refusalBlock()/
// v1()/v2()/flat/isoAgo are carried over verbatim from
// commit-reviewed-bytes-refuse-hardening.test.mjs (itself carried from the frozen
// suite) so the three suites cannot disagree about what a fixture MEANS. Two
// deliberate deviations, both isolation-only or fixture-required:
//   1. the mkdtemp prefix is 'sterling-commit-reviewed-v2-malformed-';
//   2. v2() accepts the OMIT sentinel for `blobs`, producing a receipt whose
//      content_evidence has NO blobs key at all — the legitimate grandfather
//      fixture (M0b), which is the opposite of every malformed fixture here and
//      cannot be expressed by passing a value.
//
// EXIT-CODE CAVEAT THAT MAKES TWO ASSERTIONS LOAD-BEARING: node exits 1 on an
// uncaught exception, so `code === 1` ALONE cannot tell a refusal from a crash on
// malformed JSON. Every refusal pin below therefore also asserts the
// "REVIEWED BYTES" anchor and the absence of TypeError/ReferenceError.
//
// CONTROLS FIRST (both of them, before any refusal pin): M0 proves this fixture
// family commits when the blobs value IS usable, and M0b proves the legitimate
// grandfather still commits after the fix. Without M0 a refusal pin is satisfied
// by "this shape refuses everything"; without M0b the fix is satisfied by
// deleting the grandfather clause, which bricks every genuinely-evidence-less
// receipt in a live ledger.

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

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

// The vocabulary class the refusal disclosure must land in. Board f55ab3e9
// requires the refusal to NAME THE MALFORMED SHAPE — a refusal that says only
// "path not bound" reproduces, at the disclosure surface, the very conflation
// (unusable evidence read as absent evidence) that the fix exists to remove.
// This is a WORD CLASS, not a string: any one of these satisfies it.
const MALFORMED_VOCAB = /malformed|unusable|not an object|non-object|invalid|inconsistent/i;

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

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function writeLedger(dir, entries) {
  writeFileSync(ledgerPath(dir), JSON.stringify(entries));
}
function readLedger(dir) {
  return existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null;
}
// Raw bytes, not the parsed value: a refusal that rewrites the ledger with the
// same logical content has still written to an agent-writable evidence file
// during a refusal path.
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  const sha = (r.stdout ?? '').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: hash-object must produce a usable 40-hex sha, got ${sha}`);
  return sha;
}

const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

function stageChangedSinceReview(dir, relPath, oldContent, newContent) {
  const reviewedSha = hashBytes(dir, oldContent);
  stageChange(dir, relPath, newContent);
  assert.notEqual(reviewedSha, stagedBlob(dir, relPath), 'fixture guard: the reviewed bytes must genuinely differ from the staged bytes');
  return reviewedSha;
}

function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The EXACT read scripts/direct-merge.mjs's receipt gate uses, generalized over
// the trailer key.
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);

function refusalBlock(stderr) {
  const i = stderr.search(/REVIEWED BYTES/);
  return i === -1 ? '' : stderr.slice(i);
}

// v1 (flat) receipt — the frozen suite's helper. Used ONLY by the M3 regression
// family; nothing in the v2 families touches it.
function v1({ agent_type, files, blobs, at = isoAgo(60_000), session_id = SESSION, base_sha = undefined }) {
  const e = { agent_type, files, at, session_id, branch: 'main' };
  if (base_sha !== undefined) e.base_sha = base_sha;
  e.reviewed_state = { blobs, completed_at: at };
  return e;
}

// The sentinel for "content_evidence has NO blobs key at all" — the genuinely
// absent shape §2 grandfathers. Deliberately distinct from any VALUE, because
// the entire defect under test is a value being read as an absence.
const OMIT = Symbol('omit-the-blobs-key');

// v2 (nested) receipt — decision 57984926 §1, same shape as the frozen suite's
// helper and the hardening suite's.
function v2({
  entry_id,
  agent_type,
  files,
  blobs,
  base_sha,
  status = 'complete',
  absent_paths = [],
  truncated_of = null,
  failure_reason = null,
  at = isoAgo(60_000),
  // M5 only: replace the whole content_evidence VALUE (or, with OMIT, remove the
  // key). Left undefined by every other family, so the well-formed nested object
  // above stays the default and no existing fixture changes meaning.
  content_evidence: contentEvidenceOverride = undefined,
}) {
  const content_evidence = { status, blobs, absent_paths, truncated_of, failure_reason };
  if (blobs === OMIT) delete content_evidence.blobs;
  const entry = {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status: 'active',
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence,
    disposition: null,
  };
  if (contentEvidenceOverride !== undefined) {
    if (contentEvidenceOverride === OMIT) delete entry.content_evidence;
    else entry.content_evidence = contentEvidenceOverride;
  }
  return entry;
}

const OLD = 'export const f = 1; // the bytes the reviewer read\n';
const NEW = 'export const f = 2; // the bytes actually staged\n';

// ===========================================================================
// M0 / M0b — THE TWO CONTROLS, BOTH BEFORE ANY REFUSAL PIN.
//
// The verdict "this commit was refused" has more than one possible cause, so a
// green refusal below carries evidence only because these two pass for the
// OPPOSITE reasons: M0 says the family's fixture commits when the blobs value is
// USABLE, M0b says a receipt with genuinely ABSENT evidence still commits.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix.
// FIXTURE: byte-for-byte M1's fixture except that `blobs` is a proper
// {path: sha} map binding the staged path to its actual staged sha — ONE
// property changed, which is what makes M1's refusal attributable.
// SABOTAGE: make the evidence classifier treat any v2 receipt as inconsistent
// (e.g. refuse whenever content_evidence is inspected at all, or invert the
// object test to `typeof blobs !== 'object' ? ok : refuse`) -> this control
// refuses -> red here while M1/M2 stay green. That pair of results is the
// signature of an over-broad fix.
test('M0 (CONTROL, first): a v2 receipt with status "complete" and a PROPER {path: sha} blobs map matching the staged bytes commits normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'dddddddd-0000-4000-8000-0000000000d0',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
        base_sha: head,
        status: 'complete',
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'M0 well-formed v2 blobs map']);
    assert.equal(r.code, 0, `a usable, matching v2 blobs map must commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and the receipt stamps');
    assert.deepEqual(readLedger(dir), [], 'and is consumed');
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today AND after the fix — this is the LEGITIMATE
// grandfather, and it is the control against over-correction: §2 grandfathers
// "genuinely absent evidence", and a receipt that never recorded blobs at all
// (status 'unavailable', no blobs key) is exactly that shape. It must survive the
// fix untouched.
// FIXTURE, load-bearing: the blobs KEY IS ABSENT (OMIT), not present-and-empty
// and not present-and-null. The whole defect is a PRESENT value being read as an
// ABSENCE, so the control for it must be a real absence — the serialized-bytes
// guard below is what keeps this fixture honest.
// TWO TIERS OF STRICTNESS, deliberate: the COMMIT half is pinned hard (exit 0,
// commit created, stamped, consumed); the DISCLOSURE half is pinned only as
// NON-SILENCE (/evidence/i over the combined output), because §2 specifies that
// a grandfathered commit discloses but not in which words — the frozen C2 accepts
// "NO CONTENT EVIDENCE" or "REVIEWED BYTES" for the v1 analogue, and pinning
// either literal for the v2 'unavailable' path would be inventing a string.
// SABOTAGE (the over-correction half): treat "no blobs key" as inconsistent
// evidence (drop the present-vs-absent distinction in the OTHER direction, so
// absence refuses) -> exit 1 -> red here, while M1/M2/M3 stay green.
// SABOTAGE (the silence half): remove the grandfather disclosure line -> the
// /evidence/i assertion goes red while the commit assertions stay green.
test('M0b (CONTROL, second): a v2 receipt with status "unavailable" and NO blobs key over a changed staged file STILL COMMITS, with disclosure — genuinely absent evidence stays grandfathered', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entry = v2({
      entry_id: 'dddddddd-0000-4000-8000-0000000000d1',
      agent_type: 'reviewer-legacy',
      files: ['src/laneA.mjs'],
      blobs: OMIT,
      base_sha: head,
      status: 'unavailable',
      failure_reason: 'hashing did not run',
    });
    assert.ok(!('blobs' in entry.content_evidence), 'fixture guard: the blobs KEY must be absent, not present-and-empty');
    writeLedger(dir, [entry]);
    assert.doesNotMatch(readLedgerRaw(dir), /"blobs"/, 'fixture guard: the serialized ledger carries no blobs key at all');

    const r = runCommitReviewed(dir, ['-m', 'M0b v2 unavailable, no blobs key']);
    assert.equal(r.code, 0, `a receipt with no content evidence at all must NOT be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-legacy'], 'and the receipt stamps as before');
    assert.deepEqual(readLedger(dir), [], 'and is consumed as before');
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /evidence/i,
      `a grandfathered commit is never SILENT about the missing evidence — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M1 / M2 — PRESENT-BUT-UNUSABLE blobs IS INCONSISTENT EVIDENCE, NOT ABSENCE.
//
// §2: "a covered path whose evidence is partial/truncated/inconsistent also
// refuses"; "grandfather only genuinely absent evidence — schema absence does
// not imply blob absence."
//
// THE DEFECT: the adapter's blobs guard maps an unusable value to `undefined`,
// so "recorded something unusable" and "recorded nothing" become the same
// observation, and the grandfather clause swallows the first. status:'complete'
// makes it worse, not better: the receipt CLAIMS full coverage while carrying
// nothing comparable, which is self-contradiction on its face.
// ===========================================================================

// EXPECTED STATE: RED today. On the current tree the string blobs value is
// collapsed to `undefined`, the receipt is classified as recorded-nothing, the
// grandfather clause applies and the run commits (exit 0) -> the FIRST assertion
// (`code === 1`) fires, along with the HEAD-unmoved and ledger-byte-identical
// assertions.
// SABOTAGE (the whole defect, one line): in the adapter, map an unusable blobs
// value to `undefined` instead of surfacing it as a distinct present-but-unusable
// shape -> the CLI reads absence -> exit 0 -> red.
// SECOND SABOTAGE (the classifier half): surface the shape from the adapter but
// route it into the grandfather branch in the CLI ("no comparable blobs => absent
// evidence") -> exit 0 -> red. Both halves must hold; the pin cannot be satisfied
// by fixing only the adapter.
// THIRD SABOTAGE (the disclosure half): refuse, but describe it only as an
// unbound/missing path -> the MALFORMED_VOCAB assertion goes red while the exit
// code stays green. That arm is why this pin asserts the disclosure's word class
// and not just the verdict: board f55ab3e9 requires the malformed shape to be
// NAMED, since a refusal that calls it "absent" leaves the reader with the same
// wrong model the adapter had.
// NOT SATISFIED BY THE SHIPPED H2b GUARD: the S2b-2 fix refuses a 'complete'
// receipt that declares a staged path and binds no key for it — but it is never
// reached here, because the grandfather clause short-circuits first on an
// evidence-less-looking receipt. That short-circuit is the hole.
test('M1: a v2 receipt with status "complete" whose content_evidence.blobs is the STRING "junk", covering a staged changed path, REFUSES as inconsistent evidence — and the refusal names the malformed shape', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'eeeeeeee-0000-4000-8000-0000000000e1',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: 'junk',
        base_sha: head,
        status: 'complete',
      }),
    ]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"blobs":"junk"/, 'fixture guard: the serialized ledger really carries a STRING blobs value');

    const r = runCommitReviewed(dir, ['-m', 'M1 v2 complete, blobs is a string']);
    assert.equal(
      r.code,
      1,
      `a PRESENT but unusable blobs value is inconsistent evidence (clause 2), never genuinely absent evidence (clause 3) — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the ledger file is byte-identical after the refusal');
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a REFUSAL, never a crash — node exits 1 on an uncaught throw too — stderr=${flat(r.stderr)}`);
    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal carries the REVIEWED BYTES anchor, as every other refusal in this gate does — stderr=${flat(r.stderr)}`);
    assert.match(block, /src\/laneA\.mjs/, `and names the covered staged path — refusal=${flat(block)}`);
    assert.match(
      block,
      MALFORMED_VOCAB,
      `and names the MALFORMED SHAPE rather than reporting it as absent/unbound evidence — refusal=${flat(block)}`
    );
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today, all three arms, same shape and same cause as M1.
// WHY THE ARMS ARE NOT REDUNDANT — each kills a DIFFERENT partial fix:
//   'junk' (M1)   : killed by any `typeof blobs === 'object'` test;
//   42            : same class as M1, but a number reaches index access
//                   (42['src/laneA.mjs'] === undefined) without throwing, so an
//                   implementation that merely try/catches its way to safety
//                   still grandfathers it;
//   ['array']     : `typeof [] === 'object'` is TRUE, so an object-typeof fix
//                   passes M1 and this arm still slips through — an array is a
//                   usable-looking container whose keys are indices, never paths;
//   true          : a boolean, the cheapest hand-edit of the four, included
//                   because it is unambiguously the adjudicated class (PRESENT,
//                   not a usable object) and no reading grandfathers it.
// SABOTAGE: guard with `typeof blobs === 'object'` alone (no Array.isArray, no
// null check) -> the array arm commits -> red on that arm alone, while M1 stays
// green. That single-arm signature is exactly what a partial fix looks like.
test('M2 (arms): a v2 receipt with status "complete" whose content_evidence.blobs is 42, ["array"] or true, covering a staged changed path, REFUSES in every arm', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'number', blobs: 42, serialized: /"blobs":42/ },
    { label: 'array', blobs: ['array'], serialized: /"blobs":\["array"\]/ },
    { label: 'boolean', blobs: true, serialized: /"blobs":true/ },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', NEW);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [
        v2({
          entry_id: `eeeeeeee-0000-4000-8000-0000000000e2-${arm.label}`,
          agent_type: 'reviewer-correctness',
          files: ['src/laneA.mjs'],
          blobs: arm.blobs,
          base_sha: head,
          status: 'complete',
        }),
      ]);
      const before = readLedgerRaw(dir);
      assert.match(before, arm.serialized, `[${arm.label}] fixture guard: the serialized ledger really carries this blobs value`);

      const r = runCommitReviewed(dir, ['-m', `M2 ${arm.label} blobs value`]);
      assert.equal(r.code, 1, `[${arm.label}] a PRESENT but unusable blobs value must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${arm.label}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] ledger byte-identical`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm.label}] a refusal, never a crash — stderr=${flat(r.stderr)}`);
      const block = refusalBlock(r.stderr);
      assert.notEqual(block, '', `[${arm.label}] the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
      assert.match(block, /src\/laneA\.mjs/, `[${arm.label}] and names the covered staged path — refusal=${flat(block)}`);
      assert.match(block, MALFORMED_VOCAB, `[${arm.label}] and names the malformed shape — refusal=${flat(block)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// M3 — v1 RECEIPTS ARE UNTOUCHED BY THIS FIX (regression guard, not a new rule).
//
// The fix changes the v2 adapter path. These two pins exist so a v2 change that
// leaks into the shared v1 reading is caught in the same run: one shape that must
// still COMMIT, one that must still REFUSE. They are stated as guards over
// ALREADY-SHIPPED behaviour (S2b-2/S2b-3), not as new specification.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix (the frozen C0 / hardening H3-0
// property, restated here as this file's v1 guard).
// SABOTAGE: implement the fix by deleting the grandfather clause outright, or by
// classifying "no evidence recorded" as inconsistent for ALL schema versions ->
// this legacy receipt refuses -> red, while M1/M2 stay green. That is the
// over-correction that would brick every pre-flip receipt in a live ledger.
test('M3a (v1 REGRESSION GUARD, control first): a v1 receipt with NO reviewed_state key over a changed staged file still COMMITS — the existing grandfather is untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [{ agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main' }]);

    const r = runCommitReviewed(dir, ['-m', 'M3a v1 legacy receipt, no evidence key']);
    assert.equal(r.code, 0, `a v1 receipt with no content evidence at all must NOT be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-legacy'], 'and stamped as before');
    assert.deepEqual(readLedger(dir), [], 'and consumed as before');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today AND after the fix, IF the v1 present-but-not-object
// class shipped as board f55ab3e9 records ("the v1 present-but-not-object hole
// closed in the S2b-2 fix round"), whose direction the hardening suite's H3b pins
// as REFUSE for the neighbouring present-and-null shape. A RED here today is a
// FINDING, not a fix pin: it would mean the v1 half of the class was never
// actually closed for a non-null unusable value, and the conductor should treat
// it as newly discovered scope rather than as this slice's expected red.
// SABOTAGE: relax the v1 evidence guard to `reviewed_state?.blobs ?? {}` and
// grandfather the empty result -> exit 0 -> red. Restated positively: this pin is
// what stops the v2 fix from being implemented by MOVING the guard out of the
// shared reading path instead of adding to it.
test('M3b (v1 REGRESSION GUARD): a v1 receipt whose reviewed_state.blobs is the STRING "junk", covering a staged changed path, still REFUSES — the shipped v1 inconsistent class is preserved', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: 'junk' })]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"blobs":"junk"/, 'fixture guard: the serialized v1 receipt really carries a STRING blobs value');

    const r = runCommitReviewed(dir, ['-m', 'M3b v1 blobs is a string']);
    assert.equal(r.code, 1, `the v1 present-but-not-object class refuses, and this fix must not change that — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `a refusal, never a crash — stderr=${flat(r.stderr)}`);
    assert.notEqual(refusalBlock(r.stderr), '', `the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M4 — AMBIGUITY PIN (reported, NOT resolved here).
//
// `content_evidence.blobs: null` is PRESENT-and-null. Board f55ab3e9's rule
// ("present but not a usable object") reaches it, and the v1 analogue (hardening
// H3b, reviewed_state present-and-null) is adjudicated REFUSE — but the board
// item's own examples are "junk"/42/["array"], and `null` is the one value an
// implementation can defensibly read as an explicit absence rather than a
// malformed record. §2 does not choose, and the brief did not adjudicate it.
//
// So this pin asserts only what holds under EITHER reading (the frozen C2/C3
// pattern): no crash, and no SILENT acceptance. It exists so the conductor learns
// which way the fix went without a false red either way — if the answer should be
// strict refusal, THIS is the pin that gets tightened, and the tightening is a
// one-line change to this test.
// SABOTAGE: let a null blobs value fall through as verified evidence (commit,
// no stamp / no disclosure path taken) -> the commit branch's stamp assertion
// goes red.
test('M4 (AMBIGUITY, either reading): a v2 receipt with status "complete" and content_evidence.blobs === null is never silently mishandled — refuse+preserve, or commit+disclose', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'ffffffff-0000-4000-8000-0000000000f1',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: null,
        base_sha: head,
        status: 'complete',
      }),
    ]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"blobs":null/, 'fixture guard: the key is PRESENT and null, not omitted');

    const r = runCommitReviewed(dir, ['-m', 'M4 v2 complete, blobs null']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `a null blobs value must never crash the CLI — stderr=${flat(r.stderr)}`);
    if (r.code === 0) {
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'if it commits, the commit really happened');
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and the receipt is stamped normally');
      assert.deepEqual(readLedger(dir), [], 'and consumed normally');
      assert.match(
        `${r.stdout}\n${r.stderr}`,
        /evidence/i,
        `if a null blobs value is grandfathered, the missing evidence must still be DISCLOSED — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`
      );
    } else {
      assert.equal(r.code, 1, `a refusal is exit 1, never another code — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'if it refuses, no commit was created');
      assert.equal(readLedgerRaw(dir), before, 'and nothing was consumed');
      assert.notEqual(refusalBlock(r.stderr), '', `and the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M5 — THE SAME HOLE ONE LEVEL UP: a non-object content_evidence VALUE.
//
// SCOPE ADDED MID-ROUND (coordinator, this round): the M1/M2 fix guards the
// `blobs` value INSIDE content_evidence. A v2 entry whose ENTIRE
// content_evidence value is a non-object ("junk", 42, ["array"]) never reaches
// that guard — normalization maps it to `contentEvidence = null`, blobs reads as
// `undefined`, and the receipt is grandfathered exactly as before. Same defect
// class, same clause, one nesting level up: an unusable PRESENT value being read
// as a genuine ABSENCE.
//
// §2 governs it unchanged: "a covered path whose evidence is
// partial/truncated/inconsistent also refuses"; "grandfather only genuinely
// absent evidence — schema absence does not imply blob absence." A receipt that
// wrote SOMETHING into content_evidence has not established an absence.
//
// WHERE THE VERDICT'S EVIDENCE COMES FROM: M0 (first in file) is still the
// load-bearing control for this family too — it is a v2 receipt with a
// well-formed content_evidence object that COMMITS, so a green refusal here can
// never be explained by "the fix refuses every v2 receipt". M5-0 below adds the
// family's own absence probe.
//
// ONE test() PER ARM, deliberately, not a loop body: an early assertion failure
// aborts the whole test and hides every later arm, so a looped three-arm fixture
// reports "one red" while two further defects sit unmeasured
// (anti_pattern early-assertion-masks-every-later-assertion-in-the-same-test).
// M2's loop predates that reading; the new family does not repeat it.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix, under EITHER reading — this is
// an ambiguity probe, not a verdict pin. v2 promotions always write
// content_evidence, so an entry missing the key entirely is malformed-adjacent
// rather than legitimately legacy (unlike M3a's v1 receipt, where the key did not
// yet exist). §2 does not choose between "refuse as inconsistent" and "treat as
// absent and disclose", and this round did not adjudicate it, so the pin asserts
// only the invariants that hold either way: never a crash, and never a SILENT
// acceptance as verified evidence.
// SABOTAGE: let a missing content_evidence fall through as verified evidence
// (commit with no stamp, or commit with no disclosure at all) -> the commit
// branch's stamp/`evidence` assertions go red. SECOND SABOTAGE: reach into the
// missing key without a guard -> TypeError -> the no-crash assertion goes red
// before anything else can explain the exit code.
test('M5-0 (family control / AMBIGUITY, first): a v2 entry with NO content_evidence key at all is never silently mishandled — refuse+preserve, or commit+disclose, never a crash', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entry = v2({
      entry_id: '99999999-0000-4000-8000-000000000090',
      agent_type: 'reviewer-correctness',
      files: ['src/laneA.mjs'],
      base_sha: head,
      content_evidence: OMIT,
    });
    assert.ok(!('content_evidence' in entry), 'fixture guard: the content_evidence KEY must be absent, not present-and-empty');
    writeLedger(dir, [entry]);
    const before = readLedgerRaw(dir);
    assert.doesNotMatch(before, /"content_evidence"/, 'fixture guard: the serialized entry carries no content_evidence key at all');

    const r = runCommitReviewed(dir, ['-m', 'M5-0 v2 entry with no content_evidence key']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `a missing content_evidence must never crash the CLI — stderr=${flat(r.stderr)}`);
    if (r.code === 0) {
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'if it commits, the commit really happened');
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and the receipt is stamped normally');
      assert.deepEqual(readLedger(dir), [], 'and consumed normally');
      assert.match(
        `${r.stdout}\n${r.stderr}`,
        /evidence/i,
        `if it is grandfathered, the missing evidence must still be DISCLOSED — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`
      );
    } else {
      assert.equal(r.code, 1, `a refusal is exit 1, never another code — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'if it refuses, no commit was created');
      assert.equal(readLedgerRaw(dir), before, 'and nothing was consumed');
      assert.notEqual(refusalBlock(r.stderr), '', `and the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    }
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today, every arm, on the FIRST assertion (`code === 1`):
// the non-object content_evidence normalizes to null, blobs reads as undefined,
// the grandfather clause applies and the run commits.
// SABOTAGE (the defect itself, one line): normalize a non-object content_evidence
// to `null` (or `?? {}`) instead of surfacing it as present-but-unusable -> the
// CLI reads absence -> exit 0 -> red.
// SABOTAGE (the depth half): apply the M1/M2 fix ONLY to the inner `blobs` value
// and leave the outer normalization untouched -> M1/M2 go green while every arm
// here stays red. That result pair is the signature this family exists to make
// visible, and no pin above can produce it.
// SABOTAGE (the array half, this arm specifically): guard the outer value with
// `typeof content_evidence === 'object'` alone -> the ["array"] arm commits while
// the "junk" and 42 arms refuse -> exactly one arm red, which is why the arms are
// three independent tests rather than one abortable loop.
// SABOTAGE (the disclosure half): refuse but describe it as absent/unbound
// evidence -> only the MALFORMED_VOCAB assertion reds.
for (const arm of [
  { label: 'string', value: 'junk', serialized: /"content_evidence":"junk"/ },
  { label: 'number', value: 42, serialized: /"content_evidence":42/ },
  { label: 'array', value: ['array'], serialized: /"content_evidence":\["array"\]/ },
]) {
  test(`M5 (${arm.label}): a v2 entry whose whole content_evidence VALUE is a non-object, covering a staged changed path, REFUSES as inconsistent evidence — and the refusal names the malformed shape`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', NEW);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [
        v2({
          entry_id: `99999999-0000-4000-8000-00000000009${arm.label}`,
          agent_type: 'reviewer-correctness',
          files: ['src/laneA.mjs'],
          base_sha: head,
          content_evidence: arm.value,
        }),
      ]);
      const before = readLedgerRaw(dir);
      assert.match(before, arm.serialized, `[${arm.label}] fixture guard: the serialized entry really carries this content_evidence value`);

      const r = runCommitReviewed(dir, ['-m', `M5 ${arm.label} content_evidence value`]);
      assert.equal(
        r.code,
        1,
        `[${arm.label}] a PRESENT but unusable content_evidence is inconsistent evidence (clause 2), never genuinely absent evidence (clause 3) — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${arm.label}] NO commit was created`);
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] NOTHING consumed — the ledger file is byte-identical after the refusal`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm.label}] a REFUSAL, never a crash — node exits 1 on an uncaught throw too — stderr=${flat(r.stderr)}`);
      const block = refusalBlock(r.stderr);
      assert.notEqual(block, '', `[${arm.label}] the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
      assert.match(block, /src\/laneA\.mjs/, `[${arm.label}] and names the covered staged path — refusal=${flat(block)}`);
      assert.match(block, MALFORMED_VOCAB, `[${arm.label}] and names the MALFORMED SHAPE rather than reporting it as absent/unbound evidence — refusal=${flat(block)}`);
    } finally {
      cleanup();
    }
  });
}
