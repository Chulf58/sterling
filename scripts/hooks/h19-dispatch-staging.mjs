// H19 — dispatch staging (AC5; board 7b01f139-7341-4d3c-9991-6c1c27ceafc7,
// probe evidence 35a89a0f-120e-4b18-97f9-63dc82016c74). SubagentStart hook (no
// matcher — every agent type): stages the SAME knowledge-delivery payload
// h19-knowledge-delivery.mjs computes for a governed touch, but for the
// territory named in the DISPATCH PROMPT rather than a file the spawned agent
// has touched yet. Closes the gap the board item names: N agents can start
// reasoning from one stale premise before any of their own Read/Edit ever
// fires the file-touch hook.
//
// LIVE-PROBED, not inferred (2026-08-04, research_finding 35a89a0f):
// SubagentStart's hookSpecificOutput.additionalContext lands in the SPAWNED
// subagent's own context (not the parent's), on the WSL CLI headless surface,
// CC 2.1.220. Its stdin carries session_id, transcript_path, cwd, prompt_id,
// agent_id, agent_type, hook_event_name — THERE IS NO PROMPT FIELD. The
// dispatch prompt is therefore recovered from the PARENT transcript at
// transcript_path (H6 precedent, scripts/hooks/lib/transcript.mjs): find the
// LAST assistant message holding one or more Task/Agent tool_use blocks, and
// take the union of every such block's `prompt` in that one message — an
// accepted, disclosed imprecision for parallel dispatches (board item).
//
// Never a gate (AC7 precedent): internal failure degrades to no output, exit 1
// non-blocking (P5) — dispatch staging is an aid layered on top of the file-
// touch delivery, never a second place that can deny a spawn.
import { readStdin, allow, warnNonBlocking, openStore, loadConfig, repoRel } from './lib/common.mjs';
// Prompt recovery + path extraction moved to lib/dispatch-prompt.mjs when H22's
// dispatch register became a second consumer — one mechanism, imported never
// reimplemented (decision f5638a84). Behavior here is unchanged.
import { lastDispatchPrompts, extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  readGuard,
  writeGuard,
  renderArticle,
  renderReference,
  renderHazards,
  cappedHazards,
  renderDecisionPointers,
  DECISION_POINTER_CAP,
  renderPayload,
  extractAxisTerms,
  axisHits,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  recordCentralityHits,
} from './lib/delivery.mjs';

// Subject-channel decision ceiling — mirrors H20's MAX_DECISIONS: a keyword
// match is weaker evidence than a file_keys join, so it earns less attention.
const SUBJECT_MAX_DECISIONS = 5;

const input = readStdin();

