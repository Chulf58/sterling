// H7 — file-touch reconcile register (spec §6 H7). PostToolUse
// Edit|Write|MultiEdit, non-blocking. Look up owning articles (file-key join);
// mark reconcile_needed on the run (pipeline mode — unchanged by board
// c198866d). In DIRECT MODE this hook is now CANDIDATE-ONLY (board c198866d,
// H7 CANDIDATE-ONLY + SETTLEMENT-TIME MINTING): it registers the touched path
// in the transient touch register (.sterling/transient/touches.json) — the
// same register H10 already reads for its capture check — and mints NOTHING
// itself. Minting moves to SETTLEMENT: scripts/hooks/lib/settlement.mjs's
// mintSettlementReconcile, called from h10-direct-capture.mjs's Stop and
// direct-merge.mjs's pre-merge backstop, hashes the FINAL candidate content
// against the owning article's CURRENT baseline — so an edit-then-revert, or
// a path an intervening knowledge_update already rebaselined, never mints.
//
// R3, ROUND 2 (board c198866d round-4 fixer): an append-only JSONL rewrite of
// this register was tried first to close the H7-vs-H7 read-modify-write race,
// but it broke multiple ALREADY-GREEN frozen tests that spawn this real hook
// and then `JSON.parse` touches.json expecting a top-level ARRAY — the
// ON-DISK SHAPE stays exactly what it always was (a JSON array, read/written
// whole). The race is closed instead with MUTUAL EXCLUSION around this same
// read-modify-write: withFileLock (scripts/hooks/lib/settlement.mjs, the
// same lock-dir idiom already used by H22's review-ledger lock and
// lib/delivery.mjs) holds a sibling touches.json.lock directory for the
// whole read+push+write below, so two concurrent H7s serialize instead of
// racing. A lock that cannot be acquired within its short deadline degrades
// to today's unlocked RMW (a Stop/PostToolUse hook must never hang the
// session, P1) and records check_skipped so the degrade is never silent.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, warnNonBlocking, openStore, repoRel } from './lib/common.mjs';
import { withFileLock, parseTouchesContent, loadGeneratedProjections } from './lib/settlement.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow();
// machinery internals are never governed work: a commit-message temp file
// under .git/ tripped the register live (2026-06-12) and fed H10 a junk
// article demand — the tree is excluded, not pattern-matched per file
if (rel === '.git' || rel.startsWith('.git/')) allow();

const store = openStore(input.cwd);
if (!store) allow();

try {
  const run = store.getRun();

  if (run) {
    // Pipeline mode: unchanged by board c198866d — H7 still mints reconcile
    // debt on the RUN at touch time (the run's own disposal/completeness
    // gates are its settlement boundary, not this hook).
    // GENERATED-PROJECTIONS EXEMPTION (ruling e1275166, restored per board
    // 1784d6fc — mirrors the direct arm's mintSettlementReconcile in
    // settlement.mjs): a touched path listed in config.generated_projections
    // is the system's own regenerated output, not drift, and must never mint
    // reconcile debt — filtered on the TOUCHED PATH itself, up front, before
    // the owner join, so an article that also owns a non-exempt path is still
    // marked when THAT path is touched.
    const exempt = loadGeneratedProjections(input.cwd);
    if (!exempt.has(rel)) {
      // §3.2.5: repo-located reference docs (kind: doc) join the reconcile
      // economy — their location doubles as a file_key, so the same join
      // finds them here. Records declaring a working_tree describe a
      // DIFFERENT tree (comsoft-juiced 2026-07-17): a same-named path in this
      // session's root is not their file — they never receive a
      // touch-driven reconcile here.
      const owners = store
        .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
        .filter((r) => !r.working_tree);
      for (const article of owners) store.appendRunReconcileNeeded(run.id, article.id);
    } else {
      // Exempt touch mints nothing — but still normalize reconcile_needed to
      // a read-back array (the schema leaves it undefined until the first
      // mint) so a run whose only touches were exempt settles to [] rather
      // than undefined.
      store.updateRunOptimistic(run.id, (current) => (current.reconcile_needed ? current : { ...current, reconcile_needed: [] }));
    }
  } else {
    // Direct mode: CANDIDATE-ONLY — register the touch, mint nothing here.
    const now = new Date().toISOString();
    const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');
    mkdirSync(dirname(touchesPath), { recursive: true });
    withFileLock(
      touchesPath,
      () => {
        // parseTouchesContent (micro-round fixer, shared with H10 via
        // settlement.mjs), not a bare JSON.parse: a stray/malformed line on
        // disk must never throw here and silently stop every future H7
        // append (a bare JSON.parse would have thrown for this whole write).
        const touches = existsSync(touchesPath) ? parseTouchesContent(readFileSync(touchesPath, 'utf8')) : [];
        touches.push({ path: rel, at: now });
        writeFileSync(touchesPath, JSON.stringify(touches));
      },
      { onTimeout: () => store.recordCheckSkipped('h7-touches-lock', 'lock_timeout', undefined, now) }
    );
  }
  allow();
} catch (e) {
  warnNonBlocking(`H7: file-touch registration failed for '${rel}': ${e.message}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
