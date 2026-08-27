// domain-doctor `adopt --apply --create-only` tests — a SIBLING to
// domain-doctor-v2-guard.test.mjs, domain-doctor-field-loss.test.mjs and
// domain-doctor-escape-hatch.test.mjs, pinning the ONE write path `adopt` has
// ever been permitted to have.
//
// WHY THIS FILE EXISTS. `adoptCreateOnly()` is implemented and, at the time of
// writing, UNCOMMITTED and ENTIRELY UNVERIFIED: an independent audit measured
// ZERO grep hits for `--create-only` anywhere under scripts/tests/. That is a
// data-adjacent write path over REAL USER KNOWLEDGE STORES with no coverage at
// all. Six domain-doctor suites are 97/97 green and none of them execute a
// single line of it.
//
// THE RULED DESIGN — board 44434103, option (B), the "NARROW SAFE SUBSET".
// The write half of `adopt` was REMOVED once already (v2-guard round 3: a
// concurrent-commit-loss race plus a non-atomic rmSync-then-VACUUM-INTO
// replace; the user ruled "gated-unreachable code is worse than absent code").
// It comes back ONLY in the shape that has no race to lose: allow `--apply`
// when the destination DOES NOT EXIST, by `VACUUM INTO` a temp and `linkSync`
// it into place. No existing destination means no live holder, no backup, no
// replace, no TOCTOU. It does NOT heal an existing split — which is most of
// what board 44434103 is for, and precisely why the SUCCESS WORDING is pinned
// here as hard as the behaviour (pin 6): a user who reads "adopted" and infers
// that the general adopt write half now works has been misled by this tool
// into believing their split store was healed when it was not.
//
// THE LOAD-BEARING PIN IS PIN 2 — AND ITS VERDICT CARRIER IS BYTE-IDENTITY,
// NOT THE PRESENCE OF AN ERROR. The design's entire safety argument is that
// destination-absence is enforced by the PUBLICATION PRIMITIVE (`linkSync`,
// which fails EEXIST atomically at the moment of publication) and NOT by an
// `existsSync` check, which would be TOCTOU — the exact class of race that got
// the previous write half deleted. A test asserting only "it exited non-zero"
// would stay green under a `copyFileSync` publication guarded by `existsSync`,
// which is the regression this file exists to catch. So every existing-
// destination arm asserts the destination's BYTES are unchanged, and the whole
// directory is unchanged, before it says anything about exit codes.
//
// THE TOCTOU WINDOW IS NOT DETERMINISTICALLY REACHABLE FROM THE CLI, AND THIS
// FILE DOES NOT PRETEND OTHERWISE. Reproducing "the destination appears
// BETWEEN the check and the publish" needs either a fault-injection seam in
// the implementation (there is none) or a racing writer timed against a
// VACUUM (flaky by construction). Rather than ship a sleep-and-hope arm, this
// file pins a DETERMINISTIC STATIC ANALOGUE of the same distinction — the
// DANGLING-SYMLINK arm below. `existsSync(to)` on a dangling symlink is FALSE
// (it follows the link), so an `existsSync`-guarded implementation proceeds and
// publishes; `link(2)` does NOT follow the link and fails EEXIST on the entry
// itself. One fixture, no timing, and it separates the two guard designs
// exactly. What it does NOT prove is the temporal race; that is stated in the
// report as unpinned rather than faked.
//
// DEFENCE-IN-DEPTH DISCLOSURE (the hollow-pin corollary). If the shipped
// implementation carries an EARLY existence check IN ADDITION to `linkSync`,
// then the single mutation "replace linkSync with copyFileSync" leaves the
// plain-file arm GREEN — not because the arm is hollow, but because a second
// layer caught it. To tell the two apart the layers must be stripped TOGETHER:
// remove any pre-publish existence check AND replace linkSync with a copy. The
// dangling-symlink arm is the discriminator that says WHICH layer is carrying
// the verdict, because it is the one fixture where an existsSync layer does
// not fire at all.
//
// EXIT-CODE CONTRACT, carried forward from v2-guard round 4 (three-valued, not
// re-litigated here): 0 = clean/succeeded, 3 = a FINDING to report, 2 = cannot
// safely be attempted. A create-only apply onto an occupied destination is
// "cannot safely be attempted" -> 2.
//
// WORDING IS PINNED AT CLAUSE LEVEL, NOT VERBATIM. Each honesty assertion
// matches a distinctive keyword for ONE required clause with a message naming
// the clause. A rephrase keeps the clause and stays green; a rephrase that
// DROPS a clause goes red, which is the whole point — the four success clauses
// are the difference between an honest report and one from which a user infers
// a capability that does not exist.
//
// FIXTURE NOTES, inherited from the sibling suites.
// (1) Provenance DDL is HARDCODED, never introspected (the composite-PK trap,
//     anti_pattern 0059fa66):
//       record_versions(record_id, version, archived_at, body) PK(record_id,version)
//       record_aliases(historical_id PK, canonical_id, archived_version, created_at)
//       record_relations(source_id, rel, target_id, created_at) PK(source_id,rel,target_id)
// (2) oneLine() flattens a child-process stream only inside an assertion's own
//     MESSAGE, never its TARGET (anti_pattern ee89c3fd).
// (3) THIS SUITE'S OWN READS MUST NOT CREATE THE LITTER IT CHECKS FOR
//     (anti_pattern 8616e72d): a read-only DatabaseSync open on a WAL store
//     MATERIALIZES an empty -wal/-shm. Every directory/byte snapshot is
//     therefore taken with raw fs reads ONLY, and every openRO()/listIds()
//     verification happens strictly AFTER the last such snapshot in its test.
// (4) The destination is never opened with SterlingStore for verification —
//     that constructor is the lazy-CREATE path and would write to the very
//     thing under test.
// (5) LOGICAL fidelity is asserted, not byte-fidelity: `VACUUM INTO` rewrites
//     the file (that is what makes it a consistent snapshot), so "byte-faithful
//     mirror" in board 44434103's prose means record- and satellite-level
//     faithfulness, and asserting a byte-equal copy would pin a property the
//     design does not have.
//
// VERIFICATION POSTURE: the author of this file holds NO Bash, by design (the
// read wall that keeps the oracle from being anchored to the code under test).
// NOTHING HERE HAS BEEN EXECUTED. Every assertion carries a SABOTAGE comment
// naming the one-line implementation change that must turn it red; the
// coordinator runs the file and holds it to those shapes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, readFileSync,
  copyFileSync, symlinkSync, readlinkSync,
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
    encoding: 'utf8', cwd, timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function mk(id, answer, extra = {}) {
  return {
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22',
    capture_date: '2026-06-22', ...extra,
  };
}

