// domain-doctor v2-cutover repair tests (board a215b119): restore and sweep
// both read supersession off the pre-v2 record BODY, but storableBody
// (packages/store/src/index.ts:598-604) strips status/superseded_by from the
// persisted body of every v2 record — restore therefore refuses on every v2
// store, and sweep can miss a dangling pointer whose only surviving trace is
// the authoritative record_relations 'supersedes' row (the migration runner's
// discarded-extra-claimant path can leave that relation with the
// `superseded_by` COLUMN still NULL). These tests pin the v2-authoritative
// fix: read status/superseded_by from the records COLUMNS, and treat a
// `record_relations` inbound 'supersedes' row as authoritative over (or in
// addition to) the column when it exists.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => new Date().toISOString();

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function doctor(args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domain-doctor.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mkRecord(id, answer) {
  return {
    id,
    type: 'research_finding',
    created_at: NOW(),
    updated_at: NOW(),
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['genesys-cloud'],
    question: `q-${id}`,
    answer,
    source_urls: ['https://example.test'],
    source_date: '2026-06-22',
    capture_date: '2026-06-22',
    volatility_hint: 'medium',
  };
}

/** A project dir with .sterling/{config.json,store.db} and one domains root —
 *  no promotion/tombstone yet, so each test builds its own supersession shape. */
function projectFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-v2repair-'));
  const projectDir = join(dir, 'proj');
  const domainsRoot = join(dir, 'domains');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  mkdirSync(domainsRoot, { recursive: true });
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({
      stack_tags: ['genesys-cloud'],
      domain_paths: { 'genesys-cloud': join(domainsRoot, 'genesys-cloud', 'sterling.db').replace(/\\/g, '/') },
    })
  );
  const storePath = join(projectDir, '.sterling', 'store.db');
  const store = new SterlingStore(storePath);
  return { dir, projectDir, domainsRoot, storePath, store };
}

/** Simulate the ONE migration-runner path the board item traces (a discarded
 *  extra link-only supersession claimant): the record_relations 'supersedes'
 *  row survives, but the records.superseded_by COLUMN is NULL — a shape no
 *  normal SterlingStore write path can produce (every one of them keeps both
 *  in sync inside one transaction), so it must be constructed with raw SQL. */
function desyncColumnFromRelation(dbPath, tombstoneId) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE records SET superseded_by = NULL WHERE id = ?").run(tombstoneId);
  } finally {
    db.close();
  }
}

test('sweep finds a dangling supersedes RELATION even when the superseded_by COLUMN has been desynced to NULL (v2 migration-runner shape)', () => {
  const { projectDir, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'the tenant facts'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  desyncColumnFromRelation(storePath, originalId);

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    3,
    `a dangling pointer visible ONLY through record_relations must still be reported, never a false clean: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout, new RegExp(lostId), 'names the missing successor even though the column was NULL');
  assert.match(swept.stdout, new RegExp(originalId), 'names the tombstone holding the pointer');
});

test('sweep reports CLEAN once the relation-only successor resolves, even with the column desynced', () => {
  const { projectDir, domainsRoot, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const targetId = randomUUID();
  store.create(mkRecord(originalId, 'the tenant facts'));
  store.retireInFavorOf(originalId, targetId, NOW(), 'promoted');
  store.close();
  desyncColumnFromRelation(storePath, originalId);

  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  domain.create({ ...mkRecord(targetId, 'the tenant facts'), scope: 'domain:genesys-cloud' });
  domain.close();

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    0,
    `the successor resolves in the mounted domain store, so this must be clean even though the column is NULL: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout, /clean/i);
});

