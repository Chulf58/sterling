// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { randomUUID } from 'node:crypto';
import { signalSchema, SIGNALS, SIGNAL_PAYLOADS, parseConfig, type DurableRecord, type RunRecord, type SterlingConfig } from '@sterling/schemas';
import type { QueryOptions, RecordedExit, SterlingStore } from '@sterling/store';
import { react, type BrainAction, type ResolvedExit } from './brain.js';

export interface SkippedCheck {
  check: string;
  reason: string;
}

export interface ToolDeps {
  store: SterlingStore;
  config?: SterlingConfig;
  now?: () => string;
  newId?: () => string;
}

const DAY_MS = 86_400_000;

export class SterlingTools {
  private store: SterlingStore;
  private config: SterlingConfig;
  private now: () => string;
  private newId: () => string;

  constructor(deps: ToolDeps) {
    this.store = deps.store;
    this.config = deps.config ?? parseConfig({});
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

  knowledgeCreate(
    type: string,
    fields: Record<string, unknown>
  ): { record: DurableRecord; check_skipped: SkippedCheck[]; merged_into?: string } {
    const ts = this.now();
    const candidate = {
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
    };
    const skipped: SkippedCheck[] = [];

    if (type === 'anti_pattern') {
      // dedup-merge (§3.2.2, mechanical): keyword/tag overlap against existing
      // records merges evidence into the existing record instead of duplicating.
      const match = this.findAntiPatternOverlap(candidate);
      if (match) {
        skipped.push(this.skip('noise-gate', this.activeRunId()));
        const merged = this.knowledgeUpdate(match.id, {
          source_evidence: `${(match as { source_evidence: string }).source_evidence}\n${String(fields.source_evidence ?? '')}`,
        });
        return { record: merged, check_skipped: skipped, merged_into: match.id };
      }
      skipped.push(this.skip('noise-gate', this.activeRunId()));
    } else {
      // evidence-merging is defined for anti_patterns; other types skip loudly
      skipped.push(this.skip('dedup-merge', this.activeRunId()));
    }

    const record = this.store.create(candidate);
    if (type === 'note') skipped.push(this.skip('note-structuring-h11', this.activeRunId()));
    return { record, check_skipped: skipped };
  }

  private findAntiPatternOverlap(candidate: Record<string, unknown>): DurableRecord | undefined {
    const existing = this.store.query({ types: ['anti_pattern'], cap: 1000 });
    const candKeys = new Set(((candidate.file_keys as string[]) ?? []).map((p) => p.replace(/\\/g, '/')));
    const tokens = (r: Record<string, unknown>) =>
      new Set(
        `${r.title ?? ''} ${r.trigger ?? ''}`
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3)
      );
    const candTokens = tokens(candidate);
    return existing.find((e) => {
      const rec = e as unknown as Record<string, unknown>;
      const keyOverlap = ((rec.file_keys as string[]) ?? []).some((k) => candKeys.has(k));
      let shared = 0;
      for (const t of tokens(rec)) if (candTokens.has(t)) shared++;
      return keyOverlap || shared >= 2;
    });
  }

