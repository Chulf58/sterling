// domain-doctor v2-guard tests (board b96ebf47; supersedes the hollow half of
// article 'domain-doctor' AC3, 8ff011e4) — a SIBLING to domain-doctor.test.mjs,
// not an extension of it. See that file's header for why a sibling exists.
//
// THREE ADJUDICATION ROUNDS SO FAR:
//   Round 1 (21 tests, 6/21 green on first run) ruled exit codes, message-
//     match pairing, hardcoded (not introspected) provenance DDL, the
//     AC9xAC11 no-backup-on-missing-destination rule, and the behavioral WAL
//     proof technique.
//   Round 2 (22/22 green after `adopt` first landed with a write path) added
//     AC13 (version-transition safety) and AC14 (non-Sterling destination
//     fails loud), and tightened the AC9 sidecar check and AC10's count
//     anchors.
//   Round 3 (THIS revision) — a roster reviewer and Codex, independently,
//     found two HIGH defects in `adopt --apply` invisible to the round-2
//     suite: a concurrent-commit-loss race between the subset proof and the
//     backup (no fixture ever presented a LIVE destination), and a
//     non-atomic rmSync-then-VACUUM-INTO replace with no crash-safety window.
//     The user ruled: REMOVE adopt's write half entirely rather than add
//     locking — "gated-unreachable code is worse than absent code." `adopt`
//     is now a READ-ONLY PROOF TOOL: it probes versions, proves whether the
//     destination's ids (AND satellite-table rows) are a subset of the
//     source's, reports counts and a verdict, and exits. No --apply, no
//     backup, no VACUUM INTO, no writes of any kind, ever.
//
// RETIRED THIS ROUND (behavior that no longer exists — NOT a quiet weakening;
// the requirements these encoded live on in git history and on the board for
// if/when a locked, atomic apply path is actually built):
//   - "AC9: adopt --apply backs up the destination, replaces it with a
//      consistent snapshot, record ids/count match, stale sidecars gone"
//   - "AC9: adopt --apply carries record_versions (composite PK intact),
//      record_aliases and record_relations from the source — the whole point
//      of adopt over migrate"
//   - "AC9: adopt --apply on a source with committed-but-uncheckpointed WAL
//      rows still adopts them"
//   - "AC9 x AC11: adopting onto a missing destination writes no pre-adopt
//      backup"
//   - "AC11: adopt creates a missing destination, including parent
//      directories, only on --apply"
//   - "adopt overwrites a same-id divergent body (source canonical) but the
//      pre-adopt backup still holds the old body"
//   - "adopt --apply is idempotent: running it twice yields the same
//      destination record content"
//   All of the above pinned the write path directly; every one is gone
//   because the write path they pinned is gone, per this round's ruling.
//   The two AC13-CONTROL tests were REWRITTEN, not deleted (below): the
//   version-safety RULE survives adopt's redesign — a pre-v2 source is still
//   a legitimate probe target (a real machine store, `deepdots`, is stuck at
//   v0) — only the OUTCOME changed, from "allowed to write" to "reported
//   adoptable, nothing written, ever."
//   AC8/AC12/AC14 were EDITED (not retired): their subject (subset-of-ids
//   proof; missing/self-referential --from; a non-Sterling destination)
//   still applies to the read-only probe — only the `--apply` flag was
//   dropped from their invocations, since passing it now hits AC18's own
//   refusal and would otherwise corrupt what they're pinning.
//   AC10 was EDITED beyond the coordinator's explicit list (flagged in the
//   handoff/report, not silently done): its "names the backup path it would
//   write" assertion directly contradicts this round's ruling that no backup
//   mechanism exists at all anymore. Replaced with the opposite: the plan
//   must NOT mention a backup path, since there is none to mention.
//
// NEW THIS ROUND (all RED today — none of AC15-19 exist in the implementation
// yet, and neither does the write-path removal AC18 pins):
//   AC15 — read-only is ACTUALLY read-only under a HOT WAL, both directions
//     (a live sidecar survives untouched; a cold store gets no new litter).
//     This is the pin whose absence hid the worst defect: no round-1/2
//     fixture ever presented a live destination. ROUNDS 5-6 diagnosed and
//     hardened the hot-WAL half (forced journal_mode, evidence-bearing hard
//     failure instead of a skip, a proveHot() inversion bug fixed, -shm
//     asserted present-only never hashed). ROUND 7, MUTATION-VERIFIED
//     HOLLOW: that fixture kept the writer connection open, which made
//     SQLite's last-connection-out checkpoint (the defect's actual trigger)
//     unreachable — a confirmed sabotage of the real read-only-open stayed
//     green. FIXED STRUCTURALLY: the hot pair is now built in a throwaway
//     dir and moved (main + -wal, deliberately not -shm) into a fresh dir
//     with NO live connection anywhere — the crashed-writer shape both
//     reviewers described, and the only shape in which a writable open can
//     actually mutate the store. The former "fallback pin" shared the same
//     blindness and is deleted rather than kept as false belt-and-braces —
//     see that test's comment block for the full account.
//   AC16 — migrate refuses an alias-namespace collision (a live source id
//     that collides with a destination's historical alias id).
//   AC17 — structural preflight in BOTH modes: a header-says-v2-but-
//     missing-provenance-tables store fails loud, never a raw SQLite error.
//   AC18 — `adopt --apply` is refused outright; the mode itself still exists,
//     only the flag is gone.
//   AC19 — adopt's subset verdict must cover record_aliases/record_versions,
//     not just `records` — those tables are keyed independently.
//
// ROUND 4: the exit-code flag raised in round 3 was RULED — adopt's contract
// is now explicitly THREE-VALUED, matching `sweep` in the original suite:
//   exit 0 — the destination IS a clean subset (records AND satellites):
//            adoption would be safe and complete. Pinned by the new
//            "AC-adopt-clean" CONTROL test below — without a positive case,
//            a three-valued contract could be satisfied by an implementation
//            that never returns 0.
//   exit 3 — a FINDING to report (destination-only record ids [AC8], or
//            destination-only record_aliases/record_versions rows [AC19]).
//            Nothing is wrong with the invocation; the ids must still be
//            NAMED. AC8 and AC19 were changed from strictEqual(2) to
//            strictEqual(3) — a REVISION of an established pin, ruled
//            legitimate because it is a CONTRACT change, not a loosening,
//            and 3 is the STRICTER assertion (2 was previously satisfiable
//            by any hard failure, crash-shaped ones included).
//   exit 2 — cannot safely be attempted / malformed input: AC12 (same file,
//            missing --from), AC13 (version violations), AC14 (no records
//            table), AC17 (structural preflight), AC18 (--apply). Also every
//            migrate refusal: AC5, AC6, AC7, AC16.
//
// RULINGS CARRIED FORWARD, UNCHANGED (do not re-litigate without
// re-adjudication): exit 2 for migrate's AC5/6/7 guard refusals and AC13/16
// (asserted with strictEqual, paired with a message match and, for migrate,
// doesNotMatch(/REFUSED:/) to prove the guard fired before any write);
// hardcoded (never introspected) provenance DDL —
//   record_versions(record_id, version, archived_at, body) PK(record_id,version)
//   record_aliases(historical_id PK, canonical_id, archived_version, created_at)
//   record_relations(source_id, rel, target_id, created_at) PK(source_id,rel,target_id)
// — because introspecting here would itself be the composite-PK trap
// (anti_pattern table-info-pk-composite-not-rowid-alias, 0059fa66) two of
// these tests exist to pin; and oneLine() flattening any raw child-process
// stream before it lands in an assertion's own MESSAGE (anti_pattern
// ee89c3fd), never in an assertion's TARGET.
//
// A NEW ANTI-PATTERN surfaced by knowledge delivery for this round governs
// AC15 directly: 'a-writable-sqlite-open-on-a-wal-database-mutates-the-main-
// fi' (8616e72d) — a READ-ONLY DatabaseSync open on a WAL-mode store can
// still materialize an empty -wal/-shm it cannot unlink, and reaching for a
// writable handle "because it leaves things clean" is exactly the false
// promise AC15 exists to catch. This file's own verification helpers
// (openRO/listIds) are therefore never called between an AC15 "before" and
// "after" sidecar snapshot — only raw fs reads (existsSync/readFileSync) are,
// so this suite cannot be the thing that creates the litter it is checking
// for.
//
// RED vs GREEN TODAY: every migrate-only test (AC5, AC6+control, AC7, AC3')
// is GREEN, as established in prior rounds. AC12 and AC14 are GREEN under the
// CURRENT (still-has-write-path) implementation's read-side behavior, since
// dropping --apply from their invocations exercises code paths that already
// exist and already behave this way pre-removal. AC8 and AC19 are RED today
// (exit 3 is a new contract point the current implementation does not
// return — it currently either exits 2 or would exit 0 after a real
// --apply). AC10's new doesNotMatch(/pre-adopt/i) assertion, AC13-control's
// rewritten exit-0/nothing-written assertions, and the new AC-adopt-clean
// control are all RED today because the current implementation still WOULD
// write / still mentions a backup path when given --apply-shaped input.
// AC15, AC16, AC17, AC18 are all RED today.
//
// VERIFICATION: this agent holds no Bash (by design). Every test carries a
// SABOTAGE comment naming the one-line implementation change that must turn
// it red. The coordinator runs this file directly; this revision applies
// their adjudications but does not itself claim a new run.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, symlinkSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
let DatabaseSync;
let sqliteAvailable = true;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    sqliteAvailable = false;
  }
});

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Flatten a possibly-multi-line child-process stream before interpolating it
 *  into an assertion's own MESSAGE (anti_pattern ee89c3fd). Never applied to
 *  an assertion's TARGET (the string being matched), only to diagnostic text
 *  shown on failure. */
function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function mk(id, answer, extra = {}) {
  return {
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22', capture_date: '2026-06-22',
    ...extra,
  };
}

function mkV2(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SterlingStore(path);
  for (const r of records) s.create(r);
  s.close();
  return path;
}

