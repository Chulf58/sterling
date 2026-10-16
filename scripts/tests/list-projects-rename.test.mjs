// list-projects --rename <path> <new-name> [--apply] (decision
// config-project-name-decides-the-registry-name, GitHub #113). Every case spawns the script
// against temp dirs with STERLING_REGISTRY_DB isolated, so the real ~/.sterling is never
// touched. OPENCODE and OPENCODE_SESSION_ID are cleared in the child env (anti_pattern ddf7ad45).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'list-projects.mjs');
const T = '2026-10-15T10:00:00.000Z';

let ProjectRegistry;
let tmp;
before(async () => {
  ({ ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  tmp = mkdtempSync(join(tmpdir(), 'sterling-list-projects-rename-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Two registered projects (alpha, beta), each with a config.json; alpha's has extra keys and 4-space indent. */
function sandbox() {
  const dir = mkdtempSync(join(tmp, 'case-'));
  const registryDb = join(dir, 'registry.db');
  const make = (name, cfgText) => {
    const p = join(dir, name);
    mkdirSync(join(p, '.sterling'), { recursive: true });
    writeFileSync(join(p, '.sterling', 'config.json'), cfgText);
    const r = new ProjectRegistry(registryDb);
    r.register({ repo_path: p, name, stack_tags: ['node'], toolchains: [], sterling_version: null, at: T });
    r.close();
    return p;
  };
  const alpha = make('alpha', `${JSON.stringify({ stack_tags: ['node'], backup_path: '/b', mode: 'hobby' }, null, 4)}\n`);
  const beta = make('beta', JSON.stringify({ project_name: 'beta' }));
  return { dir, registryDb, alpha, beta };
}

function run(registryDb, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_REGISTRY_DB: registryDb, OPENCODE: undefined, OPENCODE_SESSION_ID: undefined },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function names(registryDb) {
  const r = new ProjectRegistry(registryDb);
  try {
    return Object.fromEntries(r.list().map((p) => [p.repo_path, p.name]));
  } finally {
    r.close();
  }
}

const cfgText = (p) => readFileSync(join(p, '.sterling', 'config.json'), 'utf8');

test('--rename dry run prints the plan and changes neither the config nor the row', () => {
  const s = sandbox();
  const before = cfgText(s.alpha);
  const r = run(s.registryDb, '--rename', s.alpha, 'alpha-two');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Rename preview \(dry run; nothing is changed\)/);
  assert.match(r.out, /config\.json project_name: \(not set\) -> alpha-two/);
  assert.match(r.out, /Registry row name: alpha -> alpha-two/);
  assert.equal(cfgText(s.alpha), before);
  assert.equal(names(s.registryDb)[s.alpha], 'alpha');
});

test('--rename --apply writes project_name into config.json (rest of the file kept) and renames the row', () => {
  const s = sandbox();
  const r = run(s.registryDb, '--rename', s.alpha, 'alpha-two', '--apply');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(cfgText(s.alpha), `${JSON.stringify({ stack_tags: ['node'], backup_path: '/b', mode: 'hobby', project_name: 'alpha-two' }, null, 4)}\n`);
  assert.equal(names(s.registryDb)[s.alpha], 'alpha-two');
  assert.equal(names(s.registryDb)[s.beta], 'beta', 'the other project is untouched');
  const again = run(s.registryDb, '--rename', s.alpha, 'alpha-two', '--apply');
  assert.equal(again.code, 0);
  assert.match(again.out, /Nothing to change/);
});

test('--rename --apply finishes a half-done rename: config already says the name, the row does not', () => {
  const s = sandbox();
  writeFileSync(join(s.alpha, '.sterling', 'config.json'), JSON.stringify({ project_name: 'alpha-two' }));
  const r = run(s.registryDb, '--rename', s.alpha, 'alpha-two', '--apply');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(names(s.registryDb)[s.alpha], 'alpha-two');
});

test('--rename refuses a name another project uses, with nothing written (dry run and --apply)', () => {
  const s = sandbox();
  const before = cfgText(s.alpha);
  for (const extra of [[], ['--apply']]) {
    const r = run(s.registryDb, '--rename', s.alpha, 'beta', ...extra);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, new RegExp(`the name 'beta' is already used by the project at ${s.beta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(cfgText(s.alpha), before);
    assert.equal(names(s.registryDb)[s.alpha], 'alpha');
  }
});

test('--rename refuses an unregistered path, an empty name and a project without a readable config', () => {
  const s = sandbox();
  const stranger = join(s.dir, 'stranger');
  mkdirSync(join(stranger, '.sterling'), { recursive: true });
  writeFileSync(join(stranger, '.sterling', 'config.json'), '{}');
  const unknown = run(s.registryDb, '--rename', stranger, 'x', '--apply');
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no registered project is at /);
  assert.equal(cfgText(stranger), '{}');

  const empty = run(s.registryDb, '--rename', s.alpha, '   ', '--apply');
  assert.equal(empty.code, 1);
  assert.match(empty.out, /the new name is empty/);

  rmSync(join(s.alpha, '.sterling', 'config.json'));
  const noCfg = run(s.registryDb, '--rename', s.alpha, 'alpha-two', '--apply');
  assert.equal(noCfg.code, 1);
  assert.match(noCfg.out, /no .*config\.json; this is not an initialized Sterling project/);
  assert.equal(names(s.registryDb)[s.alpha], 'alpha');
});

test('--rename argument errors exit 2', () => {
  const s = sandbox();
  assert.equal(run(s.registryDb, '--rename', s.alpha).code, 2);
  assert.equal(run(s.registryDb, '--apply').code, 2);
  assert.equal(run(s.registryDb, '--rename', s.alpha, 'x', '--remove', s.beta).code, 2);
});
