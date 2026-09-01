// H23 — OUTPUT-AXIS DELIVERY (board 5e3d6ff4; decision
// output-axis-delivery-h23-consumed-content-pointers, knowledge_get
// b266d6b7-8bdd-4b44-abcf-b7487c303854; concept family knowledge-delivery).
// H19 keys on the file PATH touched; H20 keys on the dispatch PROMPT; neither
// ever looks at what a tool call actually RETURNED — a log tail, a rendered
// artifact, a probe's stdout. Registered on PostToolUse Read and Bash
// (PowerShell too, per the decision) this hook runs H20's three-floor
// mechanism-axis match (AXIS_MIN_HITS, a discriminating hit, record
// centrality) over the CONSUMED CONTENT itself against anti_pattern/decision
// candidates. MEASURED FAILURES this closes (board 5e3d6ff4): 14 rendered
// plates were sent to the user against a standing gate while path-keyed
// delivery stayed silent at that exact moment (retro 2026-08-15-1520); an
// anti_pattern describing the conductor's exact confusion was never delivered
// because the conductor was reading ungoverned log/txt artifacts, not
// governed source (retro 2026-08-18).
//
// RETUNED 2026-08-31 (USER RULING h23-kept-raised-threshold-one-pointer-payload,
// knowledge_get 284fc4b0-d8a5-4b5b-aebc-e2d1cfaeec5e; board 1f26e2a5): this hook
// is KEPT — dropping it was rejected because one of its measured saves is
// structurally output-only, a class neither H19 nor H20 can reach — but its two
// cost knobs are turned down, because it is the largest single advisory consumer
// on this repo (57 of 103 all-time fires) at a ~6% follow rate. The PAYLOAD half
// is built: see OUTPUT_AXIS_POINTER_CAP (one pointer + the suppressed tail). The
// THRESHOLD half is NOT — the min_score machinery the ruling names cannot carry
// it portably; the measurements that establish that, and what they imply, sit
// beside that constant below. A FOLD into H19/H20 stays the ruling's own
// fallback if noise persists.
//
// POINTER, NOT SUBSTANCE, ENQUEUE-ONLY — same reasoning as H19's Bash-pointer
// channel: a content match is weaker evidence of relevance than an explicit
// file_keys join, and this hook fires on every Read/Bash whose output happens
// to share vocabulary with something in the store, so a false positive must
// cost one line, never an article. It never writes hookSpecificOutput
// directly; it only enqueues into the SAME pending queue h19-bash-delivery
// drains at the next UserPromptSubmit — enqueueing needs no probed injection
// cell at all, unlike direct injection (disclosed limitation in b266d6b7: the
// Read seam could inject at this machine's probed 'read' rung instead, kept
// as a one-change follow-up, not built speculatively here).
//
// READ SEAM IS OWNERSHIP-GATED, BASH SEAM IS NOT. A Read of governed
// territory already gets full article substance from H19 at the same
// moment — a second block for the same touch would be double delivery
// (alternatives_rejected in b266d6b7). Bash has no analogous substance
// channel for its output, so it always runs the match.
//
// OWN GUARD NAMESPACE (guard.output_axis), never guard.records: a pointer
// must not consume a record's H19/H20 substance-delivery eligibility, or
// pointing at a record here would silently suppress the real delivery later
// (the pointer-never-suppresses rule the Bash-pointer decision already
// established for guard.pointer_files vs guard.records).
//
// CONDUCTOR-ONLY, SILENT ON A SUBAGENT MARKER: the pending queue serves the
// conductor's next UserPromptSubmit, which a spawned agent never sees —
// enqueueing its touches would mis-route the pointer into the wrong context
// (the same correctness finding behind h19-knowledge-delivery/h19-bash-
// delivery's own agent_id carve-out).
//
// NEVER BLOCKS, NEVER THROWS OUT: every path below ends in allow()/exit 0,
// including malformed stdin (readStdin's JSON.parse is inside the same
// try/catch as everything else here, unlike h19/h20 where it sits outside
// theirs — this hook's own contract requires exit 0 even there), a missing
// tool_response, an unrecognised tool name, and any internal failure.
import { readStdin, allow, openStore, repoRel } from './lib/common.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  pendingPath,
  readGuard,
  writeGuard,
  enqueuePending,
  extractAxisTerms,
  axisHits,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  pointerVerifyRecipe,
  joinPointerBlock,
} from './lib/delivery.mjs';