/** An empty (or user_version-stamped) file with NO Sterling DDL at all — used
 *  for AC14's "not a Sterling store" fixture and for pre-v2/newer-than-2
 *  version-gate fixtures where the guard must fire from the header alone,
 *  before any table is read. Forces header materialization via a PRAGMA
 *  write so a purely-empty open doesn't leave a zero-byte file. */
function mkRawSqlite(path, userVersion) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return path;
}

/** A MINIMAL store with a `records(id, body)` table but NONE of the v2
 *  provenance tables, at a caller-chosen user_version. Two distinct fixture
 *  roles reuse this shape: a genuinely pre-v2 store (userVersion < 2, AC13)
 *  and a HALF-MIGRATED store whose header lies that it is v2 (userVersion =
 *  2, AC17) — both are "records exists, provenance tables do not", just at
 *  different claimed versions. This is fixture-only invention beyond the one
 *  column name this file treats as literal fact (`records.body`, and `id`
 *  alongside it), disclosed here rather than silently assumed. Distinct from
 *  mkRawSqlite (AC14's fixture), which has no `records` table at all. */
function mkPreV2Store(path, userVersion, records = []) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE records (id TEXT, body TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO records (id, body) VALUES (?, ?)');
  for (const r of records) ins.run(r.id, JSON.stringify(r));
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return path;
}

function openRO(path) {
  return new DatabaseSync(path, { readOnly: true });
}
function openRW(path) {
  return new DatabaseSync(path);
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

// --- hardcoded provenance-table writers (packages/store/src/index.ts:57-84) ---
// Deliberately NOT introspected — see header comment on why introspection here
// would be the composite-PK trap this file exists to pin.
function insertVersionSnapshot(db, recordId, version, body, archivedAt = NOW()) {
  db.prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, ?, ?, ?)')
    .run(recordId, version, archivedAt, body);
}
function insertAlias(db, historicalId, canonicalId, archivedVersion, createdAt = NOW()) {
  db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historicalId, canonicalId, archivedVersion, createdAt);
}
function insertRelation(db, sourceId, rel, targetId, createdAt) {
  db.prepare('INSERT INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceId, rel, targetId, createdAt);
}

/** Enumerate record ids from the ONE column the brief confirms literally
 *  ("SELECT body FROM records"), rather than assuming any other column name. */
function listIds(dbPath) {
  const db = openRO(dbPath);
  const rows = db.prepare('SELECT body FROM records').all();
  db.close();
  return rows.map((r) => JSON.parse(r.body).id).sort();
}
function recordCount(dbPath) {
  const db = openRO(dbPath);
  const n = countRows(db, 'records');
  db.close();
  return n;
}

/** Hash every file under a directory (recursively) so "nothing written" can
 *  be asserted including sidecar (-wal/-shm) creation/removal, not just the
 *  main .db file's bytes. */
function snapshotDir(dir) {
  const out = {};
  const walk = (d, prefix) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

/** Hash a single file, or null if it does not exist — used by AC15 for
 *  before/after sidecar comparisons via raw fs reads only (never via
 *  DatabaseSync), so this suite's own verification cannot be the source of
 *  the litter it is checking for. */
function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// AC5 — migrate refuses on a version mismatch. UNCHANGED this round.
// ---------------------------------------------------------------------------

test('AC5: migrate refuses when the source is pre-v2, naming migrate-stores.mjs and which side, and touches neither file', () => {
  const dir = tmp('doctor-ac5a-');
  const from = mkRawSqlite(join(dir, 'from', 'sterling.db'), 0);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'dest answer')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: delete the pre-v2 version check (or make it a no-op) — the
  // exit-code assertion goes red (code stays 0, or becomes whatever the
  // unguarded read/parse path produces on a table-less file).
  assert.strictEqual(r.code, 2, `a guard refusal exits 2, not the create-storm's 3 or a crash: ${out}`);
  assert.match(out, /migrate-stores\.mjs/, 'names the required first step');
  assert.match(out, /pre-v2/, 'names the condition');
  assert.match(out, /source/i, 'names WHICH side is pre-v2');
  assert.doesNotMatch(out, /REFUSED:/, 'the guard fires before any write is attempted, not inside the create-storm catch');
  assert.deepEqual(snapshotDir(dir), before1, 'neither file touched');
});

test('AC5: migrate refuses when the destination is pre-v2, naming migrate-stores.mjs and which side, and touches neither file', () => {
  const dir = tmp('doctor-ac5b-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'src answer')]);
  const to = mkRawSqlite(join(dir, 'to', 'sterling.db'), 1);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: check only the source's user_version, never the destination's.
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /migrate-stores\.mjs/);
  assert.match(out, /pre-v2/);
  assert.match(out, /destination/i, 'names WHICH side is pre-v2');
  assert.doesNotMatch(out, /REFUSED:/);
  assert.deepEqual(snapshotDir(dir), before1);
});

test('AC5: migrate refuses when either side reports a newer-than-2 user_version, untouched', () => {
  const dir = tmp('doctor-ac5c-');
  const v2 = mkV2(join(dir, 'v2', 'sterling.db'), [mk(randomUUID(), 'a')]);
  const newerA = mkRawSqlite(join(dir, 'newerA', 'sterling.db'), 3);
  const newerB = mkRawSqlite(join(dir, 'newerB', 'sterling.db'), 5);
  const before1 = snapshotDir(dir);
  const r1 = doctor(['migrate', '--from', newerA, '--to', v2], dir);
  const out1 = oneLine(r1.stdout + r1.stderr);
  assert.strictEqual(r1.code, 2, `a newer-than-2 source is refused, not downgraded into: ${out1}`);
  assert.match(out1, /newer/i);
  assert.doesNotMatch(out1, /REFUSED:/);
  const r2 = doctor(['migrate', '--from', v2, '--to', newerB], dir);
  const out2 = oneLine(r2.stdout + r2.stderr);
  assert.strictEqual(r2.code, 2, `a newer-than-2 destination is refused: ${out2}`);
  assert.match(out2, /newer/i);
  assert.doesNotMatch(out2, /REFUSED:/);
  assert.deepEqual(snapshotDir(dir), before1, 'no file touched by either refused attempt');
});

test('AC5: migrate refuses when BOTH sides are pre-v2 rather than attempting an implicit double migration', () => {
  const dir = tmp('doctor-ac5d-');
  const from = mkRawSqlite(join(dir, 'from', 'sterling.db'), 0);
  const to = mkRawSqlite(join(dir, 'to', 'sterling.db'), 1);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, `must be the guard's own refusal, not the create-storm's exit 3: ${out}`);
  assert.match(out, /migrate-stores\.mjs/);
  assert.doesNotMatch(out, /REFUSED:/, 'REFUSED: proves a write was attempted — the guard must fire before that');
  assert.deepEqual(snapshotDir(dir), before1);
});

// ---------------------------------------------------------------------------
// AC6 — migrate refuses when the source holds provenance it cannot carry.
// UNCHANGED this round.
// ---------------------------------------------------------------------------

test('AC6-control: a v2 source with no record_versions/alias rows and no retired records migrates normally', () => {
  const dir = tmp('doctor-ac6ctrl-');
  const onlyInSource = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(onlyInSource, 'plain answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, `a clean v2 source must still migrate: ${oneLine(r.stderr)}`);
  assert.ok(listIds(to).includes(onlyInSource), 'the record actually landed in the destination');
});

test('AC6: migrate refuses when the source holds a retired-lifecycle record, naming what it found', () => {
  const dir = tmp('doctor-ac6ret-');
  const from = join(dir, 'from', 'sterling.db');
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  mkdirSync(dirname(from), { recursive: true });
  const originalId = randomUUID();
  const lostId = randomUUID();
  const s = new SterlingStore(from);
  s.create(mk(originalId, 'will be retired'));
  s.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  s.close();
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, `a retired record cannot be reconstructed from SELECT body alone: ${out}`);
  assert.match(out, /retired/i, 'names what it found');
  assert.match(out, /\b1\b/, 'names the count, not just the rule');
  assert.doesNotMatch(out, /REFUSED:/);
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written');
});

test('AC6: migrate refuses when the source holds any record_versions rows', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac6ver-');
  const liveId = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  mkV2(fromPath, [mk(liveId, 'current body', { version: 2 })]);
  const rw = openRW(fromPath);
  insertVersionSnapshot(rw, liveId, 1, JSON.stringify(mk(liveId, 'old body')), '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', fromPath, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, `history that would be silently dropped must block the copy: ${out}`);
  assert.match(out, /record_versions/, 'names the table');
  assert.match(out, /\b1\b/, 'names the row count');
  assert.doesNotMatch(out, /REFUSED:/);
  assert.deepEqual(snapshotDir(dir), before1);
});

test('AC6: migrate refuses when the source holds any record_aliases rows', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac6ali-');
  const liveId = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  mkV2(fromPath, [mk(liveId, 'current body')]);
  const rw = openRW(fromPath);
  insertAlias(rw, randomUUID(), liveId, 1, '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', fromPath, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, `aliases that would stop resolving must block the copy: ${out}`);
  assert.match(out, /record_aliases/, 'names the table');
  assert.match(out, /\b1\b/, 'names the row count');
  assert.doesNotMatch(out, /REFUSED:/);
  assert.deepEqual(snapshotDir(dir), before1);
});

// ---------------------------------------------------------------------------
// AC7 — migrate refuses a same-file --from/--to. UNCHANGED this round.
// ---------------------------------------------------------------------------

