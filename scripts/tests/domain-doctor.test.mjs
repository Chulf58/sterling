// domain-doctor tests (board 4cb9d525): the forensics + guarded-repair script
// for shared domain stores. The incident it exists for: a promoted record's
// domain copy resolves in NO store any session mounts (a homedir/root flip
// stranded the old store file; lazy-create silently shadowed it with a fresh
// empty one), while the project store still holds the tombstone whose
// superseded_by dangles at the lost copy.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
let DatabaseSync;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ DatabaseSync } = await import('node:sqlite'));
});

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A project dir with .sterling/{config.json,store.db}, one domains root, and a
 *  promotion-then-loss: the original was retired in favor of an id that exists
 *  in NO store (the lost domain copy). */
function lossScenario() {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  const projectDir = join(dir, 'proj');
  const domainsRoot = join(dir, 'domains');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  mkdirSync(domainsRoot, { recursive: true });
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({ stack_tags: ['genesys-cloud'], domain_paths: { 'genesys-cloud': join(domainsRoot, 'genesys-cloud', 'sterling.db').replace(/\\/g, '/') } })
  );
  const store = new SterlingStore(join(projectDir, '.sterling', 'store.db'));
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create({
    id: originalId,
    type: 'research_finding',
    created_at: NOW(),
    updated_at: NOW(),
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['genesys-cloud'],
    question: 'What are the tenant facts?',
    answer: 'The tenant facts are X, Y and Z.',
    source_urls: ['https://example.test'],
    source_date: '2026-06-22',
    capture_date: '2026-06-22',
    volatility_hint: 'medium',
  });
  // the promotion tombstone whose target was lost with the stranded store file
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();
  return { dir, projectDir, domainsRoot, originalId, lostId };
}

test('sweep reports a superseded_by that resolves in no store, and is silent once it resolves', () => {
  const { projectDir, lostId, originalId } = lossScenario();
  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(swept.code, 3, 'dangling pointers exit 3 so a caller can branch on the finding');
  assert.match(swept.stdout, new RegExp(lostId), 'names the missing target id');
  assert.match(swept.stdout, new RegExp(originalId), 'names the tombstone holding the pointer');
  assert.match(swept.stdout, /DANGLING/i);
});

test('restore is dry-run by default, applies only with --apply, resurrects the DANGLING id, and refuses a second apply', () => {
  const { projectDir, domainsRoot, originalId, lostId } = lossScenario();

  const dry = doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud'], projectDir);
  assert.equal(dry.code, 0, `dry-run succeeds: ${dry.stderr}`);
  assert.match(dry.stdout, /DRY-RUN/i, 'says nothing was written');
  assert.match(dry.stdout, new RegExp(lostId), 'plans to resurrect exactly the dangling target id');

  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  const applied = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.equal(applied.code, 0, `apply succeeds: ${applied.stderr}`);
  assert.match(applied.stdout, /RESTORED/i);

  const domain = new SterlingStore(domainDb);
  const restored = domain.get(lostId);
  domain.close();
  assert.ok(restored, 'the domain store now holds the record under the previously-dangling id');
  assert.equal(restored.status, 'active');
  assert.equal(restored.scope, 'domain:genesys-cloud');
  assert.equal(restored.answer, 'The tenant facts are X, Y and Z.', 'content restored from the tombstone body');
  assert.ok(
    restored.links.some((l) => l.rel === 'informed_by' && l.target_id === originalId),
    'provenance link back to the tombstone, same shape knowledge_promote writes'
  );

  // the sweep is now clean …
  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(swept.code, 0, 'no dangling pointers after the restore');

  // … and a second apply refuses: the id resolves, there is nothing to restore.
  const again = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.notEqual(again.code, 0, 'restoring an id that already resolves is refused');
  assert.match(again.stdout + again.stderr, /already resolves/i);
});

test('scan lists per-domain store files with record counts from an explicit root', () => {
  const { projectDir, domainsRoot, originalId, lostId } = lossScenario();
  // materialize the domain store via a real restore so scan has something to count
  doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'], projectDir);
  const scanned = doctor(['scan', '--roots', domainsRoot], projectDir);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.match(scanned.stdout, /genesys-cloud/);
  assert.match(scanned.stdout, /records: 1/, 'counts the restored record');
  assert.match(scanned.stdout, new RegExp(lostId.slice(0, 8)), '--find-free scan still lists earliest/latest ids per store');
});

test('migrate copies records verbatim from a stranded store into the current one, skipping ids that already exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mig-'));
  const oldDb = join(dir, 'old', 'sterling.db');
  const newDb = join(dir, 'new', 'sterling.db');
  mkdirSync(dirname(oldDb), { recursive: true });
  mkdirSync(dirname(newDb), { recursive: true });
  const shared = randomUUID();
  const strandedOnly = randomUUID();
  const mk = (id, answer) => ({
    id, type: 'research_finding', created_at: '2026-06-22T10:00:00.000Z', updated_at: '2026-06-22T10:00:00.000Z',
    author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'domain:genesys-cloud',
    stack_tags: ['genesys-cloud'], question: `q-${id}`, answer, source_urls: [], source_date: '2026-06-22', capture_date: '2026-06-22',
  });
  const old = new SterlingStore(oldDb);
  old.create(mk(shared, 'shared answer'));
  old.create(mk(strandedOnly, 'stranded answer'));
  old.close();
  const nu = new SterlingStore(newDb);
  nu.create(mk(shared, 'shared answer'));
  nu.close();

  const dry = doctor(['migrate', '--from', oldDb, '--to', newDb], dir);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /DRY-RUN/i);
  assert.match(dry.stdout, new RegExp(strandedOnly), 'plans to copy exactly the missing record');
  assert.match(dry.stdout, /skipped 1/i, 'discloses the skipped shared id');

  const applied = doctor(['migrate', '--from', oldDb, '--to', newDb, '--apply'], dir);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /MIGRATED: 1/i);

  const check = new SterlingStore(newDb);
  const restored = check.get(strandedOnly);
  const stillOne = check.get(shared);
  check.close();
  assert.ok(restored, 'the stranded record now resolves in the current store');
  assert.equal(restored.answer, 'stranded answer', 'body copied verbatim');
  assert.equal(restored.created_at, '2026-06-22T10:00:00.000Z', 'original clocks preserved — a migration is not a new write');
  assert.ok(stillOne, 'existing records untouched');
});