function mkV2(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SterlingStore(path);
  for (const r of records) s.create(r);
  s.close();
  return path;
}

const openRO = (path) => new DatabaseSync(path, { readOnly: true });
const openRW = (path) => new DatabaseSync(path);

// --- hardcoded provenance-table writers (fixture note 1) ---------------------
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

/** Enumerate record ids through the ONE column this suite family treats as
 *  literal fact ("SELECT body FROM records"). */
function listIds(dbPath) {
  const db = openRO(dbPath);
  const rows = db.prepare('SELECT body FROM records').all();
  db.close();
  return rows.map((r) => JSON.parse(r.body).id).sort();
}
function bodyOf(dbPath, id) {
  const db = openRO(dbPath);
  const rows = db.prepare('SELECT body FROM records').all();
  db.close();
  for (const r of rows) {
    const b = JSON.parse(r.body);
    if (b.id === id) return b;
  }
  return undefined;
}
function userVersionOf(dbPath) {
  const db = openRO(dbPath);
  const v = db.prepare('PRAGMA user_version').get().user_version;
  db.close();
  return v;
}
// node:sqlite's `.all()` returns rows as `[Object: null prototype]`. Every
// field compares equal, but `assert.deepEqual` under `node:assert/strict` is
// `deepStrictEqual`, which also compares PROTOTYPES — so a raw row asserted
// against a plain `{...}` literal fails on the prototype alone, not on any
// field. The `.map((r) => ({ ...r }))` below re-homes each row on
// Object.prototype so the comparison is field-for-field only, exactly as
// strict as before. Do NOT "simplify" this back to the raw `.all()` result —
// that reintroduces a false red with an identical-looking diff.
function satelliteRows(dbPath) {
  const db = openRO(dbPath);
  const out = {
    aliases: db.prepare('SELECT historical_id, canonical_id, archived_version FROM record_aliases ORDER BY historical_id').all().map((r) => ({ ...r })),
    versions: db.prepare('SELECT record_id, version FROM record_versions ORDER BY record_id, version').all().map((r) => ({ ...r })),
    relations: db.prepare('SELECT source_id, rel, target_id FROM record_relations ORDER BY source_id, rel, target_id').all().map((r) => ({ ...r })),
  };
  db.close();
  return out;
}