test('restore succeeds against a v2 store when the superseded_by COLUMN is NULL but the supersedes RELATION exists', () => {
  const { projectDir, domainsRoot, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'the tenant facts'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();
  desyncColumnFromRelation(storePath, originalId);

  const applied = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.equal(
    applied.code,
    0,
    `restore must read supersession from record_relations (authoritative) rather than refusing on a desynced column: ${applied.stdout}${applied.stderr}`
  );
  assert.match(applied.stdout, /RESTORED/i);
  assert.match(applied.stdout, new RegExp(lostId));

  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  const domain = new SterlingStore(domainDb);
  const restored = domain.get(lostId);
  domain.close();
  assert.ok(restored, 'the domain store now holds the record under the previously-dangling id');
  assert.equal(restored.answer, 'the tenant facts', 'content restored from the tombstone body');
  // the ENVELOPE, not just the content (roster review, test honesty): a
  // resurrection is a fresh live record, not the tombstone's own retired
  // identity re-served — lifecycle/freshness/version must reset, not carry
  // over 'retired'/'flagged_stale'/the tombstone's version number.
  assert.equal(restored.status, 'active');
  assert.equal(restored.lifecycle, 'live', 'a v2 restore must not resurrect the tombstone AS retired');
  assert.equal(restored.version, 1, 'a resurrection is version 1, not a continuation of the tombstone\'s version');
  assert.equal(restored.scope, 'domain:genesys-cloud');
  assert.ok(
    restored.links.some((l) => l.rel === 'informed_by' && l.target_id === originalId),
    'provenance link back to the tombstone'
  );
});

test('restore refuses cleanly on an ordinary v2 store when the tombstone is not actually retired (status/relation both absent)', () => {
  const { projectDir, store } = projectFixture();
  const liveId = randomUUID();
  store.create(mkRecord(liveId, 'still alive'));
  store.close();

  const attempted = doctor(['restore', '--project', projectDir, '--tombstone', liveId, '--domain', 'genesys-cloud'], projectDir);
  assert.notEqual(attempted.code, 0, 'a live (non-retired) v2 record is not a tombstone');
  assert.match(attempted.stdout + attempted.stderr, /not a tombstone/i);
});

test('sweep leaves no -wal/-shm sidecar litter beside any store it touches (idsIn must clean up conditionally, like readOnlyProbe)', () => {
  const { projectDir, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  assert.equal(existsSync(`${storePath}-wal`), false, 'fixture precondition: cold store, no -wal before the call');
  assert.equal(existsSync(`${storePath}-shm`), false, 'fixture precondition: cold store, no -shm before the call');

  doctor(['sweep', '--project', projectDir], projectDir);

  assert.equal(existsSync(`${storePath}-wal`), false, 'sweep must not leave -wal litter beside the project store');
  assert.equal(existsSync(`${storePath}-shm`), false, 'sweep must not leave -shm litter beside the project store');
});

test('restore (dry-run) leaves no -wal/-shm sidecar litter on the stores its dangling-id check reads', () => {
  const { projectDir, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  assert.equal(existsSync(`${storePath}-wal`), false, 'fixture precondition: cold store, no -wal before the call');
  assert.equal(existsSync(`${storePath}-shm`), false, 'fixture precondition: cold store, no -shm before the call');

  doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud'], projectDir);

  assert.equal(existsSync(`${storePath}-wal`), false, 'restore dry-run must not leave -wal litter beside the project store');
  assert.equal(existsSync(`${storePath}-shm`), false, 'restore dry-run must not leave -shm litter beside the project store');
});

// ---------------------------------------------------------------------------
// Second review round (outside-family Codex + roster review, same board):
// three defects in the fix above, plus one roster-only HIGH (alias-namespace
// blindness) and process/test-honesty items.

function mkArticleRecord(id, title) {
  return {
    id,
    type: 'feature_article',
    created_at: NOW(),
    updated_at: NOW(),
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['genesys-cloud'],
    slug: `article-${id.slice(0, 8)}`,
    title,
    what_it_does: 'does a thing',
    intended_behavior: 'behaves as intended',
    files: [{ path: 'scripts/domain-doctor.mjs', role: 'test fixture' }],
    // the field under test: server-derived content-hash provenance for the
    // OLD (about-to-be-tombstoned) record's owned files.
    file_baselines: { 'scripts/domain-doctor.mjs': 'deadbeefdeadbeefdeadbeefdeadbeef' },
    current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW(), event: 'created for test' }],
    live_test_refs: [],
  };
}

/** A v2-SHAPED `records` table (carries the v2 'lifecycle' column) with NO
 *  `record_relations` table at all — the half-migrated shape Codex HIGH 1
 *  traces: a store whose header may or may not claim user_version 2, but
 *  whose 'records' table already has the v2 columns, is v2-shaped regardless
 *  of what the header says, and reading supersession from the compatibility
 *  column alone on such a store is a guess. Raw SQL because no normal write
 *  path leaves this shape (create() always creates every v2 table together). */
function mkHalfMigratedProjectStore(rows, { userVersion = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-halfmig-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({ stack_tags: ['genesys-cloud'], domain_paths: {} })
  );
  const storePath = join(projectDir, '.sterling', 'store.db');
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'live',
      freshness TEXT NOT NULL DEFAULT 'fresh',
      version INTEGER NOT NULL DEFAULT 1,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      author TEXT NOT NULL,
      derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL
    )`);
    db.exec(`PRAGMA user_version = ${userVersion}`);
    const stmt = db.prepare(
      `INSERT INTO records (id, type, status, superseded_by, lifecycle, freshness, version, scope, created_at, updated_at, author, derived_unconfirmed, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      stmt.run(
        r.id, r.type, r.status, r.superseded_by ?? null, r.lifecycle ?? 'live', r.freshness ?? 'fresh', r.version ?? 1,
        r.scope, r.created_at, r.updated_at, r.author, r.derived_unconfirmed ?? 0, JSON.stringify(r.body)
      );
    }
  } finally {
    db.close();
  }
  return { dir, projectDir, storePath };
}

