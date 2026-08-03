// Direct merge [S] (spec §8.2): the conductor-direct counterpart to the §8.1
// merge gate (merge-gate.mjs). The human invoking it IS the merge-to-main
// decision — Sterling's second gate — so run it only once the change is
// committed and reconciled. It merges the current conductor-direct branch
// --no-ff into the base, then gives direct mode the branch hygiene runs already
// get from mergeRun: deletes the merged branch and sweeps every other
// fully-merged branch (git branch -d — refuses unmerged, never loses work).
// Refuses during an active run (a run merges through merge-gate.mjs, which keeps
// the disposal/promotion gate), on a dirty tree, or when already on the base.
//   node scripts/direct-merge.mjs [--into <branch>] [--branch <branch>] [--target <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, fail, openProject } from './lib/project.mjs';
import { isGitRepo, currentBranch, defaultBranch, mergeBranchInto, sweepMergedBranches } from './lib/branch-manager.mjs';
import { defaultExec } from './lib/update.mjs';

const target = arg('--target') ?? process.cwd();
if (!isGitRepo(target)) fail('direct-merge: not a git repository');

// A run owns the working tree and merges through the §8.1 gate, which runs
// disposal + promotion first — never route a run merge through here (P5).
const { store } = openProject(target);
const active = store.getRun();
const openTodos = store.query({ types: ['todo'], cap: 1000 });
store.close();
if (active) {
  fail(`direct-merge: run '${active.id}' is active (${active.machine_state}) — a run merges through merge-gate.mjs, not direct-merge`);
}

const into = arg('--into') ?? defaultBranch(target);
const branch = arg('--branch') ?? currentBranch(target);
if (branch === into) {
  fail(
    `direct-merge: currently on the base branch '${into}' — checkout the branch to merge, or pass --branch.\n` +
      `If a merge just completed here, the work is ALREADY on ${into} and its branch was deleted:\n` +
      `check 'git log --oneline -3 ${into}' before merging anything again. A gate that exits\n` +
      `non-zero after a SUCCESSFUL merge (stale bundles / failed sweep) says so on its first line.`
  );
}

// Cheap git precondition BEFORE the expensive checks (P1). mergeBranchInto keeps
// its own dirty-tree gate as the invariant, but that gate sits AFTER the
// multi-minute battery, so a dirty tree used to cost the whole battery and then
// throw a RAW branch-manager stack. Checking here fails in ~2s with a message
// that routes through fail(). The remedy text deliberately does NOT tell you to
// "commit or discard": that advice was actively wrong for untracked documents
// whose disposition is a user decision, so tracked and untracked are separated
// and untracked files are named as a choice rather than an obstacle.
const dirtyCheck = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (dirtyCheck.status !== 0) {
  fail(`direct-merge: git status --porcelain failed (${dirtyCheck.status}): ${(dirtyCheck.stderr || dirtyCheck.stdout || '').trim()}`);
}
const dirtyLines = dirtyCheck.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
if (dirtyLines.length > 0) {
  const untracked = dirtyLines.filter((l) => l.startsWith('??'));
  // Unmerged paths carry a U on either side, plus the DD/AA both-side cases. They
  // are dirty, but "commit or discard" is the WRONG remedy for a conflicted tree —
  // misprescribing here is the exact defect this refusal was rewritten to stop.
  const unmerged = dirtyLines.filter((l) => /^(DD|AA|.U|U.)/.test(l.slice(0, 2)));
  const tracked = dirtyLines.filter((l) => !l.startsWith('??') && !unmerged.includes(l));
  const parts = [`direct-merge: working tree is dirty — refusing before the battery (a merge must not carry uncommitted state across branches)`];
  if (unmerged.length > 0) {
    parts.push(
      `\n${unmerged.length} UNMERGED path(s) — a merge or rebase is already in progress here:`,
      ...unmerged.map((l) => `  ${l}`),
      '  → resolve the conflicts and commit, or abort that operation',
      '    (git merge --abort / git rebase --abort). Do NOT start another merge on top.'
    );
  }
  if (tracked.length > 0) {
    parts.push(`\n${tracked.length} tracked change(s):`, ...tracked.map((l) => `  ${l}`), '  → commit them on this branch, or discard them.');
  }
  if (untracked.length > 0) {
    parts.push(
      `\n${untracked.length} untracked path(s):`,
      ...untracked.map((l) => `  ${l}`),
      '  → these may not be yours to commit. Decide their disposition first —',
      '    commit, .gitignore, move out of the repo, or remove. The gate does not',
      '    choose for you, and "commit or discard" is not always the right answer.'
    );
  }
  fail(parts.join('\n'));
}

