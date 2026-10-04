// The domain map runs by itself after an update (board item
// the-domain-map-runs-by-itself-the-first-time-after-an-update; decision
// consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command):
//   - /sterling:update's per-project pass runs the map for each project and prints a
//     proposal when there is one. It never applies it.
//   - the first session start after the update prints one line pointing at
//     /sterling:domains, once. On a clone the update leaves .sterling/domain-map-pending
//     for H1 to consume; on an installed copy the trigger is the post-update sync.
//   - session start refreshes the project's stack tags in the registry, so a mount added
//     by a config edit reaches other projects by the adding project's next session start.
// Every run uses a scratch HOME and a scratch registry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SterlingStore, ProjectRegistry, createDomain } from '@sterling/store';
import { runUpdate, UPDATE_MARKER_RELATIVE_PATH, DOMAIN_MAP_PENDING_REL } from '../lib/update.mjs';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realDomains = join(root, 'scripts', 'domains.mjs');
const sourceH1 = join(root, 'scripts', 'hooks', 'h1-session-start.mjs');
const HEAD = 'a'.repeat(40);
const VERSION = '9.9.9-fixture';

let seam;
before(async () => {
  seam = await buildSeamHook('h1-session-start.mjs');
});
const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  seam?.cleanup();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const fwd = (p) => p.replace(/\\/g, '/');
const configOf = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
const pendingOf = (dir) => existsSync(join(dir, DOMAIN_MAP_PENDING_REL));