/** A GENUINELY pre-v2 `records` table: no 'lifecycle' column at all (the
 *  shape migrate-stores.mjs migrates FROM), status/superseded_by are plain
 *  columns as they always were, and no v2 satellite table exists. This is
 *  the shape refuseIfHalfMigratedForSupersession must NOT refuse — pins the
 *  column-only arm of supersessionPointers' union query. */
function mkPreV2ProjectStore(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-prev2-'));
  const projectDir = join(dir, 'proj');
  mkdirSync(join(projectDir, '.sterling'), { recursive: true });
  writeFileSync(
    join(projectDir, '.sterling', 'config.json'),
    JSON.stringify({ stack_tags: ['genesys-cloud'], domain_paths: {} })
  );
  const storePath = join(projectDir, '.sterling', 'store.db');
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      author TEXT NOT NULL,
      derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL
    )`);
    const stmt = db.prepare(
      `INSERT INTO records (id, type, status, superseded_by, scope, created_at, updated_at, author, derived_unconfirmed, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      stmt.run(r.id, r.type, r.status, r.superseded_by ?? null, r.scope, r.created_at, r.updated_at, r.author, r.derived_unconfirmed ?? 0, JSON.stringify(r.body));
    }
  } finally {
    db.close();
  }
  return { dir, projectDir, storePath };
}

// --- Codex HIGH 1: v2-shaped without record_relations must fail loud -------

test('sweep FAILS LOUD on a v2-shaped records table with record_relations absent, rather than trusting the compatibility column alone (half-migrated)', () => {
  const originalId = randomUUID();
  const lostId = randomUUID();
  const { projectDir } = mkHalfMigratedProjectStore([
    {
      id: originalId, type: 'research_finding', status: 'superseded', superseded_by: lostId, lifecycle: 'retired',
      scope: 'project', created_at: NOW(), updated_at: NOW(), author: 'conductor', body: { id: originalId, type: 'research_finding' },
    },
  ]);

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    2,
    `a v2-shaped store missing record_relations must refuse loudly, never silently trust the compatibility column: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout + swept.stderr, /record_relations/i);
  assert.match(swept.stdout + swept.stderr, /half-migrated/i);
});

test('restore FAILS LOUD on a v2-shaped store with record_relations absent, rather than trusting the compatibility column alone', () => {
  const originalId = randomUUID();
  const lostId = randomUUID();
  const { projectDir } = mkHalfMigratedProjectStore([
    {
      id: originalId, type: 'research_finding', status: 'superseded', superseded_by: lostId, lifecycle: 'retired',
      scope: 'project', created_at: NOW(), updated_at: NOW(), author: 'conductor', body: { id: originalId, type: 'research_finding' },
    },
  ]);

  const attempted = doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud'], projectDir);
  assert.equal(
    attempted.code,
    2,
    `restore must refuse the same half-migrated shape sweep refuses: ${attempted.stdout}${attempted.stderr}`
  );
  assert.match(attempted.stdout + attempted.stderr, /record_relations/i);
  assert.match(attempted.stdout + attempted.stderr, /half-migrated/i);
});

test('sweep detects v2-SHAPEDness from the lifecycle COLUMN alone, even when the header user_version was never bumped to 2', () => {
  const originalId = randomUUID();
  const lostId = randomUUID();
  const { projectDir } = mkHalfMigratedProjectStore(
    [
      {
        id: originalId, type: 'research_finding', status: 'superseded', superseded_by: lostId, lifecycle: 'retired',
        scope: 'project', created_at: NOW(), updated_at: NOW(), author: 'conductor', body: { id: originalId, type: 'research_finding' },
      },
    ],
    { userVersion: 0 }
  );

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    2,
    `the 'lifecycle' column alone must be enough to detect v2-shapedness, independent of user_version: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout + swept.stderr, /lifecycle/i);
});

