// cleanup-plan per-path buckets: a deprecated article's files[] is what the
// feature touched, not what is safe to delete. Each path lands in exactly one
// of release / absent / keep / delete, and only `delete` paths reach the
// top-level delete_paths list that fs-remove is fed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

test('cleanup-plan: a file not on disk is absent, a store edit only', () => {
  const { dir, store, cleanup } = makeProject({ 'src/keep-repo-nonempty.mjs': 'x\n' });
  try {
    const dead = store.create(articleRec('gone-feat', ['src/gone.mjs'], { state: 'deprecated' }));
    const p = plan(dir);
    const c = p.candidates.find((x) => x.article === dead.id);
    assert.equal(bucketOf(c, 'src/gone.mjs').bucket, 'absent');
    assert.deepEqual(p.delete_paths, []);
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
    assert.equal(bucketOf(c, 'src/dead_feature.mjs').bucket, 'delete', 'the file referencing itself does not keep it');
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
