// REVIEW-LEDGER `discharge` + FALLBACK NARROWING — **HARDENING PINS**
// (campaign slice S2b-3 FIX ROUND; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §3).
//
// WHY A SECOND FILE: scripts/tests/review-ledger-discharge.test.mjs and
// scripts/tests/commit-reviewed-structured-fallback.test.mjs are FROZEN — they
// are the red-first evidence for the discharge verb and the fallback narrowing
// as SHIPPED. Two independent reviews of the shipped CLI found defects those
// suites cannot see: a post-hoc reviewer's clean worktree classified as
// no-live, foreign-* classes accepted on an entry whose identity is UNKNOWN
// rather than foreign, a mid-commit discharge destroyed by the consume write,
// an UNAUTHENTICATED `status:'discharged'` marker changing spendability, a
// declared path with pathspec metacharacters compared as a GLOB, and an IGNORED
// untracked file reading as absent territory. These are NEW spec pins for the
// FIXED behaviour; nothing here edits or weakens a frozen suite or any source.
//
// SPEC-ONLY, RED-FIRST. Authored from decision 57984926 §3 (opened with
// knowledge_get; the governing clauses are quoted at each family) and the
// launching brief's adjudications. H4 read wall honored: this file's author
// never Read nor content-Grepped scripts/review-ledger.mjs,
// scripts/commit-reviewed.mjs or scripts/hooks/lib/review-ledger-entry.mjs.
// Only sibling TEST files were read, for fixture conventions.
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// readLedgerRaw()/ledgerDigest()/assertNoLedgerResidue()/stageChange()/
// commitFile()/stagedBlob()/runLedger()/runCommitReviewed()/
// reviewedByTrailers()/v2()/flat/isoAgo are review-ledger-discharge.test.mjs's
// idioms, carried over VERBATIM so the two suites cannot disagree about what a
// fixture MEANS. installPreCommitHook() is
// commit-reviewed-hardening.test.mjs's idiom (a real, executable
// .git/hooks/pre-commit, mode 0o755 + chmod), likewise verbatim. One deliberate
// harness deviation, isolation-only: the mkdtemp prefix is
// 'sterling-review-ledger-discharge-hardening-'.
//
// THE INTERFACE IS THE SIBLING SUITE'S, UNCHANGED:
//     node scripts/review-ledger.mjs discharge \
//       --entry-id <uuid> --digest <sha256-of-exact-ledger-bytes> \
//       --class <foreign-session|foreign-branch|no-live-territory> \
//       --reason "<single-line reason>"
//   cwd = project root; ledger = .sterling/review-ledger.json; exit 0 =
//   discharged, non-zero = refused, refusals speak on stderr;
//   STERLING_SESSION_ID is the current-session seam (commit-reviewed.mjs
//   currentSessionId(), per commit-reviewed-file-scoping.test.mjs). If the
//   coder changed a FLAG SPELLING, the flag names here are what moves — the
//   assertions inside each test are the spec and stand unchanged.
//
// LOAD-BEARING FIXTURE CHOICES:
//   1. CONTROLS FIRST IN EVERY FAMILY. Each refusal pin is its family's control
//      fixture minus EXACTLY ONE property, so a green refusal can never be
//      explained by "this class refuses everything" — and each success pin has a
//      counter-arm so a green cannot be explained by "this class accepts
//      everything".
//   2. EVERY no-live fixture whose expected verdict is SUCCESS puts base_sha at
//      a genuine ANCESTOR of HEAD (HEAD advanced on an unrelated file), because
//      family P1 makes base_sha == HEAD + clean tree a REFUSAL. Without that
//      separation a P5/P6 success arm would be refused for P1's reason and the
//      red would be uninterpretable.
//   3. Every v2 receipt spent through commit-reviewed binds MATCHING blobs for
//      the staged path (§2's reviewed-bytes REFUSE flip is live), so no pin here
//      can go red for a byte-mismatch it did not intend.
//
// AMBIGUITIES FLAGGED, NOT RESOLVED (reported to the launching agent, not pinned):
//   (a) [CLOSED by the final-review adjudication, now pinned as P2b] `--class
//       foreign-session` on a receipt whose session_id EQUALS the current
//       session — a CONTRADICTED assertion, not merely an unverified one. §3
//       does not spell it out; the fix round adjudicates REFUSE, so P2b asserts
//       it strictly rather than either-reading.
//   (b) A no-live declared path ABSENT from base AND absent from the worktree
//       (the "reverted addition" shape). §3's rejected option (b) implies
//       no-live, but does not state it; family P6's control therefore uses a
//       TRACKED at-base path instead, so no pin depends on that reading.
//   (c) Whether the P4b disclosure is stderr-only or also mutates/annotates the
//       malformed entry. P4b pins DISCLOSURE + NON-SPENDING + PRESERVATION, and
//       deliberately does not forbid an added annotation... except that the
//       entry must still be there, unspent (see the assertion messages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, utimesSync, statSync } from 'node:fs';
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

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-discharge-hardening-'));
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
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

// THE CONCURRENCY TOKEN: SHA-256 over the EXACT ledger bytes, per §3 (mtime was
// explicitly rejected). Computed from the file, never from a re-serialization.
function ledgerDigest(dir) {
  return createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');
}

function assertNoLedgerResidue(dir, label) {
  const residue = readdirSync(join(dir, '.sterling')).filter(
    (n) => /^review-ledger\.json\..+/.test(n) && !n.endsWith('.lock')
  );
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
  return git(dir, ['hash-object', relPath]);
}
function stagedBlob(dir, relPath) {
  return git(dir, ['hash-object', relPath]);
}
const porcelain = (dir) => git(dir, ['status', '--porcelain']);

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function reviewedByTrailers(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// A REAL, executable pre-commit hook in the fixture repo — the deterministic way
// to observe what happens WHILE `git commit` runs without reading the CLI.
function installPreCommitHook(dir, script) {
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, script, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
}

// v2 entry per decision 57984926 §1 — verbatim from review-ledger-discharge.test.mjs.
function v2({
  entry_id,
  agent_type,
  files,
  blobs = {},
  base_sha,
  session_id = SESSION,
  branch = 'main',
  source = 'review-territory',
  status = 'active',
  disposition = null,
  at = isoAgo(60_000),
}) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status,
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha },
    territory: { files, source, attribution: 'block' },
    content_evidence: { status: 'complete', blobs, absent_paths: [], truncated_of: null, failure_reason: null },
    disposition,
  };
}

