import { z } from 'zod';

// Run-scoped transient shapes (spec §3.2.9) — NOT knowledge-store records.
// The staged pipeline (signals, handoffs, machine states, run records) was
// removed per decision sterling-claude-code-scale-down-boundary (2ad87dd1);
// only the session-event register survives — it backs the knowledge-loop
// events (no_capture, capture_pending, concept_designed, …) below.

// Session-event register shape (run r-0501, interface slice 1). A run-scoped
// append log at .sterling/transient/session-events.json; defined ONCE here
// (invariant 1); written by H16 (research_tool, agent_dispatch),
// debug-scope.mjs (debug_scope), concept-designed.mjs (concept_designed —
// detail carries the concept FAMILY slug; decision foreign_7208729b), and
// no-capture.mjs (no_capture — detail carries the REASON; board 7bbec3bd:
// an explicit declaration that a Stop produced nothing durable, satisfying
// H10's capture duty for every touch/debug_scope event EARLIER than it; work
// arriving after the declaration re-arms the duty. A false declaration is
// drift, not a bypass). Since 2026-08-09 (board 1af5d630/75b1a05f) no_capture,
// concept_designed and the SIXTH kind capture_pending are also writable via
// the MCP tool surface — the scripts stay as the no-server fallback.
// capture_pending: detail carries "<target> — <reason>" (and `target` carries
// the target alone, see the field below), declaring the capture
// EXISTS and its write is in flight on a named commit/agent/lane; H10 defers
// the capture duty one Stop (registers preserved, so a landed write settles
// cleanly) and converts a still-pending duty to ONE deduped capture_owed item
// on the next — pending work defers or lands on the queue, never evaporates.
// test_repair (decision frozen-test-repair-signatures-plus-visible-repair,
// 7a4c3fb6-dc23-4c2f-9369-d2592132f408; board a06e4a1c): the VISIBLE-REPAIR
// half — the conductor stays sanctioned to hand-repair a demonstrably buggy
// frozen test (H5 rides coder/debugger frontmatter only), but the repair
// must stop being invisible. detail carries the repaired repo-relative test
// path plus the evidence for why the TEST, not the code, was wrong; written
// by scripts/test-repair.mjs (a CLI, not a hook — mirrors no-capture.mjs's
// append shape). Never a durable store record.
// test_append (board 17204d1e): the ADDITIVE sibling of test_repair — the
// conductor appended a NEW case to a frozen test rather than repairing a
// wrong one; detail carries the test path plus what the new case pins and
// why it is additive. Written by scripts/test-repair.mjs --append. Kept a
// distinct kind so appends and repairs are never conflated in the register.
// READER ASYMMETRY (deliberate, not an oversight): a test_repair event
// discharges H10's per-path capture duty (h10-direct-capture.mjs kind-filters
// 'test_repair' only) — a test_append event does NOT, so the capture duty
// stays armed for an appended case. This is the safe direction (consistent
// with decision no-capture-discharge-is-lane-scoped) and the two kinds are
// NOT siblings for that purpose — do not assume parity when wiring a reader.
//
// LANE (decision no-capture-discharge-is-lane-scoped,
// 51ebe0dd-099e-40a9-abc5-d3c8cc767883; USER-RULED 2026-08-22): a no_capture
// declaration is scoped to the duty lane it actually claims. OPTIONAL because a
// BARE declaration is the pre-ruling behavior — it covers the CAPTURE lane only
// — and because every no_capture event written BEFORE this field existed must
// read the same way: field-absent means 'capture', NEVER 'all'. A legacy event
// cannot silently gain research-clearing power it never had, since a locally
// true "typo fix, nothing durable" would then silently discharge an unrelated
// earlier research duty (P5 fail-loud / P2 the KB is the product: silent
// knowledge loss is the severe direction). Both producers — scripts/no-capture.mjs
// (--lane) and the no_capture MCP tool — refuse an unrecognized value LOUDLY,
// naming this set, rather than coercing it to a lane the human did not claim.
export const NO_CAPTURE_LANES = ['research', 'capture', 'all'] as const;
export const noCaptureLaneSchema = z.enum(NO_CAPTURE_LANES);
export type NoCaptureLane = z.infer<typeof noCaptureLaneSchema>;

