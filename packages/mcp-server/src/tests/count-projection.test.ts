// Spec for: count-only query projection (board fa19524d — absence semantics on
// capped results).
//
// Background (from the brief): a capped knowledge_query window cannot establish
// absence — "does the store hold X?" is unanswerable once more records match
// than the cap shows. The store already exposes an uncapped count() used by H1.
// This file specifies knowledge_query({ ..., projection: 'count' }): the caller
// gets the TRUE total for the filter, never a records payload, and never a cap
// truncation — because a count is not a window, it is the whole answer.
//
// Idiom source: packages/mcp-server/src/tests/tools.test.ts — harness(), the
// knowledgeQueryResult envelope ({ records, returned, matched_filter, cap,
// capped, note }), and the existing digest/full projection tests this file's
// AC4 regresses against. Only that test file was read; no implementation
// source was read to write these tests (H4).
//
// ENVELOPE-KEY ASSUMPTIONS (pin these — they are guesses, not confirmed
// interface, because 'count' projection does not exist in the declared
// envelope yet):
//   - AC1/AC3: a count projection reuses the EXISTING `matched_filter` number
//     as the true total, sets `records` to an empty array, and `capped` to
//     false (a count is defined as never-capped — it does not enumerate).
//   - AC2: per-type counts are assumed to ride a NEW envelope key `by_type`,
//     shaped `Record<string, number>` (e.g. { decision: 250, anti_pattern: 3 }).
//     If the implementation lands under a different key, THIS assumption is
//     what should move, not the AC2 behavior it specifies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-count-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

test("AC1: projection:'count' returns the TRUE total past the default cap, with no records and capped:false", () => {
  const { tools, cleanup } = harness();
  try {
    // 250 decisions — comfortably past any plausible default cap (the existing
    // suite's caps top out at 1000 for maintenance and 50 for knowledge_query
    // digest smoke tests; 250 forces the point without hardcoding the default).
    for (let i = 0; i < 250; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }

    const result = tools.knowledgeQueryResult({ types: ['decision'], projection: 'count' }) as unknown as {
      matched_filter: number;
      records: unknown[];
      capped: boolean;
      returned: number;
    };

    assert.equal(result.matched_filter, 250, 'a count answers the real question: the TRUE total, not a window into it');
    assert.deepEqual(result.records ?? [], [], 'no record bodies ride a count projection — that is the entire point');
    assert.equal(result.capped, false, 'a count is never capped — it counts the WHOLE filtered set by definition');
  } finally {
    cleanup();
  }
});

test("AC2: projection:'count' splits by type when multiple types are queried, alongside the total", () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }
    for (let i = 0; i < 3; i++) {
      tools.knowledgeCreate('anti_pattern', {
        title: `AP${i}`,
        trigger: 't',
        guidance: 'g',
        wrong_way: 'w',
        right_way: 'r',
        source_evidence: 'e',
        severity: 'warn',
      });
    }

    const result = tools.knowledgeQueryResult({ types: ['decision', 'anti_pattern'], projection: 'count' }) as unknown as {
      matched_filter: number;
      records: unknown[];
      // ASSUMED key — see file header. If the real envelope names this field
      // differently, this is the line to update; the assertion below is the
      // behavior spec (per-type split + total), not the key name.
      by_type?: Record<string, number>;
    };

    assert.equal(result.matched_filter, 8, 'the total spans every queried type');
    assert.deepEqual(result.records ?? [], [], 'still no record bodies — a count stays a count across multiple types');
    assert.ok(result.by_type, 'a per-type breakdown must be present when multiple types are queried (ASSUMED envelope key: by_type)');
    assert.equal(result.by_type?.decision, 5, 'decision count isolated from the total');
    assert.equal(result.by_type?.anti_pattern, 3, 'anti_pattern count isolated from the total');
  } finally {
    cleanup();
  }
});

test("AC3: file_keys filtering composes with projection:'count' — the count is of the FILTERED set, not the type-wide set", () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('decision', { title: 'touches x', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src/x.ts'] });
    tools.knowledgeCreate('decision', { title: 'touches x too', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src/x.ts'] });
    tools.knowledgeCreate('decision', { title: 'touches y only', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src/y.ts'] });

    const filtered = tools.knowledgeQueryResult({ types: ['decision'], file_keys: ['src/x.ts'], projection: 'count' }) as unknown as {
      matched_filter: number;
      records: unknown[];
    };
    assert.equal(filtered.matched_filter, 2, 'count composes with file_keys — exactly the records carrying src/x.ts');
    assert.deepEqual(filtered.records ?? [], [], 'no bodies even with a narrowing filter applied');

    // sanity: the unfiltered count for the same type is the full 3, proving the
    // file_keys filter actually narrowed rather than the count always being 2.
    const unfiltered = tools.knowledgeQueryResult({ types: ['decision'], projection: 'count' }) as unknown as { matched_filter: number };
    assert.equal(unfiltered.matched_filter, 3, 'without file_keys, the count is the full type-wide total');
  } finally {
    cleanup();
  }
});

test('AC4 (regression): default projection and \'digest\' are unchanged — records present, cap honored', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }

    // default ('full') projection: records are actually served, and a cap
    // narrower than the matched set is honored (returned === cap).
    const defaultResult = tools.knowledgeQueryResult({ types: ['decision'], cap: 3 });
    assert.equal(defaultResult.returned, 3, 'default projection still honors the cap on returned records');
    assert.equal((defaultResult.records[0] as unknown as { statement: string }).statement, 'S', 'default projection still carries record bodies');

    // 'digest' projection: records present (digested), cap honored, no bodies.
    const digestResult = tools.knowledgeQueryResult({ types: ['decision'], cap: 3, projection: 'digest' });
    assert.equal(digestResult.returned, 3, 'digest projection still honors the cap on returned records');
    assert.ok(!('statement' in (digestResult.records[0] as unknown as Record<string, unknown>)), 'digest still omits the body — unchanged by the new count projection');
  } finally {
    cleanup();
  }
});
