// H1's maintenance-queue lines, host-neutral: the system-todo summary, the
// deep-queue signal and the reconcile backlog line. Extracted from
// h1-session-start.mjs so the OpenCode context hook states the SAME text from the
// SAME code (board cbee2b3d, audit f2ba68c2 row 2). A sibling of operating-state.mjs,
// not part of it: it carries the maintenance-worker lib (lockfile and journal
// reads, which both hosts share), which the dispatch-staging bundles must not pull in.
// Each line function returns the bare text, or '' when nothing is stated.
import { ageText, isJudgedOwesProse, owesProseVerdicts, workerBreakage, workerStatus } from './maintenance-worker.mjs';

/**
 * The system-todo summary: the TRUE total (store.count, never a capped read), the
 * reconcile backlog (count, owes-prose count, oldest created_at), the drainable and
 * parked counts and the per-lane breakdown.
 */
export function readMaintenanceState(store, cwd) {
  const reconcile = { count: 0, owesProse: 0, oldest: null };
  let queueReasonEntries = [];
  let queueReasons = [];
  let drainable = 0;
  let parked = 0;
  const systemTotal = store.count({ types: ['todo'], source: 'system' });
  const system = systemTotal > 0 ? store.query({ types: ['todo'], source: 'system', cap: systemTotal }) : [];
  // file_parked closes at branch merge (direct-merge sweeps it), never by
  // draining — counting it toward the deep-queue threshold makes H1 cry wolf
  // about items no drain can touch, and a standing warning about undrainable
  // items trains the operator to ignore the warning (2026-08-09 consuming
  // project: 15 by-design-open file_parked items tripped this every session
  // start). It stays in counts.maintenance (the human's banner shows the true
  // total); only the DRAIN signal excludes it.
  // RECONCILE BACKLOG AGE (decision maintenance-queue-background-haiku-worker-
  // simple-redesign point (5)): the count and the oldest created_at, so a
  // backlog nobody drains shows its age instead of only its size.
  const reconcileItems = system.filter((t) => t.system_reason === 'reconcile_needed');
  reconcile.count = reconcileItems.length;
  // 'owes prose' is judged per (item id, current file_keys) in the worker's
  // JSONL, never marked on the item itself.
  try {
    const verdicts = owesProseVerdicts(cwd);
    reconcile.owesProse = reconcileItems.filter((t) => isJudgedOwesProse(t, verdicts)).length;
  } catch {
    reconcile.owesProse = null; // unreadable journal: say so below, never a confident 0
  }
  reconcile.oldest = reconcileItems.map((t) => t.created_at).filter(Boolean).sort()[0] ?? null;
  const drainableItems = system.filter((t) => t.system_reason !== 'file_parked');
  drainable = drainableItems.length;
  parked = system.length - drainable;
  // Lane breakdown for the deep-queue signal below: a bare total says "drain",
  // a per-lane split says WHAT is owed, which is what decides how to drain it.
  // Phrased as "N item(s) in lane <reason>" (not "<reason> ×N"): a lane
  // legitimately landing on a round number (e.g. 100) must read unambiguously
  // as a per-lane count, never as evidence of a silent truncation to some
  // common cap literal.
  const byReason = new Map();
  for (const t of drainableItems) byReason.set(t.system_reason, (byReason.get(t.system_reason) ?? 0) + 1);
  queueReasonEntries = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  queueReasons = queueReasonEntries.map(([r, n]) => `${n} item${n === 1 ? '' : 's'} in lane ${r}`);
  return { total: systemTotal, reconcile, drainable, parked, queueReasonEntries, queueReasons };
}

/**
 * The deep-queue signal for the conductor, or '' below `deepThreshold`
 * (config.maintenance_queue.deep_threshold, default 15, clamped to >= 1).
 */
