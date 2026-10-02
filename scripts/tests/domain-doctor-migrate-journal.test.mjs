// AUTHORED BY THE TEST-WRITER LANE (H4 read wall applies): this suite specifies
// behavior from the dispatch brief and from domain-doctor-migrate-atomicity.test.mjs
// (a sibling TEST file, permitted reading) ONLY. scripts/domain-doctor.mjs itself
// was NEVER read — H4 denies it by design, so nothing below is anchored to the
// implementation. Every claim this file pins traces to the brief's own words;
// where the brief left a shape ambiguous (see inline notes), the assertion is
// written to be the loosest claim that still falls over under the named
// sabotage, and the ambiguity is disclosed rather than silently resolved.
//
// SCOPE: the migrate journal (a manifest JSON written beside the DESTINATION,
// twice — an intent record with outcome:'in_progress' BEFORE the first
// create(), then the real outcome) and the activity_log eviction disclosure
// (the destination's activity feed is capped at 50 rows; copying N records
// evicts N real ones, and the tool must say so both before and after, and
// preserve the pre-run feed in journal.activity_log.entries_before).
//
// FIXTURES: mkV2 / mk / doctor / breakBody / ids / tmp are copied verbatim from
// domain-doctor-migrate-atomicity.test.mjs (same recipe: an invalid record is a
// REQUIRED FIELD DELETED FROM AN ALREADY-STORED BODY, unreachable through
// create(), so it survives the survey and the field-loss guard and reaches the
// copy loop as a REFUSED record per AC3).
//
// CONTROLS ARE NOT OPTIONAL. J4/J5/A3/A5 exist specifically so a hollow "the
// line always prints" implementation cannot pass silently — each is placed
// first in its pair per the mutation-verification discipline where practical,
// and its own comment says which false-positive shape it forecloses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let DatabaseSync;
test.before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ DatabaseSync } = await import('node:sqlite'));
});

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8', cwd, timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function mk(id, answer) {
  return {
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22',
    capture_date: '2026-06-22',
  };
}

function mkV2(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SterlingStore(path);
  for (const r of records) s.create(r);
  s.close();
  return path;
}

/** Delete a REQUIRED field from a STORED body — see the header note above. */
function breakBody(dbPath, id, field) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT body FROM records WHERE id = ?').get(id);
  const body = JSON.parse(row.body);
  delete body[field];
  db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(body), id);
  db.close();
}

function ids(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id FROM records').all().map((r) => r.id);
  db.close();
  return new Set(rows);
}

/** Insertion-order read of the destination's OWN activity feed, via rowid — a
 *  universal SQLite column, not a guess at a schema-specific ordering column.
 *  record_id and verb ARE confirmed by the brief itself (A1, A4). */
function readActivityLog(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT rowid AS rid, record_id, verb FROM activity_log ORDER BY rid ASC').all();
  db.close();
  return rows;
}

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/** Every migrate journal file sitting beside <to>, by the brief's own naming
 *  shape: `<to>.domain-doctor-migrate-*.json`. Never predicts the ms-timestamp
 *  suffix (per the brief's explicit instruction not to pin exact path/existsSync). */
function journalFiles(toPath) {
  const dir = dirname(toPath);
  const base = basename(toPath);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.domain-doctor-migrate-`) && f.endsWith('.json'))
    .map((f) => join(dir, f));
}

function readSoleJournal(toPath) {
  const files = journalFiles(toPath);
  assert.equal(files.length, 1, `expected exactly one migrate journal beside ${toPath}, found: ${files.join(', ') || '(none)'}`);
  return JSON.parse(readFileSync(files[0], 'utf8'));
}

/** planned's element shape is not given literally by the brief (unlike copied/
 *  refused, which the brief shows literally as bare ids / {id} objects
 *  respectively) — this accepts either a bare id or an {id,...} object so the
 *  assertion binds to "every id is named" without guessing an unverified shape. */
function idsOf(list) {
  return list.map((x) => (typeof x === 'string' ? x : x.id));
}

// ---------------------------------------------------------------------------
// J1 — journal exists + announced
// ---------------------------------------------------------------------------
test('J1: migrate --apply writes exactly one migrate journal beside the destination and announces it on stdout', () => {
  const dir = tmp('doctor-journal-j1-');
  const a = randomUUID();
  const b = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(a, 'first'), mk(b, 'second')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 0, `a clean migrate exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 2/i, 'both records crossed');
  assert.equal(journalFiles(to).length, 1, 'exactly one journal file lands beside the destination');
  assert.match(
    r.out,
    new RegExp(`JOURNAL: [^\\n]*${esc(dirname(to))}`),
    'stdout announces the journal, naming a path beside the destination directory'
  );
});
// SABOTAGE: delete the pre-loop writeMigrateJournal call.

