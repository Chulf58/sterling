// domain-doctor [S] (board 4cb9d525): forensics + GUARDED repair for the shared
// domain stores under the per-user roots. The incident class it exists for:
// a record promoted to a domain store resolves in NO store any session mounts —
// a domains-root/homedir flip (native Windows ↔ WSL both ran on this machine)
// strands the old store file, and §2.3 lazy-create silently shadows it with a
// fresh empty one. The project store still holds the promotion tombstone whose
// superseded_by dangles at the lost copy, so the CONTENT survives — what is
// missing is a sanctioned way to see the stranding and repair it (H15 rightly
// denies ad-hoc shell access to store files; this script is the sanctioned
// probe, listed in config.store_guard.allow_scripts).
//
//   node scripts/domain-doctor.mjs scan [--roots <dir,dir>]
//     List every domain store file under each root: record count, scope/type
//     breakdown, clock range, first/last record ids. Default roots: this
//     context's <home>/.sterling/domains plus, under WSL, the Windows-side
//     /mnt/c/Users/<user>/.sterling/domains when it exists — the two contexts
//     this machine actually runs (the flip between them is the leading
//     stranding cause). READ-ONLY.
//
//   node scripts/domain-doctor.mjs sweep --project <dir> [--roots <dir,dir>]
//     Every superseded_by pointer in the project's store whose target resolves
//     in NO store — not the project store, not a mounted domain, not any store
//     under the roots. Exit 3 when dangling pointers exist (0 clean). READ-ONLY.
//
//   node scripts/domain-doctor.mjs restore --project <dir> --tombstone <id> --domain <name> [--apply]
//     Recreate a lost promoted copy FROM the tombstone body, UNDER THE DANGLING
//     ID (tombstone.superseded_by) — so the tombstone's server-owned pointer
//     becomes consistent again without hand-editing it — with scope
//     domain:<name>, status active, and the same informed_by-origin link
//     knowledge_promote writes. Content fields are copied verbatim; clocks are
//     stamped at restore time (the restore is an event, not a forgery of the
//     original write). REFUSES when the target id already resolves anywhere.
//     Dry-run by default; --apply writes (and lazily creates the domain store,
//     which is the normal §2.3 mount behavior).
//
//   node scripts/domain-doctor.mjs show --db <db> --id <id>
//     READ-ONLY forensic read of ONE record, working on a store at ANY schema
//     version (unlike migrate, this never refuses a pre-v2 store — reading a
//     stuck store, e.g. deepdots at user_version 0, is the whole point; board
//     d055b150). A retired v2 record's successor comes from record_relations
//     (rel='supersedes', target_id = the resolved id), NEVER from the body,
//     because storableBody drops status/superseded_by from every persisted v2
//     record (packages/store/src/index.ts:598-604) — a show that only printed
//     the body would show no successor at all for a retired v2 record. On a
//     pre-v2 store the legacy body's own superseded_by is what's printed (no
//     v2 tables exist to query), and every raw row sharing the requested id is
//     printed and every distinct superseded_by claimant named — MULTIPLE
//     claimants are a FINDING to report, never collapsed to one. Also reports
//     record_aliases historical ids resolving to the record and the
//     record_versions snapshot COUNT. Id resolution: an exact id always wins;
//     otherwise an unambiguous prefix resolves and an ambiguous one is refused
//     naming every candidate (decision 6d5a6719 — a read is recoverable, so
//     the id ladder applies) — the ladder's candidate pool is the UNION of
//     `records.id` and `record_aliases.historical_id` (buildResolver,
//     scripts/lib/citations.mjs — the resolver check-record-citations and
//     knowledge-export already share), so a --id that is a HISTORICAL id
//     resolves to its live canonical record instead of reporting a false
//     not-found; the result discloses the forward (old id -> current id)
//     rather than silently printing the canonical record as if --id had named
//     it directly (board 4d13968f). Exit 0 found (a multi-successor conflict
//     is still a found-and-printed record, not a refusal); exit 3 not-found
//     (names the id and the db path searched); exit 2 malformed/unsafe input,
//     an unparseable body, or a store that isn't (or isn't fully) a Sterling
//     store — never a raw driver exception.
//
//   node scripts/domain-doctor.mjs adopt --from <db> --to <db>
//     WOULD replacing the destination FILE with the source lose anything? The
//     question worth asking about one logical store split across TWO physical
//     files by the homedir/context flip, because a whole-file copy carries
//     records AND their v2 provenance (record_versions, record_aliases,
//     record_relations) intact, which a row replay cannot. READ-ONLY: it
//     reports and NEVER writes — there is no --apply (the write half was
//     removed after review found an unlockable concurrent-commit-loss race and
//     a non-atomic replace; its requirements live on board 44434103).
//     Exit 0 the destination is a clean subset, so adopting would be safe and
//     complete; exit 3 a FINDING — record ids, record_aliases historical_ids
//     or record_versions snapshots that exist ONLY in the destination, each
//     NAMED (the proof is over IDS across every table that carries identity,
//     never over counts); exit 2 the pairing cannot be evaluated at all — same
//     file, missing source, a source NEWER than this build's schema, a
//     DOWNGRADE onto a higher-version destination, or a store that is not (or
//     is only half) a Sterling store. EQUAL versions are fine at any version,
//     including a pre-v2 pair: a whole-file copy mirrors whatever the source
//     is, so "both sides must be v2" is migrate's rule, not this one.
import {
  readFileSync, readdirSync, existsSync, mkdirSync, openSync, readSync, closeSync,
  realpathSync, statSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore, resolveDomainMounts } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { buildResolver } from './lib/citations.mjs';

