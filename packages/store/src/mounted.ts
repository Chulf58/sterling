// @sterling/store — MountedStores (spec §3.3): composes the project store with
// the project's mounted domain stores (the config.stack_tags manifest). The project
// store holds project-scoped knowledge + all run/board/transient state; domain
// stores (at ~/.sterling/domains/<name>/, resolved by the caller) hold shared,
// cross-project knowledge. One retrieval interface (§3.4) fans across the mounted
// set PROJECT-FIRST; writes route by the record's `scope` (project | domain:<name>).
//
// Mechanism (decision 2026-06-16, store-internals are the implementor's choice
// per §12): composition over SQLite ATTACH — each store is a self-contained,
// already-tested SterlingStore; this layer only mounts, routes, and merges.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { SterlingStore, DEFAULT_QUERY_CAP, type QueryOptions } from './index.js';
import { validateRecord, type DurableRecord, type SterlingConfig } from '@sterling/schemas';

/** A domain store to mount: its manifest name + its already-resolved DB path. */
export interface DomainMount {
  name: string;
  dbPath: string;
}

/** §3.3: the project's stack_tags ARE the domain mount manifest — the SAME list
 *  that filters retrieval (§3.4) mounts the shared domain stores, so the mounted
 *  set and the filter align by construction. Each tag mounts a store at
 *  ~/.sterling/domains/<tag>/sterling.db by default; config.domain_paths overrides
 *  the path per tag (spec line 94). The ONE resolver the MCP server AND dispose-run
 *  share, so the mounted set and the snapshotted set can never drift apart. */
export function resolveDomainMounts(config: SterlingConfig): DomainMount[] {
  return config.stack_tags.map((name) => ({
    name,
    dbPath: config.domain_paths[name] ?? join(homedir(), '.sterling', 'domains', name, 'sterling.db'),
  }));
}

/** Open (and thereby lazily create — §2.3) a store at dbPath. SterlingStore opens
 *  the file directly; the parent dir is ensured here so a first-mount of a domain
 *  at ~/.sterling/domains/<name>/ (or a fresh project .sterling/) just works. */
function open(dbPath: string): SterlingStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new SterlingStore(dbPath);
}

export class MountedStores {
  /** The project store — also the home of all run/board/transient state. */
  readonly project: SterlingStore;
  private readonly domains = new Map<string, SterlingStore>();

  /** Opening a store creates its file + schema (§2.3 lazy creation): a domain
   *  store comes into being the first time a project's manifest mounts it.
   *  When options.skipMissing is true, domain mounts whose db file does NOT
   *  already exist on disk are SKIPPED — never created. Existing siblings that
   *  DO exist are still mounted. The default (no options / skipMissing false)
   *  always lazily creates missing stores (§2.3 backward-compatible default). */
  constructor(projectDbPath: string, mounts: DomainMount[] = [], options?: { skipMissing?: boolean }) {
    this.project = open(projectDbPath);
    for (const m of mounts) {
      if (options?.skipMissing && !existsSync(m.dbPath)) continue;
      this.domains.set(m.name, open(m.dbPath));
    }
  }

  /** Scope-routed write (§3.3): project → the project store; domain:<name> → that
   *  domain store. Routing is MECHANICAL here; the tool layer owns the policy
   *  (feature_article always project, reference/research project-then-promote).
   *
   *  Validation here needs `scope`, so it must run BEFORE the write reaches a
   *  store — which means it must also run the store's identity normalization
   *  first (SterlingStore.normalizeIdentityEnvelope, the ONE definition):
   *  otherwise a lifecycle/freshness-only envelope that SterlingStore.create
   *  accepts was rejected through the mounted surface, because the schemas
   *  registry still declares the derived status/superseded_by fields. */
  create(input: unknown): DurableRecord {
    const record = validateRecord(SterlingStore.normalizeIdentityEnvelope(input));
    return this.storeFor(record.scope).create(record);
  }

