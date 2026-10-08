// @sterling/store — MountedStores (spec §3.3): composes the project store with
// the project's mounted domain stores (the config.stack_tags manifest). The project
// store holds project-scoped knowledge + all run/board/transient state; domain
// stores (at ~/.sterling/domains/<name>/, resolved by the caller) hold shared,
// cross-project knowledge. One retrieval interface (§3.4) fans across the mounted
// set, project first, with each store's share of the cap set by allocateShares
// (shares.ts); writes route by the record's `scope` (project | domain:<name>).
//
// Mechanism (decision 2026-06-16, store-internals are the implementor's choice
// per §12): composition over SQLite ATTACH — each store is a self-contained,
// already-tested SterlingStore; this layer only mounts, routes, and merges.
import { mkdirSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { SterlingStore, SchemaMigrationRequiredError, StoreRowDecodeError, UnsupportedSchemaVersionError, DEFAULT_QUERY_CAP, assertNoFieldLoss, type QueryOptions, type BoardItemReadiness, type WriteOptions } from './index.js';
import { validateRecord, type DurableRecord, type SterlingConfig } from '@sterling/schemas';
import { allocateShares } from './shares.js';
import { PgBridgeClosedError, PgBridgeTimeoutError, PgQueryError, PgWorkerDiedError } from './pg-bridge.js';
import { PgLockTimeoutError, PgNulCharacterError, PgStatementTimeoutError, PgStoreMissingError } from './pg-driver.js';

/** A domain store to mount: its manifest name + its already-resolved DB path. */
export interface DomainMount {
  name: string;
  dbPath: string;
}

/** A mounted domain whose store failed a read and was dropped from every later
 *  read: its manifest name, its DB path, the error text of the failing read,
 *  and a note saying when it was dropped and that the session must restart
 *  before it is read again. */
export interface UnreadableDomain {
  name: string;
  dbPath: string;
  error: string;
  note: string;
}

/** §3.3: the project's config.stack_tags list is the domain mount manifest and
 *  nothing else. It does NOT filter retrieval: a query's own `stack_tags` option
 *  is a separate, caller-supplied filter (decision
 *  projects-mount-domains-and-sibling-projects corrected the older claim that
 *  the two were the same list). Each tag mounts a store at
 *  ~/.sterling/domains/<tag>/sterling.db by default; config.domain_paths overrides
 *  the path per tag (spec line 94). The ONE resolver every MountedStores caller
 *  uses, so the mounted set and the snapshotted set can never drift apart. */
export function resolveDomainMounts(config: SterlingConfig): DomainMount[] {
  return config.stack_tags.map((name) => ({
    name,
    dbPath: config.domain_paths[name] ?? join(homedir(), '.sterling', 'domains', name, 'sterling.db'),
  }));
}

/** Open a store at dbPath, creating the file and its parent dir when absent.
 *  MountedStores uses this for the PROJECT store and for domain stores that
 *  already exist; a missing domain is never created here (see createDomain). */
function open(dbPath: string, busyTimeoutMs: number | undefined): SterlingStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new SterlingStore(dbPath, { busyTimeoutMs });
}

/** An id no record has, for the mount-time read check (probeDomain). */
const PROBE_ID = '00000000-0000-0000-0000-000000000000';

/** UnreadableDomain.note for a domain dropped by a read after mount. A failure
 *  at that point may be transient (a locked file), and the drop is not retried,
 *  so the disclosure says how long it lasts. */
const DROPPED_AFTER_MOUNT_NOTE = 'dropped after mount; reads skip it until the session restarts';

/** UnreadableDomain.note for a domain dropped by the mount-time check. */
const DROPPED_AT_MOUNT_NOTE = 'dropped at mount; restart the session after the store is repaired';

/** True for a failure of the STORE under an open or a read, the only kind that
 *  drops a domain: an error node:sqlite raised (every one carries code
 *  'ERR_SQLITE_ERROR'; this includes a file that is not a database), the
 *  store's own pre-v2 refusal, its refusal to open a newer schema, or a row
 *  whose body does not decode. Anything else (a ZodError for a bad option, a
 *  TypeError or RangeError from a bug here, a SyntaxError raised outside the
 *  row decoder) is the caller's or this code's fault, so the guard rethrows it
 *  and drops nothing. */
