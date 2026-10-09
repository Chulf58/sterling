// Worker mode: the maintenance worker's own MCP server refuses every store
// mutation its run's batch policy does not allow, BEFORE the mutation runs,
// and stamps every allowed write's receipt with the run and the item (GitHub
// #56 slice A; decision
// maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet,
// design (a), (c), (d) and changes (i)-(iv)).
//
// The server is in worker mode only when main.ts was given
// `--worker-policy <eligible.json> --worker-token <lock token>`; without them
// nothing here runs. The policy file is re-read on every mutation, and every
// mutation fails CLOSED when it is missing, unparseable, fails
// workerPolicySchema, or carries a different token. Read tools pass through
// untouched. Every tool that is neither a read nor one of the guarded writes
// below is refused, so a tool added later is refused in worker mode until it
// is given a rule here.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MountedStores } from '@sterling/store';
import { normalizeRepoPath, workerPolicySchema, type WorkerPolicy, type WorkerPolicyItem, type WorkerPolicyLane } from '@sterling/schemas';

export interface WorkerPolicyArgs {
  /** Absolute path to the run's eligible.json. */
  path: string;
  /** The run's lock token; the policy's `token` must equal it. */
  token: string;
}

/** The receipt key every allowed worker write carries. The worker's stream
 *  parser (slice B) fails the run on a successful write result without it. */
export const WORKER_STAMP_KEY = 'worker_stamp';
/** `resolved` lists the queue items this call named for closing (`resolves`,
 *  or the removed id) that are gone from the store after it ran. The runner
 *  counts a closure only from this list, never from the request: an
 *  article_missing join that covers part of an item rewrites the item and
 *  leaves it open. */
export type WorkerStamp = { run_id: string; item_id: string; resolved: string[] };
type Authorized = { run_id: string; item_id: string; closes: string[] };

/**
 * Which fields a worker write may touch, by the lane of the policy item that
 * names the target, then by the target's record type. A type not listed for
 * a lane is refused outright, so decision and anti_pattern bodies are never
 * writable, and title and slug appear nowhere. The entries are the factual
 * refresh the decision allows: files[] (roles and entry marks included),
 * history, test references, state, the dates, and the prose fields where one
 * corrected sentence lands.
 * - article_missing allows only a knowledge_append to `files`, under the
 *   directory rule in appendJoinFault (change iv).
 * - knowledge_line_ref_fix is not keyed by this list: its own checks fix
 *   which fields it can touch, and it needs a reconcile_needed item that
 *   targets the record.
 */
export const WORKER_FIELD_ALLOW_LIST: Readonly<Record<WorkerPolicyLane, Readonly<Record<string, readonly string[]>>>> = {
  reconcile_needed: {
    feature_article: ['files', 'history', 'live_test_refs', 'what_it_does', 'intended_behavior'],
    reference_material: ['summary', 'source_date', 'capture_date'],
  },
  state_review: {
    feature_article: ['state', 'state_reason', 'files', 'history'],
  },
  stale_research: {
    research_finding: ['source_date', 'capture_date', 'answer'],
  },
  refresh_reference: {
    reference_material: ['summary', 'source_date', 'capture_date'],
  },
  article_missing: {
    feature_article: ['files'],
  },
};

/** Tools that never write the store; worker mode leaves them alone. */
export const WORKER_READ_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_query',
  'knowledge_get',
  'knowledge_render',
  'knowledge_schema',
  'knowledge_stats',
  'knowledge_preflight',
  'board_query',
  'board_get',
  'maintenance_query',
]);

/** A refusal names the rule and the policy items it was judged against, so
 *  the worker can hand the item off with a reason. */
export class WorkerPolicyRefusal extends Error {
  constructor(
    readonly tool: string,
    readonly rule: string,
    detail: string,
    readonly itemIds: readonly string[] = []
  ) {
    super(
      `worker policy refused ${tool}: rule '${rule}' — ${detail}. Policy item(s): ${itemIds.length ? itemIds.join(', ') : 'none'}. Nothing was written.`
    );
    this.name = 'WorkerPolicyRefusal';
  }
}

type RecordView = Pick<MountedStores, 'projectStoreHolds' | 'get'>;

/** The root field a knowledge_edit field, append field or array_remove
 *  selector names: `files[path=x].role` -> `files`. */
