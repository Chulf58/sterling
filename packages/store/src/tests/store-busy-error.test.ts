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
import { SterlingStore, SqliteDriver, StoreBusyError, StoreOutcomeUncertainError } from '../index.js';
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
  /^the store was locked by another connection for longer than 200 ms; this transaction did not commit and nothing from it was written/;

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

// ---------------------------------------------------------------------------
// Injected-driver arms: a SqliteDriver whose COMMIT and ROLLBACK can be made to
// throw, so every exit of tx() is exercised without racing a second process.
// ---------------------------------------------------------------------------

/** What node:sqlite throws for a busy statement: a message plus the numeric result code. */
function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

class FaultyDriver extends SqliteDriver {
  failCommit: unknown;
  failRollback: unknown;
  rollbacks = 0;
  override commit(): void {
    if (this.failCommit !== undefined) throw this.failCommit;
    super.commit();
  }
  override rollback(): void {
    this.rollbacks++;
    if (this.failRollback !== undefined) throw this.failRollback;
    super.rollback();
  }
}

function withFaultyDriver(run: (store: SterlingStore, driver: FaultyDriver) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-store-busy-injected-'));
  const path = join(dir, 'sterling.db');
  const driver = new FaultyDriver(path, { busyTimeoutMs: 200 });
  const store = new SterlingStore(path, { driver });
  try {
    run(store, driver);
  } finally {
    try {
      // An arm that retired the connection left its transaction open on purpose.
      driver.failCommit = undefined;
      driver.failRollback = undefined;
      driver.exec('ROLLBACK');
    } catch {
      /* no transaction was open */
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('BUSY from inside the transaction body: rolled back, StoreBusyError, nothing written', { skip }, () => {
  withFaultyDriver((store, driver) => {
    const busy = sqliteError('database is locked', 5);
    assert.throws(
      () =>
        store.withTransaction(() => {
          store.create(decisionInput(ID));
          throw busy;
        }),
      (e: unknown) => e instanceof StoreBusyError && e.cause === busy && EXPECTED_TEXT.test(e.message)
    );
    assert.equal(driver.rollbacks, 1);
    assert.equal(store.count({}), 0, 'the row created before the BUSY was rolled back');
    assert.doesNotThrow(() => store.create(decisionInput(ID)), 'the connection is clean afterwards');
  });
});

test('BUSY from COMMIT with a successful rollback: StoreBusyError, nothing written, connection usable', { skip }, () => {
  withFaultyDriver((store, driver) => {
    const busy = sqliteError('database is locked', 5);
    driver.failCommit = busy;
    assert.throws(
      () => store.create(decisionInput(ID)),
      (e: unknown) => e instanceof StoreBusyError && e.cause === busy && EXPECTED_TEXT.test(e.message)
    );
    driver.failCommit = undefined;
    assert.equal(driver.rollbacks, 1);
    assert.equal(store.count({}), 0);
    assert.doesNotThrow(() => store.create(decisionInput(ID)));
    assert.equal(store.count({}), 1);
  });
});

test('BUSY from COMMIT with a FAILING rollback: uncertain outcome, never "safe to re-send", connection retired for reads and writes', { skip }, () => {
  withFaultyDriver((store, driver) => {
    const busy = sqliteError('database is locked', 5);
    const rollbackFailure = new Error('rollback failed');
    driver.failCommit = busy;
    driver.failRollback = rollbackFailure;
    let caught: unknown;
    try {
      store.create(decisionInput(ID));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof StoreOutcomeUncertainError, `expected StoreOutcomeUncertainError, got ${String(caught)}`);
    assert.ok(!(caught instanceof StoreBusyError));
    assert.equal(caught.cause, busy, 'the original BUSY is kept as cause');
    assert.match(caught.message, /whether this transaction committed is not known/);
    assert.doesNotMatch(caught.message, /safe to re-send|did not commit and nothing/);

    // The transaction state is unknown, so the connection refuses further writes
    // loudly instead of continuing as if clean.
    driver.failCommit = undefined;
    driver.failRollback = undefined;
    const retired = /connection was retired after a failed ROLLBACK/;
    assert.throws(() => store.create(decisionInput('00000000-0000-4000-8000-0000000000b2')), retired);
    // Reads are refused too: the handle may still hold the failed transaction open,
    // so a read through it could show the uncommitted row and make the write look landed.
    assert.throws(() => store.count({}), retired);
    assert.throws(() => store.get(ID), retired);
    assert.throws(() => store.query({}), retired);
  });
});

test('a failed rollback after a non-busy error still rethrows the original error and retires the connection', { skip }, () => {
  withFaultyDriver((store, driver) => {
    const boom = new Error('not a lock problem');
    driver.failRollback = new Error('rollback failed');
    assert.throws(() => store.withTransaction(() => { throw boom; }), (e: unknown) => e === boom);
    driver.failRollback = undefined;
    assert.throws(() => store.withTransaction(() => undefined), /connection was retired after a failed ROLLBACK/);
    assert.throws(() => store.count({}), /connection was retired after a failed ROLLBACK/);
  });
});

test('extended busy codes are still busy but never claim the timeout ran out; other codes pass through', { skip }, () => {
  withFaultyDriver((store) => {
    const attempt = (err: Error) => () =>
      store.withTransaction(() => {
        throw err;
      });
    // Base code 5: the timeout wording.
    assert.throws(attempt(sqliteError('database is locked', 5)), (e: unknown) => e instanceof StoreBusyError && /locked by another connection for longer than 200 ms/.test(e.message));
    for (const [code, name] of [
      [261, 'SQLITE_BUSY_RECOVERY'],
      [517, 'SQLITE_BUSY_SNAPSHOT'],
      [773, 'SQLITE_BUSY_TIMEOUT'],
    ] as const) {
      assert.throws(
        attempt(sqliteError('database is locked', code)),
        (e: unknown) => {
          assert.ok(e instanceof StoreBusyError, `code ${code} is busy`);
          assert.equal(e.sqlite_errcode, code);
          assert.match(e.message, new RegExp(`the store was busy \\(${name}\\); this transaction did not commit and nothing from it was written`));
          assert.doesNotMatch(e.message, /longer than/);
          // The worker's BUSY_RE (/database is locked|SQLITE_BUSY/i) keeps matching.
          assert.match(e.message, /database is locked/);
          assert.match(e.message, /SQLITE_BUSY/);
          return true;
        },
        name
      );
    }
    // An extended code with no name here still reads as busy, with the number.
    assert.throws(attempt(sqliteError('busy', 1029)), (e: unknown) => e instanceof StoreBusyError && /extended code 1029/.test(e.message));
    // SQLITE_LOCKED (6) is a different condition and passes through unchanged.
    const locked = sqliteError('database table is locked', 6);
    assert.throws(attempt(locked), (e: unknown) => e === locked);
  });
});