function isStoreFailure(e: unknown): boolean {
  return (
    e instanceof SchemaMigrationRequiredError ||
    e instanceof UnsupportedSchemaVersionError ||
    e instanceof StoreRowDecodeError ||
    (e as { code?: unknown } | null)?.code === 'ERR_SQLITE_ERROR'
  );
}

/** True for a failure of a Postgres-backed store under an open or a read: a
 *  missing store, a server refusal, a timeout, or a lost connection. Only a
 *  work-mode MountedStores consults it. */
function isPgStoreFailure(e: unknown): boolean {
  return (
    e instanceof PgStoreMissingError ||
    e instanceof PgQueryError ||
    e instanceof PgLockTimeoutError ||
    e instanceof PgStatementTimeoutError ||
    e instanceof PgNulCharacterError ||
    e instanceof PgBridgeClosedError ||
    e instanceof PgBridgeTimeoutError ||
    e instanceof PgWorkerDiedError
  );
}

const errorText = (e: unknown): string => String((e as Error)?.message ?? e);

/** Postgres storage (routing.ts, the `work` option): a mounted domain that is
 *  missing or cannot be read. It never skips or drops a domain (decision
 *  postgres-store-backend-design-sync-bridge-schema-per-store, point 6): the
 *  open or the read fails, naming the domain, and `cause` carries the
 *  store's own error. */
export class DomainUnavailableError extends Error {
  readonly domain: string;
  readonly location: string;
  constructor(domain: string, location: string, cause: unknown) {
    super(
      `storage 'postgres': domain '${domain}' (${location}) is missing or cannot be read: ${errorText(cause)}. ` +
        `Postgres storage never skips or drops a mounted domain; the call fails and nothing was written.`,
      { cause }
    );
    this.name = 'DomainUnavailableError';
    this.domain = domain;
    this.location = location;
  }
}

/** How a work-mode MountedStores opens its stores (routing.ts supplies it).
 *  Neither opener may create a store. */
export interface WorkStoreOpeners {
  openProject(): SterlingStore;
  openDomain(mount: DomainMount): SterlingStore;
}

export interface MountedStoresOptions {
  /** Hobby only: skip a configured domain whose store file is missing, listing it on missingDomains. Ignored with `work`. */
  skipMissing?: boolean;
  /** Postgres storage (routing.ts): open through these, never create a store, and throw DomainUnavailableError wherever the SQLite path would skip or drop a domain. */
  work?: WorkStoreOpeners;
  /** SQLite busy timeout in milliseconds for every store opened here (project and domains). Unset keeps the store default (5000). Ignored with `work`. */
  busyTimeoutMs?: number;
}

/** The store_meta key that holds a domain's description. */
export const DOMAIN_DESCRIPTION_KEY = 'description';

/** A mounted domain whose store does not exist yet. Domains are no longer created
 *  lazily on first mount: a new domain needs a description, and only
 *  createDomain takes one (board 675daf9d (c), decision
 *  projects-mount-domains-and-sibling-projects: "creating a domain without one
 *  fails loud"). */
/** The mounted stores rank on different score scales (e.g. one on SQLite, one on Postgres). */
export class MixedScoreScaleError extends Error {
  constructor(
    operation: string,
    readonly scales: { source: string; scale: string }[],
  ) {
    super(
      `${operation}: the mounted stores rank on different score scales (${scales.map((x) => `${x.source}: ${x.scale}`).join(', ')}), so a min_score cannot be applied across them. Nothing was counted.`
    );
    this.name = 'MixedScoreScaleError';
  }
}

export class DomainNotCreatedError extends Error {
  readonly domain: string;
  readonly db_path: string;
  constructor(domain: string, dbPath: string) {
    super(
      `domain '${domain}' has no store at '${dbPath}'. Domain stores are not created on first mount: create it with ` +
        `createDomain('${domain}', <description>, <dbPath>), where the description says which knowledge belongs in this domain. ` +
        `To mount only the domains that already exist, pass { skipMissing: true }.`
    );
    this.name = 'DomainNotCreatedError';
    this.domain = domain;
    this.db_path = dbPath;
  }
}