const hashFile = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Hash every FILE under a directory tree with raw fs reads only, so "nothing
 *  written / no temp residue" covers sidecars and stray temp files, not just
 *  the main .db. Directories contribute nothing, so a created-but-empty
 *  directory is deliberately tolerated: an empty dir is not a residue and not
 *  a partial database. */
function snapshotDir(dir) {
  const out = {};
  const walk = (d, prefix) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isSymbolicLink()) out[rel] = `symlink:${readlinkSync(full)}`;
      else out[rel] = hashFile(full);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * PIN 6 (success half) — the four clauses an honest create-only success MUST
 * carry. Each is asserted separately so a dropped clause names itself.
 *
 * These are not decoration. `adopt --apply --create-only` is a NARROW subset of
 * the capability board 44434103 tracks, shipped while the general write half is
 * deliberately unbuilt. A success line reading "adopted" with none of these
 * clauses lets an operator conclude (a) their split store was healed, (b)
 * everything committed to the source is present, and (c) whatever was at the
 * destination was safely superseded. All three conclusions are false.
 */
function assertHonestSuccessWording(out, label) {
  assert.match(
    out, /point[-\s]?in[-\s]?time/i,
    `${label}: says the destination was created from a consistent POINT-IN-TIME snapshot — without it, the user reads ` +
      `"adopted" as "live mirror"`
  );
  assert.match(
    out, /replac/i,
    `${label}: states that no existing destination was replaced — the one property that distinguishes this mode from ` +
      `the removed write half`
  );
  assert.match(
    out, /concurrent/i,
    `${label}: discloses that source commits CONCURRENT with (after the start of) the snapshot may be ABSENT — the ` +
      `snapshot is point-in-time, and silence here is how a user concludes nothing was missed`
  );
  assert.match(
    out, /heal|merge/i,
    `${label}: states this does NOT heal or merge an existing split — which is most of what board 44434103 is for and ` +
      `is exactly what a bare "adopted" would be read as having done`
  );
}

/**
 * PIN 6 (refusal half) — a create-only refusal must say WHY the mode refused,
 * in terms of the mode's rule, not just that an fs call failed. "EEXIST" alone
 * is a syscall leaking; the operator needs to learn that create-only adoption
 * NEVER replaces an existing store, so they stop looking for a --force.
 */
function assertHonestRefusalWording(out, label) {
  assert.match(
    out, /replac/i,
    `${label}: states that create-only adoption never REPLACES an existing store`
  );
  assert.match(
    out, /exist/i,
    `${label}: and names the condition it found — something already exists at the destination`
  );
}

// ---------------------------------------------------------------------------
// CONTROLS FIRST. Both of the arms below must pass for the OPPOSITE reason to
// everything after them: they prove that a destination appearing at the end of
// a run is caused by `--apply --create-only` SPECIFICALLY, and not by the
// fixture, the harness, or `adopt` in general. Without them, "the destination
// exists and holds the records" has more than one possible cause and the whole
// success group is unfalsifiable.
// ---------------------------------------------------------------------------

test('CONTROL: `adopt` WITHOUT --apply onto a MISSING destination reports adoptable and creates NOTHING — the write is caused by the flag, not by the mode', () => {
  const dir = tmp('doctor-createonly-ctl-ro-');
  const x = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(x, 'x')]);
  const to = join(dir, 'to', 'sterling.db');
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', from, '--to', to], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: make adoptCreateOnly() run whenever `--create-only` is present
  // regardless of `--apply` (or default `apply` to true) — this arm goes red on
  // the destination appearing, and it is the ONLY arm that can see that
  // particular slip, because every other arm passes --apply.
  assert.strictEqual(r.code, 0, `a missing destination is reported adoptable (AC13-control precedent): ${out}`);
  assert.equal(existsSync(to), false, 'the read-only probe created NOTHING at the destination path');
  assert.deepEqual(snapshotDir(dir), before1, 'byte-identical: no file created or modified anywhere');
  // SABOTAGE: emit the create-only success wording unconditionally rather than
  // only on the applied path — this assertion reddens alone and proves the
  // wording arms below are pinning the APPLY report, not "words this tool
  // prints somewhere".
  assert.doesNotMatch(r.stdout, /point[-\s]?in[-\s]?time/i, 'a dry probe never claims a snapshot was taken');
});

