// REVIEW-LEDGER RECEIPT EXPIRY — Option B (board 09e03d76; decision
// review-ledger-receipt-expiry, knowledge_get 0408b295-13a7-4221-864c-
// 0bc929ae3337) — SPEC ONLY, red-first, authored from the DECISION RECORD +
// BOARD ITEM text, never from scripts/hooks/h22-review-ledger.mjs's or
// scripts/commit-reviewed.mjs's internals (H4 read wall honored — those two
// files were never opened by this author). Harness idioms (spawnSync + JSON
// stdin fixture style, git()/makeRepo() fixture style, H1's
// h1()/additionalContext() helper) are adapted, without importing or
// modifying, from scripts/tests/h22-review-ledger.test.mjs,
// scripts/tests/commit-reviewed.test.mjs,
// scripts/tests/commit-reviewed-spend-warnings.test.mjs, and
// scripts/tests/h1-session-residue.test.mjs — confirmed to exist via Glob
// before writing this file. This file is standalone: its own fixtures, no
// shared imports from any sibling test file.
//
// SPEC UNDER TEST (verbatim reading of the two records above):
//   1. H22's SubagentStop promotion path writes reviewer ledger entries
//      carrying session_id, branch, and base sha ALONGSIDE the existing
//      {agent_type, files, at} — existing fields unchanged.
//   2. commit-reviewed: a receipt whose session_id differs from the current
//      session, OR whose branch differs from the current branch, is
//      DISCLOSED-BUT-NOT-STAMPED (spend-warning-surface-or-equivalent naming
//      the foreign session/branch + the receipt's age) and is NOT consumed
//      into a Reviewed-By-Agent trailer stamp. A same-session, same-branch
//      receipt stamps and consumes exactly as today.
//   3. A foreign receipt is never silently deleted by the stamping path — it
//      survives in the ledger for H1 reporting.
//   4. H1 SessionStart reports surviving receipts with their ages.
//
// ASSUMPTIONS DISCLOSED (low-risk naming inferences from established
// same-file conventions, NOT resolutions of open ambiguities):
//   - New ledger-entry field names are snake_case `session_id`, `branch`,
//     `base_sha` — every sibling field in the register and the existing
//     ledger entry (agent_id, agent_type, session_id, files, at) is
//     snake_case; the decision's prose ("session_id, branch, and base sha")
//     names the first two exactly and gives "base sha" for the third.
//   - Ages are reported in the "N.Nh" / "Nh" convention already shipped in
//     scripts/commit-reviewed.mjs's staleness warning ("30.0h old" —
//     confirmed live via scripts/tests/commit-reviewed-spend-warnings.test.mjs
//     P5). Assertions below accept either "N.0h" or bare "Nh" to stay
//     tolerant of the exact decimal formatting.
//
// SPEC AMBIGUITIES FLAGGED — NOT RESOLVED (per explicit instruction: do not
// invent a resolution):
//   (a) BRANCH UNDER DETACHED HEAD: neither record defines what "branch"
//       means for a receipt promoted while HEAD is detached. Left
//       deliberately untested — see the skipped placeholder test below.
//   (b) HOW commit-reviewed.mjs (a bare CLI, not a hook) learns "the current
//       session": hooks receive session_id via Claude Code's stdin JSON: a
//       CLI invoked by `node scripts/commit-reviewed.mjs -m "..."` has no
//       such channel described anywhere in the two records, in the existing
//       commit-reviewed test files, or in a knowledge_query sweep for
//       "session_id"/"CLI"/"current session" (0 hits beyond the two records
//       already read). Section B's tests ASSUME the CLI reads
//       `process.env.STERLING_SESSION_ID`, chosen only because it matches
//       the STERLING_* env-var convention already used elsewhere in this
//       suite (STERLING_CURRENCY_DISABLE, STERLING_NO_BANNER,
//       STERLING_PLUGIN_ROOT) — disclosed, not asserted as ground truth. If
//       the real implementation uses a different channel, only the fixture
//       plumbing needs retargeting; the behavioral claims pinned (foreign
//       receipt never stamped, never deleted, disclosed with its identity +
//       age) do not change.
//   (c) EXACT `base_sha` DERIVATION: "base sha" is not defined as current
//       HEAD vs. a merge-base with a default/main branch. Section A pins
//       only that the field exists and is a plausible git-sha-shaped
//       string, never its precise git derivation.
//   (d) EXIT-CODE/REFUSAL SEMANTICS WHEN THE ONLY RECEIPT(S) PRESENT ARE ALL
//       FOREIGN: the pre-existing (already-shipped) contract refuses with
//       exit 1 when zero un-consumed entries exist. The new decision does
//       not restate whether an all-foreign ledger counts as "zero eligible"
//       (refuse) or is allowed to proceed as a bare commit. B1/B2 below are
//       written to hold under EITHER reading (they branch on the observed
//       exit code rather than asserting one), while B3 (a MIXED ledger,
//       where at least one eligible receipt exists) is unambiguous and
//       asserts a firm exit code of 0.
//   (e) EXACT VOCABULARY of the disclosure marker (commit-reviewed's stderr
//       line and H1's additionalContext line): neither record names one.
//       Assertions match on the REQUIRED substantive content instead (the
//       foreign session_id/branch value named verbatim; an hour-based age
//       figure) rather than a guessed keyword.

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

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// shared: flatten multi-line child stderr before interpolating into an
// assertion message (anti-pattern ee89c3fd).
// ---------------------------------------------------------------------------
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');

