// Issue #59: a write that waits out the busy timeout for SQLite's write lock
// fails with the named StoreBusyError, never the raw 'database is locked'.
// The holder pattern follows schema-version-guard.test.ts (A5): another
// connection takes BEGIN IMMEDIATE plus a DDL statement, which forces the lock
// to materialize. The victim's busyTimeoutMs is 200 so the wait stays short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, StoreBusyError } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

const skip = sqliteOnly('SQLITE_BUSY is SQLite-specific; the Postgres driver has no busy timeout');

const ID = '00000000-0000-4000-8000-0000000000b1';

function decisionInput(id: string) {
  return {
    id,
    type: 'decision',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'busy probe',
    statement: 'written only when the write lock is free',
    alternatives_rejected: [],
    rationale: 'busy-error fixture',
    file_keys: [],
  };
}

function withHeldLock(run: (victim: SterlingStore, release: () => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-store-busy-'));
  const path = join(dir, 'sterling.db');
  let holder: DatabaseSync | undefined;
  let victim: SterlingStore | undefined;
  try {
    const seed = new SterlingStore(path);
    seed.close();
    victim = new SterlingStore(path, { busyTimeoutMs: 200 });
    holder = new DatabaseSync(path);
    holder.exec('PRAGMA busy_timeout=0');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec('CREATE TABLE IF NOT EXISTS zz_lock (x)');
    run(victim, () => {
      holder!.exec('ROLLBACK');
      holder!.close();
      holder = undefined;
    });
  } finally {
    if (holder) {
      try {
        holder.exec('ROLLBACK');
      } catch {
        /* the lock may already be gone */
      }
      holder.close();
    }
    victim?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED_TEXT =
  /^the store was locked by another connection for longer than 200 ms; this transaction was rolled back and nothing from it was written/;

test('a write blocked past busyTimeoutMs throws StoreBusyError, writes nothing, and succeeds once the lock is released', { skip }, () => {
  withHeldLock((victim, release) => {
    let caught: unknown;
    try {
      victim.create(decisionInput(ID));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof StoreBusyError, `expected StoreBusyError, got ${String(caught)}`);
    assert.equal(caught.name, 'StoreBusyError');
    assert.equal(caught.busy_timeout_ms, 200);
    assert.match(caught.message, EXPECTED_TEXT);
    // The maintenance worker's runner classifies a busy result by these words.
    assert.match(caught.message, /database is locked/);
    assert.match(String((caught.cause as Error)?.message), /database is locked/, 'the raw SQLite error is kept as cause');

    assert.equal(victim.count({}), 0, 'no row was written');

    release();
    assert.doesNotThrow(() => victim.create(decisionInput(ID)), 'the same write succeeds after the lock is released');
    assert.equal(victim.count({}), 1);
  });
});

test('withTransaction takes the same path: a busy BEGIN is a StoreBusyError and the connection stays usable', { skip }, () => {
  withHeldLock((victim, release) => {
    let ran = false;
    assert.throws(
      () =>
        victim.withTransaction(() => {
          ran = true;
        }),
      (e: unknown) => e instanceof StoreBusyError && EXPECTED_TEXT.test(e.message)
    );
    assert.equal(ran, false, 'the transaction body never ran without the lock');

    release();
    assert.doesNotThrow(() => victim.withTransaction(() => victim.create(decisionInput(ID))));
    assert.equal(victim.count({}), 1);
  });
});

test('an error that is not SQLITE_BUSY passes through tx() unchanged', { skip }, () => {
  withHeldLock((victim, release) => {
    release();
    const boom = new Error('not a lock problem');
    assert.throws(
      () =>
        victim.withTransaction(() => {
          throw boom;
        }),
      (e: unknown) => e === boom
    );
  });
});