test('AC7: migrate refuses --from/--to resolving to the same file, including a symlink and a ./-prefixed path', () => {
  const dir = tmp('doctor-ac7-');
  const real = mkV2(join(dir, 'store', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const link = join(dir, 'store', 'alias.db');
  symlinkSync(real, link);
  const dotPrefixed = join(dir, '.', 'store', 'sterling.db');
  const variants = [
    ['identical path', real, real],
    ['./-prefixed vs plain', real, dotPrefixed],
    ['symlink vs real target', real, link],
  ];
  for (const [label, from, to] of variants) {
    const before1 = snapshotDir(dir);
    const r = doctor(['migrate', '--from', from, '--to', to], dir);
    const out = oneLine(r.stdout + r.stderr);
    assert.strictEqual(r.code, 2, `${label}: a self-migration must be refused: ${out}`);
    assert.match(out, /same file/i, `${label}: names the condition`);
    assert.doesNotMatch(out, /REFUSED:/, label);
    assert.deepEqual(snapshotDir(dir), before1, `${label}: nothing written`);
  }
});

// ---------------------------------------------------------------------------
// AC3' — the NARROWED migrate contract. UNCHANGED this round.
// ---------------------------------------------------------------------------

test("AC3': migrate copies only missing records preserving id/clocks/scope when every guard passes", () => {
  const dir = tmp('doctor-ac3n-');
  const shared = randomUUID();
  const missing = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'shared'), mk(missing, 'stranded')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'shared')]);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, oneLine(r.stderr));
  const check = new SterlingStore(to);
  const restored = check.get(missing);
  const untouched = check.get(shared);
  check.close();
  assert.ok(restored, 'missing record now resolves at the destination');
  assert.equal(restored.answer, 'stranded');
  assert.equal(restored.created_at, '2026-06-22T10:00:00.000Z', 'clock preserved, not stamped fresh');
  assert.equal(restored.scope, 'domain:genesys-cloud', 'scope preserved');
  assert.equal(untouched.answer, 'shared', 'existing destination record left alone');
});

test("AC3': a schema-invalid record is reported and skipped with exit 3 while valid records still migrate", (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac3inv-');
  const validId = randomUUID();
  const invalidId = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  mkV2(fromPath, [mk(validId, 'ok'), mk(invalidId, 'will be corrupted')]);
  const rw = openRW(fromPath);
  const corrupted = { ...mk(invalidId, 'will be corrupted') };
  delete corrupted.question;
  rw.prepare('UPDATE records SET body = ? WHERE body LIKE ?').run(JSON.stringify(corrupted), `%${invalidId}%`);
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const r = doctor(['migrate', '--from', fromPath, '--to', to, '--apply'], dir);
  assert.equal(r.code, 3, 'schema-invalid records are reported, not fatal, but do change the exit code');
  assert.match(r.stdout + r.stderr, new RegExp(invalidId));
  const check = new SterlingStore(to);
  const okRecord = check.get(validId);
  const badRecord = check.get(invalidId);
  check.close();
  assert.ok(okRecord, 'the valid sibling record still migrated');
  assert.equal(badRecord, undefined, 'the invalid record was skipped, never half-written');
});

// ---------------------------------------------------------------------------
// AC8 — adopt reports a FINDING (exit 3, not a refusal) when the
// destination's ids are not a strict subset of the source's. EDITED this
// round twice: --apply dropped (the flag now hits AC18's own refusal), and
// the exit code changed 2 -> 3 per round 4's ruling — a REVISION of an
// established pin, ruled legitimate because it is a three-valued CONTRACT
// change (0 clean / 3 finding / 2 malformed), not a loosening: 3 is the
// STRICTER assertion, since 2 was previously satisfiable by any hard
// failure, crash-shaped ones included.
// ---------------------------------------------------------------------------

test('AC8: adopt reports a finding when the destination holds an id the source lacks, even when overall counts look favorable, naming the destination-only id', () => {
  const dir = tmp('doctor-ac8-');
  const a = randomUUID(); const b = randomUUID(); const c = randomUUID();
  const destOnly = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(a, 'a'), mk(b, 'b'), mk(c, 'c')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(a, 'a'), mk(destOnly, 'orphan')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: replace the subset-of-ids check with a count comparison
  // (`sourceCount >= destCount`) — this exact fixture is built so counts look
  // favorable (3 >= 2) while the id-subset property is false.
  assert.strictEqual(r.code, 3, `a destination-only id is a FINDING (exit 3), not a malformed-input refusal (exit 2): ${out}`);
  assert.match(out, new RegExp(destOnly), 'names the destination-only id verbatim');
  assert.doesNotMatch(out, /usage:/, 'must be the real subset-proof report, not the unregistered-flag usage line');
  assert.deepEqual(snapshotDir(dir), before1, 'a read-only probe changes nothing regardless of its verdict');
});

// CONTROL for the whole three-valued contract: without a positive case, an
// implementation that never returns 0 could still satisfy AC8/AC13-control/
// AC19. Matching (not merely absent) satellite rows on both sides prove the
// clean-subset check does not false-positive on satellite rows that DO have
// a counterpart in the source (anti_pattern
// an-identity-or-containment-proof-over-the-primary-table-alon, 44d4f74f: a
// destination with NO alias/version rows at all would make this control too
// weak to distinguish a sound satellite-aware proof from an unsound
// records-only one).
test('AC-adopt-clean: a genuine subset in BOTH records and satellites is reported exit 0', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac-clean-');
  const X = randomUUID();
  const sharedAliasId = randomUUID();
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(X, 'x body', { version: 2 })]);
  const rwFrom = openRW(fromPath);
  insertAlias(rwFrom, sharedAliasId, X, 1, '2026-06-01T00:00:00.000Z');
  insertVersionSnapshot(rwFrom, X, 1, JSON.stringify(mk(X, 'x body v1')), '2026-06-01T00:00:00.000Z');
  rwFrom.close();
  const toPath = mkV2(join(dir, 'to', 'sterling.db'), [mk(X, 'x body', { version: 2 })]);
  const rwTo = openRW(toPath);
  insertAlias(rwTo, sharedAliasId, X, 1, '2026-06-01T00:00:00.000Z'); // SAME row, present in source too
  insertVersionSnapshot(rwTo, X, 1, JSON.stringify(mk(X, 'x body v1')), '2026-06-01T00:00:00.000Z'); // SAME
  rwTo.close();
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', fromPath, '--to', toPath], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: hardcode a non-zero exit for every path (an implementation that
  // never reports "clean") — this assertion is the ONLY thing in the suite
  // that goes red for that sabotage; without it, AC8/AC19 alone cannot tell
  // "correctly discriminates clean vs not" from "always says not clean".
  assert.strictEqual(r.code, 0, `a genuine subset in records AND satellites must be reported clean: ${out}`);
  assert.deepEqual(snapshotDir(dir), before1, 'a read-only probe changes nothing even on a clean verdict');
});

// ---------------------------------------------------------------------------
// AC10 — adopt's default (now only) behavior is to report and change
// nothing. EDITED this round: the old "names the backup path it would write"
// assertion is REPLACED with its opposite, since no backup mechanism exists
// at all anymore — keeping the old assertion would pin removed behavior.
// ---------------------------------------------------------------------------

test('AC10: adopt prints its plan/verdict and changes nothing (no --apply flag exists to change that anymore)', () => {
  const dir = tmp('doctor-ac10-');
  const shared = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'a'), mk(randomUUID(), 'b')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'a')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  assert.equal(r.code, 0, oneLine(r.stderr));
  assert.match(r.stdout, /DRY-RUN/i);
  // Anchored on proximity to a source/destination-referring word rather than
  // a bare digit anywhere in stdout. Exact label wording is not pinned here
  // (H4 refused this agent a read of scripts/domain-doctor.mjs when asked to
  // confirm it, both this round and last — board 670b2b44).
  assert.match(r.stdout, /source[^\n]{0,60}\b2\b|\b2\b[^\n]{0,60}source/i, 'reports the source count near the word "source"');
  assert.match(r.stdout, /destination[^\n]{0,60}\b1\b|\b1\b[^\n]{0,60}destination/i, 'reports the destination count near the word "destination"');
  // SABOTAGE: leave a leftover "would back up to <path>" line in the plan
  // output from before the write path was removed — this assertion goes red
  // on that mention appearing.
  assert.doesNotMatch(r.stdout, /pre-adopt/i, 'no backup mechanism exists anymore, so the plan must not describe one');
  assert.deepEqual(snapshotDir(dir), before1, 'byte-identical: nothing written');
});

// ---------------------------------------------------------------------------
// AC12 — adopt refuses on a missing/self-referential --from. EDITED this
// round: --apply dropped from both invocations.
// ---------------------------------------------------------------------------

test('AC12: adopt refuses when --from does not exist, nothing written', () => {
  const dir = tmp('doctor-ac12a-');
  const from = join(dir, 'nope', 'sterling.db');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'untouched')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /does not exist|no such file|not found/i, 'names the missing --from condition');
  assert.doesNotMatch(out, /usage:/, 'must be the real missing-source refusal, not an unregistered-flag usage line');
  assert.deepEqual(snapshotDir(dir), before1);
});

