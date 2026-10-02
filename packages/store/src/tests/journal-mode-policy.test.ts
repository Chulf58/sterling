// Journal-mode policy pins (decision store-journal-policy-delete-on-9p):
// WAL's shm coordination is unsupported over the 9p/drvfs mount, so a store
// opened over 9p (linux + /mnt/<drive>/) is demoted to journal_mode=DELETE,
// LOUDLY (a refused demotion throws and closes — proceeding in WAL would keep
// the exact unsafe topology this exists to remove). The demotion is STICKY:
// a non-9p open of an EXISTING store already in DELETE leaves it alone rather
// than flipping it back (a native-Windows open must not fight a WSL demotion).
// Fresh stores are classified explicitly because a brand-new SQLite file is
// born in DELETE mode — without the freshness arm, single-context stores
// would never enter WAL at all (Codex consult 2026-08-27, adopted).
//
// CONTROL ARM (must pass for the OPPOSITE reason, placed first): a fresh
// store on a normal filesystem still lands in WAL — this goes red if the
// implementation hardcodes DELETE everywhere, which a demotion-only pin
// would survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, accessSync, mkdirSync, symlinkSync, constants } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore, journalDemotionRequired, JournalDemotionRefusedError } from '../index.js';

function rawMode(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  } finally {
    db.close();
  }
}