function fail(msg, code = 2) {
  console.error(`domain-doctor: ${msg}`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const POSIX = (p) => p.replace(/\\/g, '/');

/** The domain roots this machine can plausibly hold: the current context's home,
 *  plus the Windows-side home when running under WSL (the machine's other
 *  launcher context — the flip between the two is the incident's leading cause). */
function defaultRoots() {
  const roots = [join(homedir(), '.sterling', 'domains')];
  const user = basename(homedir());
  const winHome = join('/mnt/c/Users', user, '.sterling', 'domains');
  if (existsSync(winHome)) roots.push(winHome);
  return roots;
}

function roots() {
  const given = arg('roots');
  return (given ? given.split(',') : defaultRoots()).map(POSIX);
}

/** Read-only open — the doctor's diagnosis paths never take a write lock. */
function openRO(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * A read that TOUCHES NOTHING — the only honest read for a forensics tool
 * (anti_pattern 8616e72d). Two facts make this delicate:
 *   1. A read-only open of a WAL-mode store can materialize an empty -wal and
 *      a -shm, and a read-only connection cannot unlink them on close.
 *   2. A WRITABLE handle appears to fix that — it leaves no litter — but only
 *      because SQLite's LAST-connection close CHECKPOINTS the WAL into the main
 *      database file and then unlinks the sidecars. That is a WRITE to the very
 *      store we are inspecting, and on a crashed-writer WAL the open also runs
 *      recovery, TRUNCATING the WAL at its last valid commit frame. A refusal
 *      that rewrote the source's bytes and then printed "Nothing was written"
 *      would be a false claim by a tool whose only job is telling the truth
 *      about a store.
 * So: keep the read-only handle, and clean up CONDITIONALLY — remember which
 * sidecars existed BEFORE the open and remove only the ones this open created.
 * A pre-existing (live) -wal is left EXACTLY as found, which is the correct
 * forensic posture and also the safe one: a sidecar we did not create may
 * belong to a running MCP server or TUI.
 *
 * `fn` must only GATHER — never call fail() inside it. fail() exits the
 * process, and process.exit skips the finally below, so a refusal from inside
 * would leak both the handle and the litter this exists to prevent.
 */
function readOnlyProbe(dbPath, fn) {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const hadWal = existsSync(walPath);
  const hadShm = existsSync(shmPath);
  const db = openRO(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
    if (!hadWal) rmSync(walPath, { force: true });
    if (!hadShm) rmSync(shmPath, { force: true });
  }
}

/** The schema version migrate/adopt understand — the v2 identity schema
 *  ([stable-identity-design-v2]). */
const SUPPORTED_SCHEMA_VERSION = 2;

/**
 * user_version WITHOUT opening a connection: bytes 60..63 of the SQLite header,
 * big-endian — the same probe scripts/migrate-stores.mjs uses (its
 * probeSchemaVersion, research_finding 5555895c). A REFUSAL must leave no
 * litter, and a read-only DatabaseSync open of a WAL store can materialize a
 * -shm sidecar; reading the header cannot touch anything. It is duplicated
 * rather than imported because migrate-stores.mjs is a CLI with no exports —
 * importing it would run a migration.
 *
 * A HOT -wal is the one case the header cannot answer (a committed but
 * un-checkpointed user_version lives in the WAL), so that case falls back to a
 * read-only SQLite read exactly as migrate-stores.mjs does — through
 * readOnlyProbe, because this fallback would otherwise leak exactly the
 * sidecar litter the header read exists to avoid. Which of the two answered is
 * reported in `source`: a version read through the WAL fallback is a weaker
 * fact than one read from the header, so it is disclosed rather than hidden.
 */
function probeSchemaVersion(dbPath) {
  const fd = openSync(dbPath, 'r');
  let header;
  try {
    header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    if (read < 100) {
      return { error: `'${dbPath}' is only ${read} bytes — too short to be a SQLite database file (nothing was written)` };
    }
  } finally {
    closeSync(fd);
  }
  if (header.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    return { error: `'${dbPath}' is not a SQLite database file (bad header magic) — nothing was read past its first 100 bytes and nothing was written` };
  }
  const fromHeader = header.readUInt32BE(60);
  if (!existsSync(`${dbPath}-wal`)) return { version: fromHeader, source: 'header' };
  try {
    const version = readOnlyProbe(dbPath, (db) => db.prepare('PRAGMA user_version').get().user_version);
    return { version, source: 'wal-aware read-only connection (a -wal sidecar was present, so the file header alone could be stale)' };
  } catch (e) {
    return { error: `could not read the schema version of '${dbPath}' through a read-only connection (a -wal sidecar is present, so the header alone cannot be trusted): ${e.message}` };
  }
}

/** Refuse unless this side is EXACTLY at the v2 schema. A pre-v2 store has no
 *  provenance tables at all and its records go through a migration, not a copy;
 *  a newer-than-v2 store would be silently downgraded by a copy this build
 *  wrote. Either way the answer is a refusal before anything is read or
 *  written, never a best-effort merge (P5). */
function requireV2(dbPath, side) {
  const probe = probeSchemaVersion(dbPath);
  if (probe.error) fail(probe.error);
  if (probe.version < SUPPORTED_SCHEMA_VERSION) {
    fail(
      `refusing: the ${side} store '${dbPath}' is at schema version ${probe.version} — it is pre-v2, and migrate merges ` +
        `only between two v2 stores. Migrate it first with 'node scripts/migrate-stores.mjs --db ${dbPath}', then re-run. ` +
        `Nothing was read or written.`
    );
  }
  if (probe.version > SUPPORTED_SCHEMA_VERSION) {
    fail(
      `refusing: the ${side} store '${dbPath}' is at schema version ${probe.version}, which is newer than the v${SUPPORTED_SCHEMA_VERSION} ` +
        `schema this build understands — copying into or out of it would be a downgrade. Upgrade this Sterling clone instead. ` +
        `Nothing was read or written.`
    );
  }
  return probe;
}

/**
 * ONE read-only pass over a store, gathering everything the containment proofs
 * need: which tables it HAS, its record ids, and the satellite keys that carry
 * identity independently of `records` — record_aliases.historical_id and
 * (record_id, version) from record_versions (anti_pattern 44d4f74f).
 *
 * It also answers the STRUCTURAL question the file header cannot: user_version
 * is an integer anyone can stamp, so a store can claim v2 while the v2 identity
 * tables are absent (a half-migrated store). Such a store is reported through
 * `missing` rather than discovered later as a raw "no such table" throw from
 * the first provenance query.
 *
 * GATHERS ONLY — every refusal is raised by the caller, after the probe has
 * closed and cleaned up (see readOnlyProbe).
 *
 * EVERY QUERY IS GUARDED, exactly as show() guards its own satellite reads: a
 * table being ABSENT is already handled structurally (`missing` -> the
 * caller's refuseStructure), but a table being present and the query still
 * THROWING is a different hazard entirely — SQLITE_BUSY under a concurrent
 * exclusive transaction, DDL racing this survey, a corrupt page. Unguarded,
 * that throw escaped both this probe and the top-level dispatcher as an exit-1
 * stack trace: a crash ON THE REFUSAL PATH, which is worse than the hazard the
 * refusal guards. So each read reports through `error` (never fail() from
 * inside the probe — process.exit would skip readOnlyProbe's finally and leak
 * the handle plus the sidecar litter it exists to prevent) and the wrapper
 * below raises it as the promised exit 2 once the probe has closed.
 */
function surveyStore(dbPath, claimedVersion, { withBodies = false, side = 'source' } = {}) {
  const unreadable = (what, e) =>
    `refusing: the ${side} store '${dbPath}' could not be surveyed — ${what} failed (${e.message}). A concurrent exclusive ` +
    `transaction, a schema change racing this read, or a corrupt file all land here, and a survey that cannot read a table ` +
    `cannot prove anything about it. Nothing was written.`;
  let survey;
  try {
    survey = readOnlyProbe(dbPath, (db) => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      const out = {
        missing: [], bodies: [], ids: new Set(), aliasIds: new Set(), versionKeys: new Set(), relationCount: 0,
        columnState: new Map(), error: null,
      };
      if (!tables.has('records')) {
        out.missing.push('records');
        return out;
      }
      if (claimedVersion === SUPPORTED_SCHEMA_VERSION) {
        for (const t of ['record_versions', 'record_aliases', 'record_relations']) {
          if (!tables.has(t)) out.missing.push(t);
        }
      }
      try {
        out.ids = new Set(db.prepare('SELECT id FROM records').all().map((r) => r.id));
        if (withBodies) {
          // COLUMN-RESIDENT STATE travels beside the body: storableBody
          // (packages/store/src/index.ts:692-698) strips status/superseded_by
          // from every persisted v2 body and derives them from the COLUMNS at
          // read time, so two records can hold identical bodies while
          // disagreeing about whether one of them is retired. The columns are
          // read only when the table actually carries them — a legacy shape
          // without them has no column-resident state to disagree about.
          const cols = new Set(db.prepare('PRAGMA table_info(records)').all().map((c) => c.name));
          const stateful = cols.has('status') && cols.has('superseded_by');
          const rows = db.prepare(`SELECT id, body${stateful ? ', status, superseded_by' : ''} FROM records`).all();
          out.bodies = rows.map((r) => JSON.parse(r.body));
          if (stateful) {
            for (const r of rows) out.columnState.set(r.id, { status: r.status ?? null, superseded_by: r.superseded_by ?? null });
          }
        }
      } catch (e) {
        out.error = unreadable("reading the 'records' table", e);
        return out;
      }
      if (tables.has('record_aliases')) {
        try {
          out.aliasIds = new Set(db.prepare('SELECT historical_id FROM record_aliases').all().map((r) => r.historical_id));
        } catch (e) {
          out.error = unreadable("reading the 'record_aliases' table", e);
          return out;
        }
      }
      if (tables.has('record_versions')) {
        try {
          out.versionKeys = new Set(
            db.prepare('SELECT record_id, version FROM record_versions').all().map((r) => `${r.record_id}@v${r.version}`)
          );
        } catch (e) {
          out.error = unreadable("reading the 'record_versions' table", e);
          return out;
        }
      }
      // record_relations is the third table the migrate copy loop cannot carry
      // (board b96ebf47, AC20) — a row COUNT, not mere presence, is what the
      // caller's guard gates on: every mkV2 fixture carries the empty v2
      // provenance tables, so an existence-only check would refuse a clean
      // store with zero relations too.
      if (tables.has('record_relations')) {
        try {
          out.relationCount = db.prepare('SELECT COUNT(*) AS n FROM record_relations').get().n;
        } catch (e) {
          out.error = unreadable("counting 'record_relations' rows", e);
          return out;
        }
      }
      return out;
    });
  } catch (e) {
    // The open itself, the sqlite_master probe, or anything else past this
    // file's own guards — deliberate exit 2 naming what went wrong, never
    // node's default exit 1 + stack trace.
    fail(unreadable('opening it read-only for the survey', e));
  }
  if (survey.error) fail(survey.error);
  return survey;
}

/** A store that is not what it claims to be is a STOP, in either mode: a file
 *  with no records table is not a Sterling store at all, and one whose header
 *  says v2 while the identity tables are absent is half-migrated. Both are
 *  named loudly — with the side and the absent table — because the alternative
 *  is a raw driver exception: exit 1, a stack trace, and no indication which of
 *  the two files was the broken one. */
function refuseStructure(dbPath, side, survey, claimedVersion) {
  if (!survey.missing.length) return;
  if (survey.missing.includes('records')) {
    fail(
      `refusing: the ${side} store '${dbPath}' holds no records table — it is a SQLite file, but not a Sterling knowledge store. ` +
        `Check the path. Nothing was written.`
    );
  }
  fail(
    `refusing: the ${side} store '${dbPath}' is structurally incomplete — its header claims schema v${claimedVersion}, but the v2 identity ` +
      `table(s) ${survey.missing.join(', ')} are absent, so this is a HALF-MIGRATED store and every provenance check over it would be a ` +
      `guess. Finish the migration ('node scripts/migrate-stores.mjs --db ${dbPath}') or restore its pre-migration backup. Nothing was written.`
  );
}

/** Are these two paths the SAME FILE? A string compare answers only the easiest
 *  case: realpath collapses './'-style variants and symlinks, and the
 *  inode/device pair catches a hard link (and anything realpath cannot see
 *  through). A doctor that copied a store onto itself would be an unbounded
 *  no-op at best. */
function sameFile(a, b) {
  if (a === b) return true;
  let ra;
  let rb;
  try { ra = realpathSync(a); } catch { /* unresolvable: fall through to stat */ }
  try { rb = realpathSync(b); } catch { /* unresolvable: fall through to stat */ }
  if (ra !== undefined && ra === rb) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    // ino is 0/unreliable on some Windows filesystems, so it only ever
    // CONFIRMS sameness here — realpath above is what carries that case.
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function refuseSameFile(from, to, verb) {
  if (sameFile(from, to)) {
    fail(`refusing: --from and --to are the same file ('${from}' and '${to}' resolve to one file) — there is nothing to ${verb}. Nothing was read or written.`);
  }
}

/** Every store file under the given roots: root/<domain>/sterling.db. */
function storeFilesUnder(rootList) {
  const found = [];
  for (const root of rootList) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dbPath = POSIX(join(root, name, 'sterling.db'));
      if (existsSync(dbPath)) found.push({ root: POSIX(root), domain: name, dbPath });
    }
  }
  return found;
}

function projectContext(projectDir) {
  if (!projectDir) fail('--project <dir> is required');
  const dotDir = join(projectDir, '.sterling');
  const configPath = join(dotDir, 'config.json');
  if (!existsSync(configPath)) fail(`no Sterling config at ${POSIX(configPath)} — is this an init'd project?`);
  // store.db is the standard name; fall back to the single *.db in .sterling so
  // an older/differently-named project store is still sweepable.
  let storePath = POSIX(join(dotDir, 'store.db'));
  if (!existsSync(storePath)) {
    const dbs = readdirSync(dotDir).filter((f) => f.endsWith('.db'));
    if (dbs.length === 1) storePath = POSIX(join(dotDir, dbs[0]));
    else fail(`no project store at ${storePath}${dbs.length ? ` (found ${dbs.join(', ')} — ambiguous, pass a project with a store.db)` : ''}`);
  }
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  return { config, storePath };
}

/** KEY-ORDER-INDEPENDENT structural equality over two parsed record bodies
 *  (board b96ebf47, AC21) — used ONLY to decide whether a same-id record on
 *  both sides of a migrate is an idempotent skip or a genuine conflict.
 *  Deliberately a plain recursive compare rather than a JSON.stringify
 *  compare: two bodies serialized through the same schema at different times
 *  are not guaranteed identical KEY order, and a stringify compare would
 *  false-positive a conflict on a byte-identical record.
 *
 *  ARRAY ORDER IS SIGNIFICANT, and that is deliberate, not an oversight of the
 *  same relaxation: links[], files[] and history[] are ORDER-BEARING, so two
 *  arrays holding the same entries in a different sequence are a real
 *  difference between the two stores and must conflict rather than skip.
 *  "Order-independent" above refers to object KEY order only.
 *
 *  DEPTH-BOUNDED. The inputs are RAW pre-validation JSON read straight out of
 *  a foreign store's `records.body`, so nothing upstream has capped their
 *  nesting: an unbounded recursion turns a pathological (or corrupt) body into
 *  a RangeError that escapes as exit 1 + a stack trace instead of the promised
 *  refusal. Exceeding the bound THROWS a plain message the caller turns into a
 *  clean exit-2 refusal naming the record — the bound is far past any legal
 *  record shape, so hitting it is itself the finding. */
const MAX_BODY_COMPARE_DEPTH = 64;

function deepEqual(a, b, depth = 0) {
  if (depth > MAX_BODY_COMPARE_DEPTH) {
    throw new Error(`its nesting exceeds ${MAX_BODY_COMPARE_DEPTH} levels, deeper than any legal record body`);
  }
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i], depth + 1));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], depth + 1));
  }
  return false;
}

