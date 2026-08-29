// ---------------------------------------------------------------------------
// PIN GROUP A — schema-version marker (stable-identity wave S1, decision
// stable-identity-design-v2 / 2176748e, board dee719dd). SPEC-ONLY: NOTHING
// in this pin group is implemented yet. SterlingStore's constructor today
// neither reads nor stamps PRAGMA user_version, so every test below is
// expected to fail on its own assertion (a raw pragma read reporting the
// SQLite default of 0 instead of 1, or `assert.throws` reporting "did not
// throw" when the current constructor happily opens a user_version=99 file)
// — never on a bare crash of the whole file.
//
// Ground truth for the pragma itself (research_finding 5555895c): PRAGMA
// user_version lives at header offset 60 and is fully the application's own
// to use; `schema_version` is SQLite-internal and this feature must never
// touch it.
//
// Raw pragma access below goes through node:sqlite's DatabaseSync directly
// against the .db file on disk — SterlingStore is never asked to expose a
// pragma reader, so these tests observe the marker exactly the way an
// external tool (or a fresh second connection) would.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

function tempDbPath(prefix = 'sterling-schema-guard-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'sterling.db') };
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

/** Raw, out-of-band pragma write — simulates states the real migration would never write itself. */
function rawSetUserVersion(path: string, value: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

/** Raw table-name snapshot — used to prove a refused open writes NOTHING, not even a new table. */
function rawTableNames(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name)
      .sort();
  } finally {
    db.close();
  }
}

// test-repair 2026-08-22 [stable-identity-design-v2]: A1/A2 pinned the S1-era
// contract (marker = 1; legacy stores auto-stamped forward on open). Schema v2
// advances the marker to 2, and refuse-until-migrated REPLACES the auto-stamp:
// a pre-v2 store with data must never be stamped forward without the data
// migration actually running (S4's journaled runner) — it opens readable and
// refuses writes loudly instead.