test('AC12: adopt refuses when --from and --to resolve to the same file', () => {
  const dir = tmp('doctor-ac12b-');
  const real = mkV2(join(dir, 'store', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const link = join(dir, 'store', 'alias.db');
  symlinkSync(real, link);
  for (const [label, from, to] of [['identical path', real, real], ['symlink vs real target', real, link]]) {
    const before1 = snapshotDir(dir);
    const r = doctor(['adopt', '--from', from, '--to', to], dir);
    const out = oneLine(r.stdout + r.stderr);
    assert.strictEqual(r.code, 2, `${label}: ${out}`);
    assert.match(out, /same file/i, label);
    assert.doesNotMatch(out, /usage:/, label);
    assert.deepEqual(snapshotDir(dir), before1, label);
  }
});

// ---------------------------------------------------------------------------
// AC13 — adopt's version-transition safety rule SURVIVES the write-path
// removal: even a read-only probe must refuse to evaluate an unsafe pairing
// (it could be acted on by hand). The two CONTROL ARMS are REWRITTEN (not
// deleted) to assert the read-only outcome — reported adoptable, nothing
// written — for the same legitimate pairings: a real machine store
// (`deepdots`) is stuck at v0 pending a separate fix.
// ---------------------------------------------------------------------------

test('AC13-control: pre-v2 source vs an equal-version pre-v2 destination (deepdots-shape) — reported adoptable, nothing written', () => {
  const dir = tmp('doctor-ac13ctrl1-');
  const x = randomUUID(); const y = randomUUID();
  const from = mkPreV2Store(join(dir, 'from', 'sterling.db'), 0, [mk(x, 'x'), mk(y, 'y')]);
  const to = mkPreV2Store(join(dir, 'to', 'sterling.db'), 0, [mk(x, 'x')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: refuse whenever the source's user_version is anything other
  // than exactly 2 (treat "not v2" as unconditionally unsafe) — this
  // assertion goes red, proving the eventual guard is not "refuse every
  // version mismatch" wearing an AC13 costume.
  assert.strictEqual(r.code, 0, `equal-version pre-v2 pair must be reported adoptable: ${out}`);
  assert.deepEqual(snapshotDir(dir), before1, 'the probe is read-only — nothing written even on a clean verdict');
});

test('AC13-control: pre-v2 source vs a MISSING destination — reported adoptable, nothing created', () => {
  const dir = tmp('doctor-ac13ctrl2-');
  const x = randomUUID();
  const from = mkPreV2Store(join(dir, 'from', 'sterling.db'), 0, [mk(x, 'x')]);
  const to = join(dir, 'to', 'sterling.db');
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: same as above — refuse any non-v2 source unconditionally.
  assert.strictEqual(r.code, 0, `pre-v2 vs a missing destination must be reported adoptable: ${out}`);
  assert.equal(existsSync(to), false, 'read-only — a missing destination is never created anymore');
});

test('AC13: adopt refuses to evaluate a source newer than the supported version, nothing written', () => {
  const dir = tmp('doctor-ac13a-');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'dest')]);
  const from = mkRawSqlite(join(dir, 'from', 'sterling.db'), 3);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /newer/i);
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written');
});

test('AC13: adopt refuses to evaluate a downgrade — an existing destination at a higher version than the source', () => {
  const dir = tmp('doctor-ac13b-');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'dest')]);
  const from = mkPreV2Store(join(dir, 'from', 'sterling.db'), 0, [mk(randomUUID(), 'src')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /downgrade/i);
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written');
});

// ---------------------------------------------------------------------------
// AC14 — adopt on a destination that EXISTS but is not a Sterling store at
// all (no records table — distinct from AC13's pre-v2-but-real-store and
// AC17's half-migrated shapes). EDITED this round: --apply dropped.
// ---------------------------------------------------------------------------

test('AC14: adopt on a destination with no records table fails loud, not with a raw SQLite error', () => {
  const dir = tmp('doctor-ac14-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const to = mkRawSqlite(join(dir, 'to', 'sterling.db'), 2);
  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
  assert.doesNotMatch(out, /SqliteError|no such table/i, 'must not surface the raw driver exception');
  assert.ok(out.includes(to), 'names the offending file');
});

// ---------------------------------------------------------------------------
// AC15 — READ-ONLY IS ACTUALLY READ-ONLY, under a HOT WAL. The pin whose
// absence hid the worst defect: no earlier fixture ever presented a live
// destination. Both directions matter: a live sidecar must survive
// byte-identical (catches a mutating handle), and a cold store must gain no
// new sidecars at all (catches the litter a naive "open read-only" can still
// leave — anti_pattern a-writable-sqlite-open-on-a-wal-database-mutates-the-
// main-fi, 8616e72d — which is exactly why this file's own verification via
// openRO/listIds is never interleaved between an AC15 before/after snapshot).
// ROUND-4 CAUTION APPLIED: the same trap can bite the FIXTURE, not just the
// assertions — the hot-WAL proof (a byte-copy of the main .db checked for
// the freshest row's absence) is re-run on a fresh, uniquely-named throwaway
// copy IMMEDIATELY BEFORE each doctor() call under test, never only once at
// fixture-build time, and it never re-opens the store under test.
//
// ROUND 5 DIAGNOSIS (this pin previously SKIPPED): journal_mode is FORCED
// via a momentary second connection rather than trusted (database-level, not
// connection-level, so it applies to an already-open writer too), and
// "cannot confirm the precondition" is a HARD FAILURE carrying diagnostic
// evidence, never a skip.
//
// ROUND 6, MEASURED (an independent probe settled both open questions):
//   - THE FIXTURE IS CONSTRUCTIBLE (a maximally hot store's main file can
//     have NO `records` table at all — the whole schema still sitting in
//     the WAL, measured: -wal size=358472, main file schema-less).
//   - proveHot() had a bug, not the fixture: that maximally-hot byte-copy
//     opens read-only successfully, then throws "no such table: records" —
//     the STRONGEST possible proof of hotness. The original proveHot()
//     caught that throw and reported `hot: false`, inverting its own
//     strongest evidence. Fixed: that specific throw now means `hot: true`.
//   - -shm MUST NOT be hashed for equality (measured: a read-only reader
//     registers a read-mark in the WAL index, which lives in -shm — correct
//     SQLite behaviour, not a write). -shm is checked for PRESENCE only.
//
// ROUND 7, MUTATION-VERIFIED HOLLOW, THEN FIXED STRUCTURALLY: with the round
// 6 fixture (writer connection kept OPEN throughout), the coordinator
// sabotaged scripts/domain-doctor.mjs's read-only open to a writable one and
// the suite STAYED GREEN — 30/30, all three AC15 arms passed under the exact
// defect they exist to catch. Cause: the defect fires on SQLite's
// LAST-CONNECTION-OUT checkpoint. With the writer still open, the doctor's
// connection is never last, so a writable open and a read-only open are
// BYTE-INDISCERNIBLE — the fixture's hotness mechanism (keep a connection
// open) was MUTUALLY EXCLUSIVE with the defect's trigger (be the last
// connection to close). No assertion tightening can fix an unreachable
// state; the fixture itself had to change shape.
// FIX — the crashed-writer shape, faithful to both reviewers' threat model:
// build the hot pair in a throwaway dir A with the writer open (exactly as
// before), then copyFileSync the main .db AND its -wal (never -shm — its
// absence, alongside a real non-empty -wal, IS the crashed-writer condition)
// into a FRESH dir B, and close the dir-A writer. Dir B holds a hot WAL with
// NO live connection anywhere. THE ONE PROPERTY THIS PIN NOW HAS THAT IT DID
// NOT BEFORE: the state under test is one in which a writable open WOULD
// ACTUALLY MUTATE the store — the doctor's own connection to dir B is the
// only connection, so a writable open's close is the last-connection-out
// checkpoint that fires the defect. The former fallback pin (also built on a
// permanently-open live connection) shared the exact same blindness and is
// DELETED rather than kept as false belt-and-braces — a fallback whose
// fixture cannot reach the defect reads as coverage while pinning nothing.
// ---------------------------------------------------------------------------

test('AC15: a hot WAL with NO live connection (crashed-writer shape) survives byte-identical across a migrate refusal and an adopt probe', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dirA = tmp('doctor-ac15hot-a-');
  const dirB = tmp('doctor-ac15hot-b-');
  const aPath = join(dirA, 'hot', 'sterling.db');
  mkdirSync(dirname(aPath), { recursive: true });
  const writer = new SterlingStore(aPath); // open only long enough to produce the hot pair

  // Force wal mode via a second, momentary connection rather than trust the
  // default (journal_mode is database-level, not connection-level, so this
  // also applies to the already-open `writer`).
  const modeSetter = new DatabaseSync(aPath);
  const forcedMode = modeSetter.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  modeSetter.close();

  const origId = randomUUID();
  const lostId = randomUUID();
  writer.create(mk(origId, 'will be retired — also guarantees a migrate refusal via AC6'));
  writer.retireInFavorOf(origId, lostId, NOW(), 'promoted');
  const freshId = randomUUID();
  writer.create(mk(freshId, 'freshly committed, for the hot-WAL proof'));

  // Move the hot pair to dir B with NO live connection: this is the
  // crashed-writer shape, and the only shape in which a writable open
  // actually mutates anything (see the section comment above for the
  // mutation-verified reasoning). Copy the main .db and its -wal; do NOT
  // copy -shm — its absence alongside a real, non-empty -wal is exactly the
  // crashed-writer condition.
  const bPath = join(dirB, 'hot', 'sterling.db');
  mkdirSync(dirname(bPath), { recursive: true });
  copyFileSync(aPath, bPath);
  copyFileSync(`${aPath}-wal`, `${bPath}-wal`);
  writer.close(); // dir A is now irrelevant — it only ever existed to produce the hot pair

  // proveHot(): re-run on a fresh, uniquely-named THROWAWAY byte-copy of
  // dir B's main file each call (never re-opening `bPath` itself), rather
  // than trusted from fixture-build time. A "no such table: records" throw
  // is treated as proof of hotness, not a failure to establish it (round 6).
  const proveHot = () => {
    const scratch = join(dirB, `proof-copy-${randomUUID()}.db`);
    try {
      copyFileSync(bPath, scratch);
      return { hot: !listIds(scratch).includes(freshId), error: null };
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/no such table:\s*records/i.test(msg)) {
        return { hot: true, error: null };
      }
      return { hot: false, error: msg };
    }
  };

  const walExistedBefore = existsSync(`${bPath}-wal`);
  const walSizeBefore = walExistedBefore ? statSync(`${bPath}-wal`).size : 0;
  const first = proveHot();
  // Fixture precondition, not a pin on scripts/domain-doctor.mjs — no
  // implementation sabotage can turn this one red or green. A genuine
  // inability to construct the crashed-writer state must be visible with
  // evidence, never a skip (round 5's ruling, unchanged by this restructure).
  assert.ok(first.hot,
    `could not establish a hot (uncheckpointed) WAL with no live connection: forced journal_mode='${forcedMode}', ` +
    `pre-existing -wal existed=${walExistedBefore} size=${walSizeBefore} bytes, ` +
    `proveHot() error=${first.error ?? 'none (row was simply already present in the main file)'}.`);
  assert.ok(existsSync(`${bPath}-wal`) && statSync(`${bPath}-wal`).size > 0, 'fixture precondition: a real, non-empty -wal exists on the crashed copy');
  assert.equal(existsSync(`${bPath}-shm`), false, 'fixture precondition: -shm was deliberately not copied — no live connection exists anywhere on dir B');

  const cleanDest = mkV2(join(dirB, 'clean', 'sterling.db'), []);
  const other = mkV2(join(dirB, 'other', 'sterling.db'), [mk(randomUUID(), 'y')]);

  // main and -wal are where data integrity lives and are hashed for exact
  // equality. -shm is checked for presence only where relevant, never
  // hashed (round 6: a read-only reader may legitimately create/touch it to
  // build a WAL index, which is not a write to the database).
  const snap = () => ({ main: hashFile(bPath), wal: hashFile(`${bPath}-wal`) });

  const beforeMigrateProof = proveHot();
  assert.ok(beforeMigrateProof.hot, `WAL liveness lost before the migrate call could even run: ${beforeMigrateProof.error ?? 'checkpointed already'}`);
  const before1 = snap();
  doctor(['migrate', '--from', bPath, '--to', cleanDest], dirB); // AC6 retired-record refusal
  const after1 = snap();
  // SABOTAGE: swap the read-only open for a writable one anywhere on this
  // path (e.g. `new DatabaseSync(path)` instead of `{ readOnly: true }`) —
  // this MUST go red here specifically because, with no other connection
  // left on `bPath`, the doctor's own connection is the LAST one out, so a
  // writable connection's close checkpoints the WAL into the main file and
  // changes both hashes. Mutation-verified: this exact sabotage stayed green
  // under the PREVIOUS (still-open-writer) fixture, because that state made
  // last-connection-out unreachable regardless of how the doctor opened it.
  assert.deepEqual(after1, before1, 'a migrate refusal must leave the main .db and -wal byte-identical');
  assert.ok(existsSync(`${bPath}-wal`), '-wal still present after a migrate refusal');

  const beforeAdoptProof = proveHot();
  assert.ok(beforeAdoptProof.hot, `WAL liveness lost before the adopt call could even run: ${beforeAdoptProof.error ?? 'checkpointed already'}`);
  const before2 = snap();
  doctor(['adopt', '--from', bPath, '--to', other], dirB);
  const after2 = snap();
  // SABOTAGE: same as above, on the adopt probe path — with no live
  // connection on `bPath`, a writable open there checkpoints on close just
  // as measurably as the migrate case.
  assert.deepEqual(after2, before2, 'an adopt probe must leave the main .db and -wal byte-identical');
  assert.ok(existsSync(`${bPath}-wal`), '-wal still present after an adopt probe');
});

