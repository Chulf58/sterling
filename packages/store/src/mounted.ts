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
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { SterlingStore, type QueryOptions } from './index.js';
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
   *  store comes into being the first time a project's manifest mounts it. */
  constructor(projectDbPath: string, mounts: DomainMount[] = []) {
    this.project = open(projectDbPath);
    for (const m of mounts) this.domains.set(m.name, open(m.dbPath));
  }

  /** Scope-routed write (§3.3): project → the project store; domain:<name> → that
   *  domain store. Routing is MECHANICAL here; the tool layer owns the policy
   *  (feature_article always project, reference/research project-then-promote). */
  create(input: unknown): DurableRecord {
    const record = validateRecord(input);
    return this.storeFor(record.scope).create(record);
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
    const cap = opts.cap ?? 20;
    const merged = this.all().flatMap((s) => s.query(opts));
    return merged.slice(0, cap);
  }

  /** Cross-store fetch by id: project first, then domains. */
  get(id: string): DurableRecord | undefined {
    for (const s of this.all()) {
      const r = s.get(id);
      if (r) return r;
    }
    return undefined;
  }

  // -- record mutations: route to the store that HOLDS the record --------------
  // A record's scope decided where it lives at create time; a later change has to
  // land in that same store, so these route by where the id actually is — never
  // by the caller. (knowledge_update gets the record first, so supersede always
  // finds it; addLink/remove route on the source/target id the same way.)

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

  /** Typed link edge, added on the source record in its holding store. */
  addLink(...args: Parameters<SterlingStore['addLink']>): ReturnType<SterlingStore['addLink']> {
    return this.storeHolding(args[0]).addLink(...args);
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
  recordPendingExit(...args: Parameters<SterlingStore['recordPendingExit']>): ReturnType<SterlingStore['recordPendingExit']> {
    return this.project.recordPendingExit(...args);
  }
  getPendingExit(...args: Parameters<SterlingStore['getPendingExit']>): ReturnType<SterlingStore['getPendingExit']> {
    return this.project.getPendingExit(...args);
  }
  appendRunEscalation(...args: Parameters<SterlingStore['appendRunEscalation']>): ReturnType<SterlingStore['appendRunEscalation']> {
    return this.project.appendRunEscalation(...args);
  }
  recordCheckSkipped(...args: Parameters<SterlingStore['recordCheckSkipped']>): ReturnType<SterlingStore['recordCheckSkipped']> {
    return this.project.recordCheckSkipped(...args);
  }
  writeHandoff(...args: Parameters<SterlingStore['writeHandoff']>): ReturnType<SterlingStore['writeHandoff']> {
    return this.project.writeHandoff(...args);
  }
  readHandoffs(...args: Parameters<SterlingStore['readHandoffs']>): ReturnType<SterlingStore['readHandoffs']> {
    return this.project.readHandoffs(...args);
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