/** migrate --from <store.db> --to <store.db> [--apply]: copy every record the
 *  destination does not hold, preserving the envelope (ids, clocks, scope: this
 *  heals ONE logical store split across two physical files by a context flip;
 *  it is not a new write event). Records are inserted through the validated
 *  write path, so a record that no longer parses against the current schemas is
 *  REPORTED and skipped, never silently dropped or half-written.
 *
 *  Since the v2 identity cutover the surviving guarantee is deliberately
 *  NARROW, and the guards below are what keep it honest (board b96ebf47): the
 *  per-record path speaks only `records`, so anything a record carries OUTSIDE
 *  that table — its archived versions, its historical-id aliases, the inbound
 *  supersedes relation a retired record's successor lives in — cannot cross
 *  here at all. Those cases are REFUSED before the first write rather than
 *  half-copied. Whole-file adoption is the SHAPE that would carry them, but
 *  `adopt` is a read-only probe with no apply path (board 44434103), so today
 *  those refusals have no operable route past them — stated plainly in the
 *  messages rather than pointing at a mode that cannot write (decision
 *  [migrate-relations-containment-narrows-migrate-to-unlinked-stores]). */
function migrate() {
  const from = arg('from') ?? fail('--from <store.db> is required');
  const to = arg('to') ?? fail('--to <store.db> is required');
  const apply = process.argv.includes('--apply');
  if (!existsSync(from)) fail(`no source store at ${from}`);
  if (!existsSync(to)) fail(`no destination store at ${to} — migrate merges into an existing store; create it by mounting first, or use 'adopt', which creates a missing destination`);
  // EVERY guard runs before the first write, and a refusal prints nothing from
  // the copy path: each dest.create() commits its OWN transaction, so a
  // refusal discovered mid-way cannot be rolled back and would leave the
  // destination half-written — the one outcome worse than not migrating.
  refuseSameFile(from, to, 'migrate');
  const fromProbe = requireV2(from, 'source');
  const toProbe = requireV2(to, 'destination');
  const src = surveyStore(from, fromProbe.version, { withBodies: true, side: 'source' });
  refuseStructure(from, 'source', src, fromProbe.version);
  const dst = surveyStore(to, toProbe.version, { withBodies: true, side: 'destination' });
  refuseStructure(to, 'destination', dst, toProbe.version);
  const rows = src.bodies;
  const versionRows = src.versionKeys.size;
  const aliasRows = src.aliasIds.size;
  const relationRows = src.relationCount;
  const retired = rows.filter((r) => r.lifecycle === 'retired');
  if (versionRows) {
    fail(
      `refusing: the source holds ${versionRows} record_versions row(s) — version snapshots live outside the records table and ` +
        `the validated create path never writes them, so every archived version would be dropped while the copied record still ` +
        `claimed its high version number. Use 'adopt' (whole-file, provenance intact). Nothing was written.`
    );
  }
  if (aliasRows) {
    fail(
      `refusing: the source holds ${aliasRows} record_aliases row(s) — historical ids resolve through that table alone, so every ` +
        `pre-migration id pointing at these records would stop resolving in the copy. Use 'adopt' (whole-file, provenance intact). ` +
        `Nothing was written.`
    );
  }
  if (retired.length) {
    fail(
      `refusing: the source holds ${retired.length} record(s) with lifecycle 'retired' (${retired.map((r) => r.id).join(', ')}) — a retired ` +
        `record's successor is an inbound supersedes RELATION, not a body field, so it cannot be reconstructed from the body and the ` +
        `validated create path refuses it outright. Use 'adopt' (whole-file, provenance intact). Nothing was written.`
    );
  }
  // Checked AFTER the retired-lifecycle guard above: retiring a record is the
  // one existing, already-pinned path that ALSO leaves a record_relations row
  // (the inbound supersedes relation), so a retired-record fixture trips both
  // — the more specific "retired" refusal is the one a human wants to read.
  if (relationRows) {
    fail(
      `refusing: the source holds ${relationRows} record_relations row(s) — relations live outside the records table and the ` +
        `validated create path rebuilds them (lossily, and only self-links a body's own convenience links[] names) rather than ` +
        `copying them structurally, so every one would be silently lost or restamped. THERE IS NO WORKING ROUTE FOR A LINKED ` +
        `STORE TODAY (decision [migrate-relations-containment-narrows-migrate-to-unlinked-stores]): whole-file adoption is the ` +
        `shape that would carry relations intact, but 'adopt' is a READ-ONLY probe — it can only report whether adopting WOULD ` +
        `be safe, it cannot perform it, and its write half is unbuilt (board 44434103). Nothing was written.`
    );
  }
  // THE DESTINATION'S RESOLVABLE-ID NAMESPACE IS A UNION, not one table
  // (anti_pattern 44d4f74f): record_aliases is an id namespace in its own
  // right, so a live source record whose id equals a destination HISTORICAL id
  // passes every records-level check and still lands one id with two
  // incompatible meanings — the alias resolves it to its canonical record,
  // `records` resolves it to the newcomer, and the PRIMARY KEY inside records
  // cannot see the clash.
  const collisions = rows.filter((r) => dst.aliasIds.has(r.id));
  if (collisions.length) {
    fail(
      `refusing: ${collisions.length} source record id(s) already exist in the destination's record_aliases as HISTORICAL ids ` +
        `(${collisions.map((r) => r.id).join(', ')}) — the destination already resolves each of them to a canonical record, so inserting a ` +
        `LIVE record under the same id would give one id two incompatible meanings. Uniqueness inside 'records' cannot detect this. ` +
        `Nothing was written.`
    );
  }
  const have = dst.ids;
  // Same-id present on BOTH sides is not automatically a skip (board b96ebf47,
  // AC21): a same-id/different-body pair is exactly what a split store
  // produces, and dropping it silently loses whichever side did not win. An
  // identical body stays an idempotent skip; a differing one is a HARD
  // CONFLICT, refused here — BEFORE the plan is even printed — so the
  // dry-run's plan and --apply's actual behavior are the same diff, never a
  // plan that lies about what --apply would do.
  const dstBodyById = new Map(dst.bodies.map((r) => [r.id, r]));
  const missing = [];
  const conflicts = [];
  const stateConflicts = [];
  for (const r of rows) {
    if (!have.has(r.id)) { missing.push(r); continue; }
    let identical;
    try {
      identical = deepEqual(r, dstBodyById.get(r.id));
    } catch (e) {
      fail(
        `refusing: record '${r.id}' exists in BOTH stores but could not be compared — ${e.message}. A body this shape is either ` +
          `corrupt or hostile, and skipping it would silently drop whichever side did not win. Nothing was written.`
      );
    }
    if (!identical) { conflicts.push(r.id); continue; }
    // BODY-IDENTICAL IS NOT STATE-IDENTICAL. `status` and `superseded_by` are
    // stripped from every persisted v2 body and derived from the COLUMNS
    // (storableBody, packages/store/src/index.ts:692-698), so a record retired
    // on one side and live on the other compares byte-identical here. Ruled a
    // CONFLICT, same treatment as a differing body: the two sides disagree
    // about what the record IS, which is exactly the condition this conflict
    // path exists for, and a silent skip would lose a supersession pointer
    // permanently — the successor never crosses, and nothing later can tell
    // that it did not.
    const srcState = src.columnState.get(r.id);
    const dstState = dst.columnState.get(r.id);
    if (srcState && dstState && (srcState.status !== dstState.status || srcState.superseded_by !== dstState.superseded_by)) {
      stateConflicts.push({ id: r.id, srcState, dstState });
    }
  }
  if (conflicts.length) {
    fail(
      `refusing: ${conflicts.length} record id(s) exist in BOTH stores with DIFFERING bodies (${conflicts.join(', ')}) — the source ` +
        `and destination disagree about what these record(s) ARE, which is not something to skip past and continue. Reconcile the ` +
        `conflicting record(s) by hand, then re-run. Nothing was written.`
    );
  }
  if (stateConflicts.length) {
    const shown = (s) => `status ${s.status ?? 'null'}, superseded_by ${s.superseded_by ?? 'null'}`;
    fail(
      `refusing: ${stateConflicts.length} record id(s) exist in BOTH stores with IDENTICAL bodies but DIFFERING column-resident ` +
        `lifecycle state (${stateConflicts.map((c) => `${c.id}: source [${shown(c.srcState)}] vs destination [${shown(c.dstState)}]`).join('; ')}) — ` +
        `status and superseded_by live in the records COLUMNS, not the body, so this disagreement is invisible to a body compare. ` +
        `It is a CONFLICT, not a skip: the two sides disagree about what the record IS, and skipping it would lose a supersession ` +
        `pointer permanently — the successor would never cross, and nothing afterwards could tell that it had not. Reconcile the ` +
        `conflicting record(s) by hand, then re-run. Nothing was written.`
    );
  }
  console.log(`migrate ${from} → ${to}: ${rows.length} source record(s), skipped ${rows.length - missing.length} already present, ${missing.length} to copy`);
  console.log(`  schema: source v${fromProbe.version} (${fromProbe.source}), destination v${toProbe.version} (${toProbe.source})`);
  for (const r of missing) console.log(`  copy: ${r.id} (${r.type}, ${r.status}, ${r.created_at})`);
  if (!apply) {
    console.log('DRY-RUN: nothing written — re-run with --apply to migrate');
    return;
  }
  const dest = new SterlingStore(to);
  let copied = 0;
  const refused = [];
  try {
    for (const r of missing) {
      try {
        dest.create(r); // validated path: schema + indexes + FTS
        copied++;
      } catch (e) {
        refused.push({ id: r.id, reason: e.message });
      }
    }
  } finally {
    dest.close();
  }
  console.log(`MIGRATED: ${copied} record(s)`);
  for (const r of refused) console.log(`REFUSED: ${r.id} — ${r.reason}`);
  if (refused.length) process.exit(3);
}

