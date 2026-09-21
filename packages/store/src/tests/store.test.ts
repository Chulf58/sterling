import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import type { QueryOptions } from '../index.js';
import * as storeMod from '../index.js';

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

function researchFinding(over: Record<string, unknown> = {}) {
  return {
    ...envelope('research_finding'),
    question: 'does the platform rate-limit per org or per token?',
    answer: 'per-org',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-01-15',
    capture_date: '2026-06-01',
    volatility_hint: 'medium',
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

test('recordIdIndex serves ids at ANY status — tombstones included, which query() never does', () => {
  const { dir, store } = tempStore();
  try {
    const active = store.create(decision());
    const old = store.create(decision());
    const replacement = store.supersede(old.id, decision({ updated_at: LATER }));

    const index = store.recordIdIndex();
    const byId = new Map(index.map((r) => [r.id, r]));
    assert.equal(byId.get(active.id)?.status, 'active');
    assert.equal(byId.get(replacement.id)?.status, 'active');
    assert.equal(byId.get(old.id)?.status, 'superseded', 'the tombstone is in the index — citing history is legitimate');
    assert.equal(byId.get(old.id)?.type, 'decision');
    // the contrast that makes this primitive necessary
    assert.equal(
      store.query({ types: ['decision'], cap: 50 }).some((r) => r.id === old.id),
      false,
      'query() excludes superseded records, so it cannot resolve a citation to one'
    );
    assert.equal(index.length, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('query: research_finding file-key join — the same join every other file_keys-bearing type gets (decision foreign_8dbbc85d, board b1de6fab)', () => {
  const { dir, store } = tempStore();
  try {
    const withKey = store.create(researchFinding({ question: 'q-with-key', file_keys: ['scripts/hooks/x.mjs'] }));
    store.create(researchFinding({ question: 'q-other-key', file_keys: ['scripts/hooks/other.mjs'] }));
    store.create(researchFinding({ question: 'q-no-key' })); // (3) file_keys omitted — still a valid, queryable-by-type record; just never joined by path
    assert.equal(store.query({ types: ['research_finding'] }).length, 3, 'all three are valid research findings regardless of file_keys presence');
    assert.equal(store.query({ file_keys: ['scripts/hooks/x.mjs'] }).length, 1, 'joins exactly the finding carrying that path');
    assert.equal((store.query({ file_keys: ['scripts/hooks/x.mjs'] })[0] as unknown as { id: string }).id, withKey.id);
    assert.equal(store.query({ file_keys: ['scripts/hooks/other.mjs'] }).length, 1, 'and the finding at a DIFFERENT path is not returned for this key');
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

// ---------------------------------------------------------------------------
// COVERAGE RANKING (decision pull-ranking-at-scale-order-of-work-coverage-
// before-columns-no-narrowing-ladder, step 2; mechanism 1 flooding,
// research_finding why-dome-farmer-pull-cases-miss-mechanisms-september-2026).
// query()'s rank_terms path orders the WHOLE OR/AND-eligible set by the
// number of DISTINCT rank_terms expressions a record matches (FTS semantics
// — a prefix or the term's own quoting counts as ONE expression, never a
// substring count) BEFORE bm25, so a record repeating one generic term
// cannot outrank a record that matches every term once. Eligibility
// (records_fts MATCH) is untouched by this — same nonsense tokens as the
// match_all fixture above so the proof is independent of real vocabulary.
// ---------------------------------------------------------------------------

const COV_A = 'zorbaline';
const COV_B = 'quintavox';
const COV_C = 'phentaris';

// Fixed, opposing UUIDs for the bm25 tie-break pins below: with two records
// tied on coverage AND on updated_at (both created at NOW), the ONLY thing
// separating a correct bm25-driven order from an id-ASC fallback is whether
// bm25 is actually in the ORDER BY. Random UUIDs (envelope()'s default) would
// let such a pin pass by 50/50 luck if a future edit dropped bm25 entirely.
// The record EXPECTED to win gets the id that would sort LAST under id ASC
// (ID_HIGH); the expected loser gets ID_LOW — so a dropped-bm25 regression
// flips the order and the assertion fails loudly instead of passing by luck.
const ID_LOW = '00000000-0000-4000-8000-000000000001';
const ID_HIGH = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

/**
 * Reproduces mechanism 1 (flooding) FOR REAL, not by assertion: with only two
 * candidate documents, bm25's IDF term already favors the multi-term match (a
 * toy 2-record fixture never actually floods). What makes COV_B/COV_C common
 * enough — and COV_A comparatively rare — for bm25 ALONE to let the repeated
 * term win is a corpus of decoys carrying COV_B/COV_C but not COV_A, exactly
 * the "generic OR terms over a wide set" shape research_finding
 * why-dome-farmer-pull-cases-miss-mechanisms-september-2026 attributes it to.
 * Verified empirically (scratch harness against the pre-fix build): with this
 * fixture store.query() ranks 'flooded-one-term' above 'full-coverage' today.
 */
function seedFloodingFixture(store: SterlingStore) {
  store.create(article({ slug: 'full-coverage', title: 'full coverage', what_it_does: `${COV_A} ${COV_B} ${COV_C} marker` }));
  store.create(article({ slug: 'flooded-one-term', title: 'flooded one term', what_it_does: Array(5).fill(COV_A).join(' ') }));
  for (let i = 0; i < 5; i += 1) {
    store.create(
      article({ slug: `decoy-${i}`, title: `decoy ${i}`, what_it_does: `distractor ${i} ${COV_B} ${COV_C} filler padding content` })
    );
  }
}

test('coverage ranking: a record matching 3-of-3 terms once each outranks a record flooding 1-of-3 many times', () => {
  const { dir, store } = tempStore();
  try {
    seedFloodingFixture(store);
    const ranked = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_B, COV_C], cap: 50 });
    assert.equal(ranked.length, 7, 'the decoys match COV_B/COV_C too — the OR-eligible set is unchanged by coverage ranking');
    assert.equal(
      (ranked[0] as { slug: string }).slug,
      'full-coverage',
      '3-of-3 coverage outranks a single term flooded 5 times, even though bm25 alone (verified pre-fix) favors the repeated term'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: ties on coverage fall to bm25 exactly as today', () => {
  const { dir, store } = tempStore();
  try {
    store.create(article({ id: ID_LOW, slug: 'sparse-both', title: 'sparse both', what_it_does: `${COV_A} ${COV_B} marker` }));
    store.create(
      article({ id: ID_HIGH, slug: 'dense-both', title: 'dense both', what_it_does: Array(10).fill(`${COV_A} ${COV_B}`).join(' ') })
    );
    const ranked = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_B], cap: 50 });
    assert.equal(ranked.length, 2, 'both records match both terms — equal coverage');
    assert.equal(
      (ranked[0] as { slug: string }).slug,
      'dense-both',
      'equal coverage (2-of-2 both): the tie-break is bm25, which favors the denser match — same as pre-coverage ordering'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: a single rank term produces exactly today\'s bm25-only order (decoys still outrank the sparse owner)', () => {
  const { dir, store } = tempStore();
  try {
    store.create(article({ id: ID_LOW, slug: 'sparse-owner', title: 'sparse owner', what_it_does: `${COV_A} marker` }));
    store.create(article({ id: ID_HIGH, slug: 'dense-decoy', title: 'dense decoy', what_it_does: Array(10).fill(COV_A).join(' ') }));
    const ranked = store.query({ types: ['feature_article'], rank_terms: [COV_A], cap: 50 });
    assert.equal(ranked.length, 2, 'both match the single term — coverage is uniformly 1, so order is bm25-only');
    assert.equal((ranked[0] as { slug: string }).slug, 'dense-decoy', 'with only one rank term, coverage cannot differ between matches — bm25 alone decides, unchanged from before');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: match_all is unaffected — every matching row already has full coverage, order stays bm25', () => {
  const { dir, store } = tempStore();
  try {
    store.create(article({ id: ID_LOW, slug: 'sparse-all', title: 'sparse all', what_it_does: `${COV_A} ${COV_B} ${COV_C} marker` }));
    store.create(
      article({
        id: ID_HIGH,
        slug: 'dense-all',
        title: 'dense all',
        what_it_does: Array(10).fill(`${COV_A} ${COV_B} ${COV_C}`).join(' '),
      })
    );
    const ranked = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_B, COV_C], match_all: true, cap: 50 });
    assert.equal(ranked.length, 2, 'match_all requires every term — both records qualify');
    assert.equal(
      (ranked[0] as { slug: string }).slug,
      'dense-all',
      'match_all rows all have full (3-of-3) coverage, so coverage cannot distinguish them — bm25 decides, same as pre-coverage ordering'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: a prefix term and a quoted term each count as ONE expression, not one per distinct token they match', () => {
  const { dir, store } = tempStore();
  try {
    // 'zorb*' prefix-matches THREE distinct tokens in this record's text, but
    // must still count as ONE rank_terms expression toward coverage.
    store.create(
      article({ slug: 'prefix-flood', title: 'prefix flood', what_it_does: 'zorbaline zorbanox zorbatide marker' })
    );
    // Matches the prefix once AND the second term — 2-of-2 distinct expressions.
    store.create(article({ slug: 'prefix-plus-term', title: 'prefix plus term', what_it_does: `zorbaline ${COV_B} marker` }));
    // Decoys carrying COV_B (not the prefix) so COV_B is common enough that
    // bm25 ALONE (verified pre-fix) lets the 3-token prefix match win — the
    // same flooding shape as seedFloodingFixture, applied to a prefix term.
    for (let i = 0; i < 5; i += 1) {
      store.create(article({ slug: `decoy-${i}`, title: `decoy ${i}`, what_it_does: `distractor ${i} ${COV_B} filler padding content` }));
    }
    const ranked = store.query({ types: ['feature_article'], rank_terms: ['zorb*', COV_B], cap: 50 });
    assert.equal(ranked.length, 7, 'the decoys match COV_B too — the OR-eligible set is unchanged by coverage ranking');
    assert.equal(
      (ranked[0] as { slug: string }).slug,
      'prefix-plus-term',
      '2-of-2 expressions (prefix counted once) outranks a record whose prefix matches three tokens but still covers only 1 expression, even though bm25 alone (verified pre-fix) favors the 3-token match'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: cap applies AFTER coverage ordering over the whole eligible set', () => {
  const { dir, store } = tempStore();
  try {
    seedFloodingFixture(store);
    const capped = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_B, COV_C], cap: 1 });
    assert.equal(capped.length, 1);
    assert.equal((capped[0] as { slug: string }).slug, 'full-coverage', 'the cap:1 window is the coverage-first winner, not the bm25-only winner (which — verified pre-fix — is flooded-one-term)');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: eligibility is unchanged — a record matching none of the OR terms is still excluded', () => {
  const { dir, store } = tempStore();
  try {
    seedFloodingFixture(store);
    store.create(article({ slug: 'no-match', title: 'no match', what_it_does: 'unrelated content entirely' }));
    const ranked = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_B, COV_C], cap: 50 });
    const slugs = (ranked as { slug: string }[]).map((r) => r.slug).sort();
    assert.deepEqual(
      slugs,
      ['decoy-0', 'decoy-1', 'decoy-2', 'decoy-3', 'decoy-4', 'flooded-one-term', 'full-coverage'],
      'the same eligible set as the plain OR match — coverage only reorders it, never narrows or widens it, and no-match stays excluded'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: a duplicate rank term does not inflate coverage — dedupe is on the COMPILED expression', () => {
  const { dir, store } = tempStore();
  try {
    // Both records match exactly ONE distinct term — a genuine coverage tie
    // (1-of-2) that should fall to bm25, same as any other tie. 'gamma-only'
    // is denser so it wins that tie (fixed opposing ids per the tie-break
    // pins above, so this doesn't pass by id luck either).
    store.create(article({ id: ID_LOW, slug: 'alpha-only', title: 'alpha only', what_it_does: `${COV_A} marker` }));
    store.create(
      article({ id: ID_HIGH, slug: 'gamma-only-denser', title: 'gamma only denser', what_it_does: `${Array(5).fill(COV_C).join(' ')} marker` })
    );
    // rank_terms repeats COV_A: an undeduped implementation counts it TWICE
    // toward 'alpha-only's coverage (2), wrongly beating 'gamma-only-denser's
    // true 1-of-2 coverage — the exact defect this pin catches.
    const withDup = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_A, COV_C], cap: 50 });
    const deduped = store.query({ types: ['feature_article'], rank_terms: [COV_A, COV_C], cap: 50 });
    assert.deepEqual(
      (withDup as { slug: string }[]).map((r) => r.slug),
      (deduped as { slug: string }[]).map((r) => r.slug),
      'a duplicate term must not change the order relative to the already-deduped input'
    );
    assert.equal(
      (withDup[0] as { slug: string }).slug,
      'gamma-only-denser',
      'both records have TRUE coverage 1-of-2 (a tie) — bm25 correctly picks the denser match, not the record that happens to repeat a query term'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: a case-variant duplicate ("Zorbaline" vs "zorbaline") is NOT merged, but ELIGIBILITY is still identical to the single term alone', () => {
  const { dir, store } = tempStore();
  try {
    // Dedupe is on the EXACT compiled expression, not a JS case fold — a JS
    // fold is not the same equivalence FTS5's unicode61 tokenizer uses, and
    // a false JS merge could narrow OR eligibility or widen AND eligibility.
    // The accepted consequence is a harmless double-count (asserted nowhere
    // here, per design) — what MUST hold is that the returned id SET is
    // unaffected by the case variance, because FTS5 itself case-folds at
    // MATCH time regardless of what this dedupe does.
    store.create(article({ slug: 'alpha-record', title: 'alpha record', what_it_does: `${COV_A} marker` }));
    store.create(article({ slug: 'no-match', title: 'no match', what_it_does: 'unrelated content entirely' }));
    const caseVariantDup = store.query({ types: ['feature_article'], rank_terms: ['Zorbaline', COV_A], cap: 50 });
    const single = store.query({ types: ['feature_article'], rank_terms: [COV_A], cap: 50 });
    assert.deepEqual(
      (caseVariantDup as { id: string }[]).map((r) => r.id).sort(),
      (single as { id: string }[]).map((r) => r.id).sort(),
      'the id SET is identical whether or not the case-variant duplicate is present — eligibility never depends on whether the dedupe merged it'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage ranking: countAboveScore shares the SAME dedupe as query() — a duplicate rank term must not inflate -bm25 past a threshold it would otherwise miss', () => {
  const { dir, store } = tempStore();
  try {
    // One record matching ONLY COV_A. Empirically (against this exact fixture):
    // -bm25 for rank_terms ['zorbaline','phentaris'] (already-deduped, matches
    // this record on COV_A alone) is 0.000001; for the undeduped
    // ['zorbaline','zorbaline','phentaris'] — bm25 sums a contribution per
    // query-term OCCURRENCE — it doubles to 0.000002. minScore sits exactly
    // between the two: the TRUE (deduped) score misses it, the INFLATED
    // (undeduped) score would have crossed it.
    store.create(article({ slug: 'alpha-only', title: 'alpha only', what_it_does: `${COV_A} marker` }));
    const minScore = 0.0000015;
    const deduped = store.countAboveScore({ types: ['feature_article'], rank_terms: [COV_A, COV_C] }, minScore);
    const withDup = store.countAboveScore({ types: ['feature_article'], rank_terms: [COV_A, COV_A, COV_C] }, minScore);
    assert.equal(deduped, 0, "CONTROL: the record's true score (0.000001) sits below minScore — nothing crosses it");
    assert.equal(
      withDup,
      deduped,
      'a duplicate rank term must not inflate the score countAboveScore thresholds by — it must agree with the already-deduped input, not silently count the record the undeduped score would have crossed'
    );
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

test('supersede: a flagged_stale research finding CAN be superseded (re-verification is the advertised remedy) — audit finding 13/43', () => {
  const { dir, store } = tempStore();
  try {
    const rf = (over = {}) => ({
      ...envelope('research_finding'),
      question: 'q', answer: 'a', source_urls: [], source_date: '2026-01-01', capture_date: '2026-01-01',
      ...over,
    });
    const stale = store.create(rf({ status: 'flagged_stale' }));
    // re-verification supersedes the stale finding — previously threw "not active"
    const fresh = store.supersede(stale.id, rf({ answer: 're-verified' }));
    assert.equal(store.get(stale.id)!.status, 'superseded');
    assert.equal(store.get(fresh.id)!.status, 'active');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renameFileKey rewrites path-keyed object KEYS (file_baselines), not just values — audit finding 11/43', () => {
  const { dir, store } = tempStore();
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;');
    // an article owning a.ts gets a server-computed file_baselines keyed by 'a.ts'
    const a = store.create(article({ slug: 'feat', files: [{ path: 'a.ts', role: 'impl' }], file_baselines: { 'a.ts': 'deadbeef' } }));
    store.renameFileKey('a.ts', 'b.ts');
    const moved = store.get(a.id) as unknown as { files: { path: string }[]; file_baselines?: Record<string, string> };
    assert.equal(moved.files[0].path, 'b.ts', 'files[].path rewritten');
    assert.ok(moved.file_baselines && 'b.ts' in moved.file_baselines, 'baseline KEY rewritten to the new path');
    assert.ok(!('a.ts' in (moved.file_baselines ?? {})), 'old baseline key gone (was stranded before the fix)');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove() deletes INBOUND link edges, not just outbound — no dangling reverse-traversal rows (audit finding 31/43)', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'target' }));
    const source = store.create(decision({ statement: 'source' }));
    store.addLink(source.id, 'informed_by', target.id);
    // no public reverse-traversal reader exists (the latent surface the audit
    // named), so assert the record_links index directly — a store-internal invariant
    const links = store as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } };
    const inbound = () => links.db.prepare('SELECT source_id FROM record_relations WHERE target_id = ?').all(target.id); // test-repair 2026-08-22: record_links replaced by record_relations in schema v2; invariant unchanged [stable-identity-design-v2]
    assert.equal(inbound().length, 1, 'inbound edge present before removal');
    store.remove(target.id);
    assert.equal(inbound().length, 0, 'inbound edge to a removed record is gone (was dangling before the fix)');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addLink: a standalone store still rejects a missing target by default, and an identical edge dedups', () => {
  // The mounted layer passes targetValidated after its cross-store resolution;
  // standalone usage must keep the local existence check (no regression).
  const { dir, store } = tempStore();
  try {
    const source = store.create(decision({ statement: 'source' }));
    const target = store.create(decision({ statement: 'target' }));
    assert.throws(() => store.addLink(source.id, 'cites', randomUUID()), /no target record/);
    store.addLink(source.id, 'cites', target.id);
    const again = store.addLink(source.id, 'cites', target.id);
    assert.equal(again.links.filter((l) => l.rel === 'cites' && l.target_id === target.id).length, 1, 'identical edge dedups — source unchanged');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query source filter is applied BEFORE the cap — matching items are not lost past the cap (audit finding 38/43)', () => {
  const { dir, store } = tempStore();
  try {
    const todo = (source: string, reason: string, at: string) => ({
      ...envelope('todo', at), text: `${source} ${reason}`, source,
      ...(source === 'system' ? { system_reason: reason } : { priority: 'normal' }),
    });
    // 1 old user todo, then many newer system todos (updated_at DESC ordering
    // would push the user todo past a small cap if the filter ran after)
    store.create(todo('user', 'x', '2026-06-01T00:00:00.000Z'));
    for (let i = 0; i < 30; i++) store.create(todo('system', 'reconcile_needed', `2026-06-10T00:00:${String(i).padStart(2, '0')}.000Z`));
    const users = store.query({ types: ['todo'], source: 'user', cap: 5 });
    assert.equal(users.length, 1, 'the lone user todo is found despite 30 newer system todos and cap 5');
    assert.equal((users[0] as { source: string }).source, 'user');
    const systems = store.query({ types: ['todo'], source: 'system', cap: 100 });
    assert.equal(systems.length, 30, 'system filter returns only system todos');
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
    assert.throws(() => store.supersede(v1.id, article({ version: 3 })), /already superseded/);
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

test('updateTodo: IN-PLACE mutation — same id, same status, rebuilds file_keys + FTS indexes (§3.2.7 board_update)', () => {
  const { dir, store } = tempStore();
  try {
    const t = store.create({
      ...envelope('todo'),
      text: 'reconcile auth article',
      source: 'user',
      priority: 'low',
      file_keys: ['src/auth.ts'],
    });

    const patched = store.updateTodo(t.id, { ...t, text: 'reconcile auth article thoroughly', priority: 'high', file_keys: ['src/auth2.ts'], updated_at: LATER });
    assert.equal(patched.id, t.id, 'the id is stable — no new record is minted');
    assert.equal(patched.status, 'active');
    assert.equal(patched.created_at, t.created_at, 'created_at is untouched by an in-place edit');
    assert.equal(patched.updated_at, LATER);
    assert.equal(store.query({ types: ['todo'] }).length, 1, 'still exactly one record — updateTodo never supersedes');
    assert.equal(store.get(t.id)!.id, t.id, 'the SAME row now carries the patched body');
    assert.equal((store.get(t.id) as unknown as { text: string }).text, 'reconcile auth article thoroughly');

    // the file_keys join index was rebuilt to the NEW value, not merely appended to
    assert.equal(store.query({ file_keys: ['src/auth.ts'] }).length, 0, 'the old file_key no longer joins');
    assert.equal(store.query({ file_keys: ['src/auth2.ts'] }).length, 1, 'the new file_key joins');

    // the FTS row was refreshed too — old text no longer ranks, new text does
    assert.equal(store.query({ rank_terms: ['thoroughly'] }).length, 1, 'FTS reflects the new text');

    // refuses a non-todo id and an already-superseded id
    const d = store.create(decision());
    assert.throws(() => store.updateTodo(d.id, { ...d }), /not a todo/);
    const gone = store.create({ ...envelope('todo'), text: 'x', source: 'user' });
    store.remove(gone.id);
    assert.throws(() => store.updateTodo(gone.id, { ...gone, text: 'y' }), /no record/);
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

test('activity log (board 39d6462d): create/supersede/link/remove/retire/promote each log exactly one row', () => {
  const { dir, store } = tempStore();
  try {
    // create → 'created', title-or-slug clipped (article carries both; title wins)
    const d = store.create(decision({ title: 'Use SQLite' }));
    let rows = store.listActivityLog(10);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { verb: rows[0].verb, type: rows[0].type, id: rows[0].id, title: rows[0].title },
      { verb: 'created', type: 'decision', id: d.id, title: 'Use SQLite' }
    );

    // supersede → 'updated', logged against the NEW record's id
    const d2 = store.supersede(d.id, decision({ title: 'Use SQLite v2', updated_at: LATER }));
    rows = store.listActivityLog(10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].verb, 'updated');
    assert.equal(rows[0].id, d2.id);
    assert.equal(rows[0].title, 'Use SQLite v2');

    // addLink → 'linked'; an identical (deduped) edge does NOT log a second row
    const target = store.create(decision({ title: 'target' }));
    store.addLink(d2.id, 'cites', target.id);
    rows = store.listActivityLog(10);
    const afterFirstLink = rows.length;
    assert.equal(rows[0].verb, 'linked');
    assert.equal(rows[0].id, d2.id);
    store.addLink(d2.id, 'cites', target.id); // identical edge — dedups, no new row
    assert.equal(store.listActivityLog(10).length, afterFirstLink, 'a deduped identical edge logs no second row');

    // remove on a NON-todo record → 'removed'
    const removable = store.create(decision({ title: 'a removable decision' }));
    store.remove(removable.id);
    rows = store.listActivityLog(10);
    assert.equal(rows[0].verb, 'removed');
    assert.equal(rows[0].type, 'decision');
    assert.equal(rows[0].id, removable.id);

    // remove on a USER todo → 'removed' in the activity log (never in the drain log)
    const userTodo = store.create({ ...envelope('todo'), text: 'a user todo', source: 'user' });
    store.remove(userTodo.id, LATER);
    rows = store.listActivityLog(10);
    assert.equal(rows[0].verb, 'removed');
    assert.equal(rows[0].id, userTodo.id);

    // remove on a SYSTEM todo → already covered by queue_drain_log; NOT double-logged here
    const sysTodo = store.create({ ...envelope('todo'), text: 'reconcile x', source: 'system', system_reason: 'reconcile_needed' });
    const afterCreate = store.listActivityLog(50).length; // the create() itself logs 'created'
    store.remove(sysTodo.id, LATER);
    assert.equal(store.listActivityLog(50).length, afterCreate, 'a system-todo removal is not double-logged (queue_drain_log already covers it)');
    assert.equal(store.listQueueDrain(1)[0].text, 'reconcile x', 'the drain log still gets it');

    // retireInFavorOf default verb → 'retired'
    const dup = store.create(decision({ title: 'a duplicate decision' }));
    const survivor = store.create(decision({ title: 'the survivor' }));
    store.retireInFavorOf(dup.id, survivor.id, LATER);
    rows = store.listActivityLog(10);
    assert.equal(rows[0].verb, 'retired');
    assert.equal(rows[0].id, dup.id);
    assert.equal(rows[0].title, 'a duplicate decision');

    // retireInFavorOf with an explicit verb → 'promoted' (knowledgePromote's call shape)
    const promotedOriginal = store.create(decision({ title: 'promotable finding' }));
    const domainCopy = store.create({ ...decision({ title: 'promotable finding' }), scope: 'domain:node', id: randomUUID() });
    store.retireInFavorOf(promotedOriginal.id, domainCopy.id, LATER, 'promoted');
    rows = store.listActivityLog(10);
    assert.equal(rows[0].verb, 'promoted');
    assert.equal(rows[0].id, promotedOriginal.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity log title-or-slug: todo falls back to its first text line; feature_article uses title over slug', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article({ slug: 'csv-export', title: 'CSV export' }));
    assert.equal(store.listActivityLog(1)[0].title, 'CSV export', 'title wins over slug when both exist');

    const t = store.create({ ...envelope('todo'), text: 'first line\nsecond line', source: 'user' });
    assert.equal(store.listActivityLog(1)[0].title, 'first line', 'todo falls back to its first text line, clipped');

    void a; void t;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity log is capped at 50 rows, oldest pruned in the same transaction', () => {
  const { dir, store } = tempStore();
  try {
    for (let i = 0; i < 60; i++) store.create(decision({ title: `decision ${i}` }));
    const all = store.listActivityLog(100);
    assert.equal(all.length, 50, 'capped at 50');
    assert.equal(all[0].title, 'decision 59', 'newest first');
    assert.ok(!all.some((e) => e.title === 'decision 0'), 'oldest entries pruned');
    assert.equal(store.listActivityLog(15).length, 15, 'reader limit');
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

// ===========================================================================
// AC8 — models catalog: bootstrap-if-absent, catalogStatus (present/stale),
// and deduped refresh_reference enqueue. Store-level oracle for run r-ea9e
// phase 3, brief tui-system-tab (foreign_08bfa318). SPEC-ONLY: catalogStatus /
// bootstrapCatalogIfAbsent / enqueueRefreshReferenceOnce do not exist yet.
//
// Governing design — decision foreign_98064d77:
//   - the catalog is a PROJECT-scoped reference_material record carrying the
//     optional typed `catalog` field {entries:[{id,label,tier,status}]}
//     (phase-1 schema, commit e44e78a); one record.
//   - bootstrap seeds entries from config.models' DISTINCT pinned model IDs
//     (no network — day one the dropdown offers the pinned IDs).
//   - staleness is TIME-based against the tunable models_catalog.staleness_days
//     (default 45), reusing the EXISTING refresh_reference maintenance lane
//     (source=system board item); enqueue is deduped — no-op while a pending
//     item exists.
//
// STALENESS CONVENTION (grounded, not invented): the existing refresh_reference /
// staleness lane compares `age > threshold` STRICTLY (packages/mcp-server/src/
// tools.ts: `sourceAge > threshold`, `ageDays(updated_at) > platform_external_days`,
// with age = floor((now - anchor)/DAY_MS)). Decision foreign_98064d77 says the catalog
// "reuses the EXISTING refresh_reference maintenance lane", so this oracle pins
// the SAME strict-greater semantics: at EXACTLY staleness_days elapsed the catalog
// is FRESH; it becomes stale only PAST the threshold. A `>=` implementation is a
// defect against the mirrored §3.2.5 convention. Boundary fixtures use only
// whole-day offsets, so the verdict is identical whether the impl floors to whole
// days or compares raw milliseconds.
//
// INTERFACE-FORM NOTE (resolved behaviorally, not blocked — mirrors the accepted
// phase-2 cfgBoth precedent): the interface slice gives catalogStatus an explicit
// record-first pure signature `(catalogRecord|null, now, thresholdDays)` — an
// unambiguous FREE function. It does NOT state whether bootstrapCatalogIfAbsent /
// enqueueRefreshReferenceOnce are SterlingStore methods or free functions, nor
// their exact arg order. Rather than block an unattended run on a calling
// convention whose MECHANISM is fully specified, the adapters below accept BOTH
// forms at runtime and compile now via casts (this file's frozen-oracle
// convention). CANONICAL forms this oracle expects the coder to land:
//     catalogStatus(record|null, nowISO, thresholdDays)            // free, pure
//     store.bootstrapCatalogIfAbsent(config, nowISO)               // store method
//     store.enqueueRefreshReferenceOnce(nowISO)                    // store method
// If the coder picks the free-function variant instead, the adapter still routes
// to it; a genuinely different arg SHAPE is a localized one-line fix in these
// helpers, and the behavioral assertions are the contract either way.
// ===========================================================================

const DAY_MS = 86_400_000;
const SEED = '2026-01-01T00:00:00.000Z';
const isoPlusDays = (base: string, days: number): string => new Date(Date.parse(base) + days * DAY_MS).toISOString();

const StoreMod = storeMod as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;

interface CatalogStatusResult {
  present: boolean;
  stale: boolean;
  staleDate: string | null | undefined;
}

/** catalogStatus is a pure, record-first free function per the interface slice. */
function callCatalogStatus(record: unknown, nowISO: string, thresholdDays: number): CatalogStatusResult {
  const fn = StoreMod.catalogStatus;
  if (typeof fn === 'function') return fn(record, nowISO, thresholdDays) as CatalogStatusResult;
  throw new Error('catalogStatus export not found (expected free `catalogStatus(record|null, now, thresholdDays)`)');
}

/** bootstrap: store method `store.bootstrapCatalogIfAbsent(config, now)`, or free `(store, config, now)`. */
function callBootstrap(store: SterlingStore, config: unknown, nowISO: string): unknown {
  const method = (store as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>).bootstrapCatalogIfAbsent;
  if (typeof method === 'function') return method.call(store, config, nowISO);
  const free = StoreMod.bootstrapCatalogIfAbsent;
  if (typeof free === 'function') return free(store, config, nowISO);
  throw new Error('bootstrapCatalogIfAbsent not found (expected `store.bootstrapCatalogIfAbsent(config, now)` or free `(store, config, now)`)');
}

/** enqueue: store method `store.enqueueRefreshReferenceOnce(now)`, or free `(store, now)`. */
function callEnqueue(store: SterlingStore, nowISO: string): unknown {
  const method = (store as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>).enqueueRefreshReferenceOnce;
  if (typeof method === 'function') return method.call(store, nowISO);
  const free = StoreMod.enqueueRefreshReferenceOnce;
  if (typeof free === 'function') return free(store, nowISO);
  throw new Error('enqueueRefreshReferenceOnce not found (expected `store.enqueueRefreshReferenceOnce(now)` or free `(store, now)`)');
}

/** A reference_material-shaped catalog record with created_at === updated_at (clock-choice agnostic). */
function catalogRecordAt(
  anchorISO: string,
  entries: { id: string; label: string; tier: string; status: string }[] = [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
  ]
) {
  return {
    id: randomUUID(),
    type: 'reference_material',
    created_at: anchorISO,
    updated_at: anchorISO,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'Models catalog',
    kind: 'doc',
    location: '.sterling/models-catalog',
    summary: 'KB-maintained model catalog for the TUI System tab.',
    catalog: { entries },
  };
}

/** The catalog reference_material record(s) actually in the store: reference_material carrying a catalog payload. */
function catalogRecords(store: SterlingStore): Record<string, unknown>[] {
  return store
    .query({ types: ['reference_material'], cap: 200 })
    .filter((r) => (r as Record<string, unknown>).catalog) as unknown as Record<string, unknown>[];
}

/** Pending refresh_reference maintenance items. */
function refreshItems(store: SterlingStore): Record<string, unknown>[] {
  return store
    .query({ types: ['todo'], cap: 200 })
    .filter((r) => (r as Record<string, unknown>).system_reason === 'refresh_reference') as unknown as Record<string, unknown>[];
}

// config.models with a DUPLICATE pinned ID (5 roles, 3 distinct IDs) — the
// distinct-dedup discriminator: a naive one-entry-per-role impl yields 5.
const MODELS = {
  coder: { model: 'claude-sonnet-4-6', effort: 'medium' },
  researcher: { model: 'claude-sonnet-4-6', effort: 'medium' }, // duplicate ID
  test_writer: { model: 'claude-opus-4-8', effort: 'high' },
  reviewers: { model: 'claude-opus-4-8', effort: 'high' }, // duplicate ID
  explorer: { model: 'claude-haiku-4-5', effort: 'low' },
};
const DISTINCT_IDS = ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6']; // sorted

// --- catalogStatus (pure) -------------------------------------------------

test('AC8 catalogStatus: a missing catalog (null) reports present:false and is NOT stale (absence is the bootstrap path, not staleness)', () => {
  const res = callCatalogStatus(null, isoPlusDays(SEED, 100), 45);
  assert.equal(res.present, false, 'a null catalog record is not present');
  assert.equal(res.stale, false, 'absence is handled by bootstrap — a missing catalog is not reported "stale"');
  assert.ok(res.staleDate == null, 'no record → no stale horizon');
});

test('AC8 catalogStatus: a present, recent catalog reports present:true, stale:false, and a future stale horizon', () => {
  const rec = catalogRecordAt(SEED);
  const now = isoPlusDays(SEED, 10); // 10 days old, threshold 45
  const res = callCatalogStatus(rec, now, 45);
  assert.equal(res.present, true, 'a catalog-bearing record is present');
  assert.equal(res.stale, false, '10 days < 45-day threshold → fresh');
  assert.ok(res.staleDate != null, 'a present catalog reports a stale horizon');
  assert.equal(
    Date.parse(res.staleDate as string),
    Date.parse(SEED) + 45 * DAY_MS,
    'stale horizon = catalog clock + thresholdDays'
  );
  assert.ok(Date.parse(now) < Date.parse(res.staleDate as string), 'a fresh catalog: now is before the stale horizon');
});

test('AC8 catalogStatus: a catalog older than the threshold reports stale:true (present stays true)', () => {
  const rec = catalogRecordAt(SEED);
  const now = isoPlusDays(SEED, 60); // 60 days old, threshold 45
  const res = callCatalogStatus(rec, now, 45);
  assert.equal(res.present, true, 'a stale catalog is still present');
  assert.equal(res.stale, true, '60 days > 45-day threshold → stale');
  assert.ok(Date.parse(now) > Date.parse(res.staleDate as string), 'a stale catalog: now is past the stale horizon');
});

test('AC8 catalogStatus BOUNDARY: at EXACTLY staleness_days elapsed the catalog is FRESH (strict > convention, §3.2.5)', () => {
  const rec = catalogRecordAt(SEED);
  // exactly 45 whole days old, threshold 45 — age == threshold, NOT past it.
  const atEdge = callCatalogStatus(rec, isoPlusDays(SEED, 45), 45);
  assert.equal(atEdge.present, true);
  assert.equal(atEdge.stale, false, 'age == staleness_days is the LAST fresh point (strict >, mirroring tools.ts sourceAge > threshold)');
  // one whole day past the threshold — now stale.
  const pastEdge = callCatalogStatus(rec, isoPlusDays(SEED, 46), 45);
  assert.equal(pastEdge.stale, true, 'age == staleness_days + 1 is past the threshold → stale');
});

test('AC8 catalogStatus: the thresholdDays tunable governs the verdict for the same catalog', () => {
  const rec = catalogRecordAt(SEED);
  const now = isoPlusDays(SEED, 30); // fixed 30-day-old catalog
  assert.equal(callCatalogStatus(rec, now, 20).stale, true, 'threshold 20 (< age 30) → stale');
  assert.equal(callCatalogStatus(rec, now, 45).stale, false, 'threshold 45 (> age 30) → fresh — the tunable, not a hardcoded window, decides');
});

// --- bootstrapCatalogIfAbsent ---------------------------------------------

test('AC8 bootstrap: an absent catalog is seeded from config.models DISTINCT pinned IDs (5 roles → 3 entries)', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(catalogRecords(store).length, 0, 'precondition: no catalog exists');
    callBootstrap(store, { models: MODELS }, NOW);

    const cats = catalogRecords(store);
    assert.equal(cats.length, 1, 'bootstrap creates exactly one project-scoped catalog reference_material');
    const entries = (cats[0].catalog as { entries: { id: string }[] }).entries;
    const ids = entries.map((e) => e.id).sort();
    assert.deepEqual(ids, DISTINCT_IDS, 'entries are the DISTINCT pinned model IDs from config.models');
    assert.equal(entries.length, 3, 'distinct dedup — NOT one entry per role (5 roles, 3 distinct IDs)');
    for (const e of entries) {
      assert.ok(DISTINCT_IDS.includes(e.id), `no fabricated ID: ${e.id} came from config.models (no network seed)`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8 bootstrap: idempotent — a second call with a DIFFERENT config is a no-op (catalog present is left untouched)', () => {
  const { dir, store } = tempStore();
  try {
    callBootstrap(store, { models: MODELS }, NOW);
    // A different config, at a later time — must NOT reseed or append.
    callBootstrap(store, { models: { coder: { model: 'claude-sonnet-5-0', effort: 'medium' } } }, LATER);

    const cats = catalogRecords(store);
    assert.equal(cats.length, 1, 'still exactly one catalog — the second bootstrap did not create a duplicate');
    const ids = (cats[0].catalog as { entries: { id: string }[] }).entries.map((e) => e.id).sort();
    assert.deepEqual(ids, DISTINCT_IDS, 'the present catalog is preserved — not reseeded from the second config');
    assert.ok(!ids.includes('claude-sonnet-5-0'), 'a no-op bootstrap does not adopt the second config\'s IDs');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8 bootstrap BOUNDARY: empty config.models never throws, fabricates no IDs, and creates at most one catalog', () => {
  const { dir, store } = tempStore();
  try {
    assert.doesNotThrow(() => callBootstrap(store, { models: {} }, NOW), 'empty config.models is a degenerate but non-fatal input');
    const cats = catalogRecords(store);
    assert.ok(cats.length <= 1, 'empty config.models creates at most one catalog record');
    if (cats.length === 1) {
      const entries = (cats[0].catalog as { entries: unknown[] } | undefined)?.entries ?? [];
      assert.equal(entries.length, 0, 'empty config.models seeds ZERO entries — no fabricated defaults');
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- enqueueRefreshReferenceOnce ------------------------------------------

test('AC8 enqueue: creates exactly ONE refresh_reference system maintenance item', () => {
  const { dir, store } = tempStore();
  try {
    callBootstrap(store, { models: MODELS }, NOW);
    callEnqueue(store, NOW);

    const items = refreshItems(store);
    assert.equal(items.length, 1, 'one refresh_reference item enqueued');
    const item = items[0];
    assert.equal(item.source, 'system', 'a maintenance item is source:system');
    assert.equal(item.system_reason, 'refresh_reference', 'reuses the existing refresh_reference lane (decision 98064d77)'); // not-a-citation: fixture id
    if (item.feature_link != null) {
      assert.equal(item.feature_link, catalogRecords(store)[0].id, 'when linked, the refresh item points at the catalog record');
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8 enqueue: deduped — a second enqueue is a no-op while one is pending (never a duplicate)', () => {
  const { dir, store } = tempStore();
  try {
    callBootstrap(store, { models: MODELS }, NOW);
    callEnqueue(store, NOW);
    const firstId = refreshItems(store)[0].id;

    callEnqueue(store, LATER); // second call, item still pending

    const items = refreshItems(store);
    assert.equal(items.length, 1, 'still exactly one refresh_reference item — no duplicate while one is pending');
    assert.equal(items[0].id, firstId, 'the pending item is left in place, not replaced by a fresh one');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8 enqueue: once the pending item is removed, a fresh enqueue is allowed again (a genuinely new record)', () => {
  const { dir, store } = tempStore();
  try {
    callBootstrap(store, { models: MODELS }, NOW);
    callEnqueue(store, NOW);
    const firstId = refreshItems(store)[0].id as string;

    store.remove(firstId, LATER); // the maintenance item is worked/drained
    assert.equal(refreshItems(store).length, 0, 'removing the pending item clears the refresh_reference queue');

    callEnqueue(store, LATER);
    const after = refreshItems(store);
    assert.equal(after.length, 1, 'with no pending item, a fresh enqueue is allowed again');
    assert.notEqual(after[0].id, firstId, 'the re-enqueued item is a NEW record, not the removed one');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8 enqueue BOUNDARY: dedup is scoped to the refresh_reference lane — an unrelated pending item does not suppress it', () => {
  const { dir, store } = tempStore();
  try {
    callBootstrap(store, { models: MODELS }, NOW);
    // An unrelated pending maintenance item on a DIFFERENT lane.
    store.create({ ...envelope('todo'), text: 'reconcile something unrelated', source: 'system', system_reason: 'reconcile_needed' });

    callEnqueue(store, NOW);

    assert.equal(refreshItems(store).length, 1, 'dedup keys on refresh_reference — a pending reconcile_needed item must NOT block the enqueue');
    const reconciles = store
      .query({ types: ['todo'], cap: 200 })
      .filter((r) => (r as Record<string, unknown>).system_reason === 'reconcile_needed');
    assert.equal(reconciles.length, 1, 'enqueue leaves unrelated maintenance items untouched');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('articlesBySlug resolves an exact slug deterministically — a slug that loses its own bm25 top-5 still resolves', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(article({ slug: 'hooks-suite', what_it_does: 'Twenty-two bundled hooks.' }));
    // Six DECOYS that each mention the target slug far more than the target does
    // itself — the exact shape that made the ranked cap-5 lookup report a live
    // article as absent (decision foreign_3db7095f).
    for (let i = 0; i < 6; i += 1) {
      store.create(
        article({
          slug: `citer-${i}`,
          what_it_does: 'hooks-suite hooks-suite hooks-suite hooks-suite hooks-suite',
          intended_behavior: 'hooks-suite hooks-suite hooks-suite',
        })
      );
    }

    // The old mechanism, pinned here so the regression is visible rather than asserted:
    const ranked = store.query({ types: ['feature_article'], rank_terms: ['hooks-suite'], cap: 5 });
    assert.equal(ranked.length, 5, 'the ranked window is full');
    assert.equal(
      ranked.some((r) => (r as unknown as { slug: string }).slug === 'hooks-suite'),
      false,
      'and the owner is NOT in it — the decoys outrank it on its own slug'
    );

    const hit = store.articlesBySlug('hooks-suite');
    assert.equal(hit.length, 1, 'the lookup is unaffected by ranking or caps');
    assert.equal(hit[0].id, target.id);

    assert.deepEqual(store.articlesBySlug('no-such-slug'), [], 'a genuinely absent slug is still empty');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// withTransactionForScope on a plain SterlingStore — RETIRED 2026-09-06, decision
// `domain-held-subject-queue-items-close-two-step-named-mount-refusal-on-every-lane-label-routed-transaction-retired`
// (knowledge_get f2c61919-59ca-482e-8fab-53a7ddf13a2f): the three tests that lived here covered a
// label-routed opener with zero production callers, retired outright rather than fixed.

test('articlesBySlug serves the live head only, newest first — superseded versions never', () => {
  const { dir, store } = tempStore();
  try {
    const v1 = store.create(article({ slug: 'versioned' }));
    const v2 = store.supersede(v1.id, article({ slug: 'versioned', version: 2, updated_at: LATER }));

    const hits = store.articlesBySlug('versioned');
    assert.equal(hits.length, 1, 'the tombstone is not served — unlike recordIdIndex, this resolves the CURRENT article');
    assert.equal(hits[0].id, v2.id);
    assert.equal(hits[0].status, 'active');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ATOMIC MAINTENANCE DEDUP (board 2ded3b4b / feedback §2.2). Four producers each
// ran their own query-then-insert with no uniqueness constraint: two could both
// read "no open item" before either committed (seven byte-identical pairs 2-3ms
// apart, 52% of a 27-item queue), and every one of the four keys omitted the
// FILE — so a second drifting file was suppressed and then absorbed by the next
// re-baseline. One definition now, inside the insert transaction.
// ---------------------------------------------------------------------------

const storeHarness = () => {
  const { dir, store } = tempStore();
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
};

const ART_1 = randomUUID();
const ART_2 = randomUUID();

const sysTodo = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  type: 'todo',
  created_at: NOW,
  updated_at: NOW,
  author: 'system',
  status: 'active',
  superseded_by: null,
  links: [],
  scope: 'project',
  stack_tags: [],
  text: 'reconcile article x',
  source: 'system',
  system_reason: 'reconcile_needed',
  file_keys: ['src/a.ts'],
  feature_link: ART_1,
  ...over,
});

test('enqueueSystemTodo: the same (reason, link, file) returns the EXISTING item instead of duplicating', () => {
  const { store, cleanup } = storeHarness();
  try {
    const first = store.enqueueSystemTodo(sysTodo());
    assert.equal(first.deduped, false);
    const second = store.enqueueSystemTodo(sysTodo());
    assert.equal(second.deduped, true, 'the duplicate is collapsed');
    assert.equal(second.record.id, first.record.id, 'and the caller gets the item that already exists');
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ONE OPEN reconcile_needed ITEM PER feature_link (board b0bb9d96 / I-29, "the
// mint storm"): a read-time per-file minter and a settlement grouped-per-
// article minter used to coexist as DUPLICATES for the same article, because
// the universal key included the exact file_keys SET. This lane now folds on
// (system_reason, feature_link) ALONE, unioning file_keys IN — the opposite
// of the old test this block replaces, which pinned the two-item outcome as
// "the silent-loss half of the bug". That was the defect, not a contract.
// ---------------------------------------------------------------------------

test('enqueueSystemTodo: reconcile_needed — a DIFFERENT file on the SAME article WIDENS the existing item instead of duplicating it (case a)', () => {
  const { store, cleanup } = storeHarness();
  try {
    const first = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts'] }));
    assert.equal(first.deduped, false, 'baseline: first mint for this article');

    const second = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts', 'src/b.ts'] }));
    assert.equal(second.deduped, true, 'folded into the existing item, not a second one');
    assert.equal(second.record.id, first.record.id, 'the surviving item is the FIRST one — SABOTAGE: replacing instead of unioning makes this go RED (a fresh id)');

    const open = store.query({ types: ['todo'], cap: 100 });
    assert.equal(open.length, 1, 'exactly one open reconcile_needed item for this article');
    assert.deepEqual(
      [...((open[0] as unknown as { file_keys: string[] }).file_keys)].sort(),
      ['src/a.ts', 'src/b.ts'],
      "keys are the UNION — SABOTAGE: replacing file_keys instead of unioning makes this go RED (drops 'src/a.ts')"
    );
  } finally {
    cleanup();
  }
});

// DIRECT DESCENDANT of the historical silent-loss pin this fold replaced (the
// old store.test.ts:1172/1349 and server.test.ts:687 asserted 2 items here,
// each carrying its own guard text: "this is the silent-loss half of the
// bug" / "silently re-introduces the exact silent-loss bug decision foreign_194f43e4
// fixed"). That earlier bug (board 2ded3b4b) kept the SAME shape this fold
// now produces — one surviving item — but got there by keying dedup on
// (reason, feature_link) WITHOUT the file at all: a genuinely NEW, DISJOINT
// path enqueued for an article with an already-open item returned the
// EXISTING item as deduped and never recorded the new path — silent data
// loss, not a union. Case (a) above does not discriminate that regression
// because its second call's own payload already carries BOTH files
// (['src/a.ts','src/b.ts']), so even a "replace file_keys with the incoming
// candidate's" mutation happens to pass it. This test enqueues a SECOND,
// DISJOINT single-file payload — the second call names ONLY 'src/b.ts', never
// 'src/a.ts' — so the union is the only way 'src/a.ts' can still be present
// afterward.
test('enqueueSystemTodo: reconcile_needed — a DISJOINT second file must not be silently lost (descendant of the pre-fold silent-loss pin, board 2ded3b4b/decision foreign_194f43e4)', () => {
  const { store, cleanup } = storeHarness();
  try {
    const first = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts'] }));
    assert.equal(first.deduped, false, 'baseline: first mint for this article');

    // The incoming payload names ONLY the new path — never the old one — so a
    // "return the existing item, keys untouched" implementation (the
    // historical bug) and a correct union are distinguishable by this call
    // alone, unlike case (a)'s superset payload.
    const second = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/b.ts'] }));
    // enqueueSystemTodo's contract reports a matched-existing-item outcome as
    // `deduped: true` regardless of whether the match's body needed a rewrite
    // (see the sibling text-update/no-op tests above) — this fold is no
    // exception: the caller gets back "this collapsed into an existing item",
    // not a fresh insert, even though that existing item's file_keys just grew.
    assert.equal(second.deduped, true, 'the second, disjoint enqueue still reports a fold onto the existing item, not a fresh insert');
    assert.equal(second.record.id, first.record.id, 'the surviving item is the FIRST one — SABOTAGE: returning a fresh id makes this go RED');

    const open = store.query({ types: ['todo'], cap: 100 });
    assert.equal(open.length, 1, 'exactly one open item — SABOTAGE: silently dropping the union (the historical bug) still leaves exactly one item, so THIS assertion alone would not catch it — see the file_keys assertion below');
    assert.deepEqual(
      [...((open[0] as unknown as { file_keys: string[] }).file_keys)].sort(),
      ['src/a.ts', 'src/b.ts'],
      "file_keys is EXACTLY the union of both disjoint calls — SABOTAGE: the historical silent-loss bug (return the matched item unchanged, without folding the new path in) makes this go RED ('src/b.ts' missing)"
    );
    const text = (open[0] as unknown as { text: string }).text;
    assert.match(text, /src\/a\.ts/, 'the surviving text still names the FIRST call\'s path');
    assert.match(text, /src\/b\.ts/, 'and the surviving text names the SECOND, disjoint call\'s path — neither is silently dropped');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// drainResolves' resolvedReceipt OUT-PARAM (board b0bb9d96 fix-round HIGH):
// a caller building a "what did resolves actually close" disclosure from an
// EARLIER read (e.g. the pre-transaction validation a tool-layer caller did
// before this write) can be lying by the time the drain actually runs, now
// that this lane's own identity folds and widens an item in place. The fix
// is to capture each claimed item's state INSIDE drainResolves, immediately
// before its own removal — the COMMITTED state, not a stale earlier read —
// and hand that back through `resolvedReceipt`.
// ---------------------------------------------------------------------------

test('drainResolves: resolvedReceipt reflects the COMMITTED state at removal, not an earlier stale read — proven by a SECOND real connection widening the item first (board b0bb9d96 fix-round HIGH)', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision());
    const item = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts'] })).record;

    // Simulate a caller's EARLIER validation read of the item — the shape a
    // pre-transaction `claims` snapshot would have held. This value must NOT
    // be what the receipt below echoes.
    const staleRead = store.get(item.id) as unknown as { file_keys?: string[] };
    assert.deepEqual(staleRead.file_keys, ['src/a.ts'], 'baseline: this is what an earlier reader would have seen');

    // A SECOND, independent SterlingStore connection to the SAME db file
    // widens the item for real — the production fold path (enqueueSystemTodo),
    // exercised from a genuinely different connection rather than a re-read on
    // this one, so this is not a same-connection-cache artifact.
    const second = new SterlingStore(join(dir, 'sterling.db'));
    try {
      second.enqueueSystemTodo(sysTodo({ file_keys: ['src/b.ts'] })); // same feature_link (ART_1 default) — folds onto `item`
    } finally {
      second.close();
    }

    // Now drain `item` via an ordinary versioned write that never itself read
    // the item beforehand — resolvedReceipt is the ONLY place this call gets
    // to say what it closed.
    const receipt: { id: string; system_reason?: string; file_keys?: string[]; text?: string }[] = [];
    store.updateRecord(target.id, { ...decision(), rationale: 'updated by the resolves-race test' }, { resolves: [item.id], resolvedReceipt: receipt });

    assert.equal(receipt.length, 1, 'one snapshot for the one claimed id');
    assert.equal(receipt[0].id, item.id);
    assert.deepEqual(
      [...(receipt[0].file_keys ?? [])].sort(),
      ['src/a.ts', 'src/b.ts'],
      "the receipt names the WIDENED, committed set — SABOTAGE: building resolvedReceipt from a pre-transaction/pre-widen read (the historical HIGH bug) makes this go RED (['src/a.ts'] only, 'src/b.ts' missing)"
    );
    assert.equal(store.get(item.id), undefined, 'and the item really is gone — the drain still happened');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drainResolves: resolvedReceipt is undefined/omitted when no receipt array is supplied — an OUT-param, not a mandatory return', () => {
  const { store, cleanup } = storeHarness();
  try {
    const target = store.create(decision());
    const item = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts'] })).record;
    // No `resolvedReceipt` passed — must not throw, and must drain exactly as before.
    const updated = store.updateRecord(target.id, { ...decision(), rationale: 'updated, no receipt requested' }, { resolves: [item.id] });
    assert.ok(updated);
    assert.equal(store.get(item.id), undefined, 'the item still drains with no receipt requested');
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: a different reason, or a different article, is also distinct', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo());
    store.enqueueSystemTodo(sysTodo({ system_reason: 'file_parked' }));
    store.enqueueSystemTodo(sysTodo({ feature_link: ART_2 }));
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 3);
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: a match whose TEXT differs is UPDATED, not discarded (escalating severity)', () => {
  const { store, cleanup } = storeHarness();
  try {
    const first = store.enqueueSystemTodo(sysTodo({ text: "reconcile article 'x' — src/a.ts changed on disk (out-of-band edit)" }));
    // Same file, worse news, first item not yet drained. Swallowing this as a
    // duplicate would lose the more urgent fact.
    const second = store.enqueueSystemTodo(
      sysTodo({ text: "reconcile article 'x' — src/a.ts no longer exists (out-of-band deletion)", updated_at: '2026-06-11T00:00:00.000Z' })
    );
    assert.equal(second.deduped, true, 'still one item');
    assert.equal(second.text_updated, true, 'but its text was refreshed');
    assert.equal(second.record.id, first.record.id);
    const [only] = store.query({ types: ['todo'], cap: 100 }) as unknown as { text: string; updated_at: string }[];
    assert.match(only.text, /no longer exists/, 'the queue carries the newer, more urgent fact');
    assert.equal(only.updated_at, '2026-06-11T00:00:00.000Z', 'and its timestamp moved');
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: identical text is NOT an update — a repeat report changes nothing', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo());
    const again = store.enqueueSystemTodo(sysTodo({ updated_at: '2026-06-11T00:00:00.000Z' }));
    assert.equal(again.text_updated, false);
    const [only] = store.query({ types: ['todo'], cap: 100 }) as unknown as { updated_at: string }[];
    assert.equal(only.updated_at, NOW, 'no churn on a re-report of the same fact');
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: items with NO link and NO file_keys stay distinct by text', () => {
  const { store, cleanup } = storeHarness();
  try {
    // capture_owed / research_owed carry neither, so keying on the reason alone
    // would merge unrelated obligations — trading one bug for a worse one.
    const bare = { file_keys: undefined, feature_link: undefined, system_reason: 'capture_owed' };
    store.enqueueSystemTodo(sysTodo({ ...bare, text: 'capture the decision about X' }));
    store.enqueueSystemTodo(sysTodo({ ...bare, text: 'capture the anti-pattern about Y' }));
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 2, 'two different obligations survive');
    store.enqueueSystemTodo(sysTodo({ ...bare, text: 'capture the decision about X' }));
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 2, 'an exact duplicate still collapses');
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo refuses anything that is not a system-source todo', () => {
  const { store, cleanup } = storeHarness();
  try {
    assert.throws(() => store.enqueueSystemTodo(sysTodo({ source: 'user' })), /expects a system-source todo/);
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: file_keys ORDER does not create a false distinction', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts', 'src/b.ts'] }));
    const second = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/b.ts', 'src/a.ts'] }));
    assert.equal(second.deduped, true, 'the key is a SET — the same pair in another order is the same item');
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PATH PRUNING FOR reconcile_needed (board 7e779e1f). Transferring a file
// between owning articles (knowledge_array_remove off the old owner +
// knowledge_append onto the new one) used to leave the OLD owner's open item
// still naming the transferred path, and an ATTESTED close of that item
// refused WHOLE — even for the item's other, untouched keys — because
// refuseAttestationScope's SUBSET check (correctly) sees a path the owner no
// longer owns. These pin the store half of the fix: a same-store versioned
// in-place write that makes a record stop claiming a path prunes that path
// from the record's own open reconcile_needed item, in the SAME transaction,
// through applyInPlace/pruneReconcileNeeded.
// ---------------------------------------------------------------------------

test('pruneReconcileNeeded: a write that stops claiming ONE of an item\'s TWO paths shrinks it in place — same id, text regenerated', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }, { path: 'src/b.ts', role: 'impl' }] }));
    const item = store.enqueueSystemTodo(
      sysTodo({
        feature_link: art.id,
        file_keys: ['src/a.ts', 'src/b.ts'],
        text: "reconcile article 'csv-export' — owned file(s) changed content in direct mode (settled): src/a.ts, src/b.ts",
      })
    ).record;

    const receipt: { id: string; system_reason?: string; removed: boolean; pruned_paths: string[]; remaining_file_keys: string[] }[] = [];
    store.updateRecord(art.id, article({ files: [{ path: 'src/b.ts', role: 'impl' }] }), { prunedReceipt: receipt });

    assert.equal(receipt.length, 1, 'one item touched');
    assert.equal(receipt[0].id, item.id);
    assert.equal(receipt[0].removed, false, 'one path remains — the item survives');
    assert.deepEqual(receipt[0].pruned_paths, ['src/a.ts']);
    assert.deepEqual(receipt[0].remaining_file_keys, ['src/b.ts']);

    const [survivor] = store.query({ types: ['todo'], cap: 100 }) as unknown as { id: string; file_keys: string[]; text: string }[];
    assert.equal(survivor.id, item.id, 'SAME id — SABOTAGE: a remove+reinsert instead of an in-place shrink makes this go RED');
    assert.deepEqual(survivor.file_keys, ['src/b.ts'], 'the pruned path is gone from file_keys');
    assert.match(survivor.text, /src\/b\.ts/, 'the surviving path is still named');
    assert.doesNotMatch(survivor.text, /src\/a\.ts/, 'the pruned path is gone from the regenerated text too — SABOTAGE: not regenerating text through buildReconcileText makes this go RED');
  } finally {
    cleanup();
  }
});

test('pruneReconcileNeeded: a write that stops claiming an item\'s ONLY path removes it through the NORMAL removal path (drain log gets it)', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }, { path: 'src/b.ts', role: 'impl' }] }));
    const item = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts'] })).record;

    const receipt: { id: string; removed: boolean; pruned_paths: string[]; remaining_file_keys: string[] }[] = [];
    store.updateRecord(art.id, article({ files: [{ path: 'src/b.ts', role: 'impl' }] }), { prunedReceipt: receipt });

    assert.equal(receipt.length, 1);
    assert.equal(receipt[0].id, item.id);
    assert.equal(receipt[0].removed, true, 'the item\'s only path was pruned — nothing left to reconcile');
    assert.deepEqual(receipt[0].remaining_file_keys, []);
    assert.equal(store.get(item.id), undefined, 'the item is really gone — SABOTAGE: leaving a zero-key item behind makes this go RED');
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 0);
    const drain = store.listQueueDrain(10);
    assert.equal(drain.length, 1, 'the removal went through the NORMAL removal path (queue_drain_log recorded it) — SABOTAGE: a bare DELETE bypassing remove() makes this go RED');
    assert.equal(drain[0].system_reason, 'reconcile_needed');
    assert.deepEqual(drain[0].file_keys, ['src/a.ts']);
  } finally {
    cleanup();
  }
});

test('pruneReconcileNeeded: a shrink by a path the item does NOT name leaves the item completely untouched', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }, { path: 'src/b.ts', role: 'impl' }] }));
    // The item names only 'src/a.ts' — the write below drops 'src/b.ts', which
    // this item never claimed.
    const item = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts'] })).record;
    const before = store.get(item.id) as unknown as { version: number; file_keys: string[]; text: string };

    const receipt: { id: string; system_reason?: string; removed: boolean; pruned_paths: string[]; remaining_file_keys: string[] }[] = [];
    store.updateRecord(art.id, article({ files: [{ path: 'src/a.ts', role: 'impl' }] }), { prunedReceipt: receipt });

    assert.equal(receipt.length, 0, 'nothing named in this item was dropped — SABOTAGE: pruning by owner alone (ignoring which paths the item names) makes this go RED');
    const after = store.get(item.id) as unknown as { version: number; file_keys: string[]; text: string };
    assert.equal(after.version, before.version, 'no write landed on the item at all');
    assert.deepEqual(after.file_keys, ['src/a.ts']);
    assert.equal(after.text, before.text);
  } finally {
    cleanup();
  }
});

test('renameFileKey: a rename is NOT a shrink — the item\'s path follows the rename, nothing is pruned', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }] }));
    const item = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts'] })).record;

    store.renameFileKey('src/a.ts', 'src/a2.ts');

    const after = store.get(item.id) as unknown as { file_keys: string[]; text: string };
    assert.deepEqual(after.file_keys, ['src/a2.ts'], 'the item\'s OWN path followed the rename (renameFileKey\'s pre-existing behaviour) — SABOTAGE: a prune firing on the rename\'s apparent shrink would instead DROP this path, making this go RED');
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 1, 'still exactly one item — never removed as a false "zero paths left" prune');
    // EXTENDED (review round, MEDIUM): the canonical text must follow the
    // rename too — a rewrite that moves file_keys but leaves text naming the
    // OLD path is stale prose the next reader cannot trust. SABOTAGE: renaming
    // file_keys without regenerating text through buildReconcileText leaves
    // 'src/a.ts' in the text, going RED on the second assertion below.
    assert.match(after.text, /src\/a2\.ts/, 'the regenerated text names the NEW path');
    assert.doesNotMatch(after.text, /src\/a\.ts/, 'the regenerated text no longer names the OLD path');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// REVIEW ROUND (board 7e779e1f) — three findings on the prune diff, all
// accepted. This block covers the two renameFileKey findings:
//
//   HIGH   renameFileKey read record_file_keys BEFORE taking the write lock
//          (BEGIN IMMEDIATE), so a reconcile_needed item minted for the OLD
//          path by a concurrent writer in that gap was invisible to the
//          rename's own row list — the owner moved to the NEW path while the
//          item kept naming the OLD one, reproducing the exact unclosable
//          state this whole change exists to fix. FIXED by moving the query
//          inside this.tx(), after BEGIN IMMEDIATE takes the lock.
//
//   MEDIUM deepReplaceString maps file_keys with NO DEDUPE and only replaces
//          an exact string match — an item already naming BOTH the old and
//          new path collides into a duplicate entry, and the canonical text
//          (asserted above) was never regenerated at all. FIXED by deduping
//          and regenerating text through buildReconcileText specifically for
//          a reconcile_needed system todo, inside renameFileKey's own patch —
//          deepReplaceString itself is UNCHANGED, so every other record type
//          and lane keeps its exact pre-existing behaviour.
// ---------------------------------------------------------------------------

test('renameFileKey HIGH fix: an item enqueued on a SECOND connection, committed immediately before the rename call, still ends up naming the NEW path — the read happens under the write lock, not before it', () => {
  const { dir, store } = tempStore();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }] }));

    // A second, independent connection to the SAME db file — production
    // shape, not a same-connection artifact (mirrors the I-29 drainResolves
    // race test above). Its write COMMITS before renameFileKey is ever
    // called on connection 1.
    //
    // WHAT THIS DOES NOT PIN: the true TOCTOU window the HIGH finding named
    // was a read that ran OUTSIDE any transaction, followed later by BEGIN
    // IMMEDIATE — a gap a black-box test cannot force a real second
    // connection's commit INTO without a test-only seam (which the review
    // explicitly said not to add). That window is closed BY CONSTRUCTION
    // now (the SELECT runs after BEGIN IMMEDIATE has already taken the
    // write lock, so no commit can land between the read and the rewrite),
    // not by this test. What this DOES pin is the externally-observable
    // outcome the closed window guarantees: an item that exists before
    // renameFileKey is called is never missed by it.
    const second = new SterlingStore(join(dir, 'sterling.db'));
    let itemId: string;
    try {
      itemId = second.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts'] })).record.id;
    } finally {
      second.close();
    }

    store.renameFileKey('src/a.ts', 'src/a2.ts');

    const after = store.get(itemId) as unknown as { file_keys: string[] };
    assert.deepEqual(after.file_keys, ['src/a2.ts']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renameFileKey MEDIUM fix: a reconcile_needed item colliding on the rename target DEDUPES its file_keys, and its text is regenerated to match', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a2.ts', role: 'impl' }] }));
    // The item already names BOTH the pre-rename path and its target — the
    // collision case deepReplaceString's plain element-wise map cannot
    // dedupe on its own.
    const item = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts', 'src/a2.ts'] })).record;

    store.renameFileKey('src/a.ts', 'src/a2.ts');

    const after = store.get(item.id) as unknown as { file_keys: string[]; text: string };
    assert.deepEqual(
      after.file_keys,
      ['src/a2.ts'],
      "SABOTAGE: a non-deduping rewrite leaves ['src/a2.ts','src/a2.ts'] here, going RED"
    );
    assert.match(after.text, /src\/a2\.ts/);
    assert.doesNotMatch(after.text, /src\/a\.ts/, 'the stale pre-rename path name must not survive in the regenerated text');
  } finally {
    cleanup();
  }
});

test('renameFileKey: deepReplaceString itself is UNCHANGED for every OTHER lane — a plain decision\'s file_keys still map element-wise with no dedupe pass', () => {
  const { store, cleanup } = storeHarness();
  try {
    // A decision naming the SAME path twice in file_keys (legacy/malformed
    // data, but nothing refuses it at this layer) is not a reconcile_needed
    // system todo, so the MEDIUM fix's dedupe/regenerate branch must not
    // touch it — only that ONE lane's rename-time patch changed.
    const d = store.create(decision({ file_keys: ['src/a.ts', 'src/a.ts'] }));
    store.renameFileKey('src/a.ts', 'src/a2.ts');
    const after = store.get(d.id) as unknown as { file_keys: string[] };
    assert.deepEqual(after.file_keys, ['src/a2.ts', 'src/a2.ts'], 'unchanged deepReplaceString behaviour outside the reconcile_needed lane — SABOTAGE: a blanket dedupe applied to every renamed record makes this go RED');
  } finally {
    cleanup();
  }
});

test('pruneReconcileNeeded: a write that both claims the item in resolves AND shrinks is drained ONCE — no throw, never reported as pruned', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }, { path: 'src/b.ts', role: 'impl' }] }));
    const item = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts', 'src/b.ts'] })).record;

    const resolvedReceipt: { id: string; file_keys?: string[] }[] = [];
    const prunedReceipt: { id: string; system_reason?: string; removed: boolean; pruned_paths: string[]; remaining_file_keys: string[] }[] = [];
    assert.doesNotThrow(() =>
      store.updateRecord(art.id, article({ files: [{ path: 'src/b.ts', role: 'impl' }] }), {
        resolves: [item.id],
        resolvedReceipt,
        prunedReceipt,
      })
    );

    assert.equal(resolvedReceipt.length, 1, 'drained via the explicit claim');
    assert.equal(resolvedReceipt[0].id, item.id);
    assert.equal(prunedReceipt.length, 0, 'the SAME item is never ALSO reported as pruned — SABOTAGE: pruning before checking drain state makes this go RED');
    assert.equal(store.get(item.id), undefined, 'gone either way');
  } finally {
    cleanup();
  }
});

