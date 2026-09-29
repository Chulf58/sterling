// H1 SessionStart — RECONCILE BACKLOG line (decision
// maintenance-queue-background-haiku-worker-simple-redesign point (5)): the
// open reconcile_needed count, the age of the oldest item from created_at, and
// whether a background worker is running (from its lockfile).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h1-session-start.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1rb-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

const reconcileItem = (store, createdAt, text = "reconcile article 'x' — owned file(s) changed content in direct mode (settled): src/a.mjs") =>
  store.create({
    id: randomUUID(), type: 'todo', created_at: createdAt, updated_at: createdAt, author: 'system', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], text, source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'],
  });

function h1(dir) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't.jsonl'), cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_PLUGIN_ROOT: root },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const daysAgo = (d, extraHours = 0) => new Date(Date.now() - (d * 24 + extraHours) * 3600_000 - 60_000).toISOString();

test('H1 prints the reconcile count and the OLDEST item age on the banner and to the conductor; no worker running', () => {
  const p = makeProject();
  try {
    reconcileItem(p.store, daysAgo(1));
    const oldest = daysAgo(3, 2);
    reconcileItem(p.store, oldest);
    const judged = reconcileItem(p.store, daysAgo(0), "reconcile article 'y' — changed");
    // 'owes prose' lives in the worker's JSONL, keyed by id + current file_keys (never on the item).
    writeFileSync(join(p.dir, '.sterling', 'maintenance-worker.jsonl'), JSON.stringify({ kind: 'verdict', item_id: judged.id, verdict: 'owes_prose', file_keys: ['src/a.mjs'], reason: 'new flag' }) + '\n');
    const out = h1(p.dir);
    assert.match(out.systemMessage, /3 maintenance items pending · 3 items in lane reconcile_needed, oldest 3d 2h, worker not running$/);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(`RECONCILE BACKLOG: 3 items in lane reconcile_needed, the oldest open since ${oldest.replace(/[.]/g, '\\.')} \\(3d 2h\\)`));
    assert.match(ctx, /Of these, 1 item in lane reconcile_needed are judged 'owes prose' by the background worker/);
  } finally {
    p.cleanup();
  }
});

test('H1 names a running worker from a live lockfile, and a failed last run loudly', () => {
  const p = makeProject();
  try {
    reconcileItem(p.store, daysAgo(0, 5));
    const since = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.lock'), JSON.stringify({ pid: process.pid, started_at: since }));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ spend: { [today]: 1.5 }, last_run: { ok: false, at: since, error: 'exit 1' } }));
    const out = h1(p.dir);
    assert.match(out.systemMessage, new RegExp(`1 item in lane reconcile_needed, oldest 5h, worker running \\(pid ${process.pid}, since `));
    assert.match(out.systemMessage, /last worker run FAILED at .*: exit 1 \(log: \.sterling\/maintenance-worker\.log\); worker spend today \$1\.50/);
  } finally {
    p.cleanup();
  }
});

test('H1 stays silent about the backlog when no reconcile item is open', () => {
  const p = makeProject();
  try {
    const out = h1(p.dir);
    assert.doesNotMatch(out.systemMessage, /reconcile/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /RECONCILE BACKLOG/);
  } finally {
    p.cleanup();
  }
});
