// scripts/migrate-stores.mjs — the stable-identity schema v1 -> v2 DATA
// migration runner (S4, decision [stable-identity-design-v2] / 2176748e
// section 6; board 60fa6960). The write-side sibling of the read-only
// scripts/migration-preflight.mjs (S1): preflight REPORTS the shape of what
// this script MOVES, and the two agree by construction — same --db CLI, same
// `already_migrated` marker vocabulary, same "name the path and exit non-zero"
// failure style.
//
//   node scripts/migrate-stores.mjs --db <path-to-sterling.db>
//   node scripts/migrate-stores.mjs --all-stores [--roots <dir>[,<dir>...]]   (fleet sweep — see below)
//
// The CLI + JSON contract, and the legacy (v1) input shape, are pinned by
// scripts/tests/migration-runner.test.mjs — THAT FILE IS THE ORACLE; this
// header is a pointer plus the provenance notes a reader of this script needs.
//
// WHY RAW node:sqlite AND NOT SterlingStore: since S2 (6bd3a8d) the v2 store
// refuses every write on a pre-v2 store (SchemaMigrationRequiredError —
// refuse-until-migrated is the whole point), so the migration itself CANNOT go
// through it. Every statement below is raw DatabaseSync.
//
// MIRRORED, NOT IMPORTED (flagged provenance): TARGET_SCHEMA_VERSION and the
// three v2 identity tables' DDL are copies of packages/store/src/index.ts's
// `DDL` + SUPPORTED_SCHEMA_VERSION. Three reasons, in order:
//   1. the DDL is a module-private `const` in packages/store — it is not
//      exported at all, so there is nothing to import;
//   2. packages/*/dist is GITIGNORED, so a consumer machine's clone has no
//      built dist until `npm run build` — a migration runner that hard-imports
//      it would be broken on exactly the machines that need it most;
//   3. the target version is 2 BECAUSE THIS CODE PRODUCES A v2 STORE. Tracking
//      packages/store's SUPPORTED_SCHEMA_VERSION would silently stamp 3 on a
//      store this code only migrated to 2 — the same reasoning
//      migration-preflight.mjs recorded for its own mirrored constant.
// If the v2 identity DDL below ever diverges from packages/store's, a migrated
// store stops matching a fresh one — keep them in step by hand.
//
// ORDER OF OPERATIONS (design section 6, and the order is load-bearing):
//   1. REFUSALS FIRST, before any file is touched: missing --db, a store
//      already at/past v2 (idempotent no-op, byte-identical), a too-new store
//      (refuse, never downgrade), a file that is not a v1 Sterling store. The
//      version probe reads the SQLite header's user_version field DIRECTLY
//      (offset 60, big-endian u32 — research_finding 5555895c), so a refused
//      run opens no connection, creates no -wal/-shm sidecar, and leaves no
//      litter. A HOT -wal (a pending checkpoint could hold a newer
//      user_version) falls back to a read-only SQLite read, disclosed.
//   2. BACKUP FIRST: WAL checkpoint, then VACUUM INTO a backup beside the db,
//      before any mutation — so even a failed run is restorable.
//   3. CLASSIFY MECHANICALLY, from status/superseded_by + record_links only —
//      never from prose (design section 6). Two distinct legacy shapes:
//        * COLLAPSE (a legacy knowledge_update/knowledge_supersede chain): a
//          record_links rel='supersedes' edge (source = successor). The chain
//          collapses onto its TERMINUS, which keeps its id permanently.
//        * RETIREMENT (knowledge_retire / retireInFavorOf duplicate
//          consolidation): a superseded_by column value with NO links edge —
//          exactly the shape migration-preflight.mjs documents. Two DIFFERENT
//          records, not two versions of one, so the retired record STAYS a
//          record (lifecycle 'retired') and gains a supersedes RELATION.
//   4. MUTATE IN ONE TRANSACTION, VERIFY, THEN BUMP LAST. Any verification
//      failure rolls the whole transaction back with user_version UNCHANGED.
//   5. JOURNAL: a manifest JSON beside the db on every attempted run (success
//      or verification failure) — counts, backup path, schema versions
//      before/after, every collapse/retirement/drop disclosure, verdict.
//
// DESIGN CHOICES MADE HERE THAT THE DESIGN DID NOT FIX (flagged in the S4
// handoff, disclosed in every manifest this script writes):
//   * archived snapshots keep their OWN historical id in the body (that is what
//     the citation pinned), stored under the canonical record_id + the version
//     position they occupied;
//   * relation endpoints are REMAPPED to canonical ids (an alias is a dead-id
//     lookup, not a live namespace) and a relation that becomes a self-edge
//     after remapping is dropped;
//   * a DANGLING SUPERSESSION pointer REFUSES the migration (identity is at
//     stake), while a dangling NON-identity link (`cites`, `informed_by`, …) is
//     dropped and disclosed — pre-existing dead links exist in real stores
//     (preflight counts them as links_targeting_missing) and must not
//     permanently block the wave;
//   * record_links is DROPPED once its content has moved, so a migrated store
//     matches a fresh v2 store's schema instead of keeping a stale edge table
//     a future reader could mistake for truth (the backup + manifest hold the
//     provenance);
//   * records_fts is reconciled MECHANICALLY (rows for collapsed ids deleted,
//     duplicates folded) rather than recomputed: the per-type FTS text builder
//     lives in packages/schemas' RECORD_TYPES and cannot be mirrored here
//     honestly. A surviving record with NO fts row therefore REFUSES (its text
//     cannot be synthesized) rather than silently becoming unrankable.
//
// EXIT CODES: --db: 0 success / already-migrated - 1 verification failed
// (nothing bumped) - 2 refusal before work - 3 unimplemented mode.
// --all-stores: 0 every enumerated store succeeded (migrated/already/missing
// only) - 1 at least one store failed. STDOUT carries exactly one JSON-Lines
// record per enumerated store (the --db JSON shape, plus store/origin); the
// {total, migrated, already, failed, missing} summary and the advisory
// close-your-sessions warning both go to STDERR, deliberately kept OUT of the
// per-store stdout stream so a caller counting/parsing stdout lines never
// off-by-ones on a summary shaped like just another store result.
//
// --ALL-STORES (fleet mode, decision migrate-stores-all-stores-advisory-fleet
// -mode — INVERTS the earlier exit-3 refusal stub): enumerates every store on
// the machine — every registered project's <repo>/.sterling/sterling.db
// (from the project registry, ~/.sterling/registry.db or STERLING_REGISTRY_DB
// — the SAME env override packages/store/src/registry.ts's registryPath()
// honors), each such project's OWN configured domain mounts (read straight
// from that project's .sterling/config.json — stack_tags + domain_paths
// overrides, the same shape packages/store/src/mounted.ts's
// resolveDomainMounts resolves, parsed by hand here since this file has no
// workspace import — see "MIRRORED, NOT IMPORTED" above), and every
// default-root ~/.sterling/domains/*/sterling.db (so an orphaned/renamed
// domain nothing currently mounts still gets swept) — deduped by resolved
// absolute path. Domain roots (source 3 only) resolve against THIS machine's
// homedir() by default (Node's own os.homedir(), which already honors the
// HOME env var on POSIX — it composes with STERLING_REGISTRY_DB for full
// test isolation), or against `--roots <dir>[,<dir>...]` when given —
// REPLACING the default root entirely, mirroring scripts/domain-doctor.mjs's
// own --roots flag exactly. Project-config domain mounts (source 2) are
// unaffected by --roots — they always resolve against each project's own
// .sterling/config.json. Each store runs the EXISTING single-db flow via a
// SELF-SPAWN of this exact script (never a refactor of the --db path, so that
// path stays byte-identical and one store's crash/hang cannot take another
// down), CONTINUING past per-store failures. ADVISORY posture, same as --db:
// no live-writer detection is attempted (no PID/lock surface exists to check
// it), so the close-your-sessions warning is printed once, up front.

