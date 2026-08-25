// SETTLEMENT-TIME reconcile-mint predicate (board c198866d: H7 CANDIDATE-ONLY
// + SETTLEMENT-TIME MINTING). H7's direct-mode Arm 1 (h7-file-touch.mjs) no
// longer mints reconcile_needed at touch time — it only registers the
// touched path as a CANDIDATE (.sterling/transient/touches.json, the same
// register H10 already reads). Minting moves to SETTLEMENT, at three
// boundaries: (a) the direct-session Stop, after whatever capture/reconcile
// knowledge_update calls already landed this turn (h10-direct-capture.mjs);
// (b) pre-merge, as a HARD BACKSTOP over every file the branch actually
// changed (direct-merge.mjs); (c) run completion — pipeline mode is
// untouched by this change, since H7 still mints on the RUN at touch time
// there (this module is a direct-mode-only concern). Commit alone is
// deliberately NOT a settlement boundary: Sterling commits code then
// reconciles, so the meaningful boundary is "the reconciliation window
// settled", which a bare commit does not establish.
//
// THE PREDICATE mirrors packages/mcp-server/src/tools.ts's read-time
// hashFile/contentChanged (Arm 2, unchanged by this board item) — duplicated
// here, not imported, because hooks/scripts are dependency-light standalone
// .mjs and cannot pull in mcp-server at runtime (invariant 4). No baseline
// for a path -> ABSTAIN (false): a freshly-owned file gets its baseline at
// the next create/reconcile, and mtime/touch alone is not proof of a real
// change. A baseline that EXISTS but whose current bytes cannot be read ->
// DRIFT (true) — F1, board c198866d fixer round: a deleted governed file is
// itself the reconcile fact (mirroring tools.ts's separate missing-file
// stat() arm, which treats absence from disk as drift; this narrower mirror
// folds "missing" into the same content check rather than reproducing that
// arm's fuller parked-on-ref/never-tracked git-probe machinery, which is out
// of scope for a settlement predicate). Because the comparison always reads
// the article's CURRENT baseline, an edit-then-revert and a path an
// intervening knowledge_update already rebaselined both naturally fall out
// as "no mint" — no separate bookkeeping needed for either case.
//
// NAMED HOLE (must stay explicit, per the board item's conductor caveat): a
// session that DIES mid-work never reaches Stop-settlement (a) — its
// touches.json candidates are simply abandoned on disk. The pre-merge
// backstop (b) only ever sees MERGED work, so a dead session whose branch
// never merges is covered by neither settlement boundary; H7's Arm 2
// (read-time out-of-band drift check, unchanged) is the residual net for
// that gap, not a settlement boundary itself.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// MUTUAL EXCLUSION around touches.json's read-modify-write (R3 round-4
// fixer, board c198866d): the earlier attempt to close the H7-vs-H7 race by
// changing the ON-DISK SHAPE (JSONL / one-file-per-touch) broke multiple
// already-green frozen tests that spawn the real H7 hook and then
// `JSON.parse` touches.json expecting a top-level array — so the shape stays
// exactly what it always was, and the race is closed with a LOCK around the
// existing RMW instead. Same lock-dir idiom already used twice in this
// codebase (scripts/hooks/lib/delivery.mjs's withFileLock, the H22
// review-ledger lock): mkdirSync on a sibling `<path>.lock` DIRECTORY is
// atomic (EEXIST on contention) on every platform Node supports, so it
// doubles as a lock with no extra dependency — chosen over a `wx`-flag
// lockFILE only because it is the codebase's existing precedent for exactly
// this class of transient-register RMW, and reusing it keeps one idiom
// instead of two. Age-based staleness ONLY, never PID-liveness (anti_pattern
// 8e603e23: a recycled PID gives a false lock identity) — hooks are
// short-lived, so a lock older than LOCK_STALE_MS is a crashed holder's
// leftover, broken loud (console.error) and reclaimed. Contention retries
// briefly (LOCK_DEADLINE_MS, polling every LOCK_POLL_MS — a handful of
// attempts, tens of milliseconds total): a Stop/PostToolUse hook must never
// hang the session waiting on a lock (P1). On final failure this DEGRADES TO
// THE UNLOCKED RMW (today's pre-fix behavior) rather than blocking or
// erroring — a rarely-lost touch under pathological contention is exactly
// the pre-fix world, and it is netted by Arm 2 (read-time drift) and the
// pre-merge backstop; a silent lock-wait-forever would be worse. `onTimeout`
// lets the caller record a loud, non-fatal check_skipped naming the timeout
// (never required — a caller with no store handle simply omits it).
const LOCK_DEADLINE_MS = 150;
const LOCK_STALE_MS = 3000;
const LOCK_POLL_MS = 20;

