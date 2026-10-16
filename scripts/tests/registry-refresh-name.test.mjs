// The registry row follows config.json project_name (decision
// config-project-name-decides-the-registry-name, GitHub #113). Drives the shared refresh
// (scripts/hooks/lib/registry-refresh.mjs) against a temp registry: STERLING_REGISTRY_DB is
// pointed at the temp dir for each case, so the real ~/.sterling is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let ProjectRegistry;
let refreshRegistryRow;
let tmp;
let savedDb;
before(async () => {
  ({ ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ refreshRegistryRow } = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'registry-refresh.mjs')).href));
  tmp = mkdtempSync(join(tmpdir(), 'sterling-registry-refresh-name-'));
  savedDb = process.env.STERLING_REGISTRY_DB;
});
after(() => {
  if (savedDb === undefined) delete process.env.STERLING_REGISTRY_DB;
  else process.env.STERLING_REGISTRY_DB = savedDb;
  rmSync(tmp, { recursive: true, force: true });
});

const T = '2026-10-15T10:00:00.000Z';
const NOW = '2026-10-16T10:00:00.000Z';
const SELF = '/work/self-project';

/** A registry holding this project (as "old-name") and one sibling named "sibling". */
function setup() {
  const dir = mkdtempSync(join(tmp, 'case-'));
  process.env.STERLING_REGISTRY_DB = join(dir, 'registry.db');
  const reg = new ProjectRegistry(process.env.STERLING_REGISTRY_DB);
  reg.register({ repo_path: SELF, name: 'old-name', stack_tags: ['node'], toolchains: [], sterling_version: '1.0.0', at: T });
  reg.register({ repo_path: '/work/other', name: 'sibling', stack_tags: [], toolchains: [], sterling_version: null, at: T });
  reg.close();
}

function rowOf(path) {
  const reg = new ProjectRegistry(process.env.STERLING_REGISTRY_DB);
  try {
    return reg.list().find((r) => r.repo_path === path);
  } finally {
    reg.close();
  }
}

test('refresh renames this project\'s row to config.json project_name and touches nothing else of init', () => {
  setup();
  const res = refreshRegistryRow(SELF, { config: { project_name: 'new-name', stack_tags: ['node'] }, at: NOW });
  assert.equal(res.notice, null);
  const row = rowOf(SELF);
  assert.equal(row.name, 'new-name');
  assert.equal(row.last_seen_at, NOW);
  assert.equal(row.sterling_version, '1.0.0');
  assert.equal(row.last_init_at, T);
  assert.deepEqual(res.siblings.map((p) => p.name), ['sibling']);
  assert.equal(rowOf('/work/other').name, 'sibling', 'the sibling row is untouched');
});

test('refresh with no project_name leaves the row\'s name alone', () => {
  setup();
  const res = refreshRegistryRow(SELF, { config: { stack_tags: ['node'] }, at: NOW });
  assert.equal(res.notice, null);
  assert.equal(rowOf(SELF).name, 'old-name');
});

test('refresh ignores an empty or whitespace project_name and an unreadable config', () => {
  setup();
  assert.equal(refreshRegistryRow(SELF, { config: { project_name: '   ', stack_tags: [] }, at: NOW }).notice, null);
  assert.equal(rowOf(SELF).name, 'old-name');
  assert.equal(refreshRegistryRow(SELF, { config: { project_name: 'x' }, configUnreadable: true, at: NOW }).notice, null);
  assert.equal(rowOf(SELF).name, 'old-name');
});

test('refresh with a name another project already holds skips the rename and returns a notice', () => {
  setup();
  const res = refreshRegistryRow(SELF, { config: { project_name: 'sibling', stack_tags: ['node'] }, at: NOW });
  assert.equal(rowOf(SELF).name, 'old-name', 'the row keeps its name');
  assert.equal(rowOf('/work/other').name, 'sibling');
  assert.match(res.notice, /PROJECT NAME NOT APPLIED: config\.json project_name 'sibling' is already registered for \/work\/other, so this project stays registered as 'old-name'/);
  assert.equal(rowOf(SELF).last_seen_at, NOW, 'the rest of the refresh still runs');
});

test('refresh never creates a row for an unregistered project', () => {
  setup();
  const res = refreshRegistryRow('/work/unregistered', { config: { project_name: 'brand-new' }, at: NOW });
  assert.equal(res.notice, null);
  assert.equal(rowOf('/work/unregistered'), undefined);
});
