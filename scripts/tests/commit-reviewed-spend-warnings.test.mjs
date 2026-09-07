// COMMIT-REVIEWED — THE DISCLOSURE CHANNEL (R1 pin re-cut, group D).
//
// AUTHORITY: contract sheet §3.2 — "Disclosures printed (never refuse): receipt_stale,
// receipt_age_unverifiable, receipt_deferred, receipt_no_overlap, multi_spend (>3),
// receipt_unattributable, receipt_foreign, receipt_identity_unknown, legacy_entries_present"
// — and §1.4 `render(x)` → `NOTE [<code>] <message>`, with `disclosures[].code` in --json.
//
// RE-CUT: stale horizon per A11 (14 days default) — R1-D22's stale receipt is aged 400 days,
//   and its unverifiable-age receipt uses an unparseable STRING (a non-string finished_at is
//   [ledger_entry_malformed] per A11, which would be a different class in the wall).
//
// RETIRED: P3/P4/P9 (the DO-NOT-OVERLAP advisory and its path-normalization arm) — that class
//   is [receipt_no_overlap] and is pinned in commit-reviewed-file-scoping.test.mjs R1-D13/D17.
// RETIRED: P5/P6/P7/P10 (STALE RECEIPT, RECEIPT AGE UNVERIFIABLE and the hostile `at`) —
//   pinned in commit-reviewed-completed-at.test.mjs R1-D62..R1-D66 on the v2 finished_at field.
// RETIRED: P11 (RECORDS NO FILES) — an empty territory is no longer stamped at all; the
//   consequence is pinned in commit-reviewed-file-scoping.test.mjs R1-D16.
// RETIRED: the `spend_warnings[]` field name and every ALL-CAPS banner assertion
//   (MULTI-SPEND — 4 review receipts, DEFERRED RECEIPT, ADVISORY ONLY) — the channel is
//   `disclosures[]` with a `code` per entry (§3.2), asserted by code, never by text or count
//   embedded in prose.
// RETIRED: every v1 (flat) fixture except the ONE legacy_entries_present arm inside R1-D22.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-spend-'));
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
const codesOf = (out) => (out.disclosures ?? []).map((d) => d.code);

function v2({
  entry_id, agent_type, files, blobs = {}, base_sha, at = isoAgo(60_000),
  finished_at, session_id = SESSION,
}) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: finished_at ?? at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch: 'main', base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}

// ===========================================================================
// R1-D20 — CONTROL, PLACED FIRST. Establishes both the threshold boundary and the
// present-as-empty channel; without it, "multi_spend fired" is indistinguishable
// from "this channel emits something on every run".
// ===========================================================================

// EXPECTED: RED today — there is no `disclosures` key (today's field is `spend_warnings`), so
// the deepEqual on an empty array fires.
// SABOTAGE: emit multi_spend at `>= 3` instead of `> 3` -> the doesNotMatch and the empty
// deepEqual both red. The boundary is the whole content of this arm.
test('R1-D20 (CONTROL, first): exactly 3 selected receipts is AT the multi-spend threshold, not over it — no [multi_spend], and disclosures is present-as-EMPTY, never absent', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const ids = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003'];
    writeLedger(dir, ids.map((id, i) => v2({ entry_id: id, agent_type: `reviewer-${i}`, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base })));

    const r = runCommitReviewed(dir, ['-m', 'D20 three receipts', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, token('multi_spend'), `three is the boundary, not over it — stderr=${flat(r.stderr)}`);
    assert.deepEqual(soleJson(r).disclosures, [], `a clean run reports disclosures as an EMPTY array — got ${flat(r.stdout)}`);
  } finally { cleanup(); }
});