import { existsSync, openSync, readSync, closeSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// See "MIRRORED, NOT IMPORTED" above before changing either constant.
const TARGET_SCHEMA_VERSION = 2;
const TOOL = 'migrate-stores';
// --all-stores self-spawns THIS exact file, once per enumerated store — see
// the --ALL-STORES header note for why (byte-identical --db path, per-store
// process isolation).
const SELF_PATH = fileURLToPath(import.meta.url);

// Verbatim from packages/store/src/index.ts's DDL (schema v2 identity tables).
// The `records` v2 COLUMNS (lifecycle/freshness/version) are added by
// ensureRecordColumns() below, because CREATE TABLE IF NOT EXISTS never alters
// an existing table.
const V2_IDENTITY_DDL = `
CREATE TABLE IF NOT EXISTS record_versions (
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (record_id, version)
);
CREATE TABLE IF NOT EXISTS record_aliases (
  historical_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  archived_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- remove() deletes aliases by canonical_id.
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON record_aliases(canonical_id);
CREATE TABLE IF NOT EXISTS record_relations (
  source_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, rel, target_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_target ON record_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_rel_target ON record_relations(rel, target_id);
`;

function fail(msg, code = 2) {
  console.error(`${TOOL}: ${msg}`);
  process.exit(code);
}

/**
 * A value-taking flag's argument. REFUSES loudly (never silently accepts) a
 * value that is missing or itself starts with '--' — without this, a
 * malformed invocation like `--all-stores --invoked-by --all-stores` would
 * silently forward the LITERAL STRING '--all-stores' as --invoked-by's
 * value, and the --all-stores self-spawn's `hasFlag('all-stores')` check in
 * the CHILD process re-enters fleet mode recursively (roster review finding,
 * fixer-mode) — refusing here kills that recursion vector at its root,
 * rather than trying to detect it downstream.
 */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(
      `--${name} requires a value, got ${value === undefined ? 'nothing (it was the last argument)' : `another flag ('${value}')`} — ` +
        `a flag can never be the value of another flag.`
    );
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** Every value passed to a REPEATABLE flag, e.g. multiple --elect-successor. */
function argAll(name) {
  const flag = `--${name}`;
  const values = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag) values.push(process.argv[i + 1]);
  }
  return values;
}

// Every id Sterling mints is a UUID (v4-shaped, but this only checks the
// canonical 8-4-4-4-12 hex layout — it need not pin the version/variant
// nibbles, since the point is catching a typo/truncation, not validating
// UUID conformance).
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses every --elect-successor <oldId>=<winnerId> flag into a Map, syntax-
 * checked here (before any db work) so a malformed election fails loudly
 * before a backup is even taken. Semantic validation (does the conflict
 * exist, does the winner match the claimants) happens in classify(), which
 * has the actual legacy data.
 *
 * review fix F2 (roster review, board d055b150): a typo'd or space-padded id
 * used to sail through this parse and only surface later as a stale_election
 * or election_mismatch AFTER classify() ran — contradicting this function's
 * own "before a backup is even taken" promise (classify() runs, and its
 * failures are journalled, only after the backup). Both sides are trimmed and
 * must be UUID-shaped, or the flag itself is refused right here.
 */
function parseElections() {
  const elections = new Map();
  for (const raw of argAll('elect-successor')) {
    const eq = raw ? raw.indexOf('=') : -1;
    if (!raw || eq <= 0 || eq === raw.length - 1) {
      return fail(`--elect-successor requires '<oldId>=<winnerId>' (got '${raw}')`);
    }
    const oldId = raw.slice(0, eq).trim();
    const winnerId = raw.slice(eq + 1).trim();
    if (!UUID_SHAPE.test(oldId) || !UUID_SHAPE.test(winnerId)) {
      return fail(
        `--elect-successor '${raw}' must be '<oldId>=<winnerId>' with both sides a UUID-shaped record id — got ` +
          `oldId='${oldId}'${UUID_SHAPE.test(oldId) ? '' : ' (not UUID-shaped)'}, winnerId='${winnerId}'` +
          `${UUID_SHAPE.test(winnerId) ? '' : ' (not UUID-shaped)'}`
      );
    }
    if (elections.has(oldId) && elections.get(oldId) !== winnerId) {
      return fail(
        `--elect-successor given twice for '${oldId}' with different winners ('${elections.get(oldId)}' vs ` +
          `'${winnerId}') — ambiguous, refusing rather than picking one`
      );
    }
    elections.set(oldId, winnerId);
  }
  return elections;
}

/** The DERIVED served status — the one definition mirrored from
 *  packages/store's SterlingStore.derivedStatus (it is private there). */
function derivedStatus(lifecycle, freshness) {
  if (lifecycle === 'retired') return 'superseded';
  return freshness === 'flagged_stale' ? 'flagged_stale' : 'active';
}

/** Legacy `status` -> the v2 (lifecycle, freshness) pair, mirroring
 *  SterlingStore.resolveIdentity's status compatibility mapping. */
function identityFromLegacyStatus(status, retired) {
  if (retired) return { lifecycle: 'retired', freshness: 'fresh' };
  if (status === 'flagged_stale') return { lifecycle: 'live', freshness: 'flagged_stale' };
  return { lifecycle: 'live', freshness: 'fresh' };
}

/**
 * user_version WITHOUT opening a connection: bytes 60..63 of the SQLite header,
 * big-endian (research_finding 5555895c — an application-owned integer, never
 * SQLite's own PRAGMA schema_version). Refusal paths must leave NO litter, and
 * a read-only DatabaseSync open of a WAL store can materialize a -shm sidecar;
 * reading the header cannot touch anything.
 *
 * A HOT -wal is the one case the header cannot answer (a committed but
 * un-checkpointed user_version lives in the WAL), so that case falls back to a
 * read-only SQLite read and says so.
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
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return { version: fromHeader, source: 'header' };
  // Hot WAL: read through SQLite so a checkpointed-but-unmerged user_version is
  // not missed. This may create a -shm sidecar; disclosed rather than hidden.
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    return { version, source: 'wal-aware read-only connection (a -wal sidecar was present, so the file header alone could be stale)' };
  } catch (e) {
    return { error: `could not read the schema version of '${dbPath}' through a read-only connection (a -wal sidecar is present, so the header alone cannot be trusted): ${e.message}` };
  } finally {
    db?.close();
  }
}

/** ALTER TABLE records ADD COLUMN for each v2 identity column that is absent —
 *  the piece CREATE TABLE IF NOT EXISTS can never do. */