// ---------------------------------------------------------------------------
// scope-audit (new READ-ONLY verb, dispatched in parallel with this suite) —
// AUTHORED BY THE TEST-WRITER LANE, H4 READ WALL APPLIES: scripts/domain-doctor.mjs's
// new-verb code was NEVER read. Every fixture below is built through the REAL
// store code path (SterlingStore.create()) plus, exactly where the drift
// itself is what needs simulating and create() cannot produce it, a raw SQL
// edit of an ALREADY-STORED row — the identical technique breakBody() uses in
// domain-doctor-migrate-atomicity.test.mjs (a sibling TEST file, permitted
// reading), never a hand-written row shape production cannot reach.
//
// See anti_pattern record-body-scope-is-not-physical-store-identity for why
// body-vs-column drift (C1/C2) is reachable through ordinary APIs (an update
// writes the JSON body without touching the scope COLUMN) — the fixtures
// below reproduce exactly that end-state, one field at a time, on a row that
// create() first wrote correctly. C3 reproduces a mis-migration: a row
// created correctly in one physical store, then relocated whole (every
// column preserved) into a different store file — this is what a hand
// migration or a stranded-store recovery actually does, not a synthetic
// shape. See anti_pattern a-writable-sqlite-open-on-a-wal-database-mutates-the-main-fi
// for the hot-WAL discipline PIN 7 depends on, including the exact "a throw
// while proving hotness is itself the proof" trap named in the dispatch brief.
//
// AMBIGUITY DISCLOSED (not guessed around): the brief gives the finding's
// required DATA (dbPath, mounted identity, record id, column scope, body
// scope, class) but not its exact rendering — text layout, JSON key names, or
// how an ABSENT body scope (C1) is denoted. Pins below assert PRESENCE of
// each required datum via substring/regex over combined stdout+stderr (or the
// --json payload), accepting either the class CODE ("C1") or its SLUG
// ("body_omits_scope") since the brief prints both, never a specific layout.
// C5 (ambiguous_mount) and the --roots/unmounted-stores behavior are real
// spec content but are NOT in the seven REQUIRED PINS list, so no test claims
// them here — flagged for the coordinator rather than silently covered or
// silently skipped.

const esc = (s) => String(s).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** A well-formed research_finding body — the same field shape the sibling
 *  migrate suites use (verified live via their own green creates), so this
 *  is a genuine schema-valid record, not a guessed shape. */
function mkRF(id, scope, overrides = {}) {
  return {
    id,
    type: 'research_finding',
    created_at: NOW(),
    updated_at: NOW(),
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope,
    stack_tags: [],
    question: `scope-audit fixture marker ${id.slice(0, 8)}`,
    answer: 'fixture body',
    source_urls: [],
    source_date: '2026-06-22',
    capture_date: '2026-06-22',
    volatility_hint: 'medium',
    ...overrides,
  };
}

/** A project dir with .sterling/config.json declaring the given domain
 *  mounts (name -> physical db path), POSIX-normalized per the path
 *  invariant, matching lossScenario()'s own config shape above. */
function configProject(dir, { domains = {} } = {}) {
  const projectDir = join(dir, 'proj');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  const domain_paths = {};
  for (const [name, p] of Object.entries(domains)) domain_paths[name] = p.replace(/\\/g, '/');
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({ stack_tags: Object.keys(domains), domain_paths })
  );
  return projectDir;
}

/** A genuine domain store file, built through SterlingStore.create() only. */
function domainStore(domainsRoot, name, records) {
  const path = join(domainsRoot, name, 'sterling.db');
  mkdirSync(dirname(path), { recursive: true });
  const s = new SterlingStore(path);
  for (const r of records) s.create(r);
  s.close();
  return path;
}

function readBody(dbPath, id) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT body FROM records WHERE id = ?').get(id);
  db.close();
  return JSON.parse(row.body);
}
function writeBody(dbPath, id, body) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(body), id);
  db.close();
}
/** Simulates the C1 end-state: a body that OMITS scope entirely, on a row
 *  whose scope COLUMN is untouched and remains NOT NULL — see the cited
 *  anti_pattern for why this is reachable through ordinary update APIs. */
function dropBodyScope(dbPath, id) {
  const body = readBody(dbPath, id);
  delete body.scope;
  writeBody(dbPath, id, body);
}
/** Simulates the C2 end-state: a body scope that CONTRADICTS the column. */
function setBodyScope(dbPath, id, newScope) {
  const body = readBody(dbPath, id);
  body.scope = newScope;
  writeBody(dbPath, id, body);
}
function readColumnScope(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT scope FROM records WHERE id = ?').get(id);
  db.close();
  return row.scope;
}
/** Simulates the C3 end-state: relocates a row WHOLE (every column,
 *  including its scope column, preserved verbatim) from one physical store
 *  into another — the shape a real mis-migration or stranded-store recovery
 *  produces, not a synthetic column value. Column names are read off the row
 *  itself (SELECT *) rather than hardcoded, since the schema is implementation
 *  the test-writer does not read. */
