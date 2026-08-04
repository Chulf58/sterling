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
import { existsSync } from 'node:fs';
import { readStdin, allow, warnNonBlocking, openStore, loadConfig, repoRel } from './lib/common.mjs';
import { readTail } from './lib/transcript.mjs';
import {
  guardPath,
  readGuard,
  writeGuard,
  renderArticle,
  renderReference,
  renderHazards,
  renderDecisionPointers,
  DECISION_POINTER_CAP,
  renderPayload,
} from './lib/delivery.mjs';

// Path-candidate extraction from free-form prompt prose. No shared extractor
// exists yet in this codebase for this shape (grepped: absent) — the nearest
// analog, a bash-command path extractor, does not exist either; this is a
// standalone extractor for prompt TEXT rather than a single shell command.
// Deliberately permissive: a false positive costs one extra store lookup that
// finds nothing; a false negative costs the staging this hook exists to
// provide. Directory segments exclude '.' (so URLs and prose like
// "claude.com/docs" rarely qualify); the filename segment allows '.' for
// multi-dot names (e.g. 'h19-delivery.test.mjs'); the trailing extension group
// is what stops the match before sentence punctuation ('…delivery.mjs.' keeps
// only 'delivery.mjs').
const PATH_CANDIDATE_RE = /(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}/g;

function extractPathCandidates(text) {
  const found = String(text ?? '').match(PATH_CANDIDATE_RE) ?? [];
  return [...new Set(found)];
}

/** The union of every Task/Agent tool_use block's `prompt` in the LAST
 *  assistant message (scanned from the tail) that carries at least one such
 *  block. Returns [] on anything short of a clean read: missing transcript,
 *  no assistant entries, malformed JSON — staging degrades to silence rather
 *  than a throw a caller must special-case. */
function lastDispatchPrompts(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const tail = readTail(transcriptPath);
  if (tail === null) return [];
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // first line of the tail window may be truncated
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const blocks = content.filter((b) => b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent'));
    if (!blocks.length) continue; // this assistant turn dispatched nothing — keep scanning backward
    return blocks.map((b) => b.input?.prompt).filter((p) => typeof p === 'string');
  }
  return [];
}

const input = readStdin();

try {
  const store = openStore(input.cwd);
  if (!store) allow(); // not a Sterling project — no ceremony (P1)

  const prompts = lastDispatchPrompts(input.transcript_path);
  const candidates = [...new Set(prompts.flatMap(extractPathCandidates))];

  const rels = [...new Set(candidates.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
    (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/')
  );

  // AC5's contract: "a dispatch with declared file_keys gets the payload
  // staged; undeclared dispatches are unchanged" — no candidates at all is the
  // undeclared case, exit 0 with no output.
  if (!rels.length) allow();

  const owners = store
    .query({ types: ['feature_article', 'reference_material'], file_keys: rels, cap: 100 })
    .filter((r) => !r.working_tree);
  const hazards = store.query({ types: ['anti_pattern'], file_keys: rels, cap: 100 });
  const decisions = store.query({ types: ['decision'], file_keys: rels, cap: 100 });

  // Candidates resolved but named nothing the store governs: still the
  // undeclared case for AC5's purposes — no frontier notice here (that signal
  // belongs to the file-touch hook, which fires once the agent actually
  // touches the path; staging is a bonus, not a second frontier surface).
  if (!owners.length && !hazards.length && !decisions.length) allow();

  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);

  const freshOwners = owners.filter((r) => !guard.records.includes(r.id));
  const freshHazards = hazards.filter((r) => !guard.records.includes(r.id));
  const freshDecisions = decisions.filter((r) => !guard.records.includes(r.id));
  if (!freshOwners.length && !freshHazards.length && !freshDecisions.length) allow();

  const charCap = loadConfig(input.cwd)?.delivery?.payload_char_cap ?? 2400;
  const blocks = [
    ...renderHazards(freshHazards, charCap),
    ...freshOwners.map((r) => (r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap))),
    ...(freshDecisions.length ? [renderDecisionPointers(rels.join(', '), freshDecisions)] : []),
  ];
  const payload = renderPayload(rels.join(', '), blocks, { unowned: false });
  const fresh = [...freshOwners, ...freshHazards, ...freshDecisions.slice(0, DECISION_POINTER_CAP)];

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