/** Every id that RESOLVES in a store: `records.id` UNION, when the table
 *  exists, `record_aliases.historical_id` — a resolvable id namespace of its
 *  own since [stable-identity-design-v2] (anti_pattern 44d4f74f). Without the
 *  alias half, sweep can report a successor reachable ONLY through an alias
 *  as dangling (a false finding), and restore's already-resolves refusal can
 *  miss a target id an alias already resolves elsewhere — letting --apply
 *  mint a live record under an id that means something else there. migrate()
 *  already guards this exact collision on its own copy path (~:415-423,
 *  naming record_aliases); this is the same union for sweep/restore's
 *  resolution universe (board a215b119, roster review finding).
 *
 *  Goes through readOnlyProbe (not a bare openRO) because a read-only open of
 *  a WAL-mode store can materialize an empty -wal/-shm it cannot unlink on
 *  close — the same trap anti_pattern 8616e72d documents; sweep, restore and
 *  scan all call this (or the same pattern) across every store they touch, so
 *  a bare open here left litter beside every one of them (board a215b119,
 *  third defect). */
function idsAndAliasesIn(dbPath) {
  return readOnlyProbe(dbPath, (db) => {
    const ids = new Set(db.prepare('SELECT id FROM records').all().map((r) => r.id));
    const aliasIds = new Set();
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (tables.has('record_aliases')) {
      for (const row of db.prepare('SELECT historical_id FROM record_aliases').all()) aliasIds.add(row.historical_id);
    }
    return { ids, aliasIds };
  });
}

/** The UNION of ids and aliases — what sweep needs, since a dangling-pointer
 *  resolution check only cares WHETHER an id resolves, never which namespace
 *  answered. restore's already-resolves refusal needs the finer-grained
 *  idsAndAliasesIn instead, because the two namespaces mean OPPOSITE things
 *  to the operator there (board a215b119, roster MEDIUM): a live-record
 *  collision means the successor is alive and there is genuinely nothing to
 *  restore, but an alias collision means the successor's CONTENT IS STILL
 *  LOST — that id has just been repurposed to mean a different canonical
 *  record — so a refusal that does not say which one fired tells the operator
 *  the content is safe when it is not. */
function idsIn(dbPath) {
  const { ids, aliasIds } = idsAndAliasesIn(dbPath);
  return new Set([...ids, ...aliasIds]);
}

/** Does this store's `records` table carry the v2 'lifecycle' column
 *  [stable-identity-design-v2] adds? A SEPARATE signal from the header's
 *  user_version — a store can carry the column while its header was never
 *  bumped (or vice-versa, mid-migration). Checking BOTH signals is what lets
 *  refuseIfHalfMigratedForSupersession catch a v2-SHAPED records table
 *  lacking record_relations regardless of which signal tips it off (Codex
 *  review finding, board a215b119 HIGH 1). */
function recordsTableIsV2Shaped(db) {
  return db.prepare('PRAGMA table_info(records)').all().some((c) => c.name === 'lifecycle');
}

/** A store whose `records` table is v2-shaped (by EITHER signal above) but
 *  which lacks `record_relations` is HALF-MIGRATED: the compatibility
 *  `superseded_by` COLUMN is kept in sync with the relation graph only by the
 *  normal v2 write paths, and there is no relation graph here at all — so
 *  resolving supersession from the column alone is a GUESS, not a read.
 *  Without this guard, sweep could read the column, find it (already) NULL or
 *  stale, and print `clean` on a store that is not safely readable at all.
 *  Returns an error string (never calls fail() — same discipline as every
 *  other readOnlyProbe gatherer) or null when the store's shape is fine to
 *  read as-is. Applied to BOTH sweep (supersessionPointers) and restore
 *  (tombstoneInfo) — the failure mode is identical in each. */
function refuseIfHalfMigratedForSupersession(dbPath, db, tables) {
  if (tables.has('record_relations')) return null;
  const userVersion = db.prepare('PRAGMA user_version').get().user_version;
  const lifecycleShaped = recordsTableIsV2Shaped(db);
  if (userVersion !== SUPPORTED_SCHEMA_VERSION && !lifecycleShaped) return null;
  return (
    `the store '${dbPath}' is v2-shaped (user_version ${userVersion}` +
    (lifecycleShaped ? ", 'records' already carries the v2 'lifecycle' column" : '') +
    `) but its 'record_relations' table is absent — a HALF-MIGRATED store, and resolving supersession from the compatibility ` +
    `'superseded_by' column alone would be a guess. Finish the migration ('node scripts/migrate-stores.mjs --db ${dbPath}') or ` +
    `restore its pre-migration backup. Nothing was written.`
  );
}