// ---------------------------------------------------------------------------
// J2 — content
// ---------------------------------------------------------------------------
test('J2: the journal names every planned id, every copied id, outcome complete, a schema_version field, and invocation.argv verbatim', () => {
  const dir = tmp('doctor-journal-j2-');
  const a = randomUUID();
  const b = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(a, 'first'), mk(b, 'second')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  const passedArgs = ['migrate', '--from', from, '--to', to, '--apply'];

  const r = doctor(passedArgs, dir);
  assert.equal(r.code, 0, `a clean migrate exits 0: ${oneLine(r.out)}`);

  const journal = readSoleJournal(to);
  assert.deepEqual(idsOf(journal.planned).sort(), [a, b].sort(), 'planned names every id that was to be copied');
  assert.deepEqual([...journal.copied].sort(), [a, b].sort(), 'copied names every id that actually crossed');
  assert.equal(journal.outcome, 'complete', 'a fully clean apply is outcome:complete');

  assert.ok(Object.prototype.hasOwnProperty.call(journal, 'schema_version'), 'journal carries a schema_version field');
  assert.notEqual(journal.schema_version, undefined, 'schema_version is populated, not left undefined');

  assert.ok(journal.invocation && Array.isArray(journal.invocation.argv), 'invocation.argv is an array');
  const argv = journal.invocation.argv;
  const hasSubsequence = (() => {
    outer: for (let i = 0; i + passedArgs.length <= argv.length; i++) {
      for (let j = 0; j < passedArgs.length; j++) if (argv[i + j] !== passedArgs[j]) continue outer;
      return true;
    }
    return false;
  })();
  assert.ok(hasSubsequence, 'invocation.argv carries the exact CLI args verbatim, as a contiguous run');
});
// SABOTAGE: planned: [].

// ---------------------------------------------------------------------------
// J3 — intent-before-write
// ---------------------------------------------------------------------------
test(
  'J3: when the destination directory cannot be written, the journal-write failure is caught BEFORE any record crosses',
  { skip: process.platform === 'win32' ? 'chmod-based deny-write is not portable to native Windows; parity note per brief' : false },
  () => {
    const dir = tmp('doctor-journal-j3-');
    const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'stranded')]);
    const toDir = join(dir, 'to');
    const to = mkV2(join(toDir, 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
    const before = ids(to);

    chmodSync(toDir, 0o555);
    try {
      const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

      assert.equal(r.code, 2, `an unwritable destination directory refuses, exit 2: ${oneLine(r.out)}`);
      assert.match(r.out, /journal/i, 'the failure message names the journal (this is what the write that failed was for)');
      assert.match(r.out, new RegExp(esc(dirname(to))), 'the message names the destination-side location, not a generic error');
      assert.deepEqual([...ids(to)].sort(), [...before].sort(), 'the destination record count is unchanged — nothing was created');
    } finally {
      chmodSync(toDir, 0o755);
    }
  }
);
// SABOTAGE: move the journal write below the copy loop.
// (Not pinning existsSync(journalPath) per the brief's explicit instruction —
// the ms-timestamp suffix makes the exact filename unreachable to predict.)

// ---------------------------------------------------------------------------
// J4 — CONTROL: no-op leaves no journal
// ---------------------------------------------------------------------------
test('J4 CONTROL: apply against a destination that already holds every source record writes NO journal', () => {
  const dir = tmp('doctor-journal-j4-');
  const shared = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(shared, 'same answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(shared, 'same answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 0, `a true no-op exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 0/i, 'nothing crossed — identical body is an idempotent skip (AC21)');
  assert.equal(journalFiles(to).length, 0, 'no journal file is written when there is nothing to migrate');
});
// SABOTAGE: remove the `!missing.length` early return.

// ---------------------------------------------------------------------------
// J5 — CONTROL: dry-run journals nothing
// ---------------------------------------------------------------------------
test('J5 CONTROL: a dry-run (no --apply) with real missing records still writes NO journal', () => {
  const dir = tmp('doctor-journal-j5-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'stranded')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);

  assert.equal(r.code, 0, `a clean dry-run exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /DRY-RUN/, 'still the ordinary dry-run report');
  assert.equal(journalFiles(to).length, 0, 'a plan writes no journal — only --apply does');
});
// SABOTAGE: hoist the journal write above `if (!apply)`.

