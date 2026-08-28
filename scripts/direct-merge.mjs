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
import { mintSettlementReconcile, explainReconcileDebtLiveness } from './hooks/lib/settlement.mjs';
import { matchesGlob } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';

const target = arg('--target') ?? process.cwd();
if (!isGitRepo(target)) fail(`direct-merge: not a git repository: '${target}'`);

// A run owns the working tree and merges through the §8.1 gate, which runs
// disposal + promotion first — never route a run merge through here (P5).
const { store, config } = openProject(target);
const active = store.getRun();
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
// SHA RESOLUTION (decision h7-co-owner-trap-verification-discharge-and-version-only-exception):
// resolve intoTip / branchTip / mergeBase ONCE here, fail closed (fail()) on any
// resolution error, and reuse these three SHAs everywhere below (the version-only
// proof, next) — never re-derive them. `git diff --name-only mergeBase branchTip`
// is semantically identical to the three-dot `into...branch` form it replaces.
const resolveSha = (ref, label) => {
  const r = spawnSync('git', ['rev-parse', ref], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) fail(`direct-merge: git rev-parse ${label} ('${ref}') failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
};
const intoTip = resolveSha(into, 'into');
const branchTip = resolveSha(branch, 'branch');
const mergeBaseR = spawnSync('git', ['merge-base', intoTip, branchTip], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (mergeBaseR.status !== 0) fail(`direct-merge: git merge-base ${intoTip} ${branchTip} failed: ${(mergeBaseR.stderr || '').trim()}`);
const mergeBase = mergeBaseR.stdout.trim();

const diff = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--end-of-options', mergeBase, branchTip], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (diff.status !== 0) fail(`direct-merge: git diff ${mergeBase} ${branchTip} failed: ${(diff.stderr || '').trim()}`);
const changed = new Set(diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean));

// VERSION-ONLY PROOF (arm A2 of decision h7-co-owner-trap-verification-discharge-and-version-only-exception).
// Applies to exactly ['.claude-plugin/plugin.json', 'package.json']. Pure,
// deterministic, fail-closed — no diff/text parsing. qualifiesVersionOnly(path)
// is true ONLY if ALL of the following hold; any failure returns false, with NO
// carve-out:
//   (a) at BOTH mergeBase and branchTip the path is a regular blob (mode
//       100644 or 100755, type 'blob') — absent / added / deleted / symlink /
//       type-change all fail here;
//   (b) both blob contents parse as JSON;
//   (c) each content contains EXACTLY ONE standalone version-field line (a line
//       whose entire TRIMMED content is `"version": "<v>"` with an optional
//       trailing comma) — zero or multiple matches fail;
//   (d) the two parsed `.version` values differ;
//   (e) replacing that one matched line's full text with an identical sentinel
//       in both contents — split on '\n' (so any '\r' stays attached to its
//       line; no other normalization) — yields byte-identical results.
// A whole-file CRLF conversion, JSON reformat, key reorder, or ANY other change
// therefore fails closed.
function lsTreeEntry(root, sha, path) {
  const r = spawnSync('git', ['ls-tree', sha, '--', path], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  const line = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return null;
  const m = line.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/);
  return m ? { mode: m[1], type: m[2], hash: m[3] } : null;
}
// FATAL UTF-8 DECODE (Codex round-2 HIGH): a plain Buffer.toString('utf8')
// silently replaces invalid byte sequences with U+FFFD, so two DIFFERENT
// non-version byte sequences can decode to the SAME string and wrongly
// qualify — the eventual string-equality check in (e) is only byte-equivalent
// for the remaining, unchanged bytes if the decode itself cannot lose
// information. `fatal: true` makes a malformed blob throw instead, which this
// caller turns into a fail-closed `null` (never a qualifying proof).
function showBlobText(root, sha, path) {
  const r = spawnSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'buffer', timeout: 30_000 });
  if (r.status !== 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
  } catch {
    return null;
  }
}
function readManifestVersion(root, sha, path) {
  const content = showBlobText(root, sha, path);
  if (content === null) return null;
  try {
    return JSON.parse(content)?.version ?? null;
  } catch {
    return null;
  }
}
const VERSION_LINE_RE = /^"version"\s*:\s*"[^"]*"\s*,?$/;
function findSingleVersionLineIndex(lines) {
  const idx = [];
  lines.forEach((line, i) => {
    if (VERSION_LINE_RE.test(line.trim())) idx.push(i);
  });
  return idx.length === 1 ? idx[0] : -1;
}
function qualifiesVersionOnly(root, mergeBaseSha, branchTipSha, path) {
  const isRegularBlob = (e) => !!e && e.type === 'blob' && (e.mode === '100644' || e.mode === '100755');
  const baseEntry = lsTreeEntry(root, mergeBaseSha, path);
  const tipEntry = lsTreeEntry(root, branchTipSha, path);
  // MODE MUST MATCH TOO (Codex round-2 MEDIUM): both endpoints being SOME
  // regular-blob mode is not enough — a chmod bundled with the version bump
  // (100644 -> 100755 or back) is a real content-adjacent change, not
  // version-only, and must fail closed rather than qualify.
  if (!isRegularBlob(baseEntry) || !isRegularBlob(tipEntry) || baseEntry.mode !== tipEntry.mode) return false; // (a)

  const baseContent = showBlobText(root, mergeBaseSha, path);
  const tipContent = showBlobText(root, branchTipSha, path);
  if (baseContent === null || tipContent === null) return false;

  let baseJson;
  let tipJson;
  try {
    baseJson = JSON.parse(baseContent);
    tipJson = JSON.parse(tipContent);
  } catch {
    return false; // (b)
  }

  const baseLines = baseContent.split('\n');
  const tipLines = tipContent.split('\n');
  const baseIdx = findSingleVersionLineIndex(baseLines);
  const tipIdx = findSingleVersionLineIndex(tipLines);
  if (baseIdx === -1 || tipIdx === -1) return false; // (c)

  const baseVersion = baseJson?.version;
  const tipVersion = tipJson?.version;
  // STRING VERSIONS ONLY (Codex round-2 MEDIUM): a duplicate "version" key
  // elsewhere in the object can make JSON.parse's `.version` an OBJECT — two
  // distinct objects are ALWAYS !== by reference identity, which would
  // satisfy "the values differ" vacuously even when nothing meaningful
  // differs. Require both parsed values to actually be strings.
  if (typeof baseVersion !== 'string' || typeof tipVersion !== 'string' || baseVersion === tipVersion) return false; // (d)

  const SENTINEL = '"version": "__version-only-sentinel__"';
  const baseNormalized = [...baseLines];
  baseNormalized[baseIdx] = SENTINEL;
  const tipNormalized = [...tipLines];
  tipNormalized[tipIdx] = SENTINEL;
  return baseNormalized.join('\n') === tipNormalized.join('\n'); // (e)
}

const VERSION_ONLY_CANDIDATES = ['.claude-plugin/plugin.json', 'package.json'];
// Applied to exactly the paths above that this branch's diff actually touched;
// every other consumer below keeps reading the untouched `changed` set.
const versionOnlyPaths = VERSION_ONLY_CANDIDATES.filter((p) => changed.has(p) && qualifiesVersionOnly(target, mergeBase, branchTip, p));
// `changed` stays exactly as-is for every existing consumer (version-field
// gate, review-receipt checks, board-payment nudge, parked sweep).
// `reconcileChanged` is `changed` minus the proven version-only paths, used
// ONLY for settlement minting and the reconcile refusal's covering/liveness
// scope — a proven version-only path can never block or mint a merge refusal
// from this exception alone (decision h7-co-owner-trap-verification-discharge-and-version-only-exception, arm A2).
const reconcileChanged = new Set([...changed].filter((p) => !versionOnlyPaths.includes(p)));

// SETTLEMENT BOUNDARY (b) — the pre-merge HARD BACKSTOP (board c198866d, H7
// CANDIDATE-ONLY + SETTLEMENT-TIME MINTING). H7's direct-mode Arm 1 no longer
// mints reconcile_needed at touch time — only the direct-session Stop
// (h10-direct-capture.mjs) and this gate ever mint it now, so a branch whose
// session died before reaching Stop-settlement (the design's NAMED HOLE) still
// gets its debt minted HERE, against every file this branch actually changed,
// before the refusal below ever reads the queue. Every SURVIVING
// reconcile_needed item covering this branch's files is then re-evaluated
// against the LIVE predicate (current content vs the owning article's CURRENT
// baseline) — a stale row (already reconciled since it minted, or an
// edit-then-revert) must never block the merge on its own authority.
// A row the live predicate CLEARS is NAMED, never silently dropped (board
// 92f7e826, recurrence 2026-08-25): the exclusion already worked, but it was
// invisible, so eight no-op items were "closed" with board_remove — which
// never moves the owning article's file_baselines — and re-minted within
// minutes, blocking the merge twice. The gate now reports every cleared row so
// the close can be deliberate. It still closes NOTHING itself.
const { store: settleStore } = openProject(target);
let debt;
let cleared;
let versionOnlyReport;
let settlementError;
try {
  mintSettlementReconcile(settleStore, target, [...reconcileChanged]);
  const covering = settleStore
    .query({ types: ['todo'], cap: 1000 })
    .filter((t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && (t.file_keys ?? []).some((k) => reconcileChanged.has(k)));
  debt = [];
  cleared = [];
  versionOnlyReport = [];
  // VERSION-ONLY NONBLOCKING REPORT (arm A2): an item covering a PROVEN
  // version-only path is deliberately excluded from `covering` above
  // (reconcileChanged drops proven paths), so it can never contribute to
  // `debt`/`cleared` or block this merge from this exception alone — but it
  // is still named here, loud, exactly because nothing has actually closed it.
  if (versionOnlyPaths.length > 0) {
    // file_keys + source passed INTO the query (Codex round-2 MEDIUM), same
    // idiom as the board-payment nudge below: both filter BEFORE the cap:1000,
    // so a proven path's covering item can never be crowded out of the capped
    // window by unrelated recent todos.
    const versionOnlyCovering = settleStore
      .query({ types: ['todo'], file_keys: versionOnlyPaths, source: 'system', cap: 1000 })
      .filter((t) => t.system_reason === 'reconcile_needed' && (t.file_keys ?? []).some((k) => versionOnlyPaths.includes(k)));
    for (const t of versionOnlyCovering) {
      const provenHere = versionOnlyPaths.filter((p) => (t.file_keys ?? []).includes(p));
      if (!provenHere.length) continue;
      const article = t.feature_link ? settleStore.get(t.feature_link) : null;
      for (const p of provenHere) {
        const oldV = readManifestVersion(target, mergeBase, p);
        const newV = readManifestVersion(target, branchTip, p);
        versionOnlyReport.push({
          item: t,
          article,
          path: p,
          summary: `${p}: only the version line differs mergeBase..branchTip (${oldV} -> ${newV})`,
        });
      }
    }
  }
  for (const t of covering) {
    // R5(b) (board c198866d round-3 fixer): widen-in-place can group a path
    // this branch never touched into the same item as one it did (grouping is
    // per ARTICLE, not per branch) — evaluating liveness over the FULL item
    // would let that unrelated path's drift refuse THIS merge. Scope the live
    // check to item.file_keys ∩ this branch's changed files (the merge gate's
    // own scope, decision 9df61181) by passing a view of the item carrying
    // only the intersecting keys — always non-empty here, since the .some()
    // above already guarantees at least one overlapping key.
    //
    // ONE SCOPE, BLOCKING AND REPORTING ALIKE (conductor ruling, board
    // 92f7e826): an item covering no file this branch changed is out of this
    // gate's business entirely — it cannot block, so naming it here is output
    // nobody acts on at a merge (P1). Stale rows beyond the branch diff are
    // /sterling:drain's lane, which already verifies queue items against HEAD.
    const scopedFiles = (t.file_keys ?? []).filter((k) => reconcileChanged.has(k));
    const verdict = explainReconcileDebtLiveness(settleStore, target, { ...t, file_keys: scopedFiles });
    if (verdict.live) debt.push(t);
    else cleared.push({ item: t, scopedFiles, verdict });
  }
} catch (e) {
  settlementError = e;
} finally {
  settleStore.close();
}
// F5 (board c198866d fixer round): a mint/live-check throw left `debt`
// undefined, so the `debt.length` read below raised a raw TypeError instead
// of a loud, attributable refusal (P5) — fail() here, never a bare crash.
if (settlementError) {
  fail(`direct-merge: settlement mint/live-check failed (${settlementError?.message ?? settlementError}) — refusing rather than merging on an unverified reconcile state`);
}
// VERSION-ONLY NONBLOCKING REPORT, printed BEFORE the cleared/refusal output
// below so it appears on every path — a clean merge, a merge that proceeds
// past cleared rows, and a merge refused on OTHER, still-live debt (decision
// h7-co-owner-trap-verification-discharge-and-version-only-exception, arm A2).
// Nothing here closes anything: the item stays open, unverified, and the
// exception's whole claim is nonblocking-ness, never verified-clean-ness.
if (versionOnlyReport.length > 0) {
  console.error(
    [
      '',
      'direct-merge: VERSION-ONLY NONBLOCKING (decision h7-co-owner-trap-verification-discharge-and-version-only-exception)',
      ...versionOnlyReport.map(({ item, article, path, summary }) => {
        const articleLabel = article ? `${article.slug ?? article.id} (${article.id})` : '(no owning article)';
        return `  - ${item.id}  article ${articleLabel}  path ${path}\n      ${summary}\n      still open; not verified clean; nothing closed by this exception.`;
      }),
      '',
    ].join('\n')
  );
}

// THE CLEARED ROWS, NAMED (board 92f7e826). Printed to STDERR only — stdout is
// the gate's machine-readable JSON result and stays exactly that. Printed
// BEFORE the refusal below, so it appears on BOTH paths: a merge that proceeds
// and a merge refused on OTHER, genuinely-live debt. Nothing is removed or
// rewritten here; the remedy text says why board_remove alone is the wrong
// close, which is the trap this report exists to stop.
if (cleared.length > 0) {
  const why = (v) => {
    switch (v.code) {
      case 'all_exempt':
        return `every named path is a generated projection (config.generated_projections, ruling e1275166): ${v.exempt_paths.join(', ')}`;
      case 'baseline_match':
        return `content now MATCHES the owning article's current baseline (already reconciled, or edited and reverted): ${v.matched.join(', ')}`;
      case 'baseline_absent':
        return `UNVERIFIED, not clean — the owning article records NO baseline for ${v.unbaselined.join(', ')}, so there was nothing to compare (the settlement predicate abstains rather than inventing drift); this row cannot be cleared by a baseline re-stamp`;
      case 'baseline_match_and_absent':
        return (
          `content matches the current baseline for ${v.matched.join(', ')}; ` +
          `and the article records NO baseline for ${v.unbaselined.join(', ')} (UNVERIFIED, not clean — nothing to compare)`
        );
      default:
        return `live predicate false (${v.code})`;
    }
  };
  // THE REMEDY IS PER-REASON, never one prescription for all of them (both
  // reviewers, board 92f7e826): a universal "re-stamp the baseline" footer
  // directly contradicts a baseline_absent row, which has no baseline TO
  // re-stamp — and a footer that contradicts the line above it teaches the
  // reader to ignore both. Each remedy line is emitted only when at least one
  // row above actually earns it.
  const hasRestampable = cleared.some(({ verdict }) => verdict.code !== 'baseline_absent' && verdict.code !== 'all_exempt');
  const hasAbsent = cleared.some(({ verdict }) => verdict.code === 'baseline_absent' || verdict.code === 'baseline_match_and_absent');
  const hasExempt = cleared.some(({ verdict }) => verdict.code === 'all_exempt');
  console.error(
    [
      '',
      `direct-merge: ${cleared.length} open reconcile_needed item(s) cover this branch's files but their LIVE predicate no longer holds —`,
      `evaluated over the paths this branch changed (file_keys ∩ branch-changed, the merge gate's own scope), so the`,
      `verdict is re-checkable against exactly those paths and says nothing about any other path on the same item.`,
      `They do NOT block this merge, and NOTHING here closed them (a gate never closes debt on its own authority):`,
      ...cleared.map(
        ({ item, scopedFiles, verdict }) =>
          `  - ${item.id}  [${scopedFiles.join(', ')}]${item.feature_link ? `  article ${item.feature_link}` : ''}\n      ${why(verdict)}`
      ),
      `Close each one DELIBERATELY — the right close depends on the reason given above, and there is no single one:`,
      ...(hasRestampable
        ? [
            `  · a row reported as MATCHING the owning article's baseline: close it with a VERSIONED article write`,
            `    that re-stamps the baseline (knowledge_update / knowledge_append naming the item in \`resolves\`).`,
            `    Close it with an article write, and not with board_remove alone: removal never moves the owning`,
            `    article's file_baselines, so an item whose files still differ from a stale baseline re-mints within`,
            `    minutes (board 92f7e826, measured twice on 2026-08-25).`,
          ]
        : []),
      ...(hasAbsent
        ? [
            `  · a row reported as UNVERIFIED because NO baseline is recorded: a re-stamp is not the remedy — there is`,
            `    nothing to re-stamp. Either re-add that path to the owning article's files[] (the write mints its`,
            `    baseline, and the item then discharges by being named in \`resolves\`), or — if the article genuinely no`,
            `    longer owns the path — drop the path from the item (board_update) and close what remains on its own`,
            `    reason. Do not read this row as verified-clean; nothing was compared.`,
          ]
        : []),
      ...(hasExempt
        ? [
            `  · a generated-projection row: nothing needs re-stamping (ruling e1275166). Settlement no longer mints`,
            `    exempt paths and a later widen drops them from a legacy item, so closing it directly is safe.`,
          ]
        : []),
      '',
    ].join('\n')
  );
}
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
  // TWO SANCTIONED DISCHARGES (decision h7-co-owner-trap-verification-discharge-and-version-only-exception,
  // arm A1) — the prior text here ("knowledge_update ... auto-drains its item")
  // was FALSE: drain happens ONLY via an explicit `resolves` claim (decision
  // 68988832), never as a side effect of any write.
  // WHOLE-ITEM RULE STATED UNCONDITIONALLY (Codex round-2 HIGH): this used to
  // print ONLY inside the out-of-diff NOTE below, so an item whose file_keys
  // happened to sit entirely within this branch's diff never saw the warning
  // at all — but resolves ALWAYS deletes the whole item and re-baselines
  // EVERY owned file, regardless of diff scope, so discharge (b) states the
  // rule every time, not conditionally.
  const remedy = [
    '',
    'Two sanctioned discharges — close each item with ONE of these (never a bare knowledge_update; drain requires an explicit `resolves` claim, decision 68988832):',
    '  (a) BEHAVIOR CHANGED: reconcile the article with a real write carrying resolves:[<full item id>].',
    '  (b) VERIFIED UNAFFECTED: append a verification-history entry — `resolves` deletes the WHOLE item and the write',
    '      re-baselines EVERY file the owning article owns, so verify EVERY file_key on the item (and rule out any',
    '      unexplained drift elsewhere in the article\'s owned set) before resolving — never just the paths this branch',
    '      happened to touch —',
    '      knowledge_append(id:<article>, field:"history", entries:[{date:<ISO>, event:"VERIFIED UNAFFECTED (decision h7-co-owner-trap-verification-discharge-and-version-only-exception): <path(s)> — checked against the diff, no reconcile owed"}], resolves:["<full item id>"])',
    'Then rerun.',
  ];
  // PER-ITEM NOTE, kept as EMPHASIS (not the sole carrier of the rule anymore)
  // when an item's file_keys reach beyond this branch's diff — those specific
  // out-of-scope paths are named so they are not missed.
  for (const t of debt) {
    const outside = (t.file_keys ?? []).filter((k) => !changed.has(k));
    if (outside.length) {
      remedy.push(
        `  NOTE (${t.id}): this item also covers ${outside.join(', ')} beyond this branch — verify those too before resolving (see discharge (b) above; resolves deletes the whole item).`
      );
    }
  }
  fail(`direct-merge: ${headline} cover files this branch changed — reconcile before merging:\n` + grouped + '\n' + remedy.join('\n'));
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