// Date.now()-relative ISO timestamps — never hardcoded dates, so staleness
// pins do not rot as the calendar moves.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

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
// SECTION A — H22 SubagentStop ledger promotion carries session_id/branch/
// base_sha alongside {agent_type, files, at}.
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

test(
  'A0 (CONTROL): promoting a reviewer-* entry still carries the pre-existing {agent_type, files, at} triple with the exact same values as today — a regression pin, independent of whether the new fields land',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject('main');
    try {
      writeRegisterRaw(dir, [registerEntry('rev-1', 'reviewer-correctness', ['src/a.mjs'], '2026-08-25T00:00:00.000Z')]);
      const r = runH22Hook(h22Input(dir, { agent_id: 'rev-1' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const ledger = readLedgerA(dir);
      assert.equal(ledger.length, 1);
      // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
      // standing): the CONTROL's intent (promotion works independent of whether the expiry fields land) is
      // unchanged — only the field homes moved, to the v2 envelope's reviewer.agent_type/territory.files/started_at.
      assert.equal(ledger[0].reviewer.agent_type, 'reviewer-correctness', 'agent_type unchanged by the receipt-expiry addition');
      assert.deepEqual(ledger[0].territory.files, ['src/a.mjs'], 'files unchanged');
      assert.equal(ledger[0].started_at, '2026-08-25T00:00:00.000Z', 'at (now started_at) unchanged');
    } finally {
      cleanup();
    }
  }
);

test(
  "A1: the promoted v2 entry's identity{} carries session_id (the register entry's session_id), branch (the git branch active in the hook's cwd), and a sha-shaped base_sha (per decision 57984926's v2 envelope)",
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeGitProject('sterling/board-fanout-3');
    try {
      writeRegisterRaw(dir, [registerEntry('rev-2', 'reviewer-security', ['src/b.mjs'], '2026-08-25T01:00:00.000Z', 's1')]);
      const r = runH22Hook(h22Input(dir, { agent_id: 'rev-2', session_id: 's1' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const ledger = readLedgerA(dir);
      assert.equal(ledger.length, 1);
      const entry = ledger[0];
      // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
      // standing): promotions now write the v2 entry envelope, not the flat six-key shape this pin originally
      // asserted. The expiry semantics this test actually cares about (session_id/branch/base_sha presence and
      // value) now live under identity{...} — same assertions, ruled v2 home.
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['content_evidence', 'disposition', 'entry_id', 'finished_at', 'identity', 'kind', 'reviewer', 'schema_version', 'started_at', 'status', 'territory'],
        'decision 57984926: every new promotion is a v2 entry — exactly these eleven top-level keys, nothing extra'
      );
      assert.equal(
        entry.identity.session_id,
        's1',
        "the register entry's session_id is carried through — TODAY's shipped promotion deliberately EXCLUDES session_id (see h22-review-ledger.test.mjs's pin: 'NOT the register's agent_id/session_id'); this decision reverses exactly that exclusion"
      );
      assert.equal(entry.identity.branch, 'sterling/board-fanout-3', "branch matches the git branch active in the hook's cwd at promotion time");
      assert.match(entry.identity.base_sha, /^[0-9a-f]{7,40}$/i, 'base_sha is a plausible git sha string — its exact derivation (HEAD vs. merge-base) is unspecified and not pinned here');
    } finally {
      cleanup();
    }
  }
);

test('A2: a cwd with no git repository at all still promotes the reviewer entry without crashing — session_id/branch/base_sha degrade rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-expiry-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    writeRegisterRaw(dir, [registerEntry('rev-3', 'reviewer-performance', ['src/c.mjs'], '2026-08-25T02:00:00.000Z')]);
    const r = runH22Hook(h22Input(dir, { agent_id: 'rev-3' }), dir);
    assert.notEqual(r.code, 2, 'a git-repo-less cwd must never cause the hook to deny/crash the SubagentStop boundary');
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedgerA(dir);
    assert.equal(ledger.length, 1, 'the reviewer entry is still promoted even though branch/base_sha cannot be resolved');
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): agent_type now lives at reviewer.agent_type on a v2-promoted entry.
    assert.equal(ledger[0].reviewer.agent_type, 'reviewer-performance');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Flagged, not resolved (ambiguity (a) above): what "branch" means for a
// receipt promoted while HEAD is detached is undefined by either record.
test('AMBIGUITY (flagged, not resolved): branch identity under a detached HEAD is unspecified by decision review-ledger-receipt-expiry — deliberately left untested', {
  skip: 'spec ambiguity: neither the decision record nor the board item defines "branch" for a detached-HEAD promotion; no resolution is invented here per explicit instruction',
}, () => {});

// =============================================================================
// SECTION B — commit-reviewed: foreign session/branch is disclosed-but-not-
// stamped; a matching receipt stamps/consumes exactly as today; a foreign
// receipt is never silently deleted.
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
  mkdirSync(join(dir, '.sterling'), { recursive: true });
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

function runCommitReviewed(dir, args = [], envOverride = {}) {
  const r = spawnSync(process.execPath, [COMMIT_REVIEWED_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...envOverride },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readTrailerValues(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

test(
  'B0 (CONTROL): a receipt matching BOTH the current session_id (assumed via STERLING_SESSION_ID) and the current branch stamps and consumes exactly as today',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeRepo('main');
    try {
      stageChange(dir);
      writeLedgerB(dir, [
        { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: isoAgo(1_000), session_id: 's1', branch: 'main', base_sha: 'd'.repeat(40) },
      ]);
      const r = runCommitReviewed(dir, ['-m', 'B0 control'], { STERLING_SESSION_ID: 's1' });
      assert.equal(r.code, 0, `same-session/same-branch must still succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readTrailerValues(dir).length, 1, 'the matching receipt still gets its trailer');
      assert.deepEqual(readLedgerB(dir), [], 'the matching receipt is still fully consumed');
    } finally {
      cleanup();
    }
  }
);

test(
  'B1: a receipt whose session_id differs from the current session is never stamped and never deleted; the disclosure names the foreign session_id and the receipt\'s age — holds under either reading of the lone-foreign-receipt exit-code ambiguity (see file header, ambiguity d)',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeRepo('main');
    try {
      stageChange(dir);
      writeLedgerB(dir, [
        { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: isoAgo(2 * 3_600_000), session_id: 'foreign-session-xyz', branch: 'main', base_sha: 'a'.repeat(40) },
      ]);
      const r = runCommitReviewed(dir, ['-m', 'B1 foreign session'], { STERLING_SESSION_ID: 's1' });

      if (r.code === 0) {
        assert.equal(readTrailerValues(dir).length, 0, 'if the commit succeeds bare, the foreign-session receipt must not be among the stamped trailers');
      }
      const ledgerAfter = readLedgerB(dir);
      assert.equal(ledgerAfter.length, 1, 'the foreign-session receipt survives — disclosed, never silently deleted, regardless of exit code');
      assert.equal(ledgerAfter[0].session_id, 'foreign-session-xyz');

      assert.match(r.stderr, /foreign-session-xyz/, 'the disclosure names the foreign session_id verbatim');
      assert.match(r.stderr, /\b2\.0h\b|\b2h\b/, `the disclosure names the receipt's age (~2h) — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
);

test(
  'B2: a receipt whose branch differs from the current branch is never stamped and never deleted; the disclosure names the foreign branch and the receipt\'s age — holds under either reading of the lone-foreign-receipt exit-code ambiguity',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeRepo('main');
    try {
      stageChange(dir);
      writeLedgerB(dir, [
        {
          agent_type: 'reviewer-correctness',
          files: ['src/feature.mjs'],
          at: isoAgo(4 * 3_600_000),
          session_id: 's1',
          branch: 'sterling/some-other-slice',
          base_sha: 'b'.repeat(40),
        },
      ]);
      const r = runCommitReviewed(dir, ['-m', 'B2 foreign branch'], { STERLING_SESSION_ID: 's1' });

      if (r.code === 0) {
        assert.equal(readTrailerValues(dir).length, 0, 'if the commit succeeds bare, the foreign-branch receipt must not be among the stamped trailers');
      }
      const ledgerAfter = readLedgerB(dir);
      assert.equal(ledgerAfter.length, 1, 'the foreign-branch receipt survives — disclosed, never silently deleted, regardless of exit code');
      assert.equal(ledgerAfter[0].branch, 'sterling/some-other-slice');

      assert.match(r.stderr, /sterling\/some-other-slice/, 'the disclosure names the foreign branch verbatim');
      assert.match(r.stderr, /\b4\.0h\b|\b4h\b/, `the disclosure names the receipt's age (~4h) — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
);

test(
  'B3: a mixed ledger (1 eligible + 1 foreign-session) commits successfully, stamps ONLY the eligible entry, and the foreign entry survives un-consumed and disclosed',
  { skip: GIT_SKIP },
  () => {
    const { dir, cleanup } = makeRepo('main');
    try {
      stageChange(dir);
      writeLedgerB(dir, [
        { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: isoAgo(1_000), session_id: 's1', branch: 'main', base_sha: 'b'.repeat(40) },
        { agent_type: 'reviewer-security', files: ['src/feature.mjs'], at: isoAgo(3 * 3_600_000), session_id: 'foreign-session-abc', branch: 'main', base_sha: 'c'.repeat(40) },
      ]);
      const r = runCommitReviewed(dir, ['-m', 'B3 mixed'], { STERLING_SESSION_ID: 's1' });
      assert.equal(r.code, 0, `at least one eligible entry exists, so the commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

      const trailers = readTrailerValues(dir);
      assert.deepEqual(trailers, ['reviewer-correctness'], 'only the eligible receipt is stamped — the foreign one is excluded');

      const ledgerAfter = readLedgerB(dir);
      assert.equal(ledgerAfter.length, 1, 'exactly the foreign entry survives, un-consumed');
      assert.equal(ledgerAfter[0].session_id, 'foreign-session-abc');

      assert.match(r.stderr, /foreign-session-abc/, 'disclosure names the surviving foreign receipt');
      assert.match(r.stderr, /\b3\.0h\b|\b3h\b/, `disclosure names its age — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
);

// =============================================================================
// SECTION C — H1 SessionStart reports surviving receipts with their ages.
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

test('C0 (CONTROL): SessionStart with no review-ledger.json at all reports nothing about receipts', () => {
  const { dir, cleanup } = makeH1Project();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(additionalContext(r) ?? '', /review.?receipt/i, 'nothing to report — no ledger file exists');
  } finally {
    cleanup();
  }
});

test("C1: SessionStart with ONE surviving ledger receipt reports it with its age in additionalContext", () => {
  const { dir, cleanup } = makeH1Project();
  try {
    writeH1Ledger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/a.mjs'], at: isoAgo(5 * 3_600_000), session_id: 'old-session', branch: 'main', base_sha: 'd'.repeat(40) },
    ]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r) ?? '';
    assert.match(ctx, /review.?receipt/i, 'the surviving receipt is named in additionalContext — exact vocabulary unspecified, matched loosely (ambiguity e)');
    assert.match(ctx, /\b5\.0h\b|\b5h\b/, "the receipt's age is reported, in the same 'Xh' convention already shipped in commit-reviewed's staleness warning");
  } finally {
    cleanup();
  }
});

test('C2: SessionStart with TWO surviving receipts names the count and both ages in additionalContext', () => {
  const { dir, cleanup } = makeH1Project();
  try {
    writeH1Ledger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/a.mjs'], at: isoAgo(1 * 3_600_000), session_id: 's-x', branch: 'main', base_sha: 'e'.repeat(40) },
      { agent_type: 'reviewer-security', files: ['src/b.mjs'], at: isoAgo(20 * 3_600_000), session_id: 's-y', branch: 'main', base_sha: 'f'.repeat(40) },
    ]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r) ?? '';
    assert.match(ctx, /\b2\b/, 'the count of surviving receipts (2) is named somewhere in the report');
    assert.match(ctx, /\b1\.0h\b|\b1h\b/, "the fresher receipt's age is named");
    assert.match(ctx, /\b20\.0h\b|\b20h\b/, "the older receipt's age is named");
  } finally {
    cleanup();
  }
});

// =============================================================================
// SECTION D — coordinator follow-up (MEDIUM, reviewer-required): H1's own
// session-marker write (.sterling/transient/session.json) is fail-open, but a
// FAILED write must never leave a PREVIOUS (stale) session's marker in place —
// stale positive identity evidence would make every current receipt read
// foreign and hard-refuse the gate falsely. The landed fix: H1's catch now
// best-effort rmSync's the marker, so ABSENCE (unjudgeable -> eligible) is the
// degraded state, never a survived stale positive.
//
// NEW INFORMATION surfaced by this follow-up, noted but NOT retrofitted into
// Section B above (out of this addition's scope; flagged for the coordinator
// rather than silently changing an existing pin): H1 apparently writes a
// session-identity marker to .sterling/transient/session.json at
// SessionStart. This may be the real channel other tools (e.g.
// commit-reviewed.mjs) use to learn "the current session" — which Section B
// only ASSUMED was process.env.STERLING_SESSION_ID (ambiguity (b) in the file
// header), a channel this file never found confirmed anywhere. This section
// does not change that assumption or Section B's tests; it is scoped only to
// H1's own write-then-fail-open-cleanup behavior, driven the same way as
// Section C (this file's own h1()/additionalContext() helpers, not imported
// from any other test file).
//
// TWO independent fixtures are used because a directory-shaped write target
// (the coordinator's own suggested fixture) carries a disclosed Node.js risk:
// fs.rmSync's `force:true` suppresses ENOENT ONLY — it does NOT suppress
// EISDIR/ENOTEMPTY for an existing directory; only `recursive:true` does. If
// H1's best-effort cleanup call omits `recursive:true` (plausible: the
// marker is normally expected to be a plain FILE), the directory-fixture test
// below can fail even against a CORRECT implementation, for a fixture reason
// unrelated to the defect being guarded against. The companion
// chmod-read-only-FILE fixture is immune to that specific risk (rmSync on a
// plain file needs no `recursive:true`), so it is presented FIRST as the more
// reliable pin, with the directory fixture second as the coordinator's
// literally-requested form, its own risk disclosed inline.
// =============================================================================

function sessionMarkerPath(dir) {
  return join(dir, '.sterling', 'transient', 'session.json');
}

test(
  'D0 (reachable-half, chmod-based FILE fixture): a pre-existing stale session.json marker made read-only never survives SessionStart with its STALE content — true whether the write failed (marker cleared) or actually succeeded (marker overwritten with fresh content)',
  () => {
    const { dir, cleanup } = makeH1Project();
    try {
      const markerPath = sessionMarkerPath(dir);
      mkdirSync(dirname(markerPath), { recursive: true });
      const STALE_MARKER = 'stale-old-session-id-do-not-survive';
      writeFileSync(markerPath, JSON.stringify({ session_id: STALE_MARKER, at: '2026-08-20T00:00:00.000Z' }));
      // Best-effort: on a host/user where chmod does not actually block the
      // write (e.g. running as root, or a filesystem ignoring POSIX
      // write-protection), this simply lets the write succeed instead — see
      // the assertion below, which holds either way.
      try {
        chmodSync(markerPath, 0o444);
      } catch {
        // chmod itself unsupported on this host — fixture degrades to a
        // plain writable stale file; the assertion below still holds
        // because a normal SessionStart write would overwrite it anyway.
      }

      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /EACCES|EPERM|uncaught|TypeError/i, 'a fail-open marker write must never surface an uncaught exception, even under a permission failure');

      if (existsSync(markerPath)) {
        const content = readFileSync(markerPath, 'utf8');
        assert.doesNotMatch(
          content,
          new RegExp(STALE_MARKER),
          'if ANY marker file exists after SessionStart, it must not carry the STALE prior content — either the failed write cleared it (absence = the degraded state) or the write actually succeeded and overwrote it with fresh content; a surviving STALE positive is the one outcome this pins against'
        );
      }
      // chmod is restored so cleanup() can rmSync the temp dir without EACCES.
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
  'D1 (PRIMARY, coordinator-specified directory fixture): a session.json write target occupied by a non-empty directory makes the write fail, and the stale marker does not survive SessionStart — KNOWN FIXTURE RISK disclosed inline (see Section D header)',
  () => {
    const { dir, cleanup } = makeH1Project();
    try {
      const markerPath = sessionMarkerPath(dir);
      mkdirSync(markerPath, { recursive: true });
      writeFileSync(join(markerPath, 'stale-payload.txt'), 'stale prior session marker occupying the write target as a directory, so writeFileSync cannot overwrite it');

      const r = h1(dir, 'startup');
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /EISDIR|ENOTEMPTY|uncaught|TypeError/i, 'a fail-open marker write must never surface an uncaught exception, even when the write target is a directory');

      // PRIMARY pin, as specified by the coordinator: the stale marker does
      // not survive. DISCLOSED FIXTURE RISK (see Section D header): if H1's
      // best-effort cleanup call is `rmSync(path, { force: true })` WITHOUT
      // `recursive: true`, this assertion fails on ANY implementation,
      // correct or not, purely because rmSync cannot remove a non-empty
      // directory without `recursive: true` and `force` does not substitute
      // for it. D0 above is the fixture immune to this specific risk.
      assert.equal(existsSync(markerPath), false, 'the stale marker (any shape) does not survive H1 SessionStart when its write failed');
    } finally {
      cleanup();
    }
  }
);
