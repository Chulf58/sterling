// scripts/expired-claims.mjs and scripts/lib/board-claims-watch.mjs: the cross-project expired-claim
// reader. Fixtures build their own stores and registry; the machine's live registry is never read
// (STERLING_REGISTRY_DB points at a temp file). Hazard ddf7ad45: OPENCODE vars are cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, SterlingStore } from '@sterling/store';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';
import { buildBins } from '../lib/bundled-artifacts.mjs';
import { collectExpiredClaims, readProjectClaims } from '../lib/board-claims-watch.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../expired-claims.mjs', import.meta.url));
// The CLI judges against the real clock, so the fixtures are built relative to it.
const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const env = (reg) => {
  const e = { ...process.env, STERLING_REGISTRY_DB: reg };
  delete e.OPENCODE;
  delete e.OPENCODE_SESSION_ID;
  return e;
};

/** name -> bytes of every file in a directory; -shm is skipped (a reader's read-mark legitimately changes it). */
const dirBytes = (dir) => Object.fromEntries(readdirSync(dir).filter((n) => !n.endsWith('-shm')).sort().map((n) => [n, readFileSync(join(dir, n))]));

function project(base, name, { lease, claimAgeMinutes, config }) {
  const root = join(base, name);
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), config ?? JSON.stringify(lease ? { board_claims: { lease_minutes: lease } } : {}));
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  try {
    if (claimAgeMinutes !== undefined) {
      const tools = new SterlingTools({ store, repoRoot: root, now: () => minutesAgo(claimAgeMinutes) });
      const id = tools.boardAdd({ text: `${name} task\nsecond line`, source: 'user', objective: 'standalone' }).record.id;
      store.claimTodo(id, { session: `${name}-sess`, checkout: `${name}-main`, now: minutesAgo(claimAgeMinutes) });
    }
  } finally {
    store.close();
  }
  return root;
}

