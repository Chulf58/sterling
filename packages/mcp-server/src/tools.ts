// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRepoPath, signalSchema, SIGNALS, SIGNAL_PAYLOADS, parseConfig, RECORD_TYPES, REVIEWER_ROLES, handoffSchema, type DurableRecord, type RunRecord, type SterlingConfig } from '@sterling/schemas';
import type { QueryOptions, RecordedExit, ToolStore } from '@sterling/store';
import { react, type BrainAction, type ResolvedExit } from './brain.js';

export interface SkippedCheck {
  check: string;
  reason: string;
}

export interface ToolDeps {
  store: ToolStore;
  config?: SterlingConfig;
  now?: () => string;
  newId?: () => string;
  /** project root for §3.2.5 repo-located doc mtime checks; absent → check inert */
  repoRoot?: string;
  /** note-structuring dispatch override (tests); default detach-spawns the bundled worker */
  noteExtraction?: (payload: NoteExtractionPayload) => NoteExtractionDispatch;
}

/**
 * stdin payload for the bundled note-structuring worker
 * (hooks/h11-note-structure.mjs) — mirrors the PostToolUse hook input shape the
 * script was built against, so the worker runs unchanged now that the server,
 * not the platform, spawns it (PostToolUse never fires on MCP tool calls —
 * research_finding 5e7d0a78, board ccb14030).
 */
export interface NoteExtractionPayload {
  cwd: string;
  tool_input: { type: 'note'; fields: Record<string, unknown> };
  tool_response: { content: { type: 'text'; text: string }[] };
}

export interface NoteExtractionDispatch {
  dispatched: boolean;
  reason?: string;
}

// The bundled worker ships with the plugin; resolve it relative to this module
// (dist/tools.js → repo root is three levels up) so the path holds wherever the
// server runs — self-hosted or launched from a consuming project.
const NOTE_WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'h11-note-structure.mjs');