export function queueDepthLine({ drainable, parked, queueReasons, queueReasonEntries, deepThreshold: rawThreshold }) {
  // DEEP-QUEUE SIGNAL TO THE CONDUCTOR (config.maintenance_queue.deep_threshold).
  // The counts above go to the human as a systemMessage, which the MODEL never
  // sees — correct while the queue is shallow and event-drained, wrong once it is
  // deep, because the human is not the one who drains it. A consuming project
  // reached 63 items, most of them work finished days earlier and never closed,
  // with nothing anywhere prompting a drain (reported 2026-07-29). Silent below the
  // threshold (P1); above it, states the depth, the lanes, and the remedy.
  //
  // TWO TIERS (board 91fc3d6f): "drain it before taking new work" is an honest ask
  // at a few dozen items, but not at hundreds — a consuming project measured 247
  // drainable items against 5 closed in one drain pass, i.e. an instruction whose
  // only honest response was to ignore it ("is not a drain, it is evaporation").
  // TOO_DEEP_MULTIPLIER anchors the second tier off the SAME deep_threshold that
  // gates the first: at 10x threshold (default 150), naming every lane is no
  // longer readable and a blanket "drain it" is no longer actionable, so the
  // message switches to naming the top few lanes by count with a BOUNDED ask
  // (drain the biggest lane, or board a dedicated drain slice for the rest)
  // instead of repeating the same unattainable instruction at a larger number.
  const TOO_DEEP_MULTIPLIER = 10;
  let queueContext = '';
  // Clamped to >= 1 (reviewer F1): a corrupt/hostile deep_threshold <= 0 would
  // otherwise make BOTH tier conditions true even on an EMPTY drainable queue —
  // queueReasonEntries[0] would then be undefined and the destructure below
  // would throw OUTSIDE this try/finally, crashing H1 non-zero and losing the
  // whole injection (including an already-consumed rotation note — unrecoverable).
  const deepThreshold = Math.max(1, rawThreshold ?? 15);
  if (drainable >= deepThreshold) {
    const parkedNote =
      parked > 0 ? ` plus ${parked} file_parked (close at branch merge, not by drain — excluded from this count)` : '';
    // Second guard (reviewer F1, belt-and-suspenders alongside the clamp above):
    // never take the very-deep branch with an empty lane breakdown — fall back
    // to the modest-tier wording instead of destructuring an undefined entry.
    if (drainable >= deepThreshold * TOO_DEEP_MULTIPLIER && queueReasonEntries.length) {
      // Every count named below stays in the "N item(s) in lane X" shape (never a
      // bare number) — the same phrasing the moderate tier already uses — so a
      // lane count can never be misread as a truncated/capped total.
      const topLanes = queueReasons.slice(0, 3);
      const [topReason, topCount] = queueReasonEntries[0];
      const topPhrase = `${topCount} item${topCount === 1 ? '' : 's'} in lane ${topReason}`;
      // "too many to name in full" is only true past the top-3 we actually show
      // (reviewer cosmetic note: it read as false with exactly 2 lanes).
      const laneLead =
        queueReasonEntries.length > topLanes.length
          ? `Too many lanes to name in full, and "drain it all before new work" is not a workable ask at this size. The biggest lanes: ${topLanes.join(', ')}. `
          : `"Drain it all before new work" is not a workable ask at this size. The lane split: ${topLanes.join(', ')}. `;
      queueContext =
        `\n\nMAINTENANCE QUEUE IS VERY DEEP — ${drainable} drainable items across ${queueReasonEntries.length} lane(s)${parkedNote}.\n` +
        laneLead +
        `Drain the biggest lane now (${topPhrase}), or board a dedicated drain slice for the rest — don't try to clear the whole queue in one pass. ` +
        `Expect much of it to be ALREADY DONE work never closed, so verify each item against HEAD before writing anything back ` +
        `(an already-paid item closes with board_remove and NO knowledge_update). ` +
        `A queue this deep is itself a signal: items are arriving faster than anyone is closing them.`;
    } else {
      queueContext =
        `\n\nMAINTENANCE QUEUE IS DEEP — ${drainable} drainable items (${queueReasons.join(', ')})${parkedNote}.\n` +
        `Drain it with /sterling:drain before taking new work, and expect much of it to be ALREADY DONE: ` +
        `the queue records debt the mechanism detected, not debt that is necessarily still owed, so each item is verified against HEAD first ` +
        `(an already-paid item closes with board_remove and NO knowledge_update — a version bump claiming a reconcile that added nothing is itself drift). ` +
        `A deep queue is also a signal in its own right: items that keep arriving faster than they close mean either the drain is being skipped or a hook is over-firing.`;
    }
    // The maintenance-item COUNT itself (in the systemMessage banner above) is a
    // persistent visibility count by design: items close only at their
    // lane-specific events (e.g. file_parked only at merge), so a stable count
    // is not a failed drain — that attribution belongs here, on the surface
    // that carries prose, not on the banner's pinned counts-only contract.
    queueContext +=
      ' This is a persistent visibility count by design — items close only at their lane-specific events, e.g. file_parked only at merge, so a stable count is not a failed drain.';
  }
  return queueContext.replace(/^\n\n/, '');
}

/**
 * The reconcile backlog: `banner` is the human banner segment (' · ...', or ''),
 * `line` the bare conductor line (or '').
 */
export function reconcileBacklog({ reconcile, cwd }) {
  // RECONCILE BACKLOG LINE: one '·' segment on the human banner (after the
  // maintenance clause, so that clause's text is unchanged) and one line for the
  // conductor, who drafts the prose the worker leaves owed. Silent when there
  // is no reconcile item (P1). Worker state comes from its lockfile. A BROKEN
  // last run (workerBreakage: non-zero exit, error result, permission denials,
  // MCP not connected) adds one clause naming its reason and the log; routine
  // states (back-off, nothing eligible, no progress) add nothing, because the
  // worker's routine status is not the session's business (decision
  // maintenance-worker-notices-session-start-only-and-no-sliver-launch).
  let reconcileBanner = '';
  let reconcileContext = '';
  if (reconcile.count > 0) {
    let worker = 'worker not running';
    let lastRunNote = '';
    try {
      const ws = workerStatus(cwd);
      if (ws.running) worker = `worker running (pid ${ws.pid}, since ${ws.since})`;
      const broken = workerBreakage(ws.lastRun);
      if (broken) lastRunNote = `; last worker run FAILED at ${broken.at}: ${broken.reason} (log: .sterling/maintenance-worker.log)`;
    } catch (e) {
      worker = `worker state unreadable (${e?.message ?? e})`;
    }
    const age = ageText(reconcile.oldest);
    // Counts keep H1's "N item(s) in lane <reason>" shape, so a round number
    // can never read as a truncated cap (h1-accuracy AC1).
    const inLane = (n) => `${n} item${n === 1 ? '' : 's'} in lane reconcile_needed`;
    reconcileBanner = ` · ${inLane(reconcile.count)}, oldest ${age}, ${worker}${lastRunNote}`;
    reconcileContext =
      `\n\nRECONCILE BACKLOG: ${inLane(reconcile.count)}, the oldest open since ${reconcile.oldest ?? 'unknown'} (${age}). ` +
      (reconcile.owesProse === null
        ? `The worker's verdict journal (.sterling/maintenance-worker.jsonl) is unreadable, so which items owe prose is unknown. `
        : `Of these, ${inLane(reconcile.owesProse)} are judged 'owes prose' by the background worker (.sterling/maintenance-worker.jsonl) and wait on you to draft the article change. `) +
      `${worker}${lastRunNote}.`;
  }
  return { banner: reconcileBanner, line: reconcileContext.replace(/^\n\n/, '') };
}