test('pruneReconcileNeeded: a non-reconcile_needed lane item is never touched by an owner\'s shrink', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ files: [{ path: 'src/a.ts', role: 'impl' }, { path: 'src/b.ts', role: 'impl' }] }));
    const parked = store.enqueueSystemTodo(
      sysTodo({ system_reason: 'file_parked', feature_link: art.id, file_keys: ['src/a.ts'], text: 'src/a.ts is parked on a branch' })
    ).record;
    const before = store.get(parked.id) as unknown as { version: number; file_keys: string[] };

    const receipt: { id: string; system_reason?: string; removed: boolean; pruned_paths: string[]; remaining_file_keys: string[] }[] = [];
    store.updateRecord(art.id, article({ files: [{ path: 'src/b.ts', role: 'impl' }] }), { prunedReceipt: receipt });

    assert.equal(receipt.length, 0, 'file_parked is not the reconcile_needed lane — SABOTAGE: pruning any system lane by feature_link alone makes this go RED');
    const after = store.get(parked.id) as unknown as { version: number; file_keys: string[] };
    assert.equal(after.version, before.version);
    assert.deepEqual(after.file_keys, ['src/a.ts']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STABLE state_review IDENTITY (board e939fd21). Its file_keys are chosen by
// the CALLER (tools.ts) as unverifiedPaths-else-first-3-owned, so re-detecting
// the SAME article's state-honesty debt can present a DIFFERENT file_keys set
// on successive reads even though the semantic cause never changed — under
// the universal (system_reason, feature_link, file_keys-SET) key (decision
// 194f43e4) that mints a fresh duplicate every time the shape shifts. The fix
// gives state_review ONLY a lane-specific key of {system_reason, feature_link}
// at the enqueueSystemTodo choke point. Every OTHER lane's per-file dedup
// (decision foreign_194f43e4) was UNCHANGED at the time this block was written and is
// still pinned below as a control — EXCEPT reconcile_needed WITH a
// feature_link, which board b0bb9d96 / I-29 later gave its own
// {system_reason, feature_link} fold (unioning file_keys in, never keying on
// them) for the same reason state_review needed one: see the section below
// this one.
// ---------------------------------------------------------------------------

test('enqueueSystemTodo: state_review dedups on {system_reason, feature_link} ALONE — a DIFFERENT file_keys set for the SAME article is the SAME item', () => {
  const { store, cleanup } = storeHarness();
  try {
    const first = store.enqueueSystemTodo(
      sysTodo({
        system_reason: 'state_review',
        text: "article 'x' declares state 'planned' while its files hold real code",
        file_keys: ['src/a.ts'],
      })
    );
    assert.equal(first.deduped, false, 'baseline: first detection mints');

    const second = store.enqueueSystemTodo(
      sysTodo({
        system_reason: 'state_review',
        text: "article 'x' roles for src/b.ts are still flagged unverified",
        file_keys: ['src/b.ts', 'src/c.ts'],
      })
    );
    assert.equal(
      second.deduped,
      true,
      "re-detecting the SAME article's state-honesty debt through a DIFFERENT file_keys set must dedupe, not duplicate — " +
        'SABOTAGE: reverting the lane exception (keying state_review on the universal per-file key again) makes this go RED (mints a second item)'
    );
    assert.equal(second.record.id, first.record.id, 'the surviving item is the ORIGINAL, not a fresh duplicate');
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).filter((t) => (t as Record<string, unknown>).system_reason === 'state_review').length,
      1
    );
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: state_review CONTROL — a genuinely DIFFERENT article still mints its own separate item', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo({ system_reason: 'state_review', file_keys: ['src/a.ts'], feature_link: ART_1 }));
    store.enqueueSystemTodo(sysTodo({ system_reason: 'state_review', file_keys: ['src/a.ts'], feature_link: ART_2 }));
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).filter((t) => (t as Record<string, unknown>).system_reason === 'state_review').length,
      2,
      'CONTROL: the stable-identity fix is scoped to {system_reason, feature_link} TOGETHER — ' +
        'SABOTAGE: dropping feature_link from the state_review key too (keying on system_reason alone) makes this go RED (both articles collapse to one item)'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// reconcile_needed's fold-to-union (board b0bb9d96 / I-29) SUPERSEDES the
// per-file-SET reading of decision foreign_194f43e4 for this one lane, but not its
// underlying purpose: 194f43e4 existed to stop a second drifting file being
// SILENTLY LOST when a first file's debt was reconciled. The fold does not
// reopen that hole — every file stays named, just inside ONE item's unioned
// file_keys instead of a second item. The exact-key reading of 194f43e4
// still governs every OTHER lane, and reconcile_needed itself keeps it when
// there is no feature_link to fold on (case e below).
// ---------------------------------------------------------------------------

test('enqueueSystemTodo: reconcile_needed — two legacy single-file duplicates are FOLDED into the oldest, union complete (case b)', () => {
  const { store, cleanup } = storeHarness();
  try {
    // Simulate two items minted BEFORE this fix shipped (the old exact-key
    // choke point would have inserted both) by seeding them directly through
    // store.create — enqueueSystemTodo itself can no longer produce this
    // shape, which is the point of the fix.
    const older = store.create(
      sysTodo({ id: randomUUID(), created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z', file_keys: ['src/a.ts'] })
    );
    const newer = store.create(
      sysTodo({ id: randomUUID(), created_at: '2026-06-05T00:00:00.000Z', updated_at: '2026-06-05T00:00:00.000Z', file_keys: ['src/b.ts'] })
    );
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 2, 'baseline: two legacy duplicates exist');

    const folded = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/c.ts'] }));

    const open = store.query({ types: ['todo'], cap: 100 });
    assert.equal(open.length, 1, 'both legacy duplicates plus the new enqueue settle to ONE item');
    assert.equal(folded.record.id, older.id, 'the OLDEST id survives — SABOTAGE: keeping the newest or a fresh id makes this go RED');
    assert.notEqual(folded.record.id, newer.id);
    assert.deepEqual(
      [...((open[0] as unknown as { file_keys: string[] }).file_keys)].sort(),
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      'union is complete across both folded duplicates plus the incoming enqueue'
    );

    // The folded-away duplicate went through the store's own removal path
    // (P4), not a bare delete — its drain is visible in the audit log exactly
    // like any other closed system todo.
    assert.ok(store.drainLogEntry(newer.id), 'the folded duplicate is traced in queue_drain_log — removed through the normal path, audit trail kept');
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: reconcile_needed — the SAME file owned by two DIFFERENT articles is two legitimate items (case c)', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo({ feature_link: ART_1, file_keys: ['src/shared.ts'] }));
    store.enqueueSystemTodo(sysTodo({ feature_link: ART_2, file_keys: ['src/shared.ts'] }));
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).length,
      2,
      'no cross-owner dedupe — one changed file owned by N articles is N legitimate items, never collapsed'
    );
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: a non-reconcile_needed reason keeps EXACT file_keys-set dedup, unchanged (case d)', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo({ system_reason: 'file_parked', file_keys: ['src/a.ts'] }));
    store.enqueueSystemTodo(sysTodo({ system_reason: 'file_parked', file_keys: ['src/b.ts'] }));
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).length,
      2,
      'file_parked (and every other lane) is untouched by the reconcile_needed fold — still distinct per exact file_keys set'
    );
  } finally {
    cleanup();
  }
});

