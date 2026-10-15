// list-projects --remove <path> [--apply] (decision
// remove-a-project-store-list-projects-remove-backup-first-refuse-if-open, GitHub #109).
// Every case spawns the script against temp dirs with STERLING_REGISTRY_DB isolated, so the
// real ~/.sterling is never touched. OPENCODE and OPENCODE_SESSION_ID are cleared in the
// child env (anti_pattern ddf7ad45).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'list-projects.mjs');

let ProjectRegistry;
let SterlingStore;
let tmp;
before(async () => {
  ({ ProjectRegistry, SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  tmp = mkdtempSync(join(tmpdir(), 'sterling-list-projects-remove-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const T = '2026-10-15T10:00:00.000Z';

/** A fresh sandbox: its own registry file, backup root and project folder with a real store. */
function sandbox({ config = {}, register = true, name = 'demo' } = {}) {
  const dir = mkdtempSync(join(tmp, 'case-'));
  const registryDb = join(dir, 'registry.db');
  const backups = join(dir, 'backups');
  const project = join(dir, name);
  const sterling = join(project, '.sterling');
  mkdirSync(sterling, { recursive: true });
  const store = new SterlingStore(join(sterling, 'sterling.db'));
  const base = { created_at: T, updated_at: T, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
  store.create({ ...base, id: randomUUID(), type: 'todo', text: 'an open board item', source: 'user' });
  store.create({ ...base, id: randomUUID(), type: 'decision', title: 'a decision', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [] });
  store.close();
  writeFileSync(join(sterling, 'config.json'), JSON.stringify({ stack_tags: [], backup_path: backups, ...config }));
  mkdirSync(join(sterling, 'session-scratch'));
  writeFileSync(join(project, 'AGENTS.md'), '# agents\n');
  writeFileSync(join(project, 'CLAUDE.md'), '# claude\n');
  mkdirSync(join(project, '.opencode'));
  writeFileSync(join(project, '.opencode', 'opencode.json'), '{}');
  writeFileSync(join(project, 'opencode.sh'), '#!/bin/sh\n');
  writeFileSync(join(project, 'src.txt'), 'user file\n');
  if (register) reg(registryDb, project, name);
  return { dir, registryDb, backups, project, sterling };
}

function reg(registryDb, repoPath, name, stackTags = []) {
  const r = new ProjectRegistry(registryDb);
  r.register({ repo_path: repoPath, name, stack_tags: stackTags, toolchains: [], sterling_version: null, at: T });
  r.close();
}

function rows(registryDb) {
  const r = new ProjectRegistry(registryDb);
  try {
    return r.list().map((p) => p.repo_path);
  } finally {
    r.close();
  }
}

function run(registryDb, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_REGISTRY_DB: registryDb, OPENCODE: undefined, OPENCODE_SESSION_ID: undefined },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

test('dry run lists target, registration, counts, other entries, leftovers and backup; exits 0; changes nothing', () => {
  const s = sandbox();
  const r = run(s.registryDb, '--remove', s.project);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`Directory to delete: ${s.sterling}`), r.out);
  assert.ok(r.out.includes(`registered under demo (${s.project})`), r.out);
  assert.match(r.out, /Records by type: .*decision 1.*todo 1/, r.out);
  assert.match(r.out, /Open board items: 1/, r.out);
  assert.match(r.out, /Other entries inside \.sterling \(deleted too\): .*config\.json.*session-scratch\//, r.out);
  assert.match(r.out, /Left in place outside \.sterling \(never deleted\): AGENTS\.md, CLAUDE\.md, \.opencode, opencode\.sh/, r.out);
  assert.match(r.out, /\.opencode is still active/, r.out);
  assert.ok(r.out.includes(`Backup destination: ${join(s.backups, 'removed-demo-')}`), r.out);
  assert.match(r.out, /--apply would proceed/, r.out);
  assert.ok(existsSync(s.sterling));
  assert.deepEqual(readdirSync(s.sterling).filter((f) => f.startsWith('sterling.db')).sort(), ['sterling.db'], 'no -wal/-shm litter from the preview');
  assert.ok(!existsSync(s.backups), 'the dry run makes no backup');
  assert.deepEqual(rows(s.registryDb), [s.project]);
});

test('dry run on an unregistered store says "not registered"', () => {
  const s = sandbox({ register: false });
  const r = run(s.registryDb, '--remove', s.project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Registry: not registered/, r.out);
  assert.match(r.out, /Backup destination: .*removed-demo-/, r.out);
});

test('flag refusals: unknown flag, --apply without --remove, --remove with --prune-missing, --remove without a path', () => {
  const s = sandbox();
  for (const args of [['--bogus'], ['--apply'], ['--remove', s.project, '--prune-missing'], ['--remove'], ['--remove', s.project, 'extra']]) {
    const r = run(s.registryDb, ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /list-projects REFUSED/, r.out);
  }
  assert.ok(existsSync(s.sterling));
});

/** Expect both the dry run and --apply to refuse with `pattern`, deleting nothing. */
function expectRefusal(s, target, pattern) {
  const dry = run(s.registryDb, '--remove', target);
  assert.notEqual(dry.code, 0, dry.out);
  assert.match(dry.out, /--apply would REFUSE/, dry.out);
  assert.match(dry.out, pattern, dry.out);
  const app = run(s.registryDb, '--remove', target, '--apply');
  assert.equal(app.code, 1, app.out);
  const res = JSON.parse(app.stdout);
  assert.equal(res.ok, false);
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].step, 'validate');
  assert.ok(res.steps[0].refusals.some((x) => pattern.test(x)), app.out);
  assert.ok(existsSync(s.sterling), '.sterling is untouched');
  assert.ok(!existsSync(s.backups), 'no backup was made');
}

test('refuses a symlinked target path', () => {
  const s = sandbox();
  const link = join(s.dir, 'alias');
  symlinkSync(s.project, link);
  expectRefusal(s, link, /is a symlink/);
});

test('refuses a target whose .sterling is a symlink', () => {
  const s = sandbox({ register: false });
  const real = join(s.dir, 'real-sterling');
  rmSync(s.sterling, { recursive: true });
  mkdirSync(real);
  writeFileSync(join(real, 'config.json'), '{}');
  symlinkSync(real, s.sterling);
  expectRefusal(s, s.project, /\.sterling is a symlink/);
  assert.ok(existsSync(join(real, 'config.json')));
});

test('refuses a missing path and a missing .sterling', () => {
  const s = sandbox();
  const gone = run(s.registryDb, '--remove', join(s.dir, 'nope'));
  assert.equal(gone.code, 1, gone.out);
  assert.match(gone.out, /does not exist/, gone.out);
  const bare = join(s.dir, 'bare');
  mkdirSync(bare);
  const r = run(s.registryDb, '--remove', bare, '--apply');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /nothing to remove: .*bare\/\.sterling does not exist and no registry row matches/, r.out);
});

test('no row and no .sterling: the dry run and --apply refuse with "nothing to remove"', () => {
  const s = sandbox({ register: false });
  rmSync(s.sterling, { recursive: true });
  const dry = run(s.registryDb, '--remove', s.project);
  assert.equal(dry.code, 1, dry.out);
  assert.match(dry.out, /--apply would REFUSE:\n  - nothing to remove: /, dry.out);
  const app = run(s.registryDb, '--remove', s.project, '--apply');
  assert.equal(app.code, 1, app.out);
  const res = JSON.parse(app.stdout);
  assert.deepEqual(res.steps.map((x) => [x.step, x.ok]), [['validate', false]]);
  assert.match(res.steps[0].refusals[0], /^nothing to remove: /);
  assert.ok(existsSync(join(s.project, 'src.txt')));
});

test('row present, .sterling gone: the dry run says it only unregisters, exit 0, changes nothing', () => {
  const s = sandbox();
  rmSync(s.sterling, { recursive: true });
  const r = run(s.registryDb, '--remove', s.project);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /store already removed.*--apply only unregisters demo\./i, r.out);
  assert.doesNotMatch(r.out, /REFUSE/, r.out);
  assert.deepEqual(rows(s.registryDb), [s.project]);
});

test('row present, .sterling gone: --apply runs validate then unregister only; no backup, files untouched', () => {
  const s = sandbox();
  rmSync(s.sterling, { recursive: true });
  const r = run(s.registryDb, '--remove', s.project, '--apply');
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.map((x) => [x.step, x.ok]), [['validate', true], ['unregister', true]]);
  assert.equal(res.steps[0].mode, 'unregister-only');
  assert.equal(res.steps[1].removed, s.project);
  assert.deepEqual(rows(s.registryDb), []);
  assert.ok(!existsSync(s.backups), 'no backup is made');
  for (const f of ['AGENTS.md', 'src.txt', '.opencode/opencode.json']) assert.ok(existsSync(join(s.project, f)), `${f} is untouched`);
});

test('row present, .sterling gone: identity refusals still hold (several rows, symlinked path)', () => {
  const s = sandbox();
  rmSync(s.sterling, { recursive: true });
  const link = join(s.dir, 'alias');
  symlinkSync(s.project, link);
  const viaLink = run(s.registryDb, '--remove', link, '--apply');
  assert.equal(viaLink.code, 1, viaLink.out);
  assert.match(viaLink.out, /is a symlink/, viaLink.out);
  reg(s.registryDb, `${s.project}/`, 'demo-dup');
  const dup = run(s.registryDb, '--remove', s.project, '--apply');
  assert.equal(dup.code, 1, dup.out);
  assert.match(dup.out, /2 registry rows match this path/, dup.out);
  assert.equal(rows(s.registryDb).length, 2, 'no row removed');
});

test('refuses when several registry rows match the path', () => {
  const s = sandbox();
  reg(s.registryDb, `${s.project}/`, 'demo-dup');
  expectRefusal(s, s.project, /2 registry rows match this path/);
  assert.equal(rows(s.registryDb).length, 2);
});

test('refuses without .sterling/config.json', () => {
  const s = sandbox();
  rmSync(join(s.sterling, 'config.json'));
  expectRefusal(s, s.project, /no .*config\.json; this is not a Sterling store/);
});

test('refuses a Postgres-backed config', () => {
  const s = sandbox({ config: { storage: 'postgres', mode: 'work' } });
  expectRefusal(s, s.project, /storage 'postgres'/);
});

test('refuses without backup_path', () => {
  const s = sandbox({ config: { backup_path: undefined, backup_opt_out: true } });
  expectRefusal(s, s.project, /no backup_path .*the backup cannot be skipped/);
});

test('refuses when another registered project mounts a domain store inside the target .sterling', () => {
  const s = sandbox();
  const other = join(s.dir, 'other');
  mkdirSync(join(other, '.sterling'), { recursive: true });
  writeFileSync(join(other, '.sterling', 'config.json'), JSON.stringify({ stack_tags: ['shared'], domain_paths: { shared: join(s.sterling, 'domains', 'shared', 'sterling.db') } }));
  reg(s.registryDb, other, 'other', ['shared']);
  expectRefusal(s, s.project, /registered project other .* mounts domain 'shared'/);
});

test('refuses while another process holds the store open, naming its pid', async () => {
  const s = sandbox();
  const holder = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(join(s.sterling, 'sterling.db'))}); db.prepare('SELECT 1').get(); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => {
      holder.stdout.on('data', (d) => d.toString().includes('ready') && res());
      holder.on('exit', (c) => rej(new Error(`holder exited ${c}`)));
    });
    expectRefusal(s, s.project, new RegExp(`process ${holder.pid} \\(.*\\) has .*sterling\\.db open`));
  } finally {
    holder.kill();
  }
});