/** The one-line warning for a configured domain that was skipped because its
 *  store does not exist. Shared by every caller that mounts with skipMissing
 *  and announces the skip, so the wording cannot drift between them. */
export function missingDomainWarning(m: DomainMount): string {
  return (
    `sterling: domain '${m.name}' is configured but has no store at '${m.dbPath}'; it is NOT mounted, ` +
    `so its knowledge is not read and writes to scope domain:${m.name} are refused. ` +
    `Create it with createDomain (a description is required), or run init to set it up.`
  );
}

/**
 * Create a NEW domain store at dbPath and record its description (store_meta key
 * 'description'). The one way a domain store comes into being. Fails loud, with
 * no file left behind, when the description is missing or blank or when a store
 * already exists at dbPath (an existing domain is described with setMeta on its
 * store, not re-created).
 *
 * The file is claimed with an exclusive create (O_EXCL) before SQLite opens it,
 * so a store another process creates at the same path in the meantime is never
 * adopted, re-described, or deleted by this call's cleanup: that call fails with
 * the already-exists error instead. SQLite opens the empty file as a new database.
 */
export function createDomain(name: string, description: string, dbPath: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('createDomain: a domain name is required');
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`createDomain: domain '${name}' needs a description saying which knowledge belongs in it; none was given, so nothing was created`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    closeSync(openSync(dbPath, 'wx'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`createDomain: a store for domain '${name}' already exists at '${dbPath}'; set its description on that store instead of re-creating it`);
    }
    throw e;
  }
  let store: SterlingStore | undefined;
  try {
    store = new SterlingStore(dbPath);
    store.setMeta(DOMAIN_DESCRIPTION_KEY, description.trim());
  } catch (e) {
    store?.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(dbPath + suffix, { force: true });
    throw e;
  }
  store.close();
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

  /** Configured domains skipped under skipMissing because their store does not
   *  exist, in manifest order. Kept so a caller (boot, a tool response, H1) can
   *  disclose the skip instead of the domain silently vanishing. */
  readonly missingDomains: DomainMount[] = [];

  /** Mounted domains whose store failed a read, in the order they were dropped.
   *  One broken domain must not fail a read over the whole mounted set, so a
   *  domain read that throws drops that domain from every later read and lists
   *  it here with the error; a caller (a tool response, boot) discloses it
   *  instead of the domain silently vanishing. Checked at mount (probeDomain)
   *  and on every fanned read. The drop lasts for this instance's lifetime:
   *  a later read does not retry the store. It covers READS only: the domain
   *  stays in domainNames(), but every write into it is refused
   *  (assertWritable), and the slug uniqueness checks still ask it
   *  (slugHolders). The PROJECT store is never listed here: its failure
   *  throws. */
  readonly unreadableDomains: UnreadableDomain[] = [];
  private readonly domainPaths = new Map<string, string>();
  /** Every configured domain whose store file exists, in manifest order,
   *  whether or not it could be opened. */
  private readonly mountedNames: string[] = [];

  /** Set for Postgres storage; see MountedStoresOptions.work. */
  private readonly work: WorkStoreOpeners | undefined;

  /** The project store is opened, and created when absent; a failure to open
   *  it throws. A domain store is only ever OPENED here, never created, and one
   *  that exists but cannot be opened is listed on unreadableDomains instead of
   *  failing the mount: a mount whose db file does not exist
   *  throws DomainNotCreatedError naming createDomain (board 675daf9d (c)), with
   *  every handle opened so far closed and no file written for the missing
   *  domain. When options.skipMissing is true such a mount is skipped instead,
   *  and the existing siblings are still mounted. An existing domain store opens
   *  as it is, whether or not it has a description.
   *
   *  Postgres storage (options.work, routing.ts) differs in three ways: both stores
   *  are opened through the given openers, which never create a store;
   *  skipMissing is ignored; and every case above that lists a domain on
   *  missingDomains or unreadableDomains throws DomainUnavailableError instead,
   *  with every handle opened so far closed. */
  constructor(projectDbPath: string, mounts: DomainMount[] = [], options?: MountedStoresOptions) {
    this.work = options?.work;
    if (this.work) {
      this.project = this.work.openProject();
      try {
        for (const m of mounts) {
          this.mountedNames.push(m.name);
          this.domainPaths.set(m.name, m.dbPath);
          let store: SterlingStore;
          try {
            store = this.work.openDomain(m);
          } catch (e) {
            if (!this.isStoreFailure(e)) throw e;
            throw new DomainUnavailableError(m.name, m.dbPath, e);
          }
          this.domains.set(m.name, store);
          this.probeDomain(m.name, store);
        }
      } catch (e) {
        this.close();
        throw e;
      }
      return;
    }
    this.project = open(projectDbPath, options?.busyTimeoutMs);
    try {
      for (const m of mounts) {
        if (!existsSync(m.dbPath)) {
          if (options?.skipMissing) {
            this.missingDomains.push({ name: m.name, dbPath: m.dbPath });
            continue;
          }
          throw new DomainNotCreatedError(m.name, m.dbPath);
        }
        this.mountedNames.push(m.name);
        this.domainPaths.set(m.name, m.dbPath);
        // A domain store that cannot be OPENED is dropped like one that fails
        // the probe: listed unreadable, skipped by reads, refused by writes.
        // It has no handle, so nothing can ask it, slug checks included.
        let store: SterlingStore;
        try {
          store = new SterlingStore(m.dbPath, { busyTimeoutMs: options?.busyTimeoutMs });
        } catch (e) {
          if (!isStoreFailure(e)) throw e;
          this.dropDomain(m.name, e, true);
          continue;
        }
        this.domains.set(m.name, store);
        this.probeDomain(m.name, store);
      }
    } catch (e) {
      this.close();
      throw e;
    }
  }

  /** Mount-time read check. A pre-v2 store opens and answers some reads (get,
   *  query over pre-v2 bodies) but not others (inboundSupersedes: it has no
   *  record_relations table), so without this a first tool call could serve
   *  that domain's records and then drop it halfway through. The probe runs the
   *  two per-record reads the fan makes, against an id no record has, and drops
   *  the domain when either throws. */
  private probeDomain(name: string, store: SterlingStore): void {
    try {
      store.get(PROBE_ID);
      store.inboundSupersedes(PROBE_ID);
    } catch (e) {
      if (!this.isStoreFailure(e)) throw e;
      this.dropDomain(name, e, true);
    }
  }

  /** Drop a domain from reads. The drop lasts for this instance's lifetime:
   *  no later read retries the store, even when the failure was transient. That
   *  is safe to leave because a dropped domain cannot be written either
   *  (assertWritable): a session never writes into a store it cannot read back,
   *  and the slug checks still ask it (fanEveryDomain). */
  private dropDomain(name: string, e: unknown, atMount = false): void {
    // Postgres storage drops nothing: the failing open or read throws, naming the domain.
    if (this.work) throw new DomainUnavailableError(name, this.domainPaths.get(name) ?? '', e);
    if (this.isUnreadable(name)) return;
    this.unreadableDomains.push({
      name,
      dbPath: this.domainPaths.get(name) ?? '',
      error: errorText(e),
      note: atMount ? DROPPED_AT_MOUNT_NOTE : DROPPED_AFTER_MOUNT_NOTE,
    });
  }

  /** The failures that drop a domain in hobby mode and fail the call in work
   *  mode; any other error is the caller's or this code's fault and is rethrown. */
  private isStoreFailure(e: unknown): boolean {
    return isStoreFailure(e) || (this.work !== undefined && isPgStoreFailure(e));
  }

  private isUnreadable(name: string): boolean {
    return this.unreadableDomains.some((d) => d.name === name);
  }

  /** `(<error>; <note>)` for a dropped domain, for refusal text. */
  private droppedReason(name: string): string {
    const d = this.unreadableDomains.find((x) => x.name === name);
    return d ? `(${d.error}; ${d.note})` : '';
  }

  /** Refuse a write into a domain this session has dropped from reads: the
   *  write could not be read back, and a promotion would retire the project
   *  original in favour of a copy nobody can see. */
  private assertWritable(name: string): void {
    if (!this.isUnreadable(name)) return;
    throw new Error(
      `domain '${name}' cannot be written: this session cannot read it ${this.droppedReason(name)}. Nothing was written. ` +
        `Repair the store, then restart the session.`
    );
  }

  /** `fn` on the project store and then on EVERY mounted domain, dropped ones
   *  included, for a check where "not read" must never count as "absent" (slug
   *  uniqueness). A dropped domain that still answers is believed. A domain
   *  whose read fails makes the whole check refuse, naming it and the error. */
  private fanEveryDomain<T>(what: string, fn: (store: SterlingStore) => T): T[] {
    const out = [fn(this.project)];
    for (const [name, store] of this.domains) {
      try {
        out.push(fn(store));
      } catch (e) {
        if (!this.isStoreFailure(e)) throw e;
        this.dropDomain(name, e);
        throw new Error(
          `${what} cannot be checked: domain '${name}' could not be read (${errorText(e)}), so whether it is taken there is unknown. ` +
            `Nothing was written. Repair the store, then restart the session.`
        );
      }
    }
    return out;
  }

  /** The one read fan: `fn` on the project store, then on each readable domain
   *  in manifest order, yielding each answer with its source ('project' or the
   *  domain's manifest name). The project read is NOT guarded, so its failure
   *  throws. A domain read that fails with a store failure (isStoreFailure)
   *  drops that domain (dropDomain) and the fan moves on; any other error is
   *  rethrown. Lazy, so a first-hit caller stops reading at its hit. */
  private *fanRead<T>(fn: (store: SterlingStore) => T): Generator<{ source: string; store: SterlingStore; value: T }> {
    yield { source: 'project', store: this.project, value: fn(this.project) };
    for (const [name, store] of [...this.domains]) {
      if (this.isUnreadable(name)) continue;
      let value: T;
      try {
        value = fn(store);
      } catch (e) {
        if (!this.isStoreFailure(e)) throw e;
        this.dropDomain(name, e);
        continue;
      }
      yield { source: name, store, value };
    }
  }

  /** fanRead's answers alone, project first. */
  private fanValues<T>(fn: (store: SterlingStore) => T): T[] {
    return [...this.fanRead(fn)].map((r) => r.value);
  }

  /** A mounted domain's description (store_meta 'description'), or undefined
   *  when that existing store has none. An unmounted name is refused. */
  domainDescription(name: string): string | undefined {
    const store = this.domains.get(name);
    if (!store && this.isUnreadable(name)) throw new Error(`domainDescription: domain '${name}' cannot be read ${this.droppedReason(name)}`);
    if (!store) throw new Error(`domainDescription: domain '${name}' is not mounted`);
    return store.getMeta(DOMAIN_DESCRIPTION_KEY);
  }

  /** Set a mounted domain's description (store_meta 'description'), trimmed,
   *  on that domain's own store. The write path for an existing domain;
   *  createDomain sets it for a new one. An unmounted name and a blank
   *  description are refused with nothing written, and so is a call inside a
   *  transaction open on another mount (the same affinity rule as every write
   *  through this class). */
  setDomainDescription(name: string, description: string): void {
    this.assertWritable(name);
    const store = this.domains.get(name);
    if (!store) throw new Error(`setDomainDescription: domain '${name}' is not mounted`);
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new Error(`setDomainDescription: the description for domain '${name}' is blank; nothing was written`);
    }
    this.assertMountAffinity('setDomainDescription', store, `domain '${name}'`);
    store.setMeta(DOMAIN_DESCRIPTION_KEY, description.trim());
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
  create(input: unknown, options: WriteOptions = {}): DurableRecord {
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
    return target.create(record, options);
  }

  /** Scope-routed exactly as create() is. A maintenance item is project-LOCAL
   *  state and never shared, so this resolves to the project store in practice —
   *  and the dedup key is therefore evaluated within that ONE store rather than
   *  across the fan, which is right: two projects' queues are independent, and a
   *  cross-store key would let one project's item suppress another's. */
  enqueueSystemTodo(input: unknown, options: WriteOptions = {}): { record: DurableRecord; deduped: boolean; text_updated: boolean } {
    // Same normalize-then-validate order as create(), for the same reason.
    const record = validateRecord(SterlingStore.normalizeIdentityEnvelope(input));
    const target = this.storeFor(record.scope);
    this.assertMountAffinity('enqueueSystemTodo', target, `todo '${record.id}' (scope '${record.scope}')`);
    return target.enqueueSystemTodo(record, options);
  }

  /** Read-only twin of enqueueSystemTodo: queue items are project-local, so the
   *  precheck asks the project store only (same reasoning as the enqueue above). */
  enqueueWouldBeNoop(input: { system_reason: string; feature_link?: string; file_keys?: string[]; text: string }): boolean {
    return this.project.enqueueWouldBeNoop(input);
  }

  /** Board readiness is project-local like the board itself, so the project
   *  store answers it (decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start). */
  boardReadiness(items?: readonly DurableRecord[]): BoardItemReadiness[] {
    return this.project.boardReadiness(items);
  }

  private storeFor(scope: string): SterlingStore {
    if (scope === 'project') return this.project;
    const m = /^domain:(.+)$/.exec(scope);
    if (m) {
      this.assertWritable(m[1]);
      const store = this.domains.get(m[1]);
      if (!store) throw new Error(`scope '${scope}' targets an unmounted domain — not in the project's domains manifest`);
      return store;
    }
    throw new Error(`unroutable scope '${scope}'`);
  }

  /** Cross-store retrieval (§3.4) with read shares (board 675daf9d (b)): every
   *  mounted store runs the full filter→join→rank→cap on its own, allocateShares
   *  decides how many of each store's results make the cap (the project up to
   *  ceil(0.6 x cap) when a domain has matches, the rest split across domains,
   *  unused share spilling over), and each store's top-N is concatenated project
   *  first, then domains in manifest order. Scores are never compared across
   *  databases. When only the project matches it fills the cap, as before. */
  query(opts: QueryOptions = {}): DurableRecord[] {
    const cap = opts.cap ?? DEFAULT_QUERY_CAP;
    const perStore = this.fanValues((s) => s.query({ ...opts, cap }));
    const shares = allocateShares(perStore.map((r) => r.length), cap);
    return perStore.flatMap((records, i) => records.slice(0, shares[i]));
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
    this.commonScoreScale('countAboveScore');
    return this.fanValues((s) => s.countAboveScore(opts, minScore)).reduce((n, c) => n + c, 0);
  }

  /** The one score scale every mounted store ranks on (SterlingStore.scoreScale). Mixed scales are refused: neither their scores nor their counts above one min_score compare. */
  scoreScale(): string {
    return this.commonScoreScale('scoreScale');
  }

  private commonScoreScale(operation: string): string {
    const scales = [...this.fanRead((s) => s.scoreScale())].map((r) => ({ source: r.source, scale: r.value }));
    if (new Set(scales.map((x) => x.scale)).size > 1) throw new MixedScoreScaleError(operation, scales);
    return scales[0].scale;
  }

  /** Per-source projection (AC2): project store FIRST, then each mounted domain
   *  in manifest order. Each store runs the full query independently — type
   *  filter, file-key join, cap, and match_all are all PER-STORE (never a
   *  global slice across the merged result). Zero domains → exactly one entry.
   *  The source name is 'project' for the project store and the domain manifest
   *  name (DomainMount.name) for each domain store. */
  bySource(opts?: QueryOptions): { source: string; records: DurableRecord[] }[] {
    return [...this.fanRead((s) => s.query(opts))].map((r) => ({ source: r.source, records: r.value }));
  }

  /** bySource for each entry of `list` in one pass: per store, project first,
   *  one SterlingStore.queryEach (one read transaction), so `results[i]` is
   *  that store's bySource(list[i]) records. */
  bySourceEach(list: readonly QueryOptions[]): { source: string; results: DurableRecord[][] }[] {
    return [...this.fanRead((s) => s.queryEach(list))].map((r) => ({ source: r.source, results: r.value }));
  }

  /** Count-only per-source projection — the COUNT(*) twin of bySource (same
   *  project-first, per-store ordering) with NO body fetch. The TUI Knowledge
   *  tree's collapsed category/source badges use this so the default all-collapsed
   *  view does not fetch + parse every source's record bodies each frame. */
  countBySource(opts?: QueryOptions): { source: string; count: number }[] {
    return [...this.fanRead((s) => s.count(opts))].map((r) => ({ source: r.source, count: r.value }));
  }

  /** Records from ONE named source ('project' or a mounted domain name) — the
   *  full §3.4 query against that single store. The TUI fetches bodies only for
   *  the source the user actually expanded; an unknown source yields [], and so
   *  does a domain that is, or on this read becomes, unreadable. */
  querySource(source: string, opts: QueryOptions = {}): DurableRecord[] {
    if (source === 'project') return this.project.query(opts);
    const store = this.domains.get(source);
    if (!store || this.isUnreadable(source)) return [];
    try {
      return store.query(opts);
    } catch (e) {
      if (!this.isStoreFailure(e)) throw e;
      this.dropDomain(source, e);
      return [];
    }
  }

  /** Cross-store fetch by id: project first, then domains. */
  get(id: string): DurableRecord | undefined {
    for (const { value } of this.fanRead((s) => s.get(id))) {
      if (value) return value;
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
    return this.fanValues((s) => s.recordIdIndex()).flat();
  }

  /** Project-first concatenation of every mounted store's dead-id alias index
   *  ([stable-identity-design-v2] contract 3) — same reasoning as
   *  recordIdIndex: a historical id cited anywhere may have belonged to a
   *  record that now lives in a domain store, so resolution MUST span mounts.
   *  A historical id is unique across the fan (it was one record's id), so no
   *  dedup is needed. */
  recordAliases(): ReturnType<SterlingStore['recordAliases']> {
    return this.fanValues((s) => s.recordAliases()).flat();
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
    return this.fanValues((s) => s.articlesBySlug(slug)).flat();
  }

  /** Type-agnostic exact-slug lookup across the fan, PROJECT-FIRST (board
   *  1e639f32) — same over-detect-is-safe reasoning as articlesBySlug: its
   *  callers are a uniqueness refusal and an identity resolution, and both
   *  would rather see a domain-store record than miss one. */
  recordsBySlug(slug: string): DurableRecord[] {
    return this.fanValues((s) => s.recordsBySlug(slug)).flat();
  }

  /** recordsBySlug for a UNIQUENESS check: every mounted domain is asked,
   *  dropped ones included (fanEveryDomain), so a slug held by a record in a
   *  dropped domain still counts as taken, and a domain that cannot answer
   *  makes the check refuse instead of passing. Identity resolution keeps using
   *  recordsBySlug, which skips a dropped domain and says so. */
  slugHolders(slug: string): DurableRecord[] {
    return this.fanEveryDomain(`slug '${slug}'`, (s) => s.recordsBySlug(slug)).flat();
  }

  /** articlesBySlug for a uniqueness check; same rule as slugHolders. */
  articleSlugHolders(slug: string): DurableRecord[] {
    return this.fanEveryDomain(`slug '${slug}'`, (s) => s.articlesBySlug(slug)).flat();
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
    return this.fanValues((s) => s.supersededRecordsBySlug(slug))
      .flat()
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  /** Cross-store terminus resolution (decision foreign_de1a7329): a record lives in
   *  exactly one store (same reasoning as get()), so this tries each mounted
   *  store project-first and returns the first hit. */
  resolveTerminus(id: string): ReturnType<SterlingStore['resolveTerminus']> {
    for (const { value } of this.fanRead((s) => s.resolveTerminus(id))) {
      if (value) return value;
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
   *  two different mounts — first-seen (project-first, the read fan's own
   *  ordering) wins, never a duplicate entry for one concept. */
  /** inboundSupersedes() for each id: per store one SterlingStore.inboundSupersedesEach,
   *  merged per id exactly as inboundSupersedes merges (project first, first seen wins). */
  inboundSupersedesEach(ids: readonly string[]): DurableRecord[][] {
    const perStore = this.fanValues((s) => s.inboundSupersedesEach(ids));
    return ids.map((_, i) => {
      const seen = new Set<string>();
      const out: DurableRecord[] = [];
      for (const lists of perStore) {
        for (const record of lists[i] ?? []) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          out.push(record);
        }
      }
      return out;
    });
  }

  inboundSupersedes(id: string): ReturnType<SterlingStore['inboundSupersedes']> {
    const seen = new Set<string>();
    const out: ReturnType<SterlingStore['inboundSupersedes']> = [];
    for (const record of this.fanValues((s) => s.inboundSupersedes(id)).flat()) {
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
   *  authoritative scope is not something a caller can be trusted to know.
   *  The fourth argument (WriteOptions: operation_id) passes through. */
  supersede(...args: Parameters<SterlingStore['supersede']>): ReturnType<SterlingStore['supersede']> {
    const store = this.mutatingStoreHolding('supersede', args[0]);
    return store.supersede(args[0], args[1], this.mountNameOf(store), args[3]);
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
    if (!this.get(targetId)) throw new Error(`addLink: no target record '${targetId}' in the project store or any mounted domain${this.unreadableNote()}`);
    return this.mutatingStoreHolding('addLink', sourceId).addLink(sourceId, rel, targetId, true);
  }

  /** EVERY mounted store physically holding `id`, project-first. Ordinarily
   *  exactly one — a record lives in one store — which is precisely why the
   *  cardinality is returned rather than assumed away by a first-hit scan. */
  private holdersOf(id: string): SterlingStore[] {
    const holders = [...this.fanRead((s) => s.get(id) !== undefined)].filter((r) => r.value).map((r) => r.store);
    // A dropped domain is asked too, so an id it holds is neither reported
    // absent nor missed by the duplicate-holder check in storeHolding. When its
    // get fails as well, it cannot be asked at all: the caller's "no record"
    // refusal then names it as not read (unreadableNote).
    for (const [name, store] of this.domains) {
      if (!this.isUnreadable(name)) continue;
      try {
        if (store.get(id) !== undefined) holders.push(store);
      } catch (e) {
        if (!isStoreFailure(e)) throw e;
      }
    }
    return holders;
  }

  /** ' Not read: domain <name> (<error>)...' for a refusal that says a record
   *  was not found, so a miss caused by a dropped domain is not read as absence. */
  private unreadableNote(): string {
    if (!this.unreadableDomains.length) return '';
    return `. Not read: ${this.unreadableDomains.map((d) => `domain '${d.name}' (${d.error}; ${d.note})`).join('; ')}`;
  }

  private storeHolding(id: string): SterlingStore {
    const holders = this.holdersOf(id);
    if (holders.length === 0) throw new Error(`no record '${id}' in the project store or any mounted domain${this.unreadableNote()}`);
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
    // A sole holder this session cannot read is not a routing target: a read
    // through it would serve what every other read hides, and a write could
    // not be read back.
    for (const [name, store] of this.domains) {
      if (store === holders[0] && this.isUnreadable(name)) {
        throw new Error(
          `record '${id}' is held by domain '${name}', which this session cannot read ${this.droppedReason(name)}. ` +
            `Nothing was read or written. Repair the store, then restart the session.`
        );
      }
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

  /** Mounted domain names, in manifest order. Includes a domain listed on
   *  unreadableDomains: it is still configured, though neither read nor written. */
  domainNames(): string[] {
    return [...this.mountedNames];
  }

  close(): void {
    for (const s of this.all()) s.close();
  }

  private all(): SterlingStore[] {
    return [this.project, ...this.domains.values()];
  }
}
