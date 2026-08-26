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
import { readStdin, allow, warnNonBlocking, repoRel, loadConfig } from './lib/common.mjs';
import { extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { liveDispatches } from '../lib/dispatch-register.mjs';
import { hasUnsuppressedMatch, escapeRe, isReadOnlyDispatchType } from './lib/dispatch-advisory.mjs';
import { claimedResources } from './lib/dispatch-residue.mjs';

/**
 * SPEC B advisory text for a claimed resource already held by a live
 * dispatch — flat, uncaveated (no hedging tokens; SPEC B (5)), names every
 * contested resource and every distinct holder identity `type:id`.
 */
function buildResourceAdvisory(contested) {
  const resourceList = [...new Set(contested.map((c) => c.name))].map((n) => `'${n}'`).join(', ');
  const holderList = [...new Set(contested.map((c) => `${c.agentType}:${c.agentId}`))].join(', ');
  return (
    `H26 RESOURCE OVERLAP ADVISORY — this dispatch's brief claims exclusive resource(s) ${resourceList}, ` +
    `already held by live in-flight dispatch(es): ${holderList}. This is warn-only, never a block (decision ` +
    `6de73875-75b5-4182-8c1c-ca4841c993fa). It may repeat on further dispatches while the holding dispatch stays ` +
    `live, since the prompt extraction only approximates territory. Remedy: ` +
    `coordinate with the holder before proceeding, or drop the resource claim.`
  );
}

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
  const prompt = input.tool_input?.prompt;

  // Session-scoped live register, shared by the resource check below and the
  // file-overlap check further down (same liveness/TTL semantics either way).
  // liveDispatches reads only the register/config JSON files — no store
  // dependency — so this is safe to compute even outside a Sterling project.
  const live = liveDispatches(input.cwd).filter((e) => e && e.session_id === input.session_id);

  // SPEC B — EXCLUSIVE NON-FILE RESOURCE CLAIM. This runs BEFORE both (a) the
  // sterling.db project-marker gate just below and (b) the read-only-
  // dispatch-class early return further down: a reviewer/explorer-class
  // dispatch's FILE overlap stays suppressed (unchanged), but a resource it
  // claims that a live entry already holds must still warn — resources are
  // not write-territory, and the check needs only config.json + the register
  // (never the store), so it never needed the sterling.db gate to begin with.
  // A directory with no .sterling/config.json at all yields configuredNames
  // === [] and stays silent regardless (the non-Sterling control case).
  const cfg = loadConfig(input.cwd);
  const configuredNames = Array.isArray(cfg?.exclusive_resources)
    ? cfg.exclusive_resources.filter((n) => typeof n === 'string' && n.trim())
    : [];
  let resourceAdvisory = '';
  if (configuredNames.length) {
    const claimed = claimedResources(prompt, configuredNames);
    if (claimed.length) {
      const contested = [];
      for (const e of live) {
        // Same pruning semantics as the file-overlap comparison below: a
        // malformed entry (no agent_id) or an imprecisely-attributed one
        // (not a provable single-block claim) never contributes a warning.
        if (!e || !e.agent_id || e.attribution !== 'block' || !Array.isArray(e.exclusive_resources)) continue;
        for (const name of claimed) {
          if (e.exclusive_resources.includes(name)) {
            contested.push({ name, agentType: e.agent_type ?? 'agent', agentId: e.agent_id });
          }
        }
      }
      if (contested.length) resourceAdvisory = buildResourceAdvisory(contested);
    }
  }

  // Combine whichever advisories fired (file overlap, resource overlap, both,
  // or neither) into one emission and exit — every early return below routes
  // through this so the resource advisory is never lost when the file-overlap
  // check bails out earlier (non-Sterling cwd, no candidates, no live
  // entries, no overlap).
  function finish(fileAdvisory) {
    const parts = [fileAdvisory, resourceAdvisory].filter(Boolean);
    if (parts.length) emit(parts.join('\n\n'));
    allow();
  }

  // Not a Sterling project — no ceremony for FILE overlap (P1), same DB-file
  // marker every other hook in this layer keys on. The resource advisory
  // computed above still surfaces (it never touched the store).
  if (!existsSync(join(input.cwd ?? '.', '.sterling', 'sterling.db'))) finish();

  // READ-ONLY incoming dispatch (board a6b76e8c item 3): a reviewer/explorer/
  // Explore/Plan class cannot write, so it can never enter a live write lane
  // — never warn FILE overlap for one, regardless of prompt content. The
  // resource advisory computed above is unaffected by this exemption.
  if (isReadOnlyDispatchType(input.tool_input?.subagent_type)) finish();

  const candidates = extractPathCandidates(prompt);
  // Repo-relative POSIX only, with H22's exact exclusion filter mirrored
  // verbatim: .git/.sterling are never governed territory, and the dot-
  // stripped 'sterling/…'/'git/…' forms the extractor can produce are
  // dropped too, so an excluded path never enters the candidate set at all.
  // KEEP THE PRE-NORMALIZATION STRING for the suppression check (review
  // finding, board a6b76e8c fixer pass): a Windows-style mention
  // ('src\util.mjs') normalizes to 'src/util.mjs', which never literally
  // appears in the RAW prompt — searching the normalized form there silently
  // dropped every such candidate as "not found" rather than warning on it.
  // The normalized form is still what feeds the register comparison below.
  const normalized = candidates
    .map((raw) => ({ raw, norm: repoRel(raw, input.cwd) }))
    .filter((p) => p.norm)
    .filter(
      (p) =>
        p.norm !== '.git' &&
        !p.norm.startsWith('.git/') &&
        !p.norm.startsWith('.sterling/') &&
        !p.norm.startsWith('sterling/') &&
        !p.norm.startsWith('git/')
    );
  // Then the SHARED PROHIBITION/NEGATION CHECK (board a6b76e8c item 1): a
  // path named only inside a prohibition ("DO NOT TOUCH: <paths> (another
  // lane owns those)") is a NEGATIVE territory declaration, not a positive
  // claim on this dispatch's own lane — it must never count as a candidate.
  // checkSubjectVerb:false — "implement the feature in <path>" is a
  // legitimate territory declaration for a FILE candidate, not a
  // subject-of-change mention to discount (that guard is for H25's tool
  // mentions only); only an actual negation suppresses a path here.
  const files = [
    ...new Set(
      normalized
        .filter((p) => hasUnsuppressedMatch(prompt, new RegExp(escapeRe(p.raw)), { checkSubjectVerb: false }))
        .map((p) => p.norm)
    ),
  ];
  if (!files.length) finish();

  const candidateSet = new Set(files);

  if (!live.length) finish();

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
    // TERRITORY CLAIMED, NOT TERRITORY EXAMINED (board c56862a9,
    // research_finding 289cd172). H22's `files` is multiplexed — review
    // receipts, residue probes and H10's deferral all need every path the
    // brief MENTIONED, including the ones it forbade — so H22 keeps writing
    // that breadth and adds `claimed_files`, the same paths minus those named
    // only inside a prohibition ("DO NOT TOUCH: <path>"). An overlap warning
    // is about WRITE territory, so it reads the claimed subset: warning a new
    // lane off a path its neighbour was explicitly told NOT to touch is the
    // measured false positive (seven in one session), and it punished exactly
    // the briefs that named their do-not-touch lists most carefully.
    // A pre-field entry has no `claimed_files` and falls back to `files` —
    // today's behavior, never a silently empty lane.
    const entryFiles = Array.isArray(e.claimed_files) ? e.claimed_files : e.files;
    const matched = entryFiles.filter((f) => candidateSet.has(f));
    if (matched.length) {
      overlaps.push({ agentType: e.agent_type ?? 'agent', agentId: e.agent_id, files: matched });
      matched.forEach((f) => overlapPaths.add(f));
    }
  }
  if (!overlaps.length) finish();

  const pathList = [...overlapPaths].map((p) => `'${p}'`).join(', ');
  const entryList = overlaps.map((o) => `${o.agentType}:${o.agentId} (${o.files.join(', ')})`).join('; ');
  finish(
    `H26 DISPATCH OVERLAP ADVISORY — this dispatch's brief names file(s) that overlap a LIVE in-flight ` +
      `dispatch's declared territory: ${pathList}. Overlapping live dispatch(es): ${entryList}. This is ` +
      `warn-only, never a block (decision 6de73875-75b5-4182-8c1c-ca4841c993fa) — the prompt extraction only approximates write territory, and this hook ` +
      `compares only dispatches already present in the live register when this PreToolUse fires. It may repeat ` +
      `on further dispatches while the holding dispatch stays live, for the same reason. Remedy: ` +
      `keep lanes file-disjoint — await the in-flight agent, or re-scope this dispatch's territory so it does ` +
      `not overlap.`
  );
} catch (e) {
  // Advisory only, never a gate: loud but non-blocking (P5 without AC7 harm).
  warnNonBlocking(`H26: dispatch-overlap advisory failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
