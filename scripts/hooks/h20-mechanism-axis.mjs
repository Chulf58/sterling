// H20 — mechanism-axis delivery at DISPATCH (board 62806222; concept family
// knowledge-delivery, member 7). Registered at PreToolUse on TWO matcher entries:
// Task|Agent (the dispatch surface) and AskUserQuestion (the question surface,
// decision f5638a84). Every delivery member elsewhere NEVER blocks; AC7 still
// holds for the dispatch/consult surfaces here. The AskUserQuestion surface is
// the ONE exception (decision 68332e4b, 2026-08-24): a first-attempt question
// whose subject STRONGLY matches a store RULING (decision/anti_pattern) is
// DENIED (exit 2) before it ever reaches the user — see the DENY-ONCE block
// below and its plumbing in lib/delivery.mjs. Everywhere else this file still
// never exits 2.
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, exitAfterWrite, openStore, loadConfig } from './lib/common.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
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
  renderArticlePointers,
  ARTICLE_POINTER_CAP,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  AXIS_MIN_DISCRIMINATING_HITS,
  hasRecordCentralityHit,
  recordCentralityHits,
  HAZARD_CAP,
  isDelivered,
  markDelivered,
  DENY_RULING_TYPES,
  subQuestionText,
  capDeliveryParts,
  resolveTotalCap,
  recordsShownIn,
  decisionBlockPointer,
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

// PROMPT-SHAPE RANKING (consuming-project retro 2026-08-17-2111): a QUESTION
// ("where is X", "does X exist", "how many...") is the reader asking the
// store a fact — the article pointer IS the answer, so it must lead. A
// CHANGE ("implement X", "fix X") is the reader about to act on a file the
// store cannot see — the existing hazard-first order (stop me before I
// repeat a mistake) stays the priority, with article pointers after.
// Gated on an actual '?' so a change-shaped brief that happens to use a word
// like "does" ("this change does X") is never misread as a question — the
// interrogative words alone are common enough in ordinary prose that the
// mark is the real signal; the words narrow it to a genuine interrogative.
const QUESTION_WORDS_RE =
  /\b(where|what|which|who|whom|whose|when|why|how|does|do|did|is|are|was|were|can|could|would|will|should)\b/i;
function isQuestionShapedPrompt(text) {
  const t = String(text ?? '');
  return t.includes('?') && QUESTION_WORDS_RE.test(t);
}

const input = readStdin();

// ===========================================================================
// CODEX MODEL PIN — THE FIRST STEP, AHEAD OF EVERYTHING BELOW (board 7423f7a2
// slice 5; decision 8b329d57 as CORRECTED FORWARD; research_finding be284452).
//
// config.sparring_partner.model is the per-project SOURCE for which model a
// consult lands on, and until now NOTHING read it — the TUI wrote the value and
// no code path ever consumed it, which is the whole defect the user reported
// ("the System tab ... just says default and doesnt work"). The server-side
// `codex mcp-server -c model=` pin was REJECTED (per-clone file vs per-project
// config, restart latency, breaks init's managed compare), so the mechanism is
// the PER-CALL `model` parameter, filled here via hookSpecificOutput.updatedInput.
//
// PLACEMENT IS LOAD-BEARING, and it is why this block sits above the extraction:
// every relevance path below exits early on ordinary shapes (no prompt, empty
// prompt, too little vocabulary, no candidates, everything already delivered
// this session). Those are normal consults; riding the model pin on whether the
// store happened to match would make the model a lottery. So the pin is computed
// here, unconditionally for a codex opener, and COMPOSED into every output path
// through envelopeFor()/finish() — including the catch below.
//
// NEVER ON codex-reply: that tool's schema has no `model` field at all (a thread
// inherits its opener's model), so the injection guard is the EXACT opener name,
// not the 'mcp__codex__' matcher prefix that isConsult uses for the header.
//
// ADVISORY ALWAYS (decision ea68735d point 3): enabled:false prints a loud OFF
// line and changes nothing else — enablement and model selection are separate
// axes, and an explicitly user-asked consult still runs. An explicit call-site
// model always wins. A missing, unreadable or empty-valued config injects
// NOTHING and says so (P5 degraded-loud). No shape here ever denies.
// ===========================================================================
/**
 * The model-pin decision for this call: `{ line, updatedInput? }`, or null when
 * this is not a codex call (or not a Sterling project — P1, no ceremony).
 * NEVER THROWS: a broken config is a disclosure, not an exception.
 *
 * Everything this block needs lives INSIDE this function (the label included):
 * a top-level initialized const is a fail-closed-boundary finding in a hook
 * classified 'blocking' (scripts/check-failclosed-boundary), and this change
 * has no business adding new baseline debt to H20's existing set.
 */
