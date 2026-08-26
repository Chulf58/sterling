// ---------------------------------------------------------------------------
// PIN GROUP D — GUARD→READ WINDOW live schema-version re-check for the two
// optimistic-CAS retry writers: updateRunOptimistic (backing
// appendRunEscalation et al.) and casTransitionMerge. Pin group C
// (retry-loop-live-schema-guard.test.ts) established that BOTH writers
// re-check assertLiveSchemaVersion() at the TOP of every retry iteration.
// THIS group closes a narrower gap: a migration that lands strictly BETWEEN
// that top-of-loop guard and the writer's own row-read SELECT — i.e. inside
// the guard→read window — was previously invisible to a single top-of-loop
// check. The fix under test adds a SECOND assertLiveSchemaVersion() call
// immediately after the row-read SELECT and before the body is parsed.
//
// SPEC (this dispatch): a migration landing in the guard→read window makes
// the writer THROW /Live schema version drift/ with the run body left
// UNCHANGED (no field-dropping write lands).
//
// SEAM NOTE (load-bearing, read before touching these pins): there is no
// production seam between the back-to-back top-of-loop guard and the SELECT
// — nothing observable distinguishes "about to guard" from "about to read".
// The only reachable seam is the store's private `db` handle (the same raw
// DatabaseSync handle runs.test.ts's legacy-pending_exit pin reaches via a
// second `new DatabaseSync(...)` connection, and the same handle the SQL
// `UPDATE runs SET pending_exit = ? WHERE id = ?` in that file confirms is
// named `db` and confirms the table is literally `runs`). Each pin below
// monkeypatches `(store as any).db.prepare` to wrap ONLY a statement whose
// SQL is a SELECT reading FROM the `runs` table for this run's id; the
// wrapped statement's `.get()` is left to run for real (so the top-of-loop
// guard and the read observe the SAME pre-migration version, exactly as
// production would), and the live user_version is bumped IMMEDIATELY AFTER
// that real read returns — landing the drift strictly inside the
// guard→read window, before the writer's second guard can run.
//
// KNOWN FEASIBILITY RISK — DISCLOSED, NOT VERIFIED BY EXECUTION: this
// technique assumes the writer calls `db.prepare(...)` for the runs-body
// SELECT freshly on every write (or at least reprepares/refetches through
// the live `db.prepare` reference at call time). If the store instead
// caches a prepared-statement object once (e.g. at construction) and reuses
// that cached reference on every write, monkeypatching `db.prepare` AFTER
// construction will never see that call again, and the injection will not
// fire. This role has no execution access (no Bash) to confirm which is
// true. The failure mode if the seam is defeated is SAFE, not silent: the
// version bump never lands, the writer's normal top-of-loop guard sees no
// drift, the write commits, and `assert.equal(threw, true, ...)` below
// fails loudly — it does not pass for the wrong reason. Treat a red D2/D3
// with `threw === false` as "seam defeated, technique infeasible here",
// distinct from a red on the message-match assertions (which would mean the
// window exists but the error shape differs).
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

function runRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: [
      { id: 'p1', status: 'in_progress', signals: [], commits: [] },
      { id: 'p2', status: 'pending', signals: [], commits: [] },
    ],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
    ...over,
  };
}

function tempStore(prefix = 'sterling-guard-read-window-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'sterling.db');
  return { dir, path, store: new SterlingStore(path) };
}

/** Raw, out-of-band pragma read — never through SterlingStore. */
function rawUserVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    return row ? row.user_version : NaN;
  } finally {
    db.close();
  }
}

