// COMMIT-REVIEWED — territory.source AND SELECTION (R1 pin re-cut, group D).
//
// AUTHORITY: contract sheet §1.2 — `receiptIsSpendable(receipt, ctx)` has exactly five
// refusal codes (`receipt_not_active`, `receipt_unattributable`, `receipt_identity_unknown`,
// `receipt_foreign_session`, `receipt_foreign_branch`) — and §3.2 step 1, whose select rule
// is overlap-based with no fallback branch of any kind. Consequence, which is this file's
// whole subject after the re-cut: `territory.source` changes spendability ONLY through
// 'unattributable'. 'review-territory' and 'free-prose-fallback' are treated IDENTICALLY at
// select, coverage and byte-rule time.
//
// SCOPE FENCE (sheet §6 A13): every fixture here declares a NON-EMPTY territory, so nothing in
// this file touches the UNSCOPED partition (territory.files [], always stamped) — that rule
// SURVIVES and is pinned in commit-reviewed-file-scoping.test.mjs R1-D16a/R1-D16b. What A13
// retires, and all this file pins, is the no-match STAMPING FALLBACK.
//
// RETIRED: F0/F0b (the surviving free-prose FALLBACK stamps a non-matching receipt) — the
//   no-match stamping fallback is gone from §3.2 entirely; R1-D69 pins the opposite, and pins
//   it for BOTH sources so the retirement is symmetric rather than a new asymmetry.
// RETIRED: F1/F3 (the structured-territory NARROWING, and the mixed structured/free-prose
//   arm) — the narrowing described a difference between the two sources that no longer
//   exists; the surviving contract is the SYMMETRY, pinned by comparing the two verdicts.
// RETIRED: F2 — its content is commit-reviewed-file-scoping.test.mjs R1-D13.
// RETIRED: F4 (source review-territory with EMPTY files[] is still stamped) — an empty
//   territory covers nothing; pinned as commit-reviewed-file-scoping.test.mjs R1-D16.
// RETIRED: F5 (the flat v1 `files_source` spelling, "either reading") — v1 entries are never
//   spendable, so the ambiguity has no verdict to hang on; the surviving legacy pin is
//   commit-reviewed.test.mjs R1-D09.
// RETIRED: the `RECEIPT FILES DO NOT OVERLAP THIS DIFF` / `ADVISORY ONLY` / `DEFERRED
//   RECEIPT` banner assertions — converted to [code] tokens and --json disclosures[].code.

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
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// The two sources that must behave IDENTICALLY. 'unattributable' is the third value and is
// the subject of commit-reviewed-unattributable.test.mjs.
const SYMMETRIC_SOURCES = ['review-territory', 'free-prose-fallback'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-source-'));
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

function stageChange(dir, relPath, content = 'export const f = 1;\n') {
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

function v2({ entry_id, agent_type, files, blobs = {}, base_sha, source, at = isoAgo(60_000) }) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source, attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}

// ===========================================================================
// R1-D68 — CONTROL, PLACED FIRST, for BOTH sources. Every withholding arm below is
// this fixture with the territory pointed elsewhere, so a green withholding cannot
// be explained by "receipts of this source never spend".
// ===========================================================================

// EXPECTED: RED today only on the consumed-status assertion for both arms.
// SABOTAGE: gate spendability on `territory.source === 'review-territory'` -> the free-prose
// arm refuses while the structured arm commits -> exactly one arm reds, which is the
// asymmetry this control exists to forbid.
test('R1-D68 (CONTROL, first): a receipt COVERING the staged path spends identically whether its territory.source is review-territory or free-prose-fallback', { skip: GIT_SKIP }, () => {
  for (const source of SYMMETRIC_SOURCES) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '68000000-0000-4000-8000-000000000001';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, source })]);

      const r = runCommitReviewed(dir, ['-m', `D68 ${source}`]);
      assert.equal(r.code, 0, `[${source}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], `[${source}] stamped`);
      assert.equal(entryById(dir, id).status, 'consumed', `[${source}] consumed`);
    } finally { cleanup(); }
  }
});

// THE RETIREMENT OF THE FALLBACK, PINNED SYMMETRICALLY. The final assertion is the pin: the
// two sources must produce the SAME verdict, so neither a surviving free-prose fallback nor a
// structured-only narrowing can pass.
// EXPECTED: RED today for BOTH arms and for the symmetry assertion — today the free-prose
// receipt is stamped by the surviving fallback (exit 0) while the structured one defers, so
// the two verdicts differ by construction.
// SABOTAGE (the fallback half): restore the no-match stamping fallback for either source ->
// that arm exits 0, the trailer assertion reds, and the symmetry assertion reds with it.
// SABOTAGE (the silent-destruction half): withhold the receipt but consume it anyway -> the
// ledger byte-identical assertion reds while the exit code stays 1.
test('R1-D69: a receipt matching NOTHING staged is never stamped by any fallback — for BOTH sources the run refuses [coverage_incomplete], discloses [receipt_no_overlap], leaves the receipt ACTIVE, and the two verdicts are IDENTICAL', { skip: GIT_SKIP }, () => {
  const verdicts = {};
  for (const source of SYMMETRIC_SOURCES) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneB.mjs');
      git(dir, ['commit', '-m', 'seed lane B']);
      const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
      stageChange(dir, 'src/laneA.mjs');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '69000000-0000-4000-8000-000000000001';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base, source })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `D69 ${source}`, '--json']);
      assert.equal(r.code, 1, `[${source}] a receipt covering nothing staged can carry no commit — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const out = soleJson(r);
      assert.equal(out.code, 'coverage_incomplete', `[${source}] got ${JSON.stringify(out)}`);
      assert.deepEqual(out.facts?.uncovered, ['src/laneA.mjs'], `[${source}] got ${JSON.stringify(out.facts)}`);
      assert.ok((out.disclosures ?? []).some((d) => d.code === 'receipt_no_overlap' && JSON.stringify(d).includes(id)),
        `[${source}] the withholding is disclosed by name — got ${JSON.stringify(out.disclosures)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[${source}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[${source}] ledger byte-identical — never stamped, never consumed, never deleted`);
      verdicts[source] = { code: out.code, disclosures: (out.disclosures ?? []).map((d) => d.code).sort(), exit: r.code };
    } finally { cleanup(); }
  }
  assert.deepEqual(verdicts['review-territory'], verdicts['free-prose-fallback'],
    `THE SYMMETRY PIN: territory.source must not change the verdict for a non-covering receipt — got ${JSON.stringify(verdicts)}`);
});

