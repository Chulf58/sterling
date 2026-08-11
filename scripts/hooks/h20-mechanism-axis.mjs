// H20 — mechanism-axis delivery at DISPATCH (board 62806222; concept family
// knowledge-delivery, member 7). Registered at PreToolUse on TWO matcher entries:
// Task|Agent (the dispatch surface) and AskUserQuestion (the question surface,
// decision f5638a84). Like every delivery member it NEVER blocks: this hook has
// no exit-2 path (AC7).
//
// TIMING, probed live 2026-08-11 (research_finding 63a9646d-2f0d-406e-8a36-9e95d0b11dbd):
// PreToolUse additionalContext reaches the model WITH the tool result — and
// structurally, a PreToolUse hook fires only after the model has already emitted
// the call. On the dispatch surface that is still pre-flight enough to matter
// (the conductor reads it before acting on the subagent's report); on the
// question surface it lands after the user has ANSWERED, so the question payload
// is a POST-ANSWER AUDIT, never a pre-ask gate — the header wording says so.
//
// WHY IT EXISTS, and why no H19 improvement could have covered it: H19 joins the
// store on the FILE PATH being touched. An anti_pattern is filed against the file
// where the incident HAPPENED, not against every file where the mistake can
// RECUR — so path-scoped delivery is structurally blind to exactly the reusable
// lesson it would be most valuable to receive. Two measured cases:
//   * a conductor shipped a fix whose design was described VERBATIM by a stored
//     anti_pattern's trigger ("a node connects a signal in _ready() but finishes
//     initialising LATER"), filed against a file it never touched;
//   * a stored ruling that no breach countdown is EVER shown was violated in a
//     brief, because the countdown lived in NO file — it was a SUBJECT, not
//     territory.
// (Both records live in the CONSUMING project's store, so their ids are
// deliberately not cited here — they resolve to nothing in this one, which is
// what check-record-citations exists to catch. Provenance is in decision
// 35952525-07fb-46b6-a84a-fb7d6f748f07.)
// Both were caught by a coder refusing the work order, one step downstream of
// N agents already reasoning from the premise.
//
// WHY THE DISPATCH SEAM: a fan-out multiplies one bad premise by N, so "I am
// about to brief" is the last cheap moment to intervene. Both consuming-project
// documents name it independently. And PreToolUse on Task is PROVEN to deliver
// additionalContext to the DISPATCHING agent (research_finding e14dcf9a, issue
// #39814) — which is the right destination here, because the conductor writing
// the prompt is who needs stopping. (That same finding is why this is NOT the
// seam for H19 AC5 dispatch staging: for staging knowledge INTO the subagent,
// this destination is wrong. Different mechanism, different board item.)
//
// WHY IT DOES NOT BECOME NOISE (the P1 half, and the reason board 7bbec3bd
// exists): it is SILENT unless a real match survives both stages. A hook that
// fires on every dispatch would train the reader to skip it, which is precisely
// the H10 file-count failure this must not repeat. Measured 2026-08-04
// (board 648bb497, research_finding bf74c65f): on THIS repo it was firing
// 15/15, dominated by universal dev vocabulary that AXIS_MIN_HITS alone could
// not exclude — stage 2 now also requires hasDiscriminatingHit, a third floor
// that a match matching ONLY generic terms (test, check, file, ...) cannot
// clear on its own.
import { readStdin, allow, warnNonBlocking, openStore } from './lib/common.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  readGuard,
  writeGuard,
  extractAxisTerms,
  axisHits,
  outgoingProposalText,
  renderHazards,
  renderDecisionPointers,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  recordCentralityHits,
  HAZARD_CAP,
} from './lib/delivery.mjs';

// Injection ceilings. Deliberately tighter than H19's file-touch payload: a
// keyword match is WEAKER evidence of relevance than an explicit file_keys
// join, so it earns less of the reader's attention. Also note the separate
// finding that config.delivery.payload_char_cap is applied per FIELD and does
// not bound a payload at all — so these counts are the real bound here.
// The hazard ceiling is the ONE shared definition (HAZARD_CAP, invariant 1):
// since board a470046d slice 1, H19's path-scoped hazard block caps at the
// same count, so the two channels share the bound.
const MAX_DECISIONS = 5;
const NARROW_CLIP = 700;

const input = readStdin();
// TWO SURFACES, ONE MECHANISM (board 62806222 + board 4e6eb510). Task/Agent
// carries the brief in tool_input.prompt; AskUserQuestion has no prompt field at
// all and carries its text in questions[]/options[]. outgoingProposalText knows
// both and returns '' for anything else, so an unrecognised tool is inert rather
// than half-scanned. Registering the matcher WITHOUT this would have produced a
// hook that never fires and a probe that proves nothing, since silence is this
// hook's default state.
const outgoing = outgoingProposalText(input.tool_input);
if (!outgoing) allow(); // nothing readable on this surface
const isQuestion = Array.isArray(input.tool_input?.questions);

const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