export const sessionEventSchema = z.object({
  kind: z.enum([
    'research_tool',
    'agent_dispatch',
    'debug_scope',
    'concept_designed',
    'no_capture',
    'capture_pending',
    'test_repair',
    'test_append',
  ]),
  detail: z.string().min(1),
  at: z.string().min(1),
  lane: noCaptureLaneSchema.optional(),
  // capture_pending only (board f003082d): the declared target, trimmed, as its
  // own field. H10 keys a lapsed declaration's capture_owed debt on it alone,
  // so one target declared with two reasons is one debt. OPTIONAL because a
  // legacy event carries only the joined detail; H10 keys such an event on the
  // whole detail (never a split on ' — ', which may occur inside a target).
  // Trimmed before the length check, so a whitespace-only target is refused.
  target: z.string().trim().min(1).optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

// Domain-write ledger (decision domain-record-duty-credit-comes-from-a-per-project-write-ledger).
// A mounted domain store is shared by every project on the machine and its
// records carry no origin project, so the record alone cannot say whose session
// wrote it. The MCP server therefore appends one entry to its ledger file
// under its own project root after each write of a record held by a domain
// store (create, update and the tools that go through it, promote, supersede).
// H10 and the OpenCode settlement count a domain record toward the capture or
// research duty only when this ledger holds an entry with the same id and an
// `at` inside the duty window. Project-store records never appear here and pay
// as before.
//
// ONE FILE PER SERVER PROCESS. Several servers run under one project root (the
// session's, a maintenance worker's, OpenCode's), and on /mnt/c under WSL2 an
// append is not atomic across processes: two of them appending to one file
// within a few milliseconds overwrite each other (finding
// o-append-is-not-atomic-across-processes-on-wsl2-mnt-c). Each process
// therefore appends to its own file, knowledgeWritesProcessFile(pid, uuid) in
// KNOWLEDGE_WRITES_DIR_REL, whose name it fixes once and creates on its first
// domain write. No file has two writers, so no append and no compaction can
// lose another process's entry.
//
// FORMAT: JSON Lines, one entry per line, append-only. A reader takes the union
// of every file whose name matches KNOWLEDGE_WRITES_PROCESS_FILE exactly, plus
// the legacy single file KNOWLEDGE_WRITES_REL that builds before the split
// appended to (nothing appends to it any more), and keeps the latest `at` per
// id. It skips a line that does not parse or is not the shape below. The
// pattern is anchored at both ends, so a compaction temp file
// (<ledger file>.tmp-<pid>-<uuid>) is never read.
//
// A SEPARATE set of files from the session-event register on purpose: H10's
// clearRegisters rewrites and deletes that register at Stop, which would lose
// the write evidence while later work re-arms the duty. No Stop, settlement or
// reader clears a ledger file. Each is bounded instead: when a process's file
// passes KNOWLEDGE_WRITES_COMPACT_LINES lines that process rewrites it to the
// latest entry of the newest KNOWLEDGE_WRITES_KEEP_IDS record ids (tmp file,
// then rename). And a server removes, at its start only, another process's
// file, or a compaction temp file a crash left (KNOWLEDGE_WRITES_TEMP_FILE),
// that is older than KNOWLEDGE_WRITES_RETENTION_MS and whose owner pid is
// gone; the rule and its accepted limit are stated at
// removeExpiredDomainWriteLedgers in packages/mcp-server/src/tools.ts.
//
// Strict: an entry is exactly {id, type, at}. Nothing about the writing project
// or session enters it, and nothing from these files enters any store. The pid
// in a file name is this machine's process id and stays in the transient
// folder.
export const KNOWLEDGE_WRITES_DIR_REL = '.sterling/transient';
/** The legacy single ledger file. Read by the union, never appended to. */
export const KNOWLEDGE_WRITES_REL = `${KNOWLEDGE_WRITES_DIR_REL}/knowledge-writes.jsonl`;
/** A per-process ledger file's name; group 1 is the owner pid. */
export const KNOWLEDGE_WRITES_PROCESS_FILE = /^knowledge-writes\.([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
export const knowledgeWritesProcessFile = (pid: number, uuid: string): string => `knowledge-writes.${pid}-${uuid}.jsonl`;
/** The owner pid a per-process ledger file's name carries, or null when the name is not exactly that pattern. */
export function knowledgeWritesOwnerPid(fileName: string): number | null {
  const m = KNOWLEDGE_WRITES_PROCESS_FILE.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}
/**
 * A compaction temp file's name: a ledger file's name (per-process, or the
 * legacy one a build before the split compacted) followed by
 * .tmp-<pid>-<uuid>. Group 1 is the pid of the process that was compacting. A
 * compaction renames its temp file away at once, so one that stays is what a
 * crash left. No reader reads it.
 */
export const KNOWLEDGE_WRITES_TEMP_FILE = /^knowledge-writes\.(?:[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.)?jsonl\.tmp-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const knowledgeWritesTempFile = (ledgerFileName: string, pid: number, uuid: string): string => `${ledgerFileName}.tmp-${pid}-${uuid}`;
/** The pid of the process that wrote a compaction temp file, or null when the name is not exactly that pattern. */
export function knowledgeWritesTempOwnerPid(fileName: string): number | null {
  const m = KNOWLEDGE_WRITES_TEMP_FILE.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}
export const KNOWLEDGE_WRITES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const KNOWLEDGE_WRITES_COMPACT_LINES = 1000;
export const KNOWLEDGE_WRITES_KEEP_IDS = 500;
export const knowledgeWriteSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    at: z.string().min(1),
  })
  .strict();
export type KnowledgeWrite = z.infer<typeof knowledgeWriteSchema>;

// The maintenance worker's batch policy (GitHub #56, decision
// maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet,
// changes (i) and (ii)). The launcher's token-bound eligible.json
// (.sterling/transient/maintenance-worker.eligible.json) is the policy file:
// the worker's MCP server reads it through `--worker-policy <path>
// --worker-token <token>` and refuses every mutation it does not allow.
// eligible.json already carries `items` ({id, file_keys, feature_link, slug},
// the runner's judging list), so the policy items live under `policy_items`.
// Unknown keys pass through, at the top level and on each item: the launcher
// and runner keep their own fields, and an unknown key never widens what the
// server allows, because the server reads only the keys named here.
export const WORKER_POLICY_LANES = ['reconcile_needed', 'state_review', 'stale_research', 'refresh_reference', 'article_missing'] as const;
export type WorkerPolicyLane = (typeof WORKER_POLICY_LANES)[number];
export const workerPolicyItemSchema = z
  .object({
    id: z.string().uuid(),
    lane: z.enum(WORKER_POLICY_LANES),
    target_id: z.string().uuid().nullable(),
    file_keys: z.array(z.string().min(1)),
  })
  .passthrough();
export type WorkerPolicyItem = z.infer<typeof workerPolicyItemSchema>;
export const workerPolicySchema = z
  .object({
    policy_version: z.literal(1),
    token: z.string().min(1),
    run_id: z.string().min(1),
    policy_items: z.array(workerPolicyItemSchema),
  })
  .passthrough();
export type WorkerPolicy = z.infer<typeof workerPolicySchema>;
