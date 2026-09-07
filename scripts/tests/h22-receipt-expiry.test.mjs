// R1 GROUP B — RECEIPT IDENTITY AT PROMOTION, AND THE SPEND-SIDE DISCLOSURES.
//
// Contract source: decision `review-receipt-rebuild-invariant-three-owner-
// modules-tri-state-liveness-receipt-bound-supersession` + contract sheet
// §1.2 (ReceiptV2 identity + spendability codes), §3.2 (commit-reviewed's
// select -> reserve -> commit -> verify -> finalize, and the disclosures it
// PRINTS but never refuses on) and A6 (every advisory carries a [code] token).
//
// SECTION A — H22's Stop side records identity{session_id, branch, base_sha,
// agent_id} on the promoted receipt. SECTION B — commit-reviewed's spend:
// what is stamped, what is disclosed, and what survives in the ledger.
// SECTION C — H1 reports surviving receipts. SECTION D — H1's session-marker
// write is fail-open but never leaves a STALE positive behind.
//
// RETIRED (named so the review sees what was dropped):
//   RETIRED: 'the promoted v2 entry ... exactly these eleven top-level keys' —
//     the v2 envelope now admits the optional observed_*/reservation/
//     consumption/disposition sections (§1.2); the pin becomes required-keys
//     present + no key outside the shape.
//   RETIRED: 'the matching receipt is still fully consumed' asserted as
//     `deepEqual(ledger, [])` — consumption is a LIFECYCLE TRANSITION now
//     (status 'consumed' {commit_sha, consumed_at, nonce}), not a deletion;
//     deleting the receipt is what made a consumed commit unverifiable at the
//     merge gate.
//   RETIRED: the v1-shaped spend fixtures ({agent_type, files, at, session_id,
//     branch, base_sha}) — a v1 entry is LEGACY: never spendable, dischargeable
//     via --legacy-handle only. One adapter pin covers the shape
//     (scripts/tests/review-ledger-entry-owner.test.mjs R1-B26).
//   RETIRED: the disclosure assertions matching the foreign session_id/branch
//     VALUE and an 'Nh' age string as prose — the identity value stays pinned
//     as a FACT, the disclosure is pinned by its [code].
//   RETIRED: 'AMBIGUITY (flagged, not resolved): branch identity under a
//     detached HEAD' (a skipped placeholder) — the rebuild answers it:
//     identity.branch is `string|null`, and a null branch is DEFICIENT, not
//     foreign (receipt_identity_unknown, pinned in R1-B25).
//
// A11 SETTLED TWO THINGS THIS FILE HAD LEFT OPEN:
//   - `receipt_age_unverifiable` is reachable: parseReceipt ADMITS an
//     unparseable finished_at, and the age problem surfaces at spend. Pinned
//     as R1-B55.
//   - the lone-excluded-candidate exit code: a refusal `no_spendable_receipt`
//     exit 1 with facts.considered, NEVER a bare commit. R1-B44/B45/B48 no
//     longer branch on the observed exit code.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_HOOK = join(HOOKS, 'h22-dispatch-register.mjs');
const COMMIT_REVIEWED_CLI = join(root, 'scripts', 'commit-reviewed.mjs');
const H1_HOOK = 'h1-session-start.mjs';

// A refusal/disclosure is asserted by its code token, never by its sentence.
const token = (c) => new RegExp('\\[' + c + '\\]');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

// =============================================================================
// SECTION A — H22 SubagentStop records identity{} on the promoted receipt.
// =============================================================================