// ---------------------------------------------------------------------------
// J6 — partial + control
// ---------------------------------------------------------------------------
test('J6: one invalid record among two valid ones journals outcome partial, copied names the good id, refused[0].id names the bad one', () => {
  const dir = tmp('doctor-journal-j6a-');
  const good = randomUUID();
  const bad = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(good, 'ok'), mk(bad, 'doomed')]);
  breakBody(from, bad, 'answer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 3, `a per-record rejection is exit 3: ${oneLine(r.out)}`);
  const journal = readSoleJournal(to);
  assert.equal(journal.outcome, 'partial', 'one good + one bad, with the good one committed, is outcome:partial');
  assert.deepEqual(journal.copied, [good], 'copied names only the id that actually crossed');
  assert.equal(journal.refused[0].id, bad, 'refused[0].id names the record that was rejected');
});
// SABOTAGE: hardcode 'complete'.

test('J6 CONTROL: when every planned record is invalid, the journal says outcome nothing_written and copied is empty', () => {
  const dir = tmp('doctor-journal-j6b-');
  const bad = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(bad, 'doomed')]);
  breakBody(from, bad, 'answer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 3, `a per-record rejection is still exit 3 when it is the only record: ${oneLine(r.out)}`);
  const journal = readSoleJournal(to);
  assert.equal(journal.outcome, 'nothing_written', 'nothing committed is outcome:nothing_written, never partial');
  assert.deepEqual(journal.copied, [], 'copied is empty when nothing crossed');
});
// SABOTAGE (shared with J6): hardcode 'complete' — this control catches the
// hardcode from the OTHER direction, the same asymmetry the atomicity suite's
// analogous control documents (a gate on refused.length alone cannot tell
// partial from nothing-written; this control is what would go green under
// such a gate and is exactly why it must stay paired with the arm above).

// ---------------------------------------------------------------------------
// A1 — eviction is real
// ---------------------------------------------------------------------------
test('A1: migrating into a full activity feed discloses the eviction in the plan, past-tense on apply, and really evicts the oldest rows', () => {
  const dir = tmp('doctor-journal-a1-');
  const seed = Array.from({ length: 55 }, (_, i) => mk(randomUUID(), `seed-${i}`));
  const to = mkV2(join(dir, 'to', 'sterling.db'), seed);
  const newIds = [randomUUID(), randomUUID(), randomUUID()];
  const from = mkV2(join(dir, 'from', 'sterling.db'), newIds.map((id, i) => mk(id, `new-${i}`)));

  const preRun = readActivityLog(to);
  assert.equal(preRun.length, 50, 'the destination activity feed is already at the 50 cap from seeding');
  const oldest3 = preRun.slice(0, 3).map((row) => row.record_id);

  const plan = doctor(['migrate', '--from', from, '--to', to], dir);
  assert.equal(plan.code, 0, `a clean dry-run exits 0: ${oneLine(plan.out)}`);
  // UPDATED per coordinator 2026-08-29: the lane re-worded this line after a
  // review finding — pin the LOAD-BEARING parts (the FORECAST prefix, the
  // three numbers, and the "prediction not measurement" caveat), never the
  // whole sentence, so the next re-word does not break this for no reason.
  assert.match(plan.out, /ACTIVITY LOG \(FORECAST\)/, 'the plan-side disclosure is explicitly labeled a forecast');
  assert.match(plan.out, /\b50\b[\s\S]*\b3\b[\s\S]*EVICTED[\s\S]*\(47 surviving\)/, 'the forecast names the three load-bearing numbers: 50 held, 3 evicted, 47 surviving');
  assert.match(
    plan.out,
    /prediction, not a measurement/i,
    'the plan explicitly disclaims certainty — a concurrent writer can change what actually gets evicted'
  );

  const apply = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(apply.code, 0, `a clean apply exits 0: ${oneLine(apply.out)}`);
  assert.match(apply.stdout, /MIGRATED: 3/i, 'all three crossed');
  // CORRECTED per coordinator 2026-08-29, quoting source verbatim
  // (domain-doctor.mjs ~:1104-1110): the apply line is NOT the forecast line
  // re-tensed — it has its own wording, its own number order (evicted THEN
  // held-before, the reverse of the forecast's held-then-evicted), and
  // neither the word EVICTED nor a "(N surviving)" parenthetical, both of
  // which exist ONLY on the forecast side. Pin what is actually there.
  assert.match(apply.out, /ACTIVITY LOG:/, 'apply carries its own measured-disclosure prefix');
  assert.doesNotMatch(apply.out, /ACTIVITY LOG \(FORECAST\)/, 'apply must not restate the forecast label — it re-reads and reports what actually happened');
  assert.match(apply.out, /measured by re-reading the table/i, 'this is the distinguishing phrase between forecast and measurement, and carries the verdict');
  assert.match(apply.out, /\b3\b[\s\S]*\b50\b/, 'apply names the two numbers in their real order: evicted (3) before rows-held-before (50)');
  assert.match(apply.out, /GONE from it now/, 'apply states plainly that the evicted rows are gone');

  const postRun = readActivityLog(to);
  assert.equal(postRun.length, 50, 'the feed stays capped at 50 after the migrate');
  const postIds = new Set(postRun.map((row) => row.record_id));
  for (const evictedId of oldest3) assert.ok(!postIds.has(evictedId), `pre-run oldest entry ${evictedId} was evicted`);
  for (const newId of newIds) {
    const row = postRun.find((r) => r.record_id === newId);
    assert.ok(row, `copied id ${newId} appears in the activity feed`);
    assert.equal(row.verb, 'created', `copied id ${newId} is logged with verb:created`);
  }
});
// SABOTAGE: ACTIVITY_LOG_CAP = 500.

