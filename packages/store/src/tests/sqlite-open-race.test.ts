// Two openers of one brand-new SQLite store (board 404228d7). Postgres had the
// race fixed in b531437b: an opener that read the schema version as 0, then saw
// the tables another opener had just committed, classified the store as legacy
// and got a read-only handle that refused every write. These pins drive the
// same interleaving on SQLite, once deterministically and once with real
// processes, and require every opener to end with a writable handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, SqliteDriver, SUPPORTED_SCHEMA_VERSION, journalDemotionRequired } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

const SKIP = sqliteOnly('drives two SqliteDriver openers of one file; the Postgres race has its own pins in pg-locking.test.ts');

test('an opener that read user_version 0 before another opener built the store opens it writable, never as a legacy store', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sqlite-race-'));
  const path = join(dir, 'sterling.db');
  try {
    const late = new SqliteDriver(path);
    let versionReads = 0;
    // The late opener's first version read sees the empty file; the other opener
    // then runs its whole open (DDL and version stamp) and writes before the late one goes on.
    const interleaved = new Proxy(late, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'schemaVersion') {
          return () => {
            const version = target.schemaVersion();
            if (++versionReads === 1) {
              assert.equal(version, 0, 'the late opener read the empty file');
              const first = new SterlingStore(path, { driver: new SqliteDriver(path) });
              first.setMeta('first', 'wrote');
              first.close();
            }
            return version;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new SterlingStore(path, { driver: interleaved });
    try {
      store.setMeta('late', 'wrote');
      assert.equal(store.getMeta('first'), 'wrote');
      assert.equal(store.getMeta('late'), 'wrote');
    } finally {
      store.close();
    }
    const check = new SqliteDriver(path);
    try {
      assert.equal(check.schemaVersion(), SUPPORTED_SCHEMA_VERSION, 'the store is stamped once and stays at the supported version');
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('four processes opening one brand-new SQLite file at the same moment all get a writable handle', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sqlite-openers-'));
  const path = join(dir, 'sterling.db');
  try {
    const script = join(dir, 'opener.mjs');
    const index = new URL('../index.js', import.meta.url).href;
    writeFileSync(
      script,
      `import { SterlingStore } from ${JSON.stringify(index)};
const [path, id] = process.argv.slice(2);
// Ready once the module is loaded; the parent releases all four together.
const go = new Promise((resolve) => process.once('message', resolve));
process.send('ready');
await go;
const store = new SterlingStore(path);
store.setMeta('opener-' + id, 'wrote');
store.close();
console.log('opened');
process.disconnect();
`,
    );
    const children = [0, 1, 2, 3].map((id) => spawn(process.execPath, [script, path, String(id)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    const results = children.map(
      (child) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          let out = '';
          child.stdout!.on('data', (d) => (out += d));
          child.stderr!.on('data', (d) => (out += d));
          child.on('exit', (code) => resolve({ code, out }));
        }),
    );
    const ready = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected message ${String(m)}`))));
          child.once('exit', (code) => reject(new Error(`opener exited with ${String(code)} before it was ready`)));
        }),
    );
    try {
      await Promise.all(ready);
    } catch (e) {
      for (const child of children) child.kill();
      throw e;
    }
    for (const child of children) child.send('go');
    const done = await Promise.all(results);
    // One line, so a child's multi-line stack cannot be read as the test runner's own diagnostic.
    for (const [i, r] of done.entries()) assert.equal(r.code, 0, `opener ${i}: ${r.out.replace(/\s*\n\s*/g, ' | ')}`);
    const store = new SterlingStore(path, { driver: new SqliteDriver(path) });
    try {
      for (const id of [0, 1, 2, 3]) assert.equal(store.getMeta(`opener-${id}`), 'wrote', `opener ${id} got a writable handle`);
      // The openers race to switch the fresh file to WAL; the switch must land once, not be lost.
      assert.equal(store.journalMode(), journalDemotionRequired(path) ? 'delete' : 'wal');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
