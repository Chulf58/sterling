// domain-doctor escape-hatch honesty tests — a SIBLING to
// domain-doctor-v2-guard.test.mjs and domain-doctor-field-loss.test.mjs,
// pinning ONE property across every migrate containment refusal:
//
//   A REFUSAL MAY NOT NAME A REMEDY THAT CANNOT BE PERFORMED WITHOUT SAYING SO.
//
// THE DEFECT, recorded by the governing decision itself
// ([migrate-relations-containment-narrows-migrate-to-unlinked-stores],
// 88f3db69) as "ESCAPE-HATCH SITUATION — A REAL, COSMETIC DEFECT": migrate's
// containment guards point the operator at `adopt`, which is the conceptually
// right destination (whole-file adoption carries record_versions,
// record_aliases and record_relations intact, per 8e3848ad part 2) — but
// `adopt` is a READ-ONLY probe with no apply path (scripts/domain-doctor.mjs
// :66, :970-977; its write half was removed after review and is boarded at
// 44434103). So the message names the right CONCEPT without naming an OPERABLE
// ROUTE: a user who follows it arrives at a mode that cannot write. That
// decision names "fixing the wording" as one of the two moves that close it,
// and landing the adopt write half — the other move — is deliberately NOT
// being built (board 44434103 is explicitly stopped).
//
// WHY THIS IS A REAL PIN AND NOT A STYLE TEST. These messages are the entire
// user-facing output of a fail-closed repair tool, read by an operator
// mid-incident who has just been refused a migration of a knowledge store.
// "Use 'adopt'" sends them to a mode that will refuse them again with no
// explanation of why the tool suggested it. P5 is fail LOUD, and a refusal that
// overstates the available remedy is not loud, it is misleading.
//
// THE DIVERGENCE IS THE EVIDENCE. Measured at HEAD before this change: FOUR
// containment refusals name adopt, and exactly ONE of them (record_relations,
// added with the guard the decision was written about) carries the honest
// disclosure. Its three older siblings — record_versions, record_aliases and
// retired-lifecycle — still ended with the bare "Use 'adopt' (whole-file,
// provenance intact). Nothing was written." That is one guard telling the truth
// and three not, which is precisely how a message set drifts, and is why the
// implementation carries ONE shared constant rather than four copies.
//
// THE RELATIONS ARM IS A CONTROL, NOT A DUPLICATE. It was already honest before
// this change, so it must be GREEN BOTH BEFORE AND AFTER: it proves the
// assertion shape matches the wording the decision already ratified, rather
// than matching some new phrasing invented here. The clean-migrate arm is the
// second control — the disclosure must never leak into the SUCCESS path, which
// is what would happen if the text were appended somewhere central by mistake.
//
// FIXTURE NOTES. (1) Provenance DDL is HARDCODED, never introspected — the same
// discipline (and the same composite-PK trap, anti_pattern 0059fa66) as the
// v2-guard suite, whose header documents these three shapes:
//     record_versions(record_id, version, archived_at, body) PK(record_id,version)
//     record_aliases(historical_id PK, canonical_id, archived_version, created_at)
//     record_relations(source_id, rel, target_id, created_at) PK(source_id,rel,target_id)
// (2) oneLine() flattens a child-process stream only inside an assertion's own
// MESSAGE, never its TARGET (anti_pattern ee89c3fd).
// (3) Each guard is reached with the MINIMUM fixture that trips it and nothing
// else, so the four refusal arms produce DISJOINT red sets under mutation —
// reverting one message's disclosure must redden that message's test alone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
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

const openRW = (p) => new DatabaseSync(p);