function relocateRow(fromDb, toDb, id) {
  const src = new DatabaseSync(fromDb);
  const row = src.prepare('SELECT * FROM records WHERE id = ?').get(id);
  src.prepare('DELETE FROM records WHERE id = ?').run(id);
  src.close();
  const dst = new DatabaseSync(toDb);
  const cols = Object.keys(row);
  dst.prepare(`INSERT INTO records (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  dst.close();
  return row;
}
/** Proves a store is genuinely hot (uncheckpointed) by copying ONLY the main
 *  .db file (never -wal) and checking whether a fresh id is visible in that
 *  copy alone. Per the cited anti_pattern: on a MAXIMALLY hot store the main
 *  file may not contain the `records` table at all, and that throw is itself
 *  the strongest possible proof of hotness — NOT a failure to establish it. A
 *  catch that swallows and returns hot:false would invert the evidence, which
 *  is exactly the bug this helper exists to avoid; any OTHER error is
 *  rethrown rather than silently treated as proof of anything.
 *  NOTE: this checks the FIXTURE's own genuineness, not the scope-audit verb
 *  under test — it has no "sabotage of the implementation" in the usual
 *  sense; see the report for how it is verified instead. */
function proveHot(dbPath, freshId) {
  const copyPath = `${dbPath}.hotcheck-${randomUUID()}`;
  copyFileSync(dbPath, copyPath);
  try {
    const db = new DatabaseSync(copyPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id FROM records WHERE id = ?').get(freshId);
      return { hot: !row, reason: row ? 'present-in-main-copy' : 'absent-from-main-copy' };
    } finally {
      db.close();
    }
  } catch (err) {
    if (/no such table:\s*records/i.test(String(err && err.message))) {
      return { hot: true, reason: 'no-records-table-in-main-copy' };
    }
    throw err;
  } finally {
    rmSync(copyPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// PIN 1 — clean
// ---------------------------------------------------------------------------
test('scope-audit PIN1: a clean project + mounted domain store reports zero findings and exits 0 (both plain and --json)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-clean-'));
  const domainsRoot = join(dir, 'domains');
  const alphaPath = join(domainsRoot, 'alpha', 'sterling.db');
  const projectDir = configProject(dir, { domains: { alpha: alphaPath } });
  const project = new SterlingStore(join(projectDir, '.sterling', 'store.db'));
  project.create(mkRF(randomUUID(), 'project'));
  project.close();
  domainStore(domainsRoot, 'alpha', [mkRF(randomUUID(), 'domain:alpha')]);

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.equal(r.code, 0, `a clean scope-audit exits 0: ${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout + r.stderr, /\bC[1-5]\b/, 'no finding class is reported');

  const rJson = doctor(['scope-audit', '--project', projectDir, '--json'], projectDir);
  assert.equal(rJson.code, 0, '--json clean run also exits 0');
  const parsed = JSON.parse(rJson.stdout);
  assert.equal(JSON.stringify(parsed).match(/\bC[1-5]\b/), null, '--json output carries no finding class either');
});
// SABOTAGE: flip the exit code to a nonzero constant even on a clean input ->
// the first assert.equal(r.code, 0, ...) goes red. (This pin ALONE cannot
// distinguish a real audit from one that always reports clean — that
// distinguishing power belongs to PIN2-5, which require a real finding to be
// surfaced, and PIN6, which requires "blocked" to never read as "clean".)

// ---------------------------------------------------------------------------
// PIN 2 — C1 body_omits_scope
// ---------------------------------------------------------------------------
test('scope-audit PIN2: a row whose body omits scope entirely is found and classified C1 (body_omits_scope)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-c1-'));
  const projectDir = configProject(dir, { domains: {} });
  const dbPath = join(projectDir, '.sterling', 'store.db');
  const project = new SterlingStore(dbPath);
  const id = randomUUID();
  project.create(mkRF(id, 'project'));
  project.close();
  dropBodyScope(dbPath, id);
  assert.equal(readColumnScope(dbPath, id), 'project', 'sanity: the scope COLUMN is untouched by the body edit — the row is well-formed');

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.notEqual(r.code, 0, 'a C1 finding is a non-zero exit');
  const out = r.stdout + r.stderr;
  assert.match(out, /\bC1\b|body_omits_scope/, 'classified C1 / body_omits_scope');
  assert.match(out, new RegExp(id), 'names the record id');
  assert.match(out, /project/, 'the column scope (project) is shown for this finding');
});
// SABOTAGE: treat `!('scope' in body)` as clean (skip the C1 branch entirely)
// -> both the non-zero-exit assertion and the /\bC1\b|body_omits_scope/
// assertion go red.

// ---------------------------------------------------------------------------
// PIN 3 — C2 body_contradicts_column
// ---------------------------------------------------------------------------
test('scope-audit PIN3: a row whose body scope contradicts its column is found and classified C2 (body_contradicts_column)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-c2-'));
  const projectDir = configProject(dir, { domains: {} });
  const dbPath = join(projectDir, '.sterling', 'store.db');
  const project = new SterlingStore(dbPath);
  const id = randomUUID();
  project.create(mkRF(id, 'project'));
  project.close();
  setBodyScope(dbPath, id, 'domain:ghost');
  assert.equal(readColumnScope(dbPath, id), 'project', 'sanity: only the body was edited, the column still says project');

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.notEqual(r.code, 0, 'a C2 finding is a non-zero exit');
  const out = r.stdout + r.stderr;
  assert.match(out, /\bC2\b|body_contradicts_column/, 'classified C2 / body_contradicts_column');
  assert.match(out, new RegExp(id), 'names the record id');
  assert.match(out, /project/, 'the column scope (project) is shown');
  assert.match(out, /domain:ghost/, 'the body scope (domain:ghost) is shown');
});
// SABOTAGE: compare with `body.scope ?? column.scope` (nullish-coalesce
// instead of equality) so a PRESENT-but-different body scope is silently
// treated as agreeing -> the /\bC2\b|body_contradicts_column/ assertion goes
// red (no C2 is ever reported).

