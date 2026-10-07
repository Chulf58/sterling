// Project identity (decision work-project-identity-file-sterling-project-json):
// .sterling/project.json holds {"project_id": "<uuid v4>"}.
//   - init writes it only when absent, whatever the mode, and never overwrites it;
//   - init's gitignore entry is `.sterling/*` plus `!.sterling/project.json`, and an
//     existing `.sterling/` line is rewritten that way (init and /sterling:update);
//   - sync-agents and /sterling:update refuse a WORK project whose file is missing
//     or invalid, naming the file; a hobby project is never checked.
// The reader itself (absent / present / invalid) is tested in
// packages/schemas/src/tests/project.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withIdentityIgnore, workIdentityRefusal, ensureProjectIdentity } from '../lib/project-identity.mjs';
import { runUpdate } from '../lib/update.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OTHER_ID = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b';
const STAR = '.sterling/*';
const KEEP = '!.sterling/project.json';

const scratchDirs = new Set();
const scratch = (prefix = 'sterling-identity-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.add(d);
  return d;
};
after(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const lines = (dir) => readFileSync(join(dir, '.gitignore'), 'utf8').split(/\r?\n/);
const identityPath = (dir) => join(dir, '.sterling', 'project.json');
const readIdentityFile = (dir) => JSON.parse(readFileSync(identityPath(dir), 'utf8'));

// ---------------------------------------------------------------- the gitignore line

test('withIdentityIgnore: `.sterling/` becomes `.sterling/*` plus the negation, in place, other lines kept', () => {
  const r = withIdentityIgnore('node_modules/\n.sterling/\ndist/\n', { addIfAbsent: false });
  assert.equal(r.changed, true);
  assert.equal(r.text, `node_modules/\n${STAR}\n${KEEP}\ndist/\n`);
});

test('withIdentityIgnore: an existing `.sterling/*` without the negation gains it; one with it is unchanged', () => {
  assert.equal(withIdentityIgnore(`${STAR}\nx\n`, { addIfAbsent: false }).text, `${STAR}\n${KEEP}\nx\n`);
  const done = `a\n${STAR}\n${KEEP}\nb\n`;
  assert.deepEqual(withIdentityIgnore(done, { addIfAbsent: false }), { text: done, changed: false });
});

test('withIdentityIgnore: a negation that sits before the star is moved after it (git reads the last match)', () => {
  assert.equal(withIdentityIgnore(`${KEEP}\n${STAR}\n`, { addIfAbsent: false }).text, `${STAR}\n${KEEP}\n`);
});

test('withIdentityIgnore: both `.sterling/` and `.sterling/*` collapse to one pair', () => {
  assert.equal(withIdentityIgnore(`.sterling/\n${STAR}\n`, { addIfAbsent: false }).text, `${STAR}\n${KEEP}\n`);
});

test('withIdentityIgnore: with no Sterling line, update leaves the file alone and init appends the pair', () => {
  assert.deepEqual(withIdentityIgnore('dist/\n', { addIfAbsent: false }), { text: 'dist/\n', changed: false });
  assert.deepEqual(withIdentityIgnore('', { addIfAbsent: false }), { text: '', changed: false });
  assert.equal(withIdentityIgnore('dist/\n', { addIfAbsent: true }).text, `dist/\n${STAR}\n${KEEP}\n`);
  assert.equal(withIdentityIgnore('', { addIfAbsent: true }).text, `${STAR}\n${KEEP}\n`);
});

test('withIdentityIgnore: CRLF files keep CRLF, a missing final newline is added, and a second pass is a no-op', () => {
  const crlf = withIdentityIgnore('a\r\n.sterling/\r\n', { addIfAbsent: false });
  assert.equal(crlf.text, `a\r\n${STAR}\r\n${KEEP}\r\n`);
  assert.equal(withIdentityIgnore('a\n.sterling/', { addIfAbsent: false }).text, `a\n${STAR}\n${KEEP}\n`);
  assert.equal(withIdentityIgnore(crlf.text, { addIfAbsent: false }).changed, false);
});

test('withIdentityIgnore: lookalike lines are not the Sterling entry', () => {
  for (const other of ['.sterling', '/.sterling/', '.sterling/transient/', '# .sterling/']) {
    assert.equal(withIdentityIgnore(`${other}\n`, { addIfAbsent: false }).changed, false, other);
  }
});

// ---------------------------------------------------------------- the helpers

test('ensureProjectIdentity: creates a UUID v4 file when absent, never overwrites a valid or an invalid one', () => {
  const dir = scratch();
  mkdirSync(join(dir, '.sterling'));
  const created = ensureProjectIdentity(dir);
  assert.equal(created.status, 'created');
  assert.match(created.project_id, UUID_V4);
  assert.deepEqual(readIdentityFile(dir), { project_id: created.project_id });
  assert.deepEqual(ensureProjectIdentity(dir), { status: 'exists', project_id: created.project_id });

  writeFileSync(identityPath(dir), `{"project_id": "${OTHER_ID}", "note": "hand edit"}\n`);
  assert.deepEqual(ensureProjectIdentity(dir), { status: 'exists', project_id: OTHER_ID });
  assert.equal(readFileSync(identityPath(dir), 'utf8'), `{"project_id": "${OTHER_ID}", "note": "hand edit"}\n`);

  writeFileSync(identityPath(dir), '{ broken');
  const invalid = ensureProjectIdentity(dir);
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.error, /not valid JSON/);
  assert.equal(readFileSync(identityPath(dir), 'utf8'), '{ broken');
});

