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
import { maybeLaunchMaintenanceWorker } from '../hooks/lib/maintenance-worker.mjs';

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
    writeFileSync(join(p.dir, '.sterling', 'maintenance-worker.jsonl'), JSON.stringify({ kind: 'verdict', item_id: judged.id, verdict: 'owes_prose', file_keys: ['src/a.mjs'], reason: 'new flag', evidence: true }) + '\n');
    const out = h1(p.dir);
    assert.match(out.systemMessage, /3 maintenance items pending · 3 items in lane reconcile_needed, oldest 3d 2h, worker not running$/);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(`RECONCILE BACKLOG: 3 items in lane reconcile_needed, the oldest open since ${oldest.replace(/[.]/g, '\\.')} \\(3d 2h\\)`));
    assert.match(ctx, /Of these, 1 item in lane reconcile_needed are judged 'owes prose' by the background worker/);
  } finally {
    p.cleanup();
  }
});

test('H1 names a running worker from a live lockfile, and a broken last run once, with its reason and the log path', () => {
  const p = makeProject();
  try {
    reconcileItem(p.store, daysAgo(0, 5));
    const since = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.lock'), JSON.stringify({ pid: process.pid, started_at: since }));
    writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: false, at: since, error: 'exit 1' } }));
    const out = h1(p.dir);
    assert.match(out.systemMessage, new RegExp(`1 item in lane reconcile_needed, oldest 5h, worker running \\(pid ${process.pid}, since `));
    assert.match(out.systemMessage, /last worker run FAILED at .*: exit 1 \(log: \.sterling\/maintenance-worker\.log\)$/);
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

const BREAKAGE = [
  ['a non-zero exit', 'exit 3'],
  ['an error result (is_error)', 'error result (error_max_budget_usd)'],
  ['permission denials', '2 permission denial(s)'],
  ['the MCP server not connected', "MCP server 'sterling' not connected (failed)"],
];

for (const [kind, error] of BREAKAGE) {
  test(`H1 adds one breakage clause when the last worker run was broken: ${kind}`, () => {
    const p = makeProject();
    try {
      reconcileItem(p.store, daysAgo(0, 2));
      const at = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ last_run: { ok: false, at, error } }));
      const out = h1(p.dir);
      assert.ok(
        out.systemMessage.endsWith(`worker not running; last worker run FAILED at ${at}: ${error} (log: .sterling/maintenance-worker.log)`),
        out.systemMessage
      );
      assert.equal(out.systemMessage.split('\n').filter((l) => /last worker run/.test(l)).length, 1, 'one line');
    } finally {
      p.cleanup();
    }
  });
}

const ROUTINE = [
  ['a no-progress run', { ok: true, no_progress: true, error: null }],
  ['a run that closed items', { ok: true, no_progress: false, error: null, closes_ok: 2 }],
  ['no run recorded yet', null],
];

for (const [name, lastRun] of ROUTINE) {
  test(`H1 stays quiet about the worker's last run for a routine state: ${name}`, () => {
    const p = makeProject();
    try {
      reconcileItem(p.store, daysAgo(0, 2));
      const at = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify(lastRun ? { last_run: { at, ...lastRun } } : {}));
      const out = h1(p.dir);
      assert.match(out.systemMessage, /1 item in lane reconcile_needed, oldest 2h, worker not running$/, 'the line ends at the worker state: no clause');
      assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /last worker run|NO PROGRESS|FAILED|spend today/);
    } finally {
      p.cleanup();
    }
  });
}

test('H1 shows no worker spend even when a legacy state file still carries a spend map (the daily cap and its accounting are gone)', () => {
  const p = makeProject();
  try {
    reconcileItem(p.store, daysAgo(0, 2));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify({ spend: { [today]: 50 } }));
    const out = h1(p.dir);
    assert.match(out.systemMessage, /worker not running$/);
    assert.doesNotMatch(out.systemMessage, /spend/);
  } finally {
    p.cleanup();
  }
});

test('H1 names a failure to START the worker (the launcher recorded it as a failed last run), once, with the reason and the log path', () => {
  const p = makeProject();
  try {
    reconcileItem(p.store, daysAgo(0, 2));
    const r = maybeLaunchMaintenanceWorker({
      root: p.dir, config: null, trigger: 'stop', env: {}, now: Date.now(),
      items: [{ id: 'i1', system_reason: 'reconcile_needed', text: "reconcile article 'x'", file_keys: ['src/a.mjs'] }],
      spawnSync: () => ({ status: 128, stdout: '' }),
    });
    assert.equal(r.reason, 'git_failed');
    const out = h1(p.dir);
    assert.match(out.systemMessage, /worker not running; last worker run FAILED at .*: git could not report HEAD .*\(log: \.sterling\/maintenance-worker\.log\)$/);
  } finally {
    p.cleanup();
  }
});