function ensureRecordColumns(db) {
  const present = new Set(db.prepare('PRAGMA table_info(records)').all().map((c) => c.name));
  const added = [];
  const wanted = [
    ["lifecycle", "ALTER TABLE records ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'live'"],
    ["freshness", "ALTER TABLE records ADD COLUMN freshness TEXT NOT NULL DEFAULT 'fresh'"],
    ["version", 'ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [name, sql] of wanted) {
    if (present.has(name)) continue;
    db.exec(sql);
    added.push(name);
  }
  return added;
}

/**
 * MECHANICAL classification (design section 6): who supersedes whom, from
 * record_links + the superseded_by column ONLY. Returns the collapse chains,
 * the retirements, and every conflict that must refuse.
 *
 * `elections` is a Map<oldId, winnerId> built from repeatable
 * --elect-successor <oldId>=<winnerId> flags (board d055b150): a human-ruled
 * resolution of a genuine multi_successor conflict, run through this
 * journalled classifier rather than a hand-edit. An election is consumed
 * ONLY against a real multi-successor conflict on oldId whose claimant set
 * contains winnerId — a mismatch, or a stale election naming a conflict that
 * does not exist, both refuse loudly rather than being silently ignored
 * (electionsUsed tracks which elections actually fired; anything left over
 * at the end refuses too).
 */
function classify(records, links, elections = new Map()) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const disclosures = [];
  const failures = [];
  const electionsUsed = new Set();
  // Every supersedes edge an election DROPPED, as `${sourceId}|${targetId}`
  // (the raw record_links direction: source = claimant, target = oldId).
  // The relation-building pass in main() iterates the ORIGINAL link rows
  // independently of this function's internal `successors` maps, so a
  // dropped claim must be surfaced here too — otherwise the raw edge
  // survives, gets remapped to canonical ids, and re-appears as a relation
  // the election never elected (measured while pinning S4-E1: Q2's dropped
  // edge to P re-emerged as Q2-supersedes-Q1 once P canonicalized to Q1).
  const electionDroppedEdges = new Set();

  // oldId -> Map(newId -> Set(which legacy surface claimed it)). Both surfaces
  // describing the SAME edge is the reciprocal shape the design expects; two
  // different successors is a conflict, whichever surfaces disagree.
  const claims = new Map();
  const claim = (oldId, newId, surface) => {
    if (!claims.has(oldId)) claims.set(oldId, new Map());
    const m = claims.get(oldId);
    if (!m.has(newId)) m.set(newId, new Set());
    m.get(newId).add(surface);
  };

  for (const l of links) {
    if (l.rel !== 'supersedes') continue;
    if (l.source_id === l.target_id) {
      // The self-edge shape packages/store's insertRecord already skips on
      // re-insert (S2 note) — skipped here too, disclosed, never inferred away.
      disclosures.push(`self-referential supersedes edge on '${l.source_id}' skipped (a record cannot supersede itself)`);
      continue;
    }
    claim(l.target_id, l.source_id, 'record_links');
  }
  for (const r of records) {
    if (!r.superseded_by) continue;
    if (r.superseded_by === r.id) {
      disclosures.push(`self-referential superseded_by on '${r.id}' skipped (a record cannot supersede itself)`);
      continue;
    }
    claim(r.id, r.superseded_by, 'superseded_by');
  }

  const collapseSuccessor = new Map(); // oldId -> terminus-ward successor id
  const retirements = new Map(); // retiredId -> replacementId
  // PROMOTION tombstones (found live on the repo store, 2026-08-22; pin S4-M4):
  // knowledge_promote copies a record into a DOMAIN store and tombstones the
  // project record with superseded_by = the id it got THERE — a successor that
  // deliberately does not exist locally. Column-only, target-missing is that
  // shape's distinct signature (design: "retirement/promotion classified by
  // their distinct shapes"); the successor is recorded as FOREIGN, disclosed,
  // never treated as corruption.
  const foreignRetirements = new Map(); // retiredId -> foreign (cross-store) successor id
  for (const [oldId, successors] of claims) {
    if (successors.size > 1) {
      // TRANSITIVE-EDGE COLLAPSE (found live on the node domain store,
      // 2026-08-22; pin S4-M3): the legacy update path COPIED links[] forward
      // on every re-mint, so a terminus carries supersedes edges to ALL its
      // ancestors and an ancestor looks multi-claimed. When the record's own
      // superseded_by column names ONE immediate successor and every other
      // claimant lies further along that same column chain, the extra edges
      // are copies — dropped, disclosed. Genuinely divergent claimants (no
      // single column chain containing them all) still refuse below.
      const columnSuccessor = byId.get(oldId)?.superseded_by ?? null;
      if (columnSuccessor && successors.has(columnSuccessor)) {
        const onChain = new Set();
        let cur = columnSuccessor;
        for (let hop = 0; hop < 256 && cur && !onChain.has(cur); hop++) {
          onChain.add(cur);
          cur = byId.get(cur)?.superseded_by ?? null;
        }
        const extras = [...successors.keys()].filter((s) => s !== columnSuccessor);
        for (const s of extras) {
          // The superseded_by COLUMN was v1's only serving surface —
          // resolveTerminus and every read walked columns, never links. A
          // link-only extra claimant therefore never served: on the column
          // chain it is a legacy link-copy (transitive), off the chain it is
          // an amendment/fork mis-encoded as a supersedes edge (found live:
          // decision a127e6e1 claimed by its rewrite AND its amendment). The
          // column claim wins — the winner was already written, not invented;
          // the dropped edge survives in the backup and this journal.
          const claimSurfaces = successors.get(s);
          if (claimSurfaces && claimSurfaces.has('superseded_by')) continue; // column-corroborated: a genuine conflict, refuse below
          successors.delete(s);
          disclosures.push(
            onChain.has(s)
              ? `transitive supersedes edge '${s}' -> '${oldId}' dropped: '${s}' lies further along '${oldId}''s own superseded_by chain — a legacy link-copy, not a second successor`
              : `non-serving supersedes edge '${s}' -> '${oldId}' dropped: v1 served only the superseded_by column (which names '${columnSuccessor}'); this link-only claim never resolved and reads as an amendment/fork mis-encoded as supersession`
          );
        }
      }
    }
    // ELECTION (board d055b150): a human-ruled resolution of a genuine
    // multi-successor conflict — the automatic transitive-edge collapse above
    // only fires when oldId's OWN superseded_by column names one authoritative
    // chain, which is exactly what is missing when oldId has no local record
    // row at all (an absent target, see below) or when the claimants are
    // independent forks rather than copies of one column. Applied AFTER the
    // auto-collapse pass, so an election is never needed for a conflict the
    // mechanical pass already resolved on its own.
    if (successors.size > 1 && elections.has(oldId)) {
      const winnerId = elections.get(oldId);
      if (!successors.has(winnerId)) {
        failures.push({
          kind: 'election_mismatch',
          detail:
            `--elect-successor '${oldId}=${winnerId}' names a winner that is NOT among '${oldId}''s claimants ` +
            `(${[...successors.keys()].join(', ')}) — the election does not match the data and is refused rather ` +
            `than silently ignored. REMEDY: re-run electing one of the listed claimants.`,
        });
        electionsUsed.add(oldId);
        continue;
      }
      const dropped = [...successors.keys()].filter((s) => s !== winnerId);
      for (const s of dropped) {
        const claimSurfaces = successors.get(s);
        successors.delete(s);
        electionDroppedEdges.add(`${s}|${oldId}`);
        disclosures.push(
          `ELECTION --elect-successor '${oldId}=${winnerId}' resolved a MULTI-SUCCESSOR conflict: supersedes edge ` +
            `'${s}' -> '${oldId}' (via ${[...claimSurfaces].sort().join(' + ')}) dropped as the losing claimant; ` +
            `'${winnerId}' is the sole surviving successor by human ruling, not by mechanical guess.`
        );
      }
      electionsUsed.add(oldId);
    }
    if (successors.size > 1) {
      failures.push({
        kind: 'multi_successor',
        detail:
          `record '${oldId}' is claimed as superseded by ${successors.size} different records ` +
          `(${[...successors.keys()].join(', ')}) — a MULTI-SUCCESSOR conflict. One successor maximum is the rule ` +
          `[stable-identity-design-v2]; picking a winner mechanically would invent a version order nobody wrote.`,
      });
      continue;
    }
    const [newId, surfaces] = [...successors.entries()][0];
    if (!byId.has(oldId)) {
      // ABSENT TARGET (board d055b150, the deepdots c1bae7e0 case): oldId
      // itself has no local record row — a project-local handoff, or a
      // supersession this store's authors recorded for an id it never held.
      // Its claims live entirely in a CLAIMANT's record_links edge, never in
      // a row of its own (a superseded_by-column claim always names a REAL
      // record as oldId — see the claim-building loop above — so this shape
      // is link-only by construction), so there is no body to archive and no
      // chain to collapse. record_relations requires BOTH endpoints to
      // resolve to a live local record (verified below in main()), so even a
      // SINGLY-claimed absent target cannot be materialized here — election
      // or not. review fix F1 (roster review, board d055b150): this check
      // used to be gated on `electionsUsed.has(oldId)`, so a singly-claimed
      // absent target (no conflict, no election — deepdots' own c1bae7e0
      // shape before any human ruling) fell through to collapseSuccessor,
      // became a chain root, and crashed `JSON.parse(alias.row.body)` inside
      // the transaction (safe rollback, but unactionable) because there was
      // no row to archive. The absence is disclosed regardless of whether an
      // election named it.
      disclosures.push(
        electionsUsed.has(oldId)
          ? `ELECTION --elect-successor '${oldId}=${newId}' resolved a MULTI-SUCCESSOR conflict on an ABSENT target: ` +
              `'${oldId}' has no local record row in this store (its only trace is the claimants' supersedes edges). ` +
              `The elected supersedes edge from '${newId}' cannot be materialized as a record_relations row (both ` +
              `endpoints must resolve to a live local record), so it is dropped from the live graph; nothing was ` +
              `collapsed or aliased for '${oldId}', and this line is its provenance.`
          : `record '${oldId}' has no local record row in this store — an ABSENT target: its only trace is a ` +
              `supersedes claim from '${newId}' (via ${[...surfaces].sort().join(' + ')}). There is no body to ` +
              `archive and no chain to collapse, and the elected/sole successor's edge cannot be materialized as a ` +
              `record_relations row (both endpoints must resolve to a live local record), so it is dropped from the ` +
              `live graph; nothing was collapsed or aliased for '${oldId}', and this line is its provenance.`
      );
      continue;
    }
    if (!byId.has(newId)) {
      if (surfaces.size === 1 && surfaces.has('superseded_by')) {
        // The promote-tombstone signature: column-only claim at an id that was
        // minted in another (domain) store. Kept retired, successor recorded
        // as foreign — exactly what v1 served for this record.
        foreignRetirements.set(oldId, newId);
        disclosures.push(
          `record '${oldId}' names successor '${newId}' via superseded_by only, and no local record carries that id — ` +
            `classified as a PROMOTION tombstone (knowledge_promote mints the successor in a domain store); the ` +
            `successor is recorded as FOREIGN and the record stays retired.`
        );
        continue;
      }
      failures.push({
        kind: 'dangling_supersession',
        detail:
          `record '${oldId}' names successor '${newId}' (via ${[...surfaces].sort().join(' + ')}) but NO record with that id ` +
          `exists — a DANGLING supersession pointer whose target is missing/unresolvable. Identity is at stake here, so ` +
          `this refuses rather than guessing where the record went.`,
      });
      continue;
    }
    if (surfaces.has('record_links')) collapseSuccessor.set(oldId, newId);
    else retirements.set(oldId, newId);
  }

  // A STALE ELECTION — naming an oldId that carries no genuine
  // multi-successor conflict (never claimed at all, claimed by only one
  // record, or already resolved by the mechanical transitive-edge collapse
  // before the election was even consulted) — is an ERROR, not a no-op
  // (board d055b150): silently ignoring it would hide the fact that the
  // human's instruction no longer matches the data.
  for (const [oldId, winnerId] of elections) {
    if (electionsUsed.has(oldId)) continue;
    failures.push({
      kind: 'stale_election',
      detail:
        `--elect-successor '${oldId}=${winnerId}' names a conflict that does not exist in this store's legacy data ` +
        `— '${oldId}' is not claimed by more than one record (it may be unclaimed, singly-claimed, or already ` +
        `resolved without needing an election). A stale election is refused rather than silently ignored. REMEDY: ` +
        `drop this --elect-successor and re-run (the conflict does not exist, or the mechanical pass already ` +
        `resolved it).`,
    });
  }

  // BRANCHED (converging) chains: two records collapsing onto one successor
  // give that successor two version-1s. The preflight's component report cannot
  // tell this from a healthy chain (S2 hand-off note), so it is detected here.
  const predecessors = new Map();
  for (const [oldId, newId] of collapseSuccessor) {
    if (!predecessors.has(newId)) predecessors.set(newId, new Set());
    predecessors.get(newId).add(oldId);
  }
  for (const [newId, preds] of predecessors) {
    if (preds.size <= 1) continue;
    failures.push({
      kind: 'branched_chain',
      detail:
        `record '${newId}' is the successor of ${preds.size} different records (${[...preds].join(', ')}) — a BRANCHED ` +
        `(converging) chain, so the version positions of its history are ambiguous. Resolve by hand; nothing was collapsed.`,
    });
  }

  // Chains: walk each root (no predecessor) to its terminus.
  const nodes = new Set([...collapseSuccessor.keys(), ...collapseSuccessor.values()]);
  const chains = [];
  const visited = new Set();
  for (const node of nodes) {
    if (predecessors.has(node)) continue; // not a root
    const path = [node];
    visited.add(node);
    let cursor = node;
    while (collapseSuccessor.has(cursor)) {
      const next = collapseSuccessor.get(cursor);
      if (path.includes(next)) {
        failures.push({
          kind: 'cycle',
          detail: `supersession CYCLE detected: ${[...path, next].join(' -> ')} — a chain must end at a terminus, so nothing was collapsed.`,
        });
        break;
      }
      path.push(next);
      visited.add(next);
      cursor = next;
    }
    if (path.length > 1) chains.push(path);
  }
  for (const node of nodes) {
    if (visited.has(node)) continue;
    failures.push({
      kind: 'cycle',
      detail:
        `record '${node}' sits in a supersession CYCLE with no terminus (every member names a successor), so no id can ` +
        `be the permanent canonical one — nothing was collapsed.`,
    });
  }

  return { byId, chains, collapseSuccessor, retirements, foreignRetirements, electionDroppedEdges, disclosures, failures };
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function refuseVerification(manifestPath, manifest, reason, detail, backupPath) {
  manifest.schema_version_after = manifest.schema_version_before;
  manifest.verification = { ok: false, reason, detail };
  writeManifest(manifestPath, manifest);
  console.log(JSON.stringify({ ok: false, reason, detail, backup_path: backupPath, manifest_path: manifestPath }));
  console.error(
    `${TOOL}: ${reason} — ${detail} NOTHING was migrated: user_version is unchanged at ${manifest.schema_version_before}, ` +
      `the store is as it was, and the pre-run backup is at '${backupPath}' (journal: '${manifestPath}').`
  );
  process.exit(1);
}

/** Every array entry that is a non-empty string; anything else (missing
 *  field, wrong shape, a malformed project config) is dropped rather than
 *  thrown on — one project's bad config.json must never abort the sweep. */
function safeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.length > 0);
}

