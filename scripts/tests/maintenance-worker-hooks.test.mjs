// The worker's routine states never reach the session: H10 at Stop and H19 on a
// Bash `git commit` print NOTHING about a back-off (failed or no-progress run)
// or a large prior spend, and no worker starts under back-off; the reason is
// only in .sterling/maintenance-worker.log (user ruling 2026-09-30, decision
// maintenance-worker-notices-session-start-only-and-no-sliver-launch). Real
// breakage surfaces on H1's session-start line (h1-reconcile-backlog.test.mjs).
// Safety: every launch-refusing case here stops at the back-off check, before
// any spawn; the no-daily-cap case is covered with an injected spawn in
// maintenance-worker.test.mjs. PATH excludes the claude binary as a second guard.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function project(state) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mw-hooks-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [], context_watch: { windows: { default: 200_000 } } }));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const now = new Date().toISOString();
  store.create({
    id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
    text: "reconcile article 'x' — owned file(s) changed content in direct mode (settled): src/a.mjs", source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/a.mjs'],
  });
  store.close();
  writeFileSync(join(dir, '.sterling', 'transient', 'maintenance-worker.state.json'), JSON.stringify(state));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, dir, input) {
  const env = { ...process.env, STERLING_CURRENCY_DISABLE: '1', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  delete env.STERLING_MAINTENANCE_WORKER_DISABLE; // the preload's guard is lifted: this test exercises the launcher
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...input }), encoding: 'utf8', cwd: dir, timeout: 60_000, env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const failedRecently = () => ({ last_run: { ok: false, at: new Date(Date.now() - 60_000).toISOString(), error: 'error result (error_max_budget_usd)' } });
const noProgressRecently = () => ({ last_run: { ok: true, no_progress: true, at: new Date(Date.now() - 60_000).toISOString(), error: null } });

const lockPath = (p) => join(p.dir, '.sterling', 'transient', 'maintenance-worker.lock');
const logText = (p) => {
  const path = join(p.dir, '.sterling', 'maintenance-worker.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

const CASES = [
  ['a failed-run back-off', failedRecently, /backoff: last run FAILED .*error_max_budget_usd.*backing off/],
  ['a no-progress back-off', noProgressRecently, /backoff: worker made no progress .*backing off/],
];

for (const [name, state, logged] of CASES) {
  test(`H10 Stop: ${name} prints nothing about the worker, starts no worker, and is only in the log`, () => {
    const p = project(state());
    try {
      const r = run('h10-direct-capture.mjs', p.dir, { hook_event_name: 'Stop' });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /maintenance worker|backing off|no progress|daily budget/i, 'nothing on stdout');
      assert.doesNotMatch(r.stderr, /maintenance worker|backing off|no progress|daily budget/i, 'nothing on stderr');
      assert.equal(existsSync(lockPath(p)), false, 'nothing launched');
      assert.match(logText(p), logged);
    } finally {
      p.cleanup();
    }
  });

  test(`H19 Bash \`git commit\`: ${name} adds nothing to additionalContext, and starts no worker`, () => {
    const p = project(state());
    try {
      const r = run('h19-bash-delivery.mjs', p.dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, tool_response: { stdout: '' } });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /maintenance worker|backing off|no progress|daily budget/i);
      assert.equal(existsSync(lockPath(p)), false, 'nothing launched');
      assert.match(logText(p), logged);
    } finally {
      p.cleanup();
    }
  });
}

test('H19 Bash without a commit never consults the launcher', () => {
  const p = project(failedRecently());
  try {
    const r = run('h19-bash-delivery.mjs', p.dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '' } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /maintenance worker/);
    assert.equal(logText(p), '', 'the launcher was never consulted, so nothing was logged');
  } finally {
    p.cleanup();
  }
});