/**
 * Every supersession pointer visible in a store, from BOTH surfaces the v2
 * cutover left behind — read-only, litter-free, and schema-adaptive.
 *
 * Since [stable-identity-design-v2], `record_relations` (rel='supersedes') is
 * the AUTHORITATIVE home of supersession; `records.superseded_by` survives as
 * a compatibility/filter column the normal write paths (supersede,
 * retireInFavorOf, create with a pre-set successor) keep in sync inside the
 * same transaction as the relation. But ONE migration-runner path does not:
 * board a215b119 traces a discarded extra link-only claimant that removes the
 * row from `links` but leaves the ORIGINAL relation intact while writing NULL
 * to the column, because the column rewrite derives only from
 * retirements/foreignRetirements. A sweep reading the column alone therefore
 * MISSES that pointer entirely and can print `clean` on a store that still
 * holds a dangling successor — a false negative, which is worse than a loud
 * failure for a forensics tool.
 *
 * So both surfaces are queried and deduped by (id, successor_id), retaining
 * which surface(s) reported each pointer (disclosed in sweep's output) so a
 * genuine column/relation disagreement is visible rather than silently
 * resolved one way. `record_relations` only exists from schema v2 on, so it
 * is queried only when present — a pre-v2 store is read from the column
 * alone, same as before. A store with no `records` table at all is a
 * structural finding for the CALLER to raise (never a silent zero pointers —
 * board a215b119 is explicit that an unrecognized schema must fail loud).
 */
function supersessionPointers(dbPath) {
  return readOnlyProbe(dbPath, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!tables.has('records')) {
      return { error: `the store '${dbPath}' holds no records table — it is a SQLite file, but not a Sterling knowledge store.` };
    }
    const halfMigrated = refuseIfHalfMigratedForSupersession(dbPath, db, tables);
    if (halfMigrated) return { error: halfMigrated };
    const byKey = new Map();
    const add = (id, type, successorId, source) => {
      const key = `${id}::${successorId}`;
      const existing = byKey.get(key);
      if (existing) existing.sources.add(source);
      else byKey.set(key, { id, type, successor_id: successorId, sources: new Set([source]) });
    };
    for (const row of db.prepare("SELECT id, type, superseded_by FROM records WHERE superseded_by IS NOT NULL").all()) {
      add(row.id, row.type, row.superseded_by, 'column');
    }
    if (tables.has('record_relations')) {
      const rows = db
        .prepare(
          `SELECT rr.target_id AS id, r.type AS type, rr.source_id AS successor_id
             FROM record_relations rr JOIN records r ON r.id = rr.target_id
            WHERE rr.rel = 'supersedes'`
        )
        .all();
      for (const row of rows) add(row.id, row.type, row.successor_id, 'relation');
    }
    const pointers = [...byKey.values()].map((p) => ({ ...p, sources: [...p.sources].sort() }));
    // A genuine column/relation DISAGREEMENT — the same tombstone id pointing
    // at two DIFFERENT successors depending which surface answers — is a
    // distinct integrity defect from a dangling pointer, and sweep is the
    // forensics surface that must say so explicitly rather than merely
    // holding two separate pointer rows a reader has to notice share an id.
    const byId = new Map();
    for (const p of pointers) {
      const succ = byId.get(p.id) ?? new Set();
      succ.add(p.successor_id);
      byId.set(p.id, succ);
    }
    const sourceLabel = (s) => (s === 'relation' ? 'record_relations' : s);
    const conflicts = [...byId.entries()]
      .filter(([, succ]) => succ.size > 1)
      .map(([id, succ]) => ({
        id,
        type: pointers.find((p) => p.id === id).type,
        // Carry each successor's OWN source(s) rather than a bare id list —
        // a conflict line that just lists successors implies a column-then-
        // relation ORDER without ever stating it (roster LOW fold-in).
        successors: [...succ].map((successorId) => ({
          successorId,
          via: pointers.find((p) => p.id === id && p.successor_id === successorId).sources.map(sourceLabel).join('+'),
        })),
      }));
    return { ok: { pointers, conflicts } };
  });
}

/** adopt --from <store.db> --to <store.db>: the READ-ONLY PROOF for the
 *  stranding migrate can only half-answer (board b96ebf47) — would replacing
 *  the destination FILE with the source lose anything?
 *
 *  It only ANSWERS. adopt had a write half; review found two HIGH defects in it
 *  that cannot be fixed without a concurrency protocol, so the user ruled it
 *  removed rather than gated (an unreachable-but-shipped write path is worse
 *  than an absent one): the subset proof and the backup were separate,
 *  unlocked snapshots, so a live MCP server committing between them lost that
 *  record permanently — present in neither the source nor the backup — and
 *  unlinking an open SQLite file left the writer on an unlinked inode; and the
 *  rmSync-then-VACUUM-INTO replace left the destination ABSENT for a window
 *  with no crash-safety. Requirements for a locked, atomic apply path are kept
 *  on board 44434103.
 *
 *  The verdict is THREE-VALUED, mirroring sweep: 0 the destination is a clean
 *  subset (adoption would be safe and complete), 3 a FINDING to report, 2 the
 *  pairing cannot safely be evaluated at all. The subset proof spans `records`
 *  AND the satellite tables, because record_aliases (keyed by historical_id)
 *  and record_versions (keyed by record_id+version) carry identity and history
 *  under keys of their OWN — a clean records-level subset proves nothing about
 *  them (anti_pattern 44d4f74f). Ids, never counts. */
function adopt() {
  const from = arg('from') ?? fail('--from <store.db> is required');
  const to = arg('to') ?? fail('--to <store.db> is required');
  if (process.argv.includes('--apply')) {
    fail(
      `--apply is not implemented: adopt is a read-only probe and writes nothing, ever. Its write half was REMOVED after review found ` +
        `a concurrent-commit-loss race between the subset proof and the backup, and a non-atomic replace that left the destination ` +
        `absent on any failure — neither is fixable without a concurrency protocol. The requirements are tracked on board 44434103. ` +
        `Nothing was read or written.`
    );
  }
  if (!existsSync(from)) fail(`no source store at ${from} — it does not exist. Nothing was read or written.`);
  refuseSameFile(from, to, 'adopt');

  // VERSION GATE — before either store's CONTENTS are read. An adoption
  // MIRRORS the source file, and mirroring makes exactly two pairings unsafe:
  // a source NEWER than this build understands (adopting it would plant a store
  // nothing here can open), and a DOWNGRADE onto an existing higher-version
  // destination (a whole-file replace would roll a migrated store back). Those
  // are refused rather than merely reported, because the answer "adoptable"
  // from a doctor is something a human may go and do BY HAND — a probe that
  // blessed an unsafe pairing would be the dangerous half of the tool that is
  // left. Everything else is deliberately ALLOWED — unlike migrate, whose
  // per-record path genuinely needs v2 on both sides, a whole-file copy is
  // correct at ANY equal version: a real domain store on this machine sits at
  // user_version 0 pending a separate migration fix (board d055b150), and
  // adopting it must keep working. A missing destination has no version to
  // compare, which is the allowed case, not an error.
  const destExists = existsSync(to);
  const fromProbe = probeSchemaVersion(from);
  if (fromProbe.error) fail(fromProbe.error);
  if (fromProbe.version > SUPPORTED_SCHEMA_VERSION) {
    fail(
      `refusing: the source store '${from}' is at schema version ${fromProbe.version}, newer than the v${SUPPORTED_SCHEMA_VERSION} schema this ` +
        `build understands — adopting it would plant a store nothing on this machine can open. Upgrade this Sterling clone instead. ` +
        `Nothing was written.`
    );
  }
  let toProbe;
  if (destExists) {
    toProbe = probeSchemaVersion(to);
    if (toProbe.error) fail(toProbe.error);
    if (toProbe.version > fromProbe.version) {
      fail(
        `refusing: replacing the destination '${to}' (schema version ${toProbe.version}) with the source '${from}' (schema version ` +
          `${fromProbe.version}) would be a downgrade — a whole-file replace would roll a migrated store back to an older schema, ` +
          `losing everything that migration added` +
          (toProbe.version > SUPPORTED_SCHEMA_VERSION ? `, and the destination is itself newer than v${SUPPORTED_SCHEMA_VERSION}` : '') +
          `. Migrate the source to the destination's version first. Nothing was written.`
      );
    }
  }

  const src = surveyStore(from, fromProbe.version, { side: 'source' });
  refuseStructure(from, 'source', src, fromProbe.version);
  const empty = { missing: [], ids: new Set(), aliasIds: new Set(), versionKeys: new Set(), columnState: new Map() };
  const dst = destExists ? surveyStore(to, toProbe.version, { side: 'destination' }) : empty;
  if (destExists) refuseStructure(to, 'destination', dst, toProbe.version);

  // THE PROOF, over every table that carries identity — not `records` alone
  // (anti_pattern 44d4f74f). Both stores can hold record X under one id (zero
  // destination-only record ids) while the destination ALONE holds
  // record_aliases(old-id -> X) and extra archived versions of it: a whole-file
  // replace would silently delete a historical id that still resolves today,
  // and history no reader can get back.
  const destOnlyIds = [...dst.ids].filter((id) => !src.ids.has(id));
  const destOnlyAliases = [...dst.aliasIds].filter((id) => !src.aliasIds.has(id));
  const destOnlyVersions = [...dst.versionKeys].filter((k) => !src.versionKeys.has(k));

  const describe = (survey) => `${survey.ids.size} record(s), ${survey.aliasIds.size} record_aliases row(s), ${survey.versionKeys.size} record_versions row(s)`;
  console.log(`adopt probe ${from} → ${to}`);
  console.log(`  source: ${describe(src)} — schema version ${fromProbe.version} (${fromProbe.source})`);
  console.log(
    destExists
      ? `  destination: ${describe(dst)} — schema version ${toProbe.version} (${toProbe.source})`
      : `  destination: does not exist yet, so it holds 0 record(s) and nothing could be lost by adopting`
  );
  console.log('  DRY-RUN, ALWAYS: this mode reports and never writes — there is no --apply (board 44434103).');
  if (!destOnlyIds.length && !destOnlyAliases.length && !destOnlyVersions.length) {
    console.log('ADOPTABLE: every destination record id, record_aliases historical_id and record_versions snapshot is present in the source — replacing the destination file would lose nothing');
    return;
  }
  // A FINDING, not a refusal: with the write half gone there is no destructive
  // action left to refuse, so the answer "not a clean subset" is a REPORT the
  // caller branches on — sweep's 0-clean/3-finding shape (exit 2 stays what it
  // means everywhere else in this file: the request itself was unsafe or
  // malformed). Every finding NAMES its ids, because a count cannot be checked.
  for (const id of destOnlyIds) console.log(`FINDING: destination-only record id ${id} — present in the destination, absent from the source`);
  for (const id of destOnlyAliases) console.log(`FINDING: destination-only record_aliases historical_id ${id} — a dead id that resolves ONLY in the destination`);
  for (const key of destOnlyVersions) console.log(`FINDING: destination-only record_versions snapshot ${key} — archived history held ONLY in the destination`);
  console.log(
    `NOT A CLEAN SUBSET: ${destOnlyIds.length} record id(s), ${destOnlyAliases.length} record_aliases row(s) and ${destOnlyVersions.length} ` +
      `record_versions row(s) exist only in the destination — adopting the source over it would destroy exactly those. Nothing was written.`
  );
  process.exit(3);
}