/** Synchronous, non-busy wait — no async available in a hook body. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` (a synchronous read-modify-write of `targetPath`) holding a
 * sibling `<targetPath>.lock` directory as a mutual-exclusion lock. Shared by
 * H7 (the append) and H10 (the claim/union/release) so touches.json only
 * ever has ONE writer at a time — see the module header for the design.
 */
export function withFileLock(targetPath, fn, { onTimeout } = {}) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          console.error(`settlement: touches lock '${lockPath}' is stale (>${LOCK_STALE_MS}ms) — breaking it (a crashed holder's leftover)`);
          rmSync(lockPath, { recursive: true, force: true });
          continue; // retake immediately — no need to sleep first
        }
      } catch {
        continue; // lock vanished between the EEXIST and the stat — retry now
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
  if (!acquired && onTimeout) {
    try {
      onTimeout();
    } catch {
      // recording the timeout is itself best-effort — see each caller
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best-effort release; a leftover lock self-heals via the staleness check
      }
    }
  }
}

/**
 * touches.json is always the whole-array shape H7 writes and test fixtures
 * hand-build it as (an append-only JSONL shape was tried and reverted — see
 * h7-file-touch.mjs's header — because it broke frozen tests expecting a
 * plain `JSON.parse` to yield an array; the H7-vs-H7 race is closed with
 * withFileLock instead, not a shape change). This parser tolerates a stray
 * JSONL line too (belt-and-suspenders against any hand-written or historical
 * non-array content) — a malformed/empty line is skipped, never fatal, and
 * a single malformed line can never stop parsing the rest of the file (or,
 * for H7's caller, block every future append). Shared by H7 and H10 (micro-
 * round fixer) so a bare, throwing JSON.parse never lives in two places.
 */
export function parseTouchesContent(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  const out = [];
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      // one malformed JSONL line is skipped, never fatal to the rest
    }
  }
  return out;
}

