// AUTHORED BY A CODER LANE, PLACED BY THE CONDUCTOR: H5 freezes test paths against
// pipeline agents, so this file was developed outside the repo and landed here by
// the conductor. It IS the repo file now — `root` derives from this file's own
// location, and the new copied===0 control below was verified green after placement.
//
// domain-doctor migrate ATOMICITY-DISCLOSURE tests (board b96ebf47, hazard 4)
// — a SIBLING to domain-doctor-v2-guard.test.mjs and
// domain-doctor-field-loss.test.mjs, pinning the ONE thing migrate can honestly
// say about its own non-atomicity.
//
// THE DEFECT, re-verified at HEAD 0e01c42: migrate --apply copies through
// `dest.create()` per record (scripts/domain-doctor.mjs, the copy loop), and
// each create() commits its OWN transaction, so a record the validated write
// path rejects mid-batch leaves the destination PARTIALLY migrated: the earlier
// copies are committed for good.
//
// ALL-OR-NOTHING IS NOT IMPOSSIBLE — IT IS DECLINED. An earlier version of this
// header claimed a batch rollback was unreachable from a script because
// SterlingStore's connection is `private`. That was FALSE and is corrected here,
// because a comment asserting a limitation the code does not have is exactly how
// a real hazard gets closed as "loudness only" and never revisited:
// `withTransaction<T>()` is PUBLIC (packages/store/src/index.ts:2794) and the
// transaction is REENTRANT (:2728-2736, :881), so
// `dest.withTransaction(() => { for (const r of missing) dest.create(r); })`
// would have nested create() calls join one outer transaction and give exactly
// the atomicity that text called unbuildable.
//
// IT IS DECLINED ON POLICY (user-ruled 2026-08-27): all-or-nothing contradicts
// AC3 of the `domain-doctor` article, where a schema-invalid record is REPORTED
// AND SKIPPED with exit 3. Skip-and-continue is deliberate — one bad record must
// not block a whole migration, and the resume path is wanted. So the partial
// state below is a designed outcome whose only debt is DISCLOSURE.
//
// That state was reported as `MIGRATED: 2` + `REFUSED: <id> — <reason>` and exit
// 3 — counts, and nothing about the STATE OF THE OPERATOR'S STORE. Every other
// refusal in this tool ends "Nothing was written", so the one path where
// something WAS written is the one path that never said so. On a data-migration
// path that is a loudness defect (P5), not a design choice: the operator cannot
// tell from the output whether their two stores are still split, whether the
// copies survived, or what the resume path is.
//
// WHAT IS FIXED HERE AND WHAT IS NOT. The disclosure is fixed. The
// skip-and-continue semantics are NOT changed, and are not a gap to close:
// per-record skipping is AC3, and a batch transaction (withTransaction,
// index.ts:2794) is the route if and only if that POLICY is ever revisited —
// which is a decision, not a repair. This suite pins the truthful report. Over a
// future transactional importer the partial-state pin becomes unreachable and
// must be retired deliberately, not left to rot.
//
// BOTH DIRECTIONS ARE PINNED, and the controls come first. A pin that only
// asserts the warning APPEARS is satisfied by printing it unconditionally —
// which would be a worse tool, crying partial-write over every clean migrate.
// So each arm has a control that must pass FOR THE OPPOSITE REASON: a clean
// migrate must NOT mention a partial write; a single-record plan must NOT warn
// about a mid-batch split (one record commits in one transaction — there is no
// partial state to have); and an apply in which EVERY planned record was
// rejected must NOT claim a partial write either, because nothing was committed
// — the partial disclosure is about a WRITE having happened, not about a
// refusal having happened.
//
// FIXTURE NOTE: the schema-invalid record is made by deleting a REQUIRED field
// from an already-stored body — unreachable through create(), which is the whole
// point, and the same in-place edit shape domain-doctor-field-loss.test.mjs
// uses. It survives the survey (which only JSON.parses bodies) and the
// field-loss guard (which skips a body its validator rejects, deliberately,
// leaving it to the copy loop to report as REFUSED per AC3).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
let DatabaseSync;
before(async () => {
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

/** Delete a REQUIRED field from a STORED body — see the fixture note above. */
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
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('CONTROL: a CLEAN migrate --apply never cries partial write — exit 0, every record crosses, and the output says nothing about a partial or non-atomic run', () => {
  const dir = tmp('doctor-atomicity-control-');
  const a = randomUUID();
  const b = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(a, 'first stranded'), mk(b, 'second stranded')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 0, `a clean migrate exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 2/i, 'both records crossed');
  assert.doesNotMatch(r.out, /REFUSED:/, 'no record was rejected');
  assert.doesNotMatch(r.out, /PARTIALLY MIGRATED/i, 'a clean run must not claim a partial write');
  assert.doesNotMatch(r.out, /NOT ATOMIC/i, 'the mid-batch-split warning belongs to the plan and the partial outcome, not a completed clean apply');
  const after = ids(to);
  assert.ok(after.has(a) && after.has(b), 'both ids are really in the destination');
});

test('a record the validated write path rejects MID-BATCH leaves the destination PARTIALLY MIGRATED, and migrate says so — counts, no rollback, and the resume path', () => {
  const dir = tmp('doctor-atomicity-partial-');
  const first = randomUUID();
  const broken = randomUUID();
  const last = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [
    mk(first, 'first stranded'), mk(broken, 'doomed'), mk(last, 'last stranded'),
  ]);
  breakBody(from, broken, 'answer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 3, `a per-record rejection is exit 3, not 0 and not a whole-run refusal: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 2/i, 'the two valid records did cross');
  assert.match(r.out, new RegExp(`REFUSED: ${broken}`), 'the rejected record is named');

  // THE PIN: the state of the operator's store, in words, not just counts.
  assert.match(r.out, /PARTIALLY MIGRATED/i, 'the one path that DID write must say that it wrote');
  // THE PHRASE, NOT A PROXIMITY OF DIGITS. This assertion used to be
  // /\b2\b[\s\S]{0,80}\b3\b/ over the whole combined output, which any
  // incidental digit pair satisfies and which reads "3 of the 2 planned" as
  // happily as "2 of the 3 planned" — it pinned no committed-vs-planned
  // semantics at all. Bind the sentence that carries the meaning.
  assert.match(
    r.out,
    /2 of the 3 planned record\(s\) are now COMMITTED/,
    'the disclosure names how many of the PLANNED records are COMMITTED, in that order'
  );
  assert.match(r.out, /not atomic/i, 'it names WHY a partial state is possible at all');
  assert.match(r.out, /rolled back|rollback/i, 'it says the committed copies were NOT undone');
  assert.match(r.out, /re-run/i, 'it names the resume path');
  assert.match(r.out, new RegExp(to.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'it names WHICH store is now partial');

  // The disclosure must be TRUE, not just present.
  const after = ids(to);
  assert.ok(after.has(first) && after.has(last), 'the two valid records are committed in the destination');
  assert.ok(!after.has(broken), 'the rejected record did not land');
});

test('CONTROL: when EVERY planned record is rejected, nothing was committed — migrate must say NOTHING WAS WRITTEN and must NOT claim a partial write, still exit 3', () => {
  // THE CONTROL THAT WAS MISSING, and whose absence let the partial disclosure
  // ship gated on `refused.length` alone. It passes for the OPPOSITE REASON
  // from the partial-write pin above: there, a write happened and the tool must
  // admit it; here, NO write happened and the one line in this tool that means
  // "your store changed" must therefore be absent. Note the asymmetry that
  // proves the old gate wrong: the dry-run plan already gates its mid-batch
  // warning on `missing.length > 1`, precisely because a single copy cannot
  // half-succeed.
  const dir = tmp('doctor-atomicity-none-');
  const broken = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(broken, 'doomed')]);
  breakBody(from, broken, 'answer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  const beforeIds = ids(to);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 3, `a per-record rejection is still exit 3 when it is the only record: ${oneLine(r.out)}`);
  assert.match(r.stdout, /MIGRATED: 0/i, 'no record crossed');
  assert.match(r.out, new RegExp(`REFUSED: ${broken}`), 'the rejected record is still named');

  // The partial-write language must be ABSENT — nothing was partially anything.
  assert.doesNotMatch(r.out, /PARTIALLY MIGRATED/i, 'nothing was committed, so nothing was partially migrated');
  assert.doesNotMatch(r.out, /are now COMMITTED/i, 'no committed-record count may be claimed when the count is zero');
  assert.doesNotMatch(r.out, /rolled back|rollback/i, 'there is nothing to have not-rolled-back');
  // And the plain outcome must be PRESENT, in the same words every other
  // no-write path in this tool uses.
  assert.match(r.out, /nothing was written/i, 'it says plainly that the destination is unchanged');
  assert.match(r.out, /re-run/i, 'it still names the resume path');

  // And the claim must be TRUE: the destination is untouched.
  assert.deepEqual(
    [...ids(to)].sort(), [...beforeIds].sort(),
    'the destination id set is unchanged, which is what makes the nothing-written wording honest'
  );
});

test('CONTROL: a single-record plan does NOT warn about a mid-batch split — one record commits in one transaction, so there is no partial state to warn about', () => {
  const dir = tmp('doctor-atomicity-dry-one-');
  const only = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(only, 'the only stranded record')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);

  assert.equal(r.code, 0, `a clean dry-run exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /DRY-RUN/, 'still the ordinary dry-run report');
  assert.doesNotMatch(r.out, /NOT ATOMIC/i, 'a one-record copy cannot half-succeed, so warning about it would be noise');
});

test('a MULTI-record plan discloses the non-atomicity BEFORE --apply is authorized, so the plan never reads as all-or-nothing', () => {
  const dir = tmp('doctor-atomicity-dry-many-');
  const from = mkV2(join(dir, 'from', 'sterling.db'), [
    mk(randomUUID(), 'first stranded'), mk(randomUUID(), 'second stranded'),
  ]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);

  assert.equal(r.code, 0, `a clean dry-run exits 0: ${oneLine(r.out)}`);
  assert.match(r.stdout, /DRY-RUN/, 'still the ordinary dry-run report');
  assert.match(r.out, /NOT ATOMIC/i, 'the plan states that --apply is not all-or-nothing');
  assert.match(r.out, /partial/i, 'and names the outcome an operator would otherwise not expect');
  assert.doesNotMatch(r.out, /MIGRATED:/, 'a dry-run still writes nothing');
});