const TARGET_ID = 'e0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'e0000000-0000-4000-8000-00000000000b';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';

const bystander = (base_sha) =>
  v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });

// ===========================================================================
// P1 — A POST-HOC REVIEWER'S CLEAN WORKTREE IS NOT "REVERTED".
//
// §3 (MODE-SPECIFIC clause, verbatim): "MODE-SPECIFIC classifier semantics,
// explicit in the API: new-commit mode compares receipt base -> effective
// index/worktree; --target-sha amend mode compares target parent(s) -> target
// tree (a post-hoc reviewer's clean worktree must not read as reverted)."
//
// THE DEFECT: in NEW-COMMIT mode, a receipt whose base_sha IS the current HEAD
// over a clean tree makes every declared path trivially equal to its base state
// — so a per-path base-vs-worktree comparison concludes "no live territory" for
// the FRESHEST possible receipt. That receipt is not residue: it is a completed
// review of work already committed, spendable through `--target-sha` amend. A
// discharge there destroys spendable review evidence, and it is the easiest
// possible discharge to obtain (review after committing, then discharge).
// ===========================================================================

// EXPECTED STATE: GREEN today (the frozen D6a pins this exact shape; restated
// here as THIS family's control because P1a asserts a REFUSAL for a fixture
// that differs from it in ONE fact — base_sha == HEAD).
// PLACED FIRST: without it, P1a's refusal is satisfied by a classifier that
// refuses no-live-territory unconditionally, and by an absent CLI.
// SABOTAGE: gate no-live on `base_sha === HEAD` (the inverse over-correction of
// the P1a fix) -> this control refuses -> red, while P1a stays green. That pair
// of results is the signature of an over-narrow fix, and no single pin can see
// it.
test('discharge-hardening P1-0 (CONTROL, first): no-live-territory still SUCCEEDS when base_sha is a genuine ANCESTOR of HEAD and every declared path was returned to its base bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances; laneA untouched
    stageChange(dir, 'src/laneA.mjs', OTHER);
    stageChange(dir, 'src/laneA.mjs', CODE); // a genuine round trip
    assert.notEqual(baseSha, git(dir, ['rev-parse', 'HEAD']), 'fixture guard: HEAD has genuinely moved past base_sha');
    assert.equal(
      stagedBlob(dir, 'src/laneA.mjs'),
      git(dir, ['rev-parse', `${baseSha}:src/laneA.mjs`]),
      'fixture guard: the declared path really is back at its base-state blob'
    );

    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: baseSha }),
      bystander(baseSha),
    ]);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'the reviewed change was reverted; nothing of it remains to commit',
    ]);
    assert.equal(r.code, 0, `a conclusive no-live classification must still succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.equal(entry.status, 'discharged', 'the entry is discharged');
    assert.equal(entry.disposition.class, 'no-live-territory', 'and records the class it was classified under');
    assertNoLedgerResidue(dir, 'P1-0');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if the shipped classifier compares per-path
// base->worktree without asking whether base_sha IS HEAD over a clean tree —
// which is the reviews' finding. The discharge succeeds, so the FIRST assertion
// (`r.code !== 0`) fires, followed by the ledger-byte-identical and
// status-still-'active' assertions.
// SABOTAGE (the fix's own guard): delete the base_sha-is-HEAD-and-clean check ->
// exit 0 -> red here, green in P1-0. That is the one line this pin exists for.
// SECOND SABOTAGE (fail the OTHER way): treat "nothing differs" as conclusive
// no-live for every mode -> same red. Note what is NOT asserted: no wording is
// required to mention --target-sha, and the exact refusal vocabulary is matched
// by a broad alternation, because §3 fixes the SEMANTICS and not the prose. The
// verdict is carried by exit code + preservation + still-active, all three.
// WHY still-'active' MATTERS SEPARATELY: a refusal that nonetheless left the
// entry mutated would satisfy "exit non-zero" while having already destroyed the
// spendability the pin protects.
test('discharge-hardening P1a: no-live-territory is REFUSED when base_sha resolves to the CURRENT HEAD over a clean worktree — a post-hoc review is fresh evidence, not residue, and stays spendable', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(porcelain(dir), '', 'fixture guard: the worktree is CLEAN — index and worktree both equal HEAD');

    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: head }),
      bystander(head),
    ]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'clean tree at the reviewed base — asserted as no-live',
    ]);
    assert.notEqual(
      r.code,
      0,
      `a receipt whose base IS HEAD over a clean tree has NOT had its territory reverted — the review simply happened after the commit, and §3 forbids reading that as reverted — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a refused classification writes nothing at all');
    assert.equal(
      readLedger(dir).find((e) => e.entry_id === TARGET_ID).status,
      'active',
      'and the receipt stays ACTIVE, so it is still spendable through a --target-sha amend'
    );
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `it is a refusal, never a crash — stderr=${flat(r.stderr)}`);
    assert.match(
      r.stderr,
      /post.?hoc|amend|target.?sha|head|base|unchanged|no change|nothing changed|ambig|unknown|not conclusive|inconclusive|classif/i,
      `the refusal is ABOUT the classification being inconclusive, not a generic error — stderr=${flat(r.stderr)}`
    );
    assertNoLedgerResidue(dir, 'P1a');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P2 — FOREIGN-* IS FAIL-CLOSED: UNKNOWN IS NOT FOREIGN.
//
// §3: discharge "requires a recognized unspendable class (foreign session,
// foreign branch, conclusive no-live structured territory)"; P5 of the core
// principles: "Fail loud, never silent. Unknown signals halt."
//
// THE DEFECT: `foreign-session` on an entry whose identity.session_id is MISSING
// or EMPTY. A comparison against the current session seam reads
// `undefined !== 'this-session'` as TRUE and calls the entry foreign — so the
// cheapest way to make ANY receipt dischargeable is to delete one field of the
// agent-writable ledger. An unknown identity is exactly the ambiguity §3 sends
// to 'unknown', never to a recognized class.
// ===========================================================================