test('AC15 (converse): a cold store (no sidecars beforehand) gets none created by migrate or adopt', () => {
  const dir = tmp('doctor-ac15cold-');
  const cold = mkV2(join(dir, 'cold', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const other = mkV2(join(dir, 'other', 'sterling.db'), [mk(randomUUID(), 'y')]);
  assert.equal(existsSync(`${cold}-wal`), false, 'fixture precondition: no -wal before any call');
  assert.equal(existsSync(`${cold}-shm`), false, 'fixture precondition: no -shm before any call');

  doctor(['migrate', '--from', cold, '--to', cold], dir); // AC7 same-file refusal
  // SABOTAGE: probe the version via a read-only DatabaseSync open without the
  // hadWal/hadShm-conditional cleanup the anti-pattern's "right way" pattern
  // prescribes — a read-only open on a WAL-mode db can materialize an empty
  // -wal/-shm it then cannot unlink; these assertions go red on their
  // appearance.
  assert.equal(existsSync(`${cold}-wal`), false, 'migrate must not create a -wal beside a cold store');
  assert.equal(existsSync(`${cold}-shm`), false, 'migrate must not create a -shm beside a cold store');

  doctor(['adopt', '--from', cold, '--to', other], dir);
  assert.equal(existsSync(`${cold}-wal`), false, 'adopt probe must not create a -wal beside a cold source');
  assert.equal(existsSync(`${cold}-shm`), false, 'adopt probe must not create a -shm beside a cold source');
  assert.equal(existsSync(`${other}-wal`), false, 'adopt probe must not create a -wal beside the other store either');
  assert.equal(existsSync(`${other}-shm`), false, 'adopt probe must not create a -shm beside the other store either');
});

// ---------------------------------------------------------------------------
// AC16 — migrate refuses an alias-namespace collision: a live source record
// id equals a destination's historical alias id. Every existing guard passes
// (source is clean, H absent from destination `records`) so today migrate
// would silently insert it, creating two incompatible meanings for H.
// ---------------------------------------------------------------------------

test('AC16: migrate refuses an alias-namespace collision — a live source record id equals a destination historical alias id', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac16-');
  const C = randomUUID();
  const H = randomUUID();
  const toPath = join(dir, 'to', 'sterling.db');
  mkV2(toPath, [mk(C, 'canonical body')]);
  const rw = openRW(toPath);
  insertAlias(rw, H, C, 1, '2026-06-01T00:00:00.000Z');
  rw.close();
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(H, 'a live record that happens to share the alias id')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', fromPath, '--to', toPath], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: check only `records` for id collisions (today's `have.has(r.id)`
  // filter) and never cross-reference record_aliases — this assertion goes
  // red because H is absent from destination `records`, so H would be
  // silently inserted.
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /record_aliases/);
  assert.match(out, new RegExp(H));
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written');
});

// ---------------------------------------------------------------------------
// AC17 — structural preflight, BOTH modes: a store whose header claims v2 but
// lacks the v2 provenance tables (half-migrated) must fail loud, never a raw
// SQLite driver exception.
// ---------------------------------------------------------------------------

