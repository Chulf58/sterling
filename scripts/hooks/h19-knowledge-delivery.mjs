// H19 — knowledge delivery (decision 6dfbe675; concept family
// knowledge-delivery). The front half of the learning loop: put the owning
// article IN FRONT of the agent at file-touch, mechanically — never a gate
// (AC7: this hook must never exit 2). Since decision ca23c811 the payload also
// carries the path's HAZARDS (anti_pattern, as substance) and its RATIONALE
// (decision, as capped pointers) — articles alone answer neither "what must I
// not do here" nor "why is it this way". Registered at PostToolUse
// Read|Edit|Write|MultiEdit and PreToolUse Edit|Write|MultiEdit; which
// registration acts is decided by config.delivery.injection_rung — the rung is
// PROBE-SET (verify-at-build 0956a464, research_finding on the build's CC
// version), defaulting to the platform-proven 'prompt' path:
//   'prompt' (default): PostToolUse enqueues; h19-delivery-drain injects at the
//     next UserPromptSubmit (H2's proven additionalContext surface, one-turn lag).
//   'read':  PostToolUse injects additionalContext directly at the touch.
//   'edit':  only PreToolUse injection works on this platform — the PreToolUse
//     registration injects on Edit/Write; Read touches fall back to the queue.
// Pipeline: during an active run, agents with an agent_id got prep's
// knowledge_pack — H19 stays silent for them (AC6, no double-delivery); the
// conductor's own inline touches still deliver.
import { readStdin, allow, warnNonBlocking, openStore, loadConfig, repoRel, gitIgnored } from './lib/common.mjs';
import {
  guardPath,
  pendingPath,
  readGuard,
  writeGuard,
  enqueuePending,
  renderArticle,
  renderReference,
  renderHazards,
  cappedHazards,
  renderDecisionPointers,
  DECISION_POINTER_CAP,
  renderPayload,
} from './lib/delivery.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow(); // outside the repo: no delivery jurisdiction
if (rel === '.git' || rel.startsWith('.git/')) allow(); // machinery internals (H7 precedent)
if (rel.startsWith('.sterling/')) allow(); // the store's own tree is never governed territory

const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