// Clip and cap, named per the brief (b266d6b7): matching runs over the first
// 16,000 chars of the stringified tool_response only, and at most
// OUTPUT_AXIS_POINTER_CAP pointer lines render per block regardless of how many
// records matched.
export const OUTPUT_AXIS_CLIP = 16_000;
/** ONE pointer line + the suppressed-count tail (was 3 + tail), per USER RULING
 *  h23-kept-raised-threshold-one-pointer-payload (284fc4b0, 2026-08-31). H23 is
 *  KEPT — the drop-premise broke on the pre-check, because one of its real saves
 *  is structurally output-only (no path event for H19, no dispatch/ask event for
 *  H20 at that moment) — but it is measured as the largest single advisory
 *  consumer on this repo (57 of 103 all-time fires) at a ~6% follow rate, so the
 *  volume comes down where it is cheapest. The remainder is still DISCLOSED, never
 *  silently dropped: capping to one line must not turn "3 more matched" into
 *  "that is all there is" (the same cap-and-disclose rule renderHazards keeps). */
export const OUTPUT_AXIS_POINTER_CAP = 1;

// THE OTHER HALF OF RULING 284fc4b0 — THE RAISED MATCH THRESHOLD — IS NOT BUILT
// HERE, and deliberately so: the mechanism the ruling names cannot express it.
// Measured 2026-08-31, before implementing, and reported rather than shipped:
//
//   (1) min_score thresholds `-bm25(records_fts)`, which is IDF-WEIGHTED and so
//       corpus-relative in MAGNITUDE, not just in ordering. A floor tuned on this
//       repo's store (records passing the three axis floors: 49 -> 18 for
//       CLAUDE.md at a floor of 12, with pure-noise prose silenced by 6) reduces
//       to "never fires" on a young or homogeneous store: probed at corpus sizes
//       1, 4 and 20 where every record matched, EVERY record scored below 0.05,
//       so ANY positive floor silenced all of them. Shipping a constant would
//       have implemented DROP — the option this very ruling rejected on the
//       evidence — on every consumer project, silently.
//   (2) The two portable floors already exported for H20's deny path do not
//       substitute. STRICT_MIN_HITS (>=3 distinct hits) barely cuts (49->44,
//       29->24, and the noise samples not at all); hasFullNarrowCentralityCoverage
//       over-cuts (4 of 5 real samples to zero).
//   (3) The reframing both measurements force: H23's noise is NOT weak matches.
//       On a repo whose own text IS the store's subject matter, the records it
//       surfaces score high on every axis measure available — this is intrinsic
//       high recall, not a mis-set threshold.
//
// Left to the conductor + an outside-family consult, per the ruling's own
// fallback clause (FOLD into H19/H20 if noise persists).

/** Title-only clip: this channel renders NO guidance/rationale/statement
 *  prose inline, ever — a pointer line names the record, it never restates
 *  it (pointer-not-substance, same rule as H19's Bash pointers). */
function clipTitle(text, cap = 140) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