test('workIdentityRefusal: a work project or a Postgres-storage project is checked; missing and invalid are named refusals', () => {
  const dir = scratch();
  mkdirSync(join(dir, '.sterling'));
  assert.equal(workIdentityRefusal(dir, 'hobby'), null, 'hobby on SQLite is never checked');
  assert.match(workIdentityRefusal(dir, 'work'), /work-mode project has no \.sterling\/project\.json: run \/sterling:init/);
  writeFileSync(identityPath(dir), JSON.stringify({ project_id: 'nope' }));
  assert.equal(workIdentityRefusal(dir, 'hobby'), null, 'hobby on SQLite is not checked even when the file is invalid');
  assert.match(workIdentityRefusal(dir, 'work'), /work-mode project has an invalid \.sterling\/project\.json: .*"nope".*UUID v4/);
  writeFileSync(identityPath(dir), JSON.stringify({ project_id: OTHER_ID }));
  assert.equal(workIdentityRefusal(dir, 'work'), null);
});

test('workIdentityRefusal: storage postgres needs the identity in any mode; the config decides, not the mode alone', () => {
  const dir = scratch();
  mkdirSync(join(dir, '.sterling'));
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: 'hobby', storage: 'postgres' }));
  assert.match(workIdentityRefusal(dir, 'hobby'), /project with storage postgres has no \.sterling\/project\.json: run \/sterling:init/);
  writeFileSync(identityPath(dir), JSON.stringify({ project_id: 'nope' }));
  assert.match(workIdentityRefusal(dir, 'hobby'), /project with storage postgres has an invalid \.sterling\/project\.json/);
  writeFileSync(identityPath(dir), JSON.stringify({ project_id: OTHER_ID }));
  assert.equal(workIdentityRefusal(dir, 'hobby'), null);
  rmSync(identityPath(dir));
  writeFileSync(configPath, JSON.stringify({ mode: 'hobby', storage: 'sqlite' }));
  assert.equal(workIdentityRefusal(dir, 'hobby'), null, 'hobby on explicit SQLite is not checked');
  assert.match(workIdentityRefusal(dir, 'work'), /work-mode project has no/, 'work on SQLite is still checked');
});

test('workIdentityRefusal: an invalid config.storage is a refusal naming it, never a guess', () => {
  const dir = scratch();
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby', storage: 'pg' }));
  assert.match(workIdentityRefusal(dir, 'hobby'), /project storage cannot be read: config\.storage is "pg"/);
});

// ---------------------------------------------------------------- init