function buildModelPin(inp) {
  const PIN = 'STERLING CODEX MODEL PIN (H20)';
  // EVERY UNTRUSTED VALUE THAT REACHES THE DISCLOSURE GOES THROUGH THIS
  // (reviewer-security, 2026-09-05). .sterling/config.json is agent-writable, so
  // sparring_partner.model — and the JSON.parse error text, which quotes the
  // file's own bytes — are attacker-influenced strings landing verbatim in the
  // conductor's context. JSON.stringify is the fix that matters: it escapes
  // embedded NEWLINES and quotes, so a planted value can no longer break out of
  // its line and fabricate a Sterling-voiced sentence beneath the pin; the clip
  // bounds a value planted to flood the payload.
  // SCOPE, deliberately: this escapes what is DISPLAYED, never what is INJECTED
  // — updatedInput.model still crosses byte-for-byte, which frozen pin M-8
  // requires and decision 8b329d57 rules ("free non-empty string verbatim, no
  // validation" — there is no shell/TOML boundary on this route and codex
  // validates ids server-side with a loud 400).
  const show = (v) => {
    const s = JSON.stringify(String(v ?? ''));
    return s.length <= 120 ? s : `${s.slice(0, 120)}…`;
  };
  if (typeof inp.tool_name !== 'string' || !inp.tool_name.startsWith('mcp__codex__')) return null;
  const root = inp.cwd ? String(inp.cwd) : '';
  const sterling = join(root, '.sterling');
  // Outside a Sterling project there is no config to read and nothing to say.
  if (!existsSync(join(sterling, 'sterling.db')) && !existsSync(join(sterling, 'config.json'))) return null;

  if (inp.tool_name !== 'mcp__codex__codex') {
    // codex-reply and any future sibling: disclose, never touch the input.
    return {
      line:
        `STERLING CODEX MODEL (H20) — this tool takes no model argument, so the thread keeps the model its opener started with. ` +
        `Sterling changes nothing on this call; to move a conversation onto a different model, open a NEW consult.`,
    };
  }

  let config = null;
  let unreadable = null;
  try {
    config = loadConfig(root);
  } catch (e) {
    unreadable = (e && e.message) || String(e);
  }
  const sp = config && typeof config.sparring_partner === 'object' && config.sparring_partner ? config.sparring_partner : null;
  const lines = [];
  if (sp && sp.enabled === false) {
    lines.push(
      `${PIN} — the codex sparring partner is OFF for this project (config.sparring_partner.enabled:false). ` +
        `That is ADVISORY, NEVER A GATE (decision ea68735d point 3): this consult is not blocked, and the model below still applies. ` +
        `Turn it back on in the TUI System tab if the OFF state is stale.`
    );
  }
  // The call's OWN model wins, always — the pin only fills an OMITTED value.
  const callModel = typeof inp.tool_input?.model === 'string' && inp.tool_input.model !== '' ? inp.tool_input.model : null;
  // An EMPTY configured value is the TUI's clear-to-unset signal, not a model id
  // (main.ts applySparringModel deletes the key on an empty commit) — the two
  // are one state, and codex would 400 on ''.
  const configured = sp && typeof sp.model === 'string' && sp.model !== '' ? sp.model : null;

  if (callModel !== null) {
    lines.push(
      `${PIN} — this call names model ${show(callModel)} EXPLICITLY, so the call-site value wins and Sterling leaves the input untouched` +
        `${configured ? ` (config.sparring_partner.model is ${show(configured)} and was not applied)` : ''}.`
    );
    return { line: lines.join('\n') };
  }
  if (unreadable) {
    lines.push(
      `${PIN} — .sterling/config.json could not be parsed (${show(unreadable)}), so NO model was applied and the Codex CLI default is in force. ` +
        `Fix the config file; a consult is never denied over this.`
    );
    return { line: lines.join('\n') };
  }
  if (!configured) {
    lines.push(
      `${PIN} — no model is set in config.sparring_partner.model` +
        `${config ? '' : ' (no .sterling/config.json to read)'}, so this consult takes the Codex CLI default. ` +
        `Set one on the TUI System tab row 'Default Codex model'.`
    );
    return { line: lines.join('\n') };
  }
  lines.push(
    `${PIN} — model ${show(configured)} injected into this call from config.sparring_partner.model (.sterling/config.json), which named none. ` +
      `A model named on the call itself would have won instead; an already-running codex-reply thread keeps its opener's model.`
  );
  return {
    line: lines.join('\n'),
    updatedInput: { ...(inp.tool_input && typeof inp.tool_input === 'object' ? inp.tool_input : {}), model: configured },
  };
}