// ---------------------------------------------------------------------------
// PIN 4 — C3 column_contradicts_location
// ---------------------------------------------------------------------------
test('scope-audit PIN4: a row whose column disagrees with the physical store it sits in is found and attributed to the file it is ACTUALLY in (C3, column_contradicts_location)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-c3-'));
  const domainsRoot = join(dir, 'domains');
  const alphaPath = join(domainsRoot, 'alpha', 'sterling.db');
  const betaPath = join(domainsRoot, 'beta', 'sterling.db');
  const projectDir = configProject(dir, { domains: { alpha: alphaPath, beta: betaPath } });
  const id = randomUUID();
  domainStore(domainsRoot, 'alpha', [mkRF(id, 'domain:alpha')]);
  domainStore(domainsRoot, 'beta', []); // real mounted store, created via the real path
  relocateRow(alphaPath, betaPath, id); // row now PHYSICALLY in beta; column still says domain:alpha

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.notEqual(r.code, 0, 'a C3 finding is a non-zero exit');
  const out = r.stdout + r.stderr;
  assert.match(out, /\bC3\b|column_contradicts_location/, 'classified C3 / column_contradicts_location');
  assert.match(out, new RegExp(id), 'names the record id');
  assert.match(out, new RegExp(esc(betaPath)), 'attributed to the file it is PHYSICALLY found in (beta), not the column claim');
  assert.match(out, /domain:alpha/, 'the column claim (domain:alpha) is shown alongside');
});
// SABOTAGE: attribute a C3 finding to the store NAMED BY THE COLUMN
// (domain:alpha -> alphaPath) instead of the file actually opened -> the
// betaPath assertion goes red because the finding would instead name
// alphaPath, a file that no longer even holds the row.

// ---------------------------------------------------------------------------
// PIN 5 — C4 duplicate_id_across_mounts
// ---------------------------------------------------------------------------
test('scope-audit PIN5: the same record id present in two mounted stores is reported as C4 (duplicate_id_across_mounts), and BOTH stores are named — never resolved to one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-c4-'));
  const domainsRoot = join(dir, 'domains');
  const alphaPath = join(domainsRoot, 'alpha', 'sterling.db');
  const betaPath = join(domainsRoot, 'beta', 'sterling.db');
  const projectDir = configProject(dir, { domains: { alpha: alphaPath, beta: betaPath } });
  const id = randomUUID();
  domainStore(domainsRoot, 'alpha', [mkRF(id, 'domain:alpha')]);
  domainStore(domainsRoot, 'beta', [mkRF(id, 'domain:beta')]);

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.notEqual(r.code, 0, 'a duplicate id is a non-zero finding');
  const out = r.stdout + r.stderr;
  assert.match(out, /\bC4\b|duplicate_id_across_mounts/, 'classified C4 / duplicate_id_across_mounts');
  assert.match(out, new RegExp(id), 'names the duplicated id');
  assert.match(out, new RegExp(esc(alphaPath)), 'names the alpha store as one of the two homes');
  assert.match(out, new RegExp(esc(betaPath)), 'names the beta store as the other home');
});
// SABOTAGE: dedupe findings by record id before reporting (keep only the
// first store seen for a given id) -> whichever of the alphaPath/betaPath
// assertions names the DROPPED store goes red.

// ---------------------------------------------------------------------------
// PIN 6 — blocked != clean, and DISTINCT from the findings code
// ---------------------------------------------------------------------------
test(
  'scope-audit PIN6: an unreadable project store exits with a could-not-complete code DISTINCT from both 0 and the ordinary findings code, and never reads as clean',
  { skip: process.platform === 'win32' ? 'chmod-based unreadable fixture is not portable to native Windows; parity note per repo convention (see J3 in domain-doctor-migrate-journal.test.mjs)' : false },
  () => {
    // Capture the ORDINARY findings exit code first — the spec names THREE
    // distinct codes (0 / findings / could-not-complete), not two, so
    // "distinct from 0" alone is not what this pin is required to prove.
    const findingsDir = mkdtempSync(join(tmpdir(), 'doctor-sa-c6-findings-'));
    const findingsProjectDir = configProject(findingsDir, { domains: {} });
    const findingsDb = join(findingsProjectDir, '.sterling', 'store.db');
    const fStore = new SterlingStore(findingsDb);
    const fid = randomUUID();
    fStore.create(mkRF(fid, 'project'));
    fStore.close();
    dropBodyScope(findingsDb, fid);
    const findingsRun = doctor(['scope-audit', '--project', findingsProjectDir], findingsProjectDir);
    assert.notEqual(findingsRun.code, 0, 'sanity: the findings scenario really is non-zero');

    const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-c6-blocked-'));
    const projectDir = configProject(dir, { domains: {} });
    const dbPath = join(projectDir, '.sterling', 'store.db');
    const project = new SterlingStore(dbPath);
    project.create(mkRF(randomUUID(), 'project'));
    project.close();
    chmodSync(dbPath, 0o000);
    try {
      const r = doctor(['scope-audit', '--project', projectDir], projectDir);
      assert.notEqual(r.code, 0, 'a blocked audit never exits 0');
      assert.notEqual(r.code, findingsRun.code, 'the could-not-complete code is DISTINCT from the ordinary findings code');
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(out, /\bclean\b/i, 'a blocked audit must never say "clean"');
      assert.doesNotMatch(out, /0 findings/i, 'a blocked audit must never report zero findings — it found nothing because it could not look, not because there was nothing to find');
    } finally {
      chmodSync(dbPath, 0o644);
    }
  }
);
// SABOTAGE: catch the open/read failure and fall through to the normal
// "no findings" report path (treat any exception as "nothing to report") ->
// this pin goes red on BOTH the distinct-exit-code assertion and the
// doesNotMatch(/clean/i) assertion. Named by the brief as the pin that
// matters most: a blocked audit misread as clean is exactly the failure that
// would let a read-path change activate on drifted data it never inspected.