// Gate precondition (merge.md): every affected article reconciled. Open
// reconcile_needed debt on files this branch changed refuses the merge — the
// §8.2 mirror of dispose-run's article_unreconciled refusal (decision 9df61181).
const diff = spawnSync('git', ['diff', '--name-only', '--end-of-options', `${into}...${branch}`], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (diff.status !== 0) fail(`direct-merge: git diff ${into}...${branch} failed: ${(diff.stderr || '').trim()}`);
const changed = new Set(diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
const debt = openTodos.filter(
  (t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && (t.file_keys ?? []).some((k) => changed.has(k))
);
if (debt.length > 0) {
  fail(
    `direct-merge: ${debt.length} open reconcile_needed item(s) cover files this branch changed — reconcile before merging:\n` +
      debt.map((t) => `  - ${t.id}  ${t.text}  [${(t.file_keys ?? []).join(', ')}]`).join('\n') +
      '\nknowledge_update the owning article (the update auto-drains its item), then rerun.'
  );
}

// Consistency-check battery at the gate (R2 board 2e443375): the invariant-3
// checkers were bound to no mechanical event — `npm run check` existed but only
// prose invoked it, so registry/skill/bundle/projection drift could merge
// silently. The gate is where the cost of being wrong jumps (P1). Projects
// without a check script (consuming projects, test fixtures) skip LOUDLY.
const pkgJsonPath = join(target, 'package.json');
const hasCheck = existsSync(pkgJsonPath) && !!JSON.parse(readFileSync(pkgJsonPath, 'utf8')).scripts?.check;
if (hasCheck) {
  console.error('direct-merge: running the consistency-check battery (npm run check)…');
  // Through defaultExec, NOT a bare spawnSync: `npm` resolves through a .cmd shim
  // on native Windows that spawn cannot exec directly, so a bare call returned
  // ENOENT with status null and EMPTY stdout/stderr — the gate then reported
  // "battery FAILED" with nothing after the colon, on every Windows merge, for a
  // battery that passes. Undiagnosable by construction (P5), and it blocked the
  // gate rather than opening it, which is why it survived unnoticed. defaultExec
  // owns the shell/quoting rule and normalizes a spawn error into status 1 with
  // the message in stderr, so a future failure prints something readable.
  const check = defaultExec('npm', ['run', 'check'], { cwd: target, timeout: 300_000 });
  if (check.status !== 0) {
    fail(`direct-merge: the consistency-check battery FAILED — fix before merging:\n${check.stdout + check.stderr}`);
  }
} else {
  console.error("direct-merge: no `check` script in the target's package.json — battery skipped (loud)");
}

// branch-manager throws raw Errors (it is a library, shared with the §8.1 gate and
// the MCP server, so it cannot process.exit). Routing them through fail() here
// gives the gate ONE failure shape instead of a stack trace after the battery.
let merged;
let swept;
try {
  merged = mergeBranchInto({ cwd: target, branch, into });
} catch (e) {
  fail(`direct-merge: ${e?.message ?? e}`);
}
// The sweep runs in its OWN try: once the merge has landed, a sweep failure must
// not be reported as "the merge failed". That misreading is what teaches an
// operator to hand-merge, which is the whole point of board f37e1dae.
try {
  swept = sweepMergedBranches({ cwd: target, into });
} catch (e) {
  console.error(
    [
      '',
      `direct-merge: THE MERGE SUCCEEDED (${branch} → ${into}) — do NOT merge again.`,
      `Only the post-merge branch sweep failed: ${e?.message ?? e}`,
      `Sweep merged branches manually when convenient: git branch --merged ${into}`,
    ].join('\n')
  );
  console.log(JSON.stringify({ ...merged, branches_swept: null, sweep_failed: true }, null, 2));
  process.exit(1);
}

// POST-merge bundle freshness — the one staleness the battery structurally cannot
// see. check-bundles-fresh runs BEFORE the merge, but git's auto-merge of
// hooks/*.mjs does not equal a fresh esbuild of the MERGED source: after the
// 2026-08-03 two-branch merge, h20's bundle had been built against pre-digest
// store code and needed a rebuild (commit 1de585d), which the gate never flagged
// because its battery had already passed. Re-checking after the merge closes it.
// Sterling-specific, so it runs only where the checker exists.
//
// THE REBUILD IS LOAD-BEARING, NOT A CONVENIENCE (r-review finding (e)):
// packages/*/dist/ is GITIGNORED, so it survives the checkout to `into` and still
// holds the pre-merge build. check-bundles-fresh resolves each hook's workspace
// imports into that dist, so a stale dist makes the temp build and the shipped
// bundle vendor byte-IDENTICAL stale code — they compare equal and the check
// PASSES on exactly the staleness it exists to catch. That is the 1de585d case.
// Pre-merge this hole is covered by check-totality's stale-dist guard aborting the
// whole battery; invoking the bundle checker ALONE has no such precondition, so
// the dist must be rebuilt from the merged source first or the arm is theatre.
const bundleChecker = join(target, 'scripts', 'check-bundles-fresh.mjs');
if (existsSync(bundleChecker)) {
  console.error('direct-merge: rebuilding packages so the post-merge bundle check compares against MERGED source…');
  const rebuilt = defaultExec('npm', ['run', 'build'], { cwd: target, timeout: 600_000 });
  if (rebuilt.status !== 0) {
    console.error(
      [
        '',
        `direct-merge: THE MERGE SUCCEEDED (${branch} → ${into}) — do NOT merge again.`,
        'But `npm run build` FAILED on the merged tree, so bundle freshness could NOT be',
        `verified — the merged source may not even compile. Fix this on ${into} now:`,
        '  npm run build && npm run build:hooks',
        (rebuilt.stdout + rebuilt.stderr).trim(),
      ].join('\n')
    );
    console.log(JSON.stringify({ ...merged, branches_swept: swept, bundles_unverified: true }, null, 2));
    process.exit(1);
  }
  const bundles = spawnSync(process.execPath, [bundleChecker], { cwd: target, encoding: 'utf8', timeout: 300_000 });
  if (bundles.status !== 0) {
    console.error(
      [
        '',
        `direct-merge: THE MERGE SUCCEEDED (${branch} → ${into}) — but the shipped bundles are now STALE.`,
        'git auto-merged hook sources without rebuilding them, so the enforcement surface',
        `that actually runs no longer matches its source on ${into}. Fix it now, on ${into}:`,
        '  npm run build && npm run build:hooks',
        '  git add -A hooks && git commit -m "fix: rebuild bundles after merge"',
        'Checker output:',
        (bundles.stdout + bundles.stderr).trim(),
      ].join('\n')
    );
    console.log(JSON.stringify({ ...merged, branches_swept: swept, bundles_stale: true }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({ ...merged, branches_swept: swept }, null, 2));