/** sha256 of a file's bytes under `root`, or undefined if it cannot be read. */
export function hashFile(root, rel) {
  try {
    return createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Has `rel` actually changed since the baseline recorded in `baselines`
 * (a feature_article/reference_material's file_baselines map)? No baseline
 * entry ABSTAINS (false — never baselined, nothing to compare); a baseline
 * that exists but whose current bytes cannot be read is DRIFT (true — F1,
 * board c198866d fixer round: deletion is the reconcile fact, not an
 * abstention). See the module header.
 */
export function contentChangedAgainstBaseline(root, rel, baselines) {
  const baseline = baselines?.[rel];
  if (baseline === undefined) return false;
  const current = hashFile(root, rel);
  if (current === undefined) return true;
  return current !== baseline;
}

/**
 * GENERATED-PROJECTIONS EXEMPTION (settled ruling e1275166: files
 * REGENERATED from the store — architecture.md et al — are exempt from
 * drift machinery). The settlement-time minting path (board c198866d)
 * initially dropped this exemption entirely, measured 2026-08-25 as a
 * merge-blocking regen<->reconcile loop: a regenerated projection always
 * shows live content drift against its recorded baseline, so it minted a
 * reconcile_needed item forever and direct-merge refused on its own
 * gate's output. Reads config.generated_projections FRESH, LOCALLY, on
 * every call — missing file / missing key / non-array / a JSON parse
 * error all degrade to an EMPTY exemption set (nothing exempted, today's
 * behavior). This local guard is deliberately narrow: it must never be
 * read as license for a CALLER's own config read to swallow the same
 * failure — H10's Stop and direct-merge's openProject each parse config
 * themselves BEFORE ever reaching this module, and stay fail-closed/loud
 * on a malformed config exactly as ruling e13f0fb5 requires; a malformed
 * config never reaches this helper because the caller has already
 * refused.
 */
export function loadGeneratedProjections(root) {
  try {
    const raw = readFileSync(join(root, '.sterling', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const list = parsed?.generated_projections;
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

/** Builds the enqueueSystemTodo payload for one article's reconcile_needed item. */
function buildReconcileItem(article, fileKeys, now) {
  return {
    id: randomUUID(),
    type: 'todo',
    created_at: now,
    updated_at: now,
    author: 'system',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    text:
      article.type === 'reference_material'
        ? `reconcile reference '${article.title}' — its document changed content in direct mode (settled): ${fileKeys.join(', ')}; refresh summary + source_date (§3.2.5)`
        : `reconcile article '${article.slug}' — owned file(s) changed content in direct mode (settled): ${fileKeys.join(', ')}`,
    source: 'system',
    system_reason: 'reconcile_needed',
    file_keys: fileKeys,
    feature_link: article.id,
  };
}

/**
 * SETTLEMENT: given a store, the tree root, and a set of CANDIDATE
 * repo-relative paths (H7's touch register, or a branch's full changed-file
 * set at the pre-merge backstop), mint one grouped reconcile_needed item per
 * owning article whose owned candidate path(s) show LIVE content drift
 * against that article's CURRENT baseline. Paths owned by no article, or
 * showing no live drift, mint nothing.
 *
 * WIDEN-IN-PLACE, never a second item (F2, board c198866d fixer round):
 * grouping per article is a PRESENTATION choice the h7-settlement-minting
 * suite pins (AC5 — two changed paths under one article settle to ONE item),
 * so per-file items are not an option here without breaking that pin. But
 * enqueueSystemTodo dedups on the EXACT (reason, feature_link, file_keys)
 * SET (decision 194f43e4), so re-grouping the FULL current-candidate set on
 * every settlement pass would mint a NEW item every time the set's shape
 * changes (Stop-1 {A}, Stop-2 {A,B}, merge-backstop {A,B,C} — three open
 * items for one article, the moving-key pathology). Instead: find the
 * article's existing open item (if any); compute only the candidates NOT
 * already in its file_keys that are LIVE drift; if none, touch nothing (the
 * existing item already covers this article's live debt — this also means a
 * pre-existing item whose predicate has gone stale, e.g. AC6b's already-
 * reconciled row, is left untouched here, exactly as it was — direct-merge's
 * OWN isLiveReconcileDebt re-check is what excludes it from blocking, not a
 * removal performed during minting); otherwise WIDEN by removing the old
 * item and re-minting the union — one open item per article, always.
 */
export function mintSettlementReconcile(store, root, candidatePaths, now = new Date().toISOString()) {
  // Exempt paths are dropped from the candidate set UP FRONT (e1275166) — an
  // exempt path can never reach byArticle grouping below, so it can never
  // appear in a minted item's file_keys, even when it shows live drift. An
  // unlisted co-candidate owned by the same article is unaffected and still
  // mints normally.
  const exempt = loadGeneratedProjections(root);
  const paths = [...new Set((candidatePaths ?? []).filter(Boolean))].filter((rel) => !exempt.has(rel));
  if (!paths.length) return [];

  // Every OPEN reconcile_needed item, indexed by its owning article — only
  // the FIRST one found per article is tracked; a pre-existing SECOND one for
  // the same article (a legacy duplicate, or hand-created as in a fixture) is
  // left untouched, and this pass never creates a third.
  const openByArticle = new Map(); // article.id -> existing open item
  for (const t of store.query({ types: ['todo'], cap: 1000 })) {
    if (t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link && !openByArticle.has(t.feature_link)) {
      openByArticle.set(t.feature_link, t);
    }
  }

  const byArticle = new Map(); // article.id -> { article, freshPaths: Set<string> }
  for (const rel of paths) {
    const owners = store
      .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
      .filter((r) => !r.working_tree);
    for (const article of owners) {
      if (!byArticle.has(article.id)) byArticle.set(article.id, { article, freshPaths: new Set() });
      byArticle.get(article.id).freshPaths.add(rel);
    }
  }

  const minted = [];
  for (const { article, freshPaths } of byArticle.values()) {
    const existing = openByArticle.get(article.id);
    const existingSet = new Set((existing?.file_keys ?? []).filter((k) => !exempt.has(k)));
    // Candidates NOT already covered by the existing item, filtered to those
    // showing LIVE drift right now (F1's deletion-is-drift folds in here too).
    const newlyDrifted = [...freshPaths]
      .filter((rel) => !existingSet.has(rel))
      .filter((rel) => contentChangedAgainstBaseline(root, rel, article.file_baselines));
    if (!newlyDrifted.length) continue; // nothing new — existing item (if any) already covers this article
    if (!existing) {
      const fileKeys = newlyDrifted.sort();
      store.enqueueSystemTodo(buildReconcileItem(article, fileKeys, now));
      minted.push({ article_id: article.id, paths: fileKeys });
      continue;
    }
    const widened = [...new Set([...existingSet, ...newlyDrifted])].sort();
    // R1 (board c198866d round-3 fixer): ENQUEUE the widened item FIRST, THEN
    // sweep away the old one(s) — a crash between the two calls must leave
    // the OLD item's debt readable, never nothing. The rows can momentarily
    // coexist (their dedup keys differ, since file_keys differs), which is
    // harmless redundancy, not data loss.
    const { record: widenedRecord } = store.enqueueSystemTodo(buildReconcileItem(article, widened, now));
    // SELF-HEALING SWEEP (micro-round fixer): remove EVERY OTHER open
    // reconcile_needed item for THIS article, not just `existing` — if a
    // prior settlement pass crashed after its enqueue but before its own
    // remove, that stale duplicate is invisible to openByArticle's
    // first-found tracking (it only ever surfaces ONE item as `existing`),
    // so a bare store.remove(existing.id) alone could never clean it up and
    // it would sit open forever. Sweeping by feature_link makes retry
    // self-healing regardless of how many stale duplicates accumulated.
    for (const t of store.query({ types: ['todo'], cap: 1000 })) {
      if (t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link === article.id && t.id !== widenedRecord.id) {
        store.remove(t.id, now);
      }
    }
    minted.push({ article_id: article.id, paths: widened });
  }
  return minted;
}

/**
 * Is an already-open reconcile_needed queue item still LIVE — does at least
 * one of its named files currently differ from its owning article's CURRENT
 * baseline? Used by direct-merge.mjs's pre-merge gate so a stale row (already
 * reconciled since it minted, or an edit-then-revert) never blocks on its own
 * authority (board c198866d). An item with no feature_link, an unresolvable
 * article, or no named files cannot be re-verified this way — it stays LIVE
 * (the safe direction: never let an item silently drop out of a refusal on
 * evidence we could not check).
 *
 * Thin wrapper over explainReconcileDebtLiveness (board 92f7e826): the verdict
 * is computed in ONE place, and callers that must SAY WHY (direct-merge's loud
 * stale-item report) read the same evaluation this boolean does — a second
 * copy of the reasoning in the caller is exactly the drift invariant 4's
 * no-duplicate-logic discipline forbids.
 */
export function isLiveReconcileDebt(store, root, item) {
  return explainReconcileDebtLiveness(store, root, item).live;
}

/**
 * The SAME liveness evaluation as isLiveReconcileDebt, with the REASON
 * attached — added for board 92f7e826's recurrence (2026-08-25): the gate
 * already excluded stale rows from its refusal, but excluded them SILENTLY,
 * so eight no-op items were invisible at the gate, "closed" with board_remove
 * (which never moves the article's file_baselines) and re-minted within
 * minutes. Nothing here removes or rewrites a queue row — the verdict is
 * evidence for a human/conductor to close deliberately, never an auto-close.
 *
 * Returns { live, code, ...paths } where code is one of:
 *   live=true   'no_feature_link' | 'no_files_named' | 'article_unresolvable'
 *               (UNEVALUABLE — fail closed, the item still blocks)
 *               'drifted' (the debt is real: `drifted` names the paths, which
 *               includes a baselined path whose bytes cannot be read at all —
 *               contentChangedAgainstBaseline reads unreadable-with-a-baseline
 *               as drift, so an unreadable governed file still blocks)
 *   live=false  'all_exempt' (every named path is a generated projection,
 *               ruling e1275166) | 'baseline_match' | 'baseline_absent' |
 *               'baseline_match_and_absent'
 *
 * 'baseline_absent' is an ABSTENTION, not a verified-clean: the article
 * records no baseline for the path, so there is nothing to compare (the
 * settled predicate's documented rule — see the module header). It is
 * deliberately NOT promoted to blocking here: an article that has dropped a
 * path from files[]/file_baselines can never re-stamp it, so blocking on it
 * would deadlock the gate with no available remedy. It is reported as its own
 * code precisely so the caller can name it as unverified rather than clean.
 */
export function explainReconcileDebtLiveness(store, root, item) {
  const files = item.file_keys ?? [];
  if (!item.feature_link) return { live: true, code: 'no_feature_link' };
  if (!files.length) return { live: true, code: 'no_files_named' };
  const article = store.get(item.feature_link);
  if (!article) return { live: true, code: 'article_unresolvable' };
  // GENERATED-PROJECTIONS EXEMPTION (e1275166): drop exempt paths BEFORE the
  // liveness check. An item whose file_keys are ONLY exempt paths is
  // therefore NOT live, even when those files are genuinely drifted; an item
  // mixing one exempt path with one genuinely-drifted UNLISTED path stays
  // live on the unlisted path alone. Deliberately not the same as the
  // "no named files" case above: naming zero files means nothing could be
  // checked (stays LIVE, the safe direction); naming only exempt files means
  // everything named HAS been checked and cleared.
  const exempt = loadGeneratedProjections(root);
  const considered = files.filter((f) => !exempt.has(f));
  if (!considered.length) return { live: false, code: 'all_exempt', exempt_paths: [...files] };
  const drifted = considered.filter((f) => contentChangedAgainstBaseline(root, f, article.file_baselines));
  if (drifted.length) return { live: true, code: 'drifted', drifted };
  // Not live. Split WHY, because the two are not the same fact: a path whose
  // current bytes hash to the recorded baseline is VERIFIED clean, while a
  // path with no baseline entry was never comparable at all (the abstention
  // documented above). A caller printing "stale" over the second without
  // saying so would be claiming evidence it does not have (P5).
  const baselines = article.file_baselines ?? {};
  const matched = considered.filter((f) => baselines[f] !== undefined);
  const unbaselined = considered.filter((f) => baselines[f] === undefined);
  const code = unbaselined.length === 0 ? 'baseline_match' : matched.length === 0 ? 'baseline_absent' : 'baseline_match_and_absent';
  return { live: false, code, matched, unbaselined };
}
