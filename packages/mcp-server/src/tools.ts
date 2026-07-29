// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRepoPath, signalSchema, SIGNALS, SIGNAL_PAYLOADS, parseConfig, RECORD_TYPES, REVIEWER_ROLES, handoffSchema, knownFieldsFor, unknownFieldsIn, type DurableRecord, type RunRecord, type SterlingConfig } from '@sterling/schemas';
import { DEFAULT_QUERY_CAP, type QueryOptions, type RecordedExit, type ToolStore } from '@sterling/store';
import { react, type BrainAction, type ResolvedExit } from './brain.js';

export interface SkippedCheck {
  check: string;
  reason: string;
}

export interface BoardFilter {
  source?: 'user' | 'system';
  system_reason?: string;
  file_keys?: string[];
  cap?: number;
}

/** board_query / maintenance_query's disclosed envelope (see boardQueryResult). */
export interface BoardQueryResult {
  /** items matching the filter — EXACT here, unlike knowledge_query's rank-blind count */
  matched_filter: number;
  returned: number;
  cap: number;
  /** exact: more matched than were returned */
  capped: boolean;
  note?: string;
  records: DurableRecord[];
}

/** knowledge_query's disclosed result envelope (see knowledgeQueryResult). */
export interface KnowledgeQueryResult {
  /** records matching the FILTER (types/stack_tags/file_keys), rank- and cap-blind */
  matched_filter: number;
  returned: number;
  /** the cap actually applied — the caller's, or DEFAULT_QUERY_CAP */
  cap: number;
  /** the cap was reached, so more may exist past it; false GUARANTEES nothing was dropped */
  capped: boolean;
  /** present only when the window is partial — states how to widen it */
  note?: string;
  records: Record<string, unknown>[];
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
 * not the platform, spawns it. That placement was originally forced by the
 * platform (PostToolUse did not fire on MCP tool calls on CC 2.1.198) but is now
 * a DECISION (5ef11bd4) — the constraint was disproven on CC 2.1.215, corrected
 * finding research_finding e7bd5c19, and the seam stays because it works and is
 * mode-independent.
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
  // windowsHide: a detached console child on Windows otherwise auto-allocates
  // a visible console window that steals focus on every note capture.
  const child = spawn(process.execPath, [NOTE_WORKER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
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

// Board/queue read defaults, named rather than inlined for the DEFAULT_QUERY_CAP
// reason (decision b47889b7): the tool layer now REPORTS the cap it applied, so
// the value has two readers and a literal would be a second place to drift.
const DEFAULT_BOARD_CAP = 50;
// The bounded todo scan the filter runs over. A full scan means the reported
// count is a floor; boardQueryResult says so rather than under-reporting.
const BOARD_SCAN_CAP = 1000;

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
    // Detached-working-tree resolution (comsoft-juiced 2026-07-17): a record
    // declaring working_tree hashes against ITS tree, never the project root —
    // the root's same-named files previously leaked into copy-article baselines.
    // Unmapped tree name → NO baselines (abstain; the read path flags loud).
    const { root, unresolved } = this.treeRootFor(record);
    if (unresolved || !root) return undefined;
    const baselines: Record<string, string> = {};
    for (const rel of RECORD_TYPES[type].fileKeys(record)) {
      const hash = this.hashFile(rel, root);
      if (hash !== undefined) baselines[rel] = hash;
    }
    return Object.keys(baselines).length ? baselines : undefined;
  }

  /**
   * Resolve the working tree a record's file paths live in: no working_tree →
   * the project root; a name mapped in config.working_trees → that path
   * (absolute, or joined to the project root); an UNMAPPED name → unresolved,
   * and every consumer abstains LOUD rather than resolving against the wrong
   * tree (the comsoft-juiced false-deletion class).
   */
  private treeRootFor(record: Record<string, unknown>): { root?: string; unresolved: boolean } {
    const name = (record as { working_tree?: string }).working_tree;
    if (!name) return { root: this.repoRoot, unresolved: false };
    const mapped = this.config.working_trees?.[name];
    if (!mapped) return { root: undefined, unresolved: true };
    if (isAbsolute(mapped)) return { root: mapped, unresolved: false };
    if (!this.repoRoot) return { root: undefined, unresolved: true };
    return { root: join(this.repoRoot, mapped), unresolved: false };
  }

  /**
   * Is `rel` registered as a generated projection (config.generated_projections)?
   * A generated file changes on every regen by design, so the drift check's
   * CONTENT-change arm skips it — its currency is guarded by
   * check-projection-fresh at the merge gate, not by article baselines (the
   * regen↔baseline circularity: draining the false item required an article
   * write, whose regen re-armed the detector, forever). Deletion still flags:
   * a vanished committed deliverable is real drift however it is produced.
   */
  private isGeneratedProjection(rel: string): boolean {
    return this.config.generated_projections.includes(rel);
  }

  /** sha256 of a file's bytes under the given tree root, or undefined if it cannot be read. */
  private hashFile(rel: string, root: string | undefined = this.repoRoot): string | undefined {
    if (!root) return undefined;
    try {
      return createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
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
  private contentChanged(rel: string, baselines: Record<string, string> | undefined, root: string | undefined = this.repoRoot): boolean {
    const baseline = baselines?.[rel];
    if (baseline === undefined) return false;
    const current = this.hashFile(rel, root);
    if (current === undefined) return false;
    return current !== baseline;
  }

  // -- knowledge CRUD ---------------------------------------------------------

  /**
   * Refuse a write that tries to ASSIGN a server-owned envelope key, instead of
   * stripping it in silence. The stripping itself is correct and stays (finding
   * 14/43 — a caller must not be able to forge an id, a clock, or a status); what
   * was wrong is that the caller was told the write succeeded.
   *
   * MEASURED 2026-07-29, and this is the sharpest instance of the whole class: a
   * project trying to retire a duplicate passed {status:'superseded',
   * superseded_by:'<canonical>'} to knowledge_update. The call SUCCEEDED and
   * returned status:'active', superseded_by:null — both fields discarded, no error,
   * no warning. Their words: "that's the dangerous shape — a caller who doesn't
   * re-read the result believes it worked." They then wrote store records asserting
   * a retirement that had never happened.
   *
   * So the message must not merely refuse: for status/superseded_by it has to say
   * that NO retire path exists on this surface, because a caller reaching for
   * these fields is trying to do something the surface cannot do, and silence let
   * them believe otherwise.
   */
  private refuseServerOwnedFields(fields: Record<string, unknown>, op: 'knowledge_create' | 'knowledge_update'): void {
    const SERVER_OWNED = ['id', 'created_at', 'updated_at', 'status', 'superseded_by', 'type'];
    const attempted = SERVER_OWNED.filter((k) => k in fields);
    if (attempted.length === 0) return;
    const retiring = attempted.includes('status') || attempted.includes('superseded_by');
    throw new Error(
      `${op}: ${attempted.map((k) => `'${k}'`).join(', ')} ${attempted.length === 1 ? 'is' : 'are'} SERVER-OWNED and cannot be assigned by a caller — ` +
        `the value would have been discarded and the write reported success. ` +
        (retiring
          ? `status/superseded_by are set only by supersession: knowledge_update writes a NEW version and retires the prior one automatically. ` +
            `There is NO way to retire a record to a non-serving state through this surface — /sterling:cleanup never hard-deletes knowledge either. ` +
            `To correct a wrong record, knowledge_update it in place (the correction supersedes the error); do NOT create a second record under the same slug.`
          : `id and the clocks are assigned at write; type is fixed at create.`)
    );
  }

  /**
   * Refuse a write carrying fields the record type does not define, naming them
   * AND the valid set — the write-side half of fail-loud (P5), symmetric with the
   * strict tool PARAMETERS of decision b47889b7. The valid set is in the message
   * because discoverability is the actual complaint: per-type required fields and
   * the files-vs-file_keys split (feature_article uses files[].path, decision /
   * anti_pattern / research_finding / todo use file_keys, reference_material
   * derives paths from location) cost a round-trip each to learn otherwise.
   * An unregistered type is left to validateRecord's louder rejection.
   */
  private refuseUnknownFields(type: string, candidate: Record<string, unknown>): void {
    const unknown = unknownFieldsIn(type, candidate);
    if (unknown.length === 0) return;
    const valid = [...(knownFieldsFor(type) ?? [])].sort().join(', ');
    throw new Error(
      `knowledge write: '${type}' does not define ${unknown.map((k) => `'${k}'`).join(', ')} — ` +
        `the field would have been silently dropped and the write reported success. Valid fields: ${valid}.`
    );
  }

  knowledgeCreate(type: string, fields: Record<string, unknown>): { record: DurableRecord; check_skipped: SkippedCheck[] } {
    this.refuseServerOwnedFields(fields, 'knowledge_create');
    const ts = this.now();
    // The envelope is SERVER-OWNED: strip these keys from caller fields before
    // assembling the candidate, so a caller cannot override id/timestamps/status/
    // superseded_by/type via `...fields` (audit finding 14/43 — e.g. status:
    // 'superseded' would create an already-invisible record). knowledgeUpdate
    // strips the identical set for the same reason.
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, type: _t, ...body } = fields;
    const candidate: Record<string, unknown> = {
      id: this.newId(),
      type,
      created_at: ts,
      updated_at: ts,
      author: (body.author as string) ?? 'conductor',
      status: 'active',
      superseded_by: null,
      links: body.links ?? [],
      scope: (body.scope as string) ?? 'project',
      stack_tags: body.stack_tags ?? [],
      ...body,
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
    // types fall through to store.create for its canonical rejection.
    // Keep the parsed result — its repoPath transform fully normalizes file_keys
    // ('./x'→'x'), so the dedup key-overlap compares like-for-like against stored
    // records (audit finding 28/43); the raw candidate skipped the assist tier.
    const registered = RECORD_TYPES[type as keyof typeof RECORD_TYPES];
    // A field this type does not define is REFUSED, never dropped (P5). zod
    // objects strip unknown keys, so before this a misfiled field was accepted,
    // discarded, and the create returned SUCCESS — the caller found out only by
    // querying for what the write was supposed to have stored (sibling report
    // 2026-07-29: reference_material has no files/file_keys, its paths come from
    // location). Checked BEFORE schema.parse so the error names the actual
    // mistake instead of a required field that went missing because of it.
    this.refuseUnknownFields(type, candidate);
    const parsed = registered ? (registered.schema.parse(candidate) as Record<string, unknown>) : candidate;
    const skipped: SkippedCheck[] = [];

    if (type === 'anti_pattern') {
      // dedup guard (§3.2.2): an overlapping anti_pattern is REFUSED LOUD, never
      // silently merged — a wrong merge costs the whole lesson (2026-07-04: a
      // distinct lesson was swallowed on one shared file_key, board 3f9591e9);
      // a refusal costs one round-trip. The author decides: same finding →
      // knowledge_update the match (append source_evidence); distinct lesson →
      // re-submit with dedup_override: true.
      if (!dedupOverride) {
        const match = this.findAntiPatternOverlap(parsed);
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
   * §3.2.6 note structuring, dispatched from the server: knowledge_create itself
   * detach-spawns the bundled worker — the one seam that provably runs on every
   * note capture. Originally because PostToolUse did not fire on MCP tool calls
   * (CC 2.1.198, board ccb14030); that premise was disproven on CC 2.1.215
   * (corrected finding research_finding e7bd5c19) and the server-side seam now
   * stays BY DECISION (5ef11bd4) rather than by platform limit.
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
        // Detached-working-tree resolution (comsoft-juiced 2026-07-17): resolve
        // against the record's declared tree; an unmapped name abstains LOUD —
        // never checked against the wrong tree, never a fabricated queue item.
        const tree = this.treeRootFor(record as unknown as Record<string, unknown>);
        if (tree.unresolved) return { ...record, verify_before_use: true };
        let rel: string | undefined;
        try {
          rel = normalizeRepoPath(r.location);
        } catch {
          rel = undefined; // absolute/escaping location: not repo-located
        }
        if (rel && tree.root) {
          const stat = statSync(join(tree.root, rel), { throwIfNoEntry: false });
          // mtime > source_date is the cheap pre-filter; confirm a real content
          // change against the baseline before flagging (an mtime-only bump from
          // a merge is not an out-of-band edit). No baseline → abstain. A
          // registered generated projection never content-flags (regen churn is
          // by design; this wire has no deletion arm — that is the feature-
          // article check's job for files an article owns).
          if (stat && stat.mtimeMs > Date.parse(r.source_date) && !this.isGeneratedProjection(rel) && this.contentChanged(rel, r.file_baselines, tree.root)) {
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
        // Detached-working-tree resolution (comsoft-juiced 2026-07-17): a copy-
        // describing article's files are stat'd against ITS tree — resolving
        // against the project root produced false "out-of-band deletion" items
        // for every copy-only file. An unmapped tree name abstains LOUD.
        const tree = this.treeRootFor(record as unknown as Record<string, unknown>);
        if (tree.unresolved) return { ...record, verify_before_use: true };
        const treeRoot = tree.root ?? this.repoRoot;
        let drift: { path: string; missing: boolean } | undefined;
        for (const f of a.files ?? []) {
          const stat = statSync(join(treeRoot, f.path), { throwIfNoEntry: false });
          if (!stat) {
            drift = { path: f.path, missing: true };
            break;
          }
          // mtime newer than updated_at is the cheap pre-filter; confirm a real
          // content change against the baseline before flagging, so a git
          // merge/checkout's mtime reset is not mistaken for an out-of-band edit.
          // A registered generated projection never content-flags — every regen
          // changes it by design and the merge gate's check-projection-fresh
          // guards its currency; its DELETION still lands in the missing arm above.
          if (stat.mtimeMs > Date.parse(record.updated_at) && !this.isGeneratedProjection(f.path) && this.contentChanged(f.path, a.file_baselines, treeRoot)) {
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

  /**
   * The MCP-facing result for knowledge_query: the flagged records, PROJECTED for
   * reading, inside an envelope that DISCLOSES what the retrieval did. Two
   * failures of one class — a retrieval that misrepresents itself (P5) — and both
   * were observed, not theorized (sibling-project retrospective, 2026-07-29):
   *
   * (1) THE CAP WAS SILENT. query() caps at DEFAULT_QUERY_CAP, so a filter
   * matching 200 records returned 20 with no signal the other 180 existed. A
   * sibling conductor read such a window as the whole store and concluded it held
   * ~20 records when it held 21 feature articles alone — then reasoned from that.
   * count() already existed over the SAME base filter (the TUI's badges use it),
   * so disclosure costs one COUNT(*) and no new machinery.
   *
   * (2) VERSION HISTORY DOMINATED THE PAYLOAD. A v42 article serializes a
   * 42-entry supersedes chain plus 25 server-owned sha256 baselines on EVERY hit;
   * a cap:6 query measured 56KB, nearly none of it readable content. The
   * projection drops both — from QUERY results only. knowledge_get stays
   * full-fidelity, so nothing becomes unreachable; it just stops being paid for on
   * every retrieval. Semantic links (cites/informed_by/fulfills) SURVIVE: they
   * point at the decisions and briefs a reader may need to follow, and
   * supersedes_count keeps the version depth visible without the uuids.
   *
   * Scoped to this boundary deliberately: internal consumers read the fields the
   * projection drops (promotion.mjs filters links.rel==='fulfills'; the drift
   * wires above read file_baselines), and they call store.query/knowledgeQuery
   * directly — so trimming in the store would have starved them. knowledgeQuery
   * keeps returning full flagged records for exactly that reason.
   */
  knowledgeQueryResult(opts: QueryOptions): KnowledgeQueryResult {
    const records = this.knowledgeQuery(opts);
    const cap = opts.cap ?? DEFAULT_QUERY_CAP;
    // count() shares query()'s base filter but is rank-BLIND (rank_terms is a
    // no-op there), so this is "records matching the filter", which is exactly
    // the number a caller needs to see it is holding a window. Claiming it as
    // "records your query would return" would trade a silent lie for a loud one.
    const matchedFilter = this.store.count(opts);
    // returned === cap is the only truthful truncation signal: the LIMIT was
    // reached, so more MAY exist past it. returned < cap guarantees nothing was
    // dropped. Deriving capped from matchedFilter alone would false-positive
    // every time rank_terms legitimately narrowed the set.
    const capped = records.length === cap;
    const rankRestricted = (opts.rank_terms?.length ?? 0) > 0 && !capped && matchedFilter > records.length;
    return {
      matched_filter: matchedFilter,
      returned: records.length,
      cap,
      capped,
      ...(capped
        ? {
            note: `cap reached — showing ${records.length} of ${matchedFilter} records matching this filter; raise cap or narrow the filter (types/file_keys/rank_terms) to see the rest`,
          }
        : rankRestricted
          ? {
              note: `rank_terms restricted this to ${records.length} FTS match(es); ${matchedFilter} records match the filter alone — drop or widen rank_terms to see them`,
            }
          : {}),
      records: records.map((r) => this.projectForQuery(r)),
    };
  }

  /** Query-result projection (see knowledgeQueryResult): drop the supersedes
   *  chain and the server-owned baseline hashes, keep every semantic link. */
  private projectForQuery(record: DurableRecord & { staleness?: object; verify_before_use?: boolean }): Record<string, unknown> {
    const { file_baselines: _baselines, ...rest } = record as unknown as Record<string, unknown>;
    const links = (rest.links ?? []) as { rel: string; target_id: string }[];
    const semantic = links.filter((l) => l.rel !== 'supersedes');
    const supersedesCount = links.length - semantic.length;
    return { ...rest, links: semantic, ...(supersedesCount > 0 ? { supersedes_count: supersedesCount } : {}) };
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
    this.refuseServerOwnedFields(body, 'knowledge_update');
    const ts = this.now();
    const { id: _i, status: _s, superseded_by: _sb, created_at: _c, updated_at: _u, type: _t, ...overrides } = body;
    // Same refusal as create, applied to the CALLER's fields rather than the
    // merged record: `old` is already valid, so anything unknown came from this
    // call. Without it the merge silently discarded the field and reported a new
    // version — the failure that makes a "fix" look applied when it never landed.
    this.refuseUnknownFields(old.type, overrides);
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

  /**
   * The whole filtered set, uncapped — ONE definition of the board filter, shared
   * by the capped array (boardQuery, for internal callers) and the disclosed
   * envelope (boardQueryResult, for the tool surface). Extracted so the two can
   * never disagree about what "matching" means.
   */
  private boardFiltered(filter: BoardFilter): { matching: DurableRecord[]; scanTruncated: boolean } {
    const todos = this.store.query({ types: ['todo'], file_keys: filter.file_keys, cap: BOARD_SCAN_CAP });
    // Apply EVERY filter BEFORE the cap slice (audit finding 33/43): capping the
    // mixed set first silently dropped matching items past the cap (the store
    // orders updated_at DESC, so long-standing reason-filtered items vanished).
    let filtered = filter.source ? todos.filter((t) => (t as { source: string }).source === filter.source) : todos;
    if (filter.system_reason) {
      filtered = filtered.filter((t) => (t as { system_reason?: string }).system_reason === filter.system_reason);
    }
    // The underlying scan is itself bounded; if it came back full, the count we
    // can report is a FLOOR, and saying so beats quietly under-reporting (P5).
    return { matching: filtered, scanTruncated: todos.length >= BOARD_SCAN_CAP };
  }

  boardQuery(filter: BoardFilter = {}): DurableRecord[] {
    return this.boardFiltered(filter).matching.slice(0, filter.cap ?? DEFAULT_BOARD_CAP);
  }

  /**
   * The MCP-facing result for board_query / maintenance_query: the same envelope
   * knowledge_query gained in decision b47889b7, extended to the two surfaces it
   * MISSED. That omission was reported from the field within a day: "maintenance_
   * query caps at 50 silently. No count, no '50 of N'. I only learned the tail was
   * deep because removing 19 revealed 19 more, including a capture_owed reason not
   * previously visible." A queue that under-reports its own depth reads as drained
   * when it is merely truncated — and a drain is exactly the operation that must
   * know what remains.
   *
   * One difference from knowledge_query, in this surface's favour: the filter runs
   * in JS over the scanned set, so `capped` here is EXACT (returned < matching)
   * rather than the returned === cap heuristic that FTS rank-blindness forces
   * there. The field NAME is deliberately the same (matched_filter = records
   * matching the filter you gave) — one name per concept, with each tool
   * documenting its own guarantee.
   */
  boardQueryResult(filter: BoardFilter = {}): BoardQueryResult {
    const { matching, scanTruncated } = this.boardFiltered(filter);
    const cap = filter.cap ?? DEFAULT_BOARD_CAP;
    const records = matching.slice(0, cap);
    const capped = records.length < matching.length;
    const notes: string[] = [];
    if (capped) {
      notes.push(
        `cap reached — showing ${records.length} of ${matching.length} matching items; raise cap to see the rest (a drain that stops at the cap leaves the tail behind)`
      );
    }
    if (scanTruncated) {
      notes.push(`the underlying todo scan hit its ${BOARD_SCAN_CAP}-record ceiling, so matched_filter is a FLOOR, not a total`);
    }
    return {
      matched_filter: matching.length,
      returned: records.length,
      cap,
      capped,
      ...(notes.length ? { note: notes.join('; ') } : {}),
      records,
    };
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
    const namedPhase = run.phases.find((p) => p.id === args.phase_id);
    if (!namedPhase) {
      throw new Error(
        `agent_exit: no phase '${args.phase_id}' on run '${run.id}' — nothing was recorded. ` +
          `The run's phases: ${run.phases.map((p) => p.id).join(', ')}. A pipeline agent must exit against its dispatched phase; ` +
          `an agent working OUTSIDE the pipeline (conductor-direct) must not call agent_exit while a run is active — its final message is its deliverable.`
      );
    }
    // Phase CURRENCY, not just existence (audit finding 3/43): an exit naming a
    // real-but-not-current phase (e.g. an earlier already-complete phase) would
    // otherwise drive the brain to re-spawn that phase's successor and corrupt
    // phase state (two in_progress phases, or an early run completion). The
    // dispatched phase is always the in_progress one — refuse loud, nothing
    // recorded, naming the actual current phase.
    if (namedPhase.status !== 'in_progress') {
      const current = run.phases.find((p) => p.status === 'in_progress');
      throw new Error(
        `agent_exit: phase '${args.phase_id}' is '${namedPhase.status}', not the current (in_progress) phase — nothing was recorded. ` +
          `Exit against the dispatched phase${current ? ` '${current.id}'` : ' (none is currently in_progress — the run may be completing)'}. ` +
          `Naming a stale phase would corrupt phase state.`
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
    // A conductor-supplied exit must NOT silently shadow-and-destroy a recorded
    // agent exit (audit finding 2/43): casTransition NULLs the pending slot
    // unconditionally, so if an agent already recorded (e.g. blocked) via
    // agent_exit and the conductor then reports agent-died{empty_output}, the
    // real exit would vanish and the brain react to the wrong signal. Refuse
    // loud, nothing consumed — the conductor consumes the recorded exit (no
    // args.exit) or investigates the mismatch (mirrors the 32fa4a05 pattern).
    if (args.exit) {
      const recorded = this.store.getPendingExit(run.id);
      if (recorded) {
        throw new Error(
          `run_signal: an explicit exit was supplied but run '${run.id}' already has a recorded agent exit ` +
            `(signal '${recorded.signal}', phase '${recorded.phase_id}'${recorded.agent_role ? `, role '${recorded.agent_role}'` : ''}) ` +
            `— refusing to overwrite it (nothing consumed). Call run_signal with NO exit to react to the recorded one, ` +
            `or resolve the mismatch (consume-exit) before reporting a different signal.`
        );
      }
    }
    const exit: ResolvedExit | undefined = args.exit ?? this.store.getPendingExit(run.id);
    if (!exit) {
      throw new Error(
        `run_signal: no exit recorded for run '${run.id}' — if the Task returned without an exit, report {signal: 'agent-died', payload: {observed: 'empty_output'}} (§5.2)`
      );
    }
    // The reaction depends only on machine_state + phases + the exit — none of
    // which hooks touch — so it is computed ONCE from the observed run and stays
    // valid across merge retries.
    const { action, nextState } = react(run, exit, {
      phase_death_cap: this.config.caps.phase_death_cap,
      research_resume_per_phase: this.config.caps.research_resume_per_phase,
    });
    const at = this.now(); // stamp once — the mutate may re-run on a merge retry
    // Apply the brain reaction onto the FRESH run body (audit findings 1/43, 18/43):
    // casTransitionMerge re-reads inside its retry loop, so a concurrent hook write
    // (H7 reconcile marks, H6/H8 escalations) is preserved instead of clobbered by
    // a stale-body rewrite. The phase/escalation edits are re-derived from `fresh`
    // (identical to the observed run — hooks change neither phases nor state).
    this.store.casTransitionMerge(run.machine_state, run.id, (fresh) => {
      const phases = fresh.phases.map((p) => ({ ...p, signals: [...p.signals] }));
      const idx = exit.phase_id ? phases.findIndex((p) => p.id === exit.phase_id) : phases.findIndex((p) => p.status === 'in_progress');
      if (idx !== -1) {
        phases[idx].signals.push({ signal: exit.signal, payload: exit.payload ?? null, agent_role: exit.agent_role ?? null, at });
        if (action.action === 'complete_run') phases[idx].status = 'complete';
        if (action.action === 'spawn' && !('respawn' in action && action.respawn)) {
          phases[idx].status = 'complete';
          const nextIdx = phases.findIndex((p) => p.id === (action as { phase_id: string }).phase_id);
          if (nextIdx !== -1) phases[nextIdx].status = 'in_progress';
        }
      }
      const escalations = [...fresh.escalations];
      if (action.action === 'judgment_needed' || action.action === 'halt') {
        escalations.push({ kind: action.action, reason: (action as { reason: string }).reason, at });
      }
      return { ...fresh, machine_state: nextState, phases, escalations };
    });
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
    // system_reason is applied inside boardQuery BEFORE the cap (finding 33/43),
    // so a reason-filtered query no longer misses matches past the cap.
    return this.boardQuery({ source: 'system', system_reason: filter.system_reason, file_keys: filter.file_keys, cap: filter.cap });
  }

  /** The disclosed envelope for maintenance_query — the queue's own depth, stated (see boardQueryResult). */
  maintenanceQueryResult(filter: { system_reason?: string; file_keys?: string[]; cap?: number } = {}): BoardQueryResult {
    return this.boardQueryResult({ source: 'system', system_reason: filter.system_reason, file_keys: filter.file_keys, cap: filter.cap });
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