function fixture(specs) {
  const base = mkdtempSync(join(tmpdir(), 'expired-claims-'));
  const reg = join(base, 'registry.db');
  const registry = new ProjectRegistry(reg);
  const roots = {};
  for (const [name, spec] of Object.entries(specs)) {
    roots[name] = spec === 'no-store' ? join(base, name) : project(base, name, spec);
    if (spec === 'no-store') {
      mkdirSync(join(roots[name], '.sterling'), { recursive: true });
      writeFileSync(join(roots[name], '.sterling', 'config.json'), '{}');
    }
    registry.register({ repo_path: roots[name], name, stack_tags: [], toolchains: [], sterling_version: null, at: minutesAgo(1000) });
  }
  registry.close();
  return { base, reg, roots, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('each project is judged by its own lease; unreadable, missing and unsupported boards are degraded, not empty', async () => {
  // Claims are 90 minutes old: expired under lease 60, held under lease 120.
  const f = fixture({
    short: { lease: 60, claimAgeMinutes: 90 },
    long: { lease: 120, claimAgeMinutes: 90 },
    badconfig: { config: '{ not json' },
    nostore: 'no-store',
  });
  try {
    const { stdout, code } = await run(process.execPath, [script, '--json'], { env: env(f.reg) }).then(
      (r) => ({ ...r, code: 0 }),
      (e) => ({ stdout: e.stdout, code: e.code })
    );
    assert.equal(code, 1, 'degraded projects make the exit code 1');
    const report = JSON.parse(stdout);
    assert.equal(report.projects_read, 4);
    assert.equal(report.expired.length, 1, 'only the short-lease project expired the claim');
    const [c] = report.expired;
    assert.equal(c.project, 'short');
    assert.equal(c.id8.length, 8);
    assert.equal(c.label, 'short task');
    assert.equal(c.holder_session, 'short-sess');
    assert.equal(c.checkout, 'short-main');
    assert.equal(c.age_minutes >= 90, true);
    assert.equal(c.lease_minutes, 60);
    const reasons = Object.fromEntries(report.degraded.map((d) => [d.project, d.reason]));
    assert.match(reasons.badconfig, /^config_unreadable: .*malformed/s);
    assert.equal(reasons.nostore, 'store_missing');
    assert.equal('short' in reasons || 'long' in reasons, false);
  } finally {
    f.cleanup();
  }
});

test('the reader writes nothing and renews nothing: the claim and the store are unchanged after a read', async () => {
  const f = fixture({ only: { lease: 60, claimAgeMinutes: 90 } });
  try {
    const before = dirBytes(join(f.roots.only, '.sterling'));
    assert.ok(Object.keys(before).includes('sterling.db'));
    await run(process.execPath, [script, '--json'], { env: env(f.reg) });
    assert.deepEqual(dirBytes(join(f.roots.only, '.sterling')), before, 'every file of the target store dir is byte-identical (no -wal/-shm litter either)');
    const store = new SterlingStore(join(f.roots.only, '.sterling', 'sterling.db'));
    try {
      const todo = store.query({ types: ['todo'] })[0];
      assert.equal(todo.claim.renewed_at, minutesAgo(90), 'renewed_at is untouched');
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

// Hazard 8616e72d: the registry is opened read-only, so a legacy-schema file and a file with a hot -wal
// are left byte-identical (main file and -wal; -shm legitimately changes with a reader's read-mark).
const fileBytes = (p) => (existsSync(p) ? readFileSync(p) : null);
const walPair = (db) => ({ main: fileBytes(db), wal: fileBytes(`${db}-wal`) });

test('the registry is read read-only: a legacy-schema registry and a registry with a hot -wal are byte-identical after a run', async () => {
  const f = fixture({ only: { lease: 60, claimAgeMinutes: 90 } });
  const legacy = mkdtempSync(join(tmpdir(), 'expired-claims-legacy-'));
  let hot;
  try {
    // Legacy: no project_key column, no occupancy table, rollback journal.
    const legacyReg = join(legacy, 'registry.db');
    const old = new DatabaseSync(legacyReg);
    old.exec('CREATE TABLE projects (repo_path TEXT PRIMARY KEY, name TEXT NOT NULL, stack_tags TEXT NOT NULL, toolchains TEXT NOT NULL, sterling_version TEXT, first_init_at TEXT NOT NULL, last_init_at TEXT NOT NULL, last_seen_at TEXT)');
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(f.roots.only, 'only', '[]', '[]', null, minutesAgo(9), minutesAgo(9), null);
    old.close();
    const legacyBefore = walPair(legacyReg);
    const legacyOut = JSON.parse((await run(process.execPath, [script, '--json'], { env: env(legacyReg) })).stdout);
    assert.deepEqual(legacyOut.expired.map((c) => c.project), ['only'], 'the legacy registry is still read');
    assert.deepEqual(walPair(legacyReg), legacyBefore, 'legacy registry unchanged');

    // Hot WAL: the project row exists ONLY in an uncheckpointed -wal held open by a writer.
    const hotReg = join(legacy, 'hot.db');
    new ProjectRegistry(hotReg).close();
    hot = new DatabaseSync(hotReg);
    hot.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    hot.prepare('INSERT INTO projects (repo_path, name, stack_tags, toolchains, sterling_version, first_init_at, last_init_at, last_seen_at, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.roots.only, 'only', '[]', '[]', null, minutesAgo(9), minutesAgo(9), null, 'key-1');
    const hotBefore = walPair(hotReg);
    assert.ok(hotBefore.wal && hotBefore.wal.length > 0, 'the fixture really has a hot -wal');
    const hotOut = JSON.parse((await run(process.execPath, [script, '--json'], { env: env(hotReg) })).stdout);
    assert.deepEqual(hotOut.expired.map((c) => c.project), ['only'], 'the row that lives only in the -wal is read');
    assert.deepEqual(walPair(hotReg), hotBefore, 'main file and -wal unchanged');
  } finally {
    hot?.close();
    rmSync(legacy, { recursive: true, force: true });
    f.cleanup();
  }
});

test('a report larger than the pipe buffer reaches a reader that starts late, untruncated', async () => {
  const base = mkdtempSync(join(tmpdir(), 'expired-claims-pipe-'));
  const reg = join(base, 'registry.db');
  const registry = new ProjectRegistry(reg);
  try {
    const root = join(base, 'big');
    mkdirSync(join(root, '.sterling'), { recursive: true });
    writeFileSync(join(root, '.sterling', 'config.json'), '{}');
    const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
    const COUNT = 300;
    try {
      const tools = new SterlingTools({ store, repoRoot: root, now: () => minutesAgo(200) });
      for (let i = 0; i < COUNT; i++) {
        const id = tools.boardAdd({ text: `item ${i} ${'x'.repeat(500)}`, source: 'user', objective: 'standalone' }).record.id;
        store.claimTodo(id, { session: `s${i}`, checkout: 'main', now: minutesAgo(200) });
      }
    } finally {
      store.close();
    }
    registry.register({ repo_path: root, name: 'big', stack_tags: [], toolchains: [], sterling_version: null, at: minutesAgo(1000) });
    registry.close();
    // The reader process starts one second after the writer has finished producing output.
    const late = `(sleep 1; node -e "let n=0,b=[];process.stdin.on('data',d=>{n+=d.length;b.push(d)}).on('end',()=>{const r=JSON.parse(Buffer.concat(b));console.log(n+' '+r.expired.length)})")`;
    const { stdout } = await run('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} --json | ${late}`], { env: env(reg), maxBuffer: 1 << 20 });
    const [bytes, claims] = stdout.trim().split(' ').map(Number);
    assert.equal(claims, COUNT, 'all claims arrive');
    assert.ok(bytes > 65_536 * 2, `the report (${bytes} bytes) is well past the pipe buffer`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a missing registry is refused loudly and creates nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'expired-claims-'));
  try {
    const reg = join(base, 'nope', 'registry.db');
    await assert.rejects(run(process.execPath, [script], { env: env(reg) }), (e) => e.code === 2 && /no project registry/.test(e.stderr));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a child that never answers is degraded as a timeout at the shared deadline; a dying child is reader_failed', async () => {
  const silent = () => ({ once() {}, send() {}, kill() {} });
  const t0 = Date.now();
  const [r] = await collectExpiredClaims({ projects: [{ project: 'p', root: '/x' }], now: NOW, timeoutMs: 150, start: silent });
  assert.deepEqual({ degraded: r.degraded, reason: r.reason }, { degraded: true, reason: 'timeout' });
  assert.equal(Date.now() - t0 < 2000, true);
  const dying = () => ({
    once(event, cb) {
      if (event === 'exit') setImmediate(cb);
    },
    send() {},
    kill() {},
  });
  const [d] = await collectExpiredClaims({ projects: [{ project: 'p', root: '/x' }], now: NOW, timeoutMs: 5000, start: dying });
  assert.equal(d.reason, 'reader_failed');
});

test('a Postgres-storage project is unsupported, never read as empty', () => {
  const base = mkdtempSync(join(tmpdir(), 'expired-claims-'));
  try {
    const root = join(base, 'pg');
    mkdirSync(join(root, '.sterling'), { recursive: true });
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ storage: 'postgres' }));
    const r = readProjectClaims({ project: 'pg', root, now: NOW });
    assert.equal(r.degraded, true);
    assert.equal(r.claims, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the BUILT bundle runs: usage error exits 2, and --json reads a project through a forked child of the bundle', async () => {
  // Built into a temp out-dir, never the shipped bin/ (hazard 37b3cb0a).
  const f = fixture({ short: { lease: 60, claimAgeMinutes: 90 } });
  const out = mkdtempSync(join(tmpdir(), 'expired-claims-bin-'));
  try {
    await buildBins({ root: fileURLToPath(new URL('../..', import.meta.url)), outDir: out });
    const bundle = join(out, 'expired-claims.mjs');
    await assert.rejects(run(process.execPath, [bundle, '--bogus'], { env: env(f.reg) }), (e) => e.code === 2 && /usage: expired-claims/.test(e.stderr));
    const { stdout } = await run(process.execPath, [bundle, '--json'], { env: env(f.reg) });
    const report = JSON.parse(stdout);
    assert.deepEqual(report.expired.map((c) => c.project), ['short']);
    assert.deepEqual(report.degraded, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
    f.cleanup();
  }
});
