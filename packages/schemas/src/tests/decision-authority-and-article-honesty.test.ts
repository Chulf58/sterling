// ------------------- SPEC A: decision.authority (board 055cfb6a) -------------------
// ------------------- SPEC B: feature_article test-honesty fields (board 6a8507f8) -------------------
//
// Schema-layer pins ONLY (packages/schemas). The digest/title RENDERING surfaces named in
// board 055cfb6a's fix description are a separate later slice and are deliberately NOT
// pinned here.
//
// Written RED-FIRST: none of `decision.authority`, `current_ac[].untestable_because`, or
// `feature_article.last_executed` exist on decisionSchema/featureArticleSchema yet, so every
// parsed result is cast through `unknown` (the pattern used throughout schemas.test.ts /
// board-objective.test.ts for not-yet-built fields) — the assertions below fail cleanly on
// an AssertionError, never on a package build error.
//
// envelope/validDecision/articleBase are duplicated from schemas.test.ts deliberately:
// importing them from that module would re-execute every test it declares (same rationale
// as board-objective.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decisionSchema, featureArticleSchema, unknownFieldsIn } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function validDecision(extra: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'Use SQLite',
    statement: 'SQLite via node:sqlite is the storage substrate.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no file-key joins, no FTS rank' }],
    rationale: 'Satisfies all six §3.1 criteria with zero native dependencies.',
    file_keys: ['packages/store/src/index.ts'],
    ...extra,
  };
}

function articleBase(currentAc: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as CSV.',
    intended_behavior: 'User clicks Export and receives a CSV file.',
    files: [],
    current_ac: currentAc,
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active' as const,
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...extra,
  };
}

// ===================== SPEC A: decision.authority (board 055cfb6a) =====================

test('A1 (CONTROL, positive): decision.authority accepts each of the three closed-enum values and round-trips (board 055cfb6a)', () => {
  // Establishes FIRST that `authority` is a recognized, round-tripping field once
  // implemented — so A3's refusal of an invalid value below reads as a genuine enum
  // violation, not merely "authority is an unrecognized key" (the same generic cause
  // that would ALSO throw pre-implementation for any value, valid or not).
  for (const value of ['standing', 'session_scoped', 'one_off'] as const) {
    let parsed: { authority?: string } | undefined;
    assert.doesNotThrow(() => {
      parsed = decisionSchema.parse(validDecision({ authority: value })) as unknown as { authority?: string };
    }, `authority:'${value}' must parse`);
    assert.equal(parsed!.authority, value, `authority round-trips verbatim for '${value}'`);
  }
});

test('A2: a decision WITHOUT authority stays valid — backward compatibility, field never invented (board 055cfb6a)', () => {
  const parsed = decisionSchema.parse(validDecision()) as unknown as { authority?: string };
  assert.ok(
    !('authority' in parsed) || parsed.authority === undefined,
    'a decision without authority round-trips unchanged — optional, never defaulted-in, so every pre-existing decision record stays valid'
  );
});

test('A3 (negative): any value outside the closed enum is refused — "permanent" and empty string both (board 055cfb6a)', () => {
  assert.throws(
    () => decisionSchema.parse(validDecision({ authority: 'permanent' })),
    /invalid/i,
    'authority:"permanent" is outside {standing, session_scoped, one_off} and must be refused as an enum violation'
  );
  assert.throws(
    () => decisionSchema.parse(validDecision({ authority: '' })),
    /invalid/i,
    'an empty-string authority is refused the same way — the enum is closed, not "non-empty string"'
  );
});

test('A4: unknownFieldsIn (the real write-boundary refusal surface, records.ts:1034) is unchanged for unrelated fields, and now knows authority (board 055cfb6a)', () => {
  // decisionSchema.parse() itself is NOT strict — zod silently strips unrecognized keys.
  // The misfiled-field refusal knowledgeCreate/knowledgeUpdate rely on lives in
  // unknownFieldsIn(type, candidate), not in schema.parse(). Pin that real surface.
  const unrelated = unknownFieldsIn('decision', validDecision({ totally_unrelated_bogus_field: 'x' })) as unknown as string[];
  assert.ok(
    unrelated.includes('totally_unrelated_bogus_field'),
    'an unrelated unknown field is still surfaced by unknownFieldsIn — the write-boundary discipline is intact'
  );

  const withAuthority = unknownFieldsIn('decision', validDecision({ authority: 'standing' })) as unknown as string[];
  assert.ok(
    !withAuthority.includes('authority'),
    "authority must NOT be reported as unknown once added — it is a real field of decision, known at the write boundary (guards that the addition landed in unknownFieldsIn's derived known-fields set, which zod's silent-strip parse behavior would otherwise hide)"
  );
});

// ===================== SPEC B(a): current_ac[].untestable_because (board 6a8507f8) =====================