// --- Codex HIGH 2 / roster MEDIUM: ambiguous multi-successor relations ------

test('restore refuses ambiguity loudly when record_relations holds MORE THAN ONE inbound supersedes relation for the tombstone, naming every candidate', () => {
  const { projectDir, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  const otherClaimant = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  // corrupt: a SECOND inbound supersedes relation for the same tombstone —
  // no normal write path can produce this (one successor maximum).
  const db = new DatabaseSync(storePath);
  try {
    db.prepare("INSERT INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, 'supersedes', ?, ?)").run(
      otherClaimant, originalId, NOW()
    );
  } finally {
    db.close();
  }

  const attempted = doctor(['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud'], projectDir);
  assert.equal(
    attempted.code,
    2,
    `ambiguous multi-successor state must refuse rather than silently pick one: ${attempted.stdout}${attempted.stderr}`
  );
  assert.match(attempted.stdout + attempted.stderr, new RegExp(lostId), 'names the original successor candidate');
  assert.match(attempted.stdout + attempted.stderr, new RegExp(otherClaimant), 'names the extra claimant');
});

// --- Codex MEDIUM: file_baselines must not survive the reconstruction ------

test('restore strips file_baselines from the reconstructed record (server-derived hashes of the OLD record, not the resurrection)', () => {
  const { projectDir, domainsRoot, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkArticleRecord(originalId, 'test article'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  const applied = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.equal(applied.code, 0, `restore of a feature_article tombstone should succeed: ${applied.stdout}${applied.stderr}`);

  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  const domain = new SterlingStore(domainDb);
  const restored = domain.get(lostId);
  domain.close();
  assert.ok(restored, 'restored record resolves under the previously-dangling id');
  assert.equal(
    restored.file_baselines,
    undefined,
    'file_baselines is server-derived for the OLD record and must not survive onto the reconstruction'
  );
});

// --- Roster HIGH: record_aliases is a resolvable id namespace too ----------

test('sweep does NOT report a successor as dangling when it resolves only through record_aliases.historical_id', () => {
  const { projectDir, domainsRoot, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  // the successor exists ONLY as a historical alias in the domain store — its
  // canonical record lives under a DIFFERENT id, the shape a rename/migration
  // leaves behind.
  const canonicalId = randomUUID();
  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  domain.create({ ...mkRecord(canonicalId, 'x'), scope: 'domain:genesys-cloud' });
  domain.close();
  const db = new DatabaseSync(domainDb);
  try {
    db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)').run(
      lostId, canonicalId, 1, NOW()
    );
  } finally {
    db.close();
  }

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    0,
    `the successor resolves through record_aliases, so this must not read as a dangling pointer: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout, /clean/i);
});

test('restore refuses --apply when the target id already resolves as a record_aliases historical id (would give one id two meanings)', () => {
  const { projectDir, domainsRoot, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  const canonicalId = randomUUID();
  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  domain.create({ ...mkRecord(canonicalId, 'x'), scope: 'domain:genesys-cloud' });
  domain.close();
  const db = new DatabaseSync(domainDb);
  try {
    db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)').run(
      lostId, canonicalId, 1, NOW()
    );
  } finally {
    db.close();
  }

  const attempted = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.notEqual(attempted.code, 0, 'restoring under an id an alias already resolves elsewhere must be refused');
  assert.match(attempted.stdout + attempted.stderr, /already resolves/i);
  assert.match(attempted.stdout + attempted.stderr, new RegExp(lostId));
  // ALIAS-SPECIFIC phrasing, not the generic "already resolves" a live-record
  // collision would also produce (roster MEDIUM, diagnostic accuracy): an
  // alias collision means the successor's CONTENT IS STILL LOST — that id was
  // merely repurposed to resolve to a DIFFERENT canonical record — so the
  // message must say so explicitly rather than implying the content is safe.
  const out = attempted.stdout + attempted.stderr;
  assert.match(out, /record_aliases historical id/i, `must name the ALIAS namespace specifically, not a generic collision: ${out}`);
  assert.match(
    out,
    /already resolves to another canonical record there/i,
    `must state that the content is still lost, not merely that the id is taken: ${out}`
  );
});

test('restore refuses --apply on a LIVE record id collision with a DIFFERENT message than an alias collision (the successor is genuinely alive, not lost)', () => {
  const { projectDir, domainsRoot, store } = projectFixture();
  const originalId = randomUUID();
  const lostId = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, lostId, NOW(), 'promoted');
  store.close();

  // the target id is ALIVE as an ordinary record in the domain store — a
  // completely different collision shape than the alias case above.
  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  domain.create({ ...mkRecord(lostId, 'x'), scope: 'domain:genesys-cloud' });
  domain.close();

  const attempted = doctor(
    ['restore', '--project', projectDir, '--tombstone', originalId, '--domain', 'genesys-cloud', '--apply'],
    projectDir
  );
  assert.notEqual(attempted.code, 0, 'restoring over a live record must be refused');
  const out = attempted.stdout + attempted.stderr;
  assert.match(out, /already resolves/i);
  assert.match(out, /\(live record id\)/i, `must label this a LIVE RECORD collision, not the alias phrasing: ${out}`);
  assert.doesNotMatch(out, /record_aliases historical id/i, `a live-record collision must not use the alias-specific phrasing: ${out}`);
});

// --- Test honesty: pin the column-only arm on a GENUINE pre-v2 store -------

test('sweep detects a dangling pointer from the compatibility COLUMN alone on a genuinely pre-v2 store (no lifecycle column, no record_relations)', () => {
  const originalId = randomUUID();
  const lostId = randomUUID();
  const { projectDir } = mkPreV2ProjectStore([
    {
      id: originalId, type: 'research_finding', status: 'superseded', superseded_by: lostId,
      scope: 'project', created_at: NOW(), updated_at: NOW(), author: 'conductor',
      body: { id: originalId, type: 'research_finding', status: 'superseded', superseded_by: lostId },
    },
  ]);

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.equal(
    swept.code,
    3,
    `a pre-v2 store's dangling pointer must still be found via the column alone: ${swept.stdout}${swept.stderr}`
  );
  assert.match(swept.stdout, new RegExp(lostId));
});

// --- LOW: scan() must not leak sidecar litter either -----------------------

test('scan leaves no -wal/-shm sidecar litter beside any store file it lists', () => {
  const { domainsRoot, store } = projectFixture();
  const id = randomUUID();
  const domainDb = join(domainsRoot, 'genesys-cloud', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  const domain = new SterlingStore(domainDb);
  domain.create({ ...mkRecord(id, 'x'), scope: 'domain:genesys-cloud' });
  domain.close();
  store.close();

  assert.equal(existsSync(`${domainDb}-wal`), false, 'fixture precondition: cold store, no -wal before the call');
  assert.equal(existsSync(`${domainDb}-shm`), false, 'fixture precondition: cold store, no -shm before the call');

  doctor(['scan', '--roots', domainsRoot], domainsRoot);

  assert.equal(existsSync(`${domainDb}-wal`), false, 'scan must not leave -wal litter beside a store it lists');
  assert.equal(existsSync(`${domainDb}-shm`), false, 'scan must not leave -shm litter beside a store it lists');
});

// --- LOW: a column/relation disagreement is its own reportable finding -----

test('sweep emits a CONFLICT line when the column and record_relations disagree about a tombstone\'s successor', () => {
  const { projectDir, storePath, store } = projectFixture();
  const originalId = randomUUID();
  const columnSuccessor = randomUUID();
  const relationSuccessor = randomUUID();
  store.create(mkRecord(originalId, 'x'));
  store.retireInFavorOf(originalId, relationSuccessor, NOW(), 'promoted');
  store.close();

  // corrupt: rewrite the column to point somewhere ELSE than the relation.
  const db = new DatabaseSync(storePath);
  try {
    db.prepare('UPDATE records SET superseded_by = ? WHERE id = ?').run(columnSuccessor, originalId);
  } finally {
    db.close();
  }

  const swept = doctor(['sweep', '--project', projectDir], projectDir);
  assert.match(swept.stdout, /CONFLICT/i, `a column/relation disagreement must be surfaced explicitly: ${swept.stdout}${swept.stderr}`);
  assert.match(swept.stdout, new RegExp(columnSuccessor));
  assert.match(swept.stdout, new RegExp(relationSuccessor));
  // each successor must be LABELED with the surface that reported it, not
  // just listed — an unlabeled "A vs B" implies a column-then-relation ORDER
  // without ever stating it (roster LOW fold-in).
  assert.match(
    swept.stdout,
    new RegExp(`${columnSuccessor} \\(column\\)`),
    `the column-sourced successor must be explicitly labeled '(column)': ${swept.stdout}`
  );
  assert.match(
    swept.stdout,
    new RegExp(`${relationSuccessor} \\(record_relations\\)`),
    `the relation-sourced successor must be explicitly labeled '(record_relations)': ${swept.stdout}`
  );
});