test('fresh store on a non-9p path opens in WAL (control arm — anti-hardcode)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-fresh-'));
  try {
    const store = new SterlingStore(join(dir, 'store.db'));
    store.close();
    assert.equal(rawMode(join(dir, 'store.db')), 'wal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journalDemotionRequired: linux + /mnt/<single letter>/ only', () => {
  assert.equal(journalDemotionRequired('/mnt/c/Users/x/proj/store.db', 'linux'), true);
  assert.equal(journalDemotionRequired('/mnt/D/proj/store.db', 'linux'), true);
  assert.equal(journalDemotionRequired('/mnt/wsl/store.db', 'linux'), false);
  assert.equal(journalDemotionRequired('/mnt/cd/store.db', 'linux'), false);
  assert.equal(journalDemotionRequired('/home/x/proj/store.db', 'linux'), false);
  assert.equal(journalDemotionRequired('/tmp/store.db', 'linux'), false);
  assert.equal(journalDemotionRequired('C:/Users/x/proj/store.db', 'win32'), false);
  assert.equal(journalDemotionRequired('/mnt/c/Users/x/store.db', 'win32'), false);
  assert.equal(journalDemotionRequired('/mnt/c/Users/x/store.db', 'darwin'), false);
});

test('existing store already in DELETE stays DELETE on a non-9p reopen (sticky)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-sticky-'));
  const path = join(dir, 'store.db');
  try {
    new SterlingStore(path).close(); // create as WAL
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode=DELETE');
    raw.close();
    assert.equal(rawMode(path), 'delete');
    const store = new SterlingStore(path); // must NOT flip it back to WAL
    store.close();
    assert.equal(rawMode(path), 'delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing store in WAL stays WAL on a non-9p reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-wal-'));
  const path = join(dir, 'store.db');
  try {
    new SterlingStore(path).close();
    assert.equal(rawMode(path), 'wal');
    new SterlingStore(path).close();
    assert.equal(rawMode(path), 'wal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ninePTempDir(): string | null {
  // A genuine drvfs mount is required — the demotion arm must be exercised
  // against the real topology, not a seam. On machines without one (CI,
  // pure-Linux consumers) these tests skip loudly rather than pass hollow.
  const user = userInfo().username;
  const candidates = [
    join('/mnt/c/Users', user, 'AppData', 'Local', 'Temp'),
    '/mnt/c/Temp',
    '/mnt/c/Windows/Temp',
  ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.W_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

test('fresh store opened over 9p (/mnt/<drive>) is demoted to DELETE', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const dir = join(base, `sterling-jm-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  try {
    const store = new SterlingStore(path);
    store.close();
    assert.equal(rawMode(path), 'delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9p open of an existing WAL store demotes it to DELETE once, then stays', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const dir = join(base, `sterling-jm2-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  try {
    // Simulate a pre-policy store: WAL, with schema, stamped current.
    const supported = (() => {
      const probe = join(dir, 'probe.db');
      new SterlingStore(probe).close();
      const p = new DatabaseSync(probe, { readOnly: true });
      const v = (p.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      p.close();
      return v;
    })();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode=WAL');
    raw.exec('CREATE TABLE IF NOT EXISTS t (x)'); // non-fresh
    raw.exec(`PRAGMA user_version = ${supported}`); // current, so not legacy-read-only
    raw.close();
    assert.equal(rawMode(path), 'wal');
    const store = new SterlingStore(path);
    store.close();
    assert.equal(rawMode(path), 'delete');
    // and the SECOND 9p open is the idempotent no-op arm — still delete
    new SterlingStore(path).close();
    assert.equal(rawMode(path), 'delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refused 9p demotion fails LOUD and closes (never proceeds in WAL)', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const dir = join(base, `sterling-jm3-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  try {
    new SterlingStore(path).close(); // created as DELETE under 9p by the policy itself
    // Force it back to WAL so the demotion has real work to do, then hold a
    // read transaction from a second connection: exiting WAL requires an
    // exclusive lock, so the demotion cannot complete.
    const flip = new DatabaseSync(path);
    flip.exec('PRAGMA journal_mode=WAL');
    flip.close();
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN');
    holder.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    try {
      assert.throws(
        () => new SterlingStore(path),
        (e: unknown) =>
          e instanceof JournalDemotionRefusedError &&
          // Discriminate the two refusal arms: when the busy-path wrap fired
          // (message says the PRAGMA threw), the original driver error must
          // ride along as `cause` — a wrap that loses it is a regression.
          (!/PRAGMA threw/.test(e.message) || (e as Error & { cause?: unknown }).cause instanceof Error),
        'open must throw a TYPED refusal, not a bare driver error, when the demotion cannot land',
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    // The store file must still be WAL — nothing half-applied.
    assert.equal(rawMode(path), 'wal');
    // Close evidence: reopening the SAME path now that the holder released
    // proves the refused constructor's own handle was closed — a leaked
    // connection would contend with this reopen's demotion.
    const reopened = new SterlingStore(path);
    reopened.close();
    assert.equal(rawMode(path), 'delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy-schema store found in WAL over 9p is refused, distinctly', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const dir = join(base, `sterling-jm4-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  try {
    new SterlingStore(path).close();
    const flip = new DatabaseSync(path);
    flip.exec('PRAGMA journal_mode=WAL');
    flip.exec('PRAGMA user_version = 1'); // below supported → legacy read-only branch
    flip.close();
    assert.equal(rawMode(path), 'wal');
    assert.throws(
      () => new SterlingStore(path),
      (e: unknown) =>
        e instanceof JournalDemotionRefusedError &&
        /legacy/i.test((e as Error).message) &&
        /migrate-stores/.test((e as Error).message),
      'legacy-in-WAL-over-9p must refuse distinctly, naming the migration remedy',
    );
    assert.equal(rawMode(path), 'wal', 'refused read-only open must have written nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: legacy-schema store already in DELETE over 9p still opens read-only', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const dir = join(base, `sterling-jm5-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  try {
    new SterlingStore(path).close(); // born DELETE under 9p
    const flip = new DatabaseSync(path);
    flip.exec('PRAGMA user_version = 1'); // below supported → legacy read-only branch
    flip.close();
    assert.equal(rawMode(path), 'delete');
    const store = new SterlingStore(path);
    assert.doesNotThrow(() => store.query({}));
    store.close();
    assert.equal(rawMode(path), 'delete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked path resolving onto a 9p dir classifies as 9p', (t) => {
  const base = ninePTempDir();
  if (!base) {
    t.skip('no writable /mnt/<drive> temp dir on this machine — 9p demotion arm not exercised here');
    return;
  }
  const realDir = join(base, `sterling-jm6-real-${process.pid}-${Date.now()}`);
  mkdirSync(realDir, { recursive: true });
  const linkDir = join(tmpdir(), `sterling-jm6-link-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(realDir, linkDir, 'dir');
    const store = new SterlingStore(join(linkDir, 'store.db'));
    store.close();
    assert.equal(rawMode(join(realDir, 'store.db')), 'delete');
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
});