  /** Scope-routed exactly as create() is. A maintenance item is project-LOCAL
   *  state and never shared, so this resolves to the project store in practice —
   *  and the dedup key is therefore evaluated within that ONE store rather than
   *  across the fan, which is right: two projects' queues are independent, and a
   *  cross-store key would let one project's item suppress another's. */
  enqueueSystemTodo(input: unknown): { record: DurableRecord; deduped: boolean; text_updated: boolean } {
    // Same normalize-then-validate order as create(), for the same reason.
    const record = validateRecord(SterlingStore.normalizeIdentityEnvelope(input));
    return this.storeFor(record.scope).enqueueSystemTodo(record);
  }

  private storeFor(scope: string): SterlingStore {
    if (scope === 'project') return this.project;
    const m = /^domain:(.+)$/.exec(scope);
    if (m) {
      const store = this.domains.get(m[1]);
      if (!store) throw new Error(`scope '${scope}' targets an unmounted domain — not in the project's domains manifest`);
      return store;
    }
    throw new Error(`unroutable scope '${scope}'`);
  }

  /** Cross-store retrieval (§3.4): every mounted store runs the full
   *  filter→join→rank→cap; results concatenate PROJECT-FIRST then domains (each
   *  internally bm25-ranked — §3.3 project-store-first bias) and the overall cap
   *  re-applies. A unified cross-store bm25 re-rank is a later refinement. */
  query(opts: QueryOptions = {}): DurableRecord[] {
    const cap = opts.cap ?? DEFAULT_QUERY_CAP;
    const merged = this.all().flatMap((s) => s.query(opts));
    return merged.slice(0, cap);
  }

  /** Cross-mount COUNT(*) over the §3.4 base filter — the rank/cap-free twin of
   *  query(), summed project-first across every mounted store (countBySource is
   *  the same fan, kept per-source for the TUI's badges). No body fetch. The tool
   *  layer reports it so a capped retrieval can say how many records matched the
   *  filter it was given, instead of presenting its window as the whole store. */
  count(opts: QueryOptions = {}): number {
    return this.countBySource(opts).reduce((n, s) => n + s.count, 0);
  }

  /** Per-source projection (AC2): project store FIRST, then each mounted domain
   *  in manifest order. Each store runs the full query independently — type
   *  filter, file-key join, cap, and match_all are all PER-STORE (never a
   *  global slice across the merged result). Zero domains → exactly one entry.
   *  The source name is 'project' for the project store and the domain manifest
   *  name (DomainMount.name) for each domain store. */
  bySource(opts?: QueryOptions): { source: string; records: DurableRecord[] }[] {
    const result: { source: string; records: DurableRecord[] }[] = [];
    result.push({ source: 'project', records: this.project.query(opts) });
    for (const [name, store] of this.domains) {
      result.push({ source: name, records: store.query(opts) });
    }
    return result;
  }

  /** Count-only per-source projection — the COUNT(*) twin of bySource (same
   *  project-first, per-store ordering) with NO body fetch. The TUI Knowledge
   *  tree's collapsed category/source badges use this so the default all-collapsed
   *  view does not fetch + parse every source's record bodies each frame. */
  countBySource(opts?: QueryOptions): { source: string; count: number }[] {
    const result: { source: string; count: number }[] = [{ source: 'project', count: this.project.count(opts) }];
    for (const [name, store] of this.domains) {
      result.push({ source: name, count: store.count(opts) });
    }
    return result;
  }

  /** Records from ONE named source ('project' or a mounted domain name) — the
   *  full §3.4 query against that single store. The TUI fetches bodies only for
   *  the source the user actually expanded; an unknown source yields []. */
  querySource(source: string, opts: QueryOptions = {}): DurableRecord[] {
    const store = source === 'project' ? this.project : this.domains.get(source);
    return store ? store.query(opts) : [];
  }

  /** Cross-store fetch by id: project first, then domains. */
  get(id: string): DurableRecord | undefined {
    for (const s of this.all()) {
      const r = s.get(id);
      if (r) return r;
    }
    return undefined;
  }

