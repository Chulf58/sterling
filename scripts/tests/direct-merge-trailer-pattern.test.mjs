// DIRECT-MERGE RECEIPT GATE — ROSTER-PATTERN VALIDATION AND THE ADDITIVE
// Review-Receipt BINDING (R1 PIN RE-CUT).
//
// AUTHORITY: contract sheet §3.3 (direct-merge's trailer section) + §1.3 (the
// trailer owner module) + the rebuild decision's "direct-merge REJECTS a
// Review-Receipt trailer whose receipt is absent, not consumed for that commit,
// or blob-inconsistent with the commit tree — this is what makes a post-commit
// ledger failure safe rather than a mergeable unbound attestation."
//
// TWO RULES, IN ORDER:
//   KEPT — a code-touching commit needs at least one Reviewed-By-Agent value
//     matching the roster reviewer pattern (or a visible waiver). Unrelated or
//     malformed values do not satisfy it.
//   ADDITIVE — for every `Review-Receipt: <id>` trailer on a commit in the merge
//     range, the receipt must exist, be `consumed` with consumption.commit_sha
//     equal to THAT commit, and its blobs must equal that commit's tree for every
//     covered path; otherwise the merge REFUSES naming
//     [superseder_commit_receipt_unbound] / [superseder_commit_blob_mismatch]
//     (the same codes and the same verifier as review-ledger's commit form —
//     imported, never copied). A commit with NO Review-Receipt trailer is judged
//     by the roster rule alone, so pre-rebuild history still merges.
//
// The harness is the one the two sibling receipt-gate suites use (temp repo,
// main + feature branch, real commits with real git trailers, the full CLI over
// its --target surface), reproduced here so this file stays independently
// runnable.
//
// RETIRED IN THIS RE-CUT (each with its reason):
//   RETIRED: T2's 'External-Review: codex' and 'codex-cli' arms — duplicate permutations of the same code and the same guard as the 'yes' arm; the External-Review key gets its own pin (R1-C89) and four arms remain, each pinning a DIFFERENT property of the pattern.
//   RETIRED: the header's ambiguity register (a)-(d) and the "assumed pattern" block — the pattern now lives in one owner module and is pinned behaviourally in review-trailers-owner.test.mjs.
//   RETIRED: S-ROSTER's byte-identical comparison of two regex LITERALS (lifted from the parked pin source) — converted to R1-C90: both consumers IMPORT ROSTER_TRAILER_VALUE from scripts/lib/review-trailers.mjs and neither declares its own.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const token = (c) => new RegExp('\\[' + c + '\\]');
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// A git project with a store but NO active run, plus a .sterling/config.json
// declaring this repo's registered toolchain globs (the **/*.mjs / **/*.ts pair
// the CODE-TOUCHING definition keys on).
function makeReceiptGateRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-trailer-pattern-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] })
  );
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// `trailerBlock` is passed as a SEPARATE `-m` paragraph (subject, blank line,
// trailer lines) — the shape a real git trailer needs. It may hold SEVERAL lines,
// which is how a commit carries two Reviewed-By-Agent values.
function writeAndCommit(dir, { path: relPath, content, subject, trailerBlock }) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
  git(dir, trailerBlock ? ['commit', '-m', subject, '-m', trailerBlock] : ['commit', '-m', subject]);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  return { sha, short: git(dir, ['rev-parse', '--short', sha]), subject };
}

function trailerValues(dir, key, sha = 'HEAD') {
  return git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]).split('\n').filter((l) => l.trim() !== '');
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
}

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));

const RECEIPT_ID = 'b0000000-0000-4000-8000-00000000000a';

// A consumed ReceiptV2 bound to `sha` (contract sheet §1.2).
function consumedReceipt({ entry_id = RECEIPT_ID, files, blobs, sha, at = isoAgo(60_000) }) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status: 'consumed',
    started_at: at,
    finished_at: at,
    reviewer: { agent_type: 'reviewer-correctness', model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: 'a-session', branch: 'feat/bound', base_sha: null, agent_id: 'agent-0001' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    consumption: { commit_sha: sha, consumed_at: at, nonce: 'n-1' },
    disposition: null,
  };
}

