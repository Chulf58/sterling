// ---------------------------------------------------------------------------
// PIN GROUP C — RETRY-LOOP live schema-version guard for the two optimistic-
// CAS retry writers: updateRunOptimistic (backing appendRunEscalation /
// appendRunReconcileNeeded / appendRunScopeAmendment / setRunReviewMandatory /
// incrementDispatchCount) and casTransitionMerge. Board d5942fa0 established
// the general live-write guard (schema-version-live-write-guard.test.ts,
// pin group B) for the simple autocommit writers (create/remove/writeHandoff/
// writeSelection/recordCheckSkipped). THIS group closes a narrower gap those
// pins do not reach: a RETRY-LOOP writer that re-reads the run body on every
// CAS-miss must ALSO re-check the live schema version on every iteration, not
// only once before the loop starts — a pre-loop-only check would miss a
// migration that lands on disk during a retry caused by ordinary concurrent
// activity (a hook append racing the same transition).
//
// SPEC (dispatch, board d5942fa0 follow-up): assertLiveSchemaVersion is
// called at the TOP OF EACH RETRY ITERATION of updateRunOptimistic and
// casTransitionMerge. A handle whose openedSchemaVersion has fallen behind
// the live PRAGMA user_version on disk must throw a /Live schema version
// drift/ error from EITHER writer, with the run body left completely
// unchanged (no partial/field-dropping write lands).
//
// Pin order: C1 (CONTROL, placed FIRST) must pass for the OPPOSITE reason to
// C2/C3 — it rules out "these writers just throw unconditionally" as a
// confound before the drift pins are read as meaningful.
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

function tempStore(prefix = 'sterling-retry-loop-guard-') {
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

test('C1 (CONTROL for C2/C3): a same-version handle — both retry writers SUCCEED and commit normally, ruling out "these writers just throw unconditionally"', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());

    // updateRunOptimistic-backed writer
    assert.doesNotThrow(() => store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 50 }));
    const afterEscalation = store.getRun(run.id)!;
    assert.equal(afterEscalation.escalations.length, 1, 'the escalation committed');

    // casTransitionMerge
    let applied: { machine_state: string } | undefined;
    assert.doesNotThrow(() => {
      applied = store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' })) as { machine_state: string };
    });
    assert.equal(applied!.machine_state, 'completing', 'the transition committed');
    assert.equal(store.getRun(run.id)!.machine_state, 'completing');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: updateRunOptimistic-backed appendRunEscalation THROWS /Live schema version drift/ when the live version has moved since open; the run body is left UNCHANGED', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);
    rawSetUserVersion(path, openedVersion + 7); // a second process migrates the file underneath this open handle

    let threw = false;
    let caught: unknown = null;
    try {
      store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 63 });
    } catch (err) {
      threw = true;
      caught = err;
    }
    assert.equal(threw, true, 'appendRunEscalation must refuse against a drifted live schema version');
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

test('C3: casTransitionMerge THROWS /Live schema version drift/ when the live version has moved since open; the transition never commits', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);
    rawSetUserVersion(path, openedVersion + 3);

    let threw = false;
    let caught: unknown = null;
    try {
      store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' }));
    } catch (err) {
      threw = true;
      caught = err;
    }
    assert.equal(threw, true, 'casTransitionMerge must refuse against a drifted live schema version');
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /Live schema version drift/, 'the refusal error names the drift condition');

    assert.equal(store.getRun(run.id)!.machine_state, 'running', 'the transition to completing never committed — no partial write');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C4 (IN-LOOP): casTransitionMerge — version MATCHES at loop entry but DIVERGES during the first retry pass (forced via a concurrent body change) → still THROWS, proving the guard runs INSIDE the retry loop, not only once before it', () => {
  const { dir, path, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const openedVersion = rawUserVersion(path);
    assert.equal(openedVersion, rawUserVersion(path), 'precondition: no drift yet at loop entry');

    let injected = false;
    let threw = false;
    let caught: unknown = null;
    try {
      store.casTransitionMerge('running', run.id, (fresh) => {
        if (!injected) {
          injected = true;
          // Force a CAS-miss retry: a concurrent write lands under this pass
          // (mirrors runs.test.ts's "RETRIES on a body change under it" seam).
          // The version is still UNCHANGED at this point — the FIRST
          // iteration's own guard check (whether pre-loop or in-loop) must
          // pass here.
          store.appendRunEscalation(run.id, { kind: 'concurrent_probe', agent_id: 'x' });
          // NOW a second process migrates the file — AFTER the first
          // iteration's read/check, BEFORE the retry iteration this CAS-miss
          // forces.
          rawSetUserVersion(path, openedVersion + 5);
        }
        return { ...fresh, machine_state: 'completing' };
      });
    } catch (err) {
      threw = true;
      caught = err;
    }
    assert.equal(threw, true, 'the retry iteration triggered by the concurrent body change must observe the drift and throw');
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    assert.match((caught as Error).message, /Live schema version drift/, 'the refusal error names the drift condition');

    // The transition never committed; the escalation from the forced-retry
    // seed did land (it happened before the drift), but machine_state must
    // still read the pre-transition value.
    const after = store.getRun(run.id)!;
    assert.equal(after.machine_state, 'running', 'the transition to completing never committed on the drift-detecting retry');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