/** Root(s) for the default-root domain-store scan (source 3) — mirrors
 *  scripts/domain-doctor.mjs's own `--roots` flag EXACTLY: a single
 *  `--roots <dir>[,<dir>...]` REPLACES the default `<homedir>/.sterling/
 *  domains` root entirely (never appends to it), so a fixture-isolated test
 *  never has to touch a real machine's domains. The registry stays
 *  STERLING_REGISTRY_DB-overridable (source 1) and project-config domain
 *  mounts (source 2) are UNAFFECTED by this flag — they resolve against each
 *  project's own .sterling/config.json, which names its own paths.
 *
 *  `explicit: true` marks roots that came from the flag itself, so the
 *  caller can apply the same honest split the registry already gets: a
 *  DEFAULT root that is absent is benign (nothing to sweep), while a root
 *  the caller NAMED via --roots and got wrong (a typo) must not silently
 *  enumerate zero stores and exit 0 (roster review finding, fixer-mode). */
function domainRoots() {
  const given = arg('roots');
  return { roots: given ? given.split(',') : [join(homedir(), '.sterling', 'domains')], explicit: !!given };
}

/**
 * Enumerates every store the fleet sweep should cover (decision
 * migrate-stores-all-stores-advisory-fleet-mode) — see the --ALL-STORES
 * header note for the three sources and the dedup/homedir reasoning. Never
 * throws: a malformed registry or project config is disclosed to stderr and
 * skipped, never fatal to the sweep; an unreadable filesystem entry (a
 * broken symlink, an EACCES directory) inside a domains root is likewise
 * caught per-entry and returned in `unreadable` rather than propagating —
 * one bad entry must never abort the whole enumeration (roster review fix,
 * fixer-mode).
 *
 * Returns `{ candidates, unreadable }`: `candidates` in first-seen order,
 * deduped by `resolve()`d absolute path — a project's own domain mount and
 * the default-root scan commonly name the identical file and must migrate
 * exactly once. `unreadable` is `{ origin, error, path }[]` — `path` is the
 * best-effort store path when the entry name was known (a stat failure on a
 * specific subdirectory), or `null` when the whole root's directory listing
 * itself failed (nothing beneath it was ever named).
 */