// EXPECTED: RED today — no [multi_spend] code, no disclosures[], no Review-Receipt trailers.
// SABOTAGE: promote multi_spend from disclosure to refusal -> exit 1 and the four-trailer /
// consumed assertions red. A crowded commit is a smell, never an error.
// SECOND SABOTAGE: count the LEDGER's entries instead of the SELECTED ones -> a ledger with
// four entries of which two are withheld would fire the disclosure wrongly; this fixture
// cannot see that, which is why R1-D22 keeps a withheld receipt beside four selected ones.
test('R1-D21: 4 selected receipts disclose [multi_spend] with facts.count — the commit still succeeds, all four are stamped, bound and consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const ids = ['21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000004'];
    writeLedger(dir, ids.map((id, i) => v2({ entry_id: id, agent_type: `reviewer-${i}`, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base })));

    const r = runCommitReviewed(dir, ['-m', 'D21 four receipts', '--json']);
    assert.equal(r.code, 0, `a crowded commit is disclosed, never refused — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    const multi = (out.disclosures ?? []).filter((d) => d.code === 'multi_spend');
    assert.equal(multi.length, 1, `exactly one multi-spend disclosure per invocation — got ${JSON.stringify(out.disclosures)}`);
    assert.equal(multi[0].facts?.count, 4, `the count is a FACT, not a number embedded in prose — got ${JSON.stringify(multi[0])}`);
    assert.match(r.stderr, token('multi_spend'), `and the human channel carries the same code — stderr=${flat(r.stderr)}`);
    assert.equal(reviewedByTrailers(dir).length, 4, 'one roster trailer per receipt regardless of the disclosure');
    assert.deepEqual(receiptTrailers(dir).sort(), [...ids].sort(), 'and one Review-Receipt trailer per receipt');
    for (const id of ids) assert.equal(entryById(dir, id).status, 'consumed', `${id} consumed`);
  } finally { cleanup(); }
});

// THE NEVER-A-REFUSAL WALL: every simultaneously-reachable disclosure class firing in ONE run.
// EXPECTED: RED today — four of the five codes do not exist, and a v1 entry would be spent
// rather than listed.
// SABOTAGE: let any single disclosure class set a non-zero exit -> the exit-0 assertion reds
// while the code assertions stay green, which is exactly the regression this wall exists for:
// the classes are individually harmless and collectively tempting to treat as a refusal.
test('R1-D22 (THE WALL): multi_spend + receipt_stale + receipt_age_unverifiable + receipt_no_overlap + legacy_entries_present all firing at once still exits 0, stamps every selected receipt and leaves every withheld one ACTIVE', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const selected = ['22000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000004'];
    const idNoOverlap = '22000000-0000-4000-8000-000000000005';
    writeLedger(dir, [
      v2({ entry_id: selected[0], agent_type: 'reviewer-a', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: selected[1], agent_type: 'reviewer-b', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, at: isoAgo(401 * 86_400_000), finished_at: isoAgo(400 * 86_400_000) }), // stale, past the 14-day default horizon (A11)
      v2({ entry_id: selected[2], agent_type: 'reviewer-c', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, finished_at: 'whenever' }),                                // age unverifiable: an unparseable STRING, which A11 admits
      v2({ entry_id: selected[3], agent_type: 'reviewer-d', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: idNoOverlap, agent_type: 'reviewer-e', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base }),                                                     // no overlap
      { agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main' },                                                                          // v1 legacy
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D22 every class at once', '--json']);
    assert.equal(r.code, 0, `no combination of disclosures may refuse — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    for (const code of ['multi_spend', 'receipt_stale', 'receipt_age_unverifiable', 'receipt_no_overlap', 'legacy_entries_present']) {
      assert.ok(codesOf(out).includes(code), `[${code}] must be disclosed — got ${JSON.stringify(out.disclosures)}`);
    }
    assert.equal(reviewedByTrailers(dir).length, 4, 'exactly the four SELECTED receipts are stamped — the withheld and legacy entries contribute none');
    for (const id of selected) assert.equal(entryById(dir, id).status, 'consumed', `${id} consumed`);
    assert.equal(entryById(dir, idNoOverlap).status, 'active', 'the withheld receipt stays spendable');
    assert.ok((readLedger(dir) ?? []).some((e) => e.agent_type === 'reviewer-legacy'), 'and the v1 entry is left exactly where it was');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the two channels carry different shapes today (prose on stderr, a
// `spend_warnings` string array on stdout), so no code-set comparison is possible.
// SABOTAGE: emit a disclosure into --json only (or into stderr only) -> the set comparison
// reds. Both channels are consumed by different readers — the operator and the merge
// surfaces — and a disclosure visible to only one of them is invisible to the other.
test('R1-D23: every disclosure reaches BOTH channels — the [code] tokens on stderr are exactly the set of disclosures[].code in --json', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    writeLedger(dir, [
      // Aged past the 14-day default horizon (A11) so this fixture really does produce
      // receipt_stale — at 30h it produced nothing, and the code-set comparison below would
      // then have been satisfied by receipt_no_overlap alone.
      v2({ entry_id: '23000000-0000-4000-8000-000000000001', agent_type: 'reviewer-a', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, at: isoAgo(401 * 86_400_000), finished_at: isoAgo(400 * 86_400_000) }),
      v2({ entry_id: '23000000-0000-4000-8000-000000000002', agent_type: 'reviewer-b', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D23 both channels', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const jsonCodes = new Set(codesOf(soleJson(r)));
    assert.ok(jsonCodes.size > 0, `fixture guard: this run must produce at least one disclosure — got ${flat(r.stdout)}`);
    const stderrCodes = new Set([...r.stderr.matchAll(/\[([a-z_]+)\]/g)].map((m) => m[1]));
    assert.deepEqual([...jsonCodes].sort(), [...stderrCodes].sort(), `the two channels must carry the SAME code set — json=${JSON.stringify([...jsonCodes])} stderr=${JSON.stringify([...stderrCodes])}`);
  } finally { cleanup(); }
});
