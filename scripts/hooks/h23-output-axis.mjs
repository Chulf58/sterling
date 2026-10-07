// H23 — OUTPUT-AXIS DELIVERY (board 5e3d6ff4; decision
// output-axis-delivery-h23-consumed-content-pointers, knowledge_get
// b266d6b7-8bdd-4b44-abcf-b7487c303854; concept family knowledge-delivery).
// H19 keys on the file PATH touched; H20 keys on the dispatch PROMPT; neither
// ever looks at what a tool call actually RETURNED — a log tail, a rendered
// artifact, a probe's stdout. Registered on PostToolUse Read and Bash
// (PowerShell too, per the decision) this hook runs H20's three-floor
// mechanism-axis match (AXIS_MIN_HITS, a discriminating hit, record
// centrality) over the CONSUMED CONTENT itself against anti_pattern candidates
// (decisions dropped 2026-09-29, see NARROWED below). MEASURED FAILURES this
// closes (board 5e3d6ff4): 14 rendered plates were sent to the user against a
// standing gate while path-keyed delivery stayed silent at that exact moment (retro 2026-08-15-1520); an
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
// NARROWED 2026-09-29 (USER RULING h23-output-axis-hazards-only-skip-listings-
// advisory-label, knowledge_get 5564361d v2): noise persisted after the one-
// pointer cap, and a consuming project's user read the notice as an error.
// A score threshold cannot fix it (see below), so this hook now narrows by
// record TYPE and command CLASS instead: (1) the header opens with "ADVISORY
// (not an error)"; (2) Bash/PowerShell calls whose command is VCS or listing
// output (lib/listing-command.mjs) are skipped; (3) only anti_pattern records are
// pointed at — decisions reach the model through H20 and explicit lookups.
//
// POINTER, NOT SUBSTANCE — an output match is weaker evidence of relevance
// than an explicit file_keys join, so this direct PostToolUse advisory stays a
// bounded discovery pointer rather than an article.
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
// Every context receives its own direct pointer; no prompt-time relay exists.
//
// NEVER BLOCKS, NEVER THROWS OUT: every path below ends in allow()/exit 0,
// including malformed stdin (readStdin's JSON.parse is inside the same
// try/catch as everything else here, unlike h19/h20 where it sits outside
// theirs — this hook's own contract requires exit 0 even there), a missing
// tool_response, an unrecognised tool name, and any internal failure.
import { readStdin, allow, repoRel, exitAfterWrite, warnNonBlocking, openStoreOrDegrade } from './lib/common.mjs';
import { openSubjectFan, warnFanDegraded } from './lib/subject-fan.mjs';
import { recordAdvisoryFire } from './lib/advisory-counter.mjs';
import { isListingCommand } from './lib/listing-command.mjs';
import { guardPath, readGuard, writeGuard } from './lib/delivery.mjs';
import { composeOutputAxis, outputAxisReadGated } from './lib/axis-compose.mjs';

// The clip and pointer cap, with the measurements behind them, live in
// lib/axis-compose.mjs; they are re-exported here under their old names.
export { OUTPUT_AXIS_CLIP, OUTPUT_AXIS_POINTER_CAP } from './lib/axis-compose.mjs';

try {
  const input = readStdin();

  const toolName = input.tool_name;
  if (toolName !== 'Read' && toolName !== 'Bash' && toolName !== 'PowerShell') allow();

  const rawResponse = input.tool_response;
  if (rawResponse === undefined || rawResponse === null) allow(); // nothing to match against

  // COMMAND-CLASS SKIP (ruling 5564361d v2): VCS/listing output is never matched.
  if (toolName !== 'Read' && isListingCommand(input.tool_input?.command)) allow();

  // The subject fan (lib/subject-fan.mjs): the project store plus the mounted
  // domains. The read gate below passes file_keys, so it reads the project store only.
  const store = openStoreOrDegrade(input.cwd, 'H23', openSubjectFan);
  if (!store) allow(); // not a Sterling project — no ceremony (P1)

  // READ SEAM OWNERSHIP GATE — lib/axis-compose.mjs outputAxisReadGated, which
  // carries the rationale (H19 owns governed territory; .git and .sterling are excluded).
  if (toolName === 'Read' && outputAxisReadGated(store, repoRel(input.tool_input?.file_path, input.cwd), input.cwd)) {
    warnFanDegraded(store, 'H23');
    allow();
  }

  // Stringify an object-shaped tool_response (e.g. a structured Bash result)
  // before matching; a string tool_response is matched as-is.
  const content = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

  // THE COMPOSITION IS SHARED (lib/axis-compose.mjs, also called by the OpenCode
  // plugin): the three floors, the guard.output_axis dedup and the pointer block.
  const gPath = guardPath(input.cwd, input.agent_id, input.session_id);
  const composed = composeOutputAxis(store, { content, guardFor: () => readGuard(gPath) });
  // A domain or config.json the fan could not read is one loud stderr line; the
  // project store's delivery is unaffected.
  warnFanDegraded(store, 'H23');
  if (!composed) allow();
  const { text: payload, guard, seen, shown } = composed;

  // Direct on this PostToolUse for both conductor and child contexts.
  recordAdvisoryFire(input.cwd, 'h23', input.session_id); // expiring campaign scaffolding — see lib/advisory-counter.mjs
  exitAfterWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: payload } }), 0, {
    onWritten: () => {
      guard.output_axis = [...seen, ...shown.map((x) => x.record.id)];
      writeGuard(gPath, guard);
    },
  });
} catch (e) {
  // Delivery is an aid, never a gate, and this channel's own contract (unlike
  // H19/H20's warnNonBlocking-on-catch) is exit 0 on every path, including a
  // malformed-stdin JSON.parse failure inside readStdin() above.
  warnNonBlocking(`H23: output-axis delivery failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
