// H26 — dispatch-time overlap advisory (board b6a355f4-e5a6-4819-8e3f-a3ed8a175fc3).
// PreToolUse Task|Agent, joins the existing entry (after h8-dispatch-cap,
// h20-mechanism-axis, h25-dispatch-capability). NEVER a denial — no code path
// exits 2; internal failures (e.g. unparseable stdin) exit 1 via
// warnNonBlocking, every graceful degradation (missing/corrupt register, no
// candidates, no overlap, non-Sterling cwd) is a silent allow (exit 0).
// Governing decision: knowledge_get 6de73875-75b5-4182-8c1c-ca4841c993fa
// (slug lane-concept-first-slice-scope) is the authority on semantics — the
// first lane slice scoped the mechanism half to exactly this: reuse H22's
// in-flight dispatch register rather than build the heavier claimable-slots /
// knowledge_claim lease machinery ahead of measured collisions (P3).
//
// WHAT IT DOES: extracts path-like candidates from the OUTGOING dispatch's
// own tool_input.prompt (the same extractor H22 uses, lib/dispatch-prompt.mjs
// — PreToolUse sees only this call's tool_input, there is no transcript
// recovery to do here), normalizes them repo-relative POSIX and drops the
// same governed-exclusion prefixes H22 drops (.git/, .sterling/, sterling/,
// git/) so an excluded path never enters the candidate set on either side of
// the comparison. It then reads H22's register (.sterling/transient/
// dispatch-register.json) via the shared TTL reader (scripts/lib/
// dispatch-register.mjs liveDispatches — config dispatch_register.stale_minutes,
// default 60; corrupt/missing register degrades to []), additionally
// restricted to entries from THIS session (liveDispatches has no session
// context; only the hook does). When any live same-session entry's declared
// `files` exactly matches (repo-relative string equality) a candidate from
// the outgoing prompt, it emits a warn-only advisory naming the overlapping
// path(s), each overlapping dispatch as `agent_type:agent_id`, and the remedy
// (keep lanes file-disjoint: await the in-flight agent, or re-scope this
// dispatch's territory). A malformed register entry (missing `files` or
// missing agent_id) is skipped outright — it never fabricates an
// 'undefined:undefined' identity; a null agent_type (a shape H22 writes by
// design) is labeled with the 'agent' fallback, never dropped.
//
// KNOWN IMPRECISION (disclosed, not fixed here): the prompt extraction only
// APPROXIMATES write territory (free-form prose, not a declared file list).
// This hook compares only dispatches ALREADY PRESENT IN THE LIVE REGISTER
// when this PreToolUse fires — it never claims parallel dispatches fired in
// one message can't see each other; per-block attribution (decision
// 5d3747c1, slug h22-per-block-attribution) is what makes that comparison
// safe: an imprecise ('union'-attributed, or legacy entries with no
// `attribution` field at all) register entry is suppressed below rather than
// surfaced as a caveated warning that would cry wolf on every batch.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, repoRel } from './lib/common.mjs';
import { extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { liveDispatches } from '../lib/dispatch-register.mjs';

let input;
try {
  input = readStdin();
} catch (e) {
  // Internal failure — the stdin contract itself is broken, not a dispatch to
  // evaluate. Loud but non-blocking (P5 without a denial).
  warnNonBlocking(`H26: failed to parse stdin: ${(e && e.message) || e}`);
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext },
    })
  );
}

try {
  // Not a Sterling project — no ceremony (P1), same DB-file marker every
  // other hook in this layer keys on.
  if (!existsSync(join(input.cwd ?? '.', '.sterling', 'sterling.db'))) allow();

  const candidates = extractPathCandidates(input.tool_input?.prompt);
  // Repo-relative POSIX only, with H22's exact exclusion filter mirrored
  // verbatim: .git/.sterling are never governed territory, and the dot-
  // stripped 'sterling/…'/'git/…' forms the extractor can produce are
  // dropped too, so an excluded path never enters the candidate set at all.
  const files = [...new Set(candidates.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
    (r) =>
      r !== '.git' &&
      !r.startsWith('.git/') &&
      !r.startsWith('.sterling/') &&
      !r.startsWith('sterling/') &&
      !r.startsWith('git/')
  );
  if (!files.length) allow();

  const candidateSet = new Set(files);

  const live = liveDispatches(input.cwd).filter((e) => e && e.session_id === input.session_id);
  if (!live.length) allow();

  const overlaps = [];
  const overlapPaths = new Set();
  for (const e of live) {
    // A malformed entry (no `files` array, no agent_id — the entry key) is
    // skipped outright: it can never contribute an overlap, and it must never
    // surface as a bogus 'undefined:undefined' dispatch identity. agent_type
    // is NOT required — H22 writes `agent_type ?? null` by design, so a null
    // type gets the same 'agent' fallback label the script-side reader uses
    // (scripts/lib/dispatch-register.mjs inFlightAdvisory).
    if (!e || !Array.isArray(e.files) || !e.agent_id) continue;
    // IMPRECISE ATTRIBUTION IS SUPPRESSED, NOT CAVEATED (decision 5d3747c1):
    // an entry H22 could only union across several/zero type-matching blocks
    // (attribution:'union') may not actually name this dispatch's territory,
    // and a legacy entry with no `attribution` field at all predates this
    // mechanism and carries the same old union-of-everything imprecision —
    // both are skipped outright so a warning never fires on files that may
    // not belong to the sibling it names. Only attribution:'block' entries
    // (a provable single type-matching source block) still warn.
    if (e.attribution !== 'block') continue;
    const matched = e.files.filter((f) => candidateSet.has(f));
    if (matched.length) {
      overlaps.push({ agentType: e.agent_type ?? 'agent', agentId: e.agent_id, files: matched });
      matched.forEach((f) => overlapPaths.add(f));
    }
  }
  if (!overlaps.length) allow();

  const pathList = [...overlapPaths].map((p) => `'${p}'`).join(', ');
  const entryList = overlaps.map((o) => `${o.agentType}:${o.agentId} (${o.files.join(', ')})`).join('; ');
  emit(
    `H26 DISPATCH OVERLAP ADVISORY — this dispatch's brief names file(s) that overlap a LIVE in-flight ` +
      `dispatch's declared territory: ${pathList}. Overlapping live dispatch(es): ${entryList}. This is ` +
      `warn-only, never a block — the prompt extraction only approximates write territory, and this hook ` +
      `compares only dispatches already present in the live register when this PreToolUse fires. Remedy: ` +
      `keep lanes file-disjoint — await the in-flight agent, or re-scope this dispatch's territory so it does ` +
      `not overlap.`
  );
  allow();
} catch (e) {
  // Advisory only, never a gate: loud but non-blocking (P5 without AC7 harm).
  warnNonBlocking(`H26: dispatch-overlap advisory failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
