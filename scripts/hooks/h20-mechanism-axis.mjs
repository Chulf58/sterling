// H20 — mechanism-axis delivery at DISPATCH (board 62806222; concept family
// knowledge-delivery, member 7). Registered at PreToolUse on TWO matcher entries:
// Task|Agent (the dispatch surface) and AskUserQuestion (the question surface,
// decision foreign_f5638a84). Every delivery member elsewhere NEVER blocks; AC7 still
// holds for the dispatch/consult surfaces here. The AskUserQuestion surface is
// the ONE exception (decision foreign_68332e4b, 2026-08-24): a first-attempt question
// whose subject STRONGLY matches a store RULING (decision/anti_pattern) is
// DENIED (exit 2) before it ever reaches the user — see the DENY-ONCE block
// below and its plumbing in lib/delivery.mjs. Everywhere else this file still
// never exits 2.
//
// TIMING, probed live 2026-08-11 (research_finding foreign_63a9646d):
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
// additionalContext to the DISPATCHING agent (research_finding foreign_e14dcf9a, issue
// #39814) — which is the right destination here, because the conductor writing
// the prompt is who needs stopping. (That same finding is why this is NOT the
// seam for H19 AC5 dispatch staging: for staging knowledge INTO the subagent,
// this destination is wrong. Different mechanism, different board item.)
//
// WHY IT DOES NOT BECOME NOISE (the P1 half, and the reason board 7bbec3bd
// exists): it is SILENT unless a real match survives both stages. A hook that
// fires on every dispatch would train the reader to skip it, which is precisely
// the H10 file-count failure this must not repeat. Measured 2026-08-04
// (board 648bb497, research_finding foreign_bf74c65f): on THIS repo it was firing
// 15/15, dominated by universal dev vocabulary that AXIS_MIN_HITS alone could
// not exclude — stage 2 now also requires hasDiscriminatingHit, a third floor
// that a match matching ONLY generic terms (test, check, file, ...) cannot
// clear on its own.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, exitAfterWrite, openStore } from './lib/common.mjs';
import { boardReadyNotice, boardReadyNoticeDue, markBoardReadyNoticed, laneCeiling, liveLanes } from './lib/board-ready.mjs';
import { readProjectConfig } from './lib/operating-state.mjs';
import { openSubjectFan, warnFanDegraded } from './lib/subject-fan.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import {
  guardPath,
  readGuard,
  writeGuard,
  outgoingProposalText,
  markSubstanceDelivered,
  markDiscoveryDelivered,
} from './lib/delivery.mjs';
import { dispatchOverlapNotice } from './lib/dispatch-overlap.mjs';
import { codexModelPin, composeMechanismAxis } from './lib/axis-compose.mjs';

// The injection ceilings, the question-shape test and the composition itself
// live in lib/axis-compose.mjs (shared with the OpenCode plugin).
const NARROW_CLIP = 700;

const input = readStdin();

// ===========================================================================
// CODEX MODEL PIN — THE FIRST STEP, AHEAD OF EVERYTHING BELOW (board 7423f7a2
// slice 5; decision foreign_8b329d57 as CORRECTED FORWARD; research_finding foreign_be284452).
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
// ADVISORY ALWAYS (decision foreign_ea68735d point 3): enabled:false prints a loud OFF
// line and changes nothing else — enablement and model selection are separate
// axes, and an explicitly user-asked consult still runs. An explicit call-site
// model always wins. A missing, unreadable or empty-valued config injects
// NOTHING and says so (P5 degraded-loud). No shape here ever denies.
// ===========================================================================
/**
 * The model-pin decision for this call: `{ line, updatedInput? }`, or null when
 * this is not a codex call (or not a Sterling project — P1, no ceremony).
 * NEVER THROWS: the shared codexModelPin (lib/axis-compose.mjs) never throws.
 */