// BOARD-PAYMENT NUDGE (board-payment-nudge-at-merge-gate, user-directed
// 2026-08-27): the merge just landed, so any open USER-source board item
// naming a file this branch changed may now be PAID work nobody closed —
// measured 2026-08-27, 15 of 55 board items were exactly this. Advisory only
// (never a refusal, P1: a gate here would add closure ceremony to every
// merge) — stdout stays the machine-readable JSON report, so this prints to
// stderr, only when non-empty (no noise on a clean merge), and NEVER refuses
// the merge on its own failure. Placed immediately after the merge lands and
// BEFORE the sweep/rebuild/stale-bundle blocks below, each of which can print
// "THE MERGE SUCCEEDED" and exit early — the nudge must still have run by then.
// Self-contained: builds its own query at print time rather than reusing the
// settlement-region query above, so a nudge-only failure can never surface as
// settlementError and refuse the merge (the advisory contract must never
// invert into a gate). Passing file_keys into the query lets the store
// intersect BEFORE the cap:1000 — the shared cap's recency window would
// otherwise silently drop older matching user items.
// KNOWN ACCEPTED LIMITATION: rename SOURCE paths are not nudged — `changed` is
// a --name-only diff, which reports only destinations for a detected rename;
// deliberate, so the reconcile set's own path semantics stay untouched here.
try {
  // An EMPTY file_keys array disables the store's file-key filter entirely
  // (it does not mean match-nothing) — an empty-commit / edit-then-revert
  // branch would otherwise pull in recent, unrelated todos. Skip outright.
  if (changed.size > 0) {
    // openProject() can itself fail()/process.exit (missing db, malformed
    // config) — fine pre-merge, but fatal here: the merge has ALREADY landed,
    // so this block must be exit-proof end-to-end and route any failure
    // through the catch below instead. Construct the store directly, the same
    // guard resolveProject uses, but throwing instead of exiting.
    const dbPath = join(target, '.sterling', 'sterling.db');
    if (!existsSync(dbPath)) throw new Error(`no Sterling store at ${dbPath}`);
    const nudgeStore = new SterlingStore(dbPath);
    let items;
    try {
      // source:'user' passed INTO the query (filters before the cap:1000,
      // packages/store/src/index.ts QueryOptions.source) rather than a
      // post-query .filter — an intersecting system item can no longer crowd
      // a user item out of the capped window.
      items = nudgeStore.query({ types: ['todo'], file_keys: [...changed], source: 'user', cap: 1000 });
    } finally {
      nudgeStore.close();
    }
    if (items.length > 0) {
      console.error(
        [
          '',
          `direct-merge: BOARD-PAYMENT NUDGE — ${items.length} open board item(s) name files this branch changed; the merged work may PAY them.`,
          `Re-verify each against HEAD: close what this merge pays (board_remove), rewrite what it half-pays (board_update) — an item that outlives its payment rots invisibly (15 of 55 measured 2026-08-27).`,
          ...items.map((t) => {
            const keys = (t.file_keys ?? []).filter((k) => changed.has(k));
            // Sanitize before printing: C0 controls, DEL and C1 controls
            // (\x7f-\x9f, incl. 8-bit CSI/DCS/OSC lead-ins) in stored todo
            // text could otherwise forge stderr lines. Full ids are
            // server-minted uuids and stay unsanitized/unclipped.
            const clip = String(t.text ?? '')
              .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 100);
            return `  - ${t.id}  ${clip}  [${keys.join(', ')}]`;
          }),
        ].join('\n')
      );
    }
  }
} catch (e) {
  console.error(`direct-merge: board-payment nudge did not run (${e?.message ?? e}) — advisory only, the merge stands.`);
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