function spawnNoteExtraction(payload: NoteExtractionPayload): NoteExtractionDispatch {
  if (!existsSync(NOTE_WORKER)) return { dispatched: false, reason: 'worker_script_missing' };
  const child = spawn(process.execPath, [NOTE_WORKER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  // A dead child must not crash the server: 'error' fires async on both the
  // process and its stdin pipe. Nothing to record from here — the worker owns
  // its own check_skipped once running, and pre-exec failures are covered by
  // the existsSync guard (process.execPath is the running node, always valid).
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  child.unref();
  return { dispatched: true };
}

const DAY_MS = 86_400_000;

export class SterlingTools {
  private store: ToolStore;
  private config: SterlingConfig;
  private now: () => string;
  private newId: () => string;
  private repoRoot?: string;
  private noteExtraction: (payload: NoteExtractionPayload) => NoteExtractionDispatch;

  constructor(deps: ToolDeps) {
    this.store = deps.store;
    this.config = deps.config ?? parseConfig({});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? randomUUID;
    this.repoRoot = deps.repoRoot;
    this.noteExtraction = deps.noteExtraction ?? spawnNoteExtraction;
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

  /**
   * §3.2.3/§3.2.5 drift baseline: sha256 of each owned file currently on disk,
   * keyed by the registry's file-key extractor (feature_article files[].path;
   * reference_material kind:doc location). Computed at create/reconcile so the
   * read-time drift check can distinguish a real content change from a mere
   * mtime reset (a git merge/checkout touches every file's mtime without
   * changing content). No repoRoot, or a file absent at write time, → no entry
   * (the read-time deletion check still covers a vanished owned file).
   */
  private computeBaselines(record: Record<string, unknown>): Record<string, string> | undefined {
    if (!this.repoRoot) return undefined;
    const type = record.type as string;
    if (type !== 'feature_article' && type !== 'reference_material') return undefined;
    const baselines: Record<string, string> = {};
    for (const rel of RECORD_TYPES[type].fileKeys(record)) {
      const hash = this.hashFile(rel);
      if (hash !== undefined) baselines[rel] = hash;
    }
    return Object.keys(baselines).length ? baselines : undefined;
  }

  /** sha256 of a repo-relative file's bytes, or undefined if it cannot be read. */
  private hashFile(rel: string): string | undefined {
    if (!this.repoRoot) return undefined;
    try {
      return createHash('sha256').update(readFileSync(join(this.repoRoot, rel))).digest('hex');
    } catch {
      return undefined;
    }
  }

  /**
   * Has the file at `rel` actually changed since its recorded baseline? mtime
   * has already said "maybe" (the cheap pre-filter); this is the authoritative
   * content check that suppresses the false positives a git merge/checkout
   * produces by resetting mtimes without changing content. No baseline for the
   * file (a record written before this wire, or a file absent at write time) →
   * returns FALSE: mtime alone is a proven-unreliable signal, so the check
   * ABSTAINS rather than raise a flag it cannot stand behind. The baseline is
   * established on the next create/reconcile; H7 covers every governed edit
   * meanwhile. An unreadable file also abstains (no fabricated flag).
   */
  private contentChanged(rel: string, baselines: Record<string, string> | undefined): boolean {
    const baseline = baselines?.[rel];
    if (baseline === undefined) return false;
    const current = this.hashFile(rel);
    if (current === undefined) return false;
    return current !== baseline;
  }

  // -- knowledge CRUD ---------------------------------------------------------

  knowledgeCreate(type: string, fields: Record<string, unknown>): { record: DurableRecord; check_skipped: SkippedCheck[] } {
    const ts = this.now();
    const candidate: Record<string, unknown> = {
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
    // dedup_override is a create-time directive, never a stored field
    const dedupOverride = candidate.dedup_override === true;
    delete candidate.dedup_override;
    // record the owned-file content baseline at birth (server-computed, never
    // author-supplied) so the read-time drift check is content-aware (§3.2.3)
    if (type === 'feature_article' || type === 'reference_material') {
      candidate.file_baselines = this.computeBaselines(candidate);
    }
    // validate BEFORE any dedup logic: a schema-invalid candidate gets the
    // schema error, never a dedup refusal (board 3f9591e9 defect 3); unknown
    // types fall through to store.create for its canonical rejection
    const registered = RECORD_TYPES[type as keyof typeof RECORD_TYPES];
    if (registered) registered.schema.parse(candidate);
    const skipped: SkippedCheck[] = [];

    if (type === 'anti_pattern') {
      // dedup guard (§3.2.2): an overlapping anti_pattern is REFUSED LOUD, never
      // silently merged — a wrong merge costs the whole lesson (2026-07-04: a
      // distinct lesson was swallowed on one shared file_key, board 3f9591e9);
      // a refusal costs one round-trip. The author decides: same finding →
      // knowledge_update the match (append source_evidence); distinct lesson →
      // re-submit with dedup_override: true.
      if (!dedupOverride) {
        const match = this.findAntiPatternOverlap(candidate);
        if (match) {
          throw new Error(
            `knowledge_create: this anti_pattern overlaps existing '${match.id}' — "${(match as { title?: string }).title ?? ''}". ` +
              `Same finding: knowledge_update that record, appending your source_evidence. Distinct lesson: re-submit with dedup_override: true.`
          );
        }
      }
      skipped.push(this.skip('noise-gate', this.activeRunId()));
    } else {
      // dedup guarding is defined for anti_patterns; other types skip loudly
      skipped.push(this.skip('dedup-merge', this.activeRunId()));
    }

    const record = this.store.create(candidate);
    if (type === 'note') {
      const failed = this.dispatchNoteStructuring(record, fields);
      if (failed) skipped.push(failed);
    }
    this.surfacePromotionCandidate(record, type);
    return { record, check_skipped: skipped };
  }

  /**
   * §3.2.6 note structuring, dispatched from the server: PostToolUse hooks
   * never fire on MCP tool calls (verified on CC 2.1.198 — research_finding
   * 5e7d0a78, board ccb14030), so knowledge_create itself detach-spawns the
   * bundled worker — the one seam that provably runs on every note capture.
   * Fire-and-forget: the worker opens the store at cwd and records its own
   * check_skipped on every failure path; only a dispatch that never starts is
   * recorded here (loud, P5).
   */
  private dispatchNoteStructuring(record: DurableRecord, fields: Record<string, unknown>): SkippedCheck | undefined {
    const dispatch = this.repoRoot
      ? this.noteExtraction({
          cwd: this.repoRoot,
          tool_input: { type: 'note', fields },
          tool_response: { content: [{ type: 'text', text: JSON.stringify({ record }) }] },
        })
      : { dispatched: false, reason: 'no_repo_root' };
    if (dispatch.dispatched) return undefined;
    const reason = dispatch.reason ?? 'dispatch_failed';
    this.store.recordCheckSkipped('note-structuring-h11', reason, this.activeRunId(), this.now());
    return { check: 'note-structuring-h11', reason };
  }

  /**
   * §3.3 project-store-then-promote: reference/research records are
   * domain-candidates by default. One born project-scoped, when the project has
   * a domain mounted to promote into, surfaces a single promotion_review
   * maintenance item — the human decides at the queue drain, never an automatic
   * move. No domain mounted → nowhere to promote → nothing surfaced (so a
   * domain-less project sees no promotion noise). A record the conductor already
   * scoped to a domain at creation is not a candidate.
   */
  private surfacePromotionCandidate(record: DurableRecord, type: string): void {
    if (type !== 'reference_material' && type !== 'research_finding') return;
    if (record.scope !== 'project' || this.config.stack_tags.length === 0) return;
    const label = (record as { title?: string; question?: string }).title ?? (record as { question?: string }).question ?? type;
    this.maintenanceEnqueue({
      reason: 'promotion_review',
      text: `review '${label}' for promotion to a domain store — project-scoped ${type}, a domain-candidate by default (§3.3)`,
      file_keys: (record as { file_keys?: string[] }).file_keys,
      feature_link: record.id,
    });
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
    // Dice coefficient over the significant-token sets (2·|A∩B| / (|A|+|B|)):
    // flag only on STRONG overlap — a genuine restatement of the same
    // anti-pattern — not on a couple of shared domain words. The prior
    // `shared >= 2` absolute gate collapsed distinct same-domain gotchas: any
    // two "Genesys Cloud …" titles share genesys+cloud, any two Power Automate
    // gotchas share power+automate. file_key overlap is an ASSIST, not a hard
    // signal — a busy multi-concern file (e.g. agent-distribution.mjs) hosts
    // many distinct lessons (board 3f9591e9, 2026-07-04); a shared key only
    // lowers the token bar for records that already sound alike.
    const DICE_OVERLAP_THRESHOLD = 0.5;
    const DICE_KEY_ASSISTED_THRESHOLD = 0.3;
    return existing.find((e) => {
      const rec = e as unknown as Record<string, unknown>;
      const recTokens = tokens(rec);
      const denom = candTokens.size + recTokens.size;
      if (denom === 0) return false;
      let shared = 0;
      for (const t of recTokens) if (candTokens.has(t)) shared++;
      const dice = (2 * shared) / denom;
      const keyOverlap = ((rec.file_keys as string[]) ?? []).some((k) => candKeys.has(k));
      return dice >= DICE_OVERLAP_THRESHOLD || (keyOverlap && dice >= DICE_KEY_ASSISTED_THRESHOLD);
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
      // §3.2.5: repo-located docs — out-of-band edits caught at read time.
      // File mtime newer than source_date → verify_before_use + ONE deduplicated
      // refresh_reference maintenance item (a hundred stale reads, one queue entry).
      if (record.type === 'reference_material' && (record as unknown as { kind: string }).kind === 'doc' && this.repoRoot) {
        const r = record as unknown as { id: string; title: string; location: string; source_date: string; file_baselines?: Record<string, string> };
        let rel: string | undefined;
        try {
          rel = normalizeRepoPath(r.location);
        } catch {
          rel = undefined; // absolute/escaping location: not repo-located
        }
        if (rel) {
          const stat = statSync(join(this.repoRoot, rel), { throwIfNoEntry: false });
          // mtime > source_date is the cheap pre-filter; confirm a real content
          // change against the baseline before flagging (an mtime-only bump from
          // a merge is not an out-of-band edit). No baseline → abstain.
          if (stat && stat.mtimeMs > Date.parse(r.source_date) && this.contentChanged(rel, r.file_baselines)) {
            const open = this.maintenanceQuery({ system_reason: 'refresh_reference', file_keys: [rel], cap: 1000 });
            if (open.length === 0) {
              this.maintenanceEnqueue({
                reason: 'refresh_reference',
                text: `refresh reference '${r.title}' — ${rel} changed on disk after source_date (out-of-band edit); refresh summary + source_date`,
                file_keys: [rel],
                feature_link: r.id,
              });
            }
            return { ...record, verify_before_use: true };
          }
        }
      }
      // §3.2.3: feature-article drift caught at read — H7 covers governed
      // touches; this catches out-of-band edits. Any owned file newer than the
      // article's updated_at, or missing from disk (deletion is drift), flags
      // the article and enqueues ONE reconcile_needed item (same feature_link
      // dedup as H7 — one drain surface regardless of trigger).
      if (record.type === 'feature_article' && this.repoRoot) {
        const a = record as unknown as { id: string; slug: string; files?: { path: string }[]; file_baselines?: Record<string, string> };
        let drift: { path: string; missing: boolean } | undefined;
        for (const f of a.files ?? []) {
          const stat = statSync(join(this.repoRoot, f.path), { throwIfNoEntry: false });
          if (!stat) {
            drift = { path: f.path, missing: true };
            break;
          }
          // mtime newer than updated_at is the cheap pre-filter; confirm a real
          // content change against the baseline before flagging, so a git
          // merge/checkout's mtime reset is not mistaken for an out-of-band edit.
          if (stat.mtimeMs > Date.parse(record.updated_at) && this.contentChanged(f.path, a.file_baselines)) {
            drift = { path: f.path, missing: false };
            break;
          }
        }
        if (drift) {
          const open = this.maintenanceQuery({ system_reason: 'reconcile_needed', cap: 1000 }).some(
            (t) => (t as { feature_link?: string }).feature_link === a.id
          );
          if (!open) {
            this.maintenanceEnqueue({
              reason: 'reconcile_needed',
              text: drift.missing
                ? `reconcile article '${a.slug}' — owned file ${drift.path} no longer exists (out-of-band deletion)`
                : `reconcile article '${a.slug}' — owned file ${drift.path} changed on disk after the article's last update (out-of-band edit)`,
              file_keys: [drift.path],
              feature_link: a.id,
            });
          }
          return { ...record, verify_before_use: true };
        }
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
    // re-baseline on every reconcile: the new version's owned-file hashes become
    // the truth the next read-time drift check compares against, so reconciling
    // an article both clears its current flag and immunizes it against the next
    // merge's mtime reset (§3.2.3). Overwrites any stale baseline carried from old.
    if (next.type === 'feature_article' || next.type === 'reference_material') {
      next.file_baselines = this.computeBaselines(next);
    }
    const updated = this.store.supersede(id, next);
    // P4 lifecycle-bind: reconciling an article/doc IS the fulfilling artifact for
    // any DRIFT-driven maintenance item about it. Re-baselining (above) already
    // self-clears the read-time drift flag; this drains the standing queue item in
    // the SAME event so it can never orphan — closing the gap where an item
    // outlived the reconcile that should have closed it because board_remove was a
    // separate, forgotten step (observed 2026-06-27: two already-reconciled
    // reconcile_needed items left in the queue). Scoped to the two drift reasons H7
    // and the read-time check raise (reconcile_needed + refresh_reference, both
    // keyed by feature_link); NEVER promotion_review — promotion stays a human gate
    // (P1). The item's feature_link points to whatever version was current when it
    // was raised, which may now be an ancestor, so match the whole supersede chain.
    if (next.type === 'feature_article' || next.type === 'reference_material') {
      const chain = new Set<string>([id]);
      for (const link of (old.links ?? []) as { rel: string; target_id: string }[]) {
        if (link.rel === 'supersedes') chain.add(link.target_id);
      }
      for (const item of this.maintenanceQuery({ cap: 1000 })) {
        const it = item as { id: string; feature_link?: string; system_reason?: string };
        if (
          (it.system_reason === 'reconcile_needed' || it.system_reason === 'refresh_reference') &&
          it.feature_link !== undefined &&
          chain.has(it.feature_link)
        ) {
          this.store.remove(it.id, ts);
        }
      }
    }
    return updated;
  }

  /**
   * knowledge_promote (§3.3 project→domain promotion EXECUTION): move a
   * project-scoped learning into a mounted domain store so it is shared by every
   * project that mounts that domain. Copies the record into the domain store (new
   * id, scope domain:<name>, content + clocks + author preserved, an informed_by
   * link back to the origin) and retires the project original as a superseded
   * tombstone pointing at the promoted copy — provenance and inbound links
   * survive. Promoting IS the review outcome, so a matching promotion_review is
   * drained (done = removed). feature_article is always project (§3.3); todo/note
   * are project/user surfaces — none promote. An unmounted target domain is
   * rejected loudly by the store routing before anything is written.
   */
  knowledgePromote(id: string, domain: string): { promoted: DurableRecord; retired: string; drained_review: string | null } {
    const original = this.store.get(id);
    if (!original) throw new Error(`knowledge_promote: no record '${id}'`);
    if (original.status !== 'active') throw new Error(`knowledge_promote: record '${id}' is not active (status ${original.status})`);
    if (original.scope !== 'project') throw new Error(`knowledge_promote: record '${id}' is ${original.scope} — only project-scoped records promote`);
    const UNPROMOTABLE = ['feature_article', 'todo', 'note'];
    if (UNPROMOTABLE.includes(original.type)) {
      throw new Error(`knowledge_promote: ${original.type} never promotes — feature_article is always project (§3.3); todo/note are project/user surfaces`);
    }
    const ts = this.now();
    // copy content; the envelope (id/clocks/status/scope/links) is rebuilt for the domain
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l, ...content } = original as unknown as Record<string, unknown>;
    const promoted = this.store.create({
      ...content,
      id: this.newId(),
      created_at: ts,
      updated_at: ts,
      status: 'active',
      superseded_by: null,
      scope: `domain:${domain}`,
      links: [{ rel: 'informed_by', target_id: id }],
    });
    // tombstone the project original, pointing forward to the promoted copy
    this.store.retireInFavorOf(id, promoted.id, ts);
    const review = this.maintenanceQuery({ system_reason: 'promotion_review', cap: 1000 }).find(
      (t) => (t as { feature_link?: string }).feature_link === id
    );
    if (review) this.store.remove(review.id, ts);
    return { promoted, retired: id, drained_review: review?.id ?? null };
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
    this.store.remove(id, this.now()); // system todos land in the §3.2.7 drain log
    return { removed: id, check_skipped: skipped };
  }

  /**
   * note_remove — the user-surface mirror of board_remove (§3.2.6, adjudicated
   * 2026-06-12): notes are the user's capture surface; a misfiled or spent note
   * leaves outright. Hard removal like todos (P4); raw-text immutability governs
   * edits, not deletion. Inbound cites/derived extractions survive as
   * independent records, exactly as fulfills-links survive board_remove.
   */
  noteRemove(id: string): { removed: string } {
    const record = this.store.get(id);
    if (!record) throw new Error(`note_remove: no record '${id}'`);
    if (record.type !== 'note') throw new Error(`note_remove: '${id}' is a ${record.type}, not a note`);
    this.store.remove(id);
    return { removed: id };
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
    // Phase validation at the RECORD seam (board 7d051522, incident 2026-07-03):
    // an exit naming a phase that is not on the run must fail HERE, loudly,
    // with nothing recorded — an orphan in the pending slot deadlocks the wire
    // (every later agent_exit refuses on the full slot and consume-exit cannot
    // resolve the phase). Conductor-direct subagents hit this when a run is
    // active: their deliverable is their final text, not a run exit.
    if (!run.phases.some((p) => p.id === args.phase_id)) {
      throw new Error(
        `agent_exit: no phase '${args.phase_id}' on run '${run.id}' — nothing was recorded. ` +
          `The run's phases: ${run.phases.map((p) => p.id).join(', ')}. A pipeline agent must exit against its dispatched phase; ` +
          `an agent working OUTSIDE the pipeline (conductor-direct) must not call agent_exit while a run is active — its final message is its deliverable.`
      );
    }
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
    // AC2: reviewer-role disposition coverage check (decision 628c4b7f, run r-d630, phase 2).
    // Placement mirrors the 32fa4a05 agent_exit off-run-phase guard: validate BEFORE persisting —
    // a refused write records NOTHING. Non-reviewer roles skip this check entirely.
    // The handoff is pre-parsed here for the guard only; schema validation still flows through
    // the store's writeHandoff (so malformed handoffs continue to surface as schema errors).
    const parsedForCheck = handoffSchema.safeParse(args.handoff);
    if (parsedForCheck.success && REVIEWER_ROLES.has(parsedForCheck.data.agent_role)) {
      const phaseId = parsedForCheck.data.phase_id;
      const mandatoryIds = new Set(
        (run.review_mandatory ?? []).filter((m) => m.phase_id === phaseId).map((m) => m.record_id)
      );
      const dispositionIds = new Set((parsedForCheck.data.dispositions ?? []).map((d) => d.record_id));
      const missing = [...mandatoryIds].filter((id) => !dispositionIds.has(id));
      const extra = [...dispositionIds].filter((id) => !mandatoryIds.has(id));
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing mandatory ids: ${missing.join(', ')}`);
        if (extra.length > 0) parts.push(`extra ids not in review_mandatory: ${extra.join(', ')}`);
        throw new Error(
          `handoff_write: reviewer '${parsedForCheck.data.agent_role}' disposition coverage mismatch — ${parts.join('; ')}. Nothing was written.`
        );
      }
    }
    const handoff = this.store.writeHandoff(run.id, args.handoff, this.now());
    return { written: true, phase_id: handoff.phase_id };
  }

  handoffRead(args: { run_id?: string; phase_id?: string; files?: string[] } = {}): unknown[] {
    const run = this.runState(args.run_id);
    return this.store.readHandoffs(run.id, { phase_id: args.phase_id, files: args.files });
  }
}