test('--apply on a registered store: verified backup, .sterling gone, row gone, outside files untouched', () => {
  const s = sandbox();
  const otherRow = join(s.dir, 'keep');
  mkdirSync(otherRow);
  reg(s.registryDb, otherRow, 'keep');
  const dbBytes = readFileSync(join(s.sterling, 'sterling.db'));
  const r = run(s.registryDb, '--remove', s.project, '--apply');
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.map((x) => [x.step, x.ok]), [['validate', true], ['backup', true], ['verify', true], ['recheck', true], ['delete', true], ['unregister', true]]);
  assert.equal(res.steps[5].removed, s.project);
  const dest = res.steps[1].destination;
  assert.match(dest, /\/removed-demo-\d{8}T\d{6}Z$/);
  assert.ok(dest.startsWith(s.backups));
  assert.deepEqual(readFileSync(join(dest, 'sterling.db')), dbBytes, 'backup db is byte-identical');
  assert.ok(existsSync(join(dest, 'config.json')) && existsSync(join(dest, 'session-scratch')));
  assert.ok(!existsSync(s.sterling), '.sterling is deleted');
  assert.deepEqual(rows(s.registryDb), [otherRow], 'only the target row is removed');
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.opencode/opencode.json', 'opencode.sh', 'src.txt']) assert.ok(existsSync(join(s.project, f)), `${f} is untouched`);
});

