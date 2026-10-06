// fs-move mints its reconcile todo with an operation_id where it mints the
// record id (decision postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

test('fs-move: the reconcile todo it creates is stored with an operation_id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-fs-move-opid-'));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    writeFileSync(join(dir, 'src', 'old-name.mjs'), 'export const x = 1;');
    const store = new SterlingStore(dbPath);
    const article = store.create({
      id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      slug: 'feat-opid', title: 'feat-opid', what_it_does: 'x', intended_behavior: 'x',
      files: [{ path: 'src/old-name.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
      history: [{ date: NOW, event: 'originating brief' }], live_test_refs: [],
    });
    store.close();

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-move.mjs'), 'src/old-name.mjs', 'src/new-name.mjs', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, operation_id FROM records WHERE type = 'todo'").all();
      assert.equal(rows.length, 1, 'fs-move created exactly one reconcile todo');
      assert.equal(typeof rows[0].operation_id, 'string');
      assert.ok(rows[0].operation_id.length > 0, 'the todo carries a non-empty operation_id');
      assert.ok(article.id, 'the owning article existed');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