  /**
   * Retrieval (§3.4): records pass through with lazy stale-at-read
   * annotations — research findings get both clocks + a staleness flag;
   * platform/external-basis records past threshold get verify_before_use.
   * Annotations are computed at read, never persisted (P4: no sweeps).
   */
  knowledgeQuery(opts: QueryOptions): (DurableRecord & { staleness?: object; verify_before_use?: boolean })[] {
    const nowMs = Date.parse(this.now());
    const ageDays = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / DAY_MS);
    return this.store.query(opts).map((record) => {
      if (record.type === 'research_finding') {
        const r = record as unknown as { source_date: string; capture_date: string; volatility_hint?: 'fast' | 'medium' | 'stable'; status: string };
        const threshold = this.config.staleness.research_days[r.volatility_hint ?? 'medium'];
        const sourceAge = ageDays(r.source_date);
        const stale = r.status === 'flagged_stale' || sourceAge > threshold;
        return {
          ...record,
          staleness: {
            source_age_days: sourceAge,
            capture_age_days: ageDays(r.capture_date),
            threshold_days: threshold,
            stale,
            ...(stale ? { note: 'stale — re-verify before use; re-verification supersedes this finding' } : {}),
          },
        };
      }
      const basis = (record as unknown as { basis?: string }).basis;
      if ((basis === 'platform' || basis === 'external') && ageDays(record.updated_at) > this.config.staleness.platform_external_days) {
        return { ...record, verify_before_use: true };
      }
      return record;
    });
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
    const parsed = signalSchema.safeParse(args.signal);
    if (!parsed.success) {
      throw new Error(
        `agent_exit: '${args.signal}' is not a registered signal — the enum is closed: ${SIGNALS.join(' | ')}. Re-call agent_exit with a valid member.`
      );
    }
    if (parsed.data === 'agent-died') {
      throw new Error(
        "agent_exit: 'agent-died' is conductor-reported, never agent-emitted (§5.1) — the conductor maps abnormal Task returns via run_signal's exit parameter."
      );
    }
    const payloadCheck = SIGNAL_PAYLOADS[parsed.data].safeParse(args.payload ?? {});
    if (!payloadCheck.success) {
      throw new Error(
        `agent_exit: payload for '${parsed.data}' does not match its typed schema (§5.1): ${payloadCheck.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}. Correct the payload and re-call agent_exit.`
      );
    }
    const run = this.runState(args.run_id);
    const exit: RecordedExit = {
      signal: parsed.data,
      payload: payloadCheck.data as Record<string, unknown>,
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
   *
   * Exit routing (§5.2, run-proven r-0001): ABNORMAL exits arrive here
   * immediately from any position. Normal `complete` is PHASE-SCOPED — a
   * non-terminal step's complete (e.g. the test-writer's) is consumed by the
   * conductor as the next §8.1 step (scripts/consume-exit.mjs: recorded on
   * the run record via same-state CAS, clearing the pending-exit slot, audit
   * trail intact); run_signal receives `complete` only at the phase boundary,
   * where the brain advances the phase or starts the completion sequence.
   */
  runSignal(args: { run_id?: string; exit?: ResolvedExit } = {}): { action: BrainAction; machine_state: string; run_id: string } {
    const run = this.runState(args.run_id);
    const exit: ResolvedExit | undefined = args.exit ?? this.store.getPendingExit(run.id);
    if (!exit) {
      throw new Error(
        `run_signal: no exit recorded for run '${run.id}' — if the Task returned without an exit, report {signal: 'agent-died', payload: {observed: 'empty_output'}} (§5.2)`
      );
    }
    const { action, nextState } = react(run, exit, {
      phase_death_cap: this.config.caps.phase_death_cap,
      research_resume_per_phase: this.config.caps.research_resume_per_phase,
    });
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

  /** knowledge_link (§10): typed graph edge. */
  knowledgeLink(from: string, rel: string, to: string): DurableRecord {
    return this.store.addLink(from, rel, to);
  }

  /** run_escalate (§10): surface a judgment branch / typed escalation onto the run record. */
  runEscalate(payload: Record<string, unknown>): { run_id: string; escalations: number } {
    const run = this.runState();
    this.store.appendRunEscalation(run.id, { kind: 'escalation', payload, at: this.now() });
    const after = this.runState(run.id);
    return { run_id: run.id, escalations: after.escalations.length };
  }

  /**
   * maintenance_enqueue / maintenance_query (§10): the maintenance queue IS
   * the todo store filtered source=system (§3.2.7) — no second queue exists.
   */
  maintenanceEnqueue(args: { reason: string; text: string; file_keys?: string[]; feature_link?: string }): {
    record: DurableRecord;
    check_skipped: SkippedCheck[];
  } {
    return this.boardAdd({
      text: args.text,
      source: 'system',
      system_reason: args.reason,
      file_keys: args.file_keys,
      feature_link: args.feature_link,
    });
  }

  maintenanceQuery(filter: { system_reason?: string; file_keys?: string[]; cap?: number } = {}): DurableRecord[] {
    const items = this.boardQuery({ source: 'system', file_keys: filter.file_keys, cap: filter.cap });
    return filter.system_reason ? items.filter((t) => (t as { system_reason?: string }).system_reason === filter.system_reason) : items;
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