// A machine in a scratch HOME: initialized projects, a registry, domain stores.
function machine() {
  const home = tmp('sterling-dmu-home-');
  const registryDb = join(home, 'registry.db');
  const env = { ...process.env, HOME: home, STERLING_REGISTRY_DB: registryDb, NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_CURRENCY_DISABLE: '1', STERLING_MAINTENANCE_WORKER_DISABLE: '1' };
  const withRegistry = (fn) => {
    const registry = new ProjectRegistry(registryDb);
    try {
      return fn(registry);
    } finally {
      registry.close();
    }
  };
  const addProject = (name, tags, { register = true } = {}) => {
    const dir = join(tmp('sterling-dmu-proj-'), name);
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: name, stack_tags: tags, toolchains: [], backup_opt_out: true }, null, 2));
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
    if (register) withRegistry((r) => r.register({ repo_path: fwd(dir), name, stack_tags: tags, toolchains: [], sterling_version: '0.0.0', at: '2026-10-01T00:00:00.000Z' }));
    return dir;
  };
  const addStore = (name) => createDomain(name, `${name} facts`, join(home, '.sterling', 'domains', name, 'sterling.db'));
  const rowOf = (dir) => withRegistry((r) => r.list().find((p) => p.repo_path === fwd(dir)) ?? null);

  // The already-current path of runUpdate: git answers "nothing to pull", the agent sync is
  // a stub, and the domain map is the real scripts/domains.mjs under this machine's env.
  const update = async (projects) => {
    const cwd = tmp('sterling-dmu-clone-');
    mkdirSync(dirname(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), { recursive: true });
    writeFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), JSON.stringify({ sha: HEAD, completed_at: new Date().toISOString() }));
    const calls = [];
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git') {
        const a = args.join(' ');
        if (a === 'rev-parse --git-dir') return ok('.git');
        if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
        if (a === 'rev-parse HEAD') return ok(HEAD);
        if (a.startsWith('describe')) return ok('v0.2.0');
        if (a === 'remote') return ok('origin');
        if (a.startsWith('symbolic-ref')) return ok('origin/main');
        if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD);
        if (a.startsWith('rev-list --left-right --count')) return ok('0\t0');
        return ok('');
      }
      if (args[0]?.endsWith('sync-agents.mjs')) return ok('up_to_date: implementor\n');
      if (args[0]?.endsWith('domains.mjs')) {
        const r = spawnSync(process.execPath, [realDomains, ...args.slice(1)], { encoding: 'utf8', cwd, timeout: 60_000, env });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      return ok('');
    };
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: projects.map((dir) => ({ name: configOf(dir).project_name, repo_path: fwd(dir) })), opts: {}, pluginRoot: null });
    return { report, calls, out: lines.join('\n') };
  };

  const sessionStart = (dir, { hook = sourceH1, extraEnv = {} } = {}) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't.jsonl'), cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
      cwd: dir,
      timeout: 120_000,
      env: { ...env, ...extraEnv },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    return { sys: out.systemMessage ?? '', ctx: out.hookSpecificOutput?.additionalContext ?? '' };
  };
  const map = (dir) => {
    const r = spawnSync(process.execPath, [realDomains, '--json'], { encoding: 'utf8', cwd: dir, timeout: 60_000, env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { env, addProject, addStore, rowOf, update, sessionStart, map };
}

// A project named like a domain it does not mount: the map proposes its own subject.
function withProposal(m, opts) {
  m.addStore('salesforce');
  m.addStore('genesys');
  m.addStore('sterling');
  return m.addProject('salesforce', ['genesys', 'sterling'], opts);
}

const DOMAIN_LINE = /domain map/i;

test('an updated project with a proposal gets the update output and one session-start line, once; nothing is applied', async () => {
  const m = machine();
  const dir = withProposal(m);
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');

  const u = await m.update([dir]);
  assert.equal(u.report.exit, 0, u.out);
  const domainCalls = u.calls.filter((c) => c.includes('domains.mjs'));
  assert.equal(domainCalls.length, 1, 'the map runs once for the project');
  assert.ok(domainCalls[0].includes(`--target ${fwd(dir)}`) && domainCalls[0].includes('--json'), domainCalls[0]);
  assert.ok(!u.calls.some((c) => c.includes('--apply')), 'update never applies a mount');
  assert.match(u.out, /domains: proposes adding 'salesforce'/);
  assert.match(u.out, /\/sterling:domains/);
  assert.match(u.out, /[Nn]othing was applied/);
  assert.ok(pendingOf(dir), 'the update leaves the pending marker for the next session start');

  const first = m.sessionStart(dir);
  assert.match(first.sys, DOMAIN_LINE);
  assert.match(first.sys, /\/sterling:domains/);
  assert.equal(first.ctx.split('\n').filter((l) => /^DOMAIN MAP \(H1/.test(l)).length, 1, 'one line for the conductor');
  assert.match(first.ctx, /DOMAIN MAP \(H1[^\n]*'salesforce'[^\n]*\/sterling:domains/);
  assert.ok(!pendingOf(dir), 'the session start that prints the line removes the marker');

  const second = m.sessionStart(dir);
  assert.doesNotMatch(second.sys, DOMAIN_LINE);
  assert.doesNotMatch(second.ctx, /DOMAIN MAP \(H1/);

  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before, 'config.json is byte-identical: nothing was applied');
  assert.deepEqual(m.rowOf(dir).stack_tags, ['genesys', 'sterling'], 'the registry row still carries the old mounts');
});

test('a project with no proposal gets no update output and no session-start line', async () => {
  const m = machine();
  m.addStore('sterling');
  const dir = m.addProject('plain', ['sterling']);

  const u = await m.update([dir]);
  assert.equal(u.report.exit, 0, u.out);
  assert.equal(u.calls.filter((c) => c.includes('domains.mjs')).length, 1, 'the map still runs');
  assert.doesNotMatch(u.out, /domains:/);
  assert.ok(!pendingOf(dir));

  const s = m.sessionStart(dir);
  assert.doesNotMatch(s.sys, DOMAIN_LINE);
  assert.doesNotMatch(s.ctx, /DOMAIN MAP \(H1/);
});

test('without an update, a session start prints no domain line even when the map has a proposal', () => {
  const m = machine();
  const dir = withProposal(m);
  const s = m.sessionStart(dir);
  assert.doesNotMatch(s.sys, DOMAIN_LINE);
  assert.doesNotMatch(s.ctx, /DOMAIN MAP \(H1/);
});

test('a proposal applied before the next session start prints no line, and the marker is still removed', async () => {
  const m = machine();
  const dir = withProposal(m);
  await m.update([dir]);
  assert.ok(pendingOf(dir));
  const applied = spawnSync(process.execPath, [realDomains, '--apply', '--add', 'salesforce'], { encoding: 'utf8', cwd: dir, timeout: 60_000, env: m.env });
  assert.equal(applied.status, 0, applied.stderr);

  const s = m.sessionStart(dir);
  assert.doesNotMatch(s.sys, DOMAIN_LINE);
  assert.ok(!pendingOf(dir));
});

test('a failing domain map is reported by the update and does not fail it', async () => {
  const m = machine();
  m.addStore('sterling');
  const dir = m.addProject('plain', ['sterling']);
  // stack_tags of the wrong type: the project mode still reads, and the map CLI refuses.
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'plain', stack_tags: 'sterling' }));
  const u = await m.update([dir]);
  assert.match(u.out, /domain map FAILED \(nonfatal\)/);
  assert.ok(!pendingOf(dir));
});

test('a mount added by a config edit is in the registry, and in another project\'s view, after the adding project\'s next session start', () => {
  const m = machine();
  m.addStore('sterling');
  m.addStore('genesys');
  const adder = m.addProject('adder', ['sterling']);
  const other = m.addProject('other', ['genesys', 'sterling']);

  const config = configOf(adder);
  writeFileSync(join(adder, '.sterling', 'config.json'), JSON.stringify({ ...config, stack_tags: ['genesys', 'sterling'] }, null, 2));
  assert.deepEqual(m.rowOf(adder).stack_tags, ['sterling'], 'the registry still holds the old mounts before the session start');
  assert.match(m.sessionStart(other).ctx, /- adder: sterling$/m, 'the sibling list of the other project reads the registry');

  m.sessionStart(adder);
  const row = m.rowOf(adder);
  assert.deepEqual(row.stack_tags, ['genesys', 'sterling'], 'session start refreshes the row\'s stack tags');
  assert.equal(row.sterling_version, '0.0.0', 'the row\'s init version is untouched');
  assert.equal(row.last_init_at, '2026-10-01T00:00:00.000Z', 'the row\'s init date is untouched');

  assert.match(m.sessionStart(other).ctx, /- adder: genesys, sterling$/m);
  const genesys = m.map(other).domains.find((d) => d.name === 'genesys');
  assert.deepEqual(genesys.mounted_by, ['adder', 'other']);
});

// ---- installed copy: the trigger is the post-update sync, with no marker of its own ----

// A script that appends its argv to $FIXTURE_LOG, prints, and exits with the named env code.
const LOGGING_SCRIPT = (name, stdout, exitEnv) =>
  `import { appendFileSync } from 'node:fs';\n` +
  `appendFileSync(process.env.FIXTURE_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n` +
  `process.stdout.write(${JSON.stringify(stdout)});\n` +
  `process.exit(Number(process.env.${exitEnv} ?? 0));\n`;

// No .git, so it is an installed copy. Its domains.mjs logs the call and runs the real CLI.
function installedPluginRoot() {
  const dir = tmp('sterling-dmu-plugin-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: VERSION }));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'sync-agents.mjs'), LOGGING_SCRIPT('sync-agents', 'up_to_date: implementor\n', 'FIXTURE_SYNC_EXIT'));
  writeFileSync(join(dir, 'bin', 'stamp-contract.mjs'), LOGGING_SCRIPT('stamp-contract', 'stamp-contract: 1 already in sync — 1 project(s) processed\n', 'FIXTURE_CONTRACT_EXIT'));
  writeFileSync(
    join(dir, 'bin', 'domains.mjs'),
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(process.env.FIXTURE_LOG, 'domains ' + process.argv.slice(2).join(' ') + '\\n');\n` +
      `await import(${JSON.stringify(pathToFileURL(realDomains).href)});\n`
  );
  return dir;
}

test('installed copy: the first session after a version change registers an unregistered project before the sync and prints the line once', () => {
  const m = machine();
  const dir = withProposal(m, { register: false });
  const plugin = installedPluginRoot();
  const log = join(tmp('sterling-dmu-log-'), 'calls.log');
  const run = (extraEnv = {}) => m.sessionStart(dir, { hook: seam.hookPath, extraEnv: { STERLING_PLUGIN_ROOT: plugin, FIXTURE_LOG: log, ...extraEnv } });
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  assert.equal(m.rowOf(dir), null);

  const first = run();
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(calls, ['domains', 'sync-agents', 'stamp-contract'], 'the map runs before the sync, so the sync finds the project registered');
  assert.deepEqual(m.rowOf(dir)?.stack_tags, ['genesys', 'sterling'], 'the project is registered with its current mounts');
  assert.match(first.sys, DOMAIN_LINE);
  assert.match(first.ctx, /DOMAIN MAP \(H1[^\n]*'salesforce'[^\n]*\/sterling:domains/);
  assert.match(first.ctx, /DOMAIN MAP \(H1[^\n]*now registered/);
  assert.ok(!pendingOf(dir), 'an installed copy needs no marker: the sync marker is the once-only state');

  const second = run();
  assert.doesNotMatch(second.sys, DOMAIN_LINE);
  assert.doesNotMatch(second.ctx, /DOMAIN MAP \(H1/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 3, 'nothing runs again once the versions are equal');
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before, 'nothing was applied');
});

test('installed copy: a failed sync holds the line back until the session whose sync succeeds', () => {
  const m = machine();
  const dir = withProposal(m);
  const plugin = installedPluginRoot();
  const log = join(tmp('sterling-dmu-log-'), 'calls.log');
  const run = (extraEnv = {}) => m.sessionStart(dir, { hook: seam.hookPath, extraEnv: { STERLING_PLUGIN_ROOT: plugin, FIXTURE_LOG: log, ...extraEnv } });

  const failed = run({ FIXTURE_SYNC_EXIT: '1' });
  assert.match(failed.sys, /post-update sync FAILED/);
  assert.doesNotMatch(failed.sys, DOMAIN_LINE);
  assert.doesNotMatch(failed.ctx, /DOMAIN MAP \(H1/);

  const synced = run();
  assert.match(synced.sys, DOMAIN_LINE);
  const after = run();
  assert.doesNotMatch(after.sys, DOMAIN_LINE);
});