test('CONTROL: `adopt --apply` WITHOUT --create-only onto a MISSING destination is still refused, nothing created — sibling of AC18, green before this change and after', () => {
  const dir = tmp('doctor-createonly-ctl-noflag-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const to = join(dir, 'nested', 'missing', 'sterling.db');
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', from, '--to', to, '--apply'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // GREEN BEFORE AND AFTER — that is the point. AC18 (v2-guard) already pins
  // this and passes at HEAD. Restating it HERE is what makes `--create-only`
  // the demonstrated unlock: without this arm, every success below is equally
  // explained by "--apply started writing again", which is the exact
  // regression the removed write half must not stage a comeback through.
  // SABOTAGE: route a bare `--apply` into adoptCreateOnly() when the
  // destination happens to be missing — this arm reddens alone.
  assert.strictEqual(r.code, 2, `a bare --apply is still refused: ${out}`);
  assert.match(out, /not implemented|no longer (supported|implemented)|removed|create-only/i, 'and says so');
  assert.doesNotMatch(out, /usage:/, 'the mode itself still exists — this is a refusal, not an unknown-flag usage line');
  assert.equal(existsSync(to), false, 'the missing destination was NOT created');
  assert.deepEqual(snapshotDir(dir), before1, 'nothing created or modified anywhere');
});

// ---------------------------------------------------------------------------
// PIN 1 — a FRESH destination is published as a VALID store carrying the
// source's records AND its satellite tables. The satellites are the load-
// bearing half: whole-file adoption exists precisely because migrate's
// record-replay cannot carry record_versions / record_aliases /
// record_relations (decision 8e3848ad part 2). A create-only apply that
// published a record-replay would satisfy a records-only assertion and quietly
// destroy the reason the mode exists.
//
// MASKING NOTE (anti_pattern f1d66bef): the satellite-rows prototype defect
// fixed in satelliteRows() above was, on an earlier run, hidden by an
// unrelated litter assertion failing FIRST in this same long test and
// aborting before execution ever reached the satellite comparisons — another
// instance of one early failure in a multi-assertion test hiding every
// finding after it. Both are now independently visible: the earlier
// assertion passes on its own, and the satellite comparisons are reached.
// ---------------------------------------------------------------------------

test('PIN1: --apply --create-only onto a fresh destination publishes a valid v2 store carrying the source records AND its record_versions/record_aliases/record_relations rows', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-createonly-fresh-');
  const x = randomUUID();
  const y = randomUUID();
  const historical = randomUUID();
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(x, 'x body'), mk(y, 'y body')]);
  const rw = openRW(fromPath);
  insertAlias(rw, historical, x, 1, '2026-06-01T00:00:00.000Z');
  insertVersionSnapshot(rw, x, 1, JSON.stringify(mk(x, 'x body v1')), '2026-06-01T00:00:00.000Z');
  insertRelation(rw, x, 'relies_on', y, '2026-06-01T00:00:00.000Z');
  rw.close();

  const to = join(dir, 'to', 'sterling.db');
  const sourceHashBefore = hashFile(fromPath);
  assert.equal(existsSync(to), false, 'fixture precondition: the destination does not exist');
  assert.equal(existsSync(`${fromPath}-wal`), false, 'fixture precondition: the source is COLD — no -wal before the call');
  assert.equal(existsSync(`${fromPath}-shm`), false, 'fixture precondition: the source is COLD — no -shm before the call');

  const r = doctor(['adopt', '--from', fromPath, '--to', to, '--apply', '--create-only'], dir);
  const out = oneLine(r.stdout + r.stderr);

  // SABOTAGE: hardcode a non-zero exit on the applied path (an implementation
  // that never reports success). Without a positive arm the whole file could be
  // satisfied by a mode that refuses everything — the same hole AC-adopt-clean
  // closes for the read-only verdict.
  assert.strictEqual(r.code, 0, `a create-only apply onto an absent destination succeeds: ${out}`);
  assert.ok(existsSync(to), `the destination was actually created: ${out}`);

  // PIN 3 (success half) — NO TEMP RESIDUE. Asserted with a raw readdir BEFORE
  // any DatabaseSync open in this test (fixture note 3), because a read-only
  // open would itself materialize the -wal/-shm this is checking for.
  // SABOTAGE: remove the unlink of the VACUUM temp after a successful link (or
  // move it before the link) — the temp, or a temp -wal/-shm pair left by the
  // snapshot re-validation open, shows up here and this reddens alone.
  assert.deepEqual(
    readdirSync(join(dir, 'to')).sort(), ['sterling.db'],
    'the destination directory holds EXACTLY the published store — no temp, no snapshot leftovers, no sidecars'
  );

  // SABOTAGE: open the source WRITABLE anywhere on this path instead of
  // read-only — on a cold store that leaves a -wal/-shm pair behind (the
  // converse direction of AC15, anti_pattern 8616e72d).
  assert.equal(hashFile(fromPath), sourceHashBefore, 'the SOURCE is byte-identical after an apply — adoption reads, never writes, the source');
  assert.equal(existsSync(`${fromPath}-wal`), false, 'and gains no -wal litter');
  assert.equal(existsSync(`${fromPath}-shm`), false, 'and gains no -shm litter');

  // --- everything below opens databases; no fs snapshot may follow. ---
  assert.equal(userVersionOf(to), 2, 'the published file is a real v2 Sterling store, not an empty or half-built file');
  assert.deepEqual(listIds(to), [x, y].sort(), 'and carries the source records');
  assert.equal(bodyOf(to, x).answer, 'x body', 'with bodies intact, id-for-id');

  // SABOTAGE: replace vacuumIntoSnapshot() with a record-by-record create()
  // replay into a fresh store (i.e. re-implement adopt as migrate). Records and
  // ids survive that mutation; these three assertions do not — they are the
  // ONLY thing in this file that distinguishes whole-file adoption from the
  // lossy replay adopt exists to avoid (decision 8e3848ad, anti_pattern
  // 44d4f74f).
  const sat = satelliteRows(to);
  assert.deepEqual(
    sat.aliases, [{ historical_id: historical, canonical_id: x, archived_version: 1 }],
    'record_aliases crossed whole — a record-replay adopt would carry none'
  );
  assert.deepEqual(sat.versions, [{ record_id: x, version: 1 }], 'record_versions crossed whole, composite key intact');
  assert.deepEqual(sat.relations, [{ source_id: x, rel: 'relies_on', target_id: y }], 'record_relations crossed whole');
});