test('enqueueSystemTodo: reconcile_needed with NO feature_link keeps the old exact file_keys-set dedup, unchanged (case e)', () => {
  const { store, cleanup } = storeHarness();
  try {
    store.enqueueSystemTodo(sysTodo({ feature_link: undefined, file_keys: ['src/a.ts'], text: 'reconcile an unlinked file src/a.ts' }));
    store.enqueueSystemTodo(sysTodo({ feature_link: undefined, file_keys: ['src/b.ts'], text: 'reconcile an unlinked file src/b.ts' }));
    assert.equal(
      store.query({ types: ['todo'], cap: 100 }).length,
      2,
      'the fold is keyed on feature_link — without one there is nothing to fold on, so this stays the old per-file behaviour ' +
        '(the queue-truth-at-read read-time mint never omits feature_link in practice, but the choke point must not assume that)'
    );
  } finally {
    cleanup();
  }
});

test("enqueueSystemTodo: reconcile_needed — the surviving item's text names EVERY path in the union, not just the first (case f)", () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ slug: 'union-text-subject' }));
    store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/a.ts'] }));
    store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/b.ts'] }));
    const widened = store.enqueueSystemTodo(sysTodo({ feature_link: art.id, file_keys: ['src/c.ts'] }));
    const text = (widened.record as unknown as { text: string }).text;

    assert.match(text, /src\/a\.ts/, 'names the first-folded path');
    assert.match(text, /src\/b\.ts/, 'names the second-folded path');
    assert.match(text, /src\/c\.ts/, 'names the incoming path');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ZERO-MATCH INSERT CANONICALIZATION (board b0bb9d96 fix-round MEDIUM): the