function insertVersionSnapshot(db, recordId, version, body, archivedAt) {
  db.prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, ?, ?, ?)')
    .run(recordId, version, archivedAt, body);
}
function insertAlias(db, historicalId, canonicalId, archivedVersion, createdAt) {
  db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historicalId, canonicalId, archivedVersion, createdAt);
}
function insertRelation(db, sourceId, rel, targetId, createdAt) {
  db.prepare('INSERT INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceId, rel, targetId, createdAt);
}

/**
 * The property under test, applied to one refusal's combined output.
 *
 * THREE CLAUSES, EACH LOAD-BEARING — a refusal that names adopt must ALSO say
 * that it cannot write, and WHERE that is tracked. Asserting only "mentions
 * adopt" would be satisfied by the very message this test exists to reject;
 * asserting only "says read-only" would be satisfied by a message that dropped
 * the pointer entirely, leaving the operator with no next step at all.
 */
function assertEscapeHatchIsHonest(out, label) {
  assert.match(out, /adopt/i, `${label}: still names whole-file adoption as the shape that would carry this`);
  assert.match(
    out, /READ-ONLY|read-only/,
    `${label}: and discloses that 'adopt' is a READ-ONLY probe — a bare "Use 'adopt'" sends an operator mid-incident ` +
      `to a mode that will refuse them again`
  );
  assert.match(
    out, /44434103/,
    `${label}: and names the board carrying adopt's unbuilt write half, so the operator learns the route is unbuilt ` +
      `rather than that they used it wrong`
  );
}

// ---------------------------------------------------------------------------
// THE THREE ARMS THAT ARE RED AT HEAD.
// ---------------------------------------------------------------------------

test("ESCAPE-HATCH: the record_versions refusal does not point at 'adopt' as if it were operable", (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-hatch-ver-');
  const liveId = randomUUID();
  const from = join(dir, 'from', 'sterling.db');
  mkV2(from, [mk(liveId, 'current body', { version: 2 })]);
  const rw = openRW(from);
  insertVersionSnapshot(rw, liveId, 1, JSON.stringify(mk(liveId, 'old body')), '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = `${r.stdout}\n${r.stderr}`;
  // SABOTAGE: restore this one refusal's tail to the bare
  // "Use 'adopt' (whole-file, provenance intact). Nothing was written." — the
  // read-only and 44434103 assertions go red HERE and nowhere else, because no
  // other test reaches the record_versions guard.
  assert.strictEqual(r.code, 2, `the version-snapshot guard still refuses: ${oneLine(out)}`);
  assert.match(out, /record_versions/, 'and still names the table it found');
  assertEscapeHatchIsHonest(out, 'record_versions refusal');
});

test("ESCAPE-HATCH: the record_aliases refusal does not point at 'adopt' as if it were operable", (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-hatch-ali-');
  const liveId = randomUUID();
  const from = join(dir, 'from', 'sterling.db');
  mkV2(from, [mk(liveId, 'current body')]);
  const rw = openRW(from);
  insertAlias(rw, randomUUID(), liveId, 1, '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = `${r.stdout}\n${r.stderr}`;
  // SABOTAGE: restore this one refusal's tail to the bare "Use 'adopt' …" —
  // red here alone; the alias guard is the only one this fixture reaches.
  assert.strictEqual(r.code, 2, `the alias guard still refuses: ${oneLine(out)}`);
  assert.match(out, /record_aliases/, 'and still names the table it found');
  assertEscapeHatchIsHonest(out, 'record_aliases refusal');
});

test("ESCAPE-HATCH: the retired-lifecycle refusal does not point at 'adopt' as if it were operable", () => {
  const dir = tmp('doctor-hatch-ret-');
  const from = join(dir, 'from', 'sterling.db');
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);
  mkdirSync(dirname(from), { recursive: true });
  const originalId = randomUUID();
  const s = new SterlingStore(from);
  s.create(mk(originalId, 'will be retired'));
  s.retireInFavorOf(originalId, randomUUID(), NOW(), 'promoted');
  s.close();

  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = `${r.stdout}\n${r.stderr}`;
  // SABOTAGE: restore this one refusal's tail to the bare "Use 'adopt' …".
  // NOTE this fixture ALSO carries a record_relations row (retireInFavorOf
  // mints the inbound supersedes edge), but the retired guard is ordered FIRST
  // (domain-doctor.mjs, the comment above the relations guard says so
  // explicitly), so this arm reads the retired message and never the relations
  // one — which is what keeps its red set disjoint from the relations control.
  assert.strictEqual(r.code, 2, `the retired-lifecycle guard still refuses: ${oneLine(out)}`);
  assert.match(out, /retired/i, 'and still names what it found');
  assert.doesNotMatch(out, /record_relations/, 'the more specific retired cause is the one reported, not the relations one');
  assertEscapeHatchIsHonest(out, 'retired-lifecycle refusal');
});

// ---------------------------------------------------------------------------
// CONTROLS.
// ---------------------------------------------------------------------------

test('ESCAPE-HATCH-CONTROL: the record_relations refusal was ALREADY honest and stays so — the pin matches ratified wording, not newly invented phrasing', (t) => {
  if (!sqliteAvailable) { t.skip('node:sqlite unavailable in this runtime'); return; }
  const dir = tmp('doctor-hatch-rel-');
  const a = randomUUID();
  const b = randomUUID();
  const from = join(dir, 'from', 'sterling.db');
  mkV2(from, [mk(a, 'record a'), mk(b, 'record b')]);
  const rw = openRW(from);
  insertRelation(rw, a, 'relies_on', b, '2026-06-01T00:00:00.000Z');
  rw.close();
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);

  const r = doctor(['migrate', '--from', from, '--to', to], dir);
  const out = `${r.stdout}\n${r.stderr}`;
  // GREEN BEFORE AND AFTER — that is the point. This arm must pass for the
  // OPPOSITE reason to the three above: it holds the assertion shape to the
  // wording decision 88f3db69 already ratified. If it were ever red, the three
  // arms above would be pinning phrasing this file made up.
  assert.strictEqual(r.code, 2, `the relations guard still refuses: ${oneLine(out)}`);
  assert.match(out, /record_relations/, 'and still names the table it found');
  assertEscapeHatchIsHonest(out, 'record_relations refusal');
});

test('ESCAPE-HATCH-CONTROL: a clean migrate succeeds and mentions no escape hatch at all — the disclosure never leaks into the success path', () => {
  const dir = tmp('doctor-hatch-clean-');
  const onlyInSource = randomUUID();
  const from = mkV2(join(dir, 'from', 'sterling.db'), [mk(onlyInSource, 'plain answer, nothing to contain')]);
  const to = mkV2(join(dir, 'to', 'sterling.db'), []);

  const r = doctor(['migrate', '--from', from, '--to', to, '--apply'], dir);
  const out = `${r.stdout}\n${r.stderr}`;
  // SABOTAGE: append the shared disclosure unconditionally to migrate's output
  // (rather than only inside the refusal branches) — this arm goes red alone,
  // proving the three arms above are pinning the REFUSAL messages and not
  // merely "the word adopt appears somewhere in this tool's output".
  assert.strictEqual(r.code, 0, `a clean v2 pair still migrates: ${oneLine(out)}`);
  assert.match(r.stdout, /MIGRATED: 1/i, 'and the record actually lands');
  assert.doesNotMatch(out, /44434103/, 'a successful migrate never mentions the unbuilt adopt write half');
  assert.doesNotMatch(out, /READ-ONLY probe/i, 'nor the read-only disclosure — there was nothing to refuse');
});