/** show --db <store.db> --id <id>: READ-ONLY forensic read of one record, on
 *  a store at ANY schema version (unlike migrate/adopt's version gates — this
 *  is the mode that reads a store STUCK pre-v2, e.g. deepdots, board d055b150).
 *
 *  Gathers everything inside ONE readOnlyProbe pass and returns a plain
 *  {error} or {ok} object rather than calling fail() from inside `fn` — fail()
 *  calls process.exit, which would skip readOnlyProbe's finally and leak both
 *  the handle and the sidecar litter it exists to avoid (see the comment on
 *  readOnlyProbe). Every refusal is raised by the caller, after the probe has
 *  closed and cleaned up. */
function show() {
  const dbPath = arg('db');
  const id = arg('id');
  if (!dbPath) fail('--db <store.db> is required');
  if (!id) fail('--id <id> is required');
  if (!existsSync(dbPath)) fail(`the store '${dbPath}' does not exist. Nothing was read.`);

  // schemaProbe answers "is this store v2-claiming?" for the satellite-
  // absence disclosure below, via the header's user_version — the same probe
  // migrate/adopt use. probeSchemaVersion() already turns a bad header into a
  // clean {error}, but a genuinely corrupt file (or one it cannot even open
  // for its WAL-aware fallback) can still throw — caught here rather than
  // left to crash the process (never a raw driver exception past this file).
  let schemaProbe;
  try {
    schemaProbe = probeSchemaVersion(dbPath);
  } catch (e) {
    fail(`'${dbPath}' could not be read as a SQLite database: ${e.message}`);
  }
  if (schemaProbe.error) fail(schemaProbe.error);

  let result;
  try {
    result = readOnlyProbe(dbPath, (db) => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      if (!tables.has('records')) {
        return { error: { code: 2, msg: `the store '${dbPath}' holds no records table — it is a SQLite file, but not a Sterling knowledge store.` } };
      }

      let rawIds;
      try {
        rawIds = db.prepare('SELECT id FROM records').all().map((r) => r.id);
      } catch (e) {
        return { error: { code: 2, msg: `the 'records' table in '${dbPath}' could not be queried for ids — its column shape does not match what show() expects.` } };
      }
      // A NULL id is a real, observed legacy shape (mkPreV2Store's `records`
      // table has no NOT NULL on id) — .startsWith() on a non-string crashes,
      // so it is excluded from resolution rather than dropped silently: its
      // count is reported as a finding, on every path, error or success.
      const nullIdCount = rawIds.filter((x) => typeof x !== 'string').length;
      const allIds = [...new Set(rawIds.filter((x) => typeof x === 'string'))];

      // ALIAS-AWARE RESOLUTION (board 4d13968f): show's id ladder must resolve
      // a historical id through record_aliases the same way the rest of the
      // surface does (idsAndAliasesIn, migrate's collision guard) — a
      // forensics tool answering "no record matching" for an id the store's
      // own alias table maps to a live canonical record is exactly the false
      // clean this closes. Reuses buildResolver (scripts/lib/citations.mjs,
      // the shared resolver behind check-record-citations/knowledge-export)
      // rather than a second hand-rolled ladder: it folds record_aliases rows
      // into the SAME candidate pool as record ids, so exact-id-beats-prefix
      // and ambiguous-prefix-refuses-naming-every-candidate apply uniformly
      // whether a hit lands on a live record or a historical alias. A
      // `{id,type,status}` shape is fabricated for each record id (buildResolver
      // never inspects type/status, only `id`) so this stays a plain-object
      // shim rather than requiring a real SterlingStore — a real one always
      // opens a WRITABLE handle (packages/store/src/index.ts:405), which would
      // reintroduce the WAL-mutation-on-close hazard readOnlyProbe exists to
      // avoid, and would refuse to open some of the very corrupt/legacy stores
      // show() must still diagnose.
      let rawAliasRows = [];
      if (tables.has('record_aliases')) {
        try {
          rawAliasRows = db.prepare('SELECT historical_id, canonical_id, archived_version FROM record_aliases').all();
        } catch (e) {
          return { error: { code: 2, msg: `the 'record_aliases' table in '${dbPath}' could not be queried for its id ladder — its column shape does not match what show() expects.`, nullIdCount } };
        }
      }
      // A NULL/non-string historical_id is the same observed-legacy-shape
      // hazard as a null record id (review finding, board 4d13968f follow-up):
      // left unfiltered it reaches citations.mjs's r.id.slice(0,8) and this
      // file's x.startsWith(id) below, both of which throw on a non-string —
      // caught by the outer try at the bottom of show() but misreported as a
      // generic "could not be read as a valid SQLite/Sterling store", hiding
      // that the actual defect is a malformed alias row. Filtered the same
      // way as record ids, with its own reported count.
      const nullAliasIdCount = rawAliasRows.filter((a) => typeof a.historical_id !== 'string').length;
      const aliasRows = rawAliasRows.filter((a) => typeof a.historical_id === 'string');
      const canonicalOf = new Map(aliasRows.map((a) => [a.historical_id, a.canonical_id]));
      const resolver = buildResolver({
        recordIdIndex: () => allIds.map((rid) => ({ id: rid, type: 'record', status: 'active' })),
        recordAliases: () => aliasRows,
      });

      const resolved = resolver.resolve(id);
      if (resolved === undefined) {
        return { error: { code: 3, msg: `no record matching '${id}' found in '${dbPath}'.`, nullIdCount, nullAliasIdCount } };
      }
      if (resolved === 'ambiguous') {
        // resolve() only signals the ladder's VERDICT ('ambiguous'), not which
        // ids collided — show's refusal must name every candidate, so they are
        // re-derived here from the same combined pool the resolver consulted.
        const universe = [...allIds, ...aliasRows.map((a) => a.historical_id)];
        const candidates = [...new Set(universe.filter((x) => x.startsWith(id)))];
        return { error: { code: 2, msg: `'${id}' is an ambiguous prefix in '${dbPath}' — it matches ${candidates.length} records: ${candidates.join(', ')}.`, nullIdCount, nullAliasIdCount } };
      }

      let resolvedId = resolved.id;
      let forwardedFrom = null;
      if (resolved.type === 'alias') {
        // A historical id resolved — disclose the forward (old id -> current
        // id) rather than silently showing the canonical record as if `id`
        // had named it directly.
        forwardedFrom = resolved.id;
        resolvedId = canonicalOf.get(resolved.id);
        if (!resolvedId || !allIds.includes(resolvedId)) {
          return {
            error: {
              code: 2,
              msg: `'${id}' resolves via record_aliases to historical id '${forwardedFrom}', whose canonical_id '${resolvedId ?? 'null'}' does not exist in '${dbPath}' — a dangling alias.`,
              nullIdCount,
              nullAliasIdCount,
            },
          };
        }
      }

      let rows;
      try {
        rows = db.prepare('SELECT body FROM records WHERE id = ?').all(resolvedId).map((r) => JSON.parse(r.body));
      } catch (e) {
        return { error: { code: 2, msg: `record '${resolvedId}' in '${dbPath}' has an unparseable JSON body: ${e.message}`, nullIdCount, nullAliasIdCount } };
      }

      const found = {
        resolvedId, rows, nullIdCount, nullAliasIdCount, forwardedFrom,
      };
      // v2 provenance — only present (and only queried) on a v2 store; a
      // pre-v2 store has none of these tables, and this must never refuse or
      // fall back to migrate's v2-required guard for their absence (that
      // guard is migrate's, not show's — reading a stuck store is the point
      // of show). A store that IS v2-claiming (schema header says v2) or
      // already has ANY v2 satellite table but is missing one of the three is
      // half-migrated — silently saying nothing there is a FALSE CLEAN on the
      // tool's core question ("does this record have a successor?"), so that
      // case gets an explicit "table absent — NOT checked" disclosure,
      // distinct from "queried, found none". Each query is wrapped: a
      // satellite table present with the wrong column shape must fail loud
      // (exit 2, naming the table), never a raw driver exception.
      const v2Claiming = schemaProbe.version === SUPPORTED_SCHEMA_VERSION;
      const anySatellite = tables.has('record_relations') || tables.has('record_aliases') || tables.has('record_versions');
      const discloseAbsence = v2Claiming || anySatellite;

      if (tables.has('record_relations')) {
        try {
          found.successors = db.prepare("SELECT source_id FROM record_relations WHERE target_id = ? AND rel = 'supersedes'").all(resolvedId).map((r) => r.source_id);
        } catch (e) {
          return { error: { code: 2, msg: `the 'record_relations' table in '${dbPath}' could not be queried — its column shape does not match what show() expects.`, nullIdCount } };
        }
      } else if (discloseAbsence) {
        found.relationsAbsent = true;
      }
      if (tables.has('record_aliases')) {
        try {
          found.historicalIds = db.prepare('SELECT historical_id FROM record_aliases WHERE canonical_id = ?').all(resolvedId).map((r) => r.historical_id);
        } catch (e) {
          return { error: { code: 2, msg: `the 'record_aliases' table in '${dbPath}' could not be queried — its column shape does not match what show() expects.`, nullIdCount } };
        }
      } else if (discloseAbsence) {
        found.aliasesAbsent = true;
      }
      if (tables.has('record_versions')) {
        try {
          found.versionCount = db.prepare('SELECT COUNT(*) AS n FROM record_versions WHERE record_id = ?').get(resolvedId).n;
        } catch (e) {
          return { error: { code: 2, msg: `the 'record_versions' table in '${dbPath}' could not be queried — its column shape does not match what show() expects.`, nullIdCount } };
        }
      } else if (discloseAbsence) {
        found.versionsAbsent = true;
      }
      return { ok: found };
    });
  } catch (e) {
    // A genuinely corrupt/malformed store (bad open, or a `records` table
    // whose shape breaks the sqlite_master probe itself) must not crash past
    // this file — deliberate exit 2, never node's default exit 1 + stack
    // trace, and never the raw driver text.
    fail(`'${dbPath}' could not be read as a valid SQLite/Sterling store (open or query failed unexpectedly): ${e.message}`);
  }

  if (result.error) {
    if (result.error.nullIdCount) {
      console.error(`domain-doctor: FINDING: ${result.error.nullIdCount} record(s) in '${dbPath}' have a null/non-string id and were excluded from id resolution.`);
    }
    if (result.error.nullAliasIdCount) {
      console.error(`domain-doctor: FINDING: ${result.error.nullAliasIdCount} record_aliases row(s) in '${dbPath}' have a null/non-string historical_id and were excluded from id resolution.`);
    }
    fail(result.error.msg, result.error.code);
  }

  const {
    resolvedId, rows, successors, historicalIds, versionCount, nullIdCount, nullAliasIdCount, relationsAbsent, aliasesAbsent, versionsAbsent,
    forwardedFrom,
  } = result.ok;
  if (nullIdCount) console.log(`FINDING: ${nullIdCount} record(s) in '${dbPath}' have a null/non-string id and were excluded from id resolution.`);
  if (nullAliasIdCount) console.log(`FINDING: ${nullAliasIdCount} record_aliases row(s) in '${dbPath}' have a null/non-string historical_id and were excluded from id resolution.`);
  if (forwardedFrom) {
    console.log(`domain-doctor show: '${id}' resolved via record_aliases: historical id '${forwardedFrom}' -> canonical '${resolvedId}' in '${dbPath}'`);
  } else {
    console.log(`domain-doctor show: '${id}' resolved to '${resolvedId}' in '${dbPath}'`);
  }
  rows.forEach((r) => console.log(`  record: ${JSON.stringify(r)}`));
  if (relationsAbsent) {
    console.log('  record_relations: table absent — successor provenance NOT checked');
  } else if (successors) {
    console.log(successors.length ? `  successor (record_relations, supersedes): ${successors.join(', ')}` : '  successor (record_relations, supersedes): none');
  }
  if (aliasesAbsent) {
    console.log('  record_aliases: table absent — historical-id provenance NOT checked');
  } else if (historicalIds) {
    console.log(historicalIds.length ? `  historical ids (record_aliases): ${historicalIds.join(', ')}` : '  historical ids (record_aliases): none');
  }
  if (versionsAbsent) {
    console.log('  record_versions: table absent — snapshot count NOT checked');
  } else if (versionCount !== undefined) {
    console.log(`  record_versions snapshots: ${versionCount}`);
  }
}