test('B1 (CONTROL, positive): current_ac[].untestable_because {reason, blocking_record_id} parses and round-trips (board 6a8507f8)', () => {
  // Establishes FIRST that `untestable_because` is a recognized, round-tripping shape once
  // implemented — so B3's refusals below read as genuine content validation, not merely
  // "untestable_because is an unrecognized key" (the same generic cause that would ALSO
  // throw pre-implementation for every shape below, malformed or not).
  const blockingId = randomUUID();
  const article = articleBase([
    {
      ac_id: 'AC1',
      text: 'export downloads a file',
      verifiable_at: 'final',
      untestable_because: { reason: 'no harness can drive a real browser download — ruled out by decision 2176748e-72f6-4cfc-a790-7fd67c7ee6aa', blocking_record_id: blockingId },
    },
  ]);
  let parsed: { current_ac: { untestable_because?: { reason: string; blocking_record_id: string } }[] } | undefined;
  assert.doesNotThrow(() => {
    parsed = featureArticleSchema.parse(article) as unknown as typeof parsed;
  }, 'a current_ac item carrying a well-formed untestable_because must parse');
  assert.ok(parsed!.current_ac[0].untestable_because, 'untestable_because survives parsing');
  assert.equal(parsed!.current_ac[0].untestable_because!.reason, 'no harness can drive a real browser download — ruled out by decision 2176748e-72f6-4cfc-a790-7fd67c7ee6aa');
  assert.equal(parsed!.current_ac[0].untestable_because!.blocking_record_id, blockingId);
});

test('B2: current_ac items WITHOUT untestable_because stay valid — every pre-existing article round-trips (board 6a8507f8)', () => {
  const article = articleBase([{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }]);
  const parsed = featureArticleSchema.parse(article) as unknown as { current_ac: { untestable_because?: unknown }[] };
  assert.ok(
    !('untestable_because' in parsed.current_ac[0]) || parsed.current_ac[0].untestable_because === undefined,
    'a current_ac item without untestable_because round-trips unchanged — optional, never invented'
  );
});

test('B3 (negative): malformed untestable_because shapes are each refused (board 6a8507f8)', () => {
  const blockingId = randomUUID();

  // empty reason
  assert.throws(
    () =>
      featureArticleSchema.parse(
        articleBase([{ ac_id: 'AC1', text: 't', verifiable_at: 'final', untestable_because: { reason: '', blocking_record_id: blockingId } }])
      ),
    /at least 1 character/,
    'an empty reason must be refused — non-empty string is required'
  );

  // non-uuid blocking_record_id
  assert.throws(
    () =>
      featureArticleSchema.parse(
        articleBase([{ ac_id: 'AC1', text: 't', verifiable_at: 'final', untestable_because: { reason: 'ruled out', blocking_record_id: 'not-a-uuid' } }])
      ),
    /invalid/i,
    'a non-uuid blocking_record_id must be refused'
  );

  // missing reason (blocking_record_id only)
  assert.throws(
    () =>
      featureArticleSchema.parse(
        articleBase([{ ac_id: 'AC1', text: 't', verifiable_at: 'final', untestable_because: { blocking_record_id: blockingId } }])
      ),
    /required/i,
    'reason is required when untestable_because is present'
  );

  // missing blocking_record_id (reason only)
  assert.throws(
    () =>
      featureArticleSchema.parse(
        articleBase([{ ac_id: 'AC1', text: 't', verifiable_at: 'final', untestable_because: { reason: 'ruled out' } }])
      ),
    /required/i,
    'blocking_record_id is required when untestable_because is present'
  );

  // extra member
  assert.throws(
    () =>
      featureArticleSchema.parse(
        articleBase([
          {
            ac_id: 'AC1',
            text: 't',
            verifiable_at: 'final',
            untestable_because: { reason: 'ruled out', blocking_record_id: blockingId, extra_field: 'nope' },
          },
        ])
      ),
    /unrecognized key/i,
    'an extra member on untestable_because is refused — {reason, blocking_record_id} only'
  );
});

// ===================== SPEC B(b): feature_article.last_executed (board 6a8507f8) =====================

test('B4 (positive): feature_article.last_executed accepts an ISO date-time string and round-trips (board 6a8507f8)', () => {
  let parsed: { last_executed?: string } | undefined;
  assert.doesNotThrow(() => {
    parsed = featureArticleSchema.parse(
      articleBase([{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }], { last_executed: NOW })
    ) as unknown as { last_executed?: string };
  }, 'last_executed:<ISO datetime> must parse');
  assert.equal(parsed!.last_executed, NOW, 'last_executed round-trips verbatim');
});

test('B5: feature_article WITHOUT last_executed stays valid — backward compatibility, field never invented (board 6a8507f8)', () => {
  const article = articleBase([{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }]);
  const parsed = featureArticleSchema.parse(article) as unknown as { last_executed?: string };
  assert.ok(
    !('last_executed' in parsed) || parsed.last_executed === undefined,
    'an article without last_executed round-trips unchanged — optional, never defaulted-in'
  );
});

test('B6 (negative): last_executed rejects a bare date and an unparseable string — it is a date-TIME, not a date (board 6a8507f8)', () => {
  const base = [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }];
  assert.throws(
    () => featureArticleSchema.parse(articleBase(base, { last_executed: '2026-08-21' })),
    /invalid/i,
    'a bare YYYY-MM-DD date (no time component) must be refused as last_executed — it is not the same shape as source_date/capture_date'
  );
  assert.throws(
    () => featureArticleSchema.parse(articleBase(base, { last_executed: 'not-a-date' })),
    /invalid/i,
    'an unparseable string must be refused'
  );
});