function enumerateStores() {
  const seen = new Map(); // resolved path -> origin (first sighting wins)
  const unreadable = [];
  const add = (path, origin) => {
    const resolved = resolve(path);
    if (!seen.has(resolved)) seen.set(resolved, origin);
  };

  // (1) + (2): every registered project (the registry stores no liveness —
  // it is a record of /sterling:init'd projects, not an aliveness probe) +
  // its OWN configured domain mounts.
  //
  // THE HONEST THREE-WAY SPLIT (roster review, fixer-mode): a registry that
  // cannot be read is NOT the same outcome as a registry that legitimately
  // never existed, and an EXPLICIT STERLING_REGISTRY_DB naming a path that
  // is not there is a caller error, not silence:
  //   (a) the DEFAULT path is absent -> benign, zero registered projects,
  //       disclosed on stderr, never a failure;
  //   (b) an EXPLICIT STERLING_REGISTRY_DB path is absent -> the caller
  //       asserted a specific file exists; it does not, so this is an
  //       enumeration error (counted, forces a non-zero exit);
  //   (c) the file exists but cannot be opened/queried (corrupt, EACCES) ->
  //       also an enumeration error. Without this, a sweep that silently
  //       failed to read EVERY registered project could still print
  //       failed:0 and exit 0 — a clean-looking report over a report that
  //       covered nothing.
  const registryExplicit = process.env.STERLING_REGISTRY_DB !== undefined;
  const registryDbPath = process.env.STERLING_REGISTRY_DB ?? join(homedir(), '.sterling', 'registry.db');
  if (!existsSync(registryDbPath)) {
    if (registryExplicit) {
      unreadable.push({
        origin: `project registry (STERLING_REGISTRY_DB='${registryDbPath}')`,
        error: 'no such file — an explicitly named registry path was given and must exist',
        path: null,
      });
    } else {
      console.error(
        `${TOOL}: no project registry at '${registryDbPath}' — treating as zero registered projects (nothing has ` +
          `been /sterling:init'd on this machine at this default location).`
      );
    }
  } else {
    let registry;
    try {
      registry = new DatabaseSync(registryDbPath, { readOnly: true });
      const projects = registry.prepare('SELECT repo_path FROM projects').all();
      for (const row of projects) {
        const repoPath = row.repo_path;
        add(join(repoPath, '.sterling', 'sterling.db'), `project '${repoPath}'`);
        const configPath = join(repoPath, '.sterling', 'config.json');
        // NO config.json at all is NOT an error — plenty of registered
        // projects never customize domain mounts, and nothing requires the
        // file to exist. A config that exists but fails to READ or PARSE is
        // different: it is an ENUMERATION ERROR (same three-way honesty as
        // the registry above), because that project's domain_paths overrides
        // are silently unreachable — without this, a corrupt config could
        // drop custom domain mounts from the sweep while the run still
        // exited 0 (roster review finding, fixer-mode). The project's OWN
        // store (already add()ed above) is unaffected either way: its
        // enumeration never depended on this file.
        if (!existsSync(configPath)) continue;
        // ONE try/catch per project (not folded into the outer registry
        // try) — a single project's bad config (unparseable JSON, OR
        // structurally-invalid-but-valid JSON: stack_tags that isn't an
        // array, a domain_paths entry that isn't a string and would throw
        // inside resolve()) must disclose ONE skipped line naming THAT
        // project and move on — it must never abort enumeration of every
        // project after it in the registry (roster review finding,
        // fixer-mode: this used to share the outer try, so one bad project
        // silently dropped the rest of the sweep).
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf8'));
          if (config?.stack_tags !== undefined && !Array.isArray(config.stack_tags)) {
            throw new Error(`'stack_tags' must be an array, got ${typeof config.stack_tags}`);
          }
          const domainPaths = config?.domain_paths && typeof config.domain_paths === 'object' ? config.domain_paths : {};
          for (const tag of safeStringArray(config?.stack_tags)) {
            const rawMount = domainPaths[tag];
            if (rawMount !== undefined && typeof rawMount !== 'string') {
              throw new Error(`domain_paths['${tag}'] must be a string, got ${typeof rawMount}`);
            }
            // A config.domain_paths override may be RELATIVE (a consumer
            // project's own convenience convention); it must resolve against
            // THAT PROJECT's own directory, never against this sweep's cwd —
            // a relative override resolved from the Sterling clone's cwd
            // would migrate an unrelated file (roster review finding,
            // fixer-mode). An already-absolute override is unchanged by
            // resolve() (its second argument is ignored).
            const domainDbPath = rawMount ? resolve(repoPath, rawMount) : join(homedir(), '.sterling', 'domains', tag, 'sterling.db');
            add(domainDbPath, `domain '${tag}' (mounted by project '${repoPath}')`);
          }
        } catch (e) {
          unreadable.push({ origin: `project config '${configPath}' (project '${repoPath}')`, error: e.message, path: null });
        }
      }
    } catch (e) {
      unreadable.push({ origin: `project registry '${registryDbPath}'`, error: e.message, path: null });
    } finally {
      registry?.close();
    }
  }

  // (3): every domain store under the resolved root(s) (--roots override, or
  // the default <homedir>/.sterling/domains), mounted by a registered
  // project's config or not. Both the directory listing itself and each
  // entry's stat are fallible (permissions, a broken symlink) — caught
  // per-call so one bad entry cannot abort the rest of the scan.
  const { roots: rootsToScan, explicit: rootsExplicit } = domainRoots();
  for (const domainsRoot of rootsToScan) {
    if (!existsSync(domainsRoot)) {
      if (rootsExplicit) {
        unreadable.push({
          origin: `--roots '${domainsRoot}'`,
          error: 'no such directory — an explicitly named root was given via --roots and must exist',
          path: null,
        });
      }
      continue;
    }
    let names;
    try {
      names = readdirSync(domainsRoot).sort();
    } catch (e) {
      unreadable.push({ origin: `domain root '${domainsRoot}'`, error: e.message, path: null });
      continue;
    }
    for (const name of names) {
      const entryPath = join(domainsRoot, name);
      let isDirectory;
      try {
        isDirectory = statSync(entryPath).isDirectory();
      } catch (e) {
        unreadable.push({ origin: `domain '${name}' (${domainsRoot} root)`, error: e.message, path: join(entryPath, 'sterling.db') });
        continue;
      }
      if (!isDirectory) continue;
      add(join(entryPath, 'sterling.db'), `domain '${name}' (${domainsRoot} root)`);
    }
  }

  return { candidates: [...seen.entries()].map(([path, origin]) => ({ path, origin })), unreadable };
}

/**
 * --all-stores (fleet mode, decision migrate-stores-all-stores-advisory-
 * fleet-mode — inverts the earlier exit-3 refusal stub). See the file's
 * --ALL-STORES header note for the full design; this is the driver: warn
 * once, enumerate, self-spawn the --db flow per store, print one result line
 * each plus a final summary, never abort the loop on a per-store failure.
 */