// ===========================================================================
// R1-C85 / R1-C86 — THE ROSTER RULE'S CONTROLS, PLACED FIRST.
// Every refusal pin below would be satisfied by a gate that refuses EVERY branch
// — including one broken by an over-anchored pattern no real value can match.
// ===========================================================================

// SABOTAGE: anchor the pattern so a bare roster value cannot match (requiring a
// parenthetical model suffix, or a space) -> this goes red. A bare value is
// exactly what commit-reviewed stamps, so an over-anchored pattern would refuse
// every machine-stamped commit in the repo.
test('R1-C85 (CONTROL, first): a bare roster value (reviewer-correctness) satisfies the receipt gate and the branch merges', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/bare-roster']);
    const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: 'add feature, bare roster trailer', trailerBlock: 'Reviewed-By-Agent: reviewer-correctness' });
    assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), ['reviewer-correctness'], 'fixture guard: git parses exactly one bare roster trailer value');

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a value matching the roster reviewer pattern satisfies the gate — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/bare-roster');
    assert.equal(out.merged_into, 'main');
  } finally {
    cleanup();
  }
});

// SABOTAGE: implement the check as a WHOLE-VALUE match
// (/^reviewer-[A-Za-z0-9_-]+$/) -> this goes red, and so does every hand-written
// receipt in this repo's history. A red here is the earliest signal that the
// pattern was anchored too hard.
test('R1-C86 (COMPAT CONTROL): a DECORATED roster value (reviewer-correctness (opus) — findings adjudicated) still satisfies the gate', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/decorated-roster']);
    writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: 'add feature, decorated roster trailer', trailerBlock: 'Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated' });

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `the decorated shape real receipts carry must keep passing — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/decorated-roster');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C87 — MALFORMED / UNRELATED VALUES DO NOT SATISFY THE GATE.
// ===========================================================================

// SABOTAGE (the defect the rule was written for): test the value with a
// non-empty check (`value.trim() !== ''`) instead of the roster pattern -> all
// four arms merge and go red. `Reviewed-By-Agent: yes` is a receipt naming
// nobody, and the merge gate is the ONLY mechanism standing between an unreviewed
// diff and main.
// FOUR ARMS, each a DIFFERENT property of the pattern, so no arm can witness
// another's absence:
//   'yes'                    — a nonsense affirmation (the measured defect);
//   'reviewer bob'           — a human name starting with the word "reviewer",
//                              which a substring test would accept;
//   'reviewer-'              — the QUANTIFIER: `+` -> `*` makes a bare prefix
//                              naming NOBODY pass, and no other arm is a prefix;
//   'note: reviewer-security'— the LEADING ANCHOR: drop `^` and any prose
//                              mentioning a reviewer becomes a receipt.
// CAVEAT ON THE 'reviewer-' ARM: the refusal's own remedy text may contain the
// substring `reviewer-`, so for that arm the load-bearing assertions are the
// REFUSAL and main not moving, not the value-naming match.
test('R1-C87: a commit whose ONLY Reviewed-By-Agent value is malformed or unrelated is treated as trailer-less — the gate refuses, names the offending commit, and main never moves', () => {
  for (const value of ['yes', 'reviewer bob', 'reviewer-', 'note: reviewer-security']) {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/malformed']);
      const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: 'add feature with a malformed receipt value', trailerBlock: `Reviewed-By-Agent: ${value}` });
      assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), [value], `[${value}] fixture guard: git parses exactly this one value`);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      assert.notEqual(r.status, 0, `[${value}] a value matching no roster reviewer is NO RECEIPT AT ALL — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `[${value}] the refusal names the offending commit by short sha — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /Reviewed-By-Agent/, `[${value}] and names the trailer it requires — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /--waive-reviews/, `[${value}] and the waiver remedy — stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${value}] a refused merge never moves the base branch HEAD`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: implement the rule as "EVERY value must match" instead of "AT LEAST