try {
  const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) allow(); // too little vocabulary to match on

  // STAGE 1 — narrow in the store. rank_terms genuinely FILTER (packages/store/
  // src/index.ts builds `... AND records_fts MATCH ?` with the terms OR-joined),
  // so an empty result here is a REAL zero, not a ranked top-N of everything.
  // That property is what lets this hook stay silent; without it the query would
  // return rows on every dispatch. NOTE the disclosed matched_filter count does
  // NOT reflect this narrowing — it counts the base filter only.
  const candidates = [
    ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
    ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
  ];
  if (!candidates.length) allow();

  // STAGE 2 — require precision against the NARROW fields (trigger/title, not
  // rationale). Stage 1's index spans long discursive fields, so an FTS hit is
  // not yet a reason to interrupt anyone.
  // GENERIC-TERM FLOOR (board 648bb497, tuned on the measured 15/15 fire
  // rate in research_finding bf74c65f): AXIS_MIN_HITS alone is satisfied by
  // universal dev vocabulary in a store whose own subject IS this repo's
  // machinery, so a payload matched PURELY on generic terms goes silent here
  // — at least one matched term must actually discriminate.
  // RECORD-CENTRALITY FLOOR (board b655cb6f, third floor): the two floors above
  // ask whether the PROMPT is specific; this one asks whether the matched terms
  // are central to the RECORD — a record may not fire on words that appear only
  // in passing in its own trigger (the measured 2026-08-09 Blender case).
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits) && hasRecordCentralityHit(x.record, outgoing))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) allow();

  // Share H19's session guard, keyed on the dispatching context. A record
  // already delivered by file-touch is already in this context — re-injecting it
  // at dispatch is the duplicate H19's own guard exists to prevent, and the
  // reverse holds too (what H20 delivers, H19 will not repeat).
  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);
  const fresh = scored.filter((x) => !guard.records.includes(x.record.id));
  if (!fresh.length) allow();

  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern').slice(0, HAZARD_CAP);
  const decisions = fresh.filter((x) => x.record.type === 'decision').slice(0, MAX_DECISIONS);
  if (!hazards.length && !decisions.length) allow();

  const matched = [...new Set(fresh.flatMap((x) => x.hits))].join(', ');
  // Name the covered CENTRAL terms too, so the reader can see at a glance that
  // the match is about the record's subject, not a passing mention.
  const centralCovered = [...new Set(fresh.flatMap((x) => recordCentralityHits(x.record, outgoing)))].join(', ');
  const matchedClause = `matched on: ${matched}; central to the record: ${centralCovered}`;
  // The header names the SURFACE, because the stakes differ and the reader should
  // feel which one they are on. A bad dispatch wastes agent work; a bad choice put
  // to the USER manufactures an authorised ruling that contradicts a real one, and
  // the store then holds both (board 4e6eb510). So the question wording is
  // deliberately the stronger of the two.
  const header = isQuestion
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just put a CHOICE TO THE USER. ` +
      `The store already governs this subject (${matchedClause}) and no file you touched would have surfaced it. ` +
      `THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask (probed 2026-08-11). ` +
      `Before treating the answer as a ruling, check these records: a user's answer becomes authoritative, so if one of them ` +
      `already decides the question, the pick just manufactured a contradiction with a settled ruling — ` +
      `disclose the record to the user and re-affirm before acting on the answer.`
    : `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to dispatch '${input.tool_input?.subagent_type ?? 'an agent'}'. ` +
      `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
      `Path-scoped delivery cannot find these. Check them BEFORE the brief goes out — a fan-out multiplies a bad premise by N.`;
  // A subject match has no file_keys answer — overflow widening queries are
  // rank_terms-shaped (review finding 4's class, fixed at both call sites).
  const hazardTerms = [...new Set(hazards.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const decisionTerms = [...new Set(decisions.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const blocks = [
    header,
    ...renderHazards(hazards.map((x) => x.record), NARROW_CLIP, {
      remedy: `knowledge_query types:["anti_pattern"] rank_terms:[${hazardTerms}] cap:${hazards.length || 1}`,
    }),
    ...(decisions.length
      ? [
          renderDecisionPointers('(subject match)', decisions.map((x) => x.record), MAX_DECISIONS, {
            remedy: `knowledge_query types:["decision"] rank_terms:[${decisionTerms}] cap:${decisions.length}`,
          }),
        ]
      : []),
  ];

  // SIDE EFFECT FIRST, GUARD SECOND — same rule as H19 (council wf_db9a59aa-0af):
  // the guard is what makes delivery once-per-session, so writing it before the
  // delivery lands turns any failure into permanent silent loss with no retry.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: blocks.join('\n\n') },
    })
  );
  guard.records.push(...hazards.map((x) => x.record.id), ...decisions.map((x) => x.record.id));
  writeGuard(gPath, guard);
  allow();
} catch (e) {
  // Delivery is an aid, never a gate: loud but NON-blocking (P5 without AC7 harm).
  warnNonBlocking(`H20: mechanism-axis delivery failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