test('PIN6-SUCCESS: the create-only success report carries all four honesty clauses — point-in-time, nothing replaced, concurrent commits may be absent, and this does NOT heal a split', () => {
  const dir = tmp('doctor-createonly-wording-ok-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'x')]);
  const to = join(dir, 'to', 'sterling.db');

  const r = doctor(['adopt', '--from', from, '--to', to, '--apply', '--create-only'], dir);
  const combined = `${r.stdout}\n${r.stderr}`;
  // SABOTAGE: delete ANY ONE of the four clauses from the success message (for
  // example, drop the "does not heal an existing split" sentence). Exactly one
  // assertion below reddens, and it names the clause that went missing. This is
  // the arm that keeps the narrow subset from being read as the general
  // capability board 44434103 says is NOT built.
  assert.strictEqual(r.code, 0, `precondition — this arm reads a SUCCESS report: ${oneLine(combined)}`);
  assertHonestSuccessWording(combined, 'create-only success');
});

// ---------------------------------------------------------------------------
// PIN 2 — THE LOAD-BEARING PIN. An existing destination is REFUSED, and the
// existing file stays BYTE-IDENTICAL. Read the file header for why byte
// identity, not the error, is the verdict carrier, and for the defence-in-depth
// disclosure about stripping layers together.
// ---------------------------------------------------------------------------

test('PIN2: an EXISTING destination is refused and stays BYTE-IDENTICAL — the refusal is worthless as evidence; the bytes are the verdict', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-createonly-eexist-');
  const sourceOnly = randomUUID();
  const destOnly = randomUUID();
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(sourceOnly, 'source body')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(destOnly, 'destination body — MUST SURVIVE')]);

  const destHashBefore = hashFile(to);
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', fromPath, '--to', to, '--apply', '--create-only'], dir);
  const out = oneLine(r.stdout + r.stderr);

  // THE VERDICT CARRIER, asserted FIRST and with raw fs reads only.
  // SABOTAGE (named by the brief): replace `linkSync(snapshot, to)` with a
  // plain copy/write — `copyFileSync(snapshot, to)` or
  // writeFileSync(to, readFileSync(snapshot)). Both happily clobber an existing
  // file, this assertion goes RED, and NO assertion about the exit code or the
  // message would have noticed if the implementation still printed a refusal
  // afterwards.
  // LAYER NOTE: if the implementation ALSO carries an early existence check,
  // that single mutation leaves this arm green — defence in depth, not
  // hollowness. To learn which guard carries the verdict, strip BOTH (remove
  // the pre-publish existence check AND replace linkSync with a copy); the
  // DANGLING-SYMLINK arm below is the fixture where the existsSync layer cannot
  // fire at all, so it isolates linkSync on its own.
  assert.equal(
    hashFile(to), destHashBefore,
    'THE EXISTING DESTINATION IS BYTE-IDENTICAL — create-only adoption never replaces a store, and absence is enforced ' +
      'by the publication primitive, not by a check that can go stale'
  );
  // PIN 3 (failure half) + PIN 4 — no temp residue, and nothing new anywhere.
  // SABOTAGE: remove the temp cleanup from the failure path (the temp is
  // unlinked only after a successful link, so a refusal leaks the whole VACUUM
  // snapshot into the user's domain directory) — this reddens on the extra
  // file, and it is the only arm that can see it, since the success arm's
  // cleanup runs on a different branch.
  assert.deepEqual(
    snapshotDir(dir), before1,
    'and nothing else changed either: no VACUUM temp left behind in the destination directory, no sidecar litter'
  );

  assert.notStrictEqual(r.code, 0, `the run must not report success: ${out}`);
  // Contract code per v2-guard round 4: "cannot safely be attempted" is 2.
  // SABOTAGE: swallow the EEXIST and exit 0 (or let it escape as an unhandled
  // throw, exit 1) — either reddens here while the byte assertion above stays
  // green, which is exactly the separation this pairing is for.
  assert.strictEqual(r.code, 2, `refusal is the three-valued contract's exit 2: ${out}`);
  assertHonestRefusalWording(out, 'create-only EEXIST refusal');

  // --- database opens only past this point (fixture note 3). ---
  assert.deepEqual(listIds(to), [destOnly], 'the destination still holds exactly its own record');
  assert.equal(bodyOf(to, sourceOnly), undefined, 'and none of the source crossed — not even partially');
});