// ---------------------------------------------------------------------------

function scan() {
  const rootList = roots();
  console.log(`domain-doctor scan — roots: ${rootList.join(', ')}`);
  const files = storeFilesUnder(rootList);
  if (!files.length) {
    console.log('no domain store files found under any root');
    return;
  }
  for (const f of files) {
    // readOnlyProbe, not a bare openRO+db.close(): a read-only open of a
    // WAL-mode store can materialize -wal/-shm litter it cannot unlink on
    // close (anti_pattern 8616e72d, severity block) — scan touches every
    // store file under the roots, so a bare open here left litter beside
    // every one of them.
    readOnlyProbe(f.dbPath, (db) => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
      const range = db.prepare('SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM records').get();
      const first = db.prepare('SELECT id FROM records ORDER BY created_at ASC LIMIT 1').get();
      const last = db.prepare('SELECT id FROM records ORDER BY created_at DESC LIMIT 1').get();
      const byScope = db.prepare('SELECT scope, COUNT(*) AS n FROM records GROUP BY scope').all();
      console.log(`\n[${f.domain}] ${f.dbPath}`);
      console.log(`  records: ${n}${n ? ` — created ${range.lo} … ${range.hi}` : ''}`);
      if (n) {
        console.log(`  first: ${first.id}  last: ${last.id}`);
        console.log(`  scopes: ${byScope.map((s) => `${s.scope}=${s.n}`).join(', ')}`);
      }
    });
  }
}

function sweep() {
  const { config, storePath } = projectContext(arg('project'));
  const rootList = roots();
  // resolution universe: the project store, its mounted domain paths, and every
  // store file under the roots (mounted or stranded — that is the point).
  const universe = new Set(idsIn(storePath));
  const seenPaths = new Set([storePath]);
  for (const m of resolveDomainMounts(config)) {
    const p = POSIX(m.dbPath);
    if (!seenPaths.has(p) && existsSync(p)) {
      for (const id of idsIn(p)) universe.add(id);
      seenPaths.add(p);
    }
  }
  for (const f of storeFilesUnder(rootList)) {
    if (seenPaths.has(f.dbPath)) continue;
    for (const id of idsIn(f.dbPath)) universe.add(id);
    seenPaths.add(f.dbPath);
  }

  const surveyed = supersessionPointers(storePath);
  if (surveyed.error) fail(surveyed.error);
  const { pointers: rows, conflicts } = surveyed.ok;
  const dangling = rows.filter((r) => !universe.has(r.successor_id));
  console.log(
    `domain-doctor sweep — ${rows.length} superseded_by pointer(s) in ${storePath}, resolved against ${seenPaths.size} store file(s)`
  );
  for (const c of conflicts) {
    const labeled = c.successors.map((s) => `${s.successorId} (${s.via})`).join(' vs ');
    console.log(
      `CONFLICT: tombstone ${c.id} (${c.type}) has DIFFERENT successors depending which surface answers: ${labeled} — column and record_relations disagree`
    );
  }
  if (!dangling.length && !conflicts.length) {
    console.log('clean: every pointer resolves');
    return;
  }
  for (const d of dangling) {
    const via = d.sources.length > 1 ? d.sources.join('+') : d.sources[0];
    console.log(`DANGLING: tombstone ${d.id} (${d.type}) → superseded_by ${d.successor_id} resolves in NO store [via ${via}]`);
  }
  process.exit(3);
}