// ---------------------------------------------------------------------------
// A2 — feed preserved
// ---------------------------------------------------------------------------
test('A2: the journal preserves the pre-run activity feed verbatim in entries_before, with evicted/survivors/cap', () => {
  const dir = tmp('doctor-journal-a2-');
  const seed = Array.from({ length: 55 }, (_, i) => mk(randomUUID(), `seed-${i}`));
  const to = mkV2(join(dir, 'to', 'sterling.db'), seed);
  const newIds = [randomUUID(), randomUUID(), randomUUID()];
  const from = mkV2(join(dir, 'from', 'sterling.db'), newIds.map((id, i) => mk(id, `new-${i}`)));
  const preRun = readActivityLog(to);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, `a clean apply exits 0: ${oneLine(r.out)}`);

  const journal = readSoleJournal(to);
  assert.equal(journal.activity_log.entries_before.length, 50, 'entries_before carries all 50 pre-run rows verbatim');
  assert.equal(journal.activity_log.entries_before.length, preRun.length, 'matches the measured pre-run row count exactly');
  assert.equal(journal.activity_log.evicted, 3, 'evicted count is recorded');
  assert.equal(journal.activity_log.survivors, 47, 'survivors count is recorded');
  assert.equal(journal.activity_log.cap, 50, 'the cap itself is recorded');
});
// SABOTAGE: drop entries_before.

// ---------------------------------------------------------------------------
// A3 — CONTROL: no loss, no noise
// ---------------------------------------------------------------------------
test('A3 CONTROL: a migrate that evicts nothing prints no ACTIVITY LOG line in either mode, but still writes a journal on apply', () => {
  const dir = tmp('doctor-journal-a3-');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'the only stranded record')]);

  const plan = doctor(['migrate', '--from', from, '--to', to], dir);
  assert.equal(plan.code, 0, `a clean dry-run exits 0: ${oneLine(plan.out)}`);
  assert.doesNotMatch(plan.out, /ACTIVITY LOG/i, 'no eviction, so the plan carries no activity-log disclosure');
  assert.equal(journalFiles(to).length, 0, 'a plan still writes no journal (J5)');

  const apply = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(apply.code, 0, `a clean apply exits 0: ${oneLine(apply.out)}`);
  assert.doesNotMatch(apply.out, /ACTIVITY LOG/i, 'no eviction, so apply carries no activity-log disclosure either');
  assert.equal(journalFiles(to).length, 1, 'apply still writes exactly one journal, disclosure or not');
});
// SABOTAGE: ungate the disclosure (print it unconditionally).