test('PIN2-TOCTOU-ANALOGUE: a DANGLING SYMLINK at the destination — which existsSync() calls ABSENT and link(2) calls EEXIST — is refused, and the link is never materialized', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-createonly-dangling-');
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'source body')]);
  const to = join(dir, 'to', 'sterling.db');
  const linkTarget = join(dir, 'to', 'absent-target.db');
  mkdirSync(join(dir, 'to'), { recursive: true });
  try {
    symlinkSync(linkTarget, to);
  } catch (e) {
    // Windows without Developer Mode / SeCreateSymbolicLink refuses symlink
    // creation outright. That is a platform capability, not a finding about
    // domain-doctor — and the sibling suite (AC12) already relies on symlinks.
    if (/EPERM|EACCES|ENOSYS/i.test((e && e.code) || (e && e.message) || '')) {
      t.skip(`symlink creation unavailable in this environment (${e.code}) — this arm cannot run here`);
      return;
    }
    throw e;
  }

  // THE FIXTURE'S WHOLE POINT, asserted as a precondition so a reader can see
  // the discrimination is real and not asserted-into-existence.
  assert.equal(existsSync(to), false, 'fixture precondition: existsSync() follows the link and reports the destination ABSENT');
  assert.equal(lstatSync(to).isSymbolicLink(), true, 'fixture precondition: the directory ENTRY exists — which is what link(2) sees');
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', fromPath, '--to', to, '--apply', '--create-only'], dir);
  const out = oneLine(r.stdout + r.stderr);

  // SABOTAGE, the one this arm exists for: replace `linkSync(snapshot, to)`
  // with `copyFileSync(snapshot, to)` AND/OR guard publication with
  // `if (existsSync(to)) refuse()`. A copy FOLLOWS the symlink and creates
  // linkTarget; an existsSync guard says "absent" and lets it through. Either
  // way this assertion reddens — with NO timing, NO sleep and NO second
  // process. This is the deterministic stand-in for "the destination appeared
  // between the check and the publish"; it proves the guard DESIGN, not the
  // temporal race, and the report says so.
  assert.equal(
    existsSync(linkTarget), false,
    'the dangling symlink was NOT followed and materialized — publication refuses on the ENTRY, the way link(2) does, ' +
      'not on what a stat-through-the-link happens to say'
  );
  assert.deepEqual(snapshotDir(dir), before1, 'and nothing was written anywhere — no temp, no target, link unchanged');
  assert.notStrictEqual(r.code, 0, `the run must not report success: ${out}`);

  // SELF-EVIDENCING CLAUSE. If this assertion is the ONLY red in the file, the
  // finding is NOT "the wording is wrong" — it is that the dangling-symlink
  // path was refused by some EARLIER guard (a realpath/stat failure, say) and
  // therefore never reached the publication primitive, which means this arm did
  // not discriminate the two guard designs after all. Adjudicate that; do not
  // weaken this line, or the arm silently becomes a hollow pass.
  assertHonestRefusalWording(out, 'create-only refusal on a dangling-symlink destination');
});

