// H7 — file-touch reconcile register (spec §6 H7). PostToolUse
// Edit|Write|MultiEdit, non-blocking. Direct mode is the only mode (the
// staged pipeline was removed, scale-down decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1; a consumer store's
// `runs` table survives only as an orphan — obsolete run state must never
// suppress capture, so this hook no longer branches on it at all). Look up
// owning articles (file-key join) via H7 CANDIDATE-ONLY + SETTLEMENT-TIME
// MINTING (board c198866d): it registers the touched path in the transient
// touch register (.sterling/transient/touches.json) — the same register H10
// already reads for its capture check — and mints NOTHING itself. Minting
// moves to SETTLEMENT: scripts/hooks/lib/settlement.mjs's
// mintSettlementReconcile, called from h10-direct-capture.mjs's Stop and
// direct-merge.mjs's pre-merge backstop, hashes the FINAL candidate content
// against the owning article's CURRENT baseline — so an edit-then-revert, or
// a path an intervening knowledge_update (or an attested close, R9) already
// rebaselined, never mints. The pipeline arm's own generated_projections
// exemption (ruling e1275166) was pipeline-mint-time-only and dies with the
// branch that minted on the run; the direct-mode equivalent already lives in
// settlement.mjs's mintSettlementReconcile, untouched here.
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
import { withFileLock, parseTouchesContent } from './lib/settlement.mjs';

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
  // Direct mode is the only mode (the staged pipeline's run branch was
  // removed with the pipeline itself — scale-down decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1). CANDIDATE-ONLY:
  // register the touch, mint nothing here.
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
  allow();
} catch (e) {
  warnNonBlocking(`H7: file-touch registration failed for '${rel}': ${e.message}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