// ---------------------------------------------------------------------------
// PIN 7 — no mutation on a HOT WAL, with its control arm
// ---------------------------------------------------------------------------
test('scope-audit PIN7: running the verb over a genuinely HOT-WAL store leaves the main .db and the -wal byte-identical, and -shm is present (never byte-checked)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-sa-hotwal-'));
  const projectDir = configProject(dir, { domains: {} });
  const dbPath = join(projectDir, '.sterling', 'store.db');

  const seedStore = new SterlingStore(dbPath);
  seedStore.create(mkRF(randomUUID(), 'project'));
  seedStore.close(); // establish the file cleanly first

  // The writer whose frames stay UNCHECKPOINTED in -wal: opened, written to,
  // and deliberately NOT closed before or during the audit. A fixture that
  // closes before the audit has no -wal at all and would make the
  // byte-identity claim hollow by construction (cited anti_pattern).
  const hotStore = new SterlingStore(dbPath);
  const hotId = randomUUID();
  hotStore.create(mkRF(hotId, 'project'));

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assert.ok(existsSync(walPath), 'sanity: the writer really left a WAL file behind');

  // CONTROL ARM — required by the brief: prove the fixture is genuinely hot
  // BEFORE trusting the byte-identity assertions below. This checks the
  // FIXTURE's own genuineness, not the verb under test, so it has no
  // "sabotage of the implementation" in the usual sense — see the report for
  // how its own correctness is verified instead.
  const hotness = proveHot(dbPath, hotId);
  assert.equal(hotness.hot, true, `fixture must be genuinely hot before the byte-identity claim means anything: ${JSON.stringify(hotness)}`);

  const mainBefore = readFileSync(dbPath);
  const walBefore = readFileSync(walPath);

  const r = doctor(['scope-audit', '--project', projectDir], projectDir);
  assert.equal(r.code, 0, `a clean scope-audit over a hot-WAL store still runs and reports clean: ${r.stdout}\n${r.stderr}`);

  const mainAfter = readFileSync(dbPath);
  assert.ok(Buffer.compare(mainBefore, mainAfter) === 0, 'the main .db file is byte-identical after the audit — no checkpoint occurred');
  const walAfter = readFileSync(walPath);
  assert.ok(Buffer.compare(walBefore, walAfter) === 0, 'the -wal file is byte-identical after the audit — the writer\'s frames were not touched');
  assert.ok(existsSync(shmPath), '-shm is present (PRESENCE only, never bytes — a correct read-only reader legitimately writes its own read-mark into -shm)');

  hotStore.close();
});
// SABOTAGE: open the store with a WRITABLE handle in the scope-audit read
// path (e.g. `new DatabaseSync(dbPath)` instead of `new DatabaseSync(dbPath,
// { readOnly: true })`) -> this pin goes red on the main-file byte-identity
// assertion (a writable close CHECKPOINTS WAL frames into the main file) and
// very likely also on the -wal byte-identity assertion (checkpoint
// clears/rewrites -wal).

// ===========================================================================
// P-RACE-* — readOnlyProbe's SIDECAR-REMOVAL CONTRACT (CRITICAL concurrency
// defect). AUTHORED BY THE TEST-WRITER LANE, H4 READ WALL APPLIES:
// scripts/domain-doctor.mjs was NEVER read; these pins were written from the
// dispatch brief's spec plus anti_pattern
// a-writable-sqlite-open-on-a-wal-database-mutates-the-main-fi.
//
// THE CONTRACT BEING PINNED (not any one implementation of it): the read-only
// probe may remove a `-wal`/`-shm` sidecar ONLY while that sidecar is still
// EMPTY (zero-length) AT REMOVAL TIME. A live writer's WAL carries committed
// frames and is therefore non-empty; a read-only open's self-created WAL is
// zero-length. Removing a non-empty WAL unlinks committed database state a
// live writer still holds open — so the tool would hold no writable SQLite
// handle and still have a filesystem write path that destroys live data,
// while printing that it repairs nothing.
//
// THE CONTRACT IS THE HELPER'S, NOT ONE VERB'S: readOnlyProbe is pre-existing
// and shared, so these pins deliberately exercise BOTH pre-existing consumer
// verbs — `scan` (P-RACE-1, P-RACE-2) and `sweep` (P-RACE-3, P-RACE-4).
//
// LIMIT OF THESE PINS, STATED PLAINLY RATHER THAN PAPERED OVER (see
// anti_pattern artifact-asserts-unperformed-verification): the defect's
// trigger is an INTERLEAVING — a commit landing between the probe's
// existence SAMPLE and its removal. These tests drive the probe across a
// process boundary (spawnSync), and the child's sample point is neither
// observable nor controllable from the parent, so NONE of these pins
// reproduces that window deterministically. What they pin instead is the
// CONTRACT's observable consequence at every state a test CAN construct
// deterministically: a non-empty WAL survives a probe byte-identically
// (P-RACE-1/3), an empty one does not litter (P-RACE-2), and a run claiming
// read-only changes nothing on disk (P-RACE-4). A deterministic pin on the
// interleaving itself needs an in-process seam (readOnlyProbe exported, with
// the writer's commit driven from inside the probe's own callback); that
// interface is NOT declared in the brief, so no test here invents it — it is
// reported to the coordinator as the one uncovered half.
// PREDICTIONS (not measurements — this lane holds no shell): see the report.
// ===========================================================================

