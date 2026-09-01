// H19 — BASH POINTER DELIVERY (board 841195b1; concept family
// knowledge-delivery). Delivery's blind spot: it rode Edit|Write|MultiEdit and
// Read, while the surveying that decides what to change happens through grep,
// wc, git log and awk. Four consuming-project reports named this independently
// — the fourth measured roughly a dozen Bash investigations in one session with
// ZERO knowledge delivered. The gap is worse than it sounds because it is
// SILENT: a missing injection looks exactly like there being no knowledge.
//
// THREE THINGS THIS HOOK DOES DIFFERENTLY FROM h19-knowledge-delivery, each for
// a measured reason:
//
//  1. IT DELIVERS A POINTER, NOT THE ARTICLE. Measured on this machine
//     2026-08-03: two real H19 payloads were 13,010 and 17,078 bytes, because
//     payload_char_cap is applied per FIELD and hazards are uncapped — one
//     delivery has no total ceiling. A Bash pass issues many more calls than a
//     Read pass and issues them precisely to AVOID the cost of reading the
//     file, so full-article delivery here could cost more context than the
//     reads it protects. One line per owned path is the design, not a
//     degradation.
//  2. IT ALWAYS ENQUEUES, WHATEVER THE RUNG. injection_rung is probe-set per
//     CELL, and upstream #55889 (research_finding d21d70c6) reports
//     additionalContext DROPPED for the Bash matcher specifically while other
//     matchers worked — auto-closed by a stale-bot, not by a fix. This machine's
//     rung 'read' was probed on the Read/Edit matchers, which is a DIFFERENT
//     cell; honouring it here would bet delivery on an unprobed surface that
//     fails silently. Enqueueing needs no output channel at all (a file write
//     and a clean exit), and h19-delivery-drain's UserPromptSubmit injection is
//     the one surface proven on this platform. Cost: a one-turn lag. Raising
//     this to direct injection is licensed by a probe of the Bash cell, nothing
//     less.
//  3. IT IS SILENT ON UNOWNED TERRITORY. The frontier signal is right for an
//     edit — you are about to work there. On Bash it would fire on every grep
//     across every unowned file, which is most of a survey (P1: a signal that
//     always fires teaches you to ignore it).
//
// SCOPE LIMIT, disclosed not hidden: this serves the CONDUCTOR only. The pending
// queue drains at UserPromptSubmit, which a subagent never sees, so enqueueing a
// subagent's touches would mis-route its knowledge into the conductor's context
// (the correctness finding that shaped the same rule in h19-knowledge-delivery).
// Pipeline agents get prep's knowledge_pack instead; a direct-mode subagent's
// Bash surveying is genuinely uncovered until the Bash cell is probed.
import { readStdin, allow, warnNonBlocking, openStore, repoRel } from './lib/common.mjs';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  guardPath,
  pendingPath,
  readGuard,
  writeGuard,
  enqueuePending,
  extractCommandPathCandidates,
  bashPointerBlock,
  joinPointerBlock,
  pointerVerifyRecipe,
  BASH_POINTER_PATH_CAP,
  budgetKnownGaps,
  isGapDelivered,
  markGapDelivered,
} from './lib/delivery.mjs';

const input = readStdin();
const command = input.tool_input?.command;
if (!command) allow(); // nothing to parse (not a shell call, or a malformed one)

// The queue serves the conductor's next prompt; a subagent never sees one.
if (input.agent_id) allow();

const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

