// domain-doctor `show` mode — SPEC-ONLY, adversarial test author. Board d055b150.
//
// `show` DOES NOT EXIST YET (as of this writing, only `migrate` and `adopt`
// are wired). EVERY test in this file is expected RED today, including every
// CONTROL arm — there is no implementation for any of them to accidentally
// satisfy. This agent holds no Bash and cannot run this suite; the
// coordinator runs it directly. Every test below carries a SABOTAGE comment
// naming the one-line implementation change that must turn it red once
// `show` exists, per decision a-ruling-change-is-verified-by-mutation-not-by-
// a-green-suite.
//
// EXPECTED RED, PRECISELY, ALL OF THEM:
//   AC-S1 (crux + control), AC-S2, AC-S3, AC-S4, AC-S5 (control + multi),
//   AC-S6a/b/c, AC-S7a-f, the unparseable-JSON-body adversarial arm, AC-S8
//   (hot + cold). Nothing in this file can be green until `show` is wired.
//
// HOUSE STYLE / FIXTURE HELPERS: copied and adapted from the sibling
// domain-doctor-v2-guard.test.mjs (read first, per instructions) — this file
// does not import from that one (nothing there is exported for reuse), so
// the fixture-building helpers below are deliberately duplicated, not a new
// shared module (minimal-change: a shared helper module is a bigger change
// than this task asked for). The hardcoded provenance-table DDL
// (record_versions/record_aliases/record_relations) is intentionally NOT
// introspected, for the same composite-PK-trap reason the sibling file gives
// (anti_pattern table-info-pk-composite-not-rowid-alias, 0059fa66).
//
// DISCLOSED AMBIGUITIES / CHOICES MADE (flagging rather than silently
// resolving, per instructions — these are NOT given literally by the brief):
//
//   1. AC-S5's "three supersedes-shaped legacy links... mirroring however
//      mkPreV2Store's shape allows": the pre-v2 `records` table has no
//      relations table and no uniqueness constraint on `id`. I modeled the
//      three-claimant conflict as THREE RAW ROWS sharing one id in the
//      legacy `records` table, each with a different `superseded_by` value
//      in its body — i.e. three never-reconciled historical writes for the
//      same id, which is also the most literal reading of "a multi-successor
//      conflict the runner will not resolve mechanically, because picking a
//      winner would invent a version order nobody wrote" (there IS no order
//      across duplicate rows). An alternative reading (three OTHER records
//      each independently claiming a forward `supersedes: X` field) is also
//      plausible but has no field to carry it in the `mk()` shape this suite
//      otherwise uses, so I did not choose it.
//   2. AC-S8's "assert -shm PRESENCE only, never its content": I read this as
//      "never hash/compare -shm bytes for equality." Concretely: the HOT
//      (crashed-writer) arm makes no assertion about -shm at all (a
//      legitimate read-only reader may or may not touch it to build a WAL
//      index); the COLD converse arm asserts -shm's ABSENCE (a presence
//      check, never a content check) mirroring the sibling AC15 converse.
//   3. The exit code for AC-S5's multi-successor case is not stated in the
//      brief beyond the general 0/3/2 contract in AC-S7. I inferred exit 0
//      (record found and printed) since a multi-successor conflict is a
//      finding ABOUT the data to report, not a "record absent" (3) or
//      "malformed/unsafe input" (2) condition — analogous to how AC8/AC19 in
//      the sibling file distinguish "reports a finding" from "cannot proceed
//      at all." If the real contract wants a distinct third code for this
//      case, that is a planning gap, not something I should invent silently.
//   4. sqliteAvailable gating: the sibling file gates only tests using
//      openRW/insertAlias/insertVersionSnapshot with `t.skip`, but does NOT
//      gate its mkRawSqlite-based tests, even though mkRawSqlite also
//      constructs a raw `DatabaseSync` directly. That looks like an
//      inconsistency, not a deliberate rule, so I gate EVERY test in this
//      file that touches a raw DatabaseSync (via mkRawSqlite, mkPreV2Store,
//      openRW, or the insert* helpers) consistently, rather than reproducing
//      the inconsistency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readFileSync, copyFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
let DatabaseSync;
let sqliteAvailable = true;

