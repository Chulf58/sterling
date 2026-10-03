// cleanup-plan per-path buckets: a deprecated article's files[] is what the
// feature touched, not what is safe to delete. Each path lands in exactly one
// of release / absent / keep / delete, and only `delete` paths reach the
// top-level delete_paths list that fs-remove is fed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-01T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function envelope(type) {
  return {
    id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
  };
}

function articleRec(slug, files, over = {}) {
  return {
    ...envelope('feature_article'), slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'originating brief' }], live_test_refs: [], ...over,
  };
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// files: { 'repo/path': 'content' }. withGit=false leaves the dir outside any
// git repo, so the reference check cannot run.
function makeProject(files, { withGit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cleanup-plan-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (withGit) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'fixture']);
  }
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function plan(dir) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'cleanup-plan.mjs'), '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
  assert.equal(r.status, 0, `cleanup-plan failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function bucketOf(candidate, path) {
  const hits = Object.entries(candidate.buckets).filter(([, entries]) => entries.some((e) => e.path === path));
  assert.equal(hits.length, 1, `'${path}' must land in exactly one bucket, found ${hits.map(([b]) => b).join(',') || 'none'}`);
  return { bucket: hits[0][0], reason: candidate.buckets[hits[0][0]].find((e) => e.path === path).reason };
}

test('cleanup-plan: a shared host file co-owned by a live article is release, never delete', () => {
  const { dir, store, cleanup } = makeProject({ 'game/main.gd': 'extends Node\n', 'game/old_only.gd': 'extends Node\n' });
  try {
    const dead = store.create(articleRec('old-hud', ['game/main.gd', 'game/old_only.gd'], { state: 'deprecated' }));
    store.create(articleRec('farm-loop', ['game/main.gd']));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    assert.equal(c.deletable, true);
    const main = bucketOf(c, 'game/main.gd');
    assert.equal(main.bucket, 'release');
    assert.match(main.reason, /farm-loop/, 'the reason names the live co-owner');
    assert.ok(!p.delete_paths.includes('game/main.gd'), 'a co-owned file never reaches the delete list');
    assert.equal(bucketOf(c, 'game/old_only.gd').bucket, 'delete');
    assert.deepEqual(p.delete_paths, ['game/old_only.gd']);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a co-owner that is itself deprecated does not count as a live owner', () => {
  const { dir, store, cleanup } = makeProject({ 'src/shared.mjs': 'export const s = 1;\n' });
  try {
    const a = store.create(articleRec('old-a', ['src/shared.mjs'], { state: 'deprecated' }));
    store.create(articleRec('old-b', ['src/shared.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    assert.equal(bucketOf(p.candidates.find((x) => x.article === a.id), 'src/shared.mjs').bucket, 'delete');
  } finally {
    cleanup();
  }
});

test('cleanup-plan: in a candidate with a file on disk, a file not on disk is absent, a store edit only', () => {
  const { dir, store, cleanup } = makeProject({ 'src/still_here.mjs': 'export const s = 1;\n', 'src/other.mjs': 'export const o = 1;\n' });
  try {
    const dead = store.create(articleRec('gone-feat', ['src/gone.mjs', 'src/still_here.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    assert.equal(bucketOf(c, 'src/gone.mjs').bucket, 'absent');
    assert.equal(bucketOf(c, 'src/still_here.mjs').bucket, 'delete', 'the present path is handled as before');
    assert.deepEqual(p.delete_paths, ['src/still_here.mjs']);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a deprecated or dormant article whose every file is gone is not a candidate', () => {
  const { dir, store, cleanup } = makeProject({ 'src/other.mjs': 'export const o = 1;\n' });
  try {
    const dep = store.create(articleRec('gone-deprecated', ['src/gone_a.mjs', 'src/gone_b.mjs'], { state: 'deprecated' }));
    const dorm = store.create(articleRec('gone-dormant', ['src/gone_c.mjs'], { state: 'dormant', state_reason: 'r', wiring_todo_id: randomUUID() }));
    const p = plan(dir);
    assert.ok(!p.candidates.some((x) => x.article === dep.id), 'an all-gone deprecated article yields no candidate');
    assert.ok(!p.candidates.some((x) => x.article === dorm.id), 'an all-gone dormant article yields no candidate');
    assert.deepEqual(p.candidates, []);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: an all-gone article is skipped even when an active article relies on it', () => {
  const { dir, store, cleanup } = makeProject({ 'src/other.mjs': 'export const o = 1;\n' });
  try {
    const dead = store.create(articleRec('gone-base', ['src/gone.mjs'], { state: 'deprecated' }));
    store.create(articleRec('live-user', ['src/other.mjs'], { dependencies: { relies_on: ['gone-base'], relied_by: [] } }));
    const p = plan(dir);
    assert.ok(!p.candidates.some((x) => x.article === dead.id));
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a sole-owned file referenced by another tracked file is keep, with the referrer in the reason', () => {
  const { dir, store, cleanup } = makeProject({
    'game/run/worker_crew.gd': 'extends Node\n',
    'game/main.tscn': '[ext_resource path="res://run/worker_crew.gd" type="Script"]\n',
    'src/util.mjs': 'export const u = 1;\n',
    'src/app.mjs': "import { u } from './util';\n",
  });
  try {
    const dead = store.create(articleRec('old-crew', ['game/run/worker_crew.gd', 'src/util.mjs'], { state: 'dormant', state_reason: 'r', wiring_todo_id: randomUUID() }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const crew = bucketOf(c, 'game/run/worker_crew.gd');
    assert.equal(crew.bucket, 'keep');
    assert.match(crew.reason, /game\/main\.tscn/);
    const util = bucketOf(c, 'src/util.mjs');
    assert.equal(util.bucket, 'keep', 'a reference by the basename without extension also keeps the file');
    assert.match(util.reason, /src\/app\.mjs/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a sole-owned file no other file references is delete', () => {
  const { dir, store, cleanup } = makeProject({
    'src/dead_feature.mjs': 'export const dead_feature = 1; // mentions dead_feature.mjs itself\n',
    'src/other.mjs': 'export const o = 1;\n',
  });
  try {
    const dead = store.create(articleRec('dead-feat', ['src/dead_feature.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const deadEntry = bucketOf(c, 'src/dead_feature.mjs');
    assert.equal(deadEntry.bucket, 'delete', 'the file referencing itself does not keep it');
    assert.match(deadEntry.reason, /filename, stem or declared class/, 'the reason says what was checked');
    assert.deepEqual(p.delete_paths, ['src/dead_feature.mjs']);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: outside a git repo the reference check fails closed: keep, and the reason says why', () => {
  const { dir, store, cleanup } = makeProject({ 'src/lonely.mjs': 'export const l = 1;\n' }, { withGit: false });
  try {
    const dead = store.create(articleRec('lonely-feat', ['src/lonely.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const lonely = bucketOf(c, 'src/lonely.mjs');
    assert.equal(lonely.bucket, 'keep');
    assert.match(lonely.reason, /reference check could not run/);
    assert.match(lonely.reason, /git/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a relied_by naming an active article blocks the candidate, and blocked files are never planned', () => {
  const { dir, store, cleanup } = makeProject({ 'src/base.mjs': 'export const b = 1;\n' });
  try {
    const base = store.create(articleRec('base-feat', ['src/base.mjs'], { state: 'deprecated' }));
    store.create(articleRec('live-user', ['src/live-user.mjs'], { dependencies: { relies_on: ['base-feat'], relied_by: [] } }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === base.id);
    assert.equal(c.deletable, false);
    assert.deepEqual(c.active_relied_by.map((d) => d.slug), ['live-user']);
    assert.equal(c.buckets, null, 'a blocked candidate gets no per-path plan');
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: the planner never writes to the project store', () => {
  const { dir, store, cleanup } = makeProject({ 'src/x.mjs': 'export const x = 1;\n' });
  try {
    store.create(articleRec('x-feat', ['src/x.mjs'], { state: 'deprecated' }));
    const db = join(dir, '.sterling', 'sterling.db');
    // A store whose schema lags the code: a writable SterlingStore open would
    // recreate this index through its DDL, which is a write.
    const raw = new DatabaseSync(db);
    raw.exec('DROP INDEX idx_records_type_status');
    raw.close();
    const digest = () => [db, `${db}-wal`].map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'none')).join('|');
    const before = digest();
    plan(dir);
    assert.equal(digest(), before, 'the store files are byte-identical after a planner run');
    assert.ok(!existsSync(`${db}-journal`), 'no rollback journal left behind');
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a file referenced only by the PascalCase form of its stem is keep, and the reason names the needle', () => {
  const { dir, store, cleanup } = makeProject({
    'game/foo_bar.gd': 'class_name FooBar\nextends Node\n',
    'game/user.gd': 'extends Node\nvar x = FooBar.new()\n',
  });
  try {
    const dead = store.create(articleRec('old-foo', ['game/foo_bar.gd'], { state: 'deprecated' }));
    store.create(articleRec('user-feat', ['game/user.gd']));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const foo = bucketOf(c, 'game/foo_bar.gd');
    assert.equal(foo.bucket, 'keep');
    assert.match(foo.reason, /game\/user\.gd/);
    assert.match(foo.reason, /FooBar/, 'the reason names the matched needle');
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a file referenced only by the camelCase form of its stem is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/order_queue.mjs': 'export const make = () => [];\n',
    'src/app.mjs': 'const orderQueue = globalThis.queues.get(1);\n',
  });
  try {
    const dead = store.create(articleRec('old-queue', ['src/order_queue.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const q = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/order_queue.mjs');
    assert.equal(q.bucket, 'keep');
    assert.match(q.reason, /orderQueue/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a .gd file referenced only by its declared class_name is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'game/run/timer_logic.gd': 'class_name CropTimer extends Node\n',
    'game/farm.gd': 'extends CropTimer\n',
  });
  try {
    const dead = store.create(articleRec('old-timer', ['game/run/timer_logic.gd'], { state: 'deprecated' }));
    const p = plan(dir);
    const t = bucketOf(p.candidates.find((x) => x.article === dead.id), 'game/run/timer_logic.gd');
    assert.equal(t.bucket, 'keep');
    assert.match(t.reason, /game\/farm\.gd/);
    assert.match(t.reason, /CropTimer/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a .gd file that cannot be read for its class_name fails closed: keep', { skip: process.getuid?.() === 0 && 'root reads a mode-000 file' }, () => {
  const { dir, store, cleanup } = makeProject({ 'game/secret_node.gd': 'class_name Hidden\n', 'game/other.gd': 'extends Hidden\n' });
  try {
    chmodSync(join(dir, 'game', 'secret_node.gd'), 0o000);
    const dead = store.create(articleRec('old-secret', ['game/secret_node.gd'], { state: 'deprecated' }));
    const p = plan(dir);
    const s = bucketOf(p.candidates.find((x) => x.article === dead.id), 'game/secret_node.gd');
    assert.equal(s.bucket, 'keep');
    assert.match(s.reason, /could not read/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    chmodSync(join(dir, 'game', 'secret_node.gd'), 0o644);
    cleanup();
  }
});

// Group references: the candidate paths of one deletable article die together,
// so a reference between two of them is not a reason to keep either.
test('cleanup-plan: two candidates of one article that name each other and nothing else does are both delete', () => {
  const { dir, store, cleanup } = makeProject({
    'scripts/alpha_feature.mjs': 'export const alpha = 1; // exercised by alpha_feature.test.mjs\n',
    'scripts/tests/alpha_feature.test.mjs': "import { alpha } from '../alpha_feature.mjs';\n",
    'src/other.mjs': 'export const o = 1;\n',
  });
  try {
    const dead = store.create(articleRec('alpha-feat', ['scripts/alpha_feature.mjs', 'scripts/tests/alpha_feature.test.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    assert.equal(bucketOf(c, 'scripts/alpha_feature.mjs').bucket, 'delete');
    assert.equal(bucketOf(c, 'scripts/tests/alpha_feature.test.mjs').bucket, 'delete');
    assert.deepEqual(p.delete_paths, ['scripts/alpha_feature.mjs', 'scripts/tests/alpha_feature.test.mjs']);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a reference from a file outside the group keeps the referenced candidate, and what it keeps alive stays too', () => {
  const { dir, store, cleanup } = makeProject({
    'scripts/alpha_feature.mjs': 'export const alpha = 1; // exercised by alpha_feature.test.mjs\n',
    'scripts/tests/alpha_feature.test.mjs': "import { alpha } from '../alpha_feature.mjs';\n",
    'src/consumer.mjs': "import { alpha } from '../scripts/alpha_feature.mjs';\n",
  });
  try {
    const dead = store.create(articleRec('alpha-feat', ['scripts/alpha_feature.mjs', 'scripts/tests/alpha_feature.test.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const script = bucketOf(c, 'scripts/alpha_feature.mjs');
    assert.equal(script.bucket, 'keep');
    assert.match(script.reason, /src\/consumer\.mjs/, 'the reason names the outside referrer');
    const spec = bucketOf(c, 'scripts/tests/alpha_feature.test.mjs');
    assert.equal(spec.bucket, 'keep', 'the kept script still names the test, so the test survives with it');
    assert.match(spec.reason, /scripts\/alpha_feature\.mjs/, 'the reason names the kept candidate that references it');
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a group member that a live co-owned host file references is keep; the host stays release', () => {
  const { dir, store, cleanup } = makeProject({
    'game/main.gd': 'extends Node\nvar h = preload("res://game/old_hud.gd")\n',
    'game/old_hud.gd': 'extends Node\n',
  });
  try {
    const dead = store.create(articleRec('old-hud', ['game/main.gd', 'game/old_hud.gd'], { state: 'deprecated' }));
    store.create(articleRec('farm-loop', ['game/main.gd']));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    assert.equal(bucketOf(c, 'game/main.gd').bucket, 'release', 'a co-owned host is released, never deleted');
    const hud = bucketOf(c, 'game/old_hud.gd');
    assert.equal(hud.bucket, 'keep', 'the surviving host references it, so it is outside the dying group');
    assert.match(hud.reason, /game\/main\.gd/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

// Generic basenames: a bare README.md, index.js or main.gd names every such
// file in the repo, so only the path-qualified form counts as a reference.
test('cleanup-plan: a candidate README.md is delete when other files only say "README.md" without its path', () => {
  const { dir, store, cleanup } = makeProject({
    'docs/old_feature/README.md': '# Old feature\n',
    'README.md': 'See the README.md in each package.\n',
    'packages/a/README.md': 'Read this README.md first.\n',
    'packages/b/notes.md': 'The README and README.md describe it.\n',
  });
  try {
    const dead = store.create(articleRec('old-feature', ['docs/old_feature/README.md'], { state: 'deprecated' }));
    const p = plan(dir);
    const r = bucketOf(p.candidates.find((x) => x.article === dead.id), 'docs/old_feature/README.md');
    assert.equal(r.bucket, 'delete', r.reason);
    assert.deepEqual(p.delete_paths, ['docs/old_feature/README.md']);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a candidate README.md is keep when another file names its directory and basename, or its full path', () => {
  const { dir, store, cleanup } = makeProject({
    'docs/old_feature/README.md': '# Old feature\n',
    'docs/linked/README.md': '# Linked\n',
    'docs/toc.md': 'See [the old feature](old_feature/README.md).\n',
    'docs/links.md': 'Also docs/linked/README.md.\n',
  });
  try {
    const dead = store.create(articleRec('old-feature', ['docs/old_feature/README.md', 'docs/linked/README.md'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    const viaDir = bucketOf(c, 'docs/old_feature/README.md');
    assert.equal(viaDir.bucket, 'keep');
    assert.match(viaDir.reason, /docs\/toc\.md/);
    const viaPath = bucketOf(c, 'docs/linked/README.md');
    assert.equal(viaPath.bucket, 'keep');
    assert.match(viaPath.reason, /docs\/links\.md/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a document name such as CHANGELOG is not matched by the bare stem from another directory', () => {
  const { dir, store, cleanup } = makeProject({
    'src/legacy/CHANGELOG.md': '# Changes\n',
    'src/app.mjs': "// see the CHANGELOG.md and the CHANGELOG\nconst changelog = 1;\n",
  });
  try {
    const dead = store.create(articleRec('legacy-feat', ['src/legacy/CHANGELOG.md'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/legacy/CHANGELOG.md');
    assert.equal(c.bucket, 'delete', c.reason);
  } finally {
    cleanup();
  }
});

// index and main are code names: an importer in another directory reaches them
// by a bare stem, a dotted module path or an alias, never by a slash path, so
// the old repo-wide bare-name search must keep them.
test('cleanup-plan: an index file referenced from another directory by the bare stem is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/legacy/index.mjs': 'export const legacy = 1;\n',
    'src/app.mjs': "import { x } from './index';\n",
  });
  try {
    const dead = store.create(articleRec('legacy-feat', ['src/legacy/index.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const i = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/legacy/index.mjs');
    assert.equal(i.bucket, 'keep');
    assert.match(i.reason, /src\/app\.mjs/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: main.py imported by a dotted module path from another directory is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/app/main.py': 'def run(): pass\n',
    'tools/start.py': 'from src.app.main import run\n',
  });
  try {
    const dead = store.create(articleRec('app-main', ['src/app/main.py'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/app/main.py');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /tools\/start\.py/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: main.py imported as a module of its package from another directory is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'app/main.py': 'def run(): pass\n',
    'tools/start.py': 'from app import main\n',
  });
  try {
    const dead = store.create(articleRec('app-main', ['app/main.py'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'app/main.py');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /tools\/start\.py/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: main.ts imported through a tsconfig alias from another directory is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/corelib/main.ts': 'export const m = 1;\n',
    'src/ui/view.ts': "import { m } from '@core/main';\n",
  });
  try {
    const dead = store.create(articleRec('core-main', ['src/corelib/main.ts'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/corelib/main.ts');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /src\/ui\/view\.ts/);
  } finally {
    cleanup();
  }
});

// A document name is still reached by the bare name from inside its own
// directory, and index, mod and __init__ by the directory name, so those forms
// must keep the file; a false 'delete' is the one answer the planner must never
// give.
test('cleanup-plan: a README.md named by bare name from a file in its own directory is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'docs/old_feature/README.md': '# Old feature\n',
    'docs/old_feature/guide.md': 'Start with the README.md next to this file.\n',
  });
  try {
    const dead = store.create(articleRec('old-feature', ['docs/old_feature/README.md'], { state: 'deprecated' }));
    const p = plan(dir);
    const r = bucketOf(p.candidates.find((x) => x.article === dead.id), 'docs/old_feature/README.md');
    assert.equal(r.bucket, 'keep');
    assert.match(r.reason, /docs\/old_feature\/guide\.md/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a generic-named file imported by bare name from a sibling is keep, and the reason says what was searched', () => {
  const { dir, store, cleanup } = makeProject({
    'src/legacy/index.mjs': 'export const legacy = 1;\n',
    'src/legacy/live.mjs': "import { legacy } from './index.mjs';\n",
  });
  try {
    const dead = store.create(articleRec('legacy-feat', ['src/legacy/index.mjs'], { state: 'deprecated' }));
    store.create(articleRec('live-feat', ['src/legacy/live.mjs']));
    const p = plan(dir);
    const i = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/legacy/index.mjs');
    assert.equal(i.bucket, 'keep');
    assert.match(i.reason, /src\/legacy\/live\.mjs/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a mod.rs referenced as `mod <dir>;` from the parent is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/oldfeat/mod.rs': 'pub fn run() {}\n',
    'src/lib.rs': 'mod oldfeat;\n',
  });
  try {
    const dead = store.create(articleRec('oldfeat', ['src/oldfeat/mod.rs'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/oldfeat/mod.rs');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /src\/lib\.rs/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a package __init__.py referenced by its directory name is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'oldpkg/__init__.py': 'VALUE = 1\n',
    'app/run.py': 'from oldpkg import VALUE\n',
  });
  try {
    const dead = store.create(articleRec('oldpkg', ['oldpkg/__init__.py'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'oldpkg/__init__.py');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /app\/run\.py/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a generic-named directory index imported by its directory name is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'src/legacy/index.mjs': 'export const legacy = 1;\n',
    'src/app.mjs': "import { legacy } from './legacy';\n",
  });
  try {
    const dead = store.create(articleRec('legacy-feat', ['src/legacy/index.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const i = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/legacy/index.mjs');
    assert.equal(i.bucket, 'keep');
    assert.match(i.reason, /src\/app\.mjs/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a repo-root main.py imported from another directory keeps its old bare-name behaviour: keep', () => {
  const { dir, store, cleanup } = makeProject({
    'main.py': 'print("hi")\n',
    'tools/start.py': 'import main\n',
  });
  try {
    const dead = store.create(articleRec('old-main', ['main.py'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'main.py');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /tools\/start\.py/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a repo-root index.mjs imported as ./index is keep', () => {
  const { dir, store, cleanup } = makeProject({
    'index.mjs': 'export const a = 1;\n',
    'app.mjs': "import { a } from './index';\n",
  });
  try {
    const dead = store.create(articleRec('old-index', ['index.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const m = bucketOf(p.candidates.find((x) => x.article === dead.id), 'index.mjs');
    assert.equal(m.bucket, 'keep');
    assert.match(m.reason, /app\.mjs/);
    assert.deepEqual(p.delete_paths, []);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: the delete reason of a generic-named file says it was searched by path and by bare name in its own directory', () => {
  const { dir, store, cleanup } = makeProject({
    'docs/old_feature/README.md': '# Old feature\n',
    'README.md': 'See the README.md in each package.\n',
  });
  try {
    const dead = store.create(articleRec('old-feature', ['docs/old_feature/README.md'], { state: 'deprecated' }));
    const p = plan(dir);
    const r = bucketOf(p.candidates.find((x) => x.article === dead.id), 'docs/old_feature/README.md');
    assert.equal(r.bucket, 'delete');
    assert.match(r.reason, /generic document name/);
    assert.match(r.reason, /path-qualified/);
    assert.match(r.reason, /its own directory/);
    assert.doesNotMatch(r.reason, /filename, stem or declared class/, 'the plain-name reason would be untrue here');
  } finally {
    cleanup();
  }
});

test('cleanup-plan: the keep reason lists only needles matched by files outside the group', () => {
  const { dir, store, cleanup } = makeProject({
    'src/foo_bar.mjs': 'export const f = 1;\n',
    'src/qux.mjs': 'const fooBar = 1; // names the camelCase form, but it is deleted with the group\n',
    'app/consumer.mjs': "import '../src/foo_bar.mjs';\n",
  });
  try {
    const dead = store.create(articleRec('foo-feat', ['src/foo_bar.mjs', 'src/qux.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const f = bucketOf(p.candidates.find((x) => x.article === dead.id), 'src/foo_bar.mjs');
    assert.equal(f.bucket, 'keep');
    assert.match(f.reason, /app\/consumer\.mjs/);
    assert.doesNotMatch(f.reason, /fooBar/, 'a needle only the in-group file matched is not listed');
    assert.doesNotMatch(f.reason, /src\/qux\.mjs/);
  } finally {
    cleanup();
  }
});

test('cleanup-plan: a file of one deletable article that imports another article\'s file keeps that file', () => {
  const { dir, store, cleanup } = makeProject({
    'src/feature_a.mjs': "import { b } from './feature_b.mjs';\n",
    'src/feature_b.mjs': 'export const b = 1;\n',
  });
  try {
    const a = store.create(articleRec('feat-a', ['src/feature_a.mjs'], { state: 'deprecated' }));
    const b = store.create(articleRec('feat-b', ['src/feature_b.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    assert.equal(bucketOf(p.candidates.find((x) => x.article === a.id), 'src/feature_a.mjs').bucket, 'delete');
    const kept = bucketOf(p.candidates.find((x) => x.article === b.id), 'src/feature_b.mjs');
    assert.equal(kept.bucket, 'keep', 'the group is per article, so another article\'s file is an outside referrer');
    assert.match(kept.reason, /src\/feature_a\.mjs/);
    assert.deepEqual(p.delete_paths, ['src/feature_a.mjs']);
  } finally {
    cleanup();
  }
});
