// domain-doctor field-loss tests (board bd3f0acf) — a SIBLING to
// domain-doctor-v2-guard.test.mjs, pinning the FIELD-LEVEL leg of migrate's
// containment argument.
//
// THE DEFECT, found by an outside-family Codex review 2026-08-26: migrate's
// copy path is `dest.create(rawSourceBody)`, which validates through
// validateRecord -> zod `.parse()`, and a zod object STRIPS unknown keys AT
// EVERY LEVEL. A source record carrying a legacy or hand-added field — with no
// record_versions / record_aliases / record_relations rows to trip any existing
// containment guard — migrated "successfully" (MIGRATED: 1, exit 0) and the
// destination silently lacked that field. No refusal, no warning, no trace.
//
// TWO LOSS CLASSES, TWO PINS. The first implementation of the guard enumerated
// unknown FIELDS via unknownFieldsIn(), which filters Object.keys(candidate) —
// TOP LEVEL ONLY. A review caught that `files: [{path, role, note}]` carries no
// unknown top-level key and lost `note` exactly as before. AC22 pins the
// top-level class; AC22-NESTED pins the nested one, and it is MUTATION-VERIFIED
// as the ONLY test that goes red when the implementation is reverted to a
// top-level check — which is the proof it is not redundant with AC22.
//
// WHY THE FALSE-DENY ARMS ARE THE MOST IMPORTANT TESTS HERE. The shipped guard
// simulates the parse and compares KEY-PATH PRESENCE IN ONE DIRECTION ONLY
// (source ⊆ round-trip). A full round-trip EQUALITY check was measured and
// rejected: it refuses 7 of the 9 tests below, INCLUDING the clean-source
// control, because parsing legitimately changes a body three ways that are not
// loss —
//   * DEFAULTS ADD keys: research_finding.source_urls .default([]) at
//     packages/schemas/src/records.ts:174; anti_pattern.basis :155 and
//     reference_material.basis :214, both .default('codebase');
//   * repoPath REWRITES values: every file_keys[] entry and files[].path runs
//     through normalizeRepoPath (packages/schemas/src/paths.ts:33), so
//     'docs\spec.md' and './docs/spec.md' come back canonicalized — the path
//     invariant working, not damage;
//   * normalizeIdentityEnvelope re-adds status/superseded_by, which a stored v2
//     body does not carry (storableBody strips them into columns).
// A false-denying doctor is worse than the gap it closes, so the two
// AC22-FALSE-DENY tests are the arms that hold the comparison to the loss
// question. Both are GREEN under key-containment and RED under deepEqual.
//
// KNOWN AND ACCEPTED BOUND, pinned rather than left implicit: the guard reports
// dropped KEYS, never rewritten VALUES. The repoPath arm's final assertion
// documents that the destination legitimately receives the NORMALIZED paths.
//
// FIXTURE NOTES. (1) Every mutation below is unreachable through create() —
// stripping and defaulting are what these tests pin — so bodies are edited in
// place, which is the shape a legacy or hand-edited store presents.
// `records.body` / `records.id` are the only column names this file treats as
// literal fact (same restraint as the v2-guard suite). (2) The nested pin uses
// `decision.alternatives_rejected[]` and NOT the envelope's `links[]`: create()
// mints a record_relations row per body link, which would trip the AC20
// relations refusal first and the test would pass for the wrong reason.
// (3) oneLine() flattens any child-process stream before it lands in an
// assertion's own MESSAGE (anti_pattern ee89c3fd), never in its TARGET.
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
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function mk(id, answer, extra = {}) {
  return {
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22',
    capture_date: '2026-06-22', ...extra,
  };
}

function mkDecision(id, extra = {}) {
  return {
    id, type: 'decision', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], title: `t-${id}`, statement: 'the statement',
    alternatives_rejected: [{ option: 'the other way', reason: 'slower' }], rationale: 'because', ...extra,
  };
}

function mkV2(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const s = new SterlingStore(path);
  for (const r of records) s.create(r);
  s.close();
  return path;
}

/** Rewrite a STORED body — see fixture note (1) in the header. */
function editBody(dbPath, id, mutate) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT body FROM records WHERE id = ?').get(id);
  const body = JSON.parse(row.body);
  mutate(body);
  db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(body), id);
  db.close();
}
const addStrayField = (dbPath, id, field, value) => editBody(dbPath, id, (b) => { b[field] = value; });

function bodyOf(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT body FROM records WHERE id = ?').get(id);
  db.close();
  return row ? JSON.parse(row.body) : undefined;
}
function recordCount(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) AS c FROM records').get().c;
  db.close();
  return n;
}
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('AC22: migrate --apply REFUSES a record whose body carries a field its type does not define, naming the id and the field, with nothing written', () => {
  const dir = tmp('doctor-fieldloss-a-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  addStrayField(from, strandedId, 'legacy_provenance_note', 'captured by the 2025 importer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const beforeCount = recordCount(to);
  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);

  assert.equal(r.code, 2, `refusal is exit 2, not a silent success: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, new RegExp(strandedId), 'the refusal NAMES the record it would have damaged');
  assert.match(out, /legacy_provenance_note/, 'the refusal NAMES the field that would have been dropped');
  assert.doesNotMatch(out, /MIGRATED:/, 'the guard fired BEFORE the copy loop, not after a partial write');
  assert.doesNotMatch(out, /REFUSED:/, 'this is a whole-run refusal, not a per-record create-storm');
  assert.equal(recordCount(to), beforeCount, 'nothing was written to the destination');
  assert.equal(bodyOf(to, strandedId), undefined, 'the lossy copy never landed');
});

test('AC22-NESTED: a stray field buried INSIDE an array-of-objects is refused too, named by its full key path — zod strips at every level, so a top-level-only guard is not the concern', () => {
  const dir = tmp('doctor-fieldloss-nested-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mkDecision(strandedId)]);
  editBody(from, strandedId, (b) => { b.alternatives_rejected[0].note = 'why we really rejected it'; });
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 2, `nested loss refuses just like top-level loss: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, new RegExp(strandedId), 'names the record');
  assert.match(
    out, /alternatives_rejected\[0\]\.note/,
    'and names the FULL KEY PATH — a bare field name at depth would not tell an operator which record part is going'
  );
  assert.doesNotMatch(out, /MIGRATED:/, 'refused before any write');
  assert.equal(bodyOf(to, strandedId), undefined, 'nothing landed');
});