// Added as separate import statements rather than by editing the file's
// existing ones, so this append-only section touches no existing line.
import { statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const WIN_SKIP_HOT_WAL =
  process.platform === 'win32'
    ? 'a still-open second SQLite connection + unlink-while-open semantics differ on native Windows (and again on /mnt/c); the defect this pins is POSIX-shaped — parity note per the repo convention already used by PIN6 and J3 in domain-doctor-migrate-journal.test.mjs'
    : false;

/** Proves a store is genuinely HOT (committed frames still uncheckpointed) by
 *  copying ONLY the main .db file — never -wal — into an ISOLATED scratch
 *  directory and asking whether a freshly-committed id is visible there.
 *
 *  Deliberately NOT the sibling proveHot() above: that one writes its copy
 *  BESIDE the store under test, and opening that copy read-only materializes
 *  `<copy>-wal` / `<copy>-shm` litter in the very directory P-RACE-2 and
 *  P-RACE-4 assert is unchanged. Isolating the scratch dir keeps the store
 *  directory pristine, which is a precondition of those two pins.
 *
 *  Per anti_pattern a-writable-sqlite-open-on-a-wal-database-mutates-the-main-fi:
 *  on a maximally-hot store the main file may not contain the `records` table
 *  at ALL, and that throw is the STRONGEST proof of hotness, not a failure to
 *  establish it. Any OTHER error is rethrown rather than swallowed — a catch
 *  that returned hot:false here would invert the evidence and leave a
 *  block-severity defect unpinned while looking like coverage. */
function proveHotIsolated(dbPath, freshId) {
  const scratch = mkdtempSync(join(tmpdir(), 'doctor-hotcheck-'));
  const copyPath = join(scratch, 'main-only.db');
  copyFileSync(dbPath, copyPath);
  try {
    const db = new DatabaseSync(copyPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id FROM records WHERE id = ?').get(freshId);
      return { hot: !row, reason: row ? 'present-in-main-copy' : 'absent-from-main-copy' };
    } finally {
      db.close();
    }
  } catch (err) {
    if (/no such table:\s*records/i.test(String(err && err.message))) {
      return { hot: true, reason: 'no-records-table-in-main-copy' };
    }
    throw err;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** name -> sha256 for every regular file directly under `dir`, EXCEPT `-shm`,
 *  which is recorded as a presence marker only and never hashed. A read-only
 *  reader legitimately registers a read-mark in the WAL index, and the WAL
 *  index lives in -shm — measured (anti_pattern above): main UNCHANGED, -wal
 *  UNCHANGED, -shm CHANGED. Hashing -shm would pin something FALSE and go
 *  permanently red against a CORRECT implementation. */
function snapshotStoreDir(dir) {
  const out = new Map();
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    if (name.endsWith('-shm')) {
      out.set(name, '<shm: presence recorded, bytes deliberately NOT hashed>');
      continue;
    }
    out.set(name, createHash('sha256').update(readFileSync(p)).digest('hex'));
  }
  return out;
}

function nonShmNames(snap) {
  return [...snap.keys()].filter((n) => !n.endsWith('-shm')).sort();
}

/** Nothing under the store directory may be created, removed or modified.
 *  -shm is exempt from BOTH halves: its presence may change either way and
 *  its bytes are never compared. */
function assertStoreDirUnchanged(before, after, label) {
  assert.deepEqual(
    nonShmNames(after),
    nonShmNames(before),
    `${label}: a run that repairs nothing may not create or remove any file under the store directory (-shm presence excepted)`
  );
  for (const name of nonShmNames(before)) {
    assert.equal(
      after.get(name),
      before.get(name),
      `${label}: '${name}' was MODIFIED by a run that claims to repair nothing`
    );
  }
}

// ---------------------------------------------------------------------------
// P-RACE-1 — THE CORE PIN: a live writer's non-empty WAL survives the probe,
// byte-identically, and its committed row stays readable.
// ---------------------------------------------------------------------------
test(
  'P-RACE-1: a probe (scan) over a store whose NON-EMPTY -wal is held by a still-open live writer leaves that -wal present and byte-identical, and the writer\'s committed row still reads back',
  { skip: WIN_SKIP_HOT_WAL },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-race1-'));
    const domainsRoot = join(dir, 'domains');
    const projectDir = configProject(dir, { domains: {} });

    // Built through the REAL store code path, then CLOSED — the last close
    // checkpoints and removes the sidecars, giving the cold starting state
    // the brief specifies ("ensure no -wal exists").
    const dbPath = domainStore(domainsRoot, 'alpha', [mkRF(randomUUID(), 'domain:alpha')]);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    assert.equal(
      existsSync(walPath),
      false,
      'FIXTURE PRECONDITION: the cold store left no -wal behind (the last connection\'s close checkpointed it away). If this is red the fixture never reached the cold state and every assertion below is meaningless.'
    );

    // THE OTHER PROCESS, simulated deterministically: a second connection that
    // COMMITS and stays OPEN. SQLite only checkpoints on the LAST connection's
    // close, so holding this open is exactly what keeps committed frames
    // resident in -wal for the duration of the probe.
    const live = new SterlingStore(dbPath);
    const committedId = randomUUID();
    try {
      live.create(mkRF(committedId, 'domain:alpha'));

      // CONTROL ARM A (placed FIRST, must pass for the OPPOSITE reason): the
      // -wal is genuinely NON-EMPTY. Without this, "the -wal survived" is
      // equally satisfied by a zero-length sidecar the contract PERMITS
      // removing — the verdict would have two possible causes.
      assert.equal(existsSync(walPath), true, 'CONTROL ARM: the live writer really materialized a -wal');
      const walSizeBefore = statSync(walPath).size;
      assert.ok(
        walSizeBefore > 0,
        `CONTROL ARM: the -wal must carry committed frames BEFORE the probe runs, else this pin cannot tell "a non-empty WAL was protected" from "an empty WAL was legitimately removable" (size=${walSizeBefore})`
      );

      // CONTROL ARM B: the frames are genuinely UNCHECKPOINTED — the committed
      // row is NOT in the main .db yet, so the -wal is load-bearing state and
      // unlinking it really would lose data.
      const hotness = proveHotIsolated(dbPath, committedId);
      assert.equal(
        hotness.hot,
        true,
        `CONTROL ARM: the fixture must be genuinely hot (committed row absent from a main-file-only copy) before "the -wal is load-bearing" means anything: ${JSON.stringify(hotness)}`
      );

      const walBefore = readFileSync(walPath);
      const mainBefore = readFileSync(dbPath);

      const r = doctor(['scan', '--roots', domainsRoot], projectDir);
      assert.equal(r.code, 0, `scan over a store with a live writer still completes: ${r.stdout}\n${r.stderr}`);
      // CONTROL ARM C: the probe really OPENED and READ this store, all the way
      // into frames that exist ONLY in the hot -wal (1 checkpointed + 1
      // WAL-resident = 2). Without it, every survival assertion below is also
      // satisfied by a scan that skipped the store entirely.
      assert.match(
        r.stdout,
        /records:\s*2\b/,
        `CONTROL ARM: the probe must have read the store INCLUDING its WAL-resident row (expected 'records: 2'). A count of 1 means the probe never saw the live writer's frames; no count at all means it never opened the store, and "nothing was destroyed" would then prove nothing. Output: ${r.stdout}`
      );

      // ---- THE PIN ----
      assert.equal(
        existsSync(walPath),
        true,
        'the live writer\'s -wal SURVIVES the read-only probe. A probe that unlinks it destroys committed frames a writer still holds open — a filesystem write path in a tool that holds no writable SQLite handle and claims to repair nothing.'
      );
      assert.ok(
        Buffer.compare(walBefore, readFileSync(walPath)) === 0,
        'the live writer\'s -wal is BYTE-IDENTICAL after the probe — not truncated, not recreated empty, not checkpointed'
      );
      assert.ok(
        Buffer.compare(mainBefore, readFileSync(dbPath)) === 0,
        'the main .db is byte-identical — the probe checkpointed nothing into it'
      );
      assert.ok(
        existsSync(shmPath),
        '-shm is present (PRESENCE ONLY — never byte-compared: a correct read-only reader legitimately writes its own read-mark into the WAL index, which lives in -shm)'
      );

      // …and the consequence that actually matters to a user: the committed
      // row is still there. A fresh connection is opened while `live` is still
      // open, so its own close cannot checkpoint and cannot mask the result.
      const fresh = new SterlingStore(dbPath);
      let got;
      try {
        got = fresh.get(committedId);
      } finally {
        fresh.close();
      }
      assert.ok(got, 'the row the live writer COMMITTED before the probe ran is still readable afterwards — this is the data-loss consequence of unlinking a hot WAL');
      assert.equal(got.id, committedId);
    } finally {
      live.close();
    }
  }
);
// SABOTAGE (the one-line change that must turn this RED): in readOnlyProbe's
// cleanup, drop the emptiness condition and delete on absence-at-sample-time
// alone — i.e. restore `if (!hadWal) rmSync(`${dbPath}-wal`, { force: true });`
// in place of the size-guarded form. WHICH GUARD CARRIES THE VERDICT: the
// zero-length check at REMOVAL time is the only guard that can carry it here,
// because the `hadWal` sample is not load-bearing in this fixture — the WAL
// already exists when the probe starts, so an implementation still relying on
// the sample alone ALSO passes. That is the honest limit of this pin and the
// reason it is predicted GREEN today; see the report.

// ---------------------------------------------------------------------------
// P-RACE-2 — the legitimate half: a COLD store gets no litter. This is the pin
// that stops the fix from degenerating into "never delete anything".
// ---------------------------------------------------------------------------
test('P-RACE-2: a probe (scan) over a COLD store — no sidecars, no other connection — leaves no -wal/-shm litter behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-race2-'));
  const domainsRoot = join(dir, 'domains');
  const projectDir = configProject(dir, { domains: {} });
  const dbPath = domainStore(domainsRoot, 'alpha', [mkRF(randomUUID(), 'domain:alpha')]);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  assert.equal(existsSync(walPath), false, 'FIXTURE PRECONDITION: the cold store starts with no -wal');
  assert.equal(existsSync(shmPath), false, 'FIXTURE PRECONDITION: the cold store starts with no -shm');
  const mainBefore = readFileSync(dbPath);

  const r = doctor(['scan', '--roots', domainsRoot], projectDir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  // CONTROL ARM (first, opposite reason): "no litter" is trivially satisfied by
  // a scan that never opened the store. This proves it did.
  assert.match(
    r.stdout,
    /records:\s*1\b/,
    `CONTROL ARM: the probe must actually have OPENED and READ the store (expected 'records: 1'); otherwise "no litter" is satisfied by doing nothing. Output: ${r.stdout}`
  );

  assert.equal(
    existsSync(walPath),
    false,
    'the EMPTY -wal that the read-only open itself materialized is cleaned up — the emptiness rule must not degenerate into "never remove anything"'
  );
  assert.equal(existsSync(shmPath), false, 'and the -shm the read-only open itself materialized is cleaned up too');
  assert.ok(
    Buffer.compare(mainBefore, readFileSync(dbPath)) === 0,
    'the main .db is byte-identical — a read-only open never rewrites it'
  );
});
// SABOTAGE: make the cleanup unconditional in the other direction — remove the
// removal entirely (`// if (!hadWal && isEmpty(wal)) rmSync(...)`) so the
// probe's own empty sidecars are left behind -> the existsSync(walPath) ===
// false and existsSync(shmPath) === false assertions both go red. This is the
// pin that keeps P-RACE-1/3/4 from being satisfiable by deleting nothing ever.