// ONE matches" -> the merge refuses and the status assertion goes red. A commit
// legitimately carrying both a roster receipt and a hand-written note would then
// be blocked by the gate meant to REQUIRE the receipt.
test('R1-C88: a commit carrying one MALFORMED and one VALID Reviewed-By-Agent value passes on the valid one', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/mixed-values']);
    const c = writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature with one junk and one real receipt value',
      trailerBlock: 'Reviewed-By-Agent: yes\nReviewed-By-Agent: reviewer-security',
    });
    assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), ['yes', 'reviewer-security'], 'fixture guard: git parses BOTH values on this one commit');

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `AT LEAST ONE matching value is the rule — a junk value alongside a real one must not block the merge — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/mixed-values', 'the branch really merged');
  } finally {
    cleanup();
  }
});

// SABOTAGE: read the receipt trailer by a loose key match (any key matching
// /review/i, or `%(trailers:valueonly)` unkeyed) so an External-Review line
// satisfies the gate -> the status/HEAD assertions go red. That would let a
// conductor-attested consult discharge the mandatory independent-review
// requirement, which is the precise laundering the separate key prevents.
// ARM 2 IS THE CONTROL: the same External-Review trailer BESIDE a valid roster
// receipt merges, so arm 1's refusal is caused by the ABSENCE of a roster
// receipt, not by the PRESENCE of an External-Review trailer.
test('R1-C89: an External-Review: trailer ALONE never satisfies the Reviewed-By-Agent gate — and does not poison a commit that also carries a valid roster receipt', () => {
  const EXTERNAL = 'codex (gpt-5.2) thread 01a057ee round 2 — conductor-attested consult';

  {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/external-only']);
      const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: 'add feature reviewed only by an external consult', trailerBlock: `External-Review: ${EXTERNAL}` });
      assert.deepEqual(trailerValues(dir, 'External-Review', c.sha), [EXTERNAL], 'fixture guard: git parses the External-Review trailer');
      assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), [], 'fixture guard: and there is NO Reviewed-By-Agent trailer');

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      assert.notEqual(r.status, 0, `an external consult is evidence, not the mandatory roster review — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `the refusal names the offending commit — stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, 'and main never moved');
    } finally {
      cleanup();
    }
  }

  {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/external-plus-roster']);
      writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: 'add feature reviewed by roster AND an external consult', trailerBlock: `Reviewed-By-Agent: reviewer-security\nExternal-Review: ${EXTERNAL}` });

      const r = runDirectMerge(dir);
      assert.equal(r.status, 0, `CONTROL — an External-Review trailer must not BLOCK a properly-reviewed commit either — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/external-plus-roster');
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C90 — ONE OWNER, IMPORTED, NEVER RE-DECLARED.
// ===========================================================================

// THIS PIN REPLACES a source comparison of two regex LITERALS. The old shape
// could only notice drift AFTER both copies existed; this one forbids the second
// copy. The failure it guards is silent and one-directional: a looser pattern in
// the discharge verb retires receipts behind commits the merge gate itself would
// refuse.
// SABOTAGE: re-declare `const ROSTER_TRAILER_VALUE = /.../` inside either
// consumer -> the no-local-declaration assertion goes red naming the file.
// SABOTAGE (the import half): keep the import but stop using it (a local alias
// that shadows it) -> the import assertion still passes, so this pin is NOT the
// whole guard: R1-C85..R1-C89 and review-trailers-owner.test.mjs carry the
// behaviour. WHICH GUARD CARRIES THE VERDICT: this one pins SOURCE OF TRUTH, the
// behavioural pins carry correctness — both are needed and neither substitutes.
// CONTROL (non-vacuity): the owner module's own declaration must be found, so a
// changed extractor pattern reports itself instead of passing as "no copies".
test('R1-C90: scripts/direct-merge.mjs and scripts/review-ledger.mjs both IMPORT the trailer owner and neither declares its own ROSTER_TRAILER_VALUE', () => {
  const owner = readFileSync(join(root, 'scripts', 'lib', 'review-trailers.mjs'), 'utf8');
  const declaration = /ROSTER_TRAILER_VALUE\s*=\s*\//;
  assert.match(owner, declaration, 'CONTROL: the owner module declares the pattern — if this fails the extractor changed, not the consumers, and the assertions below would be vacuous');

  for (const rel of [['scripts', 'direct-merge.mjs'], ['scripts', 'review-ledger.mjs']]) {
    const name = rel.join('/');
    const src = readFileSync(join(root, ...rel), 'utf8');
    assert.doesNotMatch(
      src,
      declaration,
      `${name} declares its OWN roster pattern — the two spellings then drift silently and in one direction: the discharge verb retires receipts behind commits main would refuse`
    );
    assert.match(
      src,
      /from\s+['"][^'"]*lib\/review-trailers\.mjs['"]/,
      `${name} must IMPORT the trailer owner rather than re-implementing it — the whole justification of the commit form is that the merge gate would accept the same value`
    );
  }
});