// EXPECTED: RED today for both arms — today the structured receipt is disclosed as DEFERRED
// prose (no code) and the free-prose one is stamped by the fallback, so both the disclosure
// code and the trailer set differ from the pin.
// SABOTAGE: apply any withholding rule per-INVOCATION rather than per-RECEIPT ("if any
// receipt is non-covering, no receipt spends") -> the covering receipt is not stamped either,
// exit 1, and both arms red.
test('R1-D70: a non-covering receipt beside one that DOES cover the staged path is withheld and stays ACTIVE while the covering receipt spends — identically for both sources', { skip: GIT_SKIP }, () => {
  const verdicts = {};
  for (const source of SYMMETRIC_SOURCES) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneB.mjs');
      git(dir, ['commit', '-m', 'seed lane B']);
      const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
      stageChange(dir, 'src/laneA.mjs');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const idCovering = '70000000-0000-4000-8000-000000000001';
      const idWithheld = '70000000-0000-4000-8000-000000000002';
      const withheld = v2({ entry_id: idWithheld, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base, source });
      writeLedger(dir, [
        v2({ entry_id: idCovering, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, source: 'review-territory' }),
        withheld,
      ]);

      const r = runCommitReviewed(dir, ['-m', `D70 ${source}`, '--json']);
      assert.equal(r.code, 0, `[${source}] a commit whose diff IS covered must succeed — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], `[${source}] only the covering receipt is stamped`);
      assert.deepEqual(entryById(dir, idWithheld), withheld, `[${source}] the withheld receipt survives exactly as written`);
      const out = soleJson(r);
      verdicts[source] = { exit: r.code, disclosures: (out.disclosures ?? []).map((d) => d.code).sort(), trailers: reviewedByTrailers(dir) };
    } finally { cleanup(); }
  }
  assert.deepEqual(verdicts['review-territory'], verdicts['free-prose-fallback'],
    `THE SYMMETRY PIN: territory.source must not change which receipts a mixed ledger spends — got ${JSON.stringify(verdicts)}`);
});
