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
import { matchesGlob } from '@sterling/schemas';

const target = arg('--target') ?? process.cwd();
if (!isGitRepo(target)) fail(`direct-merge: not a git repository: '${target}'`);

// A run owns the working tree and merges through the §8.1 gate, which runs
// disposal + promotion first — never route a run merge through here (P5).
const { store, config } = openProject(target);
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
// -c core.quotePath=false (r-review F3, applied here too for consistency): without
// it, non-ASCII filenames arrive C-quoted and defeat matchesGlob's plain-string glob
// comparisons further down.
const diff = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--end-of-options', `${into}...${branch}`], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (diff.status !== 0) fail(`direct-merge: git diff ${into}...${branch} failed: ${(diff.stderr || '').trim()}`);
const changed = new Set(diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
const debt = openTodos.filter(
  (t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && (t.file_keys ?? []).some((k) => changed.has(k))
);
if (debt.length > 0) {
  // GROUP BY OWNING ARTICLE (N13): one item per touched file is the mint
  // granularity, so a branch touching one heavily-shared file can carry
  // hundreds of near-identical items — measured 207 lines (~40KB) for a
  // single refusal. Group by feature_link (the owning article id H7 stamps)
  // so the refusal reads as N ARTICLES, not N items; every item id stays
  // listed, nested under its group, so nothing here is lossy — only the
  // presentation is denser. Items with NO feature_link (older/foreign
  // items) all share ONE bucket — keying that bucket per-item (e.g. by
  // t.id) reproduces the exact fragmentation this fix exists to remove for
  // the legacy case: 50 unlinked items would headline as "across 50
  // article(s)" instead of the 1 real article plus a single miscellaneous
  // bucket. The headline's article count is REAL articles only — the
  // no-article bucket, if present, is named separately and never inflates it.
  const NO_ARTICLE_KEY = Symbol('no-owning-article');
  const byArticle = new Map();
  for (const t of debt) {
    const key = t.feature_link ?? NO_ARTICLE_KEY;
    if (!byArticle.has(key)) byArticle.set(key, []);
    byArticle.get(key).push(t);
  }
  const realArticleCount = [...byArticle.keys()].filter((k) => k !== NO_ARTICLE_KEY).length;
  const noArticleItems = byArticle.get(NO_ARTICLE_KEY) ?? [];
  const grouped = [...byArticle.entries()]
    .map(([article, items]) => {
      const header = article === NO_ARTICLE_KEY ? `(no owning article) — ${items.length} item(s)` : `article ${article} — ${items.length} item(s)`;
      // Each item keeps its OWN file_keys on its own line (Codex P2-A): a
      // header union loses the item→files association the un-grouped
      // format used to carry — two items in one group touching different
      // files must not read as though either touched both.
      return `  - ${header}\n` + items.map((t) => `      - ${t.id}  ${t.text}  [${(t.file_keys ?? []).join(', ')}]`).join('\n');
    })
    .join('\n');
  const headline =
    noArticleItems.length > 0
      ? `${debt.length} open reconcile_needed item(s) across ${realArticleCount} article(s) (plus ${noArticleItems.length} item(s) with no owning article)`
      : `${debt.length} open reconcile_needed item(s) across ${realArticleCount} article(s)`;
  fail(
    `direct-merge: ${headline} cover files this branch changed — reconcile before merging:\n` +
      grouped +
      '\nknowledge_update the owning article (the update auto-drains its item), then rerun.'
  );
}

// REVIEW-RECEIPT MERGE GATE (board d3752b2e): the §8.2 mirror of the reconcile
// refusal just above (decision 9df61181) — a second pre-merge debt check, same
// battery slot. A CODE-TOUCHING commit (its diff hits >=1 path matching the
// project's registered toolchain path_globs, read from .sterling/config.json —
// never hardcoded, so a project without a `**/*.ts`-style adapter never gates
// on paths it never declared) must carry a `Reviewed-By-Agent` git trailer; a
// docs-only commit is exempt. Missing receipts refuse the merge before any
// merge action, naming each offending commit and both remedies. --waive-reviews
// "<reason>" lets the merge proceed but must never do so silently (P5) — every
// waived commit is named, with the reason, in the output.
const commitsRaw = spawnSync('git', ['log', '--format=%H', `${into}..${branch}`], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (commitsRaw.status !== 0) fail(`direct-merge: git log ${into}..${branch} failed: ${(commitsRaw.stderr || '').trim()}`);
const branchCommits = commitsRaw.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
const pathGlobs = (config.toolchains ?? []).flatMap((t) => t.path_globs ?? []);
const unreviewed = [];
for (const sha of branchCommits) {
  // Multi-parent (merge) commits emit NOTHING from a plain `diff-tree --name-only`
  // (r-review F1) — the default diff-tree suppresses merge diffs entirely, so a
  // merge commit whose conflict resolution touched code classified as docs-only.
  // Detect the parent count and, for a merge, diff with `--cc` (condensed combined
  // diff): it lists exactly the paths that differ from EVERY parent, i.e. the
  // hand-written resolution content — a clean auto-merge (identical to at least
  // one parent's side) stays exempt, which is correct: no new content was written.
  const parentsRaw = spawnSync('git', ['rev-parse', `${sha}^@`], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  if (parentsRaw.status !== 0) fail(`direct-merge: git rev-parse ${sha}^@ failed: ${(parentsRaw.stderr || '').trim()}`);
  const isMerge = parentsRaw.stdout.split('\n').map((l) => l.trim()).filter(Boolean).length > 1;
  const diffTreeArgs = isMerge
    ? ['-c', 'core.quotePath=false', 'diff-tree', '--cc', '--no-commit-id', '--name-only', '-r', sha]
    : ['-c', 'core.quotePath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha];
  const filesRaw = spawnSync('git', diffTreeArgs, { cwd: target, encoding: 'utf8', timeout: 30_000 });
  if (filesRaw.status !== 0) fail(`direct-merge: git diff-tree ${sha} failed: ${(filesRaw.stderr || '').trim()}`);
  const files = filesRaw.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const codeTouching = files.some((f) => pathGlobs.some((g) => matchesGlob(f, g)));
  if (!codeTouching) continue;
  const trailerRaw = spawnSync(
    'git',
    ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha],
    { cwd: target, encoding: 'utf8', timeout: 30_000 }
  );
  // A trailer with an EMPTY value is treated as ABSENT, deliberately (r-review F2,
  // adjudicated by the conductor): a receipt naming nobody is not a receipt. `.trim()`
  // on an empty/whitespace-only value falls through to the unreviewed list below.
  if ((trailerRaw.stdout ?? '').trim()) continue; // receipt present
  const short = spawnSync('git', ['rev-parse', '--short', sha], { cwd: target, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  const subject = spawnSync('git', ['log', '-1', '--format=%s', sha], { cwd: target, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  unreviewed.push({ sha, short, subject });
}
if (unreviewed.length > 0) {
  const waivePresent = process.argv.includes('--waive-reviews');
  const waiveReason = arg('--waive-reviews');
  if (waivePresent) {
    // r-review F2: a present-but-empty reason is refused with an explicit message,
    // never the generic missing-receipt refusal below — the flag was invoked, so
    // the operator gets told what is actually wrong with the invocation.
    if (!waiveReason || !waiveReason.trim()) {
      fail(`direct-merge: --waive-reviews requires a non-empty reason`);
    }
    console.error(
      `direct-merge: --waive-reviews WAIVED the review-receipt gate for ${unreviewed.length} code-touching commit(s) — reason: ${waiveReason}\n` +
        unreviewed.map((c) => `  - ${c.short}  ${c.subject}`).join('\n')
    );
  } else {
    fail(
      `direct-merge: ${unreviewed.length} code-touching commit(s) on this branch are missing a 'Reviewed-By-Agent' review-receipt trailer — reconcile before merging:\n` +
        unreviewed.map((c) => `  - ${c.short}  ${c.subject}`).join('\n') +
        `\nRemedy: amend the commit(s) to record a 'Reviewed-By-Agent: <reviewer>' trailer, then rerun.\n` +
        `Or, to proceed anyway: rerun with --waive-reviews "<reason>" (never silent — the waiver is echoed at merge time).`
    );
  }
}

// VERSION MOVES WITH THE MERGE (decision be9168e8 + user directive 2026-08-05
// "bump the version when you push"). The plugin version is the clone-currency
// signal consumers read, and be9168e8 deferred automating the bump "until the
// rule is observed to fail" — it failed on 2026-08-05 (a feature merge shipped
// unbumped), so the gate now holds it: a branch whose diff goes beyond the
// generated projections must move BOTH version fields together (be9168e8:
// package.json and plugin.json move in the same commit). Fixture repos and
// consuming projects have no plugin manifest — skipped loud. --allow-same-version
// is the deliberate escape for a merge that genuinely deserves no bump.
const GENERATED_ONLY = new Set(['architecture.md', 'rulings.md']);
const pluginManifestRel = '.claude-plugin/plugin.json';
if (existsSync(join(target, pluginManifestRel))) {
  const substantive = [...changed].filter((f) => !GENERATED_ONLY.has(f));
  if (substantive.length > 0 && !process.argv.includes('--allow-same-version')) {
    const readVersion = (raw, label) => {
      try {
        return JSON.parse(raw).version ?? null;
      } catch {
        fail(`direct-merge: could not parse ${label} while checking the version bump`);
      }
    };
    const pkgPath = join(target, 'package.json');
    const branchPlugin = readVersion(readFileSync(join(target, pluginManifestRel), 'utf8'), pluginManifestRel);
    const branchPkg = existsSync(pkgPath) ? readVersion(readFileSync(pkgPath, 'utf8'), 'package.json') : null;
    const baseShow = spawnSync('git', ['show', `${into}:${pluginManifestRel}`], { cwd: target, encoding: 'utf8', timeout: 30_000 });
    const basePlugin = baseShow.status === 0 ? readVersion(baseShow.stdout, `${into}:${pluginManifestRel}`) : null;
    if (branchPkg !== null && branchPlugin !== branchPkg) {
      fail(
        `direct-merge: version fields DIVERGED — ${pluginManifestRel} is ${branchPlugin}, package.json is ${branchPkg}. ` +
          `They move together in the same commit (decision be9168e8). Align them, commit, rerun.`
      );
    }
    if (basePlugin !== null && branchPlugin === basePlugin) {
      fail(
        `direct-merge: the plugin version (${branchPlugin}) did not move, but this branch changes ${substantive.length} file(s) beyond the generated projections.\n` +
          `The version is the clone-currency signal consumers read (decision be9168e8): bump BOTH ${pluginManifestRel} and package.json\n` +
          `(0.x rule: breaking → MINOR, additive → PATCH), commit, rerun. If this merge genuinely deserves no bump, rerun with --allow-same-version.`
      );
    }
  }
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

// PARKED-FILE ITEMS CLOSE ON THE MERGE, because the merge is the event that ends
// their life (P4 — board 1d6a721a). A file_parked item says "this owned file is
// absent here but alive on another ref"; landing that ref makes the statement
// false, and no WRITE can close it, so it has no artifact-write binding like the
// drift lanes do. Without this sweep it would linger as permanent noise — which
// is the same complaint the lane was created to answer, one lane over.
//
// Deliberately AFTER the merge and outside any fail() path: this is bookkeeping,
// so a failure here must never be reported as a merge problem. It reopens the
// store because the gate closed it during the preflight.
let parkedClosed = 0;
try {
  const { store: post } = openProject(target);
  try {
    for (const t of post.query({ types: ['todo'], cap: 1000 })) {
      if (t.source !== 'system' || t.system_reason !== 'file_parked') continue;
      // Close only when EVERY path the item names is now present — a multi-path
      // item whose second file is still parked is still true.
      const paths = t.file_keys ?? [];
      if (paths.length > 0 && paths.every((k) => existsSync(join(target, k)))) {
        post.remove(t.id, new Date().toISOString());
        parkedClosed += 1;
      }
    }
  } finally {
    post.close();
  }
} catch (e) {
  console.error(`direct-merge: the merge succeeded; the parked-file sweep did not run (${e?.message ?? e}). Harmless — /sterling:drain will close them.`);
}

// PUSH THE MERGE TO ORIGIN — work has not "landed" until consumers can
// fast-forward to it: /sterling:update reads origin, so a merged-but-unpushed
// base leaves every consumer machine behind with nothing anywhere saying so.
// Binding the push to the merge event (P4) closes that gap; --no-push opts out
// for local-only work. A repo with no origin (test fixtures, consuming
// projects) skips LOUD. On WSL a plain `git push` can fail where `git.exe`
// succeeds (credentials live in Git Credential Manager on the Windows side),
// so that interop path is tried before declaring failure. A push failure is
// NEVER reported as a merge failure — the merge stands; the exit code still
// goes non-zero so an unpushed base cannot read as a clean gate.
let pushed = false;
if (process.argv.includes('--no-push')) {
  console.error('direct-merge: push to origin SKIPPED (--no-push) — consumers cannot see this merge until you push.');
} else {
  const remotes = spawnSync('git', ['remote'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  const hasOrigin = remotes.status === 0 && remotes.stdout.split('\n').map((r) => r.trim()).includes('origin');
  if (!hasOrigin) {
    console.error("direct-merge: no 'origin' remote — push skipped (loud).");
  } else {
    const tryPush = (cmd) =>
      spawnSync(cmd, ['push', 'origin', into], {
        cwd: target,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    let push = tryPush('git');
    if (push.status !== 0 && process.platform !== 'win32') {
      console.error('direct-merge: `git push` failed — retrying through git.exe (Windows credential manager)…');
      const winPush = tryPush('git.exe');
      if (!winPush.error) push = winPush; // git.exe absent (spawn error) → keep the original failure
    }
    if (push.status === 0) {
      pushed = true;
      console.error(`direct-merge: pushed ${into} to origin.`);
    } else {
      console.error(
        [
          '',
          `direct-merge: THE MERGE SUCCEEDED (${branch} → ${into}) — but the PUSH to origin FAILED,`,
          `so consumer machines cannot see it (/sterling:update reads origin). Push ${into} manually:`,
          `  git push origin ${into}   (on WSL, try: git.exe push origin ${into} — credentials live in GCM)`,
          `A 'Repository not found' here usually means a wrong-account GCM credential.`,
          (push.stderr || push.stdout || String(push.error?.message ?? '')).trim(),
        ].join('\n')
      );
      console.log(JSON.stringify({ ...merged, branches_swept: swept, pushed: false }, null, 2));
      process.exit(1);
    }
  }
}

console.log(JSON.stringify({ ...merged, branches_swept: swept, pushed, ...(parkedClosed ? { parked_items_closed: parkedClosed } : {}) }, null, 2));