test('PIN4: a destination path occupied by a DIRECTORY is refused with no partial database published and no temp left behind', () => {
  const dir = tmp('doctor-createonly-dirpath-');
  const fromPath = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'source body')]);
  const to = join(dir, 'to', 'sterling.db');
  mkdirSync(to, { recursive: true }); // the destination PATH is a directory
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', fromPath, '--to', to, '--apply', '--create-only'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: unlink/rmSync the destination path before publishing (any
  // "clear the way then write" shape — which is exactly the non-atomic
  // rmSync-then-VACUUM-INTO replace that got the previous write half deleted in
  // v2-guard round 3) — the directory disappears and these assertions redden.
  assert.notStrictEqual(r.code, 0, `an occupied destination path must not report success: ${out}`);
  assert.equal(existsSync(to), true, 'the occupying entry still exists');
  assert.equal(statSync(to).isDirectory(), true, 'and is still a directory — nothing cleared the way');
  assert.deepEqual(readdirSync(to), [], 'nothing was written INSIDE it either');
  assert.deepEqual(snapshotDir(dir), before1, 'no partial database and no VACUUM temp anywhere under the tree');
  // Fail-loud convention carried forward from AC17: a structural refusal is a
  // domain-doctor: message, never a raw exception surfacing from fs/sqlite.
  // SABOTAGE: let the fs error escape uncaught — this reddens while the state
  // assertions above stay green, separating "safe" from "safe AND loud".
  assert.match(out, /domain-doctor:/, 'refuses loudly in the tool\'s own voice');
  assert.doesNotMatch(out, /SqliteError|EISDIR|ENOTDIR/i, 'and never leaks a raw syscall/SQLite error as the whole message');
});

test('PIN4: a refusal raised BEFORE the snapshot is taken (missing --from) leaves no destination entry and no temp — the create-only path never gets that far', () => {
  const dir = tmp('doctor-createonly-prefail-');
  const from = join(dir, 'nope', 'sterling.db');
  const to = join(dir, 'to', 'sterling.db');
  const before1 = snapshotDir(dir);

  const r = doctor(['adopt', '--from', from, '--to', to, '--apply', '--create-only'], dir);
  const out = oneLine(r.stdout + r.stderr);
  // SABOTAGE: move the mkdir/VACUUM of adoptCreateOnly() ahead of the --from
  // preflight (or drop the preflight on the create-only branch) — a temp
  // snapshot or an empty destination file appears and these redden.
  assert.strictEqual(r.code, 2, `a missing source refuses before anything is attempted: ${out}`);
  assert.match(out, /does not exist|no such file|not found/i, 'names the missing --from condition');
  assert.doesNotMatch(out, /usage:/, 'the real missing-source refusal, not an unregistered-flag usage line');
  assert.equal(existsSync(to), false, 'no destination entry was created');
  assert.deepEqual(snapshotDir(dir), before1, 'and no temp file exists anywhere under the tree');
});

// ---------------------------------------------------------------------------
// PIN 5 — SOURCE SIDECARS SURVIVE. Background: readOnlyProbe records sidecar
// existence and then DELETES those paths, and a writer can create a sidecar
// AFTER that check, so the cleanup cannot prove it owns what it removes.
// adoptCreateOnly deliberately does not take that route: it opens the source
// read-only and only DISCLOSES sidecars. Deleting a non-empty -wal is
// destroying committed-but-uncheckpointed user knowledge.
//
// THE FIXTURE IS THE CRASHED-WRITER SHAPE, and the reason is mutation-verified
// history (v2-guard round 7): with a live writer connection kept open, the
// doctor's own connection is never LAST OUT, so a writable open and a read-only
// open are byte-indiscernible and a confirmed sabotage stays GREEN. Only with
// NO live connection anywhere does a writable open's close checkpoint the WAL
// into the main file and change the bytes.
//
// AND THE VERDICT HAS TWO POSSIBLE CAUSES, so exit 0 is asserted FIRST: a
// refused run would leave the sidecars untouched trivially, and a "sidecars
// survived" green off a refusal pins nothing at all.
// ---------------------------------------------------------------------------