/** Raw, out-of-band pragma write — simulates a SECOND process migrating the file while this handle stays open. */
function rawSetUserVersion(path: string, value: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

const RUNS_SELECT_RE = /^\s*SELECT[\s\S]*?\bFROM\s+runs\b/i;

/**
 * Installs the guard→read-window injector on `store`'s private db handle.
 * Wraps only a SELECT ... FROM runs statement whose `.get()` is called with
 * this run's id; lets the real read happen, then (once) calls `onRead()`
 * immediately after — before returning the row to the writer. Returns a
 * restore function.
 */
function installReadWindowInjector(store: unknown, runId: string, onRead: () => void): () => void {
  const rawDb = (store as { db: { prepare: (sql: string, ...rest: unknown[]) => any } }).db;
  const originalPrepare = rawDb.prepare.bind(rawDb);
  let armed = true;
  rawDb.prepare = (sql: string, ...rest: unknown[]) => {
    const stmt = originalPrepare(sql, ...rest);
    if (armed && RUNS_SELECT_RE.test(sql)) {
      const originalGet = stmt.get.bind(stmt);
      stmt.get = (...args: unknown[]) => {
        const row = originalGet(...args);
        if (armed && args.includes(runId)) {
          armed = false;
          onRead();
        }
        return row;
      };
    }
    return stmt;
  };
  return () => {
    rawDb.prepare = originalPrepare;
  };
}

test('D1 (CONTROL for D2/D3, placed FIRST): the SAME injector wrapper fires but reasserts the SAME live version (no real drift) — both writers COMMIT normally, ruling out "the wrapper itself breaks the write" as a confound', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);

    let fired = false;
    const restore1 = installReadWindowInjector(store, run.id, () => {
      fired = true;
      rawSetUserVersion(path, openedVersion); // same value: exercises the wrapper without introducing drift
    });
    assert.doesNotThrow(() => store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 50 }));
    assert.equal(fired, true, 'precondition: the injector actually intercepted the runs-body SELECT for updateRunOptimistic');
    assert.equal(store.getRun(run.id)!.escalations.length, 1, 'the escalation committed under the no-op injector');
    restore1();

    fired = false;
    const restore2 = installReadWindowInjector(store, run.id, () => {
      fired = true;
      rawSetUserVersion(path, openedVersion);
    });
    let applied: { machine_state: string } | undefined;
    assert.doesNotThrow(() => {
      applied = store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' })) as {
        machine_state: string;
      };
    });
    assert.equal(fired, true, 'precondition: the injector actually intercepted the runs-body SELECT for casTransitionMerge');
    assert.equal(applied!.machine_state, 'completing', 'the transition committed under the no-op injector');
    restore2();

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2: updateRunOptimistic-backed appendRunEscalation — a migration landing in the GUARD→READ window (after the top-of-loop guard, strictly between the runs-body SELECT and body parsing) THROWS /Live schema version drift/; the run body is left UNCHANGED', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);

    let fired = false;
    const restore = installReadWindowInjector(store, run.id, () => {
      fired = true;
      // land the drift AFTER the real SELECT has returned the row, BEFORE
      // the writer's post-read guard check runs.
      rawSetUserVersion(path, openedVersion + 11);
    });

    let threw = false;
    let caught: unknown = null;
    try {
      store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 63 });
    } catch (err) {
      threw = true;
      caught = err;
    } finally {
      restore();
    }

    assert.equal(fired, true, 'precondition: the injector intercepted the runs-body SELECT — without this, the assertions below prove nothing');
    assert.equal(threw, true, 'appendRunEscalation must refuse a drift that lands strictly in the guard→read window, not only a pre-existing one');
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /Live schema version drift/, 'the refusal error names the drift condition');

    const after = store.getRun(run.id)!;
    assert.equal(after.escalations.length, 0, 'no partial escalation write landed — the body is unchanged');
    assert.equal(after.machine_state, 'running', 'machine_state untouched by the refused write');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3: casTransitionMerge — a migration landing in the GUARD→READ window (after the top-of-loop guard, strictly between the runs-body SELECT and body parsing) THROWS /Live schema version drift/; the transition never commits', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);

    let fired = false;
    const restore = installReadWindowInjector(store, run.id, () => {
      fired = true;
      rawSetUserVersion(path, openedVersion + 5);
    });

    let threw = false;
    let caught: unknown = null;
    try {
      store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' }));
    } catch (err) {
      threw = true;
      caught = err;
    } finally {
      restore();
    }

    assert.equal(fired, true, 'precondition: the injector intercepted the runs-body SELECT — without this, the assertions below prove nothing');
    assert.equal(threw, true, 'casTransitionMerge must refuse a drift that lands strictly in the guard→read window, not only a pre-existing one');
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /Live schema version drift/, 'the refusal error names the drift condition');

    assert.equal(store.getRun(run.id)!.machine_state, 'running', 'the transition to completing never committed — no partial write');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