// Mirrors the sibling's before() hook, but this file has no `test`-level
// `before` import dependency ordering concerns since every test constructs
// its own fixtures fresh — still resolved once, lazily, on first use, via
// this async loader awaited at the top of every test body (node:test does
// not guarantee `before` runs before dynamically-added tests defined via a
// helper, so each test awaits this directly rather than relying on a shared
// top-level before()).
async function ready() {
  if (!SterlingStore) {
    ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  }
  if (sqliteAvailable && !DatabaseSync) {
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      sqliteAvailable = false;
    }
  }
}

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Flatten a possibly-multi-line child-process stream before interpolating it
 *  into an assertion's own MESSAGE (anti_pattern ee89c3fd) — never applied to
 *  an assertion's TARGET. */
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

/** A store with NO Sterling DDL at all beyond a PRAGMA-forced header — used
 *  for "not a Sterling store" / "missing --db target" fixtures. */
function mkRawSqlite(path, userVersion) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return path;
}

/** A MINIMAL legacy store: `records(id, body)` only, no v2 provenance
 *  tables, at a caller-chosen user_version. No uniqueness constraint on
 *  `id` — deliberately, so AC-S5 can insert multiple never-reconciled rows
 *  sharing one id (see header disclosure #1). */
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

function openRW(path) {
  return new DatabaseSync(path);
}