test('PIN5: a successful create-only apply leaves the SOURCE main file and -wal byte-identical and its -shm present — sidecars are disclosed, never deleted', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dirA = tmp('doctor-createonly-hot-a-');
  const dirB = tmp('doctor-createonly-hot-b-');
  const aPath = join(dirA, 'hot', 'sterling.db');
  mkdirSync(dirname(aPath), { recursive: true });
  const writer = new SterlingStore(aPath); // open only long enough to build the hot triple

  // journal_mode is database-level, not connection-level, so forcing it through
  // a momentary second connection also applies to the already-open writer.
  const modeSetter = new DatabaseSync(aPath);
  const forcedMode = modeSetter.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
  modeSetter.close();

  const freshId = randomUUID();
  writer.create(mk(randomUUID(), 'older row'));
  writer.create(mk(freshId, 'freshly committed — lives in the -wal, and is what must survive'));

  // Move the hot files to dir B, then close dir A's writer: dir B holds an
  // uncheckpointed WAL with NO live connection anywhere. -shm IS copied here
  // (unlike v2-guard's AC15 fixture) because this pin includes "-shm survives";
  // its presence does not restore a live connection, so last-connection-out
  // remains reachable and the writable-open sabotage below remains detectable.
  const bPath = join(dirB, 'hot', 'sterling.db');
  mkdirSync(dirname(bPath), { recursive: true });
  copyFileSync(aPath, bPath);
  copyFileSync(`${aPath}-wal`, `${bPath}-wal`);
  const hadShm = existsSync(`${aPath}-shm`);
  if (hadShm) copyFileSync(`${aPath}-shm`, `${bPath}-shm`);
  writer.close();

  // proveHot() on a throwaway byte-copy, never on bPath itself: a maximally hot
  // store's main file can lack the `records` table entirely, and that specific
  // throw is the STRONGEST proof of hotness, not a failure to establish it
  // (v2-guard round 6).
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

  const proof = proveHot();
  // Fixture precondition, not a pin on the implementation: no sabotage of
  // scripts/domain-doctor.mjs can turn this red or green. An inability to build
  // the crashed-writer state must be visible WITH EVIDENCE, never a skip
  // (v2-guard round 5's ruling).
  assert.ok(proof.hot,
    `could not establish an uncheckpointed WAL with no live connection: forced journal_mode='${forcedMode}', ` +
    `-wal size=${existsSync(`${bPath}-wal`) ? statSync(`${bPath}-wal`).size : 0} bytes, ` +
    `proveHot() error=${proof.error ?? 'none (the row was simply already in the main file)'}.`);
  assert.ok(statSync(`${bPath}-wal`).size > 0, 'fixture precondition: a real, non-empty -wal');

  const to = join(dirB, 'to', 'sterling.db');
  // main and -wal carry data integrity and are hashed for exact equality. -shm
  // is checked for PRESENCE ONLY, never hashed: a read-only reader legitimately
  // registers a WAL-index read-mark there, which is correct SQLite behaviour
  // and not a write to the database (v2-guard round 6, measured).
  const mainBefore = hashFile(bPath);
  const walBefore = hashFile(`${bPath}-wal`);

  const r = doctor(['adopt', '--from', bPath, '--to', to, '--apply', '--create-only'], dirB);
  const out = oneLine(r.stdout + r.stderr);

  // ASSERTED FIRST — the verdict below has two possible causes, and a refusal
  // would satisfy "the sidecars survived" while pinning nothing.
  assert.strictEqual(r.code, 0, `precondition: the apply must actually have RUN and succeeded, not been refused: ${out}`);
  assert.ok(existsSync(to), 'and the destination really was published');

  // SABOTAGE A: swap the source's read-only open for a writable one
  // (`new DatabaseSync(path)` instead of `{ readOnly: true }`). With no other
  // connection on bPath, the doctor's is LAST OUT, so its close checkpoints the
  // WAL into the main file and BOTH hashes change.
  // SABOTAGE B: route the create-only apply through readOnlyProbe's
  // record-then-delete sidecar cleanup — the -wal is unlinked and these redden.
  assert.equal(hashFile(bPath), mainBefore, 'the source main .db is byte-identical after a successful apply');
  assert.equal(existsSync(`${bPath}-wal`), true, 'the source -wal STILL EXISTS — deleting it destroys committed, uncheckpointed records');
  assert.equal(hashFile(`${bPath}-wal`), walBefore, 'and is byte-identical — not checkpointed, not truncated, not rewritten');
  if (hadShm) {
    assert.equal(existsSync(`${bPath}-shm`), true, 'a PRE-EXISTING -shm survives too — the probe may not delete what it did not create');
  }

  // The hot rows must actually have crossed: VACUUM INTO through a read-only
  // open reads the WAL, so a snapshot that silently dropped uncheckpointed
  // records would be the worst possible outcome — a "successful" adoption
  // missing exactly the newest knowledge.
  // SABOTAGE: snapshot the main file by byte-copy instead of VACUUM INTO — the
  // WAL-resident row never crosses and this reddens.
  assert.ok(listIds(to).includes(freshId), 'the committed-but-uncheckpointed record is present in the published destination');
});
