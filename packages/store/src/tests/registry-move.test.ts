// Project registry identity across folder moves (GitHub issue #119, decision
// moving-a-project-folder-repoints-the-registry-and-keeps-old-paths-as-aliases):
// each row has a stable project_key; project_occupancy records which key held
// which path when. A tracker resolves through the interval on its to_root that
// contains its created_at, to that key's current row or its tombstone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATED_FROM, ProjectRegistry, resolveReceiverLocation } from '../index.js';

const T0 = '2026-10-15T10:00:00.000Z';
const T1 = '2026-10-16T10:00:00.000Z';
const T2 = '2026-10-17T10:00:00.000Z';
const T3 = '2026-10-18T10:00:00.000Z';
const T4 = '2026-10-19T10:00:00.000Z';
const T5 = '2026-10-20T10:00:00.000Z';

function withRegistry(fn: (reg: ProjectRegistry) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-registry-move-'));
  const reg = new ProjectRegistry(join(dir, 'registry.db'));
  try {
    fn(reg);
  } finally {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const register = (reg: ProjectRegistry, repo_path: string, name: string, at = T0) =>
  reg.register({ repo_path, name, stack_tags: ['node'], toolchains: [], sterling_version: '1.0.0', at });

/** Where a tracker at `to_root` created at `createdAt` resolves: [name, current path] or the reason. */
const where = (reg: ProjectRegistry, to_root: string, to_name: string, createdAt: string | undefined) => {
  const r = resolveReceiverLocation({ to_root, to_name }, createdAt, reg.snapshot());
  return 'row' in r ? [r.row.name, r.row.repo_path] : r.reason;
};

test('a pre-branch registry (projects table only) opens with every row kept, each row keyed with an open interval from the earliest time; reopening changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-registry-migrate-'));
  try {
    const path = join(dir, 'registry.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE projects (repo_path TEXT PRIMARY KEY, name TEXT NOT NULL, stack_tags TEXT NOT NULL, toolchains TEXT NOT NULL,
      sterling_version TEXT, first_init_at TEXT NOT NULL, last_init_at TEXT NOT NULL, last_seen_at TEXT)`);
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('/p/a', 'a', '["node"]', '[]', '0.1.0', T1, T2, T3);
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('/p/b', 'b', '[]', '["node"]', null, T1, T1, null);
    old.close();
    let first: unknown;
    for (let i = 0; i < 2; i++) {
      const reg = new ProjectRegistry(path);
      try {
        assert.deepEqual(reg.list(), [
          { repo_path: '/p/a', name: 'a', stack_tags: ['node'], toolchains: [], sterling_version: '0.1.0', first_init_at: T1, last_init_at: T2, last_seen_at: T3 },
          { repo_path: '/p/b', name: 'b', stack_tags: [], toolchains: ['node'], sterling_version: null, first_init_at: T1, last_init_at: T1, last_seen_at: null },
        ]);
        const snap = reg.snapshot();
        assert.equal(new Set(snap.rows.map((r) => r.project_key)).size, 2, 'each row has its own key');
        assert.deepEqual(
          snap.occupancy.map((o) => [o.path, o.from_at, o.to_at, o.project_key === snap.rows.find((r) => r.repo_path === o.path)?.project_key]),
          [['/p/a', MIGRATED_FROM, null, true], ['/p/b', MIGRATED_FROM, null, true]]
        );
        if (i === 0) first = snap;
        else assert.deepEqual(snap, first, 'the second open keeps the keys and adds no interval');
      } finally {
        reg.close();
      }
    }
    // a tracker older than the migration resolves to today's occupant
    const reg = new ProjectRegistry(path);
    try {
      assert.deepEqual(where(reg, '/p/a', 'a', '2020-01-01T00:00:00.000Z'), ['a', '/p/a']);
    } finally {
      reg.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moveProject keeps the key, closes the old interval and opens one at the new path; refused moves write nothing', () => {
  withRegistry((reg) => {
    register(reg, '/p/A', 'proj');
    register(reg, '/p/other', 'other');
    const key = reg.keyOf('/p/A');
    assert.deepEqual(reg.moveProject('/p/A', '/p/B', T1), { status: 'moved' });
    assert.deepEqual(reg.moveProject('/p/B', '/p/C', T2), { status: 'moved' });
    register(reg, '/p/C', 'proj', T3);
    assert.deepEqual(reg.moveProject('/p/C', '/p/A', T4), { status: 'moved' });
    assert.equal(reg.keyOf('/p/A'), key, 'the key survives moves and re-init');
    const moved = reg.list().find((r) => r.name === 'proj');
    assert.equal(moved?.first_init_at, T0, 'a move keeps first_init_at (re-init at T3 moved last_init_at only)');
    assert.equal(moved?.last_init_at, T3);
    assert.deepEqual(
      reg.occupancy().filter((o) => o.project_key === key).map((o) => [o.path, o.from_at, o.to_at]),
      [['/p/A', T0, T1], ['/p/B', T1, T2], ['/p/C', T2, T4], ['/p/A', T4, null]]
    );
    // trackers from each era all reach the project, now back at A
    for (const [root, at] of [['/p/A', T0], ['/p/B', T1], ['/p/C', T3], ['/p/A', T5]] as const) assert.deepEqual(where(reg, root, 'proj', at), ['proj', '/p/A']);

    const before = reg.occupancy();
    assert.deepEqual(reg.moveProject('/p/A', '/p/other', T5), { status: 'conflict', conflict_path: '/p/other' });
    assert.deepEqual(reg.moveProject('/p/nowhere', '/p/D', T5), { status: 'missing' });
    assert.deepEqual(reg.moveProject('/p/A', '/p/A', T5), { status: 'unchanged' });
    assert.deepEqual(reg.occupancy(), before);
    assert.equal(reg.list().find((r) => r.name === 'proj')?.repo_path, '/p/A');
  });
});

test('Sol repro 1: A moves to B, a newcomer registers at A and moves to C; a pre-move tracker at A still resolves to the original at B', () => {
  withRegistry((reg) => {
    register(reg, '/p/A', 'original');
    reg.moveProject('/p/A', '/p/B', T1);
    register(reg, '/p/A', 'newcomer', T2);
    reg.moveProject('/p/A', '/p/C', T3);
    assert.deepEqual(where(reg, '/p/A', 'original', T0), ['original', '/p/B']);
    assert.deepEqual(where(reg, '/p/A', 'newcomer', T2), ['newcomer', '/p/C'], 'a tracker from the newcomer era follows the newcomer');
  });
});

test('Sol repro 2: A moves to B, B is removed, a replacement registers at B; the old tracker reads "no longer registered", never the replacement', () => {
  withRegistry((reg) => {
    register(reg, '/p/A', 'original');
    reg.moveProject('/p/A', '/p/B', T1);
    assert.equal(reg.remove('/p/B', T2), true);
    register(reg, '/p/B', 'replacement', T3);
    assert.deepEqual(where(reg, '/p/A', 'original', T0), `the project at /p/A when this tracker was created is no longer registered (it was last registered at /p/B until ${T2})`);
    assert.deepEqual(where(reg, '/p/B', 'original', T1), `the project at /p/B when this tracker was created is no longer registered (it was last registered at /p/B until ${T2})`);
    assert.deepEqual(where(reg, '/p/B', 'replacement', T4), ['replacement', '/p/B']);
    assert.notEqual(reg.keyOf('/p/B'), undefined);
  });
});

test('no created_at, or no interval containing it: the row at the root now, then a unique name, else a reason', () => {
  withRegistry((reg) => {
    register(reg, '/p/old', 'moved');
    reg.moveProject('/p/old', '/p/new', T1);
    register(reg, '/p/old', 'newcomer', T2);
    assert.deepEqual(where(reg, '/p/old', 'moved', undefined), ['newcomer', '/p/old']);
    assert.deepEqual(where(reg, '/p/gone', 'moved', T0), ['moved', '/p/new'], 'falls back to the name');
    assert.equal(where(reg, '/p/gone', 'nobody', T0), "no registered project has its root /p/gone or its name 'nobody'");
  });
});