/** Computed ONCE, on first use, and memoized — `let` + a resolver rather than a
 *  top-level initialized const for the same fail-closed-boundary reason as the
 *  label above. buildModelPin never throws, so laziness changes no semantics:
 *  every reader below goes through modelPin(). */
let pinMemo;
function modelPin() {
  if (pinMemo === undefined) pinMemo = buildModelPin(input);
  return pinMemo;
}

/** One envelope carrying the pin (always, when there is one) plus whatever
 *  relevance carriage this path produced. The pin leads: it is one line about
 *  the call itself, and the carriage below it can run to many. */
function envelopeFor(extraContext) {
  const pin = modelPin();
  const parts = [];
  if (pin?.line) parts.push(pin.line);
  if (extraContext) parts.push(extraContext);
  const hookSpecificOutput = { hookEventName: input.hook_event_name };
  if (pin?.updatedInput) hookSpecificOutput.updatedInput = pin.updatedInput;
  if (parts.length) hookSpecificOutput.additionalContext = parts.join('\n\n');
  return { hookSpecificOutput };
}

/** EXACTLY ONE STDOUT WRITE PER PROCESS, structurally rather than by ordering
 *  discipline (outside-family review finding, 2026-09-05). Claude Code parses
 *  this hook's stdout as ONE JSON object: two writes produce `{…}{…}`, which
 *  parses as nothing at all — so updatedInput is dropped and the codex model pin
 *  is lost exactly when something has already gone wrong.
 *
 *  THAT RULE IS THE SHARED HELPER'S NOW (decision hook-stdout-exit-after-write-
 *  callback-bound-exit-deny-stays-synchronous): exitAfterWrite holds the
 *  one-envelope state, suppresses a second non-empty payload, DISCLOSES the drop
 *  on stderr (P5) — and, the reason it exists, exits inside the write callback
 *  so the envelope is never truncated by the exit. The local `emitted` flag is
 *  gone: two mechanisms for one rule can disagree, one cannot. */
function emitEnvelope(extraContext, opts) {
  return exitAfterWrite(JSON.stringify(envelopeFor(extraContext)), 0, opts);
}

/** Exit 0, emitting the composed envelope — the replacement for a bare allow()
 *  on every early-exit below. With no pin and no carriage it is exactly allow():
 *  silence, so a non-codex dispatch that matched nothing still prints nothing. */
function finish(extraContext) {
  const pin = modelPin();
  if (!pin?.line && !pin?.updatedInput && !extraContext) return allow();
  return emitEnvelope(extraContext);
}

// TWO SURFACES, ONE MECHANISM (board 62806222 + board 4e6eb510). Task/Agent
// carries the brief in tool_input.prompt; AskUserQuestion has no prompt field at
// all and carries its text in questions[]/options[]. outgoingProposalText knows
// both and returns '' for anything else, so an unrecognised tool is inert rather
// than half-scanned. Registering the matcher WITHOUT this would have produced a
// hook that never fires and a probe that proves nothing, since silence is this
// hook's default state.
const isQuestion = Array.isArray(input.tool_input?.questions);
const isConsult = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__codex__');

