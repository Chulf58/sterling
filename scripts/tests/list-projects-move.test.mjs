// list-projects --move <name|old-path> <new-path> [--apply] (GitHub issue #119, decision
// moving-a-project-folder-repoints-the-registry-and-keeps-old-paths-as-aliases). Every case
// spawns the script against temp dirs with STERLING_REGISTRY_DB isolated, so the real
// ~/.sterling is never touched. OPENCODE and OPENCODE_SESSION_ID are cleared in the child
// env (anti_pattern ddf7ad45).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-list-projects-move-')));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function initDir(p) {
  mkdirSync(join(p, '.sterling'), { recursive: true });
  writeFileSync(join(p, '.sterling', 'config.json'), '{}');
  return p;
}

/** Two registered projects, alpha and beta. */
function sandbox() {
  const dir = mkdtempSync(join(tmp, 'case-'));
  const registryDb = join(dir, 'registry.db');
  const r = new ProjectRegistry(registryDb);
  const alpha = initDir(join(dir, 'alpha'));
  const beta = initDir(join(dir, 'beta'));
  for (const [name, p] of [['alpha', alpha], ['beta', beta]]) r.register({ repo_path: p, name, stack_tags: [], toolchains: [], sterling_version: null, at: T });
  r.close();
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

function state(registryDb) {
  const r = new ProjectRegistry(registryDb);
  try {
    return {
      paths: Object.fromEntries(r.list().map((p) => [p.name, p.repo_path])),
      // every closed interval: the path a project left, and the path its key is at now
      moves: Object.fromEntries(
        r.occupancy().filter((o) => o.to_at !== null).map((o) => [o.path, r.list().find((row) => r.keyOf(row.repo_path) === o.project_key)?.repo_path ?? null])
      ),
    };
  } finally {
    r.close();
  }
}

test('--move previews by default, then --apply repoints the row by path or by name and records the move', () => {
  const s = sandbox();
  const moved = join(s.dir, 'beta-moved');
  renameSync(s.beta, moved);

  const dry = run(s.registryDb, '--move', s.beta, moved);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /Move preview \(dry run; nothing is changed\)/);
  assert.match(dry.out, new RegExp(`Registry path: ${s.beta} -> ${moved}`));
  assert.match(dry.out, /This repairs the registry only\. It moves no files and changes nothing inside any project/);
  assert.deepEqual(state(s.registryDb), { paths: { alpha: s.alpha, beta: s.beta }, moves: {} });

  const done = run(s.registryDb, '--move', 'beta', moved, '--apply');
  assert.equal(done.code, 0, done.out + done.err);
  assert.match(done.out, new RegExp(`Moved beta: ${s.beta} -> ${moved}\\. This repairs the registry only`));
  assert.deepEqual(state(s.registryDb), { paths: { alpha: s.alpha, beta: moved }, moves: { [s.beta]: moved } });

  assert.match(run(s.registryDb, '--move', 'beta', moved, '--apply').out, /Nothing to change/);
});

test('--move repeated, then back: every former path leads to the current path, including the one moved back to', () => {
  const s = sandbox();
  const b2 = join(s.dir, 'b2');
  const b3 = join(s.dir, 'b3');
  renameSync(s.beta, b2);
  assert.equal(run(s.registryDb, '--move', s.beta, b2, '--apply').code, 0);
  renameSync(b2, b3);
  assert.equal(run(s.registryDb, '--move', b2, b3, '--apply').code, 0);
  assert.deepEqual(state(s.registryDb).moves, { [s.beta]: b3, [b2]: b3 });
  renameSync(b3, s.beta);
  assert.equal(run(s.registryDb, '--move', 'beta', s.beta, '--apply').code, 0);
  assert.deepEqual(state(s.registryDb), { paths: { alpha: s.alpha, beta: s.beta }, moves: { [s.beta]: s.beta, [b2]: s.beta, [b3]: s.beta } });
});

test('--move refuses an unregistered project, a missing or uninitialized destination and a registered destination, with nothing written', () => {
  const s = sandbox();
  const plain = join(s.dir, 'plain');
  mkdirSync(plain);
  const cases = [
    [['--move', 'nobody', plain], /no registered project is at .* or is named 'nobody'/],
    [['--move', 'beta', join(s.dir, 'missing')], /the new path .*missing is not a directory; move the folder first/],
    [['--move', 'beta', plain], /plain has no \.sterling\/config\.json, so it is not an initialized Sterling project/],
    [['--move', 'beta', s.alpha], /is already registered as the project 'alpha'; two rows cannot share a path/],
  ];
  for (const [args, why] of cases) {
    for (const extra of [[], ['--apply']]) {
      const r = run(s.registryDb, ...args, ...extra);
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, why);
      assert.match(r.out, extra.length ? /--move REFUSED/ : /--move --apply would REFUSE/);
    }
  }
  assert.deepEqual(state(s.registryDb), { paths: { alpha: s.alpha, beta: s.beta }, moves: {} });
});

test('--move argument errors exit 2', () => {
  const s = sandbox();
  assert.equal(run(s.registryDb, '--move', 'beta').code, 2);
  assert.equal(run(s.registryDb, '--move', 'beta', s.alpha, '--rename', s.alpha, 'x').code, 2);
  assert.equal(run(s.registryDb, '--move', 'beta', s.alpha, '--prune-missing').code, 2);
});