try {
  // Unknown/typo'd rung falls back to the platform-proven default, never to a
  // silently different behavior (the MCP write path zod-validates, but config
  // can be hand-edited).
  const rawRung = loadConfig(input.cwd)?.delivery?.injection_rung;
  const rung = ['prompt', 'read', 'edit'].includes(rawRung) ? rawRung : 'prompt';
  const event = input.hook_event_name;

  // Route by event × rung: exactly one registration acts per touch.
  //  PreToolUse acts only on rung 'edit' (the PostToolUse surface is broken there).
  //  PostToolUse acts on 'read' (direct) and 'prompt' (enqueue); on rung 'edit'
  //  it still handles Read touches (no PreToolUse Read registration exists) by
  //  falling back to the queue.
  let mode; // 'inject' | 'enqueue' | null
  if (event === 'PreToolUse') {
    mode = rung === 'edit' ? 'inject' : null;
  } else {
    if (rung === 'read') mode = 'inject';
    else if (rung === 'prompt') mode = 'enqueue';
    else mode = input.tool_name === 'Read' ? 'enqueue' : null; // rung 'edit'
  }
  if (!mode) allow();

  // The pending queue serves the CONDUCTOR's next prompt — a subagent never
  // sees a UserPromptSubmit, so enqueueing its touches would mis-route its
  // articles into the conductor's context (correctness review 2026-07-19).
  // Subagents receive delivery only on the inject rungs, in their own context.
  if (mode === 'enqueue' && input.agent_id) allow();

  const run = store.getRun();
  if (run && input.agent_id) allow(); // pipeline agent: prep staged its pack (AC6)

  const owners = store
    .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
    .filter((r) => !r.working_tree);

  // HAZARDS AND RATIONALE FOR THIS PATH (decision ca23c811). Articles answer
  // "what is this and how must it behave"; they do NOT answer "what must I not
  // do here" or "why is it this way" — those live in anti_pattern and decision,
  // both of which carry file_keys and neither of which delivery served. An
  // anti_pattern naming the exact path being edited was invisible while H10
  // asked at Stop whether a hazard had been RECORDED; a consuming project
  // shipped the very bug its stored anti_pattern described. Queried SEPARATELY
  // from owners because these types do NOT confer ownership — the frontier
  // signal still fires for territory no article owns.
  const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
  const decisions = store.query({ types: ['decision'], file_keys: [rel], cap: 100 });

  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);

  // Dedup by record id, not by file: a new file owned by an already-delivered
  // article re-arms nothing (the article is in context); a new owning record
  // always delivers (scope-growth re-arm). Hazards and decisions share the one
  // ledger — their ids are ids like any other.
  const freshOwners = owners.filter((r) => !guard.records.includes(r.id));
  const freshHazards = hazards.filter((r) => !guard.records.includes(r.id));
  const freshDecisions = decisions.filter((r) => !guard.records.includes(r.id));
  // The frontier signal stays once per file per session (grill answer: solve,
  // not accept), but it is now the payload HEADER rather than a separate
  // emission that returned early. That early return was why a hazard in UNOWNED
  // territory — the reporting project's exact case — was swallowed.
  // A gitignored path is never governed territory (board 1de3653b): no article
  // will ever own it and H10 will not demand one, so the frontier signal — whose
  // whole message is "H10 will demand an article here" — would be false on it.
  // gitIgnored's null (git cannot answer) degrades TOWARD signaling: unowned
  // stands, exactly the pre-feature behavior. Checked only on unowned paths so
  // the owned-territory fast path spawns nothing.
  const bare = owners.length === 0;
  const unowned = bare && !(gitIgnored([rel], input.cwd)?.has(rel) ?? false);
  const frontierFresh = unowned && !guard.frontier_files.includes(rel);
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !frontierFresh) allow();

  const charCap = loadConfig(input.cwd)?.delivery?.payload_char_cap ?? 2400;
  // Hazards LEAD: "do not do this here" outranks the description of what the
  // territory is, and the reader may stop after the first block.
  const blocks = [
    ...renderHazards(freshHazards, charCap, { fileKeys: [rel] }),
    ...freshOwners.map((r) => (r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap))),
    ...(freshDecisions.length ? [renderDecisionPointers(rel, freshDecisions)] : []),
  ];
  const payload = renderPayload(rel, blocks, { unowned });
  // GUARD ONLY WHAT WAS ACTUALLY RENDERED (correctness review 2026-07-30). The
  // decision cap means freshDecisions can exceed what the payload shows, and
  // marking the unshown ones delivered is silent loss with no detector: a later
  // touch of a DIFFERENT file governed by the same decisions would find them all
  // guarded and print no DECISIONS block at all — not even the count. Guarding
  // only the rendered slice makes the remainder surface on a later touch instead,
  // which is the same "never mark delivered what was not delivered" rule the
  // side-effect-first ordering below enforces for the payload as a whole.
  // Hazards guard the severity-sorted RENDERED slice only, mirroring the
  // decision cap below (board a470046d slice 1): a hazard capped out of this
  // payload must surface on a later touch, not vanish as 'delivered'.
  const fresh = [...freshOwners, ...cappedHazards(freshHazards), ...freshDecisions.slice(0, DECISION_POINTER_CAP)];

  // SIDE EFFECT FIRST, GUARD SECOND (council wf_db9a59aa-0af). The guard is what
  // makes delivery once-per-session, so writing it before the delivery actually
  // happens converts any failure into permanent silent loss: nothing retries,
  // because the next touch sees the records already marked. Ordered this way, a
  // throw lands in the catch below with the guard untouched, so the next touch
  // delivers again. The combined freshness short-circuit above is what this guard
  // arms, so a guard written before a failed delivery silences the article for the whole session
  // with no residue and no detector. NOTE what this does and does not close: it
  // fully closes the case where the delivery THROWS (enqueue or stdout). It cannot
  // close the case where stdout succeeds and the PLATFORM ignores additionalContext
  // — nothing raises there, so no in-process ordering helps. That case is now PROBED
  // rather than hypothetical (research_finding 6adaa2ef, decision aa41e2ed): both
  // surfaces inject on this machine's WSL CLI at CC 2.1.220, interactive as well as
  // headless, so injection_rung is 'read' here. What that probe does NOT license is
  // the claim this comment used to make — that the failure is a 'per-platform
  // binary' settled once. Upstream it is per CC version x client surface x matcher x
  // tool class (live in the CLI, dead in the VSCode extension; dropped for the Bash
  // matcher; dropped for MCP calls), so a probe settles one CELL and an unprobed
  // client or launcher still loses silently. The successor is rung PROVENANCE — fall
  // back to 'prompt' when the running session is not the probed cell — not
  // residue-on-inject, which would double-deliver every healthy payload to hedge it.
  if (mode === 'enqueue') {
    enqueuePending(pendingPath(input.cwd), {
      kind: unowned ? 'frontier' : 'delivery',
      rel,
      payload,
      agent_id: input.agent_id ?? 'conductor',
    });
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: payload } }));
  }
  guard.records.push(...fresh.map((r) => r.id));
  if (frontierFresh) guard.frontier_files.push(rel);
  writeGuard(gPath, guard);
  allow();
} catch (e) {
  // Delivery is an aid, never a gate: internal failure is loud but NON-blocking
  // (P5 visibility without an AC7 violation).
  warnNonBlocking(`H19: knowledge delivery failed for '${rel}': ${(e && e.message) || e}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