test('A1: a freshly created store stamps PRAGMA user_version = 2 at open', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    store.close();
    assert.equal(rawUserVersion(path), 2, 'a brand-new store file is stamped to the currently-supported schema version (2)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2: a pre-v2 store is NOT stamped forward on open — it opens read-only-pre-migration: reads work, writes refuse naming the migration, marker unchanged across repeated opens', () => {
  const { dir, path } = tempDbPath();
  try {
    // Create a real, fully-initialized store, then roll its marker back to
    // SIMULATE a pre-v2 legacy file on an otherwise real schema.
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 1);
    assert.equal(rawUserVersion(path), 1, 'precondition: the file now looks like a pre-v2 (S1-era) store');

    const first = new SterlingStore(path);
    assert.doesNotThrow(() => first.query({}), 'reads are allowed pre-migration');
    assert.throws(
      () =>
        first.create({
          id: '00000000-0000-4000-8000-000000000000',
          type: 'decision',
          created_at: '2026-08-22T00:00:00.000Z',
          updated_at: '2026-08-22T00:00:00.000Z',
          author: 'conductor',
          status: 'active',
          superseded_by: null,
          links: [],
          scope: 'project',
          stack_tags: ['node'],
          title: 'probe',
          statement: 'write probe against a pre-v2 store',
          alternatives_rejected: [],
          rationale: 'must refuse',
          file_keys: [],
        } as never),
      /migrat/i,
      'a write against a pre-v2 store refuses loudly, naming the required migration'
    );
    first.close();
    assert.equal(rawUserVersion(path), 1, 'the marker was NOT stamped forward — refuse-until-migrated, never auto-migrate');

    const second = new SterlingStore(path);
    second.close();
    assert.equal(rawUserVersion(path), 1, 'a second open still does not advance the marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3: a store whose user_version is GREATER than the code supports refuses to open, and writes nothing', () => {
  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 99);
    const tablesBefore = rawTableNames(path);
    const versionBefore = rawUserVersion(path);
    assert.equal(versionBefore, 99, 'precondition: the fixture file claims a future, unsupported schema version');

    assert.throws(
      () => new SterlingStore(path),
      /./,
      'opening a store whose user_version exceeds what this code supports must throw, not silently proceed'
    );

    assert.equal(rawUserVersion(path), 99, 'the refused open must not touch user_version — still 99 after the throw');
    assert.deepEqual(rawTableNames(path), tablesBefore, 'the refused open creates no new tables — no write of any kind lands on the db');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4: the refusal is a structured, renderable error naming BOTH the found and supported versions and the word "schema"', () => {
  const supported = tempDbPath('sterling-schema-guard-probe2-');
  const probe = new SterlingStore(supported.path);
  probe.close();
  const supportedVersion = rawUserVersion(supported.path);
  rmSync(supported.dir, { recursive: true, force: true });

  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 99);

    let caught: unknown;
    try {
      new SterlingStore(path);
      assert.fail('constructing a store over an unsupported (too-new) schema version must throw');
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error, 'the refusal is a real Error (or subclass), not a bare string or null');
    const message = (caught as Error).message;
    assert.match(message, /schema/i, 'the message names the concept — "schema" — so the MCP server surface can render a meaningful failure');
    assert.match(message, /99/, 'the message names the FOUND version (99)');
    assert.ok(message.includes(String(supportedVersion)), `the message names the SUPPORTED version (${supportedVersion}) alongside the found one`);
    assert.match(message, /downgrade/i, 'the message instructs against writing with an older/downgraded build over a newer schema');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A5 — fail-open hole fix (2026-08-29): the constructor's user_version stamp
// used to run inside tx() (BEGIN IMMEDIATE) on EVERY open, so opening an
// already-stamped, healthy store took a write lock it never needed, contended
// against any other writer, waited out the 5s busy_timeout, and threw — a
// throw ~18 hook callers' runner reads as non-blocking (exit 1 = fail-open).
// The stamp is now guarded by `if (foundSchemaVersion !== SUPPORTED_SCHEMA_VERSION)`.
// This pin needs TWO verdicts: no-throw alone would still pass a regression
// that raises busy_timeout instead of removing the lock, so elapsed time is
// asserted too. The control arm (no lock held) runs FIRST so a green measured
// arm cannot be explained by a fixture whose lock never materialized.
test('A5: opening an already-stamped, healthy store takes no write lock — succeeds fast even while another connection holds BEGIN IMMEDIATE', () => {
  // CONTROL ARM, placed first: same open, no lock held anywhere, must also
  // succeed fast. Without this, a fast "pass" on the measured arm below could
  // just mean the lock-fixture never actually materialized a lock.
  {
    const { dir, path } = tempDbPath('sterling-schema-guard-a5-control-');
    try {
      const seed = new SterlingStore(path);
      seed.close();
      const start = Date.now();
      const store = new SterlingStore(path);
      const elapsed = Date.now() - start;
      store.close();
      assert.ok(elapsed < 1000, `control: opening with no lock held anywhere must be fast (was ${elapsed}ms)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // MEASURED ARM: another connection holds a real write lock (BEGIN IMMEDIATE
  // plus a DDL statement, which is what forces the lock to actually
  // materialize rather than staying a no-op reservation).
  const { dir, path } = tempDbPath('sterling-schema-guard-a5-');
  let holder: DatabaseSync | undefined;
  try {
    const seed = new SterlingStore(path);
    seed.close();
    assert.equal(rawUserVersion(path), 2, 'precondition: the fixture is already stamped at the currently-supported schema version');

    holder = new DatabaseSync(path);
    holder.exec('PRAGMA busy_timeout=0');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec('CREATE TABLE IF NOT EXISTS zz_lock (x)');

    const start = Date.now();
    let store: SterlingStore | undefined;
    assert.doesNotThrow(() => {
      store = new SterlingStore(path);
    }, 'opening an already-stamped, healthy store must succeed even while another connection holds a write lock — nothing needs stamping, so the open must never attempt to take a write lock at all');
    const elapsed = Date.now() - start;
    store?.close();

    assert.ok(
      elapsed < 1000,
      `opening must not busy-wait for a write lock it does not need (took ${elapsed}ms, vs. the 5000ms busy_timeout the defect used to burn through)`
    );
  } finally {
    if (holder) {
      try {
        holder.exec('ROLLBACK');
      } finally {
        holder.close();
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