function buildModelPin(inp) {
  if (typeof inp.tool_name !== 'string' || !inp.tool_name.startsWith('mcp__codex__')) return null;
  const root = inp.cwd ? String(inp.cwd) : '';
  const sterling = join(root, '.sterling');
  // Outside a Sterling project there is no config to read and nothing to say.
  if (!existsSync(join(sterling, 'sterling.db')) && !existsSync(join(sterling, 'config.json'))) return null;
  // NEVER ON codex-reply: that tool's schema has no `model` field at all, so the
  // opener test is the EXACT tool name, not the 'mcp__codex__' prefix.
  const pin = codexModelPin(root, { opener: inp.tool_name === 'mcp__codex__codex', toolInput: inp.tool_input });
  if (!pin.model) return { line: pin.line };
  return { line: pin.line, updatedInput: { ...(inp.tool_input && typeof inp.tool_input === 'object' ? inp.tool_input : {}), model: pin.model } };
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
function emitEnvelope(extraContext, opts = {}) {
  return exitAfterWrite(JSON.stringify(envelopeFor(extraContext)), 0, {
    ...opts,
    onWritten: () => {
      markBoardReadyShown();
      opts.onWritten?.();
    },
  });
}

/** BOARD READY LINE (decision
 *  board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start,
 *  AMENDED (e)): on the conductor's own Task|Agent dispatch, one line naming
 *  the READY and READY FOR RESEARCH items the brief does not name, deduped per
 *  session on a hash of that set (lib/board-ready.mjs). It exists because
 *  H22's SubagentStop stderr may never reach the model and H10's Stop notices
 *  drain only at the user's next prompt; this widens WHERE the list prints, not
 *  WHETHER. A subagent's own dispatch (agent_id set) gets no line. Memoized:
 *  every output path below carries it through overlapNotice(). */
let boardMemo;
function boardReady() {
  if (boardMemo !== undefined) return boardMemo;
  boardMemo = null;
  const onDispatch = !Array.isArray(input.tool_input?.questions) && !(typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__codex__'));
  if (!onDispatch || input.agent_id) return boardMemo;
  try {
    const store = openStore(input.cwd);
    if (!store) return boardMemo;
    let readiness;
    try {
      readiness = store.boardReadiness();
    } finally {
      store.close();
    }
    const notice = boardReadyNotice(readiness, outgoingProposalText(input.tool_input), liveLanes(input.cwd, input.session_id), laneCeiling(readProjectConfig(input.cwd).config));
    if (notice && boardReadyNoticeDue(input.cwd, input.session_id, notice.hash)) boardMemo = notice;
  } catch (e) {
    // Loud, and repeated on each dispatch until it reads again: no hash, so nothing is marked shown.
    boardMemo = { line: `BOARD READY line unavailable (${(e && e.message) || e}) — read the board with board_query before dispatching more.`, hash: null };
  }
  return boardMemo;
}

/** After the envelope landed: record that this session saw the line for this ready set. */
function markBoardReadyShown() {
  const b = boardMemo;
  if (!b?.hash) return;
  try {
    markBoardReadyNoticed(input.cwd, input.session_id, b.hash);
  } catch (e) {
    process.stderr.write(`H20: the BOARD READY line was written but its dedupe mark failed (${(e && e.message) || e}) — it may repeat on the next dispatch.`);
  }
}

/** DISPATCH OVERLAP (decision h20-warns-on-dispatch-file-overlap-with-live-
 *  agents): on the Task|Agent surface only, the advisory block naming files
 *  this brief shares with a live dispatch, a degraded line when the register
 *  cannot be read, or null. Computed once and memoized, like the model pin,
 *  because EVERY output path below carries it: the early exits through
 *  finish(), the full delivery as a pinned part, and the catch arm.
 *  dispatchOverlapNotice never throws. */
let overlapMemo;
function overlapNotice() {
  if (overlapMemo === undefined) {
    const onDispatch = !Array.isArray(input.tool_input?.questions) && !(typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__codex__'));
    overlapMemo = [onDispatch ? dispatchOverlapNotice(input) : null, boardReady()?.line].filter(Boolean).join('\n\n') || null;
  }
  return overlapMemo;
}

/** Exit 0, emitting the composed envelope — the replacement for a bare allow()
 *  on every early-exit below. With no pin, no carriage and no overlap it is
 *  exactly allow(): silence, so a non-codex dispatch that matched nothing
 *  still prints nothing. The overlap block rides after any carriage. */
function finish(extraContext) {
  const pin = modelPin();
  const context = [extraContext, overlapNotice()].filter(Boolean).join('\n\n');
  if (!pin?.line && !pin?.updatedInput && !context) return allow();
  return emitEnvelope(context);
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
// The Task|Agent surface. Only here do hazards render lead-whole with trigger
// lines (decision h20-dispatch-surface-lead-hazard-whole-rest-as-trigger-lines,
// a4912f91); a consult keeps them whole.
const isDispatch = !isQuestion && !isConsult;


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
    // openSubjectFan THROWS on a corrupt or locked db (it returns null only for an
    // ABSENT one — anti-pattern foreign_e13f0fb5 pins that distinction). An uncaught throw
    // exits 1, and an exit-1 hook's stdout is not the envelope Claude Code reads
    // updatedInput from, so the consult would silently lose its model pin — the
    // exact loss the catch arm below was written to prevent, one statement too
    // early to catch it. Inside the try, both failures land on that arm and the
    // pin still ships.
    const outgoing = outgoingProposalText(input.tool_input);
    if (!outgoing) return finish(); // nothing readable on this surface — the model pin still ships
    // The subject fan (lib/subject-fan.mjs): the project store plus the mounted domains.
    const store = openSubjectFan(input.cwd);
    if (!store) return finish(); // no store — no relevance carriage possible, pin unaffected

    // THE COMPOSITION IS SHARED (scripts/hooks/lib/axis-compose.mjs, also called
    // by the OpenCode plugin): stages 1-2, the guard pre-filter, the surface
    // headers, the per-type blocks and the assembled payload all live there.
    const gPath = guardPath(input.cwd, input.agent_id, input.session_id);
    const composed = composeMechanismAxis(store, {
      root: input.cwd,
      outgoing,
      toolInput: input.tool_input,
      surface: isQuestion ? 'question' : isConsult ? 'consult' : 'dispatch',
      subagentType: input.tool_input?.subagent_type,
      guardFor: () => readGuard(gPath),
      pinLine: modelPin()?.line,
      overlap: overlapNotice(),
      host: 'claude',
    });
    // A domain or config.json the fan could not read is one loud stderr line; the
    // project store's delivery above is unaffected.
    warnFanDegraded(store, 'H20');
    if (!composed) return finish();
    const { assembled, guard } = composed;
    const pin = modelPin();
    const carriage = assembled.text;

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
    // path) — but `carriage` above ALREADY contains the pin line (folded in as
    // a charged part), so this uses the raw envelope shape directly rather
    // than `emitEnvelope`/`envelopeFor`, which would prepend the pin a SECOND
    // time.
    const hookSpecificOutput = { hookEventName: input.hook_event_name };
    if (pin?.updatedInput) hookSpecificOutput.updatedInput = pin.updatedInput;
    if (carriage) hookSpecificOutput.additionalContext = carriage;
    return exitAfterWrite(JSON.stringify({ hookSpecificOutput }), 0, {
      onWritten: () => {
        markBoardReadyShown();
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
          // Only what the assembler says it actually emitted — never a
          // re-scan of the composed text (decision 92088a62's ONE ASSEMBLER
          // CONTRACT).
          markSubstanceDelivered(guard, assembled.emittedSubstance);
          markDiscoveryDelivered(guard, assembled.emittedDiscovery);
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
    const overlap = overlapNotice();
    if (overlap && !pin?.line && !pin?.updatedInput) {
      // A relevance failure must not swallow the overlap warning either: loud
      // on stderr, the warning still delivered, exit 0 (never a gate).
      process.stderr.write(failure);
      return emitEnvelope(`${overlap}\n\n⚠ ${failure} — relevance carriage was SKIPPED for this dispatch.`);
    }
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