// FIRST enqueue for an article can already carry more than one file in
// file_keys (settlement's grouped mint does exactly this) while its own
// caller-authored text names only one of them — nothing widens this item
// later to correct the prose, because there is no EXISTING item to fold
// against. A multi-file first insert must be canonicalized through the same
// buildReconcileText the fold uses. A single-file first insert is left
// exactly as the caller wrote it — see the CONTROL below for why.
// ---------------------------------------------------------------------------

test('enqueueSystemTodo: reconcile_needed — a FIRST insert carrying MULTIPLE file_keys is canonicalized through buildReconcileText, not left with narrower caller text (board b0bb9d96 fix-round MEDIUM)', () => {
  const { store, cleanup } = storeHarness();
  try {
    const art = store.create(article({ slug: 'multi-first-insert' }));
    const result = store.enqueueSystemTodo(
      sysTodo({
        feature_link: art.id,
        file_keys: ['src/a.ts', 'src/b.ts'],
        text: "reconcile article 'multi-first-insert' — src/a.ts changed on disk (out-of-band edit)",
      })
    );
    assert.equal(result.deduped, false, 'this is genuinely the first item for this article — no fold happened');
    const text = (result.record as unknown as { text: string }).text;
    assert.match(text, /src\/a\.ts/, 'still names the first path');
    assert.match(
      text,
      /src\/b\.ts/,
      "and names the SECOND path too — SABOTAGE: inserting the caller's own narrower text unchanged on a zero-match insert makes this go RED (missing 'src/b.ts')"
    );
  } finally {
    cleanup();
  }
});