function makeGitProject(branchName = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-expiry-'));
  git(dir, ['init', '-b', branchName]);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'seed']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function runH22Hook(input, cwd) {
  const r = spawnSync(process.execPath, [H22_HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function h22Input(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStop',
    ...over,
  };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function ledgerPathA(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function readLedgerA(dir) {
  return JSON.parse(readFileSync(ledgerPathA(dir), 'utf8'));
}

const registerEntry = (agentId, agentType, files, at = new Date().toISOString(), sessionId = 's1') => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
  files,
  at,
});

// A11: `disposition` is PRESENT as null on every non-discharged receipt;
// reservation/consumption are ABSENT unless the status requires them.
const RECEIPT_REQUIRED = ['content_evidence', 'disposition', 'entry_id', 'finished_at', 'identity', 'kind', 'reviewer', 'schema_version', 'started_at', 'status', 'territory'];
const RECEIPT_OPTIONAL = ['observed_files', 'observed_reads', 'observed_source', 'observed_truncated', 'reservation', 'consumption'];

test(
  'R1-B40 (CONTROL, placed first): promoting a reviewer-* entry still carries its pre-existing substance — reviewer.agent_type, territory.files and started_at — independent of whether identity{} is populated',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject('main');
    try {
      writeRegisterRaw(dir, [registerEntry('rev-1', 'reviewer-correctness', ['src/a.mjs'], '2026-08-25T00:00:00.000Z')]);
      const r = runH22Hook(h22Input(dir, { agent_id: 'rev-1', agent_type: 'reviewer-correctness' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const ledger = readLedgerA(dir);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].reviewer.agent_type, 'reviewer-correctness');
      assert.deepEqual(ledger[0].territory.files, ['src/a.mjs']);
      assert.equal(ledger[0].started_at, '2026-08-25T00:00:00.000Z');
    } finally {
      cleanup();
    }
  }
);

test(
  'R1-B41: the promoted receipt carries identity{session_id, branch, base_sha, agent_id} and no key outside the ReceiptV2 shape',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject('sterling/board-fanout-3');
    try {
      writeRegisterRaw(dir, [registerEntry('rev-2', 'reviewer-security', ['src/b.mjs'], '2026-08-25T01:00:00.000Z', 's1')]);
      const r = runH22Hook(h22Input(dir, { agent_id: 'rev-2', agent_type: 'reviewer-security', session_id: 's1' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const entry = readLedgerA(dir)[0];

      for (const key of RECEIPT_REQUIRED) assert.ok(key in entry, `required v2 key '${key}'`);
      const allowed = new Set([...RECEIPT_REQUIRED, ...RECEIPT_OPTIONAL]);
      assert.deepEqual(
        Object.keys(entry).filter((k) => !allowed.has(k)),
        [],
        'no key outside the ReceiptV2 shape (resume_count / rebaseline_refused / refresh residue are GONE)'
      );

      assert.equal(entry.identity.session_id, 's1', "the register entry's session_id is carried onto the receipt");
      assert.equal(entry.identity.branch, 'sterling/board-fanout-3', "branch is the git branch active in the hook's cwd at promotion");
      assert.match(entry.identity.base_sha, /^[0-9a-f]{7,40}$/i, 'base_sha is a git sha string');
      assert.equal(entry.identity.agent_id, 'rev-2', 'the receipt names the agent whose Stop minted it');
    } finally {
      cleanup();
    }
  }
);

test('R1-B42: a cwd with no git repository still promotes — branch/base_sha degrade to null rather than throwing, and the receipt is DEFICIENT, not foreign', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-expiry-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    writeRegisterRaw(dir, [registerEntry('rev-3', 'reviewer-performance', ['src/c.mjs'], '2026-08-25T02:00:00.000Z')]);
    const r = runH22Hook(h22Input(dir, { agent_id: 'rev-3', agent_type: 'reviewer-performance' }), dir);
    assert.notEqual(r.code, 2, 'a git-repo-less cwd must never deny the SubagentStop boundary');
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedgerA(dir);
    assert.equal(ledger.length, 1, 'the receipt is still promoted even though branch/base_sha cannot be resolved');
    assert.equal(ledger[0].reviewer.agent_type, 'reviewer-performance');
    assert.equal(ledger[0].identity.branch, null, 'an unresolvable branch is recorded as null — never a fabricated value, never omitted');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// SECTION B — commit-reviewed's spend. What is stamped, what is disclosed by
// [code], and what survives in the ledger.
// =============================================================================

function makeRepo(branchName = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-expiry-'));
  git(dir, ['init', '-b', branchName]);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ledgerPathB(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function writeLedgerB(dir, entries) {
  writeFileSync(ledgerPathB(dir), JSON.stringify(entries));
}
function readLedgerB(dir) {
  return existsSync(ledgerPathB(dir)) ? JSON.parse(readFileSync(ledgerPathB(dir), 'utf8')) : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

// The session identity channel: H1's marker file is the state the sheet names
// (.sterling/transient/session.json); the env var is kept alongside it so this
// fixture works whichever the CLI reads.
function setSession(dir, sessionId) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'session.json'), JSON.stringify({ session_id: sessionId, at: new Date().toISOString() }));
}

function runCommitReviewed(dir, args = [], envOverride = {}) {
  const r = spawnSync(process.execPath, [COMMIT_REVIEWED_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...envOverride },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const spendOutput = (r) => `${r.stdout}\n${r.stderr}`;

function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const rosterTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const receiptTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Receipt', sha);

let seq = 0;
// A spendable ReceiptV2 for the staged path: identity matches the fixture's
// session/branch/HEAD and the byte evidence matches the INDEX blob, so the
// spend's byte rule is satisfied and any refusal below has exactly one cause.
function spendableReceipt(dir, over = {}) {
  seq += 1;
  const path = over.path ?? 'src/feature.mjs';
  const indexBlob = git(dir, ['rev-parse', `:${path}`]);
  const receipt = {
    schema_version: 2,
    entry_id: `aaaaaaaa-0000-4000-8000-00000000000${seq.toString(16)}`,
    kind: 'roster_receipt',
    status: 'active',
    started_at: isoAgo(2 * HOUR),
    finished_at: isoAgo(HOUR),
    reviewer: { agent_type: 'reviewer-correctness', model: 'claude-x', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: 's1', branch: 'main', base_sha: git(dir, ['rev-parse', 'HEAD']), agent_id: `rev-${seq}` },
    territory: { files: [path], source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: { [path]: indexBlob }, absent_paths: [] },
  };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'path') continue;
    receipt[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && receipt[k] ? { ...receipt[k], ...v } : v;
  }
  return receipt;
}

// ===========================================================================
// R1-B43 — CONTROL, PLACED FIRST. A spendable receipt stamps BOTH trailers and
// the receipt survives as status 'consumed' bound to the commit it paid for.
// Without this, every "not stamped" arm below is equally satisfied by "nothing
// is ever stamped".
// SABOTAGE: delete the receipt on consumption (today's behaviour) instead of
// transitioning it to consumed — the survives/status/commit_sha assertions go
// red while the trailer assertions stay green. That deletion is precisely what
// leaves a Review-Receipt trailer unverifiable at the merge gate.
// ===========================================================================

test('R1-B43 (CONTROL): a spendable receipt stamps Reviewed-By-Agent AND Review-Receipt, and is FINALIZED as consumed {commit_sha}, not deleted', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir);
    writeLedgerB(dir, [receipt]);

    const r = runCommitReviewed(dir, ['-m', 'B43 control'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 0, `a spendable receipt must commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    assert.deepEqual(rosterTrailers(dir), ['reviewer-correctness'], "today's roster trailer value shape is unchanged");
    assert.deepEqual(receiptTrailers(dir), [receipt.entry_id], 'the NEW Review-Receipt trailer names the receipt that was spent');

    const after = readLedgerB(dir);
    assert.equal(after.length, 1, 'the consumed receipt SURVIVES — a consumed commit stays verifiable at the merge gate');
    assert.equal(after[0].entry_id, receipt.entry_id);
    assert.equal(after[0].status, 'consumed');
    assert.equal(after[0].consumption.commit_sha, git(dir, ['rev-parse', 'HEAD']), 'the consumption binds to the commit it paid for');
    assert.ok(after[0].consumption.consumed_at, 'the consumption records when');
    assert.doesNotMatch(spendOutput(r), token('receipt_deferred'), 'CONTROL: a receipt whose base_sha IS the target discloses no deferral');
    assert.doesNotMatch(spendOutput(r), token('receipt_stale'), 'CONTROL: a fresh receipt discloses no staleness');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B44 / R1-B45 — foreign identity: never stamped, never deleted, and (A11)
// the exit code is now SETTLED: when every candidate is excluded, the run is a
// REFUSAL `no_spendable_receipt` exit 1 with facts.considered naming each
// excluded entry and its code — NEVER a bare commit. A bare commit was the
// dangerous outcome: an unreviewed diff landing quietly because the only
// receipt happened to be foreign.
// SABOTAGE: drop the session comparison from receiptIsSpendable — the refusal
// becomes a stamped commit and every assertion here goes red.
// SABOTAGE: keep the refusal but fall back to a bare commit when the candidate
// set empties — the exit-code and HEAD assertions go red alone.
// ===========================================================================

test('R1-B44 (A11): a foreign-session receipt is never spent and never deleted; the run REFUSES no_spendable_receipt, naming it in facts', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir, { identity: { session_id: 'foreign-session-xyz' } });
    writeLedgerB(dir, [receipt]);
    const headBefore = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'B44 foreign session', '--json'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 1, 'every candidate excluded is a refusal, never a bare commit');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'a refusal makes no commit at all');

    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'no_spendable_receipt', 'the refusal names the closed code, not a sentence');
    assert.deepEqual(json.facts.considered.map((c) => c.entry_id), [receipt.entry_id], 'facts name WHICH receipt was considered');
    assert.deepEqual(json.facts.considered.map((c) => c.code), ['receipt_foreign_session'], 'and WHY it was excluded, as a field');

    const after = readLedgerB(dir);
    assert.equal(after.length, 1, 'the foreign receipt survives — never silently deleted');
    assert.equal(after[0].identity.session_id, 'foreign-session-xyz', 'its identity is untouched');
    assert.equal(after[0].status, 'active', 'and it is neither reserved nor consumed by a spend it was never eligible for');
  } finally {
    cleanup();
  }
});

test('R1-B45 (A11): a foreign-BRANCH receipt refuses the same way, with its own code in facts', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir, { identity: { branch: 'sterling/some-other-slice' } });
    writeLedgerB(dir, [receipt]);
    const headBefore = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'B45 foreign branch', '--json'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 1);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'a refusal makes no commit at all');

    const json = JSON.parse(r.stdout);
    assert.equal(json.code, 'no_spendable_receipt');
    assert.deepEqual(json.facts.considered.map((c) => c.code), ['receipt_foreign_branch'], 'branch and session are DIFFERENT codes — the operator learns which one to fix');

    const after = readLedgerB(dir);
    assert.equal(after.length, 1, 'the foreign-branch receipt survives');
    assert.equal(after[0].identity.branch, 'sterling/some-other-slice');
    assert.equal(after[0].status, 'active');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B46 — the unambiguous mixed case: one eligible + one foreign. The commit
// succeeds, ONLY the eligible receipt is stamped and consumed, and the foreign
// one survives ACTIVE and disclosed.
// SABOTAGE: select every receipt whose territory overlaps, skipping
// receiptIsSpendable — the trailer assertions go red with two values.
// ===========================================================================

test('R1-B46: a mixed ledger commits, stamps ONLY the eligible receipt, and leaves the foreign one active and disclosed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const eligible = spendableReceipt(dir);
    const foreign = spendableReceipt(dir, {
      reviewer: { agent_type: 'reviewer-security' },
      identity: { session_id: 'foreign-session-abc' },
    });
    writeLedgerB(dir, [eligible, foreign]);

    const r = runCommitReviewed(dir, ['-m', 'B46 mixed'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 0, `at least one eligible receipt exists, so the commit must succeed — stderr=${flat(r.stderr)}`);

    assert.deepEqual(rosterTrailers(dir), ['reviewer-correctness'], 'only the eligible receipt is stamped');
    assert.deepEqual(receiptTrailers(dir), [eligible.entry_id], 'and only its entry_id is bound to the commit');

    const after = readLedgerB(dir);
    assert.equal(after.length, 2, 'both receipts survive the spend');
    const spent = after.find((e) => e.entry_id === eligible.entry_id);
    const skipped = after.find((e) => e.entry_id === foreign.entry_id);
    assert.equal(spent.status, 'consumed');
    assert.equal(skipped.status, 'active', 'the foreign receipt is untouched by a spend it was never eligible for');
    assert.match(spendOutput(r), token('receipt_foreign'), 'the skipped foreign receipt is disclosed by code');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B47 / R1-B48 — THE TWO DISCLOSURES THAT LOOK ALIKE AND ARE NOT (A11).
// `receipt_stale` is advisory only: an old receipt is still SPENT. But
// `receipt_deferred` (identity.base_sha ≠ the target) is an EXCLUDING
// disclosure — A11 lists deferred among the exclusions that leave the run a
// refusal, because a receipt earned on top of a different commit has not seen
// the diff being committed. The two arms are each other's control: they must
// come out DIFFERENTLY, and R1-B43 asserts that neither code fires at all for
// a fresh, on-target receipt.
// STALE HORIZON (A11): config.review_ledger.stale_days if present, else 14
// days — the fixture uses 400 days, beyond either.
// SABOTAGE: collapse the two into one bucket (either "both advisory" or "both
// excluding") — whichever way it is collapsed, one of these two arms goes red.
// ===========================================================================

test('R1-B47 (A11): a STALE receipt is disclosed by code and still SPENT — staleness is advisory only', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir, { started_at: isoAgo(401 * DAY), finished_at: isoAgo(400 * DAY) });
    writeLedgerB(dir, [receipt]);

    const r = runCommitReviewed(dir, ['-m', 'B47 stale'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 0, `staleness discloses, never refuses — stderr=${flat(r.stderr)}`);
    assert.deepEqual(receiptTrailers(dir), [receipt.entry_id], 'the stale receipt is still spent');
    assert.match(spendOutput(r), token('receipt_stale'), 'and its age is disclosed by code');
  } finally {
    cleanup();
  }
});

test('R1-B48 (A11): a DEFERRED receipt (base_sha ≠ the target) is EXCLUDED — the lone-candidate run refuses, and the receipt stays active', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir, { identity: { base_sha: 'a'.repeat(40) } });
    writeLedgerB(dir, [receipt]);
    const headBefore = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'B48 deferred', '--json'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 1, 'a receipt earned on top of a DIFFERENT commit has not seen this diff — it excludes, unlike staleness');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'no commit is made');

    const json = JSON.parse(r.stdout);
    assert.equal(json.code, 'no_spendable_receipt');
    assert.deepEqual(json.facts.considered.map((c) => c.code), ['receipt_deferred'], 'the deferral is named as the exclusion reason, as a field');

    const after = readLedgerB(dir);
    assert.equal(after[0].status, 'active', 'the deferred receipt is untouched — a later, on-target round can still be earned');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B55 (A11, closes this file's previously-unpinnable disclosure) — an
// unparseable finished_at is ADMITTED by parseReceipt (the evidence is
// recorded as captured) and surfaces HERE as `receipt_age_unverifiable`. Like
// staleness and unlike deferral it is advisory: the receipt is still spent,
// because an unreadable clock says nothing about whether the bytes match.
// Its parser half is R1-B33 in scripts/tests/review-ledger-entry-owner.test.mjs.
// SABOTAGE: compute the age with a bare `Date.parse(...)` and let NaN compare
// false everywhere — no disclosure fires at all and this goes red, silently
// treating an unverifiable age as a verified-fresh one.
// SABOTAGE: make it excluding (like deferral) — the exit-code and trailer
// assertions go red.
// ===========================================================================

test('R1-B55 (A11): a receipt whose finished_at cannot be parsed is spent, with receipt_age_unverifiable disclosed by code', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const receipt = spendableReceipt(dir, { finished_at: 'not-a-date-at-all' });
    writeLedgerB(dir, [receipt]);

    const r = runCommitReviewed(dir, ['-m', 'B55 age unverifiable'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 0, `an unreadable clock is advisory, never a refusal — stderr=${flat(r.stderr)}`);
    assert.deepEqual(receiptTrailers(dir), [receipt.entry_id], 'the receipt is still spent');
    assert.match(spendOutput(r), token('receipt_age_unverifiable'), 'the unverifiable age is disclosed by code');
    assert.doesNotMatch(spendOutput(r), token('receipt_stale'), 'an unverifiable age is NOT a stale one — the two are never conflated');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-B49 — a LEGACY (v1) entry is never spendable and never deleted; its
// presence is disclosed by code so the operator knows a discharge is owed.
// SABOTAGE: let adaptLegacyEntry's output flow into the spend candidates —
// the not-stamped assertion goes red, spending a receipt whose session,
// branch and bytes were never verifiable.
// ===========================================================================

test('R1-B49: a v1 (legacy) ledger entry is never spent, never rewritten, and its presence is disclosed by code', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    stageChange(dir);
    setSession(dir, 's1');
    const eligible = spendableReceipt(dir);
    const legacy = { agent_type: 'reviewer-skeptic', files: ['src/feature.mjs'], at: isoAgo(5 * HOUR), session_id: 's1', branch: 'main', base_sha: 'b'.repeat(40) };
    writeLedgerB(dir, [legacy, eligible]);

    const r = runCommitReviewed(dir, ['-m', 'B49 legacy beside eligible'], { STERLING_SESSION_ID: 's1' });
    assert.equal(r.code, 0, `the eligible receipt still commits — stderr=${flat(r.stderr)}`);

    assert.deepEqual(rosterTrailers(dir), ['reviewer-correctness'], 'the legacy entry is NOT stamped — reading it never makes it spendable');
    assert.deepEqual(receiptTrailers(dir), [eligible.entry_id]);

    const after = readLedgerB(dir);
    assert.deepEqual(after[0], legacy, 'the v1 entry is byte-for-byte untouched — never migrated by being read');
    assert.match(spendOutput(r), token('legacy_entries_present'), 'its presence is disclosed by code, so the discharge that is owed is visible');
  } finally {
    cleanup();
  }
});

// =============================================================================
// SECTION C — H1 SessionStart reports surviving receipts.
// =============================================================================

function makeH1Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-receipts-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function writeH1Ledger(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'review-ledger.json'), JSON.stringify(entries));
}

// A standalone ReceiptV2 for the H1 reporting arms — no git fixture is needed
// here, so the blobs are arbitrary-but-well-formed.
const h1Receipt = (agentType, ageMs, id) => ({
  schema_version: 2,
  entry_id: id,
  kind: 'roster_receipt',
  status: 'active',
  started_at: isoAgo(ageMs + HOUR),
  finished_at: isoAgo(ageMs),
  reviewer: { agent_type: agentType, model: null, model_family: 'unknown', model_source: 'unknown' },
  identity: { session_id: 'old-session', branch: 'main', base_sha: 'd'.repeat(40), agent_id: `agent-${id.slice(0, 4)}` },
  territory: { files: ['src/a.mjs'], source: 'review-territory', attribution: 'block' },
  content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: { 'src/a.mjs': 'e'.repeat(40) }, absent_paths: [] },
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function h1(dir, source) {
  const r = runHook(H1_HOOK, { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source }, dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function additionalContext(res) {
  return res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : undefined;
}

test('R1-B50 (CONTROL): SessionStart with no review-ledger.json at all reports no receipt at all', () => {
  const { dir, cleanup } = makeH1Project();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r) ?? '';
    assert.doesNotMatch(ctx, /reviewer-correctness|reviewer-security/, 'nothing to report — no ledger file exists');
  } finally {
    cleanup();
  }
});

// SABOTAGE: report the receipt without its age (or with a fabricated one) —
// the age assertion goes red; the age is the whole point of the report, since
// it is what tells the operator a discharge is overdue.
test('R1-B51: SessionStart reports ONE surviving receipt by its reviewer class and its age', () => {
  const { dir, cleanup } = makeH1Project();
  try {
    writeH1Ledger(dir, [h1Receipt('reviewer-correctness', 5 * HOUR, 'c1000000-0000-4000-8000-000000000001')]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r) ?? '';
    assert.match(ctx, /reviewer-correctness/, "the surviving receipt is named by the FACT that identifies it — its reviewer class");
    assert.match(ctx, /\b5\.0h\b|\b5h\b/, "the receipt's age is reported");
  } finally {
    cleanup();
  }
});

test('R1-B52: SessionStart reports the COUNT and both ages when two receipts survive', () => {
  const { dir, cleanup } = makeH1Project();
  try {
    writeH1Ledger(dir, [
      h1Receipt('reviewer-correctness', 1 * HOUR, 'c1000000-0000-4000-8000-000000000002'),
      h1Receipt('reviewer-security', 20 * HOUR, 'c1000000-0000-4000-8000-000000000003'),
    ]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r) ?? '';
    assert.match(ctx, /\b2\b/, 'the count of surviving receipts is named');
    assert.match(ctx, /\b1\.0h\b|\b1h\b/, "the fresher receipt's age is named");
    assert.match(ctx, /\b20\.0h\b|\b20h\b/, "the older receipt's age is named");
  } finally {
    cleanup();
  }
});

// =============================================================================
// SECTION D — H1's session-marker write is fail-open, but a FAILED write must
// never leave a PREVIOUS session's marker in place: stale positive identity
// evidence would make every current receipt read foreign. ABSENCE
// (unjudgeable) is the degraded state, never a survived stale positive.
// =============================================================================

function sessionMarkerPath(dir) {
  return join(dir, '.sterling', 'transient', 'session.json');
}

test(
  'R1-B53 (chmod FILE fixture): a pre-existing read-only session.json never survives SessionStart carrying its STALE content — cleared if the write failed, overwritten if it succeeded',
  () => {
    const { dir, cleanup } = makeH1Project();
    try {
      const markerPath = sessionMarkerPath(dir);
      mkdirSync(dirname(markerPath), { recursive: true });
      const STALE_MARKER = 'stale-old-session-id-do-not-survive';
      writeFileSync(markerPath, JSON.stringify({ session_id: STALE_MARKER, at: '2026-08-20T00:00:00.000Z' }));
      try {
        chmodSync(markerPath, 0o444);
      } catch {
        // chmod unsupported here — the fixture degrades to a plain writable
        // stale file; the assertion below still holds, since a normal write
        // would overwrite it anyway.
      }

      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /EACCES|EPERM|uncaught|TypeError/i, 'a fail-open marker write never surfaces an uncaught exception');

      if (existsSync(markerPath)) {
        assert.doesNotMatch(
          readFileSync(markerPath, 'utf8'),
          new RegExp(STALE_MARKER),
          'any marker file surviving SessionStart must not carry the STALE prior content — a surviving stale positive is the one outcome this pins against'
        );
      }
      try {
        chmodSync(markerPath, 0o644);
      } catch {
        // already gone or already writable — fine either way.
      }
    } finally {
      cleanup();
    }
  }
);

test(
  'R1-B54 (directory fixture): a session.json write target occupied by a non-empty DIRECTORY fails the write, and the stale marker does not survive',
  () => {
    const { dir, cleanup } = makeH1Project();
    try {
      const markerPath = sessionMarkerPath(dir);
      mkdirSync(markerPath, { recursive: true });
      writeFileSync(join(markerPath, 'stale-payload.txt'), 'stale prior session marker occupying the write target as a directory');

      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /EISDIR|ENOTEMPTY|uncaught|TypeError/i, 'a fail-open marker write never surfaces an uncaught exception, even against a directory');

      // DISCLOSED FIXTURE RISK: rmSync's `force` suppresses ENOENT only, not
      // EISDIR/ENOTEMPTY — a cleanup call without `recursive: true` fails this
      // assertion on a correct implementation too. R1-B53 is the arm immune to
      // that risk.
      assert.equal(existsSync(markerPath), false, 'the stale marker (any shape) does not survive a failed SessionStart write');
    } finally {
      cleanup();
    }
  }
);