test('AC17: migrate fails loud (not a raw SQLite error) when the source claims v2 but lacks provenance tables', () => {
  const dir = tmp('doctor-ac17mig-src-');
  const liveId = randomUUID();
  const from = mkPreV2Store(join(dir, 'from', 'sterling.db'), 2, [mk(liveId, 'x')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: trust the header's user_version=2 and query record_versions
  // straight away without checking the table exists first — this assertion
  // goes red because the raw driver's "no such table" text (or an
  // uncaught-exception shape) would appear instead of a clean, prefixed
  // refusal.
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /domain-doctor:/);
  assert.match(out, /source/i, 'names which side is structurally incomplete');
  assert.match(out, /record_versions|record_aliases|record_relations/, 'names the missing table');
  assert.doesNotMatch(out, /SqliteError|no such table/i, 'must not surface the raw driver exception');
});

test('AC17: migrate fails loud when the DESTINATION claims v2 but lacks provenance tables', () => {
  const dir = tmp('doctor-ac17mig-dst-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const to = mkPreV2Store(join(dir, 'to', 'sterling.db'), 2, []);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /domain-doctor:/);
  assert.match(out, /destination/i, 'names which side is structurally incomplete');
  assert.match(out, /record_versions|record_aliases|record_relations/, 'names the missing table');
  assert.doesNotMatch(out, /SqliteError|no such table/i);
});

test('AC17: adopt fails loud (not a raw SQLite error) when either side claims v2 but lacks provenance tables', () => {
  const dir = tmp('doctor-ac17adopt-');
  const liveId = randomUUID();
  const halfSrc = mkPreV2Store(join(dir, 'half-src', 'sterling.db'), 2, [mk(liveId, 'x')]);
  const normalDst = mkV2(join(dir, 'normal-dst', 'sterling.db'), []);
  const r1 = doctor(['adopt', '--from', halfSrc, '--to', normalDst], dir);
  const out1 = oneLine(r1.stdout + r1.stderr);
  // SABOTAGE: AC19's satellite-table subset check queries record_aliases /
  // record_versions straight away without a structural preflight — this
  // assertion goes red on the raw driver error text appearing.
  assert.strictEqual(r1.code, 2, out1);
  assert.match(out1, /domain-doctor:/);
  assert.doesNotMatch(out1, /SqliteError|no such table/i);

  const normalSrc = mkV2(join(dir, 'normal-src', 'sterling.db'), [mk(randomUUID(), 'y')]);
  const halfDst = mkPreV2Store(join(dir, 'half-dst', 'sterling.db'), 2, []);
  const r2 = doctor(['adopt', '--from', normalSrc, '--to', halfDst], dir);
  const out2 = oneLine(r2.stdout + r2.stderr);
  assert.strictEqual(r2.code, 2, out2);
  assert.match(out2, /domain-doctor:/);
  assert.doesNotMatch(out2, /SqliteError|no such table/i);
});

// ---------------------------------------------------------------------------
// AC18 — adopt --apply is GONE. The mode itself still exists; only the flag
// is refused.
// ---------------------------------------------------------------------------

test('AC18: adopt --apply is refused — the apply path no longer exists', () => {
  const dir = tmp('doctor-ac18-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const to = join(dir, 'nested', 'missing', 'sterling.db');
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: leave --apply silently accepted-and-ignored (parsed but a
  // no-op) instead of refused — this assertion goes red on a code-0 exit
  // with no mention of the removal.
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /not implemented|no longer (supported|implemented)|removed/i, 'says the apply path is gone');
  assert.match(out, /board/i, 'points at the board where the write path is tracked');
  // SABOTAGE: let --apply fall through to generic "unknown flag" handling,
  // which would look identical to the whole MODE vanishing — that must NOT
  // be what happened; only --apply is refused, not `adopt` itself.
  assert.doesNotMatch(out, /usage:/, 'the mode itself must still exist — only --apply is refused');
  assert.deepEqual(snapshotDir(dir), before1, 'no file created or modified anywhere');
  assert.equal(existsSync(to), false, 'the missing destination was NOT created');
});

// ---------------------------------------------------------------------------
// AC19 — adopt's subset verdict must cover the satellite tables, not just
// `records`. record_aliases/record_versions are keyed independently, so a
// clean records-level subset does not prove the destination holds nothing
// the source lacks. EDITED this round: exit code 2 -> 3, same three-valued
// contract change as AC8 (this is a FINDING, not a malformed-input refusal).
// ---------------------------------------------------------------------------

test('AC19: adopt reports a destination-only alias/version row even when records-level ids are a clean subset', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac19-');
  const X = randomUUID();
  const oldAliasId = randomUUID();
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(X, 'x body', { version: 1 })]);
  const toPath = mkV2(join(dir, 'to', 'sterling.db'), [mk(X, 'x body', { version: 1 })]);
  const rw = openRW(toPath);
  insertAlias(rw, oldAliasId, X, 1, '2026-06-01T00:00:00.000Z'); // destination-only
  insertVersionSnapshot(rw, X, 0, JSON.stringify(mk(X, 'pre-x body')), '2026-05-01T00:00:00.000Z'); // destination-only
  rw.close();
  const before1 = snapshotDir(dir);
  const r = doctor(['adopt', '--from', fromPath, '--to', toPath], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: prove subset using ONLY `records` ids (today's shape, extended
  // naively to adopt) — this assertion goes red because X is present on both
  // sides at the records level, so a records-only check reports a clean
  // subset (exit 0) and never looks at record_aliases/record_versions at all.
  assert.strictEqual(r.code, 3, `a destination-only satellite row is a FINDING (exit 3), not exit 2: ${out}`);
  assert.match(out, new RegExp(oldAliasId), 'names the destination-only alias historical_id');
  assert.match(out, /record_aliases/);
  assert.deepEqual(snapshotDir(dir), before1, 'a read-only probe changes nothing regardless of its verdict');
});

// ---------------------------------------------------------------------------
// SLICE 1 (record_relations containment guard) — provisional AC20, not yet
// reflected in the feature article's current_ac (article version 19 stops at
// AC19; this pin is authored ahead of implementation, symmetrical with AC6's
// record_versions/record_aliases refusals). MEASURED GAP (conductor
// dispatch, verified at HEAD 302a2bb): the structural survey backing AC17
// reads only record_versions and record_aliases — record_relations is
// neither guarded nor copied, so any number of its rows reach the copy loop
// today: the rebuild stamps record.updated_at instead of the original
// created_at and skips self-links, and an addLink() relation never reaches
// the record body at all, so relations are silently lost or restamped. Fix:
// refuse (exit 2, nothing written) when the source holds any record_relations
// row, naming the table and the row count. BOTH TESTS BELOW ARE RED TODAY
// (the guard does not exist yet). Control placed FIRST per decisions
// cf863d84 / 23afbc83.
// ---------------------------------------------------------------------------

test('AC20-control: a v2 source with zero record_relations rows still migrates normally', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac20ctrl-');
  const onlyInSource = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(onlyInSource, 'plain answer, no relations')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  // SABOTAGE: make the new record_relations guard refuse whenever the
  // record_relations TABLE exists (rather than gating on its row COUNT) —
  // this control goes red because every mkV2 store carries the empty v2
  // provenance tables, so an existence-only check would refuse this clean
  // fixture too, proving the guard is count-gated and not "table present ->
  // refuse".
  assert.equal(r.code, 0, `a clean v2 source with no relations must still migrate: ${oneLine(r.stderr)}`);
  assert.ok(listIds(to).includes(onlyInSource), 'the record actually landed in the destination');
});

test('AC20: migrate refuses when the source holds any record_relations rows, naming the table and the count, before any write', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac20-');
  const a = randomUUID();
  const b = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  mkV2(fromPath, [mk(a, 'record a'), mk(b, 'record b')]);
  const rw = openRW(fromPath);
  insertRelation(rw, a, 'relies_on', b, '2026-06-01T00:00:00.000Z');
  insertRelation(rw, b, 'relies_on', a, '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', fromPath, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: delete the record_relations refusal branch (or fold it into a
  // no-op) — the exit-code assertion goes red first (code stays 0, or the
  // create-storm's 3), and the table/count assertions go red regardless
  // since the message never mentions record_relations at all.
  assert.strictEqual(r.code, 2, `relations that would be silently lost or restamped must block the copy: ${out}`);
  assert.match(out, /record_relations/, 'names the table');
  assert.match(out, /\b2\b/, 'names the row count');
  assert.doesNotMatch(out, /REFUSED:/, 'the guard fires before any write is attempted, not inside the create-storm catch');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing copied — the refusal happens before any write to the destination');
});

// ---------------------------------------------------------------------------
// SLICE 2 (same-id body-equality on the migrate skip path) — provisional
// AC21, not yet reflected in the feature article's current_ac. MEASURED GAP
// (conductor dispatch): today an id present in BOTH stores is filtered out of
// the copy plan by id membership alone — nothing ever compares the two
// bodies — so a same-id/different-body pair (exactly what a split store
// produces) is silently dropped rather than flagged. Fix: identical bodies
// stay an idempotent skip; differing bodies become a HARD CONFLICT (exit 2,
// naming the id), detected in BOTH the dry-run/plan path and under --apply —
// the diff that decides the plan is the same diff --apply acts on, so the
// conflict cannot be apply-gated without the plan lying about what it will
// do. CONTROL FIRST per decisions cf863d84 / 23afbc83. AC21-control and the
// identical-body skip test are GREEN TODAY already (today's id-only filter
// produces this outcome by coincidence, not by comparing bodies — see the
// sibling suite's "migrate copies records verbatim..." test, which exercises
// this exact identical-body-shared-id shape). The two conflict tests below
// are RED today: a differing body is currently silently dropped exactly like
// an identical one, exit 0, no mention of the conflicting id anywhere.
// ---------------------------------------------------------------------------

test('AC21-control: an unrelated, non-colliding pair of records on each side still migrates and is left alone normally', () => {
  const dir = tmp('doctor-ac21ctrl-');
  const onlyInSource = randomUUID();
  const onlyInDest = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(onlyInSource, 'brand new record')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(onlyInDest, 'totally unrelated pre-existing record')]);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: broaden the new body-comparison to fire on ANY cross-id pair
  // whose bodies differ (e.g., compare every destination record against
  // every source record instead of only same-id pairs) — this control goes
  // red because onlyInSource and onlyInDest differ in every field and would
  // be spuriously reported as a conflict, refusing the whole run.
  assert.equal(r.code, 0, `no id collides here at all — must not be affected by the new same-id conflict check: ${out}`);
  const check = new SterlingStore(to);
  const landed = check.get(onlyInSource);
  const untouched = check.get(onlyInDest);
  check.close();
  assert.ok(landed, 'the new record landed');
  assert.equal(landed.answer, 'brand new record');
  assert.ok(untouched, 'the unrelated pre-existing destination record is untouched');
  assert.equal(untouched.answer, 'totally unrelated pre-existing record');
});

test('AC21: same id, IDENTICAL body (incl. a matching extra field and scope) on both sides — idempotent skip, exit 0, reported as skipped rather than copied, stable under a repeated --apply', () => {
  const dir = tmp('doctor-ac21skip-');
  const shared = randomUUID();
  const onlyInSource = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [
    mk(shared, 'identical shared answer', { version: 3 }),
    mk(onlyInSource, 'the actually-missing record'),
  ]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'identical shared answer', { version: 3 })]);

  const dry = doctor(['migrate', '--from', from, '--to', to], dir);
  const dryOut = oneLine(dry.stdout + dry.stderr);
  // SABOTAGE: flip the new equality comparison to always treat same-id
  // bodies as differing (e.g., compare object identity/reference instead of
  // deep value equality) — this pair is byte-identical, so this assertion
  // goes red: the plan would report a conflict (exit 2) instead of a skip.
  assert.equal(dry.code, 0, `identical bodies at a shared id must not be a conflict: ${dryOut}`);
  assert.match(dryOut, /skipped 1/i, 'reported as skipped, not planned for copy');
  assert.match(dryOut, new RegExp(onlyInSource), 'the genuinely missing record is still named in the plan');

  const applied1 = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(applied1.code, 0, oneLine(applied1.stderr));
  const applied2 = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(applied2.code, 0, `a second --apply over an already-synced pair stays idempotent: ${oneLine(applied2.stderr)}`);

  const check = new SterlingStore(to);
  const landed = check.get(onlyInSource);
  const stillShared = check.get(shared);
  check.close();
  assert.ok(landed, 'the genuinely missing record still copied');
  assert.equal(stillShared.answer, 'identical shared answer', 'the identical shared record was never rewritten');
});

test('AC21: same id, DIFFERING body under --apply — HARD CONFLICT, exit 2, message names the conflicting id, nothing written', () => {
  const dir = tmp('doctor-ac21conflict-apply-');
  const shared = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'the source-side answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'a DIFFERENT destination-side answer')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: remove the body-difference check entirely, falling back to the
  // current id-only skip filter — this assertion goes red because the
  // differing destination body would be silently kept (exit 0) with no
  // mention of `shared` anywhere in the output, instead of a named conflict.
  assert.strictEqual(r.code, 2, `a same-id body mismatch cannot be silently dropped: ${out}`);
  assert.match(out, new RegExp(shared), 'names the conflicting id verbatim');
  assert.match(out, /conflict|differ|mismatch/i, 'names the nature of the refusal');
  assert.doesNotMatch(out, /REFUSED:/, 'a guard-level refusal, not a per-record write failure inside the create-storm');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written — including no partial write of any non-conflicting fields');
});