test("enqueueSystemTodo: reconcile_needed CONTROL — a FIRST insert carrying exactly ONE file_key keeps the caller's own text UNCHANGED", () => {
  const { store, cleanup } = storeHarness();
  try {
    const callerText = "reconcile article 'x' — src/a.ts no longer exists (out-of-band deletion)";
    const result = store.enqueueSystemTodo(sysTodo({ file_keys: ['src/a.ts'], text: callerText }));
    assert.equal(
      (result.record as unknown as { text: string }).text,
      callerText,
      "CONTROL: a single-file first insert is NOT rewritten through the generic union builder — its specific per-file wording " +
        "('no longer exists' vs 'changed on disk', or state_review's escalating phrasing elsewhere) carries real information a generic " +
        'rendering would flatten, and with exactly one file there is nothing a union could say more truthfully'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// relied_by DERIVED AT READ TIME (board 9641e01b, option (b)): relies_on stays
// author-written; relied_by is computed from the union of every other active
// feature_article's relies_on naming this article's slug — on get() AND
// query() alike, so neither read surface can serve the stale stored field.
// ---------------------------------------------------------------------------

test('derived relied_by reflects a fresh relies_on immediately — no backfill of the depended-on article needed', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article({ slug: 'a', dependencies: { relies_on: [], relied_by: [] } }));
    // 'a' has never had its own relied_by touched — proving the union is
    // computed from OTHER articles' relies_on, not from anything stored on 'a'.
    assert.deepEqual((store.get(a.id) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by, []);

    store.create(article({ slug: 'b', dependencies: { relies_on: ['a'], relied_by: [] } }));

    const viaGet = store.get(a.id) as unknown as { dependencies: { relied_by: string[] } };
    assert.deepEqual(viaGet.dependencies.relied_by, ['b'], 'get() serves the derived set the instant b declares it');

    const viaQuery = store.query({ types: ['feature_article'], cap: 100 }).find((r) => (r as unknown as { slug: string }).slug === 'a') as unknown as {
      dependencies: { relied_by: string[] };
    };
    assert.deepEqual(viaQuery.dependencies.relied_by, ['b'], 'query() agrees with get()');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relied_by_stored_stale discloses a stored value that no longer matches the derived set, and stays absent when it matches', () => {
  const { dir, store } = tempStore();
  try {
    // 'a' stores a relied_by lie: a slug that names nothing real, and omits the
    // sibling that actually relies on it.
    const a = store.create(article({ slug: 'a', dependencies: { relies_on: [], relied_by: ['ghost-slug'] } }));
    store.create(article({ slug: 'b', dependencies: { relies_on: ['a'], relied_by: [] } }));

    const stale = store.get(a.id) as unknown as { dependencies: { relied_by: string[]; relied_by_stored_stale?: boolean } };
    assert.deepEqual(stale.dependencies.relied_by, ['b'], 'the SERVED value is always the derived one');
    assert.equal(stale.dependencies.relied_by_stored_stale, true, 'never a hidden lie — the mismatch is disclosed');

    // Now correct the stored field to genuinely match the derived set.
    store.supersede(a.id, article({ slug: 'a', dependencies: { relies_on: [], relied_by: ['b'] }, version: 2 }));
    const fresh = store
      .query({ types: ['feature_article'], cap: 100 })
      .find((r) => (r as unknown as { slug: string }).slug === 'a') as unknown as {
      dependencies: { relied_by: string[]; relied_by_stored_stale?: boolean };
    };
    assert.deepEqual(fresh.dependencies.relied_by, ['b']);
    assert.equal(fresh.dependencies.relied_by_stored_stale, undefined, 'a matching stored value discloses nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derived relied_by is deduped and sorted regardless of authoring order or duplicate declarations', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article({ slug: 'a', dependencies: { relies_on: [], relied_by: [] } }));
    // 'c' names 'a' twice (author error) and 'z' names 'a' once — inserted in an
    // order that would NOT already be sorted if left alone.
    store.create(article({ slug: 'z', dependencies: { relies_on: ['a'], relied_by: [] } }));
    store.create(article({ slug: 'c', dependencies: { relies_on: ['a', 'a'], relied_by: [] } }));

    const got = store.get(a.id) as unknown as { dependencies: { relied_by: string[] } };
    assert.deepEqual(got.dependencies.relied_by, ['c', 'z'], 'deduped (c counted once) and sorted, not insertion order');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a superseded article is excluded from derivation on BOTH sides: its relies_on no longer contributes, and it no longer receives derived edges', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article({ slug: 'a', dependencies: { relies_on: [], relied_by: [] } }));
    const b = store.create(article({ slug: 'b', dependencies: { relies_on: ['a'], relied_by: [] } }));
    assert.deepEqual((store.get(a.id) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by, ['b']);

    // Supersede b with a new version that no longer relies on 'a'.
    store.supersede(b.id, article({ slug: 'b', dependencies: { relies_on: [], relied_by: [] }, version: 2 }));
    assert.deepEqual(
      (store.get(a.id) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by,
      [],
      "b's superseded (old) relies_on no longer counts toward a's derived relied_by"
    );

    // Now supersede 'a' itself out of existence (a's own record becomes a tombstone).
    store.create(article({ slug: 'c', dependencies: { relies_on: ['a'], relied_by: [] } }));
    assert.deepEqual((store.get(a.id) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by, ['c']);
    store.supersede(a.id, article({ slug: 'a', dependencies: { relies_on: [], relied_by: [] }, version: 2 }));
    // The new head of 'a' is a DIFFERENT id but the same slug — derivation is
    // slug-keyed, so 'c' still resolves to the live head of 'a'.
    const newHeadId = store.articlesBySlug('a')[0].id;
    assert.deepEqual((store.get(newHeadId) as unknown as { dependencies: { relied_by: string[] } }).dependencies.relied_by, ['c']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// PIPELINE-INDEPENDENT (decision sterling-claude-code-scale-down-boundary,
// 2ad87dd1): recordCheckSkipped/listCheckSkipped survive the staged-pipeline
// removal — a runId is always undefined now (the run concept is gone), so
// every row is the NULL-run "direct-mode" shape (knowledge_create/board_remove
// callers). Relocated/rewritten from the deleted
// packages/store/src/tests/runs.test.ts's 'check_skipped: recorded and
// listable, run-scoped or global (§16.1.9)', which exercised the runId-bound
// half through the now-deleted createRun — that half no longer exists to pin.
test('recordCheckSkipped/listCheckSkipped with runId undefined: recording, listing, and the 50-newest-row NULL-run retention cap', () => {
  const { dir, store } = tempStore();
  try {
    store.recordCheckSkipped('dedup-merge', 'not_built', undefined, NOW);
    store.recordCheckSkipped('noise-gate', 'not_built', undefined, NOW);
    const rows = store.listCheckSkipped();
    assert.equal(rows.length, 2, 'both NULL-run rows are recorded and listable');
    assert.deepEqual(rows.map((r) => r.check_name), ['dedup-merge', 'noise-gate']);
    assert.ok(rows.every((r) => r.run_id === null), 'every row carries a NULL run_id — the run concept no longer exists');

    // listCheckSkipped(runId) still works and returns nothing for a runId that
    // was never recorded (the run-scoped read path survives even though
    // nothing writes a non-null runId anymore).
    assert.deepEqual(store.listCheckSkipped('r-none'), [], 'a runId that was never recorded returns empty, not an error');

    // RETENTION CAP: NULL-run rows accrete forever with no disposal event
    // (dispose-run is gone too), so recordCheckSkipped caps them at the 50
    // newest on every write (store.ts's own INSERT + prune, wrapped in one
    // tx()). Push well past 50 and confirm exactly 50 survive, and that the
    // survivors are the NEWEST 50 (the two seeded above are pruned out).
    for (let i = 0; i < 60; i++) {
      store.recordCheckSkipped(`check-${i}`, 'not_built', undefined, NOW);
    }
    const after = store.listCheckSkipped();
    assert.equal(after.length, 50, 'the NULL-run audit tail is capped at the 50 newest rows');
    const names = after.map((r) => r.check_name);
    assert.ok(!names.includes('dedup-merge') && !names.includes('noise-gate'), 'the two oldest seed rows were pruned out by the cap');
    assert.deepEqual(names, Array.from({ length: 50 }, (_, i) => `check-${i + 10}`), 'exactly the 50 newest check names survive, oldest-to-newest by seq');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
