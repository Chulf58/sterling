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
 */
function surveyStore(dbPath, claimedVersion, { withBodies = false } = {}) {
  return readOnlyProbe(dbPath, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const survey = { missing: [], bodies: [], ids: new Set(), aliasIds: new Set(), versionKeys: new Set() };
    if (!tables.has('records')) {
      survey.missing.push('records');
      return survey;
    }
    if (claimedVersion === SUPPORTED_SCHEMA_VERSION) {
      for (const t of ['record_versions', 'record_aliases', 'record_relations']) {
        if (!tables.has(t)) survey.missing.push(t);
      }
    }
    survey.ids = new Set(db.prepare('SELECT id FROM records').all().map((r) => r.id));
    if (withBodies) survey.bodies = db.prepare('SELECT body FROM records').all().map((r) => JSON.parse(r.body));
    if (tables.has('record_aliases')) {
      survey.aliasIds = new Set(db.prepare('SELECT historical_id FROM record_aliases').all().map((r) => r.historical_id));
    }
    if (tables.has('record_versions')) {
      survey.versionKeys = new Set(
        db.prepare('SELECT record_id, version FROM record_versions').all().map((r) => `${r.record_id}@v${r.version}`)
      );
    }
    return survey;
  });
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
 *  half-copied, and `adopt` is the mode that carries them. */
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
  const src = surveyStore(from, fromProbe.version, { withBodies: true });
  refuseStructure(from, 'source', src, fromProbe.version);
  const dst = surveyStore(to, toProbe.version);
  refuseStructure(to, 'destination', dst, toProbe.version);
  const rows = src.bodies;
  const versionRows = src.versionKeys.size;
  const aliasRows = src.aliasIds.size;
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
  const missing = rows.filter((r) => !have.has(r.id));
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

/** All record ids in a store file (any status, tombstones included). */
function idsIn(dbPath) {
  const db = openRO(dbPath);
  try {
    return new Set(db.prepare('SELECT id FROM records').all().map((r) => r.id));
  } finally {
    db.close();
  }
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

  const src = surveyStore(from, fromProbe.version);
  refuseStructure(from, 'source', src, fromProbe.version);
  const empty = { missing: [], ids: new Set(), aliasIds: new Set(), versionKeys: new Set() };
  const dst = destExists ? surveyStore(to, toProbe.version) : empty;
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
    const db = openRO(f.dbPath);
    try {
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
    } finally {
      db.close();
    }
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

  const db = openRO(storePath);
  let rows;
  try {
    rows = db.prepare("SELECT id, type, superseded_by FROM records WHERE superseded_by IS NOT NULL").all();
  } finally {
    db.close();
  }
  const dangling = rows.filter((r) => !universe.has(r.superseded_by));
  console.log(
    `domain-doctor sweep — ${rows.length} superseded_by pointer(s) in ${storePath}, resolved against ${seenPaths.size} store file(s)`
  );
  if (!dangling.length) {
    console.log('clean: every pointer resolves');
    return;
  }
  for (const d of dangling) {
    console.log(`DANGLING: tombstone ${d.id} (${d.type}) → superseded_by ${d.superseded_by} resolves in NO store`);
  }
  process.exit(3);
}

function restore() {
  const { config, storePath } = projectContext(arg('project'));
  const tombstoneId = arg('tombstone') ?? fail('--tombstone <id> is required');
  const domain = arg('domain') ?? fail('--domain <name> is required');
  const apply = process.argv.includes('--apply');

  const db = openRO(storePath);
  let row;
  try {
    row = db.prepare('SELECT body FROM records WHERE id = ?').get(tombstoneId);
  } finally {
    db.close();
  }
  if (!row) fail(`no record '${tombstoneId}' in ${storePath}`);
  const tombstone = JSON.parse(row.body);
  if (tombstone.status !== 'superseded' || !tombstone.superseded_by) {
    fail(`record '${tombstoneId}' is not a tombstone (status ${tombstone.status}, superseded_by ${tombstone.superseded_by ?? 'null'}) — nothing to restore from it`);
  }
  const targetId = tombstone.superseded_by;

  // refuse when the target already resolves ANYWHERE the sweep can see —
  // restoring over a live record would mint a duplicate identity.
  const rootList = roots();
  const resolvesIn = [];
  if (idsIn(storePath).has(targetId)) resolvesIn.push(storePath);
  for (const m of resolveDomainMounts(config)) {
    const p = POSIX(m.dbPath);
    if (existsSync(p) && idsIn(p).has(targetId)) resolvesIn.push(p);
  }
  for (const f of storeFilesUnder(rootList)) {
    if (idsIn(f.dbPath).has(targetId)) resolvesIn.push(f.dbPath);
  }
  if (resolvesIn.length) {
    fail(`target '${targetId}' already resolves in: ${[...new Set(resolvesIn)].join(', ')} — nothing to restore`);
  }

  const domainDb = POSIX(config.domain_paths[domain] ?? join(homedir(), '.sterling', 'domains', domain, 'sterling.db'));
  const now = new Date().toISOString();
  // content verbatim from the tombstone body; envelope rebuilt exactly as
  // knowledge_promote builds it, except the id is the DANGLING one — restoring
  // the identity the tombstone already points at, so no server-owned field on
  // the tombstone needs touching.
  const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l, ...content } = tombstone;
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
if (mode === 'scan') scan();
else if (mode === 'sweep') sweep();
else if (mode === 'restore') restore();
else if (mode === 'migrate') migrate();
else if (mode === 'adopt') adopt();
else fail(`usage: domain-doctor.mjs scan|sweep|restore|migrate|adopt … (got '${mode ?? ''}')`);
