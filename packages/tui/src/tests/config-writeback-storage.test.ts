import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageTransitionRequiredError, applyModeToggle, applyTddToggle, writeConfigKey } from '../config-writeback.js';
import { openDashboard } from '../controller.js';

// config.storage is written only by the store move (decision
// storage-backend-is-its-own-config-key-written-only-by-store-move): the TUI's
// write-back refuses it the way config_set does. The mode toggle is
// independent of storage: config.mode only picks the PR flow, and the router
// opens Postgres storage in any mode. The dashboard
// opens a Postgres-storage project through the router, so an unreachable
// database is a named error and no SQLite file is created.

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function configFile(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-storage-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.sterling'));
  const path = join(dir, '.sterling', 'config.json');
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return path;
}

test('writeConfigKey refuses storage and every storage.* path with StorageTransitionRequiredError naming the move; the file is untouched', () => {
  const path = configFile({ mode: 'work', storage: 'sqlite' });
  const before = readFileSync(path, 'utf8');
  for (const key of ['storage', 'storage.backend']) {
    assert.throws(
      () => writeConfigKey(path, key, () => 'postgres'),
      (e: unknown) =>
        e instanceof StorageTransitionRequiredError &&
        e.message ===
          `TUI: '${key}' cannot be written directly. config.storage records where this project's stores live (SQLite or Postgres), so it changes only when the stores move, through the explicit storage transition: \`node "<Sterling root>/bin/move-store.mjs" --to pg|sqlite\`, which writes it after the move commits. Nothing was written.`,
    );
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('every toggle keeps config.storage exactly as written', () => {
  const path = configFile({ mode: 'work', storage: 'postgres', tdd: { enabled: true } });
  assert.equal(applyTddToggle({ type: 'tdd_toggle', enabled: false }, undefined, path), true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.storage, 'postgres');
  assert.deepEqual(after.tdd, { enabled: false });
});

test('mode toggle, Postgres storage: both directions write, storage and every other key kept', () => {
  const path = configFile({ mode: 'work', storage: 'postgres', stack_tags: ['node'] });
  const errors: string[] = [];
  assert.equal(applyModeToggle({ type: 'mode_toggle', mode: 'hobby' }, (m) => errors.push(m), path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'hobby', storage: 'postgres', stack_tags: ['node'] });
  assert.equal(applyModeToggle({ type: 'mode_toggle', mode: 'work' }, (m) => errors.push(m), path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'work', storage: 'postgres', stack_tags: ['node'] });
  assert.deepEqual(errors, []);
});

test('mode toggle, SQLite storage: both directions still write, every other key kept', () => {
  const path = configFile({ mode: 'work', stack_tags: ['node'] });
  assert.equal(applyModeToggle({ type: 'mode_toggle', mode: 'hobby' }, undefined, path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'hobby', stack_tags: ['node'] });
  assert.equal(applyModeToggle({ type: 'mode_toggle', mode: 'work' }, undefined, path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'work', stack_tags: ['node'] });
});

test('openDashboard, Postgres storage, database unreachable: throws StoreUnreachableError and creates no SQLite file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-pg-'));
  dirs.push(root);
  mkdirSync(join(root, '.sterling', 'credentials'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', storage: 'postgres' }));
  writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: randomUUID() }));
  // The credentials live under HOME; point HOME at a temp dir with an unreachable server.
  const home = mkdtempSync(join(tmpdir(), 'tui-pg-home-'));
  dirs.push(home);
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  writeFileSync(join(home, '.sterling', 'credentials', 'served.json'), JSON.stringify({ host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 }), { mode: 0o600 });
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => openDashboard(join(root, '.sterling', 'sterling.db')), (e: unknown) => (e as Error).name === 'StoreUnreachableError');
  } finally {
    process.env.HOME = before;
  }
  assert.deepEqual(readdirSync(join(root, '.sterling')).filter((n) => n.startsWith('sterling.db')), []);
});

test("the TUI's storage refusal is config_set's message with the surface name swapped", async () => {
  // A relative path, not a package import: @sterling/tui does not depend on the MCP server.
  const toolsPath = '../../../mcp-server/dist/tools.js';
  const { StorageTransitionRequiredError: ConfigSetRefusal } = (await import(toolsPath)) as { StorageTransitionRequiredError: new (p: string) => Error };
  assert.equal(new StorageTransitionRequiredError('storage').message.replace(/^TUI: /, ''), new ConfigSetRefusal('storage').message.replace(/^config_set: /, ''));
});
