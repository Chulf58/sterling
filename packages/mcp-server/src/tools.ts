// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { randomUUID } from 'node:crypto';
import { spineSignal, SPINE_SIGNALS, type DurableRecord, type RunRecord } from '@sterling/schemas';
import type { QueryOptions, RecordedExit, SterlingStore } from '@sterling/store';
import { react, type BrainAction, type ResolvedExit } from './brain.js';

export interface SkippedCheck {
  check: string;
  reason: string;
}

export interface ToolDeps {
  store: SterlingStore;
  now?: () => string;
  newId?: () => string;
}

export class SterlingTools {
  private store: SterlingStore;
  private now: () => string;
  private newId: () => string;

  constructor(deps: ToolDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? randomUUID;
  }

  /** §16.1.9: unbuilt checks emit check_skipped where they would have run — never silent success. */
  private skip(check: string, runId: string | undefined): SkippedCheck {
    const skipped = { check, reason: 'not_built' };
    this.store.recordCheckSkipped(check, skipped.reason, runId, this.now());
    return skipped;
  }

  private activeRunId(): string | undefined {
    return this.store.getRun()?.id;
  }

  // -- knowledge CRUD ---------------------------------------------------------

  knowledgeCreate(type: string, fields: Record<string, unknown>): { record: DurableRecord; check_skipped: SkippedCheck[] } {
    const ts = this.now();
    const record = this.store.create({
      id: this.newId(),
      type,
      created_at: ts,
      updated_at: ts,
      author: (fields.author as string) ?? 'conductor',
      status: 'active',
      superseded_by: null,
      links: fields.links ?? [],
      scope: (fields.scope as string) ?? 'project',
      stack_tags: fields.stack_tags ?? [],
      ...fields,
    });
    const skipped = [this.skip('dedup-merge', this.activeRunId())];
    if (type === 'anti_pattern') skipped.push(this.skip('noise-gate', this.activeRunId()));
    if (type === 'note') skipped.push(this.skip('note-structuring-h11', this.activeRunId()));
    return { record, check_skipped: skipped };
  }

  knowledgeQuery(opts: QueryOptions): DurableRecord[] {
    return this.store.query(opts);
  }

  knowledgeGet(id: string): DurableRecord {
    const record = this.store.get(id);
    if (!record) throw new Error(`knowledge_get: no record '${id}'`);
    return record;
  }

  /** Versioned change (§10): new version + supersede prior. Never mutates in place. */
  knowledgeUpdate(id: string, body: Record<string, unknown>): DurableRecord {
    const old = this.store.get(id);
    if (!old) throw new Error(`knowledge_update: no record '${id}'`);
    const ts = this.now();
    const { id: _i, status: _s, superseded_by: _sb, created_at: _c, updated_at: _u, type: _t, ...overrides } = body;
    const next: Record<string, unknown> = {
      ...old,
      ...overrides,
      id: this.newId(),
      type: old.type,
      created_at: ts,
      updated_at: ts,
      status: 'active',
      superseded_by: null,
    };
    if (old.type === 'feature_article' && body.version === undefined) {
      next.version = (old as { version: number }).version + 1;
    }
    return this.store.supersede(id, next);
  }

  // -- board (§3.2.7) ----------------------------------------------------------

  boardAdd(args: Record<string, unknown>): { record: DurableRecord; check_skipped: SkippedCheck[] } {
    const { text, source, ...rest } = args;
    return this.knowledgeCreate('todo', { text, source, ...rest });
  }

  boardQuery(filter: { source?: 'user' | 'system'; file_keys?: string[]; cap?: number } = {}): DurableRecord[] {
    const todos = this.store.query({ types: ['todo'], file_keys: filter.file_keys, cap: 1000 });
    const filtered = filter.source ? todos.filter((t) => (t as { source: string }).source === filter.source) : todos;
    return filtered.slice(0, filter.cap ?? 50);
  }