try {
  const input = readStdin();

  const toolName = input.tool_name;
  if (toolName !== 'Read' && toolName !== 'Bash' && toolName !== 'PowerShell') allow();

  // The queue serves the conductor's next prompt; a subagent never sees one.
  if (input.agent_id) allow();

  const rawResponse = input.tool_response;
  if (rawResponse === undefined || rawResponse === null) allow(); // nothing to match against

  const store = openStore(input.cwd);
  if (!store) allow(); // not a Sterling project — no ceremony (P1)

  // READ SEAM OWNERSHIP GATE: silent on territory an owning feature_article or
  // repo-located reference_material already covers — H19 delivers substance
  // (or, for a reference doc, its own pointer) there. Mirrors
  // h19-knowledge-delivery's owner query EXACTLY (same types, same
  // working_tree filter, review finding 2) so the two channels agree on what
  // 'governed' means — a divergent predicate here would silently disagree
  // with H19 about the same path. Unresolvable/outside-repo paths fall through
  // to the match (no jurisdiction to gate on).
  //
  // PATH EXCLUSIONS mirror h19-knowledge-delivery.mjs:41-42 (review finding
  // 1): reading the store's own tree or its delivery queue is the highest
  // false-positive input this hook could face, and it is self-referential —
  // matching on .sterling/transient/delivery/pending.json's own content would
  // let this hook feed itself.
  if (toolName === 'Read') {
    const rel = repoRel(input.tool_input?.file_path, input.cwd);
    if (rel === '.git' || rel?.startsWith('.git/')) allow();
    if (rel?.startsWith('.sterling/')) allow();
    if (rel) {
      const owners = store
        .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
        .filter((r) => !r.working_tree);
      if (owners.length) allow();
    }
  }

  // Stringify an object-shaped tool_response (e.g. a structured Bash result)
  // before matching; a string tool_response is matched as-is.
  const content = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const clipped = content.slice(0, OUTPUT_AXIS_CLIP);

  const terms = extractAxisTerms(clipped, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) allow(); // too little vocabulary to match on

  // STAGE 1 — narrow in the store, same two candidate types H19 serves.
  const candidates = [
    ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
    ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
  ];
  if (!candidates.length) allow();

  // STAGE 2 — the same three floors H20 proved: enough distinct hits, at
  // least one discriminating (not universal dev vocabulary), and the hits
  // must be central to the RECORD's own narrow fields, not a passing mention.
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits) && hasRecordCentralityHit(x.record, clipped))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) allow();

  // OWN DEDUP NAMESPACE — guard.output_axis, never guard.records/pointer_files.
  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);
  const seen = new Set(guard.output_axis ?? []);
  const fresh = scored.filter((x) => !seen.has(x.record.id));
  if (!fresh.length) allow(); // already pointed at this session, on this axis

  // Hazards lead, decisions follow — same ordering H19/H20 use everywhere
  // else in this concept family ("stop me before I repeat a mistake" first).
  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern');
  const decisions = fresh.filter((x) => x.record.type === 'decision');
  const ordered = [...hazards, ...decisions];
  const shown = ordered.slice(0, OUTPUT_AXIS_POINTER_CAP);
  const remainder = ordered.length - shown.length;

  // PER-RECORD LINES, keyed by id (fixer F1): the drain rebuilds this block from
  // the recipe, replaying a still-live record's line verbatim and REPLACING a
  // superseded/missing one with its stub, so the payload is assembled from the
  // same {header, lines, tail} decomposition the recipe carries. `header` and the
  // '(+N more matched)' tail interpolate no record field, so they replay verbatim.
  const header =
    'STERLING OUTPUT-AXIS DELIVERY (H23) — the tool output you just consumed matches governing knowledge. ' +
    'Pointer only, never a block: follow the read below before assuming the answer, never treat this line as the ruling itself.';
  const pointerLines = shown.map((x) => {
    const r = x.record;
    const kind = r.type === 'anti_pattern' ? 'HAZARD anti_pattern' : 'DECISION';
    const authorityMarker = r.authority ? `[${r.authority}] ` : '';
    return { id: r.id, line: `  → ${authorityMarker}${kind} '${clipTitle(r.title)}' · knowledge_get ${r.id}` };
  });
  const tail = remainder > 0 ? `  (+${remainder} more matched)` : '';

  // SIDE EFFECT FIRST, GUARD SECOND (the H19/H20 rule): writing the guard
  // before the enqueue lands turns any failure into permanent silent loss,
  // since the next touch would see the record already marked seen.
  recordAdvisoryFire(input.cwd, 'h23', input.session_id); // expiring campaign scaffolding — see lib/advisory-counter.mjs
  // POINTER-VERIFY recipe (decision db3392db part 2): pointer lines only, no
  // record body — the drain re-reads the SHOWN ids and REPLACES the line of any
  // that went superseded or missing between this match and the next prompt.
  // Only the shown ones: a record capped out of the payload was never pointed
  // at, so re-resolving it would disclose a record the reader never saw.
  enqueuePending(pendingPath(input.cwd), {
    kind: 'output_axis_pointers',
    rel: input.tool_input?.file_path ?? input.tool_input?.command ?? '',
    payload: joinPointerBlock({ header, lines: pointerLines, tail }),
    recipe: pointerVerifyRecipe({ header, entries: pointerLines, tail }),
    agent_id: 'conductor',
  });
  // Only the SHOWN (capped) records are marked seen — a record capped out of
  // the payload was never actually pointed at, so it stays eligible for a
  // later, smaller-batch match instead of being silently lost for the session.
  guard.output_axis = [...seen, ...shown.map((x) => x.record.id)];
  writeGuard(gPath, guard);
  allow();
} catch {
  // Delivery is an aid, never a gate, and this channel's own contract (unlike
  // H19/H20's warnNonBlocking-on-catch) is exit 0 on every path, including a
  // malformed-stdin JSON.parse failure inside readStdin() above.
  allow();
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