// EXPECTED STATE: GREEN today (D0's property for foreign-session, extended to
// foreign-branch, which no frozen pin covers).
// PLACED FIRST, and it must pass for the OPPOSITE reason to P2a: these entries
// carry a PRESENT, WELL-FORMED identity that genuinely differs from the current
// session / current branch.
// SABOTAGE: require identity fields to be present AND refuse whenever they are
// (an over-tight fix that never accepts foreign-*) -> both arms red here, P2a
// green. SECOND SABOTAGE: compare session_id against the wrong seam (the
// anti-pattern review-receipt-expiry-compares-two-different-session-identifiers)
// -> the foreign-session arm's exit-0 assertion goes red.
test('discharge-hardening P2-0 (CONTROL, first): a PRESENT identity that genuinely differs is dischargeable — foreign-session on a foreign session_id, foreign-branch on a foreign branch', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'foreign-session', cls: 'foreign-session', patch: (e) => { e.identity.session_id = 'a-session-that-ended'; } },
    { label: 'foreign-branch', cls: 'foreign-branch', patch: (e) => { e.identity.branch = 'feature/elsewhere'; } },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'fixture guard: the repo really is on main');
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head });
      arm.patch(target);
      writeLedger(dir, [target, bystander(head)]);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', arm.cls, '--reason', `${arm.label}: the receipt was earned somewhere this commit cannot spend it`,
      ]);
      assert.equal(r.code, 0, `[${arm.label}] a genuinely foreign identity is a recognized unspendable class — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
      assert.equal(entry.status, 'discharged', `[${arm.label}] the entry is discharged`);
      assert.equal(entry.disposition.class, arm.cls, `[${arm.label}] and records the asserted class`);
      assert.deepEqual(entry.identity, target.identity, `[${arm.label}] with the identity evidence preserved verbatim`);
      assertNoLedgerResidue(dir, `P2-0/${arm.label}`);
    } finally {
      cleanup();
    }
  }
});

// EXPECTED STATE: RED today if the shipped CLI records the asserted class
// without verifying it, or verifies it with a bare `!==` against the seam — in
// both cases the discharge succeeds and the FIRST assertion (`r.code !== 0`)
// fires, followed by the byte-identical and status-'active' assertions.
// FOUR ARMS, one per (class x absence shape): a MISSING key and an EMPTY string
// are different code paths (`'session_id' in identity` vs a truthiness check),
// and a guard written for one does not cover the other.
// SABOTAGE (the whole pin): implement the foreign check as
// `entry.identity?.session_id !== currentSessionId()` -> undefined and '' both
// compare unequal, all four arms discharge -> red.
// SECOND SABOTAGE: guard only the MISSING case (`if (!('session_id' in ...))`)
// while leaving '' to fall through the `!==` -> the two 'empty' arms go red
// alone, which is the signature this arm-split exists to produce.
// EVERY OTHER INPUT IS CORRECT in each arm — fresh digest, real entry_id, real
// reason, a structurally complete v2 receipt — so the only possible cause of a
// refusal is the unknown identity field.
test('discharge-hardening P2a: foreign-session / foreign-branch are REFUSED when the identity field is MISSING or EMPTY — an unknown identity is never a recognized foreign class', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'session-missing', cls: 'foreign-session', patch: (e) => { delete e.identity.session_id; }, words: /session|identity|unknown|missing|absent|foreign|fail.?closed|ambig|class/i },
    { label: 'session-empty', cls: 'foreign-session', patch: (e) => { e.identity.session_id = ''; }, words: /session|identity|unknown|missing|empty|blank|foreign|fail.?closed|ambig|class/i },
    { label: 'branch-missing', cls: 'foreign-branch', patch: (e) => { delete e.identity.branch; }, words: /branch|identity|unknown|missing|absent|foreign|fail.?closed|ambig|class/i },
    { label: 'branch-empty', cls: 'foreign-branch', patch: (e) => { e.identity.branch = ''; }, words: /branch|identity|unknown|missing|empty|blank|foreign|fail.?closed|ambig|class/i },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head });
      arm.patch(target);
      // The OTHER identity field stays correct-and-current, so neither arm can
      // refuse for the sibling class's reason.
      writeLedger(dir, [target, bystander(head)]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', arm.cls, '--reason', `${arm.label}: asserted foreign on an identity nobody can read`,
      ]);
      assert.notEqual(
        r.code,
        0,
        `[${arm.label}] an absent identity field is UNKNOWN, and unknown is not foreign — deleting one ledger field must never make a receipt dischargeable — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical`);
      assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${arm.label}] the receipt stays active`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm.label}] a refusal, never a crash — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, arm.words, `[${arm.label}] the refusal names the unreadable identity, not a generic error — stderr=${flat(r.stderr)}`);
      assertNoLedgerResidue(dir, `P2a/${arm.label}`);
    } finally {
      cleanup();
    }
  }
});

// EXPECTED STATE: GREEN against the current (fixed) tree — the verification the
// fix added for P2a necessarily decides this case too. This pin exists because
// that is NOT self-evident from the suite: with P2-0 and P2a alone, the
// CONTRADICTED branch (both identities known and EQUAL) is DELETABLE with every
// test still green, since no other pin ever discharges a receipt whose recorded
// identity matches this side's. A pin that only proves "unknown refuses" leaves
// "known-and-equal is foreign" reachable.
// SABOTAGE: implement the foreign check as "refuse only when the identity field
// is missing or empty; otherwise record the asserted class" -> both arms
// discharge -> red, while P2-0 and P2a both stay green. That is precisely the
// deletion this pin blocks.
// SECOND SABOTAGE: compare identity.branch against a stale or hardcoded branch
// name instead of the CHECKED-OUT branch -> the branch arm goes red while the
// session arm stays green.
// FIXTURE: the receipt is otherwise perfect — present, well-formed, current
// session AND current branch, structurally complete — so the ONLY thing wrong is
// that the asserted class contradicts the recorded identity.
test('discharge-hardening P2b: foreign-session / foreign-branch are REFUSED when the recorded identity EQUALS this side\'s — a contradicted class is never merely recorded', { skip: GIT_SKIP }, () => {
  const arms = [
    {
      label: 'session-equal',
      cls: 'foreign-session',
      patch: (e) => { e.identity.session_id = SESSION; },
      words: /session|foreign|current|same|equal|match|contradict|not foreign|this session|class/i,
    },
    {
      label: 'branch-equal',
      cls: 'foreign-branch',
      patch: (e, branch) => { e.identity.branch = branch; },
      words: /branch|foreign|current|same|equal|match|contradict|not foreign|checked.?out|class/i,
    },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      assert.equal(branch, 'main', 'fixture guard: the repo really is on main');
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head });
      arm.patch(target, branch);
      assert.equal(target.identity.session_id, SESSION, `[${arm.label}] fixture guard: the recorded session IS the seam value`);
      assert.equal(target.identity.branch, branch, `[${arm.label}] fixture guard: the recorded branch IS the checked-out branch`);
      writeLedger(dir, [target, bystander(head)]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', arm.cls, '--reason', `${arm.label}: asserted foreign against an identity that matches this side`,
      ]);
      assert.equal(
        r.code,
        1,
        `[${arm.label}] the asserted class CONTRADICTS the recorded identity — a receipt earned here, on this branch, in this session is spendable, and calling it foreign must refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical — a refused discharge writes nothing`);
      assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${arm.label}] the receipt stays active and spendable`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm.label}] a refusal, never a crash — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, arm.words, `[${arm.label}] the refusal is ABOUT the contradiction, not a generic error — stderr=${flat(r.stderr)}`);
      assertNoLedgerResidue(dir, `P2b/${arm.label}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// P3 — A DISCHARGE LANDING WHILE `git commit` RUNS SURVIVES THE CONSUME WRITE.