test('AC21: same id, DIFFERING body is detected in the dry-run/plan path too, not only under --apply', () => {
  const dir = tmp('doctor-ac21conflict-dry-');
  const shared = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'the source-side answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'a DIFFERENT destination-side answer')]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir); // no --apply
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: gate the new conflict check behind the --apply flag (only run
  // the body-equality comparison when args.apply is true) — this assertion
  // goes red because the dry-run path would fall back to reporting a normal
  // exit-0 plan (or a silent skip) instead of refusing, letting the plan lie
  // about what --apply would actually do.
  assert.strictEqual(r.code, 2, `the plan-time diff and the apply-time diff must be the same diff: ${out}`);
  assert.match(out, new RegExp(shared), 'names the conflicting id verbatim');
  assert.deepEqual(snapshotDir(dir), before1, 'dry-run never writes regardless — confirms this is the same detection, not a new write path');
});

// ---------------------------------------------------------------------------
// STRENGTHENING ROUND (this revision) — two independent reviews found AC20
// and AC21's existing pins insufficiently discriminating. Three gaps, in the
// dispatch's own numbering. Every new pin below carries its own SABOTAGE
// comment (decision 23afbc83) and, where its verdict could have more than
// one cause, an explicit note on which earlier test in this file already
// serves as its CONTROL arm (never re-litigated, only cited — the control
// stays where it already is, physically earlier in the file, which is what
// "placed first" means for a pin added by amendment rather than from
// scratch).
// ---------------------------------------------------------------------------

// GAP 1 — AC20 SURVIVES AN OFF-BY-ONE. The only positive AC20 fixture above
// carries exactly TWO relation rows, so `relationCount > 1` (or a hardcoded
// expected count of 2) passes it identically to the correct `!== 0` gate.
// CONTROL: 'AC20-control' above (zero rows -> exit 0) already rules out the
// OTHER wrong shape ("table exists -> refuse unconditionally") — it is
// unaffected by either `> 1` or `!== 0`, since both agree at zero. This new
// test is the boundary the control cannot reach: exactly one row discriminates
// `> 1` (wrongly allows) from `!== 0` (correctly refuses).
test('AC20: migrate refuses when the source holds EXACTLY ONE record_relations row (off-by-one boundary), naming the table and the count', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac20one-');
  const a = randomUUID();
  const b = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  mkV2(fromPath, [mk(a, 'record a'), mk(b, 'record b')]);
  const rw = openRW(fromPath);
  insertRelation(rw, a, 'relies_on', b, '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', fromPath, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: write the guard as `relationCount > 1` (an off-by-one against
  // the correct `!== 0`), or hardcode an expected count of 2 lifted from the
  // only other fixture that exercises this guard — this fixture has exactly
  // ONE relation row, so either wrong shape lets the source through
  // untouched: exit stays 0 (or 3, from the create-storm) and the relation
  // is silently lost, while the correct `!== 0` gate must still refuse.
  assert.strictEqual(r.code, 2, `a single record_relations row must still block the copy, not only two or more: ${out}`);
  assert.match(out, /record_relations/, 'names the table');
  assert.match(out, /\b1\b/, 'names the row count (1), not a hardcoded 2');
  assert.doesNotMatch(out, /REFUSED:/, 'the guard fires before any write is attempted, not inside the create-storm catch');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing copied — the refusal happens before any write to the destination');
});

// GAP 2 — AC21 SURVIVES A SHALLOW COMPARATOR. Both existing differing-body
// AC21 fixtures vary only the scalar `answer`, so `a.answer === b.answer`
// passes every existing AC21 test (research_finding.source_urls is confirmed
// optional-with-default([]) by board 37862e86 / packages/schemas/src/tests/
// research-finding-source-urls-optional.test.ts). The four pins below all
// hold `answer` IDENTICAL on both sides, so a shallow `answer`-only
// comparator cannot tell any of them apart from a genuine duplicate — only a
// real deep/structural comparison can.
//
// FIXTURE REPAIR (2026-08-26) — WHY NONE OF THESE FOUR CARRY links[] ANY MORE.
// Three of them were originally built on links[{rel, target_id}] entries.
// `create()` mints a record_relations row for EVERY body link, so a SOURCE
// fixture carrying body links now trips the AC20 relations-containment guard
// and migrate refuses at exit 2 BEFORE the body comparator is ever reached
// (decision [migrate-relations-containment-narrows-migrate-to-unlinked-
// stores], 88f3db69: migrate refuses ANY source holding ANY record_relations
// row; that ruling is shipped and twice-reviewed). The consequences were:
// the control could never reach its exit-0 skip, and the two conflict pins
// exited 2 for the WRONG REASON — a relations refusal, not a body conflict —
// so their "names the conflicting id" assertion could not pass and the pins
// proved nothing about deep equality. NEITHER the ruling NOR the production
// guard ORDER is the thing to change (exempting body-derived relations would
// narrow a settled decision; reordering the guards is an unrequested
// behavioural change) — the FIXTURES were wrong, so the FIXTURES were rebuilt
// on RELATION-FREE nested fields of the same record type:
//   * file_keys[]   — an array of repo-relative POSIX paths, which
//                     research_finding defines (CLAUDE.md, "which field
//                     carries paths is PER TYPE": research_finding →
//                     file_keys[]). Carries the nested INNER-VALUE difference.
//   * source_urls[] — an array of plain strings, ORDER-BEARING and stored as
//                     authored: MEASURED on live research_finding 8add62e0,
//                     whose three source_urls sit in non-alphabetical author
//                     order, so the store neither sorts nor canonicalizes
//                     them. It also passes through none of the path
//                     normalization file_keys goes through, which is exactly
//                     why the ARRAY-ORDER pin uses source_urls and not
//                     file_keys: a path normalizer that ever sorted or
//                     deduped would silently dissolve an order pin built on
//                     paths, turning a real difference into no difference.
// Neither field mints a relation row, so all four fixtures leave their SOURCE
// store with ZERO record_relations rows and reach the body comparator.
//
// FIXTURE DISTINCTNESS FROM THE AC20 ONE-ROW PIN ABOVE (the reason these two
// subjects cannot now be confused): that pin's source is the ONLY fixture in
// this file whose source holds a record_relations row, and it acquires it
// EXPLICITLY via insertRelation() over a link-free body — never as a side
// effect of a body link. "Holds exactly one relation row" (AC20's boundary)
// and "holds a nested structure" (AC21's subject) are therefore carried by
// disjoint fixture shapes: sabotaging the relations guard moves ONLY the AC20
// pin, sabotaging the body comparator moves ONLY these four, and no single
// mutation can move both and leave the cause ambiguous.
//
// The first of the four is the CONTROL, placed FIRST: it proves a same-id
// pair with a NESTED, non-empty structure (not just a scalar) is STILL
// correctly reported as an idempotent skip when truly identical — ruling out
// "any same-id pair with a non-trivial body always conflicts" as the cause
// behind the three conflict pins that follow it.

test("AC21-control: same id, IDENTICAL body INCLUDING NESTED ARRAY structure (file_keys[] + source_urls[], both multi-element) — idempotent skip, proven on more than scalars", () => {
  const dir = tmp('doctor-ac21nested-ctrl-');
  const shared = randomUUID();
  // Written out LONGHAND on both sides — never a shared array reference — so
  // the two nested structures are genuinely separate object instances with
  // equal content, which is the precondition the reference-identity sabotage
  // below needs in order to be able to fire at all.
  const from = mkV2(join(dir, 'from', 'sterling.db'), [
    mk(shared, 'same top-level answer', {
      file_keys: ['packages/store/src/index.ts', 'scripts/domain-doctor.mjs'],
      source_urls: ['https://example.com/alpha', 'https://example.com/beta'],
    }),
  ]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [
    mk(shared, 'same top-level answer', {
      file_keys: ['packages/store/src/index.ts', 'scripts/domain-doctor.mjs'],
      source_urls: ['https://example.com/alpha', 'https://example.com/beta'],
    }),
  ]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // WHY THIS FIXTURE REACHES THE BEHAVIOUR IT NAMES: neither file_keys nor
  // source_urls mints a record_relations row, so this source holds ZERO
  // relation rows and the AC20 containment guard cannot fire — the exit-0
  // verdict asserted below can only come from the body comparator (the
  // previous links[]-based fixture could never get past the guard, see the
  // GAP 2 header).
  // SABOTAGE: compare same-id bodies by reference/identity (or via a
  // comparator that treats any non-empty array field as automatically
  // differing) instead of deep value equality — this assertion goes red
  // because the file_keys/source_urls arrays here are separate instances with
  // identical content, and a reference-based or arrays-always-differ
  // comparator would wrongly report a conflict (exit 2) instead of a skip.
  assert.strictEqual(r.code, 0, `identical bodies, including multi-element nested arrays, must not be a conflict: ${out}`);
  assert.doesNotMatch(out, /conflict|mismatch/i, 'no conflict reported when the nested structure is genuinely identical');
  assert.deepEqual(snapshotDir(dir), before1, 'a dry-run plan never writes');
});

test("AC21: same id, bodies differ ONLY in ONE INNER ELEMENT of a nested array (file_keys[1]) — HARD CONFLICT, exit 2, id named", () => {
  const dir = tmp('doctor-ac21nested-diff-');
  const shared = randomUUID();
  // Same length, same element [0], one differing element [1] — so the arrays
  // are distinguishable ONLY by looking inside them. `answer` is identical.
  const from = mkV2(join(dir, 'from', 'sterling.db'), [
    mk(shared, 'same top-level answer', {
      file_keys: ['packages/store/src/index.ts', 'scripts/domain-doctor.mjs'],
    }),
  ]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [
    mk(shared, 'same top-level answer', {
      file_keys: ['packages/store/src/index.ts', 'scripts/migrate-stores.mjs'],
    }),
  ]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // WHY THIS FIXTURE REACHES THE BEHAVIOUR IT NAMES: file_keys mints no
  // record_relations row, so the source holds ZERO relation rows and the exit
  // 2 asserted below is the BODY COMPARATOR's conflict, not AC20's relations
  // refusal — which is why "names the conflicting id" can pass at all. Under
  // the previous links[]-based fixture this test exited 2 from the relations
  // guard and the id assertion could never be reached.
  // SABOTAGE: implement the same-id equality check by comparing only
  // top-level scalar fields (e.g. `a.answer === b.answer`) — this assertion
  // goes red because `answer` is identical on both sides here and only the
  // nested file_keys[1] element differs, so a shallow comparator reports a
  // clean skip (exit 0) instead of a conflict.
  assert.strictEqual(r.code, 2, `bodies differing only in one inner element of a nested array must still conflict: ${out}`);
  assert.match(out, new RegExp(shared), 'names the conflicting id verbatim');
  assert.match(out, /conflict|differ|mismatch/i, 'names the nature of the refusal');
  assert.doesNotMatch(out, /REFUSED:/, 'a guard-level refusal, not a per-record write failure inside the create-storm');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written on a hard conflict');
});

test('AC21: same id, bodies differ ONLY by an OPTIONAL key present on one side and absent on the other (source_urls) — HARD CONFLICT, exit 2, id named', () => {
  const dir = tmp('doctor-ac21optional-diff-');
  const shared = randomUUID();
  const fromRec = mk(shared, 'same top-level answer', { source_urls: ['https://example.com/found-here'] });
  const toRec = mk(shared, 'same top-level answer');
  delete toRec.source_urls; // physically absent — optional-with-default([]) per board 37862e86, not merely a different value
  const from = mkV2(join(dir, 'from', 'sterling.db'), [fromRec]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [toRec]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: same shallow-comparator sabotage as the nested-value pin —
  // `answer` matches on both sides, and a comparator limited to a fixed list
  // of named scalar fields never looks at source_urls at all, reporting a
  // clean skip instead of a conflict.
  assert.strictEqual(r.code, 2, `a present-vs-absent optional key is a real difference and must conflict: ${out}`);
  assert.match(out, new RegExp(shared), 'names the conflicting id verbatim');
  assert.match(out, /conflict|differ|mismatch/i, 'names the nature of the refusal');
  assert.doesNotMatch(out, /REFUSED:/, 'a guard-level refusal, not a per-record write failure inside the create-storm');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written on a hard conflict');
});

test('AC21: same id, bodies differ ONLY in ARRAY ORDER of an order-bearing field (source_urls[]) — HARD CONFLICT, exit 2, id named, never a silent skip', () => {
  const dir = tmp('doctor-ac21order-diff-');
  const shared = randomUUID();
  // The SAME two members on both sides, in opposite order — the only
  // difference in either body. source_urls is the order-bearing array chosen
  // here (over file_keys) because it is stored exactly as authored, MEASURED
  // on live research_finding 8add62e0 whose source_urls sit in
  // non-alphabetical author order: the store neither sorts nor canonicalizes
  // it, and unlike file_keys it passes through no path normalization that
  // could reorder or rewrite an element and dissolve the very difference this
  // pin exists to detect. Deliberately NOT alphabetically ordered in either
  // direction on its own, so no incidental sorting can be mistaken for a match.
  const urlsForward = ['https://example.com/second-source', 'https://example.com/first-source'];
  const urlsReversed = ['https://example.com/first-source', 'https://example.com/second-source'];
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'same top-level answer', { source_urls: urlsForward })]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'same top-level answer', { source_urls: urlsReversed })]);
  const before1 = snapshotDir(dir);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // WHY THIS FIXTURE REACHES THE BEHAVIOUR IT NAMES: source_urls mints no
  // record_relations row, so the source holds ZERO relation rows and the exit
  // 2 below is the body comparator's ORDER-SENSITIVE verdict, not AC20's
  // relations refusal. The previous links[]-based fixture refused at the
  // relations guard before any array was ever compared.
  // SABOTAGE: compare the two source_urls[] arrays as SETS (sort-then-compare,
  // or compare via a Set of the entries) instead of as an ORDER-SENSITIVE
  // sequence — this assertion goes red under a set-based comparator: it sees
  // the same two members present on both sides and reports a clean skip
  // (exit 0) instead of a conflict.
  // DIAGNOSING A FUTURE RED: the fixture's premise is that the store stores
  // source_urls AS AUTHORED. This pin deliberately does not read the stored
  // bodies back to assert that (an openRO between the before/after
  // snapshotDir pair would risk creating exactly the sidecar litter the
  // "nothing written" assertion checks for — see the file header). So if this
  // ever reds while the output reports a clean skip, check FIRST whether the
  // store began sorting/canonicalizing source_urls: that would dissolve the
  // fixture's only difference and make the red a FIXTURE defect, not an
  // implementation defect. Measured 2026-08-26 as NOT sorted (record
  // 8add62e0 holds its source_urls in non-alphabetical author order).
  assert.strictEqual(r.code, 2, `a reordered order-bearing array is a real difference and must conflict, never skip: ${out}`);
  assert.match(out, new RegExp(shared), 'names the conflicting id verbatim');
  assert.match(out, /conflict|differ|mismatch/i, 'names the nature of the refusal');
  assert.doesNotMatch(out, /REFUSED:/, 'a guard-level refusal, not a per-record write failure inside the create-storm');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing written on a hard conflict');
});

