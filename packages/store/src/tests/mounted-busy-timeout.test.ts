import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MountedStores } from '../index.js';

// MountedStoresOptions.busyTimeoutMs reaches the SterlingStore it opens: a
// write against a held lock gives up after that long, not after the 5000 ms
// default. The TUI opens with a short timeout so a held lock cannot stall it.

test('MountedStores: busyTimeoutMs reaches the project store it opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mounted-busy-'));
  const dbPath = join(dir, 'sterling.db');
  const stores = new MountedStores(dbPath, [], { busyTimeoutMs: 100 });
  const locker = new DatabaseSync(dbPath);
  try {
    locker.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    assert.throws(() => stores.project.writeSelection('todo', '00000000-0000-0000-0000-000000000001', new Date().toISOString()), /locked|busy/i);
    const waited = Date.now() - t0;
    assert.ok(waited >= 80 && waited < 1500, `waited ${waited} ms`);
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