const rootField = (field: string): string => field.split(/[.[]/)[0];

/** Record-targeted writes the field allow-list governs. */
type Fault = { rule: 'field_not_allowed' | 'append_join'; text: string };

const FIELD_WRITES = new Set(['knowledge_update', 'knowledge_edit', 'knowledge_append', 'knowledge_array_remove']);

export class WorkerGuard {
  constructor(
    private readonly args: WorkerPolicyArgs,
    private readonly records: RecordView
  ) {}

  /** The policy as it stands now, or a refusal naming why there is none. */
  private load(tool: string): WorkerPolicy {
    let raw: string;
    try {
      raw = readFileSync(this.args.path, 'utf8');
    } catch (e) {
      throw new WorkerPolicyRefusal(tool, 'policy_unreadable', `the policy file ${this.args.path} could not be read (${(e as Error).message})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new WorkerPolicyRefusal(tool, 'policy_unreadable', `the policy file ${this.args.path} is not JSON (${(e as Error).message})`);
    }
    const parsed = workerPolicySchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new WorkerPolicyRefusal(tool, 'policy_schema', `the policy file ${this.args.path} fails the worker policy schema (${issues})`);
    }
    if (parsed.data.token !== this.args.token) {
      throw new WorkerPolicyRefusal(tool, 'policy_token_mismatch', `the policy file's token is not this run's --worker-token, so it belongs to another run`);
    }
    return parsed.data;
  }

  /**
   * Decide one tool call before it runs. Returns null for a read tool, the
   * authorized item for an allowed write, and throws WorkerPolicyRefusal
   * otherwise.
   *
   * Which item a write is judged against:
   * - A write with `resolves` names exactly one policy item and is judged
   *   against that item's lane only, so an edit one lane allows can never
   *   close an item of another lane on the same record. The record must be
   *   the item's target_id; an article_missing item has none (H10 mints it
   *   with no feature_link), so its join may name any record, and the lane
   *   rules below decide whether that record can take the join.
   * - A write without `resolves` closes nothing. It is allowed when at least
   *   one policy item targets the record and that item's lane allows it; the
   *   stamp names the first such item in policy order.
   * - knowledge_line_ref_fix belongs to reconcile_needed items only.
   */
  authorize(tool: string, input: Record<string, unknown>): Authorized | null {
    if (WORKER_READ_TOOLS.has(tool)) return null;
    const policy = this.load(tool);
    const items = policy.policy_items;
    const stamp = (item: WorkerPolicyItem, closes: string[]): Authorized => ({ run_id: policy.run_id, item_id: item.id, closes });

    if (tool === 'maintenance_remove') {
      const id = String(input.id);
      const item = items.find((i) => i.id === id);
      if (!item) throw new WorkerPolicyRefusal(tool, 'item_not_in_batch', `item '${id}' is not one of this run's policy items`);
      return stamp(item, [id]);
    }

    if (tool !== 'knowledge_line_ref_fix' && !FIELD_WRITES.has(tool)) {
      throw new WorkerPolicyRefusal(tool, 'tool_not_allowed_in_worker_mode', `the worker writes only factual refreshes, and ${tool} is not one of them`);
    }

    const id = String(input.id);
    const resolves = Array.isArray(input.resolves) ? (input.resolves as unknown[]).map(String) : [];
    const outside = resolves.filter((r) => !items.some((i) => i.id === r));
    if (outside.length) {
      const targeting = items.filter((i) => i.target_id === id).map((i) => i.id);
      throw new WorkerPolicyRefusal(tool, 'resolves_outside_batch', `resolves names ${outside.join(', ')}, which ${outside.length === 1 ? 'is not a policy item' : 'are not policy items'}`, targeting);
    }
    if (resolves.length > 1) {
      throw new WorkerPolicyRefusal(tool, 'resolves_one_item', `a worker write closes one policy item and is judged by that item's lane, but resolves names ${resolves.length}`, resolves);
    }
    let candidates: WorkerPolicyItem[];
    if (resolves.length === 1) {
      const item = items.find((i) => i.id === resolves[0]) as WorkerPolicyItem;
      if (item.target_id === null ? item.lane !== 'article_missing' : item.target_id !== id) {
        throw new WorkerPolicyRefusal(tool, 'target_not_in_batch', `resolves names ${item.id}, whose target is ${item.target_id ?? 'not set'}, not record '${id}'`, [item.id]);
      }
      candidates = [item];
    } else {
      candidates = items.filter((i) => i.target_id !== null && i.target_id === id);
      if (!candidates.length) {
        throw new WorkerPolicyRefusal(
          tool,
          'target_not_in_batch',
          `record '${id}' is not the target_id of any policy item (worker mode needs the exact full uuid; an article_missing join names its item in resolves)`
        );
      }
    }
    if (tool === 'knowledge_line_ref_fix') {
      const reconcile = candidates.filter((i) => i.lane === 'reconcile_needed');
      if (!reconcile.length) {
        throw new WorkerPolicyRefusal(tool, 'line_ref_fix_lane', `a line-reference fix belongs to a reconcile_needed item, and ${candidates.map((i) => `${i.id} is ${i.lane}`).join(', ')}`, candidates.map((i) => i.id));
      }
      candidates = reconcile;
    }
    const candidateIds = candidates.map((i) => i.id);
    // Physical holder, never the body's `scope` (anti_pattern
    // record-body-scope-is-not-physical-store-identity).
    if (!this.records.projectStoreHolds(id)) {
      throw new WorkerPolicyRefusal(tool, 'target_not_project_held', `record '${id}' is not held by the project store`, candidateIds);
    }
    const ordered = candidates;

    if (tool === 'knowledge_line_ref_fix') return stamp(ordered[0], resolves);

    if (tool === 'knowledge_update' && input.expected_version === undefined) {
      throw new WorkerPolicyRefusal(tool, 'expected_version_required', 'a worker update states the version it read (decision change v)', candidateIds);
    }
    const record = this.records.get(id) as unknown as { type: string; files?: { path: string }[] } | undefined;
    if (!record) throw new WorkerPolicyRefusal(tool, 'target_not_project_held', `record '${id}' was not found`, candidateIds);

    const fields =
      tool === 'knowledge_update'
        ? Object.keys((input.body ?? {}) as Record<string, unknown>)
        : [rootField(String(tool === 'knowledge_array_remove' ? input.selector : input.field))];
    const faults: Fault[] = [];
    for (const item of ordered) {
      const fault = this.laneFault(tool, item, record, fields, input);
      if (fault === null) return stamp(item, resolves);
      faults.push({ rule: fault.rule, text: `${item.id} (${item.lane}): ${fault.text}` });
    }
    const rule = faults.every((f) => f.rule === 'append_join') ? 'append_join' : 'field_not_allowed';
    throw new WorkerPolicyRefusal(tool, rule, faults.map((f) => f.text).join('; '), candidateIds);
  }

  /** The ids among `closes` the store no longer holds: the items this call
   *  actually closed, read after it ran. */
  closed(closes: string[]): string[] {
    return closes.filter((id) => this.records.get(id) === undefined);
  }

  /** Why this item does not allow the write, or null when it does. */
  private laneFault(
    tool: string,
    item: WorkerPolicyItem,
    record: { type: string; files?: { path: string }[] },
    fields: string[],
    input: Record<string, unknown>
  ): Fault | null {
    const allowed = WORKER_FIELD_ALLOW_LIST[item.lane][record.type];
    if (!allowed) return { rule: 'field_not_allowed', text: `lane ${item.lane} does not write a ${record.type}` };
    const disallowed = fields.filter((f) => !allowed.includes(f));
    if (disallowed.length) return { rule: 'field_not_allowed', text: `field(s) ${disallowed.join(', ')} not in lane ${item.lane}'s allow-list for ${record.type} (${allowed.join(', ')})` };
    if (item.lane === 'article_missing') return appendJoinFault(tool, item, record, input);
    return null;
  }
}

/** Change (iv): an article_missing join appends only the item's own paths,
 *  and only to an article that already owns a path in the same directory. */
function appendJoinFault(tool: string, item: WorkerPolicyItem, record: { files?: { path: string }[] }, input: Record<string, unknown>): Fault | null {
  const fault = (text: string): Fault => ({ rule: 'append_join', text });
  if (tool !== 'knowledge_append' || input.field !== 'files') return fault('an article_missing item allows only a knowledge_append to files');
  const itemKeys = new Set(item.file_keys.map((k) => normalizeRepoPath(k)));
  const ownedDirs = new Set((record.files ?? []).map((f) => posix.dirname(normalizeRepoPath(f.path))));
  const entries = Array.isArray(input.entries) ? (input.entries as unknown[]) : [];
  for (const entry of entries) {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof path !== 'string') return fault('every appended entry needs a path');
    const p = normalizeRepoPath(path);
    if (!itemKeys.has(p)) return fault(`appended path ${p} is not one of the item's file_keys`);
    if (!ownedDirs.has(posix.dirname(p))) return fault(`the article owns no path in ${posix.dirname(p)}/, so joining ${p} is not mechanical`);
  }
  return null;
}

/** Put the stamp on a tool result's JSON receipt. */
function stampReceipt(tool: string, result: unknown, stamp: WorkerStamp): unknown {
  const content = (result as { content?: { type: string; text: string }[] } | undefined)?.content;
  let receipt: unknown;
  try {
    receipt = content?.length === 1 && content[0].type === 'text' ? JSON.parse(content[0].text) : undefined;
  } catch {
    receipt = undefined;
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error(`${tool}: the write landed, but its result is not a JSON object receipt, so the worker stamp ${JSON.stringify(stamp)} could not be attached`);
  }
  return { ...(result as object), content: [{ type: 'text', text: JSON.stringify({ ...receipt, [WORKER_STAMP_KEY]: stamp }) }] };
}

/**
 * Route every tool registered on `server` from here on through the guard.
 * Called before the first registerTool, so no tool escapes it.
 */
export function guardWorkerTools(server: McpServer, guard: WorkerGuard): void {
  type Handler = (...a: unknown[]) => unknown;
  const register = server.registerTool.bind(server) as unknown as (name: string, config: unknown, cb: Handler) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, (...a: unknown[]) => {
      const allowed = guard.authorize(name, (a[0] ?? {}) as Record<string, unknown>);
      const result = cb(...a);
      if (!allowed) return result;
      const finish = (r: unknown) => stampReceipt(name, r, { run_id: allowed.run_id, item_id: allowed.item_id, resolved: guard.closed(allowed.closes) });
      return result instanceof Promise ? result.then(finish) : finish(result);
    });
}