try {
  // NO run gating here, deliberately: a pipeline AGENT is already excluded above
  // (the pending queue is the conductor's), and the conductor's own inline
  // surveying during a run deserves delivery exactly as much as it does outside
  // one — which is what h19-knowledge-delivery's AC6 carve-out says too.
  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);

  const entries = [];
  const delivered = [];
  for (const candidate of extractCommandPathCandidates(command)) {
    if (entries.length >= BASH_POINTER_PATH_CAP) break;
    const rel = repoRel(candidate, input.cwd);
    if (!rel) continue; // outside the repo: no delivery jurisdiction
    if (rel === '.git' || rel.startsWith('.git/')) continue; // machinery internals (H7 precedent)
    if (rel.startsWith('.sterling/')) continue; // the store's own tree is never governed
    if (guard.pointer_files.includes(rel)) continue; // pointed at once this session

    // THE REAL FILTER. A shape-only extractor cannot tell `grep -n foo path`
    // from `grep -n path .`, and it does not need to: a search pattern that is
    // not a file on disk dies right here. Directories are excluded because
    // ownership is declared per FILE — a governed directory would fan one `ls`
    // out across every article beneath it.
    let abs;
    try {
      abs = join(input.cwd, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    } catch {
      continue;
    }

    const owners = store
      .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
      .filter((r) => !r.working_tree);
    const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
    // Silent on unowned territory (reason 3 in the header) — and silent when a
    // path carries nothing at all, which is the common case in a wide survey.
    if (!owners.length && !hazards.length) continue;

    entries.push({ rel, owners, hazards });
    delivered.push(rel);
  }

  if (!entries.length) allow();

  // KNOWN_GAPS RE-EMISSION AT THE BASH/PROBE-OUTPUT SEAM (board f1489964,
  // decision known-gaps-inline-ships-with-probe-seam-boarded 53fd6f62's ship
  // condition — closed here). The inline known_gaps slice (h19-knowledge-
  // delivery.mjs) never reaches the exact moment a probe's OUTPUT is trusted,
  // because this hook is pointer-only. Trigger is NARROW and reuses the
  // owners already resolved above for the pointer line — an OWNED PATH NAMED
  // IN THE COMMAND, never free-text output matching (that is H23's separate
  // axis). Its OWN bounded dedup (guard.gap_articles via isGapDelivered/
  // markGapDelivered) — deliberately separate from `pointer_files` above and
  // from the Read/Edit path's `records`/`slugs` guard, so a probe re-showing
  // gaps this session is bounded without being starved by, or starving, an
  // unrelated Read of the same file.
  const gapOwners = [];
  const seenGapOwnerIds = new Set();
  for (const e of entries) {
    for (const o of e.owners) {
      if (!Array.isArray(o.known_gaps) || !o.known_gaps.length) continue; // nothing recorded
      if (seenGapOwnerIds.has(o.id)) continue; // named by >1 candidate path in this command
      seenGapOwnerIds.add(o.id);
      if (isGapDelivered(guard, o)) continue; // already re-emitted this session at this seam
      gapOwners.push(o);
    }
  }
  // GLOBAL 3-gap budget, same helper the Read/Edit path uses (no divergent
  // copy) — an empty gapOwners list yields an empty Map, so bashPointerBlock's
  // gapsByOwner?.get(...) is always undefined and the payload is BYTE-
  // IDENTICAL to before this addition whenever no candidate owner carries a
  // gap (or every candidate was already gap-delivered this session).
  const gapsByOwner = budgetKnownGaps(gapOwners);

  // SIDE EFFECT FIRST, GUARD SECOND (the h19-knowledge-delivery rule): the guard
  // is what makes delivery once-per-session, so writing it before the delivery
  // happens turns any failure into permanent silent loss — nothing retries,
  // because the next touch sees the paths already marked.
  // POINTER-VERIFY recipe (decision db3392db part 2, v2 per fixer F1): the block
  // is enqueued DECOMPOSED — the fixed two-sentence header plus one {id, line}
  // per record — so the drain can REBUILD it: a still-live record's line replays
  // verbatim, while a superseded or missing one is REPLACED by its stub. The
  // earlier shape sent bare ids and let the drain append disclosures beneath the
  // whole cached blob, which left the dead record's own line standing above the
  // footnote, still naming it as governing this path. Gap substance rides the
  // SAME per-owner {id, line} entry (see bashPointerBlock), so it inherits the
  // identical live/superseded/missing verdict as the pointer it sits beside.
  const block = bashPointerBlock(entries, { gapsByOwner });
  enqueuePending(pendingPath(input.cwd), {
    kind: 'bash_pointers',
    rel: delivered.join(' '),
    payload: joinPointerBlock(block),
    recipe: pointerVerifyRecipe({ header: block.header, entries: block.lines }),
    agent_id: 'conductor',
  });
  guard.pointer_files.push(...delivered);
  // MARK ONLY WHAT ACTUALLY RENDERED (fixer round LOW finding, mirrors the
  // cappedHazards precedent: a hazard/decision capped OUT of a payload is
  // never marked delivered, so it can surface on a later touch instead of
  // vanishing). An owner whose ENTIRE gap allocation lost the shared budget
  // this touch (info.shown.length === 0, e.g. a later owner in a delivery
  // whose earlier owners already spent the global cap) must not consume its
  // one shot at this seam's dedup — a subsequent probe of its territory
  // should still get a real chance to show its gaps, not a permanently
  // suppressed "0 of N" repeat.
  const deliveredGapOwners = gapOwners.filter((o) => (gapsByOwner.get(o.id)?.shown?.length ?? 0) > 0);
  if (deliveredGapOwners.length) markGapDelivered(guard, deliveredGapOwners);
  writeGuard(gPath, guard);
  allow();
} catch (e) {
  // Delivery is an aid, never a gate: internal failure is loud but NON-blocking
  // (P5 visibility without an AC7 violation).
  warnNonBlocking(`H19: bash pointer delivery failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