//
// §3: "preserves the original evidence"; "deletion is never silent — durable
// preservation promised"; and "spending, amend spending, fallback selection and
// counts all ignore discharged entries."
//
// THE DEFECT: commit-reviewed snapshots the ledger, commits, then writes the
// ledger back minus what it spent. A discharge that lands in that window is
// destroyed by the write-back — the entry is removed as "consumed" although it
// had just become preserved evidence. The frozen consume-snapshot pin covers an
// APPENDED entry only; an in-place status flip of the SAME entry the CLI is
// spending is a different write path and no frozen pin can see it.
// The observation seam is a real .git/hooks/pre-commit, exactly as the frozen
// commit-reviewed hardening suite does it.
// ===========================================================================

const DISPOSITION = {
  reason: 'the session that produced it ended while the commit was in flight',
  at: '2026-08-31T09:00:00.000Z',
  head_sha: 'f'.repeat(40),
  classifier_version: 1,
  class: 'foreign-session',
};

// The hook flips the SAME entry the CLI is about to spend. It EXITS 1 if the
// entry is already gone — which aborts the commit and turns a
// consume-before-commit implementation into a loud, diagnosable red rather than
// a silent pass.
const hookDischargeTarget = (entryId, disposition) => `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
const target = entries.find((e) => e.entry_id === ${JSON.stringify(entryId)});
if (!target) {
  console.error('fixture hook: the target entry was already gone from the ledger while git commit was still running');
  process.exit(1);
}
target.status = 'discharged';
target.disposition = ${JSON.stringify(disposition)};
fs.writeFileSync(p, JSON.stringify(entries));
`;

const hookAppendEntry = (entry) => `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
entries.push(${JSON.stringify(entry)});
fs.writeFileSync(p, JSON.stringify(entries));
`;

