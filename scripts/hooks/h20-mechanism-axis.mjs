// H20 — mechanism-axis delivery at DISPATCH (board 62806222; concept family
// knowledge-delivery, member 7). Registered at PreToolUse Task|Agent. Like every
// delivery member it NEVER blocks: this hook has no exit-2 path (AC7).
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
// the H10 file-count failure this must not repeat.
import { readStdin, allow, warnNonBlocking, openStore } from './lib/common.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  readGuard,
  writeGuard,
  extractAxisTerms,
  axisHits,
  renderHazards,
  renderDecisionPointers,
  AXIS_MIN_HITS,
} from './lib/delivery.mjs';

// Injection ceilings. Deliberately tighter than H19's file-touch payload: a
// keyword match is WEAKER evidence of relevance than an explicit file_keys
// join, so it earns less of the reader's attention. Also note the separate
// finding that config.delivery.payload_char_cap is applied per FIELD and does
// not bound a payload at all — so these counts are the real bound here.
const MAX_HAZARDS = 3;
const MAX_DECISIONS = 5;
const NARROW_CLIP = 700;

const input = readStdin();
const prompt = input.tool_input?.prompt;
if (typeof prompt !== 'string' || !prompt.trim()) allow(); // not a dispatch we can read

const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

try {
  const terms = extractAxisTerms(prompt, MAX_RANK_TERMS);
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
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS)
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

  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern').slice(0, MAX_HAZARDS);
  const decisions = fresh.filter((x) => x.record.type === 'decision').slice(0, MAX_DECISIONS);
  if (!hazards.length && !decisions.length) allow();

  const matched = [...new Set(fresh.flatMap((x) => x.hits))].join(', ');
  const blocks = [
    `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to dispatch '${input.tool_input?.subagent_type ?? 'an agent'}'. ` +
      `The store holds records matching this prompt's SUBJECT (matched on: ${matched}) rather than any file you touched. ` +
      `Path-scoped delivery cannot find these. Check them BEFORE the brief goes out — a fan-out multiplies a bad premise by N.`,
    ...renderHazards(
      hazards.map((x) => x.record),
      NARROW_CLIP
    ),
    ...(decisions.length ? [renderDecisionPointers('(subject match)', decisions.map((x) => x.record), MAX_DECISIONS)] : []),
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