// ===========================================================================
// R1-C91 — THE ADDITIVE Review-Receipt BINDING.
// A post-commit ledger failure must be caught HERE rather than merged as an
// unbound attestation: the trailer claims specific evidence, and the gate checks
// that the evidence exists, belongs to THIS commit, and covers THESE bytes.
// ===========================================================================

// FOUR ARMS. The two CONTROLS come first and must pass for OPPOSITE reasons:
// 'legacy-no-receipt-trailer' merges because the additive rule does not apply at
// all (pre-rebuild history must keep merging), and 'bound' merges because the
// rule applied and PASSED. Without both, the two refusals are satisfied by a gate
// that refuses whenever a ledger exists.
// SABOTAGE (the whole additive rule): ignore Review-Receipt trailers -> both
// refusing arms merge and go red.
// SABOTAGE (the binding half): check only that the receipt EXISTS -> the
// 'unbound' arm merges and goes red while 'blob-mismatch' stays refused. A
// receipt consumed by a DIFFERENT commit is evidence about that commit's bytes.
// SABOTAGE (the blob half): skip the commit-tree comparison -> the
// 'blob-mismatch' arm merges and goes red alone.
// SABOTAGE (the over-reach direction): apply the additive rule to commits with no
// Review-Receipt trailer -> the 'legacy-no-receipt-trailer' control goes red,
// which is how an over-broad fix is told apart from a correct one.
test('R1-C91: every Review-Receipt trailer in the merge range must BIND — a pre-rebuild roster-only commit still merges, a bound receipt merges, an unbound one is [superseder_commit_receipt_unbound] and a blob-inconsistent one is [superseder_commit_blob_mismatch]', () => {
  const arms = [
    { label: 'legacy-no-receipt-trailer', withReceiptTrailer: false, ledger: 'none', merges: true },
    { label: 'bound', withReceiptTrailer: true, ledger: 'bound', merges: true },
    { label: 'unbound', withReceiptTrailer: true, ledger: 'other-sha', merges: false, code: 'superseder_commit_receipt_unbound' },
    { label: 'blob-mismatch', withReceiptTrailer: true, ledger: 'wrong-blob', merges: false, code: 'superseder_commit_blob_mismatch' },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/bound']);
      const trailers = ['Reviewed-By-Agent: reviewer-correctness'];
      if (arm.withReceiptTrailer) trailers.push(`Review-Receipt: ${RECEIPT_ID}`);
      const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: `add feature (${arm.label})`, trailerBlock: trailers.join('\n') });
      const treeBlob = git(dir, ['rev-parse', `${c.sha}:src/feature.mjs`]);

      if (arm.ledger !== 'none') {
        const receipt = consumedReceipt({ files: ['src/feature.mjs'], blobs: { 'src/feature.mjs': treeBlob }, sha: c.sha });
        if (arm.ledger === 'other-sha') receipt.consumption.commit_sha = 'a'.repeat(40);
        if (arm.ledger === 'wrong-blob') receipt.content_evidence.blobs = { 'src/feature.mjs': 'c'.repeat(40) };
        writeLedger(dir, [receipt]);
      } else {
        writeLedger(dir, []);
      }

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm.merges) {
        assert.equal(r.status, 0, `[${arm.label}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/bound', `[${arm.label}] the branch really merged`);
      } else {
        assert.notEqual(r.status, 0, `[${arm.label}] an attestation that does not bind must not reach main — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, token(arm.code), `[${arm.label}] the refusal carries the SAME code as review-ledger's commit form — stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `[${arm.label}] and names the offending commit — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm.label}] main never moved`);
      }
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C93 — A VISIBLE Review-Bytes-Waiver IS THE ACCOUNTABLE OVERRIDE.
//
// The blob rule exists so a commit cannot claim a review of bytes nobody
// reviewed. The waiver does not weaken that: it makes the override VISIBLE in
// the commit message, auditable at exactly this gate, and attributable to the
// operator who typed it. A gate that ignores the waiver trailer forces the
// operator to route around the mechanism instead of through it — which is how a
// documented override becomes an undocumented one.
// ===========================================================================

// TWO ARMS, and the refusing one is the CONTROL: the SAME commit, the SAME
// mismatched receipt, differing only by the presence of the waiver trailer. So a
// green merge cannot be explained by "the blob rule is not enforced here" — that
// would redden the control — and a green refusal cannot be explained by "this
// gate refuses everything" — that would redden the waived arm.
// SABOTAGE (the one this pin exists for): ignore Review-Bytes-Waiver in the
// additive gate -> the waived arm refuses and its status/branch_merged assertions
// go red while the control stays green.
// SABOTAGE (the other direction, and the third arm's whole reason): treat the
// PRESENCE of any Review-Bytes-Waiver as a global override rather than a binding
// to the entry_id it names -> the 'waiver-names-another' arm merges and its
// code/main-unmoved assertions go red. A waiver is an attestation about ONE
// receipt's bytes; honouring it for a different receipt lets a legitimate waiver
// for a trivial file silently cover a mismatch on any other file in the same
// commit, which is the accountability the per-entry value exists to keep.
test('R1-C93: a Review-Receipt whose blobs differ from the commit tree MERGES when the commit carries a Review-Bytes-Waiver NAMING THAT RECEIPT — and refuses [superseder_commit_blob_mismatch] with no waiver, or a waiver naming another entry_id', () => {
  const OTHER_ENTRY_ID = 'b0000000-0000-4000-8000-00000000000f';
  for (const arm of ['waived', 'unwaived', 'waiver-names-another']) {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/waived-bytes']);
      const trailers = ['Reviewed-By-Agent: reviewer-correctness', `Review-Receipt: ${RECEIPT_ID}`];
      if (arm === 'waived') trailers.push(`Review-Bytes-Waiver: ${RECEIPT_ID}`);
      if (arm === 'waiver-names-another') trailers.push(`Review-Bytes-Waiver: ${OTHER_ENTRY_ID}`);
      const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: `add feature (${arm})`, trailerBlock: trailers.join('\n') });

      // Bound to THIS commit in every respect except the bytes: the receipt
      // reviewed something else, which is exactly what a waiver attests to.
      const receipt = consumedReceipt({ files: ['src/feature.mjs'], blobs: { 'src/feature.mjs': 'c'.repeat(40) }, sha: c.sha });
      writeLedger(dir, [receipt]);
      assert.notEqual(receipt.content_evidence.blobs['src/feature.mjs'], git(dir, ['rev-parse', `${c.sha}:src/feature.mjs`]), 'fixture guard: the receipt genuinely reviewed different bytes than the commit holds');

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm === 'waived') {
        assert.equal(
          r.status,
          0,
          `[${arm}] the override is VISIBLE in the commit message and attributable — a gate that ignores it forces the operator around the mechanism instead of through it — stdout=${r.stdout} stderr=${flat(r.stderr)}`
        );
        assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/waived-bytes', `[${arm}] the branch really merged`);
      } else {
        assert.notEqual(
          r.status,
          0,
          `[${arm}] ${arm === 'unwaived' ? 'CONTROL — without the waiver the same commit is a claim about bytes nobody reviewed' : 'a waiver naming a DIFFERENT entry_id attests to nothing about this receipt'} — stdout=${r.stdout} stderr=${flat(r.stderr)}`
        );
        assert.match(r.stderr, token('superseder_commit_blob_mismatch'), `[${arm}] and the refusal carries the blob code — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm}] main never moved`);
      }
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C92 — THE ADDITIVE GATE FAILS CLOSED ON AN UNREADABLE LEDGER.
//
// R1-C91 pins what the gate decides when it can READ the ledger. This pins what
// it does when it cannot. A trailer that claims specific evidence is a claim the
// gate cannot check with no ledger in front of it, and "cannot check" is not
// "checked and fine": skipping the gate on availability !== ok makes DELETING
// .sterling/review-ledger.json the cheapest way past the binding rule, which
// inverts the whole point of verifying the binding at the merge boundary.
// ===========================================================================

// THREE ARMS. The CONTROL comes last and must pass for the OPPOSITE reason: with
// NO Review-Receipt trailer anywhere in the range there is nothing to bind, so an
// absent ledger is simply not this rule's business and the roster rule alone
// merges the branch. Without it, the two refusals are satisfied by a gate that
// refuses whenever the ledger is missing — which would block every pre-rebuild
// branch and every consumer that has never spent a receipt.
// SABOTAGE (the one this pin exists for): skip the additive gate when
// readLedger's availability !== 'ok' -> both refusing arms MERGE and their
// status/main-unmoved assertions go red, while the control stays green.
// SABOTAGE (the disclosure half): refuse without naming the ledger state -> only
// the code-alternation assertion goes red; an operator told "refused" with no
// code cannot tell an unbound receipt from an unreadable file, and those have
// opposite remedies (re-review vs restore the ledger).
// SABOTAGE (the over-reach direction): refuse on an absent ledger regardless of
// trailers -> the control goes red, which is how a too-broad fail-closed is told
// apart from a correct one.
// WHICH GUARD CARRIES THE VERDICT: main-unmoved. A non-zero exit alone could come
// from any later stage of the merge; the branch NOT reaching main is the property
// the gate exists to hold.
test('R1-C92: a Review-Receipt trailer with an ABSENT or CORRUPT ledger fails CLOSED — the merge refuses naming the ledger state and main never moves; with no Review-Receipt trailer an absent ledger still merges', () => {
  const arms = [
    { label: 'absent-ledger', withReceiptTrailer: true, ledger: 'absent', merges: false },
    { label: 'corrupt-ledger', withReceiptTrailer: true, ledger: 'corrupt', merges: false },
    { label: 'no-receipt-trailer-absent-ledger', withReceiptTrailer: false, ledger: 'absent', merges: true },
  ];
  // The gate may report this as the binding refusal or as the ledger-state
  // refusal; both are correct and both are in the closed code set. What is NOT
  // acceptable is silence.
  const FAIL_CLOSED_CODES = /\[(superseder_commit_receipt_unbound|ledger_absent|ledger_corrupt)\]/;

  for (const arm of arms) {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/unreadable-ledger']);
      const trailers = ['Reviewed-By-Agent: reviewer-correctness'];
      if (arm.withReceiptTrailer) trailers.push(`Review-Receipt: ${RECEIPT_ID}`);
      const c = writeAndCommit(dir, { path: 'src/feature.mjs', content: 'export const f = 1;\n', subject: `add feature (${arm.label})`, trailerBlock: trailers.join('\n') });

      if (arm.ledger === 'corrupt') writeFileSync(ledgerPath(dir), '{not json');
      else rmSync(ledgerPath(dir), { force: true });
      assert.equal(existsSync(ledgerPath(dir)), arm.ledger === 'corrupt', `[${arm.label}] fixture guard: the ledger is genuinely ${arm.ledger}`);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm.merges) {
        assert.equal(
          r.status,
          0,
          `[${arm.label}] CONTROL — no commit in the range claims a receipt, so there is nothing to bind and the roster rule alone decides; refusing here would block every pre-rebuild branch — stdout=${r.stdout} stderr=${flat(r.stderr)}`
        );
        assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/unreadable-ledger', `[${arm.label}] the branch really merged`);
      } else {
        assert.notEqual(
          r.status,
          0,
          `[${arm.label}] a claim the gate CANNOT CHECK is not a claim it has checked — deleting the ledger must not be the cheapest way past the binding rule — stdout=${r.stdout} stderr=${flat(r.stderr)}`
        );
        assert.match(r.stderr, FAIL_CLOSED_CODES, `[${arm.label}] the refusal NAMES the state it refused on — an unbound receipt and an unreadable ledger have opposite remedies — stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `[${arm.label}] and names the commit whose trailer it could not verify — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm.label}] main never moved — this is the assertion that carries the verdict`);
      }
    } finally {
      cleanup();
    }
  }
});