// EXPECTED STATE: GREEN today (the frozen consume-snapshot property, in v2
// clothing).
// PLACED FIRST and it must pass for the OPPOSITE reason to P3a: the hook rewrites
// the ledger mid-commit here too, but the target stays ACTIVE — so it MUST be
// consumed. Without this control, P3a's "the entry survived" verdict has three
// possible causes: the discharge was honored (the pin), the CLI never consumes a
// v2 entry at all, or ANY mid-commit rewrite makes the write-back give up.
// SABOTAGE: skip the consume write-back whenever the ledger changed during the
// commit -> this control's `after` still holds the target -> red, while P3a
// stays green. That result pair is exactly how "fail-safe by never writing" is
// distinguished from "honors the discharge".
test('discharge-hardening P3-0 (CONTROL, first): a mid-commit ledger rewrite that leaves the target ACTIVE still consumes it — only the hook-appended bystander survives', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const hookEntry = v2({
      entry_id: BYSTANDER_ID,
      agent_type: 'reviewer-bystander',
      files: ['src/base.mjs'],
      base_sha: head,
      at: '2026-08-31T09:00:00.000Z',
    });
    installPreCommitHook(dir, hookAppendEntry(hookEntry));

    writeLedger(dir, [
      v2({
        entry_id: TARGET_ID,
        agent_type: 'reviewer-security',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
        base_sha: head,
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P3-0 control: hook appends, target stays active']);
    assert.equal(r.code, 0, `the commit must land — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-security'], 'the active receipt is stamped');
    assert.deepEqual(
      readLedger(dir),
      [hookEntry],
      'the ACTIVE target is consumed and the hook-appended entry survives — a mid-commit rewrite does not, by itself, protect an entry'
    );
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if the write-back removes the spent entry by
// identity without re-reading its status — `readLedger(dir)` comes back `[]` and
// the length-1 / deepEqual assertions fire. If instead the implementation
// consumes BEFORE committing, the fixture hook exits 1, the commit aborts, and
// the FIRST assertion (`r.code === 0`) fires with the hook's own message naming
// the cause.
// SABOTAGE (the pin's own guard): write back the pre-commit snapshot minus the
// spent entries (or filter by entry_id against the snapshot) -> the discharged
// entry is destroyed -> red, while P3-0 stays green.
// SECOND SABOTAGE: honor the discharge by ABORTING the commit instead (refuse
// once the ledger changed) -> the exit-0 and trailer assertions go red. The
// commit MUST land: the stamping decision was made from a snapshot in which the
// receipt was active and the trailer is already in the message; failing the
// commit at that point would leave a reviewed change uncommitted for a race the
// committer cannot see.
// WHICH GUARD CARRIES THE VERDICT: the `deepEqual(after, [expected])` line — not
// exit 0 (satisfiable by a run that stamped nothing) and not the trailer alone
// (satisfiable by a run that both stamped and destroyed the evidence).
test('discharge-hardening P3a: an entry DISCHARGED while `git commit` runs SURVIVES the consume write-back still discharged — and the commit itself still lands with its trailer', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    installPreCommitHook(dir, hookDischargeTarget(TARGET_ID, DISPOSITION));

    const seeded = v2({
      entry_id: TARGET_ID,
      agent_type: 'reviewer-security',
      files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
      base_sha: head,
      at: '2026-08-31T09:00:00.000Z',
    });
    writeLedger(dir, [seeded]);
    const expected = { ...seeded, status: 'discharged', disposition: DISPOSITION };

    const r = runCommitReviewed(dir, ['-m', 'P3a discharge lands mid-commit']);
    assert.equal(
      r.code,
      0,
      `the commit must still land — the stamping decision was taken from a snapshot in which the receipt was active — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir, newSha), ['reviewer-security'], 'and carries its Reviewed-By-Agent trailer');

    const after = readLedger(dir);
    assert.equal(
      after.length,
      1,
      `the entry discharged mid-commit is NOT destroyed by the consume write — §3 promises durable preservation and forbids silent deletion — got ${JSON.stringify(after)}`
    );
    assert.deepEqual(
      after,
      [expected],
      'and it survives exactly as the discharge left it: status discharged, disposition intact, every evidence field preserved'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P4 — AN UNAUTHENTICATED `status:'discharged'` MARKER.
//
// §3: v1 entries are "NEVER migrated in place — readers use one compatibility
// adapter (missing schema_version = legacy roster receipt; missing status =
// active...)"; and for v2, discharge "sets status:'discharged' + disposition
// {reason, at, head_sha, classifier_version, class, underlying facts}".
//
// THE DEFECT, in two directions. A v1 receipt has NO lifecycle at all, so a bare
// `status:'discharged'` field on one is not a lifecycle state — treating it as
// one lets a single agent-written key silently retire evidence the adapter says
// is active. And a v2 entry carrying `status:'discharged'` with NO disposition
// was not produced by the discharge verb: it is malformed or hand-written. The
// adjudicated direction for that shape (launching brief, this fix round) is
// FAIL TOWARD NOT SPENDING — but DISCLOSED, never silently skipped, because a
// silent skip is how review evidence disappears with no reader ever knowing.
// EITHER-READING IS EXPLICITLY NOT ALLOWED HERE: both directions are asserted
// strictly.
// ===========================================================================

const WELL_FORMED_DISPOSITION = {
  reason: 'the session that produced it ended',
  at: isoAgo(30_000),
  head_sha: 'a'.repeat(40),
  classifier_version: 1,
  class: 'foreign-session',
};

// EXPECTED STATE: GREEN today for the exclusion half (the frozen D4 pins it);
// the NO-DISCLOSURE half is new.
// PLACED FIRST: P4b's verdict ("excluded AND disclosed") has two possible
// causes — the missing disposition was detected, or EVERY discharged entry gets
// announced. This control is P4b's fixture with a COMPLETE disposition, so it
// must pass for the opposite reason: excluded, and NOT announced as malformed.
// SABOTAGE: print the unauthenticated-discharge disclosure for every discharged
// entry -> the doesNotMatch assertion goes red here while P4b stays green. That
// pair is how "detected the malformation" is separated from "narrates
// everything".
// SECOND SABOTAGE: stop reading `status` -> the trailer deepEqual and the
// survival assertions go red here, and P4a's green becomes meaningless — which
// is why the two pins are read together.
test('discharge-hardening P4-0 (CONTROL, first): a WELL-FORMED discharged v2 receipt is excluded from spending, survives intact, and is NOT reported as malformed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const discharged = v2({
      entry_id: TARGET_ID,
      agent_type: 'reviewer-security',
      files: ['src/laneA.mjs'],
      blobs,
      base_sha: head,
      status: 'discharged',
      disposition: WELL_FORMED_DISPOSITION,
    });
    writeLedger(dir, [
      discharged,
      v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P4-0 control: well-formed discharge']);
    assert.equal(r.code, 0, `an active receipt covers the diff, so the commit lands — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the active receipt stamps');
    assert.deepEqual(readLedger(dir), [discharged], 'the discharged receipt survives byte-identical');
    assert.doesNotMatch(
      r.stderr,
      /unauthenticated|unauthentic|malformed|unverified|no disposition|missing disposition/i,
      `a properly discharged receipt is NOT reported as an unauthenticated or malformed discharge — stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if the spending filter tests `status !== 'active'`
// (or `status === 'discharged'`) BEFORE asking which schema version it is
// looking at: the v1 receipt is then skipped, no receipt covers the staged diff,
// and the run refuses — so the FIRST assertion (`r.code === 0`) fires, followed
// by the trailer deepEqual. GREEN today only if the adapter already scopes
// lifecycle to v2, in which case this is a regression guard — reported as such,
// not assumed.
// SABOTAGE: read `entry.status` before branching on `schema_version` -> the v1
// receipt is excluded -> red. §3's adapter is explicit that a v1 entry's lifecycle
// is not expressible: "missing schema_version = legacy roster receipt", and
// nothing in a v1 receipt authenticates a status field, so honoring one hands
// any ledger writer a one-key retirement of somebody else's review evidence.
// FIXTURE NOTE: the receipt is otherwise ORDINARY and fully spendable — recent,
// current session, current branch, matching blobs for the staged path — so the
// only thing that could make it unspendable is the bare status field.
test('discharge-hardening P4a: a V1 receipt carrying a bare status:"discharged" extra field STILL SPENDS — a v1 entry has no lifecycle, so an unauthenticated marker cannot retire it', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const at = isoAgo(60_000);
    const legacy = {
      agent_type: 'reviewer-security',
      files: ['src/laneA.mjs'],
      at,
      session_id: SESSION,
      branch: 'main',
      base_sha: head,
      status: 'discharged', // a bare extra field on a schema that has no lifecycle
      reviewed_state: { blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, completed_at: at },
    };
    assert.ok(!('schema_version' in legacy), 'fixture guard: this is a v1 entry — no schema_version at all');
    writeLedger(dir, [legacy]);

    const r = runCommitReviewed(dir, ['-m', 'P4a v1 with a bare discharged marker']);
    assert.equal(
      r.code,
      0,
      `a v1 receipt is read through the compatibility adapter, which has no lifecycle to read — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-security'], 'the v1 receipt is stamped exactly as an ordinary legacy receipt');
    assert.deepEqual(readLedger(dir), [], 'and consumed exactly as an ordinary legacy receipt');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today on the DISCLOSURE assertions if the filter drops
// non-active v2 entries silently: exit 0 and the trailer/survival assertions
// pass, and the two stderr `match` assertions fire. RED on the survival
// assertions instead if a malformed v2 entry is treated as unreadable and
// dropped from the write-back.
// SABOTAGE (the disclosure half): filter with `status === 'active'` and say
// nothing -> the /discharg/i and malformed-word assertions go red while
// everything else stays green. A silent skip means a reviewer's evidence stops
// counting with no line anywhere saying so — P5 (fail loud, never silent).
// SABOTAGE (the not-spending half): require a valid disposition before honoring
// the discharged status, i.e. treat an unauthenticated marker as ACTIVE -> the
// trailer deepEqual goes red (two trailers) and the survival deepEqual goes red
// (consumed). NOTE the deliberate asymmetry with P4a and why it is NOT a
// contradiction: a v1 entry has no lifecycle field to authenticate, while a v2
// entry's `status` IS its lifecycle field — so a v2 marker is honored (fail
// toward not spending) and merely doubted out loud, whereas a v1 marker is not a
// lifecycle statement at all.
test('discharge-hardening P4b: a v2 entry with status:"discharged" but NO disposition is still EXCLUDED from spending — and the unauthenticated discharge is DISCLOSED on stderr, never silently skipped', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const unauthenticated = v2({
      entry_id: TARGET_ID,
      agent_type: 'reviewer-security',
      files: ['src/laneA.mjs'],
      blobs,
      base_sha: head,
      status: 'discharged',
      disposition: null, // never produced by the discharge verb
    });
    writeLedger(dir, [
      unauthenticated,
      v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P4b unauthenticated discharged marker']);
    assert.equal(r.code, 0, `the active receipt covers the diff, so the commit lands — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(
      reviewedByTrailers(dir),
      ['reviewer-correctness'],
      'a discharged marker is honored toward NOT spending, even unauthenticated — it never earns a trailer'
    );
    assert.deepEqual(readLedger(dir), [unauthenticated], 'and the entry is preserved, not consumed and not rewritten');
    assert.match(
      r.stderr,
      /discharg/i,
      `the skip is DISCLOSED — a receipt that stops counting must say so somewhere a human reads — stderr=${flat(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /unauthenticated|unauthentic|malformed|unverified|no disposition|missing disposition|without a disposition|incomplete/i,
      `and the disclosure says WHY it is doubted — the discharge carries no disposition, so nothing authenticates it — stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P5 — DECLARED PATHS ARE COMPARED LITERALLY, NEVER AS PATHSPECS.
//
// §3: no-live applies only when "git conclusively compares EVERY declared path
// (untracked and deletions checked explicitly)".
//
// THE DEFECT: a declared path handed to git as a PATHSPEC is glob-expanded.
// `src/foo[1].mjs` is a character class matching `src/foo1.mjs` — so the literal
// file is never compared (git reports the pathspec matched nothing) while a
// DIFFERENT, unreviewed file is. Both outcomes are wrong in opposite directions:
// the declared path's real state is never established, and an unrelated file's
// state decides the verdict. `--` plus `:(literal)` (or a plain
// tree-vs-worktree blob comparison) is the fix; a filename with brackets is
// legal on every platform Sterling supports.
// ===========================================================================

const BRACKET = 'src/foo[1].mjs';
const DECOY = 'src/foo1.mjs'; // what the pathspec GLOB would match instead

// EXPECTED STATE: RED today if the declared path is passed as a pathspec: the
// bracket file's real (modified) state is never compared, the classifier finds
// nothing live and DISCHARGES — so the FIRST assertion (`r.code !== 0`) fires.
// (If instead git errors on the unmatched pathspec, this arm may pass today for
// the WRONG reason — which is exactly what P5a separates.)
// PLACED FIRST as the family's control: without it, P5a's success is satisfied by
// a classifier that SKIPS any path it cannot resolve, which is the most likely
// shape of the defect and would otherwise read as a clean pass.
// SABOTAGE: skip declared paths git cannot match -> this control discharges live
// territory -> red, while P5a stays green.
test('discharge-hardening P5-0 (CONTROL, first): a declared path named "src/foo[1].mjs" that is MODIFIED refuses no-live — the bracket name is really compared, not skipped', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, BRACKET, CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances — the P1 ancestor guard is satisfied
    stageChange(dir, BRACKET, OTHER); // genuinely live
    assert.equal(readFileSync(join(dir, BRACKET), 'utf8'), OTHER, 'fixture guard: the bracket-named file really holds the new bytes');
    assert.ok(porcelain(dir).includes('foo[1]'), `fixture guard: git really reports the bracket file as changed — porcelain=${flat(porcelain(dir))}`);

    writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: [BRACKET], base_sha: baseSha })]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'a bracket-named path that is still live must not classify as no-live',
    ]);
    assert.notEqual(r.code, 0, `live territory is never dischargeable as no-live, whatever the filename looks like — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.equal(readLedger(dir)[0].status, 'active', 'and the receipt stays spendable');
    assert.match(r.stderr, /foo/, `the refusal names the still-live path — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if the declared path is glob-expanded. In the
// 'no-decoy' arm the pathspec matches nothing, so an "unknown" verdict refuses
// and `r.code === 0` fires; in the 'decoy-live' arm the glob resolves to the
// MODIFIED src/foo1.mjs, so the classifier sees live territory and the same
// assertion fires. Both arms therefore red for the same root cause, from
// opposite directions.
// SABOTAGE: hand the declared path to git without `--`/`:(literal)` (e.g.
// `git diff <base> -- <path>` with the raw value) -> both arms red.
// SECOND SABOTAGE: require a globally clean worktree instead of comparing the
// DECLARED paths -> the 'decoy-live' arm alone goes red (its undeclared decoy is
// dirty), which is the diagnosable signature of that over-reach rather than of a
// pathspec bug. §3 scopes the comparison to "EVERY declared path", not to the
// whole tree.
// TWO ARMS, load-bearing: 'no-decoy' has a fully CLEAN tree, so its green cannot
// be explained by any cleanliness rule; 'decoy-live' is the sharp one, where a
// glob silently substitutes an unreviewed file's state for the declared path's.
test('discharge-hardening P5a: a declared path named "src/foo[1].mjs" at its base state SUCCEEDS as no-live — with and without a src/foo1.mjs decoy that a glob would match instead', { skip: GIT_SKIP }, () => {
  for (const arm of ['no-decoy', 'decoy-live']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, BRACKET, CODE);
      if (arm === 'decoy-live') commitFile(dir, DECOY, CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances — P1's ancestor guard satisfied
      if (arm === 'decoy-live') {
        stageChange(dir, DECOY, OTHER); // the glob's target is LIVE; it is NOT declared territory
        assert.ok(porcelain(dir).includes('foo1.mjs'), `fixture guard: the decoy is genuinely live — porcelain=${flat(porcelain(dir))}`);
      } else {
        assert.equal(porcelain(dir), '', 'fixture guard: this arm has a completely clean tree');
        assert.ok(!existsSync(join(dir, DECOY)), 'fixture guard: no decoy exists, so a glob would match nothing at all');
      }
      assert.equal(readFileSync(join(dir, BRACKET), 'utf8'), CODE, 'fixture guard: the declared bracket path holds its base bytes');
      assert.ok(!porcelain(dir).includes('foo[1]'), `fixture guard: git reports the declared path as unchanged — porcelain=${flat(porcelain(dir))}`);

      writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: [BRACKET], base_sha: baseSha })]);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'no-live-territory', '--reason', `${arm}: the declared bracket-named path is back at base`,
      ]);
      assert.equal(
        r.code,
        0,
        `[${arm}] the declared path is compared LITERALLY — a filename containing pathspec metacharacters is a filename, not a glob — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
      assert.equal(entry.status, 'discharged', `[${arm}] the entry is discharged`);
      assert.equal(entry.disposition.class, 'no-live-territory', `[${arm}] under the no-live class`);
      assert.deepEqual(entry.territory.files, [BRACKET], `[${arm}] with the declared path preserved verbatim, brackets and all`);
      assertNoLedgerResidue(dir, `P5a/${arm}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// P6 — A PRESENT FILE IS LIVE TERRITORY, IGNORED OR NOT.
//
// §3: no-live requires that "git conclusively compares EVERY declared path
// (untracked and deletions checked explicitly), every path returned to base
// state in the mode-appropriate view; any ambiguity yields 'unknown', never
// no-live."
//
// THE DEFECT: an IGNORED untracked file is invisible to `git status --porcelain`
// and to `git diff`, so a classifier built on either concludes "this path is
// absent, same as base" — while the reviewed content is sitting on disk, will be
// force-added or un-ignored later, and is unambiguously live. `.gitignore` is a
// staging convenience; it is not evidence that the reviewed work is gone. The
// plain-untracked arm beside it is the same question with the ignore removed, so
// a guard that covers only one of the two is visible.
// ===========================================================================

const IGNORED_PATH = 'src/generated.mjs';
const LOOSE_PATH = 'src/loose.mjs';

// Seeds a repo whose .gitignore ignores IGNORED_PATH, with a TRACKED at-base
// file, and with HEAD advanced past base_sha (so P1's ancestor guard is
// satisfied and no arm in this family can refuse for P1's reason).
function makeIgnoreRepo() {
  const { dir, cleanup } = makeRepo();
  commitFile(dir, 'src/tracked.mjs', CODE);
  writeFileSync(join(dir, '.gitignore'), `.sterling/\n${IGNORED_PATH}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'ignore the generated path']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances
  return { dir, cleanup, baseSha };
}

// EXPECTED STATE: GREEN today AND after the fix.
// PLACED FIRST and passing for the OPPOSITE reason to P6a: the ignored file
// EXISTS here too, but it is not DECLARED territory — the declared path is a
// tracked file at its base state. So a green P6a cannot be explained by "an
// ignored file anywhere in the tree refuses everything", and a green here cannot
// be explained by "an empty porcelain always succeeds" once P6a is read beside
// it.
// SABOTAGE: refuse whenever any ignored file exists in the tree -> red here,
// green in P6a — the over-reach this control forbids.
test('discharge-hardening P6-0 (CONTROL, first): an ignored file that exists but is NOT declared territory does not block a no-live discharge of a tracked at-base path', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baseSha } = makeIgnoreRepo();
  try {
    writeFileSync(join(dir, IGNORED_PATH), CODE); // present on disk, ignored, UNDECLARED
    assert.equal(porcelain(dir), '', 'fixture guard: the ignored file is invisible to porcelain, so the tree reads clean');

    writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/tracked.mjs'], base_sha: baseSha })]);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'the declared tracked path is at its base state',
    ]);
    assert.equal(r.code, 0, `only DECLARED paths are classified — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir)[0].status, 'discharged', 'the entry is discharged');
    assertNoLedgerResidue(dir, 'P6-0');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: the 'ignored' arm is RED today if the classifier reads
// `git status --porcelain` / `git diff` without `--ignored` or a filesystem
// check: the ignored file is invisible, the path reads as absent-like-base, the
// discharge succeeds and the FIRST assertion (`r.code !== 0`) fires. The
// 'plain-untracked' arm is likely GREEN today (§3 already says untracked paths
// are checked explicitly) and is here as the regression half of the pair —
// reported as such, not assumed.
// SABOTAGE (the pin's guard): drop the ignored-file check (or the direct
// existsSync/`git ls-files --others --ignored` probe) -> the 'ignored' arm
// discharges -> red, while 'plain-untracked' stays green. Exactly one arm red is
// the signature of an ignore-blind classifier; both arms red means untracked
// paths are not being checked at all, which is a different defect and a
// different fix.
// WHY IT MATTERS: the declared file is ABSENT from the base tree and PRESENT on
// disk — the reviewed addition is right there, one `git add -f` from being
// committed. Discharging it destroys the review requirement for content that
// still exists.
test('discharge-hardening P6a: a declared path that EXISTS as an untracked file refuses no-live — including when .gitignore hides it from git status', { skip: GIT_SKIP }, () => {
  for (const arm of ['plain-untracked', 'ignored']) {
    const { dir, cleanup, baseSha } = makeIgnoreRepo();
    try {
      const declared = arm === 'ignored' ? IGNORED_PATH : LOOSE_PATH;
      writeFileSync(join(dir, declared), CODE); // the reviewed content, present on disk, never committed
      if (arm === 'ignored') {
        assert.equal(porcelain(dir), '', 'fixture guard: the ignored arm reads CLEAN through porcelain — that is the whole defect');
      } else {
        assert.ok(porcelain(dir).includes('loose.mjs'), `fixture guard: the plain-untracked arm is visible to porcelain — porcelain=${flat(porcelain(dir))}`);
      }
      assert.throws(
        () => git(dir, ['rev-parse', `${baseSha}:${declared}`]),
        `fixture guard: [${arm}] the declared path is genuinely ABSENT from the base tree`
      );

      writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: [declared], base_sha: baseSha })]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'no-live-territory', '--reason', `${arm}: asserted no-live while the reviewed file sits on disk`,
      ]);
      assert.notEqual(
        r.code,
        0,
        `[${arm}] a declared path that EXISTS is live territory — .gitignore hides it from git, it does not make the reviewed work gone — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      assert.equal(readLedger(dir)[0].status, 'active', `[${arm}] and the receipt stays spendable`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm}] a refusal, never a crash — stderr=${flat(r.stderr)}`);
      assert.match(
        r.stderr,
        /live|untracked|ignor|present|exists|differ|base|ambig|unknown|classif/i,
        `[${arm}] the refusal is about the classification — stderr=${flat(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// P7 — A FOREIGN, FRESH LOCK IS NEVER STOLEN (final review's LOW-1).
//
// §3: "atomic locked replace". The rejected-alternatives of the register lock
// decision (register-writers-cooperating-lock) record that the LEDGER's own
// fallback is "write anyway, disclose" on an unlocked timeout — so §3 does not
// fix which way this goes, and this pin does not invent one.
//
// THE DEFECT CLASS: a lock whose holder is ANOTHER live process must not be
// broken by the waiter. Stealing a fresh foreign lock reintroduces exactly the
// concurrent-write race the ledger-bytes digest and the locked replace exist to
// close — and the theft is invisible afterwards, because the stolen lock
// directory is simply gone.
//
// WHAT IS PINNED (the invariant that holds under BOTH readings):
//   1. the run TERMINATES (a lock wait is bounded);
//   2. the foreign lock directory and its owner token SURVIVE byte-identical —
//      never removed, never rewritten;
//   3. the contention is DISCLOSED on stderr (P5: fail loud, never silent),
//      whether the CLI then refuses or degrades to writing anyway;
//   4. the ledger is left in ONE of the two coherent states, never a third.
// The exit code is deliberately NOT asserted — that is the open half.
//
// TWO LOCK PATHS ARE PLANTED because the lock's filename is not something this
// file may read (H4). If the CLI uses neither name, nothing contends, the
// discharge succeeds silently, and the DISCLOSURE assertion goes red — which
// reads as "the assumed lock path is wrong", an adjudication for the conductor,
// not a defect. Whichever name is real, the survival assertion covers it.
// TIMING: the spawn timeout is deliberately generous (60s) so a bounded-but-slow
// wait is not mistaken for a hang; if the CLI's lock wait exceeds it, the
// TERMINATION assertion fires and names an unbounded wait as the finding.
// ===========================================================================

const LOCK_NAMES = ['review-ledger.json.lock', 'review-ledger.lock'];
const OWNER_TOKEN = JSON.stringify({ pid: 999_999, host: 'another-machine', at: '2026-08-31T09:00:00.000Z' });

function runLedgerSlow(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// EXPECTED STATE: RED today if the lock is broken on contention (the survival
// assertions fire), or if the contention is handled silently (the disclosure
// assertion fires). GREEN once a fresh foreign lock is waited on and the outcome
// is disclosed.
// SABOTAGE (the theft half): rmSync the lock directory before acquiring it, or
// treat any existing lock as stale without checking freshness -> the
// `existsSync` / token-bytes assertions go red.
// SABOTAGE (the silence half): fall back to writing anyway with nothing on
// stderr -> the disclosure assertion goes red while everything else stays green.
// That is the half a green suite cannot otherwise see: a silent degrade looks
// exactly like a clean success.
// NOT A CONTROL FAMILY: every OTHER discharge pin in this file runs with NO lock
// planted and expects a clean verdict, so the whole file is this pin's control —
// if planting the lock changed nothing, P1-0/P2-0/P5a/P6-0 would be green here
// too and the disclosure assertion is what separates them.
test('discharge-hardening P7 (LOW-1): a FRESH, FOREIGN review-ledger lock is never stolen — the discharge waits, discloses the contention, and leaves the lock directory and its owner token untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }),
    ]);
    const before = readLedgerRaw(dir);
    const digest = ledgerDigest(dir);

    // A lock held by SOMEONE ELSE, right now: a directory (the mkdir-lock idiom)
    // carrying an owner token, with an mtime of NOW so no staleness rule can
    // legitimately reclaim it.
    const now = new Date();
    const planted = LOCK_NAMES.map((name) => {
      const lockDir = join(dir, '.sterling', name);
      mkdirSync(lockDir, { recursive: true });
      const tokenPath = join(lockDir, 'owner.json');
      writeFileSync(tokenPath, OWNER_TOKEN);
      utimesSync(tokenPath, now, now);
      utimesSync(lockDir, now, now);
      assert.ok(statSync(lockDir).isDirectory(), `fixture guard: ${name} is a directory lock held by another process`);
      return { name, lockDir, tokenPath };
    });

    const r = runLedgerSlow(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', digest,
      '--class', 'foreign-session', '--reason', 'contending with a lock another process is holding',
    ]);

    assert.notEqual(
      r.code,
      null,
      `the lock wait must be BOUNDED — the process still had not exited after 60s (signal=${r.signal}) — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );

    for (const p of planted) {
      assert.ok(
        existsSync(p.lockDir),
        `${p.name}: a FRESH lock held by another process is never removed — breaking it reopens the concurrent-write race the locked replace exists to close`
      );
      assert.equal(
        readFileSync(p.tokenPath, 'utf8'),
        OWNER_TOKEN,
        `${p.name}: the owner token is untouched — the waiter never rewrites another holder's claim`
      );
    }

    assert.match(
      r.stderr,
      /lock|contention|contend|busy|held|timeout|timed out|another process|concurrent/i,
      `the contention is DISCLOSED whichever way it resolves — a silent degrade is indistinguishable from a clean success — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a handled outcome, never a crash — stderr=${flat(r.stderr)}`);

    // ONE of the two coherent states, never a third. The exit code is the open
    // half of §3 (refuse-on-timeout vs the ledger's write-anyway-and-disclose
    // fallback), so it is not asserted — the STATE is.
    const after = readLedger(dir);
    assert.ok(Array.isArray(after) && after.length === 1, `the ledger is intact — raw=${flat(readLedgerRaw(dir))}`);
    if (r.code === 0) {
      assert.equal(after[0].status, 'discharged', `a degraded write-anyway must still produce the discharge it reported — got ${JSON.stringify(after[0].status)}`);
      assert.ok(after[0].disposition && after[0].disposition.reason, 'with its disposition recorded, exactly as an uncontended discharge');
    } else {
      assert.equal(readLedgerRaw(dir), before, 'a refusal under contention writes nothing at all');
      assert.equal(after[0].status, 'active', 'and the receipt stays spendable');
    }
  } finally {
    cleanup();
  }
});