/**
 * The tombstone's status and successor id, read AUTHORITATIVELY rather than
 * from the JSON body — storableBody (packages/store/src/index.ts:598-604)
 * strips status/superseded_by from the persisted body of every v2 record, so
 * a body-sourced read always sees them as undefined/null and restore refused
 * on every v2 store (board a215b119, half 1). The `records.status` /
 * `records.superseded_by` COLUMNS are the correct source for both pre-v2 and
 * ordinary v2 stores — every normal write path keeps them in sync — but a
 * relation left by the migration runner's discarded-claimant path (the same
 * shape sweep must tolerate) can survive with the column desynced to NULL;
 * when `record_relations` holds an inbound 'supersedes' row for this id it is
 * preferred as the more authoritative source, exactly as show() already
 * treats it (line ~674 above). Read-only and litter-free via readOnlyProbe.
 *
 * TWO further guards, same review round (board a215b119, Codex HIGH 1/2):
 * (1) a v2-shaped store lacking `record_relations` refuses outright — same
 * half-migrated posture as supersessionPointers, because the column alone is
 * a guess there too. (2) `record_relations` can hold MORE THAN ONE inbound
 * 'supersedes' row for one target on a corrupted or half-migrated store — the
 * v2 identity design allows one successor maximum, so more than one is
 * ambiguity, not data to silently collapse with `.get()`. Restoring under an
 * arbitrarily-picked successor could mint the WRONG identity, so this refuses
 * and names every candidate, the same posture show() uses for an ambiguous id
 * prefix.
 */
function tombstoneInfo(dbPath, id) {
  return readOnlyProbe(dbPath, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!tables.has('records')) {
      return { error: `the store '${dbPath}' holds no records table — it is a SQLite file, but not a Sterling knowledge store.` };
    }
    const halfMigrated = refuseIfHalfMigratedForSupersession(dbPath, db, tables);
    if (halfMigrated) return { error: halfMigrated };
    const row = db.prepare('SELECT status, superseded_by, body FROM records WHERE id = ?').get(id);
    if (!row) return { error: `no record '${id}' in ${dbPath}` };
    let successorId = row.superseded_by ?? null;
    if (tables.has('record_relations')) {
      const rels = db.prepare("SELECT source_id FROM record_relations WHERE rel = 'supersedes' AND target_id = ?").all(id);
      if (rels.length > 1) {
        return {
          error:
            `record '${id}' in '${dbPath}' has ${rels.length} inbound 'supersedes' relations in record_relations — ambiguous. ` +
            `The v2 identity design allows one successor maximum, so a corrupted or half-migrated store holding more than one is a ` +
            `finding, not a pick: ${rels.map((r) => r.source_id).join(', ')}. Restoring under an arbitrarily-chosen successor could mint ` +
            `the WRONG identity, so nothing was resolved.`,
        };
      }
      if (rels.length === 1) successorId = rels[0].source_id;
    }
    const status = successorId ? 'superseded' : row.status;
    return { ok: { status, successorId, body: JSON.parse(row.body) } };
  });
}

function restore() {
  const { config, storePath } = projectContext(arg('project'));
  const tombstoneId = arg('tombstone') ?? fail('--tombstone <id> is required');
  const domain = arg('domain') ?? fail('--domain <name> is required');
  const apply = process.argv.includes('--apply');

  const info = tombstoneInfo(storePath, tombstoneId);
  if (info.error) fail(info.error);
  const { status, successorId, body: tombstone } = info.ok;
  if (status !== 'superseded' || !successorId) {
    fail(`record '${tombstoneId}' is not a tombstone (status ${status}, superseded_by ${successorId ?? 'null'}) — nothing to restore from it`);
  }
  const targetId = successorId;

  // Refuse when the target already resolves ANYWHERE the sweep can see — as
  // either a live records.id OR a record_aliases.historical_id
  // (anti_pattern 44d4f74f). The two mean OPPOSITE things to the operator, so
  // the refusal must say WHICH one fired rather than collapsing them into one
  // Set the way sweep's resolution universe does (idsIn stays the union for
  // sweep's purposes; idsAndAliasesIn keeps them apart for this check):
  //   - a live-record collision: the successor is genuinely alive elsewhere,
  //     "nothing to restore" is TRUE, and the content is safe.
  //   - an alias collision: the successor's CONTENT IS STILL LOST — that id
  //     has merely been repurposed to resolve to a DIFFERENT canonical
  //     record — so telling the operator only "already resolves" would claim
  //     the content is safe when it is not, and restoring under it anyway
  //     would give one id two incompatible meanings, exactly the collision
  //     migrate() already refuses on its own copy path (~:415-423).
  const rootList = roots();
  const resolvesIn = [];
  const noteResolution = (path, { ids, aliasIds }) => {
    if (ids.has(targetId)) resolvesIn.push({ path, kind: 'live record id' });
    else if (aliasIds.has(targetId)) {
      resolvesIn.push({
        path,
        kind: "record_aliases historical id — that id already resolves to another canonical record there; restoring under it would give one id two incompatible meanings",
      });
    }
  };
  noteResolution(storePath, idsAndAliasesIn(storePath));
  for (const m of resolveDomainMounts(config)) {
    const p = POSIX(m.dbPath);
    if (existsSync(p)) noteResolution(p, idsAndAliasesIn(p));
  }
  for (const f of storeFilesUnder(rootList)) {
    noteResolution(f.dbPath, idsAndAliasesIn(f.dbPath));
  }
  if (resolvesIn.length) {
    const seen = new Set();
    const lines = resolvesIn.filter((r) => {
      const key = `${r.path}::${r.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    fail(
      `target '${targetId}' already resolves in: ${lines.map((r) => `${r.path} (${r.kind})`).join('; ')} — nothing to restore`
    );
  }

  const domainDb = POSIX(config.domain_paths[domain] ?? join(homedir(), '.sterling', 'domains', domain, 'sterling.db'));
  const now = new Date().toISOString();
  // content verbatim from the tombstone body; envelope rebuilt exactly as
  // knowledge_promote builds it, except the id is the DANGLING one — restoring
  // the identity the tombstone already points at, so no server-owned field on
  // the tombstone needs touching. lifecycle/freshness/version are stripped
  // too (not just status/superseded_by): a v2 tombstone's body still carries
  // lifecycle:'retired' verbatim (storableBody only drops status/
  // superseded_by, board a215b119), and create() refuses a record BORN
  // retired outright — the restored copy is a fresh live record, not a
  // resurrection of the tombstone's own retired identity. file_baselines is
  // stripped too: it is server-derived content-hash provenance for the OLD
  // (tombstoned) record's files, and create() would otherwise persist it
  // verbatim onto the reconstruction, which is a stale, unrelated claim about
  // what the reconstructed record's baseline should be.
  const {
    id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l,
    lifecycle: _lc, freshness: _fr, version: _v, file_baselines: _fb, ...content
  } = tombstone;
  const record = {
    ...content,
    id: targetId,
    created_at: now,
    updated_at: now,
    status: 'active',
    superseded_by: null,
    scope: `domain:${domain}`,
    links: [{ rel: 'informed_by', target_id: tombstoneId }],
  };

  console.log(`restore plan: ${tombstone.type} '${targetId}' ← tombstone ${tombstoneId}`);
  console.log(`  into: ${domainDb}`);
  console.log(`  scope: domain:${domain}; provenance: informed_by ${tombstoneId}; clocks stamped ${now}`);
  if (!apply) {
    console.log('DRY-RUN: nothing written — re-run with --apply to restore');
    return;
  }
  mkdirSync(dirname(domainDb), { recursive: true });
  const store = new SterlingStore(domainDb); // lazy-creates the file, §2.3
  try {
    store.create(record); // the one validated write path — schema + indexes + FTS
  } finally {
    store.close();
  }
  console.log(`RESTORED: '${targetId}' now resolves in ${domainDb}`);
}

const mode = process.argv[2];
// LAST LINE OF DEFENCE: no driver exception leaves this file as a bare exit-1
// stack trace. Every anticipated failure is already a fail() with its own
// message; anything that gets past them (a driver-level throw racing a probe,
// an unreadable file this build has no specific guard for) still exits 2 —
// this tool's "the request could not safely be carried out" code — naming the
// mode and the underlying message. A crash on the refusal path is worse than
// the hazard the refusal guards, since it says nothing about what was or was
// not written. process.exit() does not throw, so every deliberate exit code
// (0/2/3) still passes through untouched.
try {
  if (mode === 'scan') scan();
  else if (mode === 'sweep') sweep();
  else if (mode === 'restore') restore();
  else if (mode === 'migrate') migrate();
  else if (mode === 'adopt') adopt();
  else if (mode === 'show') show();
  else fail(`usage: domain-doctor.mjs scan|sweep|restore|migrate|adopt|show … (got '${mode ?? ''}')`);
} catch (e) {
  fail(`'${mode}' failed unexpectedly and was abandoned where it stood: ${e?.message ?? e}`);
}