  /** Project-first concatenation of every mounted store's id index (any status,
   *  tombstones included). A citation checker MUST span mounts: legitimately
   *  cited ids live in the shared domain stores as often as in the project one,
   *  so a project-only lookup calls them dangling. No dedup needed — a record
   *  lives in exactly one store. */
  recordIdIndex(): { id: string; type: string; status: string }[] {
    return this.all().flatMap((s) => s.recordIdIndex());
  }

  /** Project-first concatenation of every mounted store's dead-id alias index
   *  ([stable-identity-design-v2] contract 3) — same reasoning as
   *  recordIdIndex: a historical id cited anywhere may have belonged to a
   *  record that now lives in a domain store, so resolution MUST span mounts.
   *  A historical id is unique across the fan (it was one record's id), so no
   *  dedup is needed. */
  recordAliases(): ReturnType<SterlingStore['recordAliases']> {
    return this.all().flatMap((s) => s.recordAliases());
  }

  /** Exact-slug article resolution across the fan, PROJECT-FIRST (decision
   *  3db7095f's deterministic lookup, mounted). Feature articles are always
   *  project-scoped and never promote (AC7), so in practice this reads the project
   *  store — but it fans anyway, deliberately: its callers are H19's one-hop
   *  pointers and knowledge_create's slug-collision refusal, and for BOTH of them
   *  over-detecting a slug that somehow lives in a domain store is safe while
   *  under-detecting is not. A project-only lookup would let a clash through and
   *  serve two records under one slug, which is the failure the refusal exists to
   *  prevent. No dedup needed — a record lives in exactly one store. */
  articlesBySlug(slug: string): DurableRecord[] {
    return this.all().flatMap((s) => s.articlesBySlug(slug));
  }

  /** Type-agnostic exact-slug lookup across the fan, PROJECT-FIRST (board
   *  1e639f32) — same over-detect-is-safe reasoning as articlesBySlug: its
   *  callers are a uniqueness refusal and an identity resolution, and both
   *  would rather see a domain-store record than miss one. */
  recordsBySlug(slug: string): DurableRecord[] {
    return this.all().flatMap((s) => s.recordsBySlug(slug));
  }