// --- hardcoded provenance-table writers (packages/store/src/index.ts:57-84),
// deliberately NOT introspected (see header comment). ---
function insertVersionSnapshot(db, recordId, version, body, archivedAt = NOW()) {
  db.prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, ?, ?, ?)')
    .run(recordId, version, archivedAt, body);
}
function insertAlias(db, historicalId, canonicalId, archivedVersion, createdAt = NOW()) {
  db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historicalId, canonicalId, archivedVersion, createdAt);
}
function insertRelation(db, sourceId, rel, targetId, createdAt = NOW()) {
  db.prepare('INSERT INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceId, rel, targetId, createdAt);
}

function listIds(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT body FROM records').all();
  db.close();
  return rows.map((r) => JSON.parse(r.body).id).sort();
}

function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Force an 8-hex-char prefix onto an otherwise-random, still schema-valid
 *  UUID by overwriting only its first hyphen-group (chars 0-7). Version and
 *  variant nibbles (inside later groups) are untouched, so this stays a
 *  well-formed UUID for any zod .uuid() format check. */
function withPrefix(prefix, uuid) {
  return prefix + uuid.slice(prefix.length);
}

// ===========================================================================
// AC-S1 — the crux: a retired v2 record's successor comes from
// record_relations, NEVER from the body (status/superseded_by are dropped
// from the persisted v2 body — packages/store/src/index.ts:598-604). The
// CONTROL arm is placed FIRST, per the mutation-verification guidance: a
// verdict with more than one possible cause needs its opposite-reason control
// to run (and be readable) before the positive case, so a green on the crux
// test always carries independent evidence that the mechanism is real.
// ===========================================================================

test('AC-S1-control: a v2 record with NO inbound supersedes relation shows cleanly and never leaks an unrelated successor', async () => {
  await ready();
  const dir = tmp('doctor-acs1ctrl-');
  const cruxId = randomUUID();
  const controlId = randomUUID();
  const successorId = randomUUID(); // never created as its own record — only referenced by relation
  const cruxMarker = `BODY-MARKER-CRUX-${randomUUID().slice(0, 8)}`;
  const controlMarker = `BODY-MARKER-CONTROL-${randomUUID().slice(0, 8)}`;
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(cruxId, cruxMarker), mk(controlId, controlMarker)]);
  const rw = openRW(dbPath);
  insertRelation(rw, successorId, 'supersedes', cruxId, NOW()); // relates ONLY to cruxId, never controlId
  rw.close();

  const r = doctor(['show', '--db', dbPath, '--id', controlId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: print an unconditional "successor: <first relations row source_id>"
  // line regardless of whether it targets the record actually being shown —
  // this assertion goes red because successorId is only related to a
  // DIFFERENT record (cruxId), never to controlId.
  assert.strictEqual(r.code, 0, `an unrelated, non-retired record must show cleanly: ${out}`);
  assert.ok(out.includes(controlMarker), 'the control record\'s own stored body is printed');
  assert.doesNotMatch(out, new RegExp(successorId), 'no successor is named for a record with no inbound supersedes relation');
});

test("AC-S1: show on a retired v2 record names its successor from record_relations, not the (successor-less) persisted body", async () => {
  await ready();
  const dir = tmp('doctor-acs1-');
  const cruxId = randomUUID();
  const successorId = randomUUID();
  const cruxMarker = `BODY-MARKER-CRUX-${randomUUID().slice(0, 8)}`;
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(cruxId, cruxMarker)]);
  const rw = openRW(dbPath);
  insertRelation(rw, successorId, 'supersedes', cruxId, NOW());
  rw.close();

  const r = doctor(['show', '--db', dbPath, '--id', cruxId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: print only the stored body (e.g. `JSON.stringify(record)`) and
  // never query record_relations at all — this assertion goes red because
  // the v2 body has no status/superseded_by field to fall back on (they are
  // dropped at write time), so successorId cannot appear by accident.
  assert.strictEqual(r.code, 0, `a found record — retired or not — is exit 0: ${out}`);
  assert.ok(out.includes(cruxMarker), "the record's own stored body is printed");
  assert.match(out, new RegExp(successorId), 'the successor id (record_relations.source_id) is named');
});

// ===========================================================================
// AC-S2 — record_aliases rows whose canonical_id is the shown record are
// reported (historical ids still resolving to it). Built with a SECOND,
// unrelated alias (canonical_id = a different record) in the SAME store to
// guard against an implementation that dumps every alias row in the store
// unconditionally rather than filtering by canonical_id.
// ===========================================================================

test('AC-S2: show reports record_aliases historical ids resolving to this record, never ones resolving to a different record', async () => {
  await ready();
  const dir = tmp('doctor-acs2-');
  const shownId = randomUUID();
  const otherId = randomUUID();
  const historicalForShown = randomUUID();
  const historicalForOther = randomUUID();
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(shownId, 'shown body'), mk(otherId, 'other body')]);
  const rw = openRW(dbPath);
  insertAlias(rw, historicalForShown, shownId, 1, NOW());
  insertAlias(rw, historicalForOther, otherId, 1, NOW()); // unrelated to shownId
  rw.close();

  const r = doctor(['show', '--db', dbPath, '--id', shownId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: `SELECT historical_id FROM record_aliases` with no `WHERE
  // canonical_id = ?` filter — this assertion goes red because
  // historicalForOther, which resolves to a DIFFERENT record, would then
  // also appear.
  assert.strictEqual(r.code, 0, out);
  assert.match(out, new RegExp(historicalForShown), 'names the historical id that resolves to this record');
  assert.doesNotMatch(out, new RegExp(historicalForOther), 'does not name a historical id resolving to a different record');
});

// ===========================================================================
// AC-S3 — record_versions snapshot COUNT is reported, not the bodies. Two
// records with DIFFERENT counts (3, then 2) rule out a hardcoded literal
// count; assertions anchor on the literal table name "record_versions"
// (house vocabulary used the same way in the sibling file's AC6/AC19) rather
// than the word "version" alone, since "version" collides with unrelated
// mentions (e.g. a schema/user_version reference) that a bare digit-proximity
// regex could false-positive on.
// ===========================================================================

test('AC-S3: show reports the record_versions snapshot COUNT (not snapshot bodies), and it varies per record rather than being a fixed literal', async () => {
  await ready();
  const dir = tmp('doctor-acs3-');
  const threeId = randomUUID();
  const twoId = randomUUID();
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(threeId, 'three-body'), mk(twoId, 'two-body')]);
  const rw = openRW(dbPath);
  insertVersionSnapshot(rw, threeId, 1, JSON.stringify(mk(threeId, 'v1')), '2026-01-01T00:00:00.000Z');
  insertVersionSnapshot(rw, threeId, 2, JSON.stringify(mk(threeId, 'v2')), '2026-02-01T00:00:00.000Z');
  insertVersionSnapshot(rw, threeId, 3, JSON.stringify(mk(threeId, 'v3')), '2026-03-01T00:00:00.000Z');
  insertVersionSnapshot(rw, twoId, 1, JSON.stringify(mk(twoId, 'w1')), '2026-01-01T00:00:00.000Z');
  insertVersionSnapshot(rw, twoId, 2, JSON.stringify(mk(twoId, 'w2')), '2026-02-01T00:00:00.000Z');
  rw.close();

  const rThree = doctor(['show', '--db', dbPath, '--id', threeId], dir);
  const outThree = oneLine(rThree.stdout + rThree.stderr);
  assert.strictEqual(rThree.code, 0, outThree);
  // SABOTAGE: hardcode the printed count to "2" (or any fixed literal) — this
  // assertion (checked FIRST, with the non-matching count, so a hardcoded "2"
  // fails here before the twoId test could accidentally agree with it) goes
  // red because this record has 3 snapshots, not 2.
  assert.match(outThree, /record_versions[^\n]{0,80}\b3\b|\b3\b[^\n]{0,80}record_versions/i, `reports 3 record_versions snapshots: ${outThree}`);

  const rTwo = doctor(['show', '--db', dbPath, '--id', twoId], dir);
  const outTwo = oneLine(rTwo.stdout + rTwo.stderr);
  assert.strictEqual(rTwo.code, 0, outTwo);
  assert.match(outTwo, /record_versions[^\n]{0,80}\b2\b|\b2\b[^\n]{0,80}record_versions/i, `reports 2 record_versions snapshots: ${outTwo}`);
  // Do NOT require snapshot bodies be printed (explicit in the brief) — so no
  // assertion here checks for 'v1'/'v2'/'v3'/'w1'/'w2' text one way or the
  // other; a real implementation is free to print them or not.
});