// ---------------------------------------------------------------------------
// P-RACE-3 — the pre-existing forensic case, pinned through the OTHER
// pre-existing consumer verb (`sweep`) so the contract is covered at the
// HELPER, not at one verb.
// ---------------------------------------------------------------------------
test(
  'P-RACE-3: a NON-EMPTY -wal that existed before the probe ran is left byte-identical by `sweep` — the helper contract holds on both pre-existing consumers, not just scan',
  { skip: WIN_SKIP_HOT_WAL },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-race3-'));
    const projectDir = configProject(dir, { domains: {} });
    const dbPath = join(projectDir, '.sterling', 'store.db');
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    // Cold seed so the main file genuinely holds the schema + a checkpointed
    // row; everything after this lives only in -wal.
    const seed = new SterlingStore(dbPath);
    seed.create(mkRF(randomUUID(), 'project'));
    seed.close();
    assert.equal(existsSync(walPath), false, 'FIXTURE PRECONDITION: cold start, no -wal');

    const live = new SterlingStore(dbPath);
    try {
      // A genuine dangling-pointer finding, committed ONLY into the hot -wal.
      // It doubles as this pin's control arm: sweep can only name these ids if
      // it really read WAL-resident frames.
      const originalId = randomUUID();
      const lostId = randomUUID();
      live.create(mkRF(originalId, 'project'));
      live.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
      // bulk the WAL up so "non-empty" is unambiguous rather than marginal
      for (let i = 0; i < 40; i += 1) live.create(mkRF(randomUUID(), 'project'));

      // CONTROL ARM A (first): the -wal genuinely carries frames.
      const walSizeBefore = statSync(walPath).size;
      assert.ok(
        walSizeBefore > 0,
        `CONTROL ARM: the pre-existing -wal must be NON-EMPTY, else this pin cannot distinguish "a non-empty WAL was protected" from "an empty WAL was removable" (size=${walSizeBefore})`
      );
      // CONTROL ARM B: those frames are genuinely uncheckpointed.
      const hotness = proveHotIsolated(dbPath, originalId);
      assert.equal(hotness.hot, true, `CONTROL ARM: fixture must be genuinely hot: ${JSON.stringify(hotness)}`);

      const walBefore = readFileSync(walPath);
      const mainBefore = readFileSync(dbPath);

      const r = doctor(['sweep', '--project', projectDir], projectDir);
      // CONTROL ARM C: the sweep COMPLETED and actually read the hot store —
      // it names a dangling pointer that exists only in -wal. Without this,
      // byte-identity is equally satisfied by a sweep that never opened it.
      assert.equal(r.code, 3, `CONTROL ARM: the sweep completed and reported its finding (exit 3): ${r.stdout}\n${r.stderr}`);
      assert.match(
        r.stdout,
        new RegExp(lostId),
        'CONTROL ARM: the sweep read data that lives ONLY in the hot -wal — proof the probe opened this store rather than skipping it'
      );

      // ---- THE PIN ----
      assert.equal(existsSync(walPath), true, 'a pre-existing non-empty -wal is still present after the probe');
      assert.ok(
        Buffer.compare(walBefore, readFileSync(walPath)) === 0,
        'the pre-existing non-empty -wal is BYTE-IDENTICAL — the correct forensic posture: never checkpoint, truncate or unlink someone else\'s frames'
      );
      assert.ok(
        Buffer.compare(mainBefore, readFileSync(dbPath)) === 0,
        'the main .db is byte-identical after the sweep'
      );
      assert.ok(existsSync(shmPath), '-shm present (PRESENCE ONLY, never byte-compared — the read-mark lives there)');
    } finally {
      live.close();
    }
  }
);
// SABOTAGE: in readOnlyProbe's cleanup, drop BOTH conditions and remove the
// sidecars unconditionally after close (`rmSync(`${dbPath}-wal`, {force:true})`
// with no guard) -> the existsSync(walPath) assertion goes red immediately,
// and the byte-compare after it goes red as a throw on the missing file.
// WHICH GUARD CARRIES THE VERDICT: either the `hadWal` sample OR the
// zero-length check suffices here, so this pin is DEFENCE-IN-DEPTH and will
// survive a single-guard mutation — that is by design (it is the regression
// pin for the forensic promise the helper ALREADY makes), and it is stated
// here rather than left for a reader to assume the pin is load-bearing alone.