// THE BODY IS A FUNCTION, AND EVERY TERMINAL CALL INSIDE IT IS A `return`
// (decision hook-stdout-exit-after-write-callback-bound-exit-deny-stays-
// synchronous). The exit now happens in the stdout write callback, so a bare
// `finish()` schedules the write and RETURNS — it no longer stops the
// statements after it the way a hard process.exit did. Returning is what
// preserves that guarantee; the module then ends, the loop drains, and the
// callback exits.
function main(input) {
  try {
    // BOTH OF THESE SIT INSIDE THE TRY (2026-09-05), where
    // they were not before: outgoingProposalText reads an arbitrary tool_input and
    // openStore THROWS on a corrupt or locked db (it returns null only for an
    // ABSENT one — anti-pattern e13f0fb5 pins that distinction). An uncaught throw
    // exits 1, and an exit-1 hook's stdout is not the envelope Claude Code reads
    // updatedInput from, so the consult would silently lose its model pin — the
    // exact loss the catch arm below was written to prevent, one statement too
    // early to catch it. Inside the try, both failures land on that arm and the
    // pin still ships.
    const outgoing = outgoingProposalText(input.tool_input);
    if (!outgoing) return finish(); // nothing readable on this surface — the model pin still ships
    const store = openStore(input.cwd);
    if (!store) return finish(); // no store — no relevance carriage possible, pin unaffected

    const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) return finish(); // too little vocabulary to match on

    // STAGE 1 — narrow in the store. rank_terms genuinely FILTER (packages/store/
    // src/index.ts builds `... AND records_fts MATCH ?` with the terms OR-joined),
    // so an empty result here is a REAL zero, not a ranked top-N of everything.
    // That property is what lets this hook stay silent; without it the query would
    // return rows on every dispatch. NOTE the disclosed matched_filter count does
    // NOT reflect this narrowing — it counts the base filter only.
    // feature_article joined here too (consuming-project retro 2026-08-17-2111):
    // a subject a stored article fully answers was silently excluded before —
    // H20's carve was anti_pattern/decision only. axisNarrowText already covers
    // feature_article (slug + concept_family + title, board 39c3d762), so no
    // change to the shared axis matcher is needed — only widening what this
    // hook queries and does with the result.
    const candidates = [
      ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
      ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
      ...store.query({ types: ['feature_article'], rank_terms: terms, cap: 40 }),
      // PRIOR ANSWERS (board e7157d0b): a research_finding is an already-answered
      // question and a disconfirmed_hypothesis an already-refuted trail — the two
      // types a dispatch about to fan out on that question is about to RE-DERIVE
      // (measured: a 158k-token debugger re-deriving a recorded diagnosis; a
      // 6,142-file sweep on a question the store answered). Same floors as every
      // other candidate; axisNarrowText matches their question fields.
      ...store.query({ types: ['research_finding'], rank_terms: terms, cap: 40 }),
      ...store.query({ types: ['disconfirmed_hypothesis'], rank_terms: terms, cap: 40 }),
      // OPEN QUESTIONS (board a9be48f2) ride the SAME surface for the adjacent
      // question: not "was this answered?" but "is this ALREADY BEING
      // INVESTIGATED?". A fan-out onto a live open_question duplicates an
      // investigation instead of re-deriving a finished one — the same waste,
      // one step earlier. NOTE the deny rung is deliberately untouched: an
      // open_question is not a RULING, so it stays out of DENY_RULING_TYPES and
      // can never deny a user's question.
      ...store.query({ types: ['open_question'], rank_terms: terms, cap: 40 }),
    ];

    // MULTI-QUESTION CANDIDATE AUGMENTATION (post-commit follow-up, deny-once
    // recall floor): `terms` above is extractAxisTerms(outgoing, MAX_RANK_TERMS)
    // over the WHOLE combined form text, capped at 16 — a verbose sub-question
    // can crowd a terser, genuinely-ruled sub-question's own vocabulary out of
    // that shared top-16 before the STORE QUERY even runs, so the strict
    // classifier never sees the record: retrieval, not scoring, starved it.
    // Fix: for a multi-question form, ALSO query using each sub-question's OWN
    // top-16 extraction (independently capped — no sub-question's terms compete
    // with another's for a slot), restricted to the ruling types deny-once
    // scores, and merge the results into the SAME candidate pool (deduped by
    // id) before any early-exit or scoring runs. A single-question form's own
    // text already equals `outgoing`, so this only adds work when there is
    // more than one sub-question to protect.
    if (isQuestion && input.tool_input.questions.length > 1) {
      const seen = new Set(candidates.map((r) => r.id));
      for (const q of input.tool_input.questions) {
        const subTerms = extractAxisTerms(subQuestionText(q), MAX_RANK_TERMS);
        if (subTerms.length < AXIS_MIN_HITS) continue;
        for (const type of DENY_RULING_TYPES) {
          for (const r of store.query({ types: [type], rank_terms: subTerms, cap: 40 })) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              candidates.push(r);
            }
          }
        }
      }
    }
    if (!candidates.length) return finish();

    // DENY-ONCE PRE-STEP removed (scale-down decision
    // sterling-claude-code-scale-down-boundary, 2ad87dd1): H20 no longer
    // denies (exit 2) a first-attempt AskUserQuestion -- it is advisory-only
    // now, falling straight through to the loose STAGE 2 audit below, which
    // still runs post-answer and warns non-blocking (decision 68332e4b's
    // pre-ask deny is superseded; the deny ledger/override machinery this
    // block owned -- denyLedgerPath, readDenyLedger, writeDenyLedger,
    // denyIntentKey, renderDenyOnceMessage, stripCitations,
    // extractAxisTermsUncapped, DELTA_TERMS_VERSION/DELTA_MIN_NEW_TERMS,
    // STRICT_MIN_HITS/DENY_RULING_TYPES/hasFullNarrowCentralityCoverage -- is
    // dead with it; see the audit below for what H20 still enforces).

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
      .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(x.record, outgoing))
      .sort((a, b) => b.hits.length - a.hits.length);
    if (!scored.length) return finish();

    // Share H19's session guard, keyed on the dispatching context. A record
    // already delivered by file-touch is already in this context — re-injecting it
    // at dispatch is the duplicate H19's own guard exists to prevent, and the
    // reverse holds too (what H20 delivers, H19 will not repeat).
    const gPath = guardPath(input.cwd, input.agent_id);
    const guard = readGuard(gPath);
    const fresh = scored.filter((x) => !isDelivered(guard, x.record));
    if (!fresh.length) return finish();

    const hazards = fresh.filter((x) => x.record.type === 'anti_pattern').slice(0, HAZARD_CAP);
    const decisions = fresh.filter((x) => x.record.type === 'decision').slice(0, MAX_DECISIONS);
    // NOT sliced here — renderArticlePointers itself caps at ARTICLE_POINTER_CAP
    // and discloses the overflow, the same shape as renderHazards/
    // renderDecisionPointers; slicing early would lose the true matched count
    // the disclosure line needs.
    const articles = fresh.filter((x) => x.record.type === 'feature_article');
    // open_question shares this bucket (board a9be48f2) rather than minting a
    // fourth block: it answers the same reader question — "has someone been here
    // already?" — and a candidate type queried above but rendered by no bucket
    // would be dead weight (the terminal release just below would fire on an
    // open_question-only match, i.e. silence). Its own line label distinguishes
    // it from an ANSWER.
    const priorAnswers = fresh.filter(
      (x) => x.record.type === 'research_finding' || x.record.type === 'disconfirmed_hypothesis' || x.record.type === 'open_question'
    );
    if (!hazards.length && !decisions.length && !articles.length && !priorAnswers.length) return finish();

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
      : isConsult
      ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to CONSULT the sparring partner (codex). ` +
        `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
        `Path-scoped delivery cannot find these. Check them BEFORE the consult goes out — a bad premise sent to an external model is still a bad premise.`
      : `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to dispatch '${input.tool_input?.subagent_type ?? 'an agent'}'. ` +
        `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
        `Path-scoped delivery cannot find these. Check them BEFORE the brief goes out — a fan-out multiplies a bad premise by N.`;
    // A subject match has no file_keys answer — overflow widening queries are
    // rank_terms-shaped (review finding 4's class, fixed at both call sites).
    const hazardTerms = [...new Set(hazards.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
    const decisionTerms = [...new Set(decisions.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
    const articleTerms = [...new Set(articles.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');

    const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${decisionTerms}] cap:${decisions.length}`;
    const hazardDecisionBlocks = [
      ...renderHazards(hazards.map((x) => x.record), Number.MAX_SAFE_INTEGER, {
        remedy: `knowledge_query types:["anti_pattern"] rank_terms:[${hazardTerms}] cap:${hazards.length || 1}`,
      }).map((text) => ({ kind: 'hazard', text })),
      ...(decisions.length
        ? [
            {
              kind: 'ordinary', text: renderDecisionPointers('(subject match)', decisions.map((x) => x.record), MAX_DECISIONS, { remedy: decisionRemedy }),
              pointer: decisionBlockPointer(decisions.length, decisionRemedy),
              suffix: `  … the rest held back by the delivery cap — ${decisionRemedy}`,
            },
          ]
        : []),
    ];
    const articleBlocks = articles.length
      ? [
          renderArticlePointers(articles.map((x) => x.record), ARTICLE_POINTER_CAP, {
            remedy: `knowledge_query types:["feature_article"] rank_terms:[${articleTerms}] cap:${articles.length}`,
          }),
        ]
      : [];
    // PRIOR-ANSWER pointers (board e7157d0b): one line each — the question is the
    // subject, the clocks say how current the answer is, the id is the read. Shown
    // slice only marks delivered (cappedHazards rule).
    const PRIOR_ANSWER_CAP = 3;
    const clip = (v, n = 160) => {
      const t = String(v ?? '').replace(/\s+/g, ' ').trim();
      return t.length <= n ? t : `${t.slice(0, n)}…`;
    };
    const shownPrior = priorAnswers.slice(0, PRIOR_ANSWER_CAP);
    const priorBlocks = priorAnswers.length
      ? [
          [
            `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — this dispatch may be about to RE-DERIVE one of these, or duplicate a question already under investigation. knowledge_get before fanning out:`,
            ...shownPrior.map((x) => {
              const r = x.record;
              if (r.type === 'research_finding') {
                return `  → ANSWERED: ${clip(r.question)} (source ${r.source_date ?? '?'}, captured ${r.capture_date ?? '?'}${r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : ''}) · knowledge_get ${r.id}`;
              }
              // An OPEN question is not an answer: it names live hypotheses and
              // says the investigation exists, so the reader joins it (or cites
              // it) instead of starting a second one.
              if (r.type === 'open_question') {
                // A CLOSED question is not a live investigation: it already
                // closed into a research_finding, and THAT record is the prior
                // answer this block exists to surface — point the reader there
                // (review finding, 2026-08-31: the unbranched render said
                // 'closed, no answer yet', a self-contradicting false clause).
                if (r.resolution_status === 'closed') {
                  return `  → ANSWERED (question closed into ${r.closed_into ?? 'an unnamed record'}): ${clip(r.question)} · knowledge_get ${r.id}`;
                }
                return `  → ALREADY UNDER INVESTIGATION (open, no answer yet): ${clip(r.question)} · knowledge_get ${r.id}`;
              }
              return `  → REFUTED TRAIL: ${clip(r.question)} — rejected: ${clip(r.rejected_answer, 100)} · knowledge_get ${r.id}`;
            }),
            ...(priorAnswers.length > PRIOR_ANSWER_CAP
              ? [`  (+${priorAnswers.length - PRIOR_ANSWER_CAP} more — knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${[...new Set(priorAnswers.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',')}] cap:${priorAnswers.length})`]
              : []),
          ].join('\n'),
        ]
      : [];
    // RANKING (consuming-project retro 2026-08-17-2111, AC2): a QUESTION-SHAPED
    // prompt is the reader asking the store a fact, so the article pointer — the
    // direct answer — leads; a CHANGE-SHAPED prompt keeps today's hazard-first
    // order (stop the mistake before it recurs) with article pointers after. A
    // matched article is never withheld either way (AC3) — only its POSITION
    // in the payload moves.
    const promptIsQuestionShaped = isQuestionShapedPrompt(outgoing);
    const asPart = (text, widen) => ({ kind: 'ordinary', text, pointer: `▸ held back by the delivery cap — ${widen}` });
    const articleParts = articleBlocks.map((t) => asPart(t, `knowledge_query types:["feature_article"] rank_terms:[${articleTerms}] cap:${articles.length}`));
    const priorParts = priorBlocks.map((t) =>
      asPart(t, `knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${[...new Set(priorAnswers.flatMap((x) => x.hits))].map((t2) => `"${t2}"`).join(',')}] cap:${priorAnswers.length}`)
    );
    // PER-DELIVERY TOTAL CAP (scale-down Slice 3c, capDeliveryParts): the
    // hazards are complete unbudgeted substance; header, decisions, prior
    // answers and article pointers are ordinary and degrade under the cap.
    const blocks = [
      { kind: 'ordinary', text: header },
      // A prior ANSWER outranks everything on a question-shaped prompt — it is
      // the direct "don't re-derive" signal; on a change-shaped prompt hazards
      // still lead (stop the mistake), answers ride with the article pointers.
      ...(promptIsQuestionShaped
        ? [...priorParts, ...articleParts, ...hazardDecisionBlocks]
        : [...hazardDecisionBlocks, ...priorParts, ...articleParts]),
    ];
    const carriage = capDeliveryParts(blocks, resolveTotalCap(input.cwd)).join('\n\n');

    // SIDE EFFECT FIRST, GUARD SECOND — same rule as H19:
    // the guard is what makes delivery once-per-session, so writing it before the
    // delivery lands turns any failure into permanent silent loss with no retry.
    // THAT ORDERING IS NOW MECHANICAL, not positional: the bookkeeping rides the
    // stdout write's callback, so it runs only after the stream has actually
    // taken the envelope. A failed write therefore records nothing — every
    // record stays eligible — and the process exits non-zero instead of
    // reporting a clean delivery.
    // Composed, not replaced: on a codex consult this envelope carries BOTH the
    // model pin and the carriage (board 7423f7a2 — the pin is on every output
    // path, and this is the one that already had an envelope).
    return emitEnvelope(carriage, {
      onWritten: () => {
        recordAdvisoryFire(input.cwd, 'h20', input.session_id); // expiring campaign scaffolding — see lib/advisory-counter.mjs
        // POST-ENVELOPE BOOKKEEPING IS ITS OWN FAILURE DOMAIN (outside-family
        // review, 2026-09-05). These marks cannot run before the write — that
        // is the H19 ordering rule, and inverting it would turn a
        // failed delivery into permanent silent loss. The shared helper already
        // contains an onWritten throw (one stderr line, exit code unchanged);
        // this local catch is kept because the DISCLOSURE has to say that the
        // envelope was ALREADY WRITTEN, which is what distinguishes a
        // bookkeeping failure from one that prevented the delivery.
        try {
          // Only the SHOWN (capped) article pointers are marked delivered — same rule
          // as cappedHazards: an article capped out of the payload was never actually
          // read by the recipient, so it stays eligible for a later dispatch instead
          // of being silently lost for the rest of the session.
          const shownArticles = articles.slice(0, ARTICLE_POINTER_CAP).map((x) => x.record);
          // Only records the capped carriage actually names by id.
          markDelivered(guard, recordsShownIn(carriage, [...hazards.map((x) => x.record), ...decisions.map((x) => x.record), ...shownArticles, ...shownPrior.map((x) => x.record)]));
          writeGuard(gPath, guard);
        } catch (e) {
          // Cheap failure vs expensive one: a lost guard write costs at most a repeat
          // delivery next dispatch; a lost envelope costs the pin and the carriage.
          process.stderr.write(
            `H20: delivery bookkeeping failed AFTER the envelope was written (${(e && e.message) || e}) — the payload above STANDS and the model pin applies; these records stay eligible for delivery again this session.`
          );
        }
      },
    });
  } catch (e) {
    const failure = `H20: mechanism-axis delivery failed: ${(e && e.message) || e}`;
    const pin = modelPin();
    if (pin?.line || pin?.updatedInput) {
      // THE LAST OUTPUT PATH. A relevance failure must not silently unpin the
      // consult's model: warnNonBlocking exits 1, and an exit-1 hook's stdout is
      // not the envelope Claude Code reads updatedInput from, so dropping through
      // to it here would drop the pin exactly when something is already wrong.
      // Loud on BOTH channels instead — stderr for the transcript, the payload
      // line for the reader — and exit 0 so the pin survives (P5: visible, and
      // still never a gate). The 0 is the REQUESTED code: if this envelope's own
      // write fails, the helper turns it into a 1 rather than reporting a clean
      // exit over a lost pin (no envelope, no pin).
      process.stderr.write(failure);
      // Through emitEnvelope, never a bare write: if an envelope already landed
      // this process, THAT one carries the pin and a second object here would
      // corrupt it into unparseable text — the helper suppresses this one and
      // discloses the drop (the belt-and-braces half of the one-write rule; the
      // ordinary route is the contained bookkeeping above).
      return emitEnvelope(`⚠ ${failure} — the model pin above still applies; relevance carriage was SKIPPED for this consult.`);
    }
    // Delivery is an aid, never a gate: loud but NON-blocking (P5 without AC7 harm).
    return warnNonBlocking(failure);
  }
}

main(input);
// no close: every path above exits the process (in the write callback where an
// envelope was emitted), releasing the handle (board f81b1987)