  /** P4: done = removed. The artifact-write binding (H9/H10) is not built yet — skipped loudly, never silently. */
  boardRemove(id: string): { removed: string; check_skipped: SkippedCheck[] } {
    const record = this.store.get(id);
    if (!record) throw new Error(`board_remove: no record '${id}'`);
    if (record.type !== 'todo') throw new Error(`board_remove: '${id}' is a ${record.type}, not a todo`);
    const skipped = [this.skip('board-remove-artifact-binding', this.activeRunId())];
    this.store.remove(id);
    return { removed: id, check_skipped: skipped };
  }

  // -- run protocol (§5.2, §10) -------------------------------------------------

  runState(runId?: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(runId ? `run_state: no run '${runId}'` : 'run_state: no active run');
    return run;
  }

  /**
   * agent_exit — the exit wire, never prose: zod-validated against the signal
   * registry at the server; invalid signals are rejected in-band so the agent
   * sees the error and corrects itself (§5.2).
   */
  agentExit(args: { run_id?: string; phase_id: string; agent_role: string; signal: string; payload?: Record<string, unknown> }): {
    recorded: RecordedExit;
  } {
    const parsed = spineSignal.safeParse(args.signal);
    if (!parsed.success) {
      throw new Error(
        `agent_exit: '${args.signal}' is not a registered signal — the enum is closed: ${SPINE_SIGNALS.join(' | ')}. Re-call agent_exit with a valid member.`
      );
    }
    const run = this.runState(args.run_id);
    const exit: RecordedExit = {
      signal: parsed.data,
      payload: args.payload,
      phase_id: args.phase_id,
      agent_role: args.agent_role,
      at: this.now(),
    };
    this.store.recordPendingExit(run.id, exit);
    return { recorded: exit };
  }

  /**
   * run_signal — the brain computes the reaction from the stored exit (or the
   * conductor-reported one, e.g. agent-died{empty_output}) and the transition
   * is applied as a CAS on machine_state. The conductor executes exactly the
   * returned action.
   */
  runSignal(args: { run_id?: string; exit?: ResolvedExit } = {}): { action: BrainAction; machine_state: string; run_id: string } {
    const run = this.runState(args.run_id);
    const exit: ResolvedExit | undefined = args.exit ?? this.store.getPendingExit(run.id);
    if (!exit) {
      throw new Error(
        `run_signal: no exit recorded for run '${run.id}' — if the Task returned without an exit, report {signal: 'agent-died', payload: {observed: 'empty_output'}} (§5.2)`
      );
    }
    const { action, nextState } = react(run, exit);
    const phases = run.phases.map((p) => ({ ...p, signals: [...p.signals] }));
    const idx = exit.phase_id ? phases.findIndex((p) => p.id === exit.phase_id) : phases.findIndex((p) => p.status === 'in_progress');
    if (idx !== -1) {
      phases[idx].signals.push({ signal: exit.signal, payload: exit.payload ?? null, agent_role: exit.agent_role ?? null, at: this.now() });
      if (action.action === 'complete_run') phases[idx].status = 'complete';
      if (action.action === 'spawn' && !('respawn' in action && action.respawn)) {
        phases[idx].status = 'complete';
        const nextIdx = phases.findIndex((p) => p.id === (action as { phase_id: string }).phase_id);
        if (nextIdx !== -1) phases[nextIdx].status = 'in_progress';
      }
    }
    const escalations = [...run.escalations];
    if (action.action === 'judgment_needed' || action.action === 'halt') {
      escalations.push({ kind: action.action, reason: (action as { reason: string }).reason, at: this.now() });
    }
    const next: RunRecord = { ...run, machine_state: nextState, phases, escalations };
    this.store.casTransition(run.machine_state, next);
    return { action, machine_state: nextState, run_id: run.id };
  }

  // -- handoff pair (§10): transient, never enters the durable store -------------

  handoffWrite(args: { run_id?: string; handoff: unknown }): { written: true; phase_id: string } {
    const run = this.runState(args.run_id);
    const handoff = this.store.writeHandoff(run.id, args.handoff, this.now());
    return { written: true, phase_id: handoff.phase_id };
  }

  handoffRead(args: { run_id?: string; phase_id?: string; files?: string[] } = {}): unknown[] {
    const run = this.runState(args.run_id);
    return this.store.readHandoffs(run.id, { phase_id: args.phase_id, files: args.files });
  }
}