// ===========================================================================
// AC-S4 — the whole point: a PRE-v2 store (deepdots' actual shape, header
// user_version 0) works, reporting supersession from the LEGACY body column,
// without erroring on absent v2 tables and without reusing migrate's
// fail-closed v2-required refusal (the adversarial bullet is folded in here
// via the doesNotMatch(/migrate-stores\.mjs/) assertion, since it is the same
// invocation under test, not a separate scenario).
// ===========================================================================

test('AC-S4: show on a PRE-v2 store reports legacy body content and legacy superseded_by, never erroring on absent v2 tables or reusing migrate\'s v2-required refusal', async () => {
  await ready();
  const dir = tmp('doctor-acs4-');
  const legacyId = randomUUID();
  const legacySuccessor = randomUUID();
  const legacyMarker = `BODY-MARKER-LEGACY-${randomUUID().slice(0, 8)}`;
  const dbPath = mkPreV2Store(join(dir, 'sterling.db'), 0, [
    mk(legacyId, legacyMarker, { status: 'retired', superseded_by: legacySuccessor }),
  ]);

  const r = doctor(['show', '--db', dbPath, '--id', legacyId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: require the v2 provenance tables to exist before doing
  // anything (reusing migrate's structural preflight / v2-version guard
  // unconditionally) — this assertion goes red because a genuinely pre-v2
  // store (this fixture) would then be refused outright, which is exactly
  // the regression this AC exists to prevent (a real machine store,
  // deepdots, is stuck at v0 and MUST remain readable by `show`).
  assert.strictEqual(r.code, 0, `a pre-v2 store must be readable by show, not refused: ${out}`);
  assert.ok(out.includes(legacyMarker), "the legacy record's stored body is printed");
  assert.match(out, new RegExp(legacySuccessor), 'the legacy superseded_by value is reported');
  // SABOTAGE: fall through to (or copy) migrate's "pre-v2, run
  // migrate-stores.mjs first" refusal message for `show` too — this
  // assertion goes red on that text appearing, since reading a stuck store
  // without requiring migration first is the entire reason `show` exists.
  assert.doesNotMatch(out, /migrate-stores\.mjs/, 'show must not require (or defer to) the v2 migration guard');
  assert.doesNotMatch(out, /SqliteError|no such table/i, 'must not surface a raw driver exception for absent v2 tables');
});

// ===========================================================================
// AC-S5 — multi-successor is REPORTED, NOT COLLAPSED (the actual deepdots
// shape). Fixture: three raw rows sharing one legacy id, each claiming a
// different superseded_by (see header disclosure #1). The single-claimant
// CONTROL lives in the SAME store and is placed/asserted FIRST, so a green
// multi-successor result cannot be explained by "this implementation just
// prints every superseded_by value found anywhere in the store" — the
// control record's own single claimant would then leak the OTHER record's
// three claimants too, and vice versa.
// ===========================================================================

test('AC-S5-control: a legacy record with exactly ONE claimant reports exactly that one, never a claimant belonging to a different record in the same store', async () => {
  await ready();
  const dir = tmp('doctor-acs5ctrl-');
  const multiId = randomUUID();
  const singleId = randomUUID();
  const c1 = randomUUID(); const c2 = randomUUID(); const c3 = randomUUID();
  const soleClaimant = randomUUID();
  const dbPath = mkPreV2Store(join(dir, 'sterling.db'), 0, [
    mk(multiId, 'multi v1', { status: 'retired', superseded_by: c1 }),
    mk(multiId, 'multi v2', { status: 'retired', superseded_by: c2 }),
    mk(multiId, 'multi v3', { status: 'retired', superseded_by: c3 }),
    mk(singleId, 'single body', { status: 'retired', superseded_by: soleClaimant }),
  ]);

  const r = doctor(['show', '--db', dbPath, '--id', singleId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: report every superseded_by value found ANYWHERE in the
  // `records` table rather than only those rows matching the requested id —
  // this assertion goes red because c1/c2/c3 belong to a DIFFERENT record
  // (multiId) in the same store file.
  assert.strictEqual(r.code, 0, out);
  assert.match(out, new RegExp(soleClaimant), 'names the single claimant');
  assert.doesNotMatch(out, new RegExp(c1), 'does not leak a claimant belonging to a different record');
  assert.doesNotMatch(out, new RegExp(c2), 'does not leak a claimant belonging to a different record');
  assert.doesNotMatch(out, new RegExp(c3), 'does not leak a claimant belonging to a different record');
});

test('AC-S5: show on a legacy record claimed as superseded by THREE different records names ALL THREE, never silently picking one', async () => {
  await ready();
  const dir = tmp('doctor-acs5-');
  const multiId = randomUUID();
  const singleId = randomUUID();
  const c1 = randomUUID(); const c2 = randomUUID(); const c3 = randomUUID();
  const soleClaimant = randomUUID();
  const dbPath = mkPreV2Store(join(dir, 'sterling.db'), 0, [
    mk(multiId, 'multi v1', { status: 'retired', superseded_by: c1 }),
    mk(multiId, 'multi v2', { status: 'retired', superseded_by: c2 }),
    mk(multiId, 'multi v3', { status: 'retired', superseded_by: c3 }),
    mk(singleId, 'single body', { status: 'retired', superseded_by: soleClaimant }),
  ]);

  const r = doctor(['show', '--db', dbPath, '--id', multiId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: `SELECT ... FROM records WHERE id = ? LIMIT 1` (or any
  // single-row read) instead of reading every row matching the id — this
  // assertion goes red because only ONE of c1/c2/c3 would ever be printed
  // (or none, if the LIMIT-1 row happens to be a different shape).
  assert.strictEqual(r.code, 0, `a multi-successor conflict is a finding to report, not a refusal: ${out}`);
  assert.match(out, new RegExp(c1), 'names claimant 1');
  assert.match(out, new RegExp(c2), 'names claimant 2');
  assert.match(out, new RegExp(c3), 'names claimant 3');
  assert.doesNotMatch(out, new RegExp(soleClaimant), 'does not leak the unrelated single-claimant record\'s successor');
});

// ===========================================================================
// AC-S6 — id resolution ladder: exact full id; unambiguous 8-char prefix;
// ambiguous prefix refused naming every candidate.
// ===========================================================================

function buildPrefixFixture(dirPrefix) {
  const dir = tmp(dirPrefix);
  const sharedPrefix = 'aaaaaaaa';
  const id1 = withPrefix(sharedPrefix, randomUUID());
  let id2 = withPrefix(sharedPrefix, randomUUID());
  while (id2 === id1) id2 = withPrefix(sharedPrefix, randomUUID()); // practically unreachable, kept for correctness
  const id3 = randomUUID(); // vanishingly unlikely to also start with 'aaaaaaaa'
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(id1, 'id1 body'), mk(id2, 'id2 body'), mk(id3, 'id3 body')]);
  return { dir, dbPath, sharedPrefix, id1, id2, id3 };
}

test('AC-S6a: an unambiguous 8-char prefix resolves to the one matching record', async () => {
  await ready();
  const { dir, dbPath, id3 } = buildPrefixFixture('doctor-acs6a-');
  const prefix = id3.slice(0, 8);
  const r = doctor(['show', '--db', dbPath, '--id', prefix], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: require an EXACT id match only (no prefix resolution at all) —
  // this assertion goes red because `prefix` is 8 characters, never the full
  // 36-character id.
  assert.strictEqual(r.code, 0, `an unambiguous 8-char prefix must resolve: ${out}`);
  assert.match(out, new RegExp(id3), 'the resolved full id (or its body) is reported');
});

test('AC-S6b: an ambiguous 8-char prefix is refused (exit 2), naming every candidate id it matched', async () => {
  await ready();
  const { dir, dbPath, sharedPrefix, id1, id2 } = buildPrefixFixture('doctor-acs6b-');
  const r = doctor(['show', '--db', dbPath, '--id', sharedPrefix], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: resolve an ambiguous prefix by picking the first/last matching
  // row (e.g. `LIMIT 1`) instead of refusing — this assertion goes red
  // because such an implementation would return exit 0 for exactly one of
  // id1/id2, never exit 2 naming both.
  assert.strictEqual(r.code, 2, `an ambiguous prefix must be refused, not silently resolved: ${out}`);
  assert.match(out, new RegExp(id1), 'names candidate 1');
  assert.match(out, new RegExp(id2), 'names candidate 2');
});

test('AC-S6c: an exact full id resolves even when it shares its 8-char prefix with another record (exact match is not itself ambiguous)', async () => {
  await ready();
  const { dir, dbPath, id1 } = buildPrefixFixture('doctor-acs6c-');
  const r = doctor(['show', '--db', dbPath, '--id', id1], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: treat every --id argument as a PREFIX search (never checking
  // for an exact match first) — this assertion goes red because id1 shares
  // its first 8 characters with id2, so a prefix-only search would report
  // exit 2 (ambiguous) even though the full, exact id was given.
  assert.strictEqual(r.code, 0, `an exact full id must resolve directly, not be treated as an ambiguous prefix: ${out}`);
  assert.match(out, new RegExp(id1));
});

// ===========================================================================
// AC-S7 — exit codes: 0 found, 3 not-found (a finding, names id + db path),
// 2 malformed/unsafe. The "found" (0) cases are established throughout AC-S1
// through AC-S6 above — those already-established positive-control tests are
// why the not-found (3) tests below do not need their own inline "control
// arm": a suite where every not-found case were mislabeled 3 unconditionally
// would already be caught by every AC-S1..S6 test's `strictEqual(r.code, 0)`.
// ===========================================================================

test('AC-S7a: an id absent from the store is a not-found (exit 3), naming both the id looked for and the db path searched', async () => {
  await ready();
  const dir = tmp('doctor-acs7a-');
  const presentId = randomUUID();
  const missingId = randomUUID();
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(presentId, 'x')]);
  const r = doctor(['show', '--db', dbPath, '--id', missingId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: exit 2 (malformed) instead of 3 for an absent id — this
  // assertion goes red on the exit code alone.
  assert.strictEqual(r.code, 3, `a well-formed id absent from the store is a finding (exit 3): ${out}`);
  assert.match(out, new RegExp(missingId), 'names the id looked for');
  assert.ok(out.includes(dbPath), 'names the db path searched');
});

test('AC-S7b: a prefix matching nothing is a not-found (exit 3), never an ambiguity refusal', async () => {
  await ready();
  const dir = tmp('doctor-acs7b-');
  const presentId = randomUUID();
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(presentId, 'x')]);
  // 'z' is not a hex digit, so this prefix structurally cannot match any
  // UUID-shaped id in the store, deterministically, regardless of fixture
  // contents.
  const noMatchPrefix = 'zzzzzzzz';
  const r = doctor(['show', '--db', dbPath, '--id', noMatchPrefix], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: conflate "zero matches" with "ambiguous" (exit 2) rather than
  // "not found" (exit 3) — this assertion goes red on the exit code.
  assert.strictEqual(r.code, 3, `a prefix matching zero records is not-found, not ambiguous or malformed: ${out}`);
  assert.match(out, new RegExp(noMatchPrefix), 'names the prefix looked for');
});

test('AC-S7c: missing --db is refused (exit 2)', async () => {
  await ready();
  const dir = tmp('doctor-acs7c-');
  const r = doctor(['show', '--id', randomUUID()], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: default --db to some implicit path instead of refusing — this
  // assertion goes red on the exit code (almost certainly becoming a
  // not-found 3 or a crash instead of a clean malformed-input 2).
  assert.strictEqual(r.code, 2, out);
});

test('AC-S7d: missing --id is refused (exit 2)', async () => {
  await ready();
  const dir = tmp('doctor-acs7d-');
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(randomUUID(), 'x')]);
  const r = doctor(['show', '--db', dbPath], dir);
  const out = oneLine(r.stdout + r.stderr);
  assert.strictEqual(r.code, 2, out);
});

test('AC-S7e: a --db path that does not exist is refused (exit 2), naming the condition', async () => {
  await ready();
  const dir = tmp('doctor-acs7e-');
  const missing = join(dir, 'nope', 'sterling.db');
  const r = doctor(['show', '--db', missing, '--id', randomUUID()], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: let a missing --db path fall through to DatabaseSync, which
  // would create a NEW empty file rather than refusing — this assertion goes
  // red both on the exit code and because the file would then exist.
  assert.strictEqual(r.code, 2, out);
  assert.match(out, /does not exist|no such file|not found/i, 'names the missing --db condition');
  assert.equal(existsSync(missing), false, 'show must never CREATE a store file that did not exist');
});

test('AC-S7f: a db with no `records` table fails loud (exit 2), naming the file, never a raw SQLite error', async () => {
  await ready();
  if (!sqliteAvailable) { return; }
  const dir = tmp('doctor-acs7f-');
  const dbPath = mkRawSqlite(join(dir, 'sterling.db'), 2);
  const r = doctor(['show', '--db', dbPath, '--id', randomUUID()], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: query `SELECT body FROM records ...` without first checking the
  // table exists — this assertion goes red because the raw driver's "no such
  // table" text (or an uncaught-exception shape) would appear instead of a
  // clean, prefixed refusal.
  assert.strictEqual(r.code, 2, out);
  assert.doesNotMatch(out, /SqliteError|no such table/i, 'must not surface the raw driver exception');
  assert.ok(out.includes(dbPath), 'names the offending file');
});

// ===========================================================================
// ADVERSARIAL — a record whose body is present but unparseable JSON must be
// reported loud with a deliberate exit 2, never an uncaught crash. Pinned via
// the EXACT exit code (2), not merely "non-zero": Node's default exit code
// for an unhandled exception/rejection is 1, so this specifically catches
// "let the JSON.parse throw propagate" without also catching legitimate
// exit-2 refusals for unrelated reasons.
// ===========================================================================

test('ADVERSARIAL: a record with an unparseable JSON body is reported loud (exit 2), not an uncaught crash', async () => {
  await ready();
  if (!sqliteAvailable) { return; }
  const dir = tmp('doctor-acsbadjson-');
  const badId = randomUUID();
  const dbPath = mkPreV2Store(join(dir, 'sterling.db'), 0, []); // creates the table + header only
  const rw = openRW(dbPath);
  rw.prepare('INSERT INTO records (id, body) VALUES (?, ?)').run(badId, 'not-json{{{this is garbage');
  rw.close();
  const r = doctor(['show', '--db', dbPath, '--id', badId], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: call `JSON.parse(row.body)` with no try/catch around it — this
  // assertion goes red because an uncaught SyntaxError makes node exit with
  // code 1 (Node's default for an unhandled exception), never a deliberate 2.
  assert.strictEqual(r.code, 2, `an unparseable body must be a deliberate, caught refusal (exit 2), not an uncaught crash (typically exit 1): ${out}`);
});

// ===========================================================================
// AC-S8 — READ-ONLY IS ACTUALLY READ-ONLY, pinned the way that works: a hot
// WAL with NO LIVE CONNECTION (the crashed-writer shape — the only shape in
// which a writable open actually mutates anything, since the defect fires on
// SQLite's LAST-CONNECTION-OUT checkpoint). Structurally identical to the
// sibling suite's mutation-verified AC15 fixture; adapted here to exercise
// `show` instead of `migrate`/`adopt`.
// ===========================================================================

test('AC-S8: show against a hot WAL with no live connection (crashed-writer shape) leaves the main .db and -wal byte-identical', async () => {
  await ready();
  if (!sqliteAvailable) { return; }
  const dirA = tmp('doctor-acs8hot-a-');
  const dirB = tmp('doctor-acs8hot-b-');
  const aPath = join(dirA, 'hot', 'sterling.db');
  mkdirSync(dirname(aPath), { recursive: true });
  const writer = new SterlingStore(aPath);

  const modeSetter = new DatabaseSync(aPath);
  const forcedMode = modeSetter.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  modeSetter.close();

  const freshId = randomUUID();
  writer.create(mk(freshId, 'freshly committed, uncheckpointed — the record show() will target'));

  // Move the hot pair (main + -wal, NEVER -shm) to a fresh dir with no live
  // connection anywhere — the crashed-writer shape.
  const bPath = join(dirB, 'hot', 'sterling.db');
  mkdirSync(dirname(bPath), { recursive: true });
  copyFileSync(aPath, bPath);
  copyFileSync(`${aPath}-wal`, `${bPath}-wal`);
  writer.close();

  const proveHot = () => {
    const scratch = join(dirB, `proof-copy-${randomUUID()}.db`);
    try {
      copyFileSync(bPath, scratch);
      return { hot: !listIds(scratch).includes(freshId), error: null };
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/no such table:\s*records/i.test(msg)) return { hot: true, error: null };
      return { hot: false, error: msg };
    }
  };

  const walExistedBefore = existsSync(`${bPath}-wal`);
  const walSizeBefore = walExistedBefore ? statSync(`${bPath}-wal`).size : 0;
  const first = proveHot();
  // Fixture precondition, not a pin on domain-doctor.mjs — no implementation
  // sabotage can turn this one red or green; a genuine inability to
  // construct the crashed-writer state must be visible with evidence.
  assert.ok(first.hot,
    `could not establish a hot (uncheckpointed) WAL with no live connection: forced journal_mode='${forcedMode}', ` +
    `pre-existing -wal existed=${walExistedBefore} size=${walSizeBefore} bytes, ` +
    `proveHot() error=${first.error ?? 'none (row was simply already present in the main file)'}.`);
  assert.ok(existsSync(`${bPath}-wal`) && statSync(`${bPath}-wal`).size > 0, 'fixture precondition: a real, non-empty -wal exists on the crashed copy');
  assert.equal(existsSync(`${bPath}-shm`), false, 'fixture precondition: -shm was deliberately not copied — no live connection exists anywhere on dir B');

  const snap = () => ({ main: hashFile(bPath), wal: hashFile(`${bPath}-wal`) });

  const beforeProof = proveHot();
  assert.ok(beforeProof.hot, `WAL liveness lost before the show() call could even run: ${beforeProof.error ?? 'checkpointed already'}`);
  const before = snap();
  const r = doctor(['show', '--db', bPath, '--id', freshId], dirB);
  const out = oneLine(r.stdout + r.stderr);
  const after = snap();
  // SABOTAGE: open bPath with a writable DatabaseSync (e.g. `new
  // DatabaseSync(path)` instead of `{ readOnly: true }`) anywhere on this
  // path — this MUST go red here specifically, because with no other
  // connection left on bPath, the doctor's own connection is the LAST one
  // out, so a writable connection's close checkpoints the WAL into the main
  // file and changes both hashes. (Mutation-verified in the sibling suite:
  // this exact sabotage stayed green under a still-open-writer fixture,
  // because that state made last-connection-out unreachable regardless of
  // how the doctor opened it — which is why this fixture is the
  // crashed-writer shape, not a live-writer one.)
  assert.deepEqual(after, before, `a read-only show() must leave the main .db and -wal byte-identical: ${out}`);
  assert.ok(existsSync(`${bPath}-wal`), '-wal still present after the show() call');
  // -shm is deliberately NOT asserted here (see header disclosure #2): a
  // read-only reader may legitimately create/touch it to build a WAL index,
  // which is not a write to the database, so this suite never hashes it.
});

test('AC-S8 (converse): a cold store (no sidecars beforehand) gets none created by show', async () => {
  await ready();
  const dir = tmp('doctor-acs8cold-');
  const id = randomUUID();
  const cold = mkV2(join(dir, 'cold', 'sterling.db'), [mk(id, 'x')]);
  assert.equal(existsSync(`${cold}-wal`), false, 'fixture precondition: no -wal before any call');
  assert.equal(existsSync(`${cold}-shm`), false, 'fixture precondition: no -shm before any call');

  doctor(['show', '--db', cold, '--id', id], dir);
  // SABOTAGE: open the store with a plain `new DatabaseSync(path)` (writable,
  // default journal mode) instead of `{ readOnly: true }` plus the
  // hadWal/hadShm-conditional cleanup the anti-pattern's "right way" pattern
  // prescribes — a naive open can leave -wal/-shm litter it never cleans up,
  // and these assertions go red on their appearance.
  assert.equal(existsSync(`${cold}-wal`), false, 'show must not create a -wal beside a cold store');
  assert.equal(existsSync(`${cold}-shm`), false, 'show must not create a -shm beside a cold store');
});