function runAllStores() {
  if (hasFlag('elect-successor')) {
    fail(
      `--all-stores cannot be combined with --elect-successor: an election names a specific conflict inside ONE store's ` +
        `legacy data, and applying it blindly across every enumerated store would either misfire on unrelated data or refuse ` +
        `loudly as a stale_election everywhere else. Resolve a multi-successor conflict with a targeted ` +
        `'--db <path> --elect-successor <oldId>=<winnerId>' run instead.`
    );
  }
  const invokedBy = arg('invoked-by') ?? 'all-stores-sweep';

  console.error(
    `${TOOL}: --all-stores is an ADVISORY sweep, same posture every single --db run has always had — CLOSE EVERY SESSION ` +
      `(Claude Code CLI, MCP server, TUI) holding any of these stores open before continuing. No live-writer detection is ` +
      `attempted (no PID/lock surface exists to check it); a store migrated while a session holds it open leaves that ` +
      `session refusing writes until it exits and relaunches.`
  );

  const { candidates, unreadable } = enumerateStores();
  let migrated = 0;
  let already = 0;
  let failed = 0;
  let missing = 0;

  // An unreadable filesystem entry (EACCES, a broken symlink) is counted
  // under FAILED, never missing: `missing` means "confirmed absent, nothing
  // to do"; an entry that could not even be stat'd/listed is unactionable
  // the same way a failed migration is — it needs a human to look, not a
  // shrug. `skipped: true` (never `missing`, never a migration `ok:false`
  // shaped like a --db refusal) keeps it visibly distinct from both.
  for (const { origin, error, path } of unreadable) {
    failed++;
    // `db` mirrors the field name every --db-shaped success/failure line
    // carries (== the field a caller keys result lines by), even though
    // `path` may be null here (a whole-root readdir failure never named a
    // specific file).
    console.log(JSON.stringify({ ok: false, db: path, store: path, origin, skipped: true, error }));
  }

  for (const { path, origin } of candidates) {
    if (!existsSync(path)) {
      missing++;
      console.log(JSON.stringify({ ok: true, db: path, store: path, origin, missing: true }));
      continue;
    }
    const r = spawnSync(process.execPath, [SELF_PATH, '--db', path, '--invoked-by', invokedBy], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    const stdout = (r.stdout ?? '').trim();
    let parsed = null;
    if (stdout) {
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
    }
    const succeeded = r.status === 0 && parsed?.ok === true;
    const line = parsed
      ? { ...parsed, store: path, origin, exit_code: r.status }
      : {
          ok: false,
          store: path,
          origin,
          exit_code: r.status,
          error: (r.stderr ?? '').trim() || stdout || `migrate-stores.mjs exited ${r.status} with no parseable output`,
        };
    console.log(JSON.stringify(line));
    if (succeeded) {
      if (parsed.already_migrated) already++;
      else migrated++;
    } else {
      failed++;
    }
  }

  // The summary goes to STDERR, deliberately — stdout carries exactly one
  // JSON-Lines record per enumerated store (the machine-parseable stream a
  // caller counts/greps), and a summary object shaped just like a per-store
  // line would be indistinguishable from one on a naive '{'-leading-line
  // scan, silently off-by-one-ing any consumer that counts stdout lines.
  console.error(JSON.stringify({ total: candidates.length + unreadable.length, migrated, already, failed, missing }));
  process.exit(failed === 0 ? 0 : 1);
}

function main() {
  if (hasFlag('all-stores')) {
    return runAllStores();
  }

  const dbPath = arg('db');
  if (!dbPath) return fail('--db <path-to-sterling.db> is required (or --all-stores, for a machine-wide sweep)');
  if (!existsSync(dbPath)) return fail(`no db file at '${dbPath}' — nothing was read, nothing was created`);

  // Syntax-checked before any db work; semantic validation (against the real
  // legacy claims) happens inside classify().
  const elections = parseElections();
  const invokedBy = arg('invoked-by') ?? 'direct';

  const probe = probeSchemaVersion(dbPath);
  if (probe.error) return fail(probe.error);
  const before = probe.version;

  if (before > TARGET_SCHEMA_VERSION) {
    return fail(
      `refusing '${dbPath}' — schema version mismatch: this store's user_version (${before}) is NEWER than the schema ` +
        `version this migration produces (${TARGET_SCHEMA_VERSION}). It was migrated by a newer build of Sterling, so running ` +
        `this migration over it would be a DOWNGRADE and risks corrupting the store. Nothing was written, no backup was ` +
        `taken. Upgrade this build (or restore a backup taken before that migration) before continuing.`
    );
  }
  if (before === TARGET_SCHEMA_VERSION) {
    // Idempotent no-op — the same marker name the S1 preflight report uses.
    // Not one byte is touched: the version probe never opened a connection.
    console.log(JSON.stringify({ ok: true, already_migrated: true, db: dbPath, schema_version: before }));
    return;
  }

  const at = new Date().toISOString();
  const stamp = at.replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.pre-v${TARGET_SCHEMA_VERSION}-${stamp}.backup.db`;
  const manifestPath = `${dbPath}.migration-${stamp}.json`;
  if (existsSync(backupPath)) return fail(`refusing to overwrite an existing backup at '${backupPath}'`);
  if (existsSync(manifestPath)) return fail(`refusing to overwrite an existing manifest at '${manifestPath}'`);

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    return fail(`could not open '${dbPath}' for writing: ${e.message}`);
  }
  db.exec('PRAGMA busy_timeout=5000');

  try {
    // Still a REFUSAL-BEFORE-WORK check: is this actually a v1 Sterling store?
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name)
    );
    for (const required of ['records', 'record_links', 'records_fts']) {
      if (!tables.has(required)) {
        return fail(
          `'${dbPath}' is at schema version ${before} but has no '${required}' table — this is not a v1 Sterling knowledge ` +
            `store (tables found: ${[...tables].sort().join(', ') || 'none'}). Nothing was written, no backup was taken.`
        );
      }
    }

    const records = db
      .prepare('SELECT id, type, status, superseded_by, created_at, updated_at, body FROM records ORDER BY rowid')
      .all();
    const links = db.prepare('SELECT source_id, rel, target_id FROM record_links ORDER BY rowid').all();

    // ---- 2. BACKUP FIRST, before any mutation -----------------------------
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    const manifest = {
      tool: TOOL,
      decision: 'stable-identity-design-v2',
      at,
      db: dbPath,
      backup_path: backupPath,
      schema_version_before: before,
      schema_version_after: before,
      schema_version_source: probe.source,
      counts: {
        records: records.length,
        record_links: links.length,
        chains_collapsed: 0,
        aliases_minted: 0,
        versions_archived: 0,
        retirements_preserved: 0,
        relations_migrated: 0,
        relations_dropped_intra_chain: 0,
        relations_dropped_by_election: 0,
        relations_dropped_unresolvable: 0,
        relations_remapped_to_canonical: 0,
        records_after: records.length,
        fts_rows_after: 0,
      },
      disclosures: [],
      verification: { ok: false, reason: 'not run' },
      // PROVENANCE (board d055b150): an unattributed store-mutating run cost
      // a real investigation and one retracted attribution — argv is the
      // post-node args verbatim (so any --elect-successor lands here exactly
      // as given), plus cwd/pid/ppid/invoked_by. Old journals predate this
      // field entirely; readers must tolerate its absence.
      invocation: {
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        pid: process.pid,
        ppid: process.ppid,
        invoked_by: invokedBy,
      },
    };

    // ---- 3. CLASSIFY -------------------------------------------------------
    const { byId, chains, collapseSuccessor, retirements, foreignRetirements, electionDroppedEdges, disclosures, failures } =
      classify(records, links, elections);
    manifest.disclosures.push(...disclosures);
    if (failures.length) {
      manifest.failures = failures;
      return refuseVerification(
        manifestPath,
        manifest,
        `verification failed before any mutation: ${failures.length} legacy supersession conflict(s) (${[
          ...new Set(failures.map((f) => f.kind)),
        ].join(', ')})`,
        failures.map((f) => f.detail).join(' | '),
        backupPath
      );
    }

    // Alias plan: every non-terminus chain member -> (terminus, position).
    const aliasPlan = []; // { historicalId, canonicalId, archivedVersion, body }
    const canonicalOf = new Map(); // historicalId -> terminus id
    const terminusVersion = new Map(); // terminus id -> chain length
    for (const chain of chains) {
      const terminus = chain[chain.length - 1];
      terminusVersion.set(terminus, chain.length);
      for (let i = 0; i < chain.length - 1; i++) {
        const historicalId = chain[i];
        aliasPlan.push({ historicalId, canonicalId: terminus, archivedVersion: i + 1, row: byId.get(historicalId) });
        canonicalOf.set(historicalId, terminus);
      }
      manifest.disclosures.push(
        `legacy supersede chain collapsed to its TERMINUS '${terminus}' (which keeps its id permanently, now version ` +
          `${chain.length}): ${chain.join(' -> ')}. The ${chain.length - 1} earlier id(s) become record_aliases rows and ` +
          `their bodies are archived in record_versions under the terminus; the intra-chain supersedes edges described ` +
          `version mechanics and are REMOVED from the live relation graph — this line is their provenance.`
      );
    }
    for (const [retiredId, replacementId] of retirements) {
      manifest.disclosures.push(
        `retirement PRESERVED (superseded_by with no record_links edge — the knowledge_retire/duplicate shape, not a ` +
          `version chain): '${retiredId}' stays a record with lifecycle 'retired' and gains a supersedes relation from ` +
          `'${replacementId}'.`
      );
    }

    const removedIds = new Set(aliasPlan.map((a) => a.historicalId));
    const liveIds = new Set(records.map((r) => r.id).filter((id) => !removedIds.has(id)));

    // ---- 4. MUTATE (one transaction), VERIFY, BUMP LAST -------------------
    const canonical = (id) => canonicalOf.get(id) ?? id;
    const relationRows = []; // { source_id, rel, target_id }
    const seenRelation = new Set();
    const addRelation = (sourceId, rel, targetId) => {
      const key = `${sourceId}\x1F${rel}\x1F${targetId}`;
      if (seenRelation.has(key)) return;
      seenRelation.add(key);
      relationRows.push({ source_id: sourceId, rel, target_id: targetId });
    };

    for (const l of links) {
      // The chain edges themselves: dropped from the live graph (provenance is
      // the per-chain disclosure above).
      if (l.rel === 'supersedes' && collapseSuccessor.get(l.target_id) === l.source_id) {
        manifest.counts.relations_dropped_intra_chain++;
        continue;
      }
      // ELECTION-DROPPED edges (board d055b150): a losing claimant's raw
      // record_links row still exists here, independent of classify()'s
      // internal `successors` maps — without this check it would canonicalize
      // to the elected winner's terminus and re-appear as a relation the
      // election never elected (its own provenance line was already written
      // above, in classify()'s disclosures).
      if (l.rel === 'supersedes' && electionDroppedEdges.has(`${l.source_id}|${l.target_id}`)) {
        manifest.counts.relations_dropped_by_election++;
        continue;
      }
      const source = canonical(l.source_id);
      const target = canonical(l.target_id);
      if (source !== l.source_id || target !== l.target_id) manifest.counts.relations_remapped_to_canonical++;
      if (source === target) {
        manifest.counts.relations_dropped_unresolvable++;
        manifest.disclosures.push(
          `relation '${l.source_id}' -${l.rel}-> '${l.target_id}' dropped: both ends resolve to the same canonical record ` +
            `'${source}' after chain collapse, and the relation graph holds no self-edges.`
        );
        continue;
      }
      if (!liveIds.has(source) || !liveIds.has(target)) {
        manifest.counts.relations_dropped_unresolvable++;
        manifest.disclosures.push(
          `relation '${l.source_id}' -${l.rel}-> '${l.target_id}' dropped: ${
            liveIds.has(source) ? `target '${target}'` : `source '${source}'`
          } does not resolve to a live record (a pre-existing dead link — preflight counts these as ` +
            `links_targeting_missing). It survives in the backup and in this journal, never in the verified v2 graph.`
        );
        continue;
      }
      addRelation(source, l.rel, target);
    }
    for (const [retiredId, replacementId] of retirements) {
      // Direction matches packages/store's insertRecord: source = successor.
      addRelation(canonical(replacementId), 'supersedes', canonical(retiredId));
    }
    for (const [retiredId, foreignId] of foreignRetirements) {
      // Cross-store edge — the shape knowledge_promote itself writes (the
      // store's addLink targetValidated precedent); source is FOREIGN and is
      // exempted, by name, from the local source-resolution verify below.
      addRelation(foreignId, 'supersedes', canonical(retiredId));
    }

    const ftsRows = db.prepare('SELECT record_id, text FROM records_fts').all();
    const ftsTextById = new Map();
    const ftsDuplicates = new Set();
    for (const row of ftsRows) {
      if (ftsTextById.has(row.record_id)) ftsDuplicates.add(row.record_id);
      else ftsTextById.set(row.record_id, row.text);
    }
    const ftsMissing = [...liveIds].filter((id) => !ftsTextById.has(id));

    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const addedColumns = ensureRecordColumns(db);
      if (addedColumns.length) {
        manifest.disclosures.push(`records table gained the v2 identity columns: ${addedColumns.join(', ')}.`);
      }
      db.exec(V2_IDENTITY_DDL);

      // 4a. archive + alias + delete every non-terminus chain member.
      const insertVersion = db.prepare(
        'INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, ?, ?, ?)'
      );
      const insertAlias = db.prepare(
        'INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const alias of aliasPlan) {
        // The snapshot keeps its OWN historical id and its own legacy envelope —
        // that is what the citation pinned — plus the version position it now
        // occupies in the canonical record's history.
        const archived = { ...JSON.parse(alias.row.body), version: alias.archivedVersion };
        insertVersion.run(alias.canonicalId, alias.archivedVersion, at, JSON.stringify(archived));
        insertAlias.run(alias.historicalId, alias.canonicalId, alias.archivedVersion, at);
        db.prepare('DELETE FROM records WHERE id = ?').run(alias.historicalId);
        db.prepare('DELETE FROM record_stack_tags WHERE record_id = ?').run(alias.historicalId);
        db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(alias.historicalId);
        db.prepare('DELETE FROM records_fts WHERE record_id = ?').run(alias.historicalId);
        manifest.counts.aliases_minted++;
        manifest.counts.versions_archived++;
      }
      manifest.counts.chains_collapsed = chains.length;
      manifest.counts.retirements_preserved = retirements.size;

      // 4b. relations.
      const insertRelation = db.prepare(
        'INSERT OR IGNORE INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)'
      );
      const relationsBySource = new Map();
      for (const r of relationRows) {
        insertRelation.run(r.source_id, r.rel, r.target_id, at);
        const list = relationsBySource.get(r.source_id) ?? [];
        list.push({ rel: r.rel, target_id: r.target_id });
        relationsBySource.set(r.source_id, list);
      }
      manifest.counts.relations_migrated = relationRows.length;
      db.exec('DROP TABLE record_links');
      manifest.disclosures.push(
        'record_links DROPPED after its content moved to record_relations, so a migrated store matches a fresh v2 store ' +
          'schema instead of keeping a stale edge table beside the authoritative one (the backup holds the original).'
      );

      // 4c. every surviving record becomes a v2 record.
      const updateRecord = db.prepare(
        'UPDATE records SET status = ?, superseded_by = ?, lifecycle = ?, freshness = ?, version = ?, body = ? WHERE id = ?'
      );
      for (const row of records) {
        if (removedIds.has(row.id)) continue;
        // RETIRED covers both the classified retirement (a named replacement)
        // and the legacy status:'superseded' row that names no successor at all
        // — the latter keeps its lifecycle honest without inventing a successor.
        const retired = retirements.has(row.id) || row.status === 'superseded';
        const { lifecycle, freshness } = identityFromLegacyStatus(row.status, retired);
        const version = terminusVersion.get(row.id) ?? 1;
        // Review fix B2: a legacy status:'superseded' row with NO classified
        // retirement has no successor — retirements.get() would be undefined,
        // which node:sqlite refuses to bind. Only a genuine retirement carries
        // a superseded_by value; the successor-less tombstone binds null.
        const supersededBy = retirements.has(row.id)
          ? canonical(retirements.get(row.id))
          : foreignRetirements.has(row.id)
            ? foreignRetirements.get(row.id)
            : null;
        const body = { ...JSON.parse(row.body) };
        body.lifecycle = lifecycle;
        body.freshness = freshness;
        body.version = version;
        // status/superseded_by are DERIVED at read in v2 and dropped from the
        // stored body (SterlingStore.storableBody); links[] is materialized
        // from record_relations, so the stored copy is kept in step with it.
        delete body.status;
        delete body.superseded_by;
        body.links = relationsBySource.get(row.id) ?? [];
        updateRecord.run(
          derivedStatus(lifecycle, freshness),
          supersededBy,
          lifecycle,
          freshness,
          version,
          JSON.stringify(body),
          row.id
        );
        if (row.status === 'superseded' && !retirements.has(row.id) && !foreignRetirements.has(row.id)) {
          manifest.disclosures.push(
            `record '${row.id}' carried legacy status 'superseded' but names no successor at all (no superseded_by, no ` +
              `record_links edge): it stays a record with lifecycle 'retired' and no supersedes relation. Nothing was ` +
              `inferred about where it went.`
          );
        }
      }

      // 4d. records_fts serves exactly the surviving set: rows for collapsed
      // ids are already deleted above; fold duplicates so one id has one row.
      for (const id of ftsDuplicates) {
        if (!liveIds.has(id)) continue;
        db.prepare('DELETE FROM records_fts WHERE record_id = ?').run(id);
        db.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)').run(id, ftsTextById.get(id) ?? '');
        manifest.disclosures.push(`records_fts had duplicate rows for '${id}' — folded to the single row v2 requires.`);
      }

      // ---- VERIFY (hard gate, still inside the transaction) ---------------
      const problems = [];
      const recordsAfter = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
      manifest.counts.records_after = recordsAfter;
      if (recordsAfter !== records.length - aliasPlan.length) {
        problems.push(
          `record count does not reconcile: ${records.length} before minus ${aliasPlan.length} collapsed should be ` +
            `${records.length - aliasPlan.length}, found ${recordsAfter}`
        );
      }
      const aliasRows = db.prepare('SELECT historical_id, canonical_id, archived_version FROM record_aliases').all();
      if (aliasRows.length !== aliasPlan.length) {
        problems.push(`record_aliases holds ${aliasRows.length} rows, expected ${aliasPlan.length}`);
      }
      for (const a of aliasRows) {
        const canonicalExists = db.prepare('SELECT 1 AS ok FROM records WHERE id = ?').get(a.canonical_id);
        if (!canonicalExists) problems.push(`alias '${a.historical_id}' resolves to canonical '${a.canonical_id}', which is not a live record`);
        const snapshot = db
          .prepare('SELECT 1 AS ok FROM record_versions WHERE record_id = ? AND version = ?')
          .get(a.canonical_id, a.archived_version);
        if (!snapshot) {
          problems.push(
            `alias '${a.historical_id}' is pinned to version ${a.archived_version} of '${a.canonical_id}', but no such archived version exists`
          );
        }
        if (db.prepare('SELECT 1 AS ok FROM records WHERE id = ?').get(a.historical_id)) {
          problems.push(`historical id '${a.historical_id}' is BOTH an alias and a live record — a dead id must not also be a live namespace`);
        }
      }
      const versionCount = db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n;
      if (versionCount !== aliasPlan.length) problems.push(`record_versions holds ${versionCount} snapshots, expected ${aliasPlan.length}`);

      const relations = db.prepare('SELECT source_id, rel, target_id FROM record_relations').all();
      const foreignIds = new Set(foreignRetirements.values());
      manifest.counts.foreign_successors = foreignRetirements.size;
      for (const r of relations) {
        if (r.source_id === r.target_id) problems.push(`relation '${r.source_id}' -${r.rel}-> itself is a self-edge`);
        if (!db.prepare('SELECT 1 AS ok FROM records WHERE id = ?').get(r.source_id) && !foreignIds.has(r.source_id)) {
          problems.push(`relation source '${r.source_id}' (-${r.rel}-> '${r.target_id}') does not resolve to a record`);
        }
        if (!db.prepare('SELECT 1 AS ok FROM records WHERE id = ?').get(r.target_id)) {
          problems.push(`relation target '${r.target_id}' (from '${r.source_id}' -${r.rel}->) does not resolve to a record`);
        }
      }
      const supersedes = relations.filter((r) => r.rel === 'supersedes');
      const successorsOf = new Map();
      for (const r of supersedes) {
        if (!successorsOf.has(r.target_id)) successorsOf.set(r.target_id, new Set());
        successorsOf.get(r.target_id).add(r.source_id);
      }
      for (const [target, sources] of successorsOf) {
        if (sources.size > 1) problems.push(`record '${target}' has ${sources.size} successors in record_relations (${[...sources].join(', ')}) — one successor maximum`);
      }
      const forward = new Map();
      for (const r of supersedes) forward.set(r.target_id, r.source_id); // old -> new
      for (const start of forward.keys()) {
        const seen = new Set([start]);
        let cursor = start;
        while (forward.has(cursor)) {
          cursor = forward.get(cursor);
          if (seen.has(cursor)) {
            problems.push(`supersedes cycle in record_relations reaching '${cursor}' again`);
            break;
          }
          seen.add(cursor);
        }
      }

      const ftsAfter = db.prepare('SELECT record_id FROM records_fts').all().map((r) => r.record_id);
      manifest.counts.fts_rows_after = ftsAfter.length;
      const ftsSet = new Set(ftsAfter);
      if (ftsAfter.length !== ftsSet.size) problems.push('records_fts holds duplicate rows for at least one record id');
      for (const id of ftsSet) {
        if (!db.prepare('SELECT 1 AS ok FROM records WHERE id = ?').get(id)) {
          problems.push(`records_fts still indexes '${id}', which is no longer a record — archived history must never rank`);
        }
      }
      if (ftsMissing.length) {
        problems.push(
          `${ftsMissing.length} surviving record(s) have no records_fts row (${ftsMissing.slice(0, 5).join(', ')}${
            ftsMissing.length > 5 ? ', …' : ''
          }) — their search text cannot be rebuilt from this script (the per-type FTS text builder lives in packages/schemas), ` +
            `and a silently unrankable record is exactly the failure this gate exists to catch`
        );
      }
      for (const row of db.prepare('SELECT id, lifecycle, freshness, version, body FROM records').all()) {
        if (row.lifecycle !== 'live' && row.lifecycle !== 'retired') problems.push(`record '${row.id}' has lifecycle '${row.lifecycle}'`);
        if (!Number.isInteger(row.version) || row.version < 1) problems.push(`record '${row.id}' has version ${row.version}`);
        const body = JSON.parse(row.body);
        if (body.lifecycle !== row.lifecycle || body.version !== row.version) {
          problems.push(`record '${row.id}' body identity (${body.lifecycle}/v${body.version}) disagrees with its columns (${row.lifecycle}/v${row.version})`);
        }
      }

      if (problems.length) {
        const err = new Error('verification failed');
        err.problems = problems;
        throw err;
      }

      // ---- 5. BUMP LAST ---------------------------------------------------
      db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION}`);
      db.exec('COMMIT');
      committed = true;
    } catch (e) {
      if (!committed) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the original failure below is the one that matters */
        }
      }
      const detail = e.problems ? e.problems.join(' | ') : e.message;
      manifest.failures = e.problems ? e.problems.map((p) => ({ kind: 'verification', detail: p })) : [{ kind: 'error', detail }];
      return refuseVerification(
        manifestPath,
        manifest,
        e.problems
          ? `verification failed after migrating in-transaction: ${e.problems.length} problem(s) — the whole transaction was rolled back`
          : 'verification failed: the migration transaction was rolled back',
        detail,
        backupPath
      );
    }

    manifest.schema_version_after = TARGET_SCHEMA_VERSION;
    manifest.verification = { ok: true, checks: ['counts', 'aliases resolve', 'archived versions exist', 'relations resolve', 'no multi-successor', 'no cycles', 'records_fts matches the live set', 'lifecycle/version columns agree with bodies'] };
    writeManifest(manifestPath, manifest);
    console.log(
      JSON.stringify({
        ok: true,
        already_migrated: false,
        db: dbPath,
        backup_path: backupPath,
        manifest_path: manifestPath,
        schema_version_before: before,
        schema_version_after: TARGET_SCHEMA_VERSION,
      })
    );
  } finally {
    // No forced process.exit on the success path (the S1 sibling's F3b note): a
    // forced exit can truncate a piped stdout write.
    db.close();
  }
}

main();
