// domain-doctor `show` hardening — pins for four in-lane defects found on
// review of the initial implementation (board 2182ed98). NOT a frozen suite
// in the same sense as domain-doctor-show.test.mjs: this file is authored
// alongside the fix, not blind ahead of it, but each test still names the
// exact SABOTAGE that must turn it red, per the mutation-verification
// discipline (decision a-ruling-change-is-verified-by-mutation-not-by-a-
// green-suite) so a later regression is caught rather than rubber-stamped.
//
// HOUSE STYLE: fixture helpers are copied from scripts/tests/domain-doctor-
// show.test.mjs by value, not imported — that file is a frozen pin and
// nothing in it is exported for reuse; duplicating a handful of small helpers
// is a smaller change than introducing a shared module for two files
// (minimal-change).
//
// THE FOUR FINDINGS PINNED HERE:
//   1. (MEDIUM) partially-present v2 satellites must be DISCLOSED, not
//      silently reported as "queried, found none" — HARD-1/HARD-2.
//   2. (LOW) a NULL records.id must not crash id resolution, and must be
//      reported as a finding — HARD-3.
//   3. (LOW) a satellite table with the wrong column shape must fail loud
//      (exit 2, naming the table), never a raw SqliteError — HARD-4.
//   4. (MEDIUM) an existing corrupt/non-SQLite file, or a `records` table
//      with the wrong column shape, must fail loud (exit 2), never an
//      uncaught crash — HARD-5/HARD-6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let DatabaseSync;
let sqliteAvailable = true;

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

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ===========================================================================
// HARD-1/HARD-2 — half-migrated v2 store: schema v2, one satellite table
// dropped. show() must DISCLOSE the absence, never silently print nothing
// (which reads identically to "queried this table, found no successor").
// ===========================================================================

test('HARD-1: a half-migrated v2 store (record_relations dropped) discloses the absence, distinct from "successor: none"', async () => {
  await ready();
  if (!sqliteAvailable) return;
  const dir = tmp('doctor-hard1-');
  const id = randomUUID();
  const marker = `MARK-${randomUUID().slice(0, 8)}`;
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(id, marker)]);
  const rw = openRW(dbPath);
  rw.exec('DROP TABLE record_relations');
  rw.close();

  const r = doctor(['show', '--db', dbPath, '--id', id], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: keep the plain `if (tables.has('record_relations')) { ... }`
  // with no else-branch at all — this assertion goes red because nothing
  // about record_relations would be printed, which is exactly the silent
  // false-clean this test exists to catch.
  assert.strictEqual(r.code, 0, `a half-migrated store must still show, not refuse: ${out}`);
  assert.ok(out.includes(marker), "the record's own body is printed");
  assert.match(out, /record_relations.{0,40}(absent|missing).{0,60}not checked/i, `discloses the absent table distinctly: ${out}`);
  // SABOTAGE: print the SAME text for "table absent" as for "table present,
  // zero rows" — this assertion goes red because the two cases would then be
  // indistinguishable to the human reading the output.
  assert.doesNotMatch(out, /successor \(record_relations, supersedes\): none/i, 'the absence disclosure must not read as "queried, found none"');
});

test('HARD-2: a v2 record with the record_relations table PRESENT but empty reports "none" explicitly, distinct from the absence disclosure', async () => {
  await ready();
  if (!sqliteAvailable) return;
  const dir = tmp('doctor-hard2-');
  const id = randomUUID();
  const marker = `MARK-${randomUUID().slice(0, 8)}`;
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(id, marker)]);

  const r = doctor(['show', '--db', dbPath, '--id', id], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: only print the successor line when the array is non-empty
  // (`if (successors && successors.length)`) — this assertion goes red
  // because a present-but-empty table would then print nothing at all,
  // collapsing back into the same silence HARD-1 exists to distinguish from.
  assert.strictEqual(r.code, 0, out);
  assert.match(out, /successor \(record_relations, supersedes\): none/i, `a present, empty table reports "none" explicitly: ${out}`);
  assert.doesNotMatch(out, /table absent/i, 'a present table must never print the absence disclosure');
});

// ===========================================================================
// HARD-3 — a NULL records.id must not crash resolution (legacy `records` has
// no NOT NULL on id), and must be reported, never dropped silently.
// ===========================================================================

