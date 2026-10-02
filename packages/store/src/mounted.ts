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
import { SterlingStore, DEFAULT_QUERY_CAP, assertNoFieldLoss, type QueryOptions } from './index.js';
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
  /** The project store — also the home of the board/maintenance queue and
   *  other project-local transient state (the run/handoff protocol this
   *  comment used to describe was removed per decision
   *  sterling-claude-code-scale-down-boundary, 2ad87dd1).
   *
   *  STATED LIMIT OF THE CROSS-MOUNT WRITE BACKSTOP (decision
   *  [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
   *  This handle is a PUBLIC, FULLY MUTABLE SterlingStore, so
   *  `stores.project.create(...)` (or any other mutator on it) reaches the
   *  project connection DIRECTLY and never passes assertMountAffinity below.
   *  Called inside a transaction open on a DOMAIN mount, such a write commits
   *  on the project connection and survives the outer rollback — the exact
   *  atomicity hole the backstop closes for every write that goes through this
   *  class's own surface. The backstop's guarantee is therefore scoped to
   *  MountedStores' OWN METHODS, and this field is the one documented way past
   *  it; treat any claim of universal coverage as wrong.
   *
   *  IT IS NOT NARROWED, and the reason is not that narrowing is undesirable.
   *  MEASURED 2026-09-06 (re-runnable: grep for `.project.` across
   *  packages/{store,mcp-server,tui}/src and scripts/): NO production caller
   *  outside this file touches the handle at all — every `.project.<mutator>`
   *  call in the repo is in a TEST (packages/store/src/tests/
   *  stable-identity-hardening.test.ts and packages/mcp-server/src/tests/
   *  resolves-append-join.test.ts seed forged rows through it). Those suites
   *  are frozen, and a read-only type on
   *  this field would fail their compile, so the exposure is retained
   *  deliberately and disclosed here rather than closed by editing pins. The
   *  real containment today is that production has no such caller — a
   *  PROPERTY OF THE CALLERS, not a guarantee of this class. If a production
   *  mutation through this handle is ever wanted, route it through the guarded
   *  surface instead of widening the exception.
   */
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
    const normalized = SterlingStore.normalizeIdentityEnvelope(input);
    const record = validateRecord(normalized);
    // Board bd3f0acf — this site is NOT redundant with SterlingStore.create's own
    // guard. This surface is not a pass-through: it parses (and therefore strips)
    // HERE, before delegating, so the store below only ever sees an
    // already-cleaned record and its guard could never fire for a mounted caller.
    // The refusal must happen against the caller's own body, which only exists at
    // this point in the chain.
    assertNoFieldLoss('create', normalized, record);
    // TRANSACTION AFFINITY (decision
    // [scope-drift-closed-by-column-authoritative-reads-not-format-change]):
    // create is SCOPE-routed, so inside an open transaction it is the one write
    // that can silently target a DIFFERENT mount than the transaction holds —
    // an inner commit on a second SQLite connection that an outer rollback
    // could no longer undo. Checked after validation/loss so a malformed body
    // still gets its own refusal first.
    const target = this.storeFor(record.scope);
    this.assertMountAffinity('create', target, `record '${record.id}' (scope '${record.scope}')`);
    return target.create(record);
  }

  /** Scope-routed exactly as create() is. A maintenance item is project-LOCAL
   *  state and never shared, so this resolves to the project store in practice —
   *  and the dedup key is therefore evaluated within that ONE store rather than
   *  across the fan, which is right: two projects' queues are independent, and a
   *  cross-store key would let one project's item suppress another's. */
  enqueueSystemTodo(input: unknown): { record: DurableRecord; deduped: boolean; text_updated: boolean } {
    // Same normalize-then-validate order as create(), for the same reason.
    const record = validateRecord(SterlingStore.normalizeIdentityEnvelope(input));
    const target = this.storeFor(record.scope);
    this.assertMountAffinity('enqueueSystemTodo', target, `todo '${record.id}' (scope '${record.scope}')`);
    return target.enqueueSystemTodo(record);
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

  /** Cross-mount twin of countAboveScore (board a577a69d) — summed
   *  project-first across every mounted store, same fan as count(). */
  countAboveScore(opts: QueryOptions, minScore: number): number {
    return this.all().reduce((n, s) => n + s.countAboveScore(opts, minScore), 0);
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

  /** PHYSICAL mount membership: the PROJECT store ALONE, never the fan (anti_pattern
   *  [record-body-scope-is-not-physical-store-identity]). This is the same physical
   *  database H10 opens and the only mount withTransaction can commit on, so a caller
   *  whose atomicity or whose parity with H10 depends on "is this record project-local"
   *  asks HERE. It deliberately does NOT consult the record's body `scope`: create()
   *  routes by scope, but every later write routes by storeHolding (by id), and `scope`
   *  is caller-writable — so the field and the mount can disagree in both directions. */
  projectStoreHolds(id: string): boolean {
    return this.project.projectStoreHolds(id);
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
   *  fallthrough is the sole caller (decision foreign_df361a0f) and takes result[0] as
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

  /** Cross-store terminus resolution (decision foreign_de1a7329): a record lives in
   *  exactly one store (same reasoning as get()), so this tries each mounted
   *  store project-first and returns the first hit. */
  resolveTerminus(id: string): ReturnType<SterlingStore['resolveTerminus']> {
    for (const s of this.all()) {
      const r = s.resolveTerminus(id);
      if (r) return r;
    }
    return null;
  }

  /** Cross-store fan of inboundSupersedes (board c6e3561f part (a)): an edge
   *  lives with its SOURCE record (addLink routes by source), so a record's
   *  inbound supersedes edges can sit in a DIFFERENT mounted store than the
   *  target itself — every mount is scanned and the hits merged, same
   *  reasoning as recordsBySlug's fan. DEDUPED BY ID (roster review F3,
   *  anti_pattern foreign_1896c79b): a record promoted into a domain store leaves a
   *  project-store tombstone behind, so the SAME source id can resolve out of
   *  two different mounts — first-seen (project-first, this.all()'s own
   *  ordering) wins, never a duplicate entry for one concept. */
  inboundSupersedes(id: string): ReturnType<SterlingStore['inboundSupersedes']> {
    const seen = new Set<string>();
    const out: ReturnType<SterlingStore['inboundSupersedes']> = [];
    for (const record of this.all().flatMap((s) => s.inboundSupersedes(id))) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
    }
    return out;
  }

  // -- record mutations: route to the store that HOLDS the record --------------
  // A record's scope decided where it lives at create time; a later change has to
  // land in that same store, so these route by where the id actually is — never
  // by the caller. (knowledge_update gets the record first, so supersede always
  // finds it; remove routes on its id the same way. addLink routes on the SOURCE
  // id — the edge lives with its source — and validates the TARGET mount-wide.)

  /** Versioned change in the holding store (a domain record supersedes in its
   *  domain store) — and the replacement's `scope` is pinned from THAT MOUNT.
   *
   *  THE LAYERING (decision
   *  [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
   *  SterlingStore.supersede pins the replacement's scope from the old row's
   *  `scope` COLUMN, which is correct for a BARE store: with no mounts there is
   *  nothing the column can contradict. Through THIS surface the column is not
   *  the strongest fact — the MOUNT is. In the one drift class a
   *  column-authoritative read cannot see (a row physically held by a domain
   *  store whose column says 'project'), inheriting the column would mint a
   *  brand-new row carrying the same lie, inside the very database that
   *  disproves it. So the mount is passed down as the authoritative scope and
   *  the column is not consulted.
   *
   *  WHY IT IS DERIVED FROM THE STORE THIS WRITE IS ROUTED TO, and not from a
   *  second lookup: `store` here IS the destination — the same resolution
   *  scopeOfHolder performs (mountNameOf ∘ storeHolding), reused rather than
   *  repeated. The label and the physical destination are therefore ONE fact,
   *  and cannot drift apart at this site by construction. Any third argument a
   *  caller supplies is deliberately ignored for the same reason: an
   *  authoritative scope is not something a caller can be trusted to know. */
  supersede(...args: Parameters<SterlingStore['supersede']>): ReturnType<SterlingStore['supersede']> {
    const store = this.mutatingStoreHolding('supersede', args[0]);
    return store.supersede(args[0], args[1], this.mountNameOf(store));
  }

  /** Promotion tombstone: retire the original in its (project) store, pointing at
   *  the cross-store replacement. The replacement already lives in another store
   *  (the promoted domain copy), so only the original's holding store is touched. */
  retireInFavorOf(...args: Parameters<SterlingStore['retireInFavorOf']>): ReturnType<SterlingStore['retireInFavorOf']> {
    return this.mutatingStoreHolding('retireInFavorOf', args[0]).retireInFavorOf(...args);
  }

  /** Hard delete (+ §3.2.7 drain log for system todos) in the holding store. */
  remove(...args: Parameters<SterlingStore['remove']>): ReturnType<SterlingStore['remove']> {
    return this.mutatingStoreHolding('remove', args[0]).remove(...args);
  }

  // -- the generalized IN-PLACE write triad (stable-identity S2, decision
  // [stable-identity-design-v2]) — same holding-store routing as supersede:
  // an in-place write must land on the row that actually exists, and the
  // version counter it bumps is that store's.

  /** knowledge_update-shaped in-place write in the holding store. */
  updateRecord(...args: Parameters<SterlingStore['updateRecord']>): ReturnType<SterlingStore['updateRecord']> {
    return this.mutatingStoreHolding('updateRecord', args[0]).updateRecord(...args);
  }

  /** NARROW server-owned metadata write (board 8c8b6d78 / R9) in the holding
   *  store — same routing as updateRecord, since it is the same in-place core
   *  with the body clock preserved. */
  updateRecordMetadata(...args: Parameters<SterlingStore['updateRecordMetadata']>): ReturnType<SterlingStore['updateRecordMetadata']> {
    return this.mutatingStoreHolding('updateRecordMetadata', args[0]).updateRecordMetadata(...args);
  }

  /** knowledge_edit-shaped exactly-once passage replace in the holding store. */
  editRecordField(...args: Parameters<SterlingStore['editRecordField']>): ReturnType<SterlingStore['editRecordField']> {
    return this.mutatingStoreHolding('editRecordField', args[0]).editRecordField(...args);
  }

  /** knowledge_append-shaped array growth in the holding store. */
  appendRecordField(...args: Parameters<SterlingStore['appendRecordField']>): ReturnType<SterlingStore['appendRecordField']> {
    return this.mutatingStoreHolding('appendRecordField', args[0]).appendRecordField(...args);
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
    return this.mutatingStoreHolding('updateTodo', args[0]).updateTodo(...args);
  }

  /** Typed link edge, added on the source record in its holding store. The TARGET
   *  is resolved across ALL mounted stores (cross-store get, like get()) before
   *  delegating: cross-store edges are a legitimate shape — promotion itself writes
   *  them (supersedes / informed_by across project↔domain) — and the holding
   *  store's local check cannot see a target mounted elsewhere, so it is told the
   *  target is already validated. */
  addLink(sourceId: string, rel: string, targetId: string): DurableRecord {
    // The target lookup is a cross-store READ and stays unrestricted inside a
    // transaction — only the edge WRITE, which lands on the SOURCE's holding
    // store, is bound to the active mount (decision
    // [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
    if (!this.get(targetId)) throw new Error(`addLink: no target record '${targetId}' in the project store or any mounted domain`);
    return this.mutatingStoreHolding('addLink', sourceId).addLink(sourceId, rel, targetId, true);
  }

  /** EVERY mounted store physically holding `id`, project-first. Ordinarily
   *  exactly one — a record lives in one store — which is precisely why the
   *  cardinality is returned rather than assumed away by a first-hit scan. */
  private holdersOf(id: string): SterlingStore[] {
    return this.all().filter((s) => s.get(id) !== undefined);
  }

  private storeHolding(id: string): SterlingStore {
    const holders = this.holdersOf(id);
    if (holders.length === 0) throw new Error(`no record '${id}' in the project store or any mounted domain`);
    // A DUPLICATE ID IS UNRESOLVABLE, NOT PROJECT-FIRST (decision
    // [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
    // This scan used to return the first hit, so an id present in two mounts
    // silently resolved to the project store (or to whichever domain the
    // manifest listed first) — while every other guarantee built on this method
    // (transaction affinity, holding-store routing, scopeOfHolder) assumes a
    // SINGLE holder, and would have been quietly deciding for the wrong row.
    // The audit verb already treats this shape as unresolvable (scope-audit C4
    // names every holder and picks no winner); the store layer now agrees with
    // it instead of guessing. True record-row duplicates may not be reachable
    // through today's write paths (promotion rebuilds under a NEW id, so the
    // domain copy and the project tombstone never share one) — that makes the
    // check cheap, not unnecessary: an assumption every guarantee rests on is
    // enforced, not assumed.
    if (holders.length > 1) {
      throw new Error(
        `ambiguous holder: record '${id}' is held by ${holders.length} mounts — ${holders.map((s) => `'${this.mountNameOf(s)}'`).join(', ')}. ` +
          `One id must name one row: every routing decision here (which store a write lands in, which mount a transaction opens on, what scope a ` +
          `derived record inherits) assumes a single holder, so the ambiguity is refused rather than resolved project-first. Resolve the duplicate ` +
          `(scripts/domain-doctor.mjs show --id '${id}' on each store) before retrying.`
      );
    }
    return holders[0];
  }

  /** MountedStores' override of the storage-layer scope accessor — 'project' or
   *  'domain:<name>', derived from the MOUNT that physically holds the record
   *  and from nothing else. See SterlingStore.scopeOfHolder for the contract
   *  this satisfies; the two differ only in what "physical" can mean at each
   *  layer, and here it means the strongest available fact. Deliberately NOT
   *  the row's `scope` column: the column is authoritative over the BODY, but
   *  the MOUNT is authoritative over the column — a record seeded into the
   *  wrong store carries a truthful-looking column and a false location, and
   *  that is the one drift class a column-authoritative read cannot see.
   *  Inherits storeHolding's two refusals: no holder, and multiple holders. */
  scopeOfHolder(id: string): string {
    return this.mountNameOf(this.storeHolding(id));
  }

  /** storeHolding for a WRITE: resolve the holder, then hold it against the
   *  active transaction's mount (the C2 backstop). Reads keep using
   *  storeHolding/all() directly — a cross-store READ is legitimate. */
  private mutatingStoreHolding(op: string, id: string): SterlingStore {
    const store = this.storeHolding(id);
    this.assertMountAffinity(op, store, `record '${id}'`);
    return store;
  }

  /** The project store for a PROJECT-LOCAL write (the board/maintenance
   *  queue, the drain log — the run/handoff protocol this comment used to
   *  name was removed per decision sterling-claude-code-scale-down-boundary,
   *  2ad87dd1), held against the active transaction's mount the same way. These
   *  forward straight to this.project, so inside a DOMAIN transaction they are
   *  the second cross-mount shape: a write that commits on the project
   *  connection while the open BEGIN belongs to a domain mount. */
  private mutatingProject(op: string): SterlingStore {
    this.assertMountAffinity(op, this.project, 'project-local run/board state');
    return this.project;
  }

  /** The mount name for a physical store — 'project', or the domain's manifest
   *  name. Used only in refusal text: the point of the guard is that a MOUNT is
   *  a physical thing, so it is named by where it actually is. */
  private mountNameOf(store: SterlingStore): string {
    if (store === this.project) return 'project';
    for (const [name, s] of this.domains) if (s === store) return `domain:${name}`;
    return 'unknown mount';
  }

  /**
   * THE CROSS-MOUNT WRITE BACKSTOP (decision
   * [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
   *
   * Each mount is a separate SQLite connection, so a write routed to a store
   * OTHER than the one holding the open transaction commits independently and
   * survives an outer rollback — the atomicity hole a correct `scope` label
   * cannot close on its own. Every mutation ROUTED THROUGH THIS CLASS'S OWN
   * SURFACE therefore compares its RESOLVED target store against the ACTIVE
   * TRANSACTION'S STORE IDENTITY (not a label string: a label is exactly the
   * thing that may be lying) and refuses, naming the record, the mount the
   * transaction holds, and the mount the target actually lives in. Outside a
   * transaction there is nothing to violate, so this is a no-op. Cross-store
   * READS are never affected.
   *
   * THAT QUALIFIER IS LOAD-BEARING, not throat-clearing: the public `project`
   * handle (see its own note above) is a mutable SterlingStore a caller can
   * write through without ever reaching this method. "Every mutation is
   * guarded" would be false while that escape hatch is public, so the claim is
   * scoped to what this class actually mediates.
   */
  private assertMountAffinity(op: string, target: SterlingStore, subject: string): void {
    const active = this.activeTransactionStore;
    if (active === undefined || active === target) return;
    throw new Error(
      `${op}: refused — cross-mount write while a transaction is open on the '${this.mountNameOf(active)}' mount, but ${subject} ` +
        `is held by the '${this.mountNameOf(target)}' mount. Each mount is a separate SQLite connection, so this write would ` +
        `commit independently and survive a rollback of the open transaction — it is refused rather than silently split across ` +
        `two connections. Route the transaction to the record's own mount (withTransactionForRecord), or perform this write ` +
        `outside the transaction.`
    );
  }

  // -- board/transient state: PROJECT-LOCAL, never a domain -------------------
  // The board/maintenance queue (§3.2.7) and check_skipped are project-scoped
  // by definition — they live in the project store, so MountedStores forwards
  // them straight through. Knowledge fans across mounts; this state does not.
  // The run/handoff protocol (createRun, getRun, casTransition,
  // casTransitionMerge, recordPendingExit/getPendingExit, appendRunEscalation,
  // appendRunReconcileNeeded, writeHandoff/readHandoffs, setRunReviewMandatory)
  // was removed with the staged pipeline (decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1).

  recordCheckSkipped(...args: Parameters<SterlingStore['recordCheckSkipped']>): ReturnType<SterlingStore['recordCheckSkipped']> {
    return this.mutatingProject('recordCheckSkipped').recordCheckSkipped(...args);
  }
  /** The drain log is project-local (§3.2.7) — forwarded like every board surface. */
  drainLogEntry(...args: Parameters<SterlingStore['drainLogEntry']>): ReturnType<SterlingStore['drainLogEntry']> {
    return this.mutatingProject('drainLogEntry').drainLogEntry(...args);
  }
  /** knowledge_split's multi-record write (decision
   *  compaction-tooling-windowed-read-plus-split) targets the PROJECT store
   *  only — feature_article is always project-scoped (§3.3), so the split's
   *  children-plus-parent transaction never needs to span a domain mount. */
  withTransaction<T>(fn: () => T): T {
    return this.runScopedTransaction(this.project, fn);
  }

  /** PER-RECORD transaction boundary — the affinity fix (decision
   *  [scope-drift-closed-by-column-authoritative-reads-not-format-change]).
   *  Routes by `storeHolding(id)`, the SAME physical resolution every record
   *  mutation uses, so the transaction and the writes inside it can never open
   *  on different mounts. The retired label-routed sibling
   *  (`withTransactionForScope`, deleted per decision
   *  [domain-held-subject-queue-items-close-two-step-named-mount-refusal-on-every-lane-label-routed-transaction-retired])
   *  resolved by storeFor(scope), and a record's body `scope` is caller-writable
   *  and not the routing key for anything after creation (anti_pattern
   *  [record-body-scope-is-not-physical-store-identity]) — so a drifted label
   *  put the transaction on the wrong database while the write went to the
   *  right one. A record that no record exists for throws loudly BEFORE any
   *  transaction opens, exactly as an unmounted scope does. */
  withTransactionForRecord<T>(id: string, fn: () => T): T {
    return this.runScopedTransaction(this.storeHolding(id), fn);
  }

  /** The PHYSICAL STORE whose transaction is currently open across THIS
   *  MountedStores instance (not per-physical-store — a physical store's own
   *  txDepth only knows about ITSELF). Two jobs, both keyed on store IDENTITY
   *  rather than on a scope label (which is exactly the value that can lie):
   *  it refuses a NESTED call that targets a DIFFERENT mount, and it is the
   *  reference every mutation's cross-mount backstop compares against (see
   *  assertMountAffinity). Opening a second BEGIN IMMEDIATE on a different
   *  SQLite connection while the outer transaction is still open would let the
   *  inner one commit independently, so a later failure in the outer
   *  transaction could no longer roll the inner write back — silently breaking
   *  atomicity. A nested call to the SAME mount still joins cleanly, because it
   *  reaches that store's reentrant `tx()` (txDepth). */
  private activeTransactionStore: SterlingStore | undefined;

  private runScopedTransaction<T>(store: SterlingStore, fn: () => T): T {
    if (this.activeTransactionStore !== undefined && this.activeTransactionStore !== store) {
      throw new Error(
        `nested transaction: cannot open a transaction on the '${this.mountNameOf(store)}' mount while a transaction on the ` +
          `'${this.mountNameOf(this.activeTransactionStore)}' mount is still open on this MountedStores — cross-mount transaction nesting ` +
          `is not supported (each mount is a separate SQLite connection; an inner commit could survive an outer rollback).`
      );
    }
    const isOutermost = this.activeTransactionStore === undefined;
    if (isOutermost) this.activeTransactionStore = store;
    try {
      return store.withTransaction(fn);
    } finally {
      if (isOutermost) this.activeTransactionStore = undefined;
    }
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