function init(dir, args = []) {
  const aux = scratch('sterling-identity-aux-');
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, '--project-name', 'identity-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--domain-description', 'node=test domain node', ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: {
      ...process.env,
      STERLING_REGISTRY_DB: join(aux, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: join(aux, 'pluginroot'),
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      CLAUDE_CONFIG_DIR: join(aux, 'claude'),
      HOME: join(aux, 'home'),
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

test('init on a fresh project writes a valid project.json and ignores .sterling/* except that file', () => {
  const dir = scratch();
  const r = init(dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(readIdentityFile(dir).project_id, UUID_V4);
  assert.deepEqual(Object.keys(readIdentityFile(dir)), ['project_id']);
  assert.match(r.stdout, /^\.sterling\/project\.json\s+created\s+project_id [0-9a-f-]{36}/m);
  const ignore = lines(dir);
  assert.ok(!ignore.includes('.sterling/'), 'the directory ignore is gone');
  assert.ok(ignore.indexOf(STAR) >= 0 && ignore.indexOf(KEEP) === ignore.indexOf(STAR) + 1, `.gitignore carries the pair in order: ${ignore.join('|')}`);
  // git itself agrees: the identity file is committable, the rest of .sterling/ is not
  assert.equal(git(dir, 'init', '-q').status, 0);
  assert.equal(git(dir, 'check-ignore', '-q', '.sterling/project.json').status, 1, 'project.json is NOT ignored');
  for (const f of ['.sterling/sterling.db', '.sterling/config.json']) assert.equal(git(dir, 'check-ignore', '-q', f).status, 0, `${f} stays ignored`);
});

test('init writes the identity file whatever the mode', () => {
  for (const mode of ['hobby', 'work']) {
    const dir = scratch();
    const r = init(dir, ['--mode', mode]);
    assert.equal(r.code, 0, `${mode}: ${r.stderr}${r.stdout}`);
    assert.equal(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).mode, mode);
    assert.match(readIdentityFile(dir).project_id, UUID_V4, mode);
  }
});

test('init on an existing project never overwrites project.json, valid or invalid, and a rerun changes nothing', () => {
  const dir = scratch();
  assert.equal(init(dir).code, 0);
  const first = readFileSync(identityPath(dir), 'utf8');
  const rerun = init(dir);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(readFileSync(identityPath(dir), 'utf8'), first, 'same bytes after a rerun');
  assert.match(rerun.stdout, /^\.sterling\/project\.json\s+exists\b/m);
  const gitignoreAfterFirst = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.equal(init(dir).code, 0);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), gitignoreAfterFirst, 'the gitignore is not appended to again');

  const handEdited = `{"project_id": "${OTHER_ID}", "note": "mine"}\n`;
  writeFileSync(identityPath(dir), handEdited);
  assert.equal(init(dir).code, 0);
  assert.equal(readFileSync(identityPath(dir), 'utf8'), handEdited, 'a hand-edited valid file is left byte for byte');

  writeFileSync(identityPath(dir), '{ broken');
  const bad = init(dir);
  assert.equal(bad.code, 0, bad.stderr);
  assert.equal(readFileSync(identityPath(dir), 'utf8'), '{ broken', 'an invalid file is left untouched');
  assert.match(bad.stdout, /^\.sterling\/project\.json\s+differs\b/m);
  assert.match(bad.stdout, /^warn: .*not valid JSON.*never overwrites it/m);
});

test('init on an existing project (pre-identity: `.sterling/` ignored, no project.json) rewrites the ignore line and creates the file', () => {
  const dir = scratch();
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.sterling/\ndist/\n');
  const r = init(dir);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const ignore = lines(dir);
  assert.ok(!ignore.includes('.sterling/'), 'the old directory ignore is replaced, not kept beside the new one');
  assert.deepEqual(ignore.slice(0, 4), ['node_modules/', STAR, KEEP, 'dist/'], 'rewritten in place');
  assert.match(r.stdout, /^\.gitignore \(\.sterling entry\)\s+refreshed\b/m);
  assert.match(readIdentityFile(dir).project_id, UUID_V4);
  assert.equal(git(dir, 'init', '-q').status, 0);
  assert.equal(git(dir, 'check-ignore', '-q', '.sterling/project.json').status, 1);
});

// ---------------------------------------------------------------- sync-agents

function projectOf({ mode, identity, ignore } = {}) {
  const dir = scratch('sterling-identity-proj-');
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'fixture', ...(mode ? { mode } : {}) }, null, 2) + '\n');
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (identity !== undefined) writeFileSync(identityPath(dir), identity);
  if (ignore !== undefined) writeFileSync(join(dir, '.gitignore'), ignore);
  return dir;
}
const VALID = JSON.stringify({ project_id: OTHER_ID });
const syncAgents = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir });

test('sync-agents: a work project without project.json is refused (exit 2) naming the file; nothing is synced', () => {
  const dir = projectOf({ mode: 'work' });
  const r = syncAgents(dir);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^refused_project_identity: work-mode project has no \.sterling\/project\.json: run \/sterling:init.*; nothing synced$/m);
  assert.ok(!existsSync(join(dir, '.claude', 'agents')), 'no agent was written');
});