try {
  const store = openStore(input.cwd);
  if (!store) allow(); // not a Sterling project — no ceremony (P1)

  const prompts = lastDispatchPrompts(input.transcript_path);
  const candidates = [...new Set(prompts.flatMap(extractPathCandidates))];

  const rels = [...new Set(candidates.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
    (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/')
  );

  // PATH CHANNEL (AC5's original contract): declared file_keys get the payload
  // staged. No candidates is no longer an early exit — the SUBJECT channel
  // below (relevance slice 3, board 8f3141d4) can deliver on a pathless
  // dispatch, which is exactly the case path-scoping is structurally blind to.
  const owners = rels.length
    ? store.query({ types: ['feature_article', 'reference_material'], file_keys: rels, cap: 100 }).filter((r) => !r.working_tree)
    : [];
  const hazards = rels.length ? store.query({ types: ['anti_pattern'], file_keys: rels, cap: 100 }) : [];
  const decisions = rels.length ? store.query({ types: ['decision'], file_keys: rels, cap: 100 }) : [];

  // SUBJECT CHANNEL (relevance slice 3): the same mechanism-axis match H20
  // applies at the conductor's dispatch seam, run over the SAME recovered
  // prompt text, delivered to the SPAWNED agent — one mechanism, imported
  // never reimplemented (decision f5638a84 constraint). All three stage-2
  // floors apply (AXIS_MIN_HITS, discriminating hit, record centrality) so the
  // measured 1-in-3 noise problem is not replicated one seam deeper. Records
  // the path channel already carries are excluded — one payload, one mention.
  // Matched PER PROMPT, not over the union (review finding 5, 2026-08-10): a
  // parallel dispatch's union lets the longest prompt's vocabulary dominate
  // extraction (diluting short siblings to silence) and attributes one task's
  // subject to another's agent. Per-prompt costs one query pair per dispatch
  // block — bounded by the dispatch cap.
  const pathIds = new Set([...owners, ...hazards, ...decisions].map((r) => r.id));
  const subjectMatches = [];
  const seenSubject = new Set();
  for (const p of prompts) {
    const terms = extractAxisTerms(p, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) continue;
    const candidatesBySubject = [
      ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
      ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
    ];
    for (const r of candidatesBySubject) {
      if (pathIds.has(r.id) || seenSubject.has(r.id)) continue;
      const hits = axisHits(r, terms);
      if (hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(hits) && hasRecordCentralityHit(r, p)) {
        seenSubject.add(r.id);
        subjectMatches.push({ record: r, hits, prompt: p });
      }
    }
  }
  subjectMatches.sort((a, b) => b.hits.length - a.hits.length);

  // Nothing on either channel: still the undeclared case for AC5's purposes —
  // no frontier notice here (that signal belongs to the file-touch hook, which
  // fires once the agent actually touches the path; staging is a bonus, not a
  // second frontier surface).
  if (!owners.length && !hazards.length && !decisions.length && !subjectMatches.length) allow();

  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);

  const freshOwners = owners.filter((r) => !guard.records.includes(r.id));
  const freshHazards = hazards.filter((r) => !guard.records.includes(r.id));
  const freshDecisions = decisions.filter((r) => !guard.records.includes(r.id));
  const freshSubject = subjectMatches.filter((x) => !guard.records.includes(x.record.id));
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !freshSubject.length) allow();

  const charCap = loadConfig(input.cwd)?.delivery?.payload_char_cap ?? 2400;
  const parts = [];
  if (freshOwners.length || freshHazards.length || freshDecisions.length) {
    const blocks = [
      ...renderHazards(freshHazards, charCap, { fileKeys: rels }),
      ...freshOwners.map((r) => (r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap))),
      ...(freshDecisions.length ? [renderDecisionPointers(rels.join(', '), freshDecisions)] : []),
    ];
    parts.push(renderPayload(rels.join(', '), blocks, { unowned: false }));
  }
  const subjectHazards = freshSubject.filter((x) => x.record.type === 'anti_pattern').map((x) => x.record);
  const subjectDecisions = freshSubject.filter((x) => x.record.type === 'decision').map((x) => x.record);
  if (subjectHazards.length || subjectDecisions.length) {
    const matched = [...new Set(freshSubject.flatMap((x) => x.hits))].join(', ');
    // Centrality is per record AGAINST ITS OWN matching prompt — the union
    // never enters the match, so the header cannot credit a sibling's terms.
    const central = [...new Set(freshSubject.flatMap((x) => recordCentralityHits(x.record, x.prompt)))].join(', ');
    // With parallel dispatches this hook cannot attribute a prompt to THIS
    // spawned agent (SubagentStart carries no prompt field) — say so rather
    // than claim 'your task' for a sibling's subject (review finding 5).
    const subjectLabel = prompts.length > 1 ? `the SUBJECT of a task dispatched in this turn (possibly a sibling's)` : `your task's SUBJECT`;
    // A subject match has no file_keys answer — the widening query is
    // rank_terms-shaped (review finding 4).
    const subjectTerms = [...new Set(freshSubject.flatMap((x) => x.hits))];
    const remedy = `knowledge_query types:["anti_pattern"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectHazards.length || 1}`;
    const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectDecisions.length || 1}`;
    parts.push(
      [
        `STERLING MECHANISM-AXIS STAGING (H19) — the store holds records matching ${subjectLabel} ` +
          `(matched on: ${matched}; central to the record: ${central}), beyond any file the task names. ` +
          `Path-scoped delivery cannot find these — consult them before acting on the premise they govern.`,
        ...renderHazards(subjectHazards, charCap, { remedy }),
        ...(subjectDecisions.length ? [renderDecisionPointers('(subject match)', subjectDecisions, SUBJECT_MAX_DECISIONS, { remedy: decisionRemedy })] : []),
      ].join('\n\n')
    );
  }
  const payload = parts.join('\n\n');
  // Hazards guard the severity-sorted RENDERED slice only (board a470046d
  // slice 1) — same AC8 rule as the decision slice beside it.
  const fresh = [
    ...freshOwners,
    ...cappedHazards(freshHazards),
    ...freshDecisions.slice(0, DECISION_POINTER_CAP),
    ...cappedHazards(subjectHazards),
    ...subjectDecisions.slice(0, SUBJECT_MAX_DECISIONS),
  ];

  // Side effect first, guard second (council wf_db9a59aa-0af precedent,
  // mirrored from h19-knowledge-delivery.mjs): a throw before this line leaves
  // the guard untouched, so a later touch of the same territory — the main
  // file-touch hook, or a later dispatch — still delivers it.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: payload } }));
  guard.records.push(...fresh.map((r) => r.id));
  writeGuard(gPath, guard);
  allow();
} catch (e) {
  // Staging is an aid, never a gate: internal failure is loud but NON-blocking
  // (P5 visibility without an AC7-style violation).
  warnNonBlocking(`H19: dispatch staging failed: ${(e && e.message) || e}`);
}
