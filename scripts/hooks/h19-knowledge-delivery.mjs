// H19 — knowledge delivery (decision fe62546f; concept family
// knowledge-delivery). The front half of the learning loop: put the owning
// article IN FRONT of the agent at file-touch, mechanically — never a gate
// (AC7: this hook must never exit 2). Registered at PostToolUse
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
import { readStdin, allow, warnNonBlocking, openStore, loadConfig, repoRel } from './lib/common.mjs';
import {
  guardPath,
  pendingPath,
  readGuard,
  writeGuard,
  enqueuePending,
  renderArticle,
  renderReference,
  renderPayload,
  renderFrontier,
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

  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);

  if (owners.length === 0) {
    // Frontier signal (grill answer: solve, not accept) — once per file per session.
    if (guard.frontier_files.includes(rel)) allow();
    guard.frontier_files.push(rel);
    const notice = renderFrontier(rel);
    writeGuard(gPath, guard);
    if (mode === 'enqueue') {
      enqueuePending(pendingPath(input.cwd), { kind: 'frontier', rel, payload: notice, agent_id: input.agent_id ?? 'conductor' });
      allow();
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notice } }));
    allow();
  }

  // Dedup by record id, not by file: a new file owned by an already-delivered
  // article re-arms nothing (the article is in context); a new owning record
  // always delivers (scope-growth re-arm).
  const fresh = owners.filter((r) => !guard.records.includes(r.id));
  if (fresh.length === 0) allow();

  const charCap = loadConfig(input.cwd)?.delivery?.payload_char_cap ?? 2400;
  const blocks = fresh.map((r) => (r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap)));
  const payload = renderPayload(rel, blocks);

  guard.records.push(...fresh.map((r) => r.id));
  writeGuard(gPath, guard);

  if (mode === 'enqueue') {
    enqueuePending(pendingPath(input.cwd), { kind: 'delivery', rel, payload, agent_id: input.agent_id ?? 'conductor' });
    allow();
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: payload } }));
  allow();
} catch (e) {
  // Delivery is an aid, never a gate: internal failure is loud but NON-blocking
  // (P5 visibility without an AC7 violation).
  warnNonBlocking(`H19: knowledge delivery failed for '${rel}': ${(e && e.message) || e}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