test('AC22: the same refusal fires in DRY-RUN, so the plan can never promise a migrate that --apply would refuse', () => {
  const dir = tmp('doctor-fieldloss-b-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  addStrayField(from, strandedId, 'legacy_provenance_note', 'captured by the 2025 importer');
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  assert.equal(r.code, 2, `dry-run refuses too: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /LOSE field/, 'and for the field-loss reason');
  assert.doesNotMatch(r.stdout, /DRY-RUN/, 'it never reaches the clean-plan report');
});

test('AC22-CONTROL: a source whose records carry ONLY defined fields still migrates — the guard is not refuse-everything', () => {
  const dir = tmp('doctor-fieldloss-ctl-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const dry = doctor(['migrate', '--from', from, '--to', to], dir);
  assert.equal(dry.code, 0, `clean source plans cleanly: ${oneLine(dry.stderr)}`);
  assert.match(dry.stdout, /DRY-RUN/);
  assert.match(dry.stdout, new RegExp(strandedId), 'and plans to copy the missing record');

  const applied = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(applied.code, 0, `and applies: ${oneLine(applied.stderr)}`);
  assert.match(applied.stdout, /MIGRATED: 1/i);
  assert.equal(bodyOf(to, strandedId).answer, 'stranded answer');
});

// --- FALSE-DENY ARMS: green under key-containment, RED under deepEqual -------

test('AC22-FALSE-DENY: a legacy body MISSING a field the schema DEFAULTS (research_finding.source_urls) still migrates — a default ADDS a key, and an addition is not loss', () => {
  const dir = tmp('doctor-fieldloss-default-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  editBody(from, strandedId, (b) => { delete b.source_urls; });
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);
  assert.equal(bodyOf(from, strandedId).source_urls, undefined, 'fixture really lacks the defaulted field');

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, `a defaulted-in field must NOT read as loss: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  assert.match(r.stdout, /MIGRATED: 1/i);
  assert.deepEqual(bodyOf(to, strandedId).source_urls, [], 'and the default is what lands');
});

test('AC22-FALSE-DENY: a body whose paths are not yet NORMALIZED (repoPath rewrites them) still migrates — a rewritten value is the path invariant working, not damage', () => {
  const dir = tmp('doctor-fieldloss-normalize-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mkDecision(strandedId, { file_keys: ['scripts/a.mjs'] })]);
  editBody(from, strandedId, (b) => { b.file_keys = ['./scripts/a.mjs', 'docs\\spec.md']; });
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, `a normalization must NOT read as loss: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  assert.match(r.stdout, /MIGRATED: 1/i);
  assert.deepEqual(
    bodyOf(to, strandedId).file_keys, ['scripts/a.mjs', 'docs/spec.md'],
    'and the normalized form is what lands — every key survived, only the values were canonicalized'
  );
});

test("AC22-CONTROL: a stray field on a DESTINATION-ONLY record is not this guard's business — only the records actually being copied are checked", () => {
  const dir = tmp('doctor-fieldloss-scope-');
  const strandedId = randomUUID();
  const destOnlyId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(destOnlyId, 'destination answer')]);
  addStrayField(to, destOnlyId, 'legacy_provenance_note', 'never crosses - it is already home');

  const applied = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(applied.code, 0, `an untouched destination record does not block the migrate: ${oneLine(applied.stderr)}`);
  assert.match(applied.stdout, /MIGRATED: 1/i);
  assert.equal(
    bodyOf(to, destOnlyId).legacy_provenance_note, 'never crosses - it is already home',
    'and the destination record keeps its own field, untouched'
  );
});

test('AC22-CONTROL: a source record ALREADY PRESENT in the destination (identical body, stray field on both sides) is an idempotent skip, not a refusal', () => {
  const dir = tmp('doctor-fieldloss-skip-');
  const sharedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(sharedId, 'shared answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(sharedId, 'shared answer')]);
  addStrayField(from, sharedId, 'legacy_provenance_note', 'same on both sides');
  addStrayField(to, sharedId, 'legacy_provenance_note', 'same on both sides');

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  assert.equal(r.code, 0, `nothing to copy means nothing to lose: ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
  assert.match(r.stdout, /skipped 1/i);
  assert.match(r.stdout, /MIGRATED: 0/i);
});

test("AC22-PLAN: the copy plan prints each record's real lifecycle status from the COLUMN, never the literal 'undefined' a v2 body yields", () => {
  const dir = tmp('doctor-fieldloss-plan-');
  const strandedId = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(strandedId, 'stranded answer')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), [mk(randomUUID(), 'destination answer')]);

  const dry = doctor(['migrate', '--from', from, '--to', to], dir);
  assert.equal(dry.code, 0, oneLine(dry.stderr));
  assert.match(dry.stdout, new RegExp(`copy: ${strandedId} \\(research_finding, active,`), 'the plan line carries the real status');
  assert.doesNotMatch(dry.stdout, /undefined/, 'and never the literal undefined — status is column-resident, stripped from every v2 body');
});
