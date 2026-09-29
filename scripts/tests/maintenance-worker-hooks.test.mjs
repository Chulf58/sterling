// [finding 8] A worker failure, back-off or daily cap reaches the SESSION, not
// only a log: H10 carries the launcher's line in its Stop systemMessage and
// H19 carries it in its Bash PostToolUse additionalContext (decision
// maintenance-queue-background-haiku-worker-simple-redesign; P5).
// Safety: every case here stops at the back-off/cap check, before any spawn,
// and PATH excludes the claude binary as a second guard.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

const failedRecently = () => ({ spend: {}, last_run: { ok: false, at: new Date(Date.now() - 60_000).toISOString(), error: 'error result (error_max_budget_usd)' } });

test('H10 Stop: an active back-off after a failed run is shown in the systemMessage, and no worker starts', () => {
  const p = project(failedRecently());
  try {
    const r = run('h10-direct-capture.mjs', p.dir, { hook_event_name: 'Stop' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /maintenance worker: last run FAILED .*error_max_budget_usd.*backing off/);
    assert.equal(existsSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.lock')), false, 'nothing launched');
  } finally {
    p.cleanup();
  }
});

test('H19 Bash `git commit`: the daily-cap line rides additionalContext, and no worker starts', () => {
  const today = new Date().toISOString().slice(0, 10);
  const p = project({ spend: { [today]: 5 } });
  try {
    const r = run('h19-bash-delivery.mjs', p.dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, tool_response: { stdout: '' } });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /maintenance worker: daily budget reached \(\$5\.00 of \$5\.00/);
    assert.equal(existsSync(join(p.dir, '.sterling', 'transient', 'maintenance-worker.lock')), false, 'nothing launched');
  } finally {
    p.cleanup();
  }
});

test('H19 Bash without a commit never consults the launcher', () => {
  const p = project(failedRecently());
  try {
    const r = run('h19-bash-delivery.mjs', p.dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '' } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /maintenance worker/);
  } finally {
    p.cleanup();
  }
});
