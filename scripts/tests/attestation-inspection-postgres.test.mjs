// scripts/lib/attestation-inspection.mjs with Postgres storage (issue
// Chulf58/sterling#26 item 7; decision storage-backend-is-its-own-config-key-
// written-only-by-store-move). The inspector is disclosure-only: on a
// Postgres-storage project it reads the live attestations from the project's
// Postgres store through a read-only snapshot, and every failure is
// { available:false, reason } with no throw and no read of a sterling.db left
// beside the project. The failure tests need no server; the read test needs
// STERLING_TEST_PG=1 and its own sterling_test_<random> namespace, dropped after.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgBridge, PgDriver, SterlingStore, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';
import { inspectAttestations } from '../lib/attestation-inspection.mjs';

const PG = process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served';
const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-attest-pg-${label}-`));
  scratch.push(d);
  return d;
};

function project(id) {
  const root = tmp('proj');
  mkdirSync(join(root, '.sterling'));
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', storage: 'postgres', stack_tags: [] }));
  if (id) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: id }));
  return root;
}

// Runs fn with HOME and the test namespace set, restoring both after.
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A SQLite sterling.db beside the project holding a live approved attestation on src/a.png.
// A Postgres-storage project must never read it.
function staleSqliteCopy(root) {
  const db = new DatabaseSync(join(root, '.sterling', 'sterling.db'));
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, type TEXT, lifecycle TEXT, body TEXT)');
  const id = randomUUID();
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run(id, 'attestation', 'live', JSON.stringify({ id, verdict: 'approved', inspected_at: '2026-08-20', file_keys: ['src/a.png'] }));
  db.close();
}

const CALL = { touchedPaths: ['src/a.png'], declaredGlobs: ['src/**'] };

test('no credentials: { available:false } naming the settings failure, and the stale sterling.db is not read', () => {
  const root = project(randomUUID());
  staleSqliteCopy(root);
  const emptyHome = tmp('empty-home');
  const result = withEnv({ HOME: emptyHome, STERLING_TEST_PG_NAMESPACE: undefined }, () => inspectAttestations({ projectRoot: root, ...CALL }));
  assert.equal(result.available, false);
  assert.match(result.reason, /could not resolve the store of .*storage 'postgres': Postgres credentials file/);
  assert.equal(result.reports, undefined);
});

test('no identity file: { available:false } naming it, and the stale sterling.db is not read', () => {
  const root = project(undefined);
  staleSqliteCopy(root);
  const result = withEnv({ STERLING_TEST_PG_NAMESPACE: undefined }, () => inspectAttestations({ projectRoot: root, ...CALL }));
  assert.equal(result.available, false);
  assert.match(result.reason, /project identity file/);
});

test('the database unreachable: { available:false } naming it, never a throw', () => {
  const home = tmp('unreachable-home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const creds = join(home, '.sterling', 'credentials', 'served.json');
  writeFileSync(creds, JSON.stringify({ host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 }));
  chmodSync(creds, 0o600);
  const root = project(randomUUID());
  staleSqliteCopy(root);
  const result = withEnv({ HOME: home, STERLING_TEST_PG_NAMESPACE: undefined }, () => inspectAttestations({ projectRoot: root, ...CALL }));
  assert.equal(result.available, false);
  assert.match(result.reason, /could not read attestations from the Postgres store sterling_p_.*unreachable/);
  assert.doesNotMatch(result.reason, /not-a-secret/);
});

test('Postgres storage: the live attestations come from the Postgres store; retired and non-attestation records add no coverage', { skip: PG }, () => {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const metaSchema = `${ns}_meta`;
  const id = randomUUID();
  const schema = `${ns}_p_${id.replace(/-/g, '')}`;
  const bridge = new PgBridge(readPgCredentials());
  try {
    ensurePgLayout(bridge, metaSchema);
    createPgStore(bridge, { kind: 'test', name: 'attest', schema, metaSchema });
    const store = new SterlingStore(`postgres:${schema}`, { driver: new PgDriver(bridge, { schema, metaSchema }) });
    const base = { created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z', author: 'user', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
    const attestation = (extra) => ({ ...base, type: 'attestation', artifact_key: 'artifact', inspector: 'human-tester', ...extra });
    const stale = store.create(attestation({ id: randomUUID(), verdict: 'rejected', inspected_at: '2026-08-01', file_keys: ['src/b.png'] }));
    store.supersede(stale.id, attestation({ id: randomUUID(), verdict: 'approved', inspected_at: '2026-08-10', file_keys: ['src/c.png'] }));
    store.create(attestation({ id: randomUUID(), verdict: 'approved', inspected_at: '2026-08-20', file_keys: ['src/a.png'] }));
    store.create(attestation({ id: randomUUID(), verdict: 'needs_rework', inspected_at: '2026-08-25', file_keys: ['src/a.png'] }));
    store.create(attestation({ id: randomUUID(), verdict: 'approved', inspected_at: '2026-08-26', file_keys: [] }));
    store.create({ ...base, id: randomUUID(), type: 'decision', title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/d.png'] });
    store.close();

    const root = project(id);
    staleSqliteCopy(root);
    const result = withEnv({ STERLING_TEST_PG_NAMESPACE: ns }, () =>
      inspectAttestations({ projectRoot: root, touchedPaths: ['src/a.png', 'src/b.png', 'src/c.png', 'src/d.png'], declaredGlobs: ['src/**'] })
    );
    assert.equal(result.available, true, result.reason);
    assert.equal(result.pathless_attestation_count, 1);
    assert.equal(result.skipped_malformed_count, 0);
    const [report] = result.reports;
    assert.equal(report.touched_count, 4);
    assert.equal(report.comparable_count, 2, 'a.png (freshest wins) and c.png (the superseding attestation) are covered');
    assert.deepEqual(report.verdicts, { approved: 1, rejected: 0, needs_rework: 1 });
    assert.deepEqual(
      Object.fromEntries(report.examples.map((e) => [e.path, e.verdict])),
      { 'src/a.png': 'needs_rework', 'src/c.png': 'approved', 'src/b.png': 'uncovered', 'src/d.png': 'uncovered' }
    );
  } finally {
    try {
      for (const row of bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows) bridge.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
    } finally {
      bridge.close();
    }
  }
});