test('--apply on an unregistered store deletes it and skips unregister', () => {
  const s = sandbox({ register: false });
  const r = run(s.registryDb, '--remove', s.project, '--apply');
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.at(-1), { step: 'unregister', ok: true, skipped: 'not registered' });
  assert.ok(existsSync(join(res.steps[1].destination, 'sterling.db')));
  assert.ok(!existsSync(s.sterling));
  assert.ok(existsSync(join(s.project, 'src.txt')));
});

test('a backup failure (unwritable backup_path) deletes nothing and keeps the row', () => {
  const s = sandbox();
  mkdirSync(s.backups);
  chmodSync(s.backups, 0o500);
  try {
    const r = run(s.registryDb, '--remove', s.project, '--apply');
    assert.equal(r.code, 1, r.out);
    const res = JSON.parse(r.stdout);
    assert.deepEqual(res.steps.map((x) => [x.step, x.ok]), [['validate', true], ['backup', false]]);
    assert.match(res.steps[1].note, /nothing was deleted/);
    assert.ok(existsSync(join(s.sterling, 'sterling.db')), '.sterling is untouched');
    assert.deepEqual(rows(s.registryDb), [s.project], 'the row stays');
  } finally {
    chmodSync(s.backups, 0o700);
  }
});

test('--prune-missing is unchanged: removes only rows whose path is gone', () => {
  const s = sandbox();
  reg(s.registryDb, join(s.dir, 'gone'), 'gone');
  const r = run(s.registryDb, '--prune-missing');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Pruned 1 missing project\./, r.out);
  assert.deepEqual(rows(s.registryDb), [s.project]);
  assert.ok(existsSync(s.sterling));
});