  /** Superseded-only counterpart of recordsBySlug — knowledge_get's dead-slug
   *  fallthrough is the sole caller (decision df361a0f) and takes result[0] as
   *  THE newest carrier, so the fan-in order is load-bearing. A slug does NOT
   *  live in exactly one store: retireInFavorOf's promotion shape leaves the
   *  project tombstone behind while the live copy is promoted into a domain
   *  store, so one lineage's tombstones can be split across stores. Plain
   *  project-first concatenation would let an OLDER project tombstone shadow a
   *  NEWER domain one, so the fanned results are merge-sorted by updated_at
   *  DESC — each store's own rows already arrive newest-first, so this is a
   *  stable merge, not a full re-sort. rowid ordering (and the newest-first
   *  guarantee it gives) is only meaningful WITHIN one store; updated_at is
   *  the one field comparable across stores, and is therefore the cross-store
   *  sort key here (review finding, 2026-08-20). */
  supersededRecordsBySlug(slug: string): DurableRecord[] {
    return this.all()
      .flatMap((s) => s.supersededRecordsBySlug(slug))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  /** Cross-store terminus resolution (decision de1a7329): a record lives in
   *  exactly one store (same reasoning as get()), so this tries each mounted
   *  store project-first and returns the first hit. */
  resolveTerminus(id: string): ReturnType<SterlingStore['resolveTerminus']> {
    for (const s of this.all()) {
      const r = s.resolveTerminus(id);
      if (r) return r;
    }
    return null;
  }

  // -- record mutations: route to the store that HOLDS the record --------------
  // A record's scope decided where it lives at create time; a later change has to
  // land in that same store, so these route by where the id actually is — never
  // by the caller. (knowledge_update gets the record first, so supersede always
  // finds it; remove routes on its id the same way. addLink routes on the SOURCE
  // id — the edge lives with its source — and validates the TARGET mount-wide.)

  /** Versioned change in the holding store (a domain record supersedes in its domain store). */
  supersede(...args: Parameters<SterlingStore['supersede']>): ReturnType<SterlingStore['supersede']> {
    return this.storeHolding(args[0]).supersede(...args);
  }

  /** Promotion tombstone: retire the original in its (project) store, pointing at
   *  the cross-store replacement. The replacement already lives in another store
   *  (the promoted domain copy), so only the original's holding store is touched. */
  retireInFavorOf(...args: Parameters<SterlingStore['retireInFavorOf']>): ReturnType<SterlingStore['retireInFavorOf']> {
    return this.storeHolding(args[0]).retireInFavorOf(...args);
  }

  /** Hard delete (+ §3.2.7 drain log for system todos) in the holding store. */
  remove(...args: Parameters<SterlingStore['remove']>): ReturnType<SterlingStore['remove']> {
    return this.storeHolding(args[0]).remove(...args);
  }

  // -- the generalized IN-PLACE write triad (stable-identity S2, decision
  // [stable-identity-design-v2]) — same holding-store routing as supersede:
  // an in-place write must land on the row that actually exists, and the
  // version counter it bumps is that store's.

  /** knowledge_update-shaped in-place write in the holding store. */
  updateRecord(...args: Parameters<SterlingStore['updateRecord']>): ReturnType<SterlingStore['updateRecord']> {
    return this.storeHolding(args[0]).updateRecord(...args);
  }

  /** knowledge_edit-shaped exactly-once passage replace in the holding store. */
  editRecordField(...args: Parameters<SterlingStore['editRecordField']>): ReturnType<SterlingStore['editRecordField']> {
    return this.storeHolding(args[0]).editRecordField(...args);
  }

  /** knowledge_append-shaped array growth in the holding store. */
  appendRecordField(...args: Parameters<SterlingStore['appendRecordField']>): ReturnType<SterlingStore['appendRecordField']> {
    return this.storeHolding(args[0]).appendRecordField(...args);
  }

  /** An archived (record_id, version) snapshot from whichever store holds the
   *  record. Version history is store-local, exactly like the record itself. */
  getRecordVersion(...args: Parameters<SterlingStore['getRecordVersion']>): ReturnType<SterlingStore['getRecordVersion']> {
    return this.storeHolding(args[0]).getRecordVersion(...args);
  }

  /** IN-PLACE todo edit (board_update) in the holding store — todos are always
   *  project-scoped (§3.3), so this always resolves to the project store, but it
   *  routes the same way as supersede/remove for consistency rather than assuming. */
  updateTodo(...args: Parameters<SterlingStore['updateTodo']>): ReturnType<SterlingStore['updateTodo']> {
    return this.storeHolding(args[0]).updateTodo(...args);
  }

  /** Typed link edge, added on the source record in its holding store. The TARGET
   *  is resolved across ALL mounted stores (cross-store get, like get()) before
   *  delegating: cross-store edges are a legitimate shape — promotion itself writes
   *  them (supersedes / informed_by across project↔domain) — and the holding
   *  store's local check cannot see a target mounted elsewhere, so it is told the
   *  target is already validated. */
  addLink(sourceId: string, rel: string, targetId: string): DurableRecord {
    if (!this.get(targetId)) throw new Error(`addLink: no target record '${targetId}' in the project store or any mounted domain`);
    return this.storeHolding(sourceId).addLink(sourceId, rel, targetId, true);
  }

  private storeHolding(id: string): SterlingStore {
    for (const s of this.all()) if (s.get(id)) return s;
    throw new Error(`no record '${id}' in the project store or any mounted domain`);
  }

  // -- run/board/transient state: PROJECT-LOCAL, never a domain ----------------
  // Runs (§7.5 one active run), the board/maintenance queue (§3.2.7), handoffs and
  // check_skipped are project-scoped by definition — they live in the project
  // store, so MountedStores forwards them straight through. Knowledge fans across
  // mounts; run state does not. Signatures mirror SterlingStore exactly.

  createRun(...args: Parameters<SterlingStore['createRun']>): ReturnType<SterlingStore['createRun']> {
    return this.project.createRun(...args);
  }
  getRun(...args: Parameters<SterlingStore['getRun']>): ReturnType<SterlingStore['getRun']> {
    return this.project.getRun(...args);
  }
  casTransition(...args: Parameters<SterlingStore['casTransition']>): ReturnType<SterlingStore['casTransition']> {
    return this.project.casTransition(...args);
  }
  casTransitionMerge(...args: Parameters<SterlingStore['casTransitionMerge']>): ReturnType<SterlingStore['casTransitionMerge']> {
    return this.project.casTransitionMerge(...args);
  }
  recordPendingExit(...args: Parameters<SterlingStore['recordPendingExit']>): ReturnType<SterlingStore['recordPendingExit']> {
    return this.project.recordPendingExit(...args);
  }
  getPendingExit(...args: Parameters<SterlingStore['getPendingExit']>): ReturnType<SterlingStore['getPendingExit']> {
    return this.project.getPendingExit(...args);
  }
  appendRunEscalation(...args: Parameters<SterlingStore['appendRunEscalation']>): ReturnType<SterlingStore['appendRunEscalation']> {
    return this.project.appendRunEscalation(...args);
  }
  appendRunReconcileNeeded(...args: Parameters<SterlingStore['appendRunReconcileNeeded']>): ReturnType<SterlingStore['appendRunReconcileNeeded']> {
    return this.project.appendRunReconcileNeeded(...args);
  }
  recordCheckSkipped(...args: Parameters<SterlingStore['recordCheckSkipped']>): ReturnType<SterlingStore['recordCheckSkipped']> {
    return this.project.recordCheckSkipped(...args);
  }
  writeHandoff(...args: Parameters<SterlingStore['writeHandoff']>): ReturnType<SterlingStore['writeHandoff']> {
    return this.project.writeHandoff(...args);
  }
  /** The drain log is project-local (§3.2.7) — forwarded like every run/board surface. */
  drainLogEntry(...args: Parameters<SterlingStore['drainLogEntry']>): ReturnType<SterlingStore['drainLogEntry']> {
    return this.project.drainLogEntry(...args);
  }
  /** Project-local for the same reason as drainLogEntry — board items never live in a domain mount. */
  removedIdsByPrefix(...args: Parameters<SterlingStore['removedIdsByPrefix']>): ReturnType<SterlingStore['removedIdsByPrefix']> {
    return this.project.removedIdsByPrefix(...args);
  }
  readHandoffs(...args: Parameters<SterlingStore['readHandoffs']>): ReturnType<SterlingStore['readHandoffs']> {
    return this.project.readHandoffs(...args);
  }
  setRunReviewMandatory(...args: Parameters<SterlingStore['setRunReviewMandatory']>): ReturnType<SterlingStore['setRunReviewMandatory']> {
    return this.project.setRunReviewMandatory(...args);
  }

  /** knowledge_split's multi-record write (decision
   *  compaction-tooling-windowed-read-plus-split) targets the PROJECT store
   *  only — feature_article is always project-scoped (§3.3), so the split's
   *  children-plus-parent transaction never needs to span a domain mount. */
  withTransaction<T>(fn: () => T): T {
    return this.project.withTransaction(fn);
  }

  /** Per-store snapshot (§2.3): each store snapshots independently; the caller
   *  supplies a path per store name ('project' or 'domain-<name>'). */
  snapshotAll(pathFor: (storeName: string) => string): void {
    this.project.snapshot(pathFor('project'));
    for (const [name, store] of this.domains) store.snapshot(pathFor(`domain-${name}`));
  }

  /** Mounted domain names, in manifest order. */
  domainNames(): string[] {
    return [...this.domains.keys()];
  }

  close(): void {
    for (const s of this.all()) s.close();
  }

  private all(): SterlingStore[] {
    return [this.project, ...this.domains.values()];
  }
}
