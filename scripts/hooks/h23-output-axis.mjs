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
} from './lib/delivery.mjs';

// Clip and cap, named per the brief (b266d6b7): matching runs over the first
// 16,000 chars of the stringified tool_response only, and at most 3 pointer
// lines render per block regardless of how many records matched.
export const OUTPUT_AXIS_CLIP = 16_000;
export const OUTPUT_AXIS_POINTER_CAP = 3;

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

  const lines = [
    'STERLING OUTPUT-AXIS DELIVERY (H23) — the tool output you just consumed matches governing knowledge. ' +
      'Pointer only, never a block: follow the read below before assuming the answer, never treat this line as the ruling itself.',
  ];
  for (const x of shown) {
    const r = x.record;
    const kind = r.type === 'anti_pattern' ? 'HAZARD anti_pattern' : 'DECISION';
    const authorityMarker = r.authority ? `[${r.authority}] ` : '';
    lines.push(`  → ${authorityMarker}${kind} '${clipTitle(r.title)}' · knowledge_get ${r.id}`);
  }
  if (remainder > 0) lines.push(`  (+${remainder} more matched)`);

  // SIDE EFFECT FIRST, GUARD SECOND (the H19/H20 rule): writing the guard
  // before the enqueue lands turns any failure into permanent silent loss,
  // since the next touch would see the record already marked seen.
  enqueuePending(pendingPath(input.cwd), {
    kind: 'output_axis_pointers',
    rel: input.tool_input?.file_path ?? input.tool_input?.command ?? '',
    payload: lines.join('\n'),
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
