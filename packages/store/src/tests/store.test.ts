import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import type { QueryOptions } from '../index.js';

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
    assert.throws(() => store.create({ ...envelope('escalation_log'), title: 'x' }), /unregistered record type/);
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

test('count: COUNT(*) over the §3.4 base filter never drifts from query().length (type/stack-tag/file-key); no body fetch', () => {
  const { dir, store } = tempStore();
  try {
    store.create(decision({ stack_tags: ['node'] }));
    store.create(decision({ stack_tags: ['python'], file_keys: ['src/py/x.py'] }));
    store.create(article());
    const cases: Record<string, unknown>[] = [
      { types: ['decision'] },
      { types: ['feature_article'] },
      { types: ['anti_pattern'] }, // none anywhere → 0
      { types: ['decision'], stack_tags: ['node'] },
      { file_keys: ['src/py/x.py'] },
    ];
    for (const opts of cases) {
      assert.equal(store.count(opts), store.query({ ...opts, cap: 1000 }).length, `count == query length for ${JSON.stringify(opts)}`);
    }
    assert.equal(store.count({ types: ['decision'] }), 2);
    assert.equal(store.count({ types: ['anti_pattern'] }), 0, 'a type with no records → 0');
    // superseded excluded (same base filter as query): supersede one decision
    const node = store.query({ types: ['decision'], stack_tags: ['node'] })[0] as { id: string };
    store.supersede(node.id, decision({ stack_tags: ['node'], statement: 'v2' }));
    assert.equal(store.count({ types: ['decision'] }), 2, 'the superseded original is not counted; its active replacement is');
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

    // trailing '*' = FTS5 prefix query (the star sits outside the quoted token)
    const prefixed = store.query({ types: ['feature_article'], rank_terms: ['authent*'] });
    assert.equal(prefixed.length, 1, "'authent*' prefix-matches 'Authenticates'");
    assert.equal((prefixed[0] as { slug: string }).slug, 'auth-login');
    assert.equal(store.query({ types: ['feature_article'], rank_terms: ['authent'] }).length, 0, 'without the star the same stem is an exact token — no match');
    assert.equal(store.query({ types: ['feature_article'], rank_terms: ['*'] }).length, 0, "a bare '*' is a quoted literal, matching nothing rather than throwing");
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

test('flagged_stale research findings are still served by query; superseded are not (§3.2.4)', () => {
  const { dir, store } = tempStore();
  try {
    const rf = (status: string) => ({
      ...envelope('research_finding'),
      status,
      superseded_by: status === 'superseded' ? randomUUID() : null,
      question: `q-${status}`,
      answer: 'a',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-06-01',
    });
    store.create(rf('active'));
    store.create(rf('flagged_stale'));
    store.create(rf('superseded'));
    const served = store.query({ types: ['research_finding'], cap: 10 });
    assert.deepEqual(served.map((r) => (r as { status: string }).status).sort(), ['active', 'flagged_stale']);
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

test('queue drain log (§3.2.7): system removals logged + capped; user removals never logged', () => {
  const { dir, store } = tempStore();
  try {
    // user todo: removed, NOT logged
    const u = store.create({ ...envelope('todo'), text: 'a user todo', source: 'user' });
    store.remove(u.id, '2026-06-12T08:00:00.000Z');
    assert.equal(store.listQueueDrain().length, 0, 'user-source todos never enter the drain log');

    // system todo: removed AND logged, record still hard-deleted
    const s = store.create({
      ...envelope('todo'),
      text: 'reconcile article x',
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/x.ts'],
    });
    store.remove(s.id, '2026-06-12T09:00:00.000Z');
    assert.equal(store.get(s.id), undefined, 'the record itself is gone — no done status (P4)');
    const drained = store.listQueueDrain();
    assert.equal(drained.length, 1);
    assert.deepEqual(drained[0], {
      drained_at: '2026-06-12T09:00:00.000Z',
      system_reason: 'reconcile_needed',
      text: 'reconcile article x',
      file_keys: ['src/x.ts'],
    });

    // cap: completed items never build up — 50 max, oldest pruned in the same tx
    for (let i = 0; i < 60; i++) {
      const item = store.create({ ...envelope('todo'), text: `item ${i}`, source: 'system', system_reason: 'capture_owed' });
      store.remove(item.id, `2026-06-12T10:${String(i).padStart(2, '0')}:00.000Z`);
    }
    const all = store.listQueueDrain(100);
    assert.equal(all.length, 50, 'log is capped at 50');
    assert.equal(all[0].text, 'item 59', 'newest first');
    assert.ok(!all.some((e) => e.text === 'reconcile article x'), 'oldest entries pruned');
    assert.equal(store.listQueueDrain(15).length, 15, 'reader limit');
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

// ---------------------------------------------------------------------------
// FROZEN P1 oracle (run r-dd88) — AC6 QueryOptions.match_all (AND term-join).
// SPEC-ONLY, written before match_all exists. The AND tests must fail RED on an
// AssertionError (union vs intersection counts), never by throwing.
//
// match_all is not yet on QueryOptions, so the option is supplied through a
// NARROW cast (QueryOptions & { match_all?: boolean }) — the call compiles under
// tsc strict and, with match_all ignored by the current OR-only impl, returns
// the OR superset, which the AND assertions reject cleanly.
//
// FTS fixture with CONTROLLED token overlap: three nonsense tokens placed in
// feature_article.what_it_does (part of the indexed fts text) so OR-superset vs
// AND-intersection is provable independent of any real vocabulary:
//   ALPHA token "zappywodget" / BETA token "quibblezorp"
//   - "both"  carries BOTH tokens
//   - "onlyA" carries ALPHA only
//   - "onlyB" carries BETA only
// ---------------------------------------------------------------------------

const ALPHA = 'zappywodget';
const BETA = 'quibblezorp';

/** Supply match_all before QueryOptions declares it, without breaking tsc. */
const withMatchAll = (opts: QueryOptions, matchAll: boolean): QueryOptions =>
  ({ ...opts, match_all: matchAll }) as QueryOptions & { match_all?: boolean };

function seedTokenFixture(store: SterlingStore) {
  store.create(article({ slug: 'rec-both', title: 'rec both', what_it_does: `${ALPHA} ${BETA} marker` }));
  store.create(article({ slug: 'rec-only-a', title: 'rec only a', what_it_does: `${ALPHA} marker` }));
  store.create(article({ slug: 'rec-only-b', title: 'rec only b', what_it_does: `${BETA} marker` }));
}

test('AC6 match_all: default/absent preserves the OR term-join — multi-term returns the UNION (regression guard)', () => {
  const { dir, store } = tempStore();
  try {
    seedTokenFixture(store);
    // No match_all: existing OR semantics — the union of both tokens = all 3 records.
    const union = store.query({ types: ['feature_article'], rank_terms: [ALPHA, BETA], cap: 50 });
    assert.equal(union.length, 3, 'absent match_all keeps the OR union: every record matching EITHER token');
    const slugs = (union as { slug: string }[]).map((r) => r.slug).sort();
    assert.deepEqual(slugs, ['rec-both', 'rec-only-a', 'rec-only-b'], 'OR union is the full superset');
    // explicit match_all:false is identical to absent.
    const unionFalse = store.query(withMatchAll({ types: ['feature_article'], rank_terms: [ALPHA, BETA], cap: 50 }, false));
    assert.equal(unionFalse.length, 3, 'match_all:false === default OR union');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6 match_all:true: AND term-join returns ONLY records matching EVERY term (intersection, not union)', () => {
  const { dir, store } = tempStore();
  try {
    seedTokenFixture(store);
    const intersection = store.query(withMatchAll({ types: ['feature_article'], rank_terms: [ALPHA, BETA], cap: 50 }, true));
    assert.equal(intersection.length, 1, 'match_all:true AND-joins: only the record carrying BOTH tokens (NOT the OR superset of 3)');
    assert.equal((intersection[0] as { slug: string }).slug, 'rec-both', 'the single intersection hit is the both-tokens record');
    // a one-term match is EXCLUDED under AND.
    const slugs = (intersection as { slug: string }[]).map((r) => r.slug);
    assert.ok(!slugs.includes('rec-only-a'), 'a record matching only one term is excluded under AND');
    assert.ok(!slugs.includes('rec-only-b'), 'a record matching only the other term is excluded under AND');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6 match_all:true: a single term behaves the same as OR (one-term AND === one-term OR)', () => {
  const { dir, store } = tempStore();
  try {
    seedTokenFixture(store);
    // one ALPHA term: both "rec-both" and "rec-only-a" carry it — under AND or OR alike.
    const and = store.query(withMatchAll({ types: ['feature_article'], rank_terms: [ALPHA], cap: 50 }, true));
    const or = store.query({ types: ['feature_article'], rank_terms: [ALPHA], cap: 50 });
    assert.equal(and.length, 2, 'a single-term AND matches every record carrying that term');
    assert.deepEqual(
      (and as { slug: string }[]).map((r) => r.slug).sort(),
      (or as { slug: string }[]).map((r) => r.slug).sort(),
      'one-term AND and one-term OR return the same set'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6 match_all:true: PREFIX terms are AND-joined too (zap*/quib* → intersection only)', () => {
  const { dir, store } = tempStore();
  try {
    seedTokenFixture(store);
    // prefixes that match the same tokens: 'zap*' → zappywodget, 'quib*' → quibblezorp.
    const orPrefix = store.query({ types: ['feature_article'], rank_terms: ['zap*', 'quib*'], cap: 50 });
    assert.equal(orPrefix.length, 3, 'prefix OR union is still the full superset (default behaviour preserved)');

    const andPrefix = store.query(withMatchAll({ types: ['feature_article'], rank_terms: ['zap*', 'quib*'], cap: 50 }, true));
    assert.equal(andPrefix.length, 1, 'match_all:true AND-joins PREFIX terms — only the record matching both prefixes');
    assert.equal((andPrefix[0] as { slug: string }).slug, 'rec-both', 'the both-tokens record is the sole prefix-AND hit');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