// ---------------------------------------------------------------------------
// A4 — unreadable != clean
// ---------------------------------------------------------------------------
// RE-SHAPED per coordinator 2026-08-29: the original brief's "migrate still
// succeeds" half was WRONG for this fixture. `ALTER TABLE activity_log RENAME
// COLUMN record_id TO gone` doesn't merely make the log unreadable for
// FORECASTING purposes — it also breaks `logActivity`, which runs INSIDE
// create()'s own transaction, so every record is REFUSED and the migrate
// genuinely writes nothing (exit 3, MIGRATED: 0). That is correct, fail-loud
// behavior, not a bug to route around with a different fixture the brief
// couldn't justify — so this arm now pins what actually happens: the
// unreadable-log disclosure fires and says the eviction is NOT KNOWN (never a
// clean "nothing to lose"), the journal still records readable:false with an
// empty entries_before, and the run refuses loudly with nothing written.
test('A4: an unreadable activity_log is disclosed as NOT KNOWN (never a clean "nothing to lose"), and here the same corruption also breaks the write path, so migrate refuses loudly with nothing written', () => {
  const dir = tmp('doctor-journal-a4-');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  const before = ids(to);
  {
    const db = new DatabaseSync(to);
    db.exec('ALTER TABLE activity_log RENAME COLUMN record_id TO gone');
    db.close();
  }
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'stranded')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  // (c) the run refuses LOUDLY — exit 3, nothing written, destination unchanged.
  assert.equal(r.code, 3, `the broken column also breaks the write path, so this refuses per-record: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 0/i, 'nothing crossed — the write path is broken by the same corruption');
  assert.match(r.out, /nothing was written/i, 'the plain no-write outcome is stated, same wording as every other nothing-written path');
  assert.deepEqual([...ids(to)].sort(), [...before].sort(), 'the destination is genuinely unchanged');

  // (a) the unreadable-log disclosure fires and says NOT KNOWN — never "nothing to lose".
  assert.match(r.out, /ACTIVITY LOG:/, 'the unreadable-log disclosure uses its own prefix, distinct from the FORECAST label');
  assert.match(r.out, /could NOT be read/i, 'the disclosure names that the read itself failed');
  assert.match(r.out, /NOT KNOWN/, 'the disclosure says the eviction is NOT KNOWN, never assumed clean');
  assert.doesNotMatch(r.out, /nothing to lose/i, 'an unreadable log must never be reported as having nothing to lose');

  // (b) the journal still records readable:false with an empty entries_before.
  const journal = readSoleJournal(to);
  assert.equal(journal.activity_log.readable, false, 'journal records readable:false');
  assert.deepEqual(journal.activity_log.entries_before, [], 'entries_before is empty when the feed could not be read, never fabricated');
});
// SABOTAGE: swallow the catch and return readable:true. (This alone should
// also flip the write-path refusal, since the same underlying schema
// corruption drives both — if a future implementation decoupled the two, the
// readable:true sabotage would need pairing with a change that also silences
// the REFUSED/nothing-written path; that coupling is exactly what this arm
// exists to keep honest.)

// ---------------------------------------------------------------------------
// A5 — CONTROL: table absent
// ---------------------------------------------------------------------------
test('A5 CONTROL: a destination with no activity_log table at all migrates normally, with no ACTIVITY LOG line, and journal table_present:false', () => {
  const dir = tmp('doctor-journal-a5-');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  {
    const db = new DatabaseSync(to);
    db.exec('DROP TABLE activity_log');
    db.close();
  }
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(randomUUID(), 'stranded')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 0, `a migrate with no activity_log table to inspect still succeeds: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 1/i, 'the copy still happens');
  assert.doesNotMatch(r.out, /ACTIVITY LOG/i, 'an absent table is not the same disclosure shape as an unreadable one — no line at all');

  const journal = readSoleJournal(to);
  assert.equal(journal.activity_log.table_present, false, 'journal records table_present:false, distinct from readable:false');
});
// SABOTAGE: swallow the catch and return readable:true (the same catch-all
// would also need to distinguish "table absent" from "table present but
// unreadable" — if A4's sabotage collapses both into readable:true, this arm
// goes red too on table_present, which is the point of pairing them).