// GAP 3 — COLUMN-RESIDENT STATE IS INVISIBLE TO A BODY-ONLY COMPARISON. Per
// the v2 cutover (decision stable-identity-design-v2, and this file's own
// AC17/README notes), `status` and `superseded_by` are stripped from the
// stored body and derived from SQL COLUMNS at read time. Two same-id records
// can therefore be byte-identical at the body level while their lifecycle
// state differs — invisible to any comparator that reads only `records.body`.
// FIXTURE REPAIR (2026-08-26) — THIS PIN WAS HOLLOW, AND THE HOLLOWNESS WAS
// MUTATION-PROVEN. It used to build the destination's divergence with
// s.retireInFavorOf(). That call does NOT confine itself to the columns: it
// also rewrites `lifecycle` and `updated_at` INSIDE THE BODY. So the two
// bodies were NOT byte-identical, the ordinary body comparator saw a
// difference and refused, and the pin went green WITHOUT the column-state
// check ever running — passing for a DIFFERENT reason than the one it names
// ("byte-identical bodies"), which is the exact hollow class decision
// 23afbc83 and the mutation-rigor rule exist to catch: sabotaging the
// column-state check left it green.
// REBUILT with a RAW UPDATE that touches ONLY the `status` and
// `superseded_by` COLUMNS and no byte of any body. Raw SQL is used here
// deliberately and narrowly — no store API exists that changes column state
// without also stamping the body, and a body stamp is precisely what this pin
// must not have. The two columns are the ones article 'domain-doctor'
// (8ff011e4) names as column-resident post-v2 ("tombstoneInfo... reads
// status/superseded_by from the SQL COLUMNS (v2 strips them from the body)").
// The mutation is applied ONLY to the DESTINATION, so AC6's SOURCE-side
// retired-record refusal — a genuinely different, already-pinned guard —
// never fires and cannot be confused with this one; and the source carries no
// body links, so AC20's relations guard cannot fire either. THE PREMISE IS NOW
// ASSERTED, NOT ASSUMED: the two bodies are read back and compared BYTE FOR
// BYTE in the test itself, and the two column states are read back and proven
// to differ, so if a future store change ever stamps the body again this pin
// fails LOUDLY on its own premise instead of quietly going hollow a second time.
// CONTROL: 'AC21: same id, IDENTICAL body...idempotent skip' above already
// establishes that an ordinary identical same-id pair (both active, no column
// drift) with this same fixture shape (mkV2 + migrate) IS reported as a clean
// skip — so a universally-broken implementation that crashes or refuses on
// every input would already be caught red by that earlier, simpler test, and
// cannot be the explanation if only THIS test goes red.
// This pin asserts only the MUST-NOT the gap specifies plus the exit code that
// MUST-NOT strictly implies — it does not assert the wording of the refusal
// (which id/state names appear, in what form), because no article or decision
// settles that message shape and inventing one here would make the pin red for
// a reason it does not name.
test('AC21: same id, byte-identical BODIES but differing column-resident lifecycle state (destination superseded, source active) must not be reported as a clean identical skip', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-ac21column-');
  const shared = randomUUID();
  const successor = randomUUID();
  const fromPath = join(dir, 'from', 'sterling.db');
  const toPath = join(dir, 'to', 'sterling.db');
  mkV2(fromPath, [mk(shared, 'same top-level answer')]);
  mkV2(toPath, [mk(shared, 'same top-level answer')]);

  // COLUMN-ONLY divergence. The destination holds exactly one record (asserted,
  // so the WHERE-less UPDATE below is unambiguous and this fixture assumes no
  // column name beyond the two it is deliberately writing).
  assert.strictEqual(recordCount(toPath), 1, 'fixture premise: the destination holds exactly one record');
  const rw = openRW(toPath);
  rw.prepare('UPDATE records SET status = ?, superseded_by = ?').run('superseded', successor);
  rw.close();

  // FIXTURE PREMISE, ASSERTED RATHER THAN ASSUMED — this is the half whose
  // absence made the previous version of this pin hollow.
  const readOne = (p) => {
    const db = openRO(p);
    const row = db.prepare('SELECT body, status, superseded_by FROM records').get();
    db.close();
    return row;
  };
  const src = readOne(fromPath);
  const dst = readOne(toPath);
  assert.strictEqual(src.body, dst.body, 'PREMISE: the two stored bodies must be BYTE-IDENTICAL — if this fails the pin is testing an ordinary body conflict, not column-resident state');
  assert.strictEqual(dst.status, 'superseded', 'PREMISE: the column-only UPDATE landed on the destination');
  assert.strictEqual(dst.superseded_by, successor, 'PREMISE: the column-only UPDATE landed on the destination');
  assert.notDeepStrictEqual(
    { status: src.status, superseded_by: src.superseded_by },
    { status: dst.status, superseded_by: dst.superseded_by },
    'PREMISE: the two records differ in COLUMN state and in nothing else'
  );

  const r = doctor(['migrate', '--from', fromPath, '--to', toPath], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: drop the column-state check — i.e. compare same-id pairs by
  // reading `records.body` alone (exactly the shape this gap describes).
  // Both assertions below go red, because the two bodies really are
  // byte-identical text (asserted above; status/superseded_by live in COLUMNS
  // post-v2 and were never in the body), so a body-only comparator reports
  // "skipped 1" at exit 0 as if nothing were different, even though the
  // destination's copy is superseded and the source's is not.
  assert.ok(
    !(r.code === 0 && /skipped/i.test(out)),
    `a same-id pair with differing column-resident lifecycle state must not be silently reported as a clean identical skip: code=${r.code} out=${out}`
  );
  // The MUST-NOT above is satisfiable by an implementation that exits 0 while
  // wording its report differently ("identical 1", say); a hard conflict is
  // ruled to exit non-zero, so pin that directly — message-shape independent.
  assert.notStrictEqual(r.code, 0, `differing column-resident state is a real difference: it cannot be a success-shaped no-op, whatever the wording: ${out}`);
});
