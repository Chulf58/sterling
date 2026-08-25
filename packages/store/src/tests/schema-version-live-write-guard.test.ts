// ---------------------------------------------------------------------------
// PIN GROUP B — LIVE (in-handle) schema-version write guard. Board d5942fa0,
// gap (b): "a process (MCP server OR TUI) that ALREADY HOLDS the store open
// before another process migrates it keeps serving on its stale in-memory
// handle with no re-check until full restart". Pin group A
// (schema-version-guard.test.ts) covers the OPEN-time guard only — a store
// that is already open, mid-session, when user_version moves underneath it
// is entirely uncovered there.
//
// SPEC (conductor-settled, board d5942fa0 + dispatch): every public WRITE
// operation re-reads PRAGMA user_version immediately before mutating; if it
// differs from the version captured at open, the operation throws (no
// partial write) with a loud, structured error naming BOTH versions
// (opened-at vs current-on-disk) and framed as a "relaunch" instruction,
// matching the store's existing loud-failure style (H1/rotation-note.mjs
// "EXIT AND RELAUNCH" wording, board d5942fa0). READ operations are NOT
// required to re-check — they may keep serving on the stale handle. A write
// with an UNCHANGED live version proceeds exactly as today.
//
// IMPLEMENTED 2026-08-25 (board d5942fa0): assertLiveSchemaVersion re-reads
// PRAGMA user_version inside tx()'s BEGIN IMMEDIATE (post-lock, closing the
// check-then-act TOCTOU); the 3 autocommit writers writeHandoff/writeSelection/
// recordCheckSkipped are wrapped in tx() to inherit it. All five pins below are
// GREEN. Their ORIGINAL red-before-green roles, kept for provenance:
//   - B1 (control): passes for the OPPOSITE reason to B2 — a live write with no
//     version drift succeeds — ruling out "this store just throws on every
//     create()" as a confound for B2's verdict. Placed FIRST.
//   - B2: an interleaved-version write throws (both versions named, relaunch-
//     framed) before any mutation.
//   - B3: the refused write leaves no partial row (checked out-of-band).
//   - B4 (read exemption, boundary pin): reads never re-check user_version —
//     guards against an over-eager impl that checks reads too and breaks live
//     availability, which the board item explicitly does not want.
//   - B5: a SECOND write method (remove) is guarded too, ruling out a
//     create()-only implementation.
// NOTE: the frozen pins are bump-then-call, so they verify the guard EXISTS and
// is not create()-only; they do NOT drive an actual read/BEGIN-IMMEDIATE
// interleave, so the specific race-closing property rests on SQLite lock
// semantics (a second BEGIN IMMEDIATE cannot interleave once this one holds the
// write lock), independently confirmed by outside-family review 2026-08-25.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

function tempDbPath(prefix = 'sterling-live-write-guard-') {
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

/** Raw, out-of-band pragma write — simulates a SECOND process migrating the file while this handle stays open. */
function rawSetUserVersion(path: string, value: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

/** Raw, out-of-band row lookup in the `records` table (sqlite-store article: durable knowledge table). */
function rawRecordExists(path: string, id: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT id FROM records WHERE id = ?').get(id);
    return row !== undefined;
  } finally {
    db.close();
  }
}

function decisionRecord(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'decision',
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'live-write guard probe',
    statement: 'probe record used only to exercise the write path under a live schema-version drift',
    alternatives_rejected: [],
    rationale: 'must observe write-time behavior against a live (in-handle) schema-version guard',
    file_keys: [],
    ...over,
  };
}

test('B1 (CONTROL for B2): a write proceeds normally when the live version is UNCHANGED since open — rules out "this store just throws on every create()" as an alternate explanation for B2', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    const id = '00000000-0000-4000-8000-0000000000b1';
    assert.doesNotThrow(() => store.create(decisionRecord(id) as never), 'no live-version drift occurred — the write must not be refused');
    const got = store.get(id);
    assert.ok(got, 'the record round-trips through get() after a successful write');
    assert.equal((got as { id: string }).id, id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B2: a write throws when the live user_version has moved since open, naming BOTH versions and framed as a relaunch', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    const openedVersion = rawUserVersion(path);
    const bumpedVersion = openedVersion + 7;
    rawSetUserVersion(path, bumpedVersion); // a SECOND process migrates the file while this handle stays open

    const id = '00000000-0000-4000-8000-0000000000b2';
    let threw = false;
    let caught: unknown = null;
    try {
      store.create(decisionRecord(id) as never);
    } catch (err) {
      threw = true;
      caught = err;
    }
    assert.equal(threw, true, 'a write against a store whose live schema version moved since open must throw');
    assert.ok(caught instanceof Error, 'the refusal is a real Error (or subclass), not a bare string or null');
    const message = (caught as Error).message;
    assert.ok(message.includes(String(openedVersion)), `message names the version captured AT OPEN (${openedVersion})`);
    assert.ok(message.includes(String(bumpedVersion)), `message names the CURRENT live version found on write (${bumpedVersion})`);
    assert.match(message, /relaunch/i, 'the refusal is framed as a relaunch, matching the store\'s existing loud-failure style (H1/rotation-note.mjs wording)');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3: a refused live-version write leaves NO partial row — the create is fully rolled back, not partially applied', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    const openedVersion = rawUserVersion(path);
    rawSetUserVersion(path, openedVersion + 3);

    const id = '00000000-0000-4000-8000-0000000000b3';
    try {
      store.create(decisionRecord(id) as never);
    } catch {
      // expected refusal — verified in B2; this test only checks the row state
    }
    store.close();

    assert.equal(rawRecordExists(path, id), false, 'no row was written for the refused create — the write left no partial state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4 (boundary): a READ after an out-of-band live-version bump does NOT throw — reads stay exempt from the live re-check', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    const id = '00000000-0000-4000-8000-0000000000b4';
    store.create(decisionRecord(id) as never); // seed BEFORE the bump, while the version is unchanged
    const openedVersion = rawUserVersion(path);
    rawSetUserVersion(path, openedVersion + 4);

    let got: unknown;
    assert.doesNotThrow(() => {
      got = store.get(id);
    }, 'reads are NOT required to re-check the live schema version (spec: read exemption)');
    assert.equal((got as { id: string } | undefined)?.id, id, 'the read still returns the seeded record correctly, unaffected by the live drift');

    assert.doesNotThrow(() => store.query({ types: ['decision'] }), 'query() is a read too — also exempt from the live re-check');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5: a SECOND public write method (remove) is independently guarded — the live re-check is not special-cased to create() alone', () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SterlingStore(path);
    const id = '00000000-0000-4000-8000-0000000000b5';
    store.create(decisionRecord(id) as never); // seed while the version is unchanged
    const openedVersion = rawUserVersion(path);
    const bumpedVersion = openedVersion + 9;
    rawSetUserVersion(path, bumpedVersion);

    let threw = false;
    let caught: unknown = null;
    try {
      store.remove(id);
    } catch (err) {
      threw = true;
      caught = err;
    }
    assert.equal(threw, true, 'remove() must ALSO re-read the live user_version before mutating — refusing identically to create()');
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    const message = (caught as Error).message;
    assert.ok(message.includes(String(openedVersion)), `message names the version captured AT OPEN (${openedVersion})`);
    assert.ok(message.includes(String(bumpedVersion)), `message names the CURRENT live version found on write (${bumpedVersion})`);
    assert.match(message, /relaunch/i, 'the refusal is framed as a relaunch, matching create()\'s refusal style');

    store.close();
    assert.equal(rawRecordExists(path, id), true, 'the record seeded before the bump is still present — the refused remove() left it untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
