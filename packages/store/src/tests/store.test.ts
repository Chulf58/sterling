import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';
const LATER = '2026-06-10T13:00:00.000Z';

function envelope(type: string, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'Use SQLite',
    statement: 'SQLite is the storage substrate.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'Meets all retrieval criteria.',
    file_keys: ['packages/store/src/index.ts'],
    ...over,
  };
}

function article(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as a CSV file for spreadsheets.',
    intended_behavior: 'User clicks Export and receives a CSV download.',
    files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-store-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

test('WAL mode is active on a file-backed store (§3.1 criterion 6)', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(store.journalMode(), 'wal');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create validates: unregistered type and malformed record are rejected, nothing written', () => {
  const { dir, store } = tempStore();
  try {
    assert.throws(() => store.create({ ...envelope('anti_pattern'), title: 'x' }), /unregistered record type/);
    assert.throws(() => store.create(decision({ rationale: '' })), /rationale/i);
    assert.equal(store.query({ cap: 100 }).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('path invariant holds at the write boundary: backslash file_keys are stored POSIX (§3.2)', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ file_keys: ['src\\auth\\login.ts'] }));
    const roundtrip = store.get(d.id);
    assert.ok(roundtrip && 'file_keys' in roundtrip);
    assert.deepEqual((roundtrip as { file_keys: string[] }).file_keys, ['src/auth/login.ts']);
    // file-key join finds it via the normalized form — and via a backslash query, normalized at the read boundary too
    assert.equal(store.query({ file_keys: ['src/auth/login.ts'] }).length, 1);
    assert.equal(store.query({ file_keys: ['src\\auth\\login.ts'] }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query: filter by type and stack tags, file-key join, cap (§3.4 order)', () => {
  const { dir, store } = tempStore();
  try {
    store.create(decision({ stack_tags: ['node'] }));
    store.create(decision({ stack_tags: ['python'], file_keys: ['src/py/x.py'] }));
    store.create(article());
    assert.equal(store.query({ types: ['decision'] }).length, 2);
    assert.equal(store.query({ types: ['decision'], stack_tags: ['python'] }).length, 1);
    assert.equal(store.query({ file_keys: ['src/export/csv.ts'] }).length, 1);
    assert.equal(store.query({ types: ['decision'], cap: 1 }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rank: bm25 over rank_terms orders matching records first; freeform questions rejected (§3.4)', () => {
  const { dir, store } = tempStore();
  try {
    store.create(article({ slug: 'csv-export', title: 'CSV export', what_it_does: 'Exports board data as CSV.' }));
    store.create(
      article({
        slug: 'auth-login',
        title: 'Login',
        what_it_does: 'Authenticates users against the directory.',
        intended_behavior: 'User signs in with corporate credentials.',
      })
    );
    const ranked = store.query({ types: ['feature_article'], rank_terms: ['csv'] });
    assert.equal(ranked.length, 1, 'bm25 path returns only MATCHing records');
    assert.equal((ranked[0] as { slug: string }).slug, 'csv-export');
    assert.throws(() => store.query({ rank_terms: ['what is the best way to export?'] }), /single keywords/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback rank without rank_terms: file-key overlap count, then updated_at desc (§3.4)', () => {
  const { dir, store } = tempStore();
  try {
    store.create(decision({ file_keys: ['src/a.ts'], title: 'one key', updated_at: LATER, created_at: LATER }));
    store.create(decision({ file_keys: ['src/a.ts', 'src/b.ts'], title: 'two keys' }));
    const ranked = store.query({ file_keys: ['src/a.ts', 'src/b.ts'] });
    assert.equal((ranked[0] as { title: string }).title, 'two keys', 'higher overlap ranks first');
    const tie = store.query({ types: ['decision'] });
    assert.equal((tie[0] as { title: string }).title, 'one key', 'tie breaks on updated_at desc');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derived_unconfirmed is excluded by default, included on opt-in (§3.2.6)', () => {
  const { dir, store } = tempStore();
  try {
    store.create(decision({ derived_unconfirmed: true, title: 'unconfirmed extraction' }));
    store.create(decision({ title: 'confirmed' }));
    assert.equal(store.query({ types: ['decision'] }).length, 1);
    assert.equal(store.query({ types: ['decision'], include_unconfirmed: true }).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersede: old retained + flagged, new active with supersedes link; version chain enforced (§3.1 c3)', () => {
  const { dir, store } = tempStore();
  try {
    const v1 = store.create(article());
    const v2 = store.supersede(v1.id, article({ version: 2, what_it_does: 'Exports the board as CSV with headers.' }));
    const oldRec = store.get(v1.id)!;
    assert.equal(oldRec.status, 'superseded');
    assert.equal(oldRec.superseded_by, v2.id);
    assert.ok(v2.links.some((l) => l.rel === 'supersedes' && l.target_id === v1.id), 'supersedes link auto-ensured');
    assert.equal(store.query({ types: ['feature_article'] }).length, 1, 'only the active version is retrieved');
    assert.equal(store.get(v1.id)!.id, v1.id, 'prior version is retained');
    assert.throws(() => store.supersede(v2.id, article({ version: 2 })), /version must increase/);
    assert.throws(() => store.supersede(v1.id, article({ version: 3 })), /not active/);
    assert.throws(() => store.supersede(v2.id, decision()), /type mismatch/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decision immutability path: supersession works and is the only change primitive exposed', () => {
  const { dir, store } = tempStore();
  try {
    const d1 = store.create(decision());
    const d2 = store.supersede(d1.id, decision({ statement: 'Revised choice.' }));
    assert.equal(store.get(d1.id)!.status, 'superseded');
    assert.equal(store.get(d2.id)!.status, 'active');
    assert.equal(typeof (store as unknown as { update?: unknown }).update, 'undefined', 'no in-place update API exists');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove deletes the record and all index rows (P4 todo path)', () => {
  const { dir, store } = tempStore();
  try {
    const t = store.create({ ...envelope('todo'), text: 'reconcile auth article', source: 'user', file_keys: ['src/a.ts'] });
    assert.equal(store.query({ types: ['todo'] }).length, 1);
    store.remove(t.id);
    assert.equal(store.get(t.id), undefined);
    assert.equal(store.query({ types: ['todo'] }).length, 0);
    assert.equal(store.query({ file_keys: ['src/a.ts'] }).length, 0);
    assert.equal(store.query({ rank_terms: ['reconcile'] }).length, 0, 'fts row removed');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent access: a second connection reads while the first is open (WAL, §3.1 c6)', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision());
    const second = new SterlingStore(join(dir, 'sterling.db'));
    try {
      assert.equal(second.get(d.id)!.id, d.id);
      const t = second.create({ ...envelope('todo'), text: 'tui-written todo', source: 'user' });
      assert.equal(store.get(t.id)!.id, t.id, 'first connection sees second connection write');
    } finally {
      second.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot: VACUUM INTO produces an openable copy; refuses to overwrite (§2.3)', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision());
    const target = join(dir, 'backups', 'snap.db');
    store.snapshot(target);
    assert.ok(existsSync(target));
    const restored = new SterlingStore(target);
    try {
      assert.equal(restored.get(d.id)!.id, d.id);
    } finally {
      restored.close();
    }
    assert.throws(() => store.snapshot(target), /refusing to overwrite/);
    writeFileSync(join(dir, 'occupied.db'), 'x');
    assert.throws(() => store.snapshot(join(dir, 'occupied.db')), /refusing to overwrite/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
