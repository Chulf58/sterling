// COMMIT-REVIEWED — THE UNATTRIBUTABLE CLASS (R1 pin re-cut, group D).
//
// AUTHORITY: decision 24dc4c63 — "when several same-typed Starts in one message cannot be
// told apart … that receipt is source 'unattributable', is NEVER STAMPED and NEVER CONSUMED
// (today's pinned behaviour, kept), and is closed only by discharge." Contract sheet §1.2
// (`receiptIsSpendable` code `receipt_unattributable`), §3.2 step 1 ("unattributable NEVER
// selected (disclosure)") and the `receipt_unattributable` disclosure.
// The class's CONTRACT IS KEPT WHOLE; only its assertions move from prose to codes.
//
// RETIRED: U0's control fixture (an EMPTY files[] without the unattributable source, "still
//   ALWAYS stamped") — an empty territory covers nothing and is no longer stamped at all
//   (commit-reviewed-file-scoping.test.mjs R1-D16). The control is re-cut as R1-D75: the SAME
//   covering fixture with an ordinary source, which is what actually isolates the source field.
// RETIRED: U1's empty-files variant — a duplicate permutation of U2/R1-D76; the source gates,
//   so the territory shape adds no distinct failure.
// RETIRED: the CONSUME-DURING-REFRESH family (CONTROL/C1/C2) — `resume_count` and Stop-side
//   refresh are gone (contract sheet §2.1: "every review round has its own Start and its own
//   receipt"); the mid-commit concurrency contract it protected is re-cut as the two-phase
//   reserve/release pins in commit-reviewed-two-phase-spend.test.mjs R1-D100/R1-D104.
// RETIRED: the /unattributable/i prose assertions — converted to the [receipt_unattributable]
//   code token and facts.considered[].code.

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
const SEAM_ON = { ...ENV_SESSION, STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-unattributable-'));
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
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
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
const receiptTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Receipt', sha);
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
// R1-D75 — CONTROL, PLACED FIRST. Byte-for-byte R1-D76's fixture except that
// territory.source is an ordinary value. It is the ONLY thing that makes D76's
// refusal attributable to the source field rather than to the fixture.
// ===========================================================================

// EXPECTED: RED today only on the consumed-status assertion.
// SABOTAGE: gate the never-stamp rule on the receipt's TERRITORY (empty files, or any
// particular path shape) instead of on territory.source -> this control refuses too -> red
// here while D76 stays green, which is the signature of a mis-aimed gate.
test('R1-D75 (CONTROL, first): the identical receipt with an ORDINARY territory.source spends — stamped, bound, consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '75000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-ordinary', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, source: 'review-territory' })]);

    const r = runCommitReviewed(dir, ['-m', 'D75 control: ordinary source']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-ordinary']);
    assert.deepEqual(receiptTrailers(dir), [id]);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — there is no [receipt_unattributable] code and no facts.considered.
// SABOTAGE (the false-attestation route the decision calls FATAL): treat
// source 'unattributable' as an ordinary source, or as a synonym for the retired UNATTRIBUTED
// always-stamp class -> the receipt stamps a commit no identifiable reviewer reviewed ->
// exit 0 and every assertion reds.
// NOTE THE FIXTURE: the territory OVERLAPS the staged path and its blob MATCHES, so the
// receipt would be a clean selection on every other axis. Overlap never rescues it.
test('R1-D76: a source "unattributable" receipt whose territory covers the staged path and whose bytes MATCH is still never selected — refuses [no_spendable_receipt] with facts.considered code receipt_unattributable, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '76000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-unsafe', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, source: 'unattributable' })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D76 unattributable, sole entry', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'no_spendable_receipt', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.considered, [{ entry_id: id, code: 'receipt_unattributable' }], `got ${JSON.stringify(out.facts)}`);
    assert.match(r.stderr, token('receipt_unattributable'), `and the human channel says WHY it was withheld — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NEVER consumed — the ledger entry is untouched; only discharge closes this class');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today the unattributable receipt has no distinct class, so with
// overlapping files it would be selected and stamped alongside the eligible one (two trailers
// instead of one).
// SABOTAGE: the same one as D76 — the unattributable receipt is stamped too -> the trailer
// deepEquals red. This arm is what proves the class survives in a MIXED ledger, where the
// tempting shortcut is "some receipt covers the diff, so stamp them all".
test('R1-D77: in a MIXED ledger the eligible receipt spends and the unattributable one is left ACTIVE and byte-identical, disclosed [receipt_unattributable]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const idOk = '77000000-0000-4000-8000-000000000001';
    const idUnattr = '77000000-0000-4000-8000-000000000002';
    const unattributable = v2({ entry_id: idUnattr, agent_type: 'reviewer-unsafe-mixed', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, source: 'unattributable' });
    writeLedger(dir, [
      v2({ entry_id: idOk, agent_type: 'reviewer-eligible', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, source: 'review-territory' }),
      unattributable,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D77 mixed', '--json']);
    assert.equal(r.code, 0, `an eligible receipt covers the diff, so the commit succeeds — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-eligible'], 'ONLY the eligible receipt is stamped, though the other one\'s files genuinely overlap');
    assert.deepEqual(receiptTrailers(dir), [idOk], 'and only its entry_id is bound to the commit');
    const out = soleJson(r);
    assert.ok((out.disclosures ?? []).some((d) => d.code === 'receipt_unattributable' && JSON.stringify(d).includes(idUnattr)),
      `the withheld receipt is disclosed by name — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(entryById(dir, idUnattr), unattributable, 'and survives exactly as written — never stamped, never reserved, never consumed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the class does not exist, so amend mode would stamp it.
// SABOTAGE: apply the never-stamp gate only on the -m path (an `if (!targetSha)` guard around
// the spendability check) -> the amend goes through and stamps -> every assertion reds. That
// guard is invisible to D76/D77, which both run in new-commit mode.
test('R1-D78: --target-sha amend mode ALSO never stamps a source "unattributable" receipt, even as the sole entry with a matching base_sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneC.mjs');
    git(dir, ['commit', '-m', 'seed laneC, to be amended']);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);
    const blob = git(dir, ['rev-parse', `${targetSha}:src/laneC.mjs`]);
    const id = '78000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-unsafe-amend', files: ['src/laneC.mjs'], blobs: { 'src/laneC.mjs': blob }, base_sha: targetSha, source: 'unattributable' })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json'], SEAM_ON);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.equal(soleJson(r).code, 'no_spendable_receipt', `got ${flat(r.stdout)}`);
    assert.match(r.stderr, token('receipt_unattributable'), `and the class is named — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});
