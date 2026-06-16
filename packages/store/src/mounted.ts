// @sterling/store — MountedStores (spec §3.3): composes the project store with
// the project's mounted domain stores (the config.domains manifest). The project
// store holds project-scoped knowledge + all run/board/transient state; domain
// stores (at ~/.sterling/domains/<name>/, resolved by the caller) hold shared,
// cross-project knowledge. One retrieval interface (§3.4) fans across the mounted
// set PROJECT-FIRST; writes route by the record's `scope` (project | domain:<name>).
//
// Mechanism (decision 2026-06-16, store-internals are the implementor's choice
// per §12): composition over SQLite ATTACH — each store is a self-contained,
// already-tested SterlingStore; this layer only mounts, routes, and merges.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SterlingStore, type QueryOptions } from './index.js';
import { validateRecord, type DurableRecord } from '@sterling/schemas';

/** A domain store to mount: its manifest name + its already-resolved DB path. */
export interface DomainMount {
  name: string;
  dbPath: string;
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