// ---------------------------------------------------------------------------
// P-RACE-4 — the honesty pin: the read-only CLAIM is bound to filesystem
// evidence.
// ---------------------------------------------------------------------------
test(
  'P-RACE-4: a run that CLAIMS read-only / repairs-nothing creates, removes and modifies NO file under the store directory — -shm presence excepted, and -shm is never byte-compared',
  { skip: WIN_SKIP_HOT_WAL },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-race4-'));
    const projectDir = configProject(dir, { domains: {} });
    const sterlingDir = join(projectDir, '.sterling');
    const dbPath = join(sterlingDir, 'store.db');

    const seed = new SterlingStore(dbPath);
    seed.create(mkRF(randomUUID(), 'project'));
    seed.close();

    const live = new SterlingStore(dbPath);
    try {
      const originalId = randomUUID();
      const lostId = randomUUID();
      live.create(mkRF(originalId, 'project'));
      live.retireInFavorOf(originalId, lostId, NOW(), 'promoted');

      assert.ok(statSync(`${dbPath}-wal`).size > 0, 'CONTROL ARM: the store is hot — a non-empty -wal is in play, which is the state a sidecar sweep can destroy');

      const before = snapshotStoreDir(sterlingDir);
      assert.ok(
        nonShmNames(before).includes('store.db') && nonShmNames(before).includes('store.db-wal') && nonShmNames(before).includes('config.json'),
        `CONTROL ARM: the snapshot must actually cover the store, its hot -wal and the config — an empty or partial snapshot makes "unchanged" vacuous. Saw: ${nonShmNames(before).join(', ')}`
      );

      const r = doctor(['sweep', '--project', projectDir], projectDir);
      const out = r.stdout + r.stderr;

      // CONTROL ARMS FIRST — an "unchanged directory" has more than one
      // possible cause, and two of them are worthless: the run crashed before
      // opening anything, or it opened nothing at all.
      assert.equal(r.code, 3, `CONTROL ARM: the run COMPLETED and reported its finding (exit 3), so "unchanged" is not the signature of a crash: ${out}`);
      assert.match(
        r.stdout,
        new RegExp(lostId),
        'CONTROL ARM: the run really read THIS store, down to a record that exists only in the hot -wal'
      );
      assert.match(
        out,
        /read[_ -]?only|NOTHING IS REPAIRED/i,
        'the run CLAIMS read-only / repairs-nothing. This pin binds that CLAIM to the filesystem evidence below; if the claim disappears from the output the binding is gone and this pin must be re-aimed, not deleted.'
      );

      const after = snapshotStoreDir(sterlingDir);
      assertStoreDirUnchanged(before, after, 'a run claiming read-only');
    } finally {
      live.close();
    }
  }
);
// SABOTAGE: give the "read-only" path any filesystem write at all — the
// simplest being the defect itself, an unguarded `rmSync(`${dbPath}-wal`,
// {force:true})` after close -> assertStoreDirUnchanged goes red on the
// deepEqual of names ('store.db-wal' vanishes). A truncating variant
// (`writeFileSync(`${dbPath}-wal`, '')`) instead turns the per-file hash
// assertion red. WHICH GUARD CARRIES THE VERDICT: this pin does not name a
// guard — it is deliberately guard-agnostic and asserts the OUTCOME over the
// whole directory, so it also catches a write nobody predicted (a stray log,
// a lock file, a rewritten config). Its control arms are what keep it from
// being satisfiable by a run that did nothing.