test('HARD-3: a null-id row in a legacy store is reported as a finding and never crashes resolution of a normal id', async () => {
  await ready();
  if (!sqliteAvailable) return;
  const dir = tmp('doctor-hard3-');
  const goodId = randomUUID();
  const goodMarker = `MARK-${randomUUID().slice(0, 8)}`;
  const dbPath = mkPreV2Store(join(dir, 'sterling.db'), 0, [mk(goodId, goodMarker)]);
  const rw = openRW(dbPath);
  rw.prepare('INSERT INTO records (id, body) VALUES (?, ?)').run(null, JSON.stringify({ orphan: true }));
  rw.close();

  // Requested via an 8-char PREFIX, not the full id: an exact-match hit would
  // resolve before the filter ever runs over the null row, which is exactly
  // the shape that let this defect hide — the prefix path is what actually
  // calls `.startsWith` against every id in the store, null included.
  const r = doctor(['show', '--db', dbPath, '--id', goodId.slice(0, 8)], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: `allIds.filter((x) => x.startsWith(id))` with no
  // `typeof x === 'string'` guard — this assertion goes red because
  // `null.startsWith` throws a TypeError, which node reports as an uncaught
  // exception (exit 1), never a clean exit 0 with the good record printed.
  assert.strictEqual(r.code, 0, `a null-id row elsewhere in the store must not crash resolution of a normal id: ${out}`);
  assert.ok(out.includes(goodMarker), "the requested record's body is still printed");
  assert.match(out, /finding/i, 'the null-id row is reported as a finding, not silently dropped');
  assert.match(out, /null/i, 'the finding names the null-id condition');
});

// ===========================================================================
// HARD-4 — a satellite table present with the wrong column shape must fail
// loud (exit 2, naming the table), never a raw SqliteError past this file.
// ===========================================================================

test('HARD-4: a record_relations table with the wrong column shape fails loud (exit 2), naming the table, never a raw SqliteError', async () => {
  await ready();
  if (!sqliteAvailable) return;
  const dir = tmp('doctor-hard4-');
  const id = randomUUID();
  const dbPath = mkV2(join(dir, 'sterling.db'), [mk(id, 'x')]);
  const rw = openRW(dbPath);
  rw.exec('DROP TABLE record_relations');
  rw.exec('CREATE TABLE record_relations (nonsense TEXT)');
  rw.close();

  const r = doctor(['show', '--db', dbPath, '--id', id], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: query record_relations with no try/catch around it — this
  // assertion goes red because the "no such column: target_id" SqliteError
  // would propagate uncaught, exiting 1 with a raw driver stack trace instead
  // of a deliberate, clean exit 2 naming the table.
  assert.strictEqual(r.code, 2, `a malformed satellite table must be a deliberate refusal (exit 2): ${out}`);
  assert.doesNotMatch(out, /SqliteError|no such column/i, 'must not surface the raw driver exception');
  assert.ok(out.includes('record_relations'), 'names the offending table');
});

// ===========================================================================
// HARD-5/HARD-6 — an existing file that is not (or is only half) a valid
// SQLite/Sterling store must fail loud (exit 2), never an uncaught crash.
// ===========================================================================

test('HARD-5: an existing file that is not a valid SQLite database fails loud (exit 2), never an uncaught crash', async () => {
  await ready();
  const dir = tmp('doctor-hard5-');
  const dbPath = join(dir, 'sterling.db');
  writeFileSync(dbPath, 'this is definitely not a sqlite file');

  const r = doctor(['show', '--db', dbPath, '--id', randomUUID()], dir);
  const out = oneLine(r.stdout + r.stderr);
  // WHICH GUARD CARRIES THIS VERDICT (review correction): the up-front
  // probeSchemaVersion header-magic check intercepts this fixture — a bad
  // header returns {error} and fails at the schema-probe gate, so the file
  // never reaches readOnlyProbe. The outer try/catch around readOnlyProbe is
  // therefore DEFENSE-IN-DEPTH here, pinned by no test in either suite (a
  // fixture with a valid header but corrupt pages would pin it). SABOTAGE
  // that makes this red: remove the header-magic refusal in
  // probeSchemaVersion — the raw open then throws uncaught, exit 1.
  assert.strictEqual(r.code, 2, `a corrupt/non-SQLite file must be a deliberate refusal (exit 2), not an uncaught crash: ${out}`);
});

test('HARD-6: a records table with the wrong column shape fails loud (exit 2), never a raw SqliteError', async () => {
  await ready();
  if (!sqliteAvailable) return;
  const dir = tmp('doctor-hard6-');
  const dbPath = join(dir, 'sterling.db');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE records (nonsense TEXT)');
  db.exec('PRAGMA user_version = 0');
  db.close();

  const r = doctor(['show', '--db', dbPath, '--id', randomUUID()], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: `SELECT id FROM records` with no try/catch around it — this
  // assertion goes red because the "no such column: id" SqliteError would
  // propagate uncaught (exit 1) instead of a deliberate, clean exit 2.
  assert.strictEqual(r.code, 2, `a malformed records table must be a deliberate refusal (exit 2): ${out}`);
  assert.doesNotMatch(out, /SqliteError|no such column/i, 'must not surface the raw driver exception');
});
