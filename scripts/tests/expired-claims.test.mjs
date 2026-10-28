// scripts/expired-claims.mjs and scripts/lib/board-claims-watch.mjs: the cross-project expired-claim
// reader. Fixtures build their own stores and registry; the machine's live registry is never read
// (STERLING_REGISTRY_DB points at a temp file). Hazard ddf7ad45: OPENCODE vars are cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    await run(process.execPath, [script, '--json'], { env: env(f.reg) });
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