test('sync-agents: a work project with an invalid project.json is refused (exit 2), whatever is wrong with it', () => {
  for (const identity of ['{ broken', '[]', '{}', JSON.stringify({ project_id: 'x' })]) {
    const dir = projectOf({ mode: 'work', identity });
    const r = syncAgents(dir);
    assert.equal(r.status, 2, `${identity}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^refused_project_identity: work-mode project has an invalid \.sterling\/project\.json: .*; nothing synced$/m, identity);
    assert.ok(!existsSync(join(dir, '.claude', 'agents')), 'no agent was written');
  }
});

test('sync-agents: a work project with a valid project.json syncs; hobby projects are not checked, with or without the file', () => {
  for (const [label, opts] of [['work, valid', { mode: 'work', identity: VALID }], ['hobby, absent', { mode: 'hobby' }], ['default mode, absent', {}], ['hobby, invalid', { mode: 'hobby', identity: '{ broken' }]]) {
    const dir = projectOf(opts);
    const r = syncAgents(dir);
    assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /refused_project_identity/, label);
    assert.match(r.stdout, /^installed: implementor$/m, label);
  }
});

// ---------------------------------------------------------------- update

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
// git and npm are faked; sync-agents runs for real against the temp targets.
function updateExec() {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const exec = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged ? '0\t0' : '2\t0');
      if (a === 'status --porcelain') return ok('');
      if (a.startsWith('merge --ff-only')) { merged = true; return ok('Fast-forward'); }
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    const script = args[0]?.split(/[\\/]/).pop();
    if (script === 'sync-agents.mjs') {
      const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args.slice(1)], { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (script === 'stamp-contract.mjs') return ok('0 refusal(s).\n');
    return ok('done');
  };
  return { exec, calls };
}
async function update(projects) {
  const { exec, calls } = updateExec();
  const out = [];
  const report = await runUpdate({ cwd: scratch('sterling-identity-cwd-'), exec, log: (l) => out.push(l), projects: projects.map((p) => ({ name: p.split(/[\\/]/).pop(), repo_path: p })), opts: {} });
  return { report, log: out.join('\n'), syncCalls: calls.filter((c) => c.includes('sync-agents.mjs')) };
}

test('update: a work project without project.json is refused (exit 2) naming the file; nothing is synced for it', async () => {
  const dir = projectOf({ mode: 'work', ignore: '.sterling/\n' });
  const { report, log, syncCalls } = await update([dir]);
  assert.equal(report.exit, 2, log);
  assert.match(log, /✗ .*REFUSED — work-mode project has no \.sterling\/project\.json: run \/sterling:init/);
  assert.equal(syncCalls.length, 0, 'sync-agents is not run for the refused project');
  assert.equal(report.projects[0].handoff, 'refused_project_identity');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.sterling/\n', 'a refused project is not touched');
});

test('update: a work project with an invalid project.json is refused (exit 2); one with a valid file is refreshed', async () => {
  const bad = projectOf({ mode: 'work', identity: JSON.stringify({ project_id: 'nope' }) });
  const good = projectOf({ mode: 'work', identity: VALID });
  const { report, log, syncCalls } = await update([bad, good]);
  assert.equal(report.exit, 2, log);
  assert.match(log, /✗ .*REFUSED — work-mode project has an invalid \.sterling\/project\.json: .*"nope".*UUID v4/);
  assert.deepEqual(syncCalls.map((c) => c.split(' ').pop()), [good], 'only the valid project is synced; the refusal does not stop the next one');
  assert.deepEqual(report.projects.map((p) => p.handoff === 'refused_project_identity'), [true, false]);
});

test('update: a hobby project is not checked for project.json, with the file absent or invalid', async () => {
  const absent = projectOf({ mode: 'hobby' });
  const invalid = projectOf({ identity: '{ broken' });
  const { report, log, syncCalls } = await update([absent, invalid]);
  assert.equal(report.exit, 0, log);
  assert.doesNotMatch(log, /project\.json/);
  assert.equal(syncCalls.length, 2);
});

test('update repairs an existing project\'s `.sterling/` ignore line, hobby or work, and a second run is a no-op', async () => {
  const hobby = projectOf({ mode: 'hobby', ignore: 'dist/\n.sterling/\n' });
  const work = projectOf({ mode: 'work', identity: VALID, ignore: '.sterling/\n' });
  const none = projectOf({ mode: 'hobby', ignore: 'dist/\n' });
  const { report, log } = await update([hobby, work, none]);
  assert.equal(report.exit, 0, log);
  assert.deepEqual(lines(hobby).slice(0, 3), ['dist/', STAR, KEEP]);
  assert.deepEqual(lines(work).slice(0, 2), [STAR, KEEP]);
  assert.equal(readFileSync(join(none, '.gitignore'), 'utf8'), 'dist/\n', 'a project with no Sterling ignore line gains none from update');
  assert.deepEqual(report.projects.map((p) => p.gitignore_repaired === true), [true, true, false]);
  assert.match(log, /\.gitignore: \.sterling\/ is now \.sterling\/\* plus !\.sterling\/project\.json/);
  const before = readFileSync(join(hobby, '.gitignore'), 'utf8');
  const again = await update([hobby, work, none]);
  assert.equal(readFileSync(join(hobby, '.gitignore'), 'utf8'), before);
  assert.deepEqual(again.report.projects.map((p) => p.gitignore_repaired === true), [false, false, false]);
  assert.equal(git(hobby, 'init', '-q').status, 0);
  assert.equal(git(hobby, 'check-ignore', '-q', '.sterling/project.json').status, 1, 'project.json is committable after the repair');
});
