// H20/H19 relevance slice 4 (board 5fac3459): a NEW MCP tool, knowledge_preflight,
// lets the conductor ask "does the store govern this subject?" BEFORE dispatching,
// reusing the same axis-extraction + stage-2 centrality floors H20 already applies
// at delivery time (scripts/hooks/lib/delivery.mjs), but surfaced as a directly
// callable tool over anti_pattern + decision records instead of a passive hook.
//
// Per the slice spec: "do not import hook files in your tests, assert through the
// tool's MCP result only" — every assertion here goes through SterlingTools'
// knowledgePreflight(text) / knowledgeQueryResult(...) return values, never
// through the extractor or centrality helper directly.
//
// knowledgePreflight does not exist on SterlingTools yet, and the `answerability`
// field does not exist on the knowledge_query envelope yet — both are red by
// construction. Property access is cast through `any`/`unknown` so the file
// still COMPILES (TypeScript would otherwise refuse to build the whole package
// over a single missing method, hiding every other test in this slice), but each
// call/assert below fails on its own at runtime: a missing method fails on
// invocation ("... is not a function"), a missing envelope field fails on its
// own assert.equal(undefined, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-preflight-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type PreflightResult = {
  answerability: string;
  reason?: string;
  terms: string[];
  matches: { id: string; type: string; title: string; matched_on: string[]; central: string[] }[];
};

function preflight(tools: SterlingTools, text: string): PreflightResult {
  // knowledgePreflight does not exist yet — `any` lets this compile now and
  // throw "not a function" at call time until it is added (mirrors the
  // dynamic-import-undefined trick scripts/tests/h20-centrality.test.mjs uses
  // for the same reason: one missing symbol must not crash unrelated tests).
  return (tools as unknown as { knowledgePreflight: (t: string) => PreflightResult }).knowledgePreflight(text);
}

// --- fixture vocabulary -------------------------------------------------
//
// Copied verbatim from scripts/tests/h20-centrality.test.mjs's CENTRAL_TITLE/
// CENTRAL_TRIGGER (not its imports, per the slice spec): six modeling-domain
// words repeated 3x each (title 1x + trigger 2x) so they deterministically
// dominate the record's own top-6 by raw frequency; every other content word
// in the same narrow text (title+trigger) appears exactly once, so none of
// them can crowd into the top-6.
const CENTRAL_TITLE = 'Boolean modifier mesh manifold topology solver stability failure';
const CENTRAL_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
// -> boolean/modifier/mesh/manifold/topology/solver: freq 3 each (title+trigger)
//    recur/constantly/though/bug/rarely/touches/game/field/cell/setup/work: freq 1 each

function seedCentralAntiPattern(tools: SterlingTools) {
  return tools.knowledgeCreate('anti_pattern', {
    title: CENTRAL_TITLE,
    trigger: CENTRAL_TRIGGER,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
  }).record;
}

test('AC-a: knowledge_preflight — text repeating >=2 of a stored record\'s CENTRAL terms answers verify_targets and names the record', () => {
  const { tools, cleanup } = harness();
  try {
    const record = seedCentralAntiPattern(tools);
    const result = preflight(
      tools,
      'Investigate why the boolean operation corrupts the mesh: check whether the modifier ' +
        'stack introduces non-manifold geometry that breaks downstream processing.'
    );
    assert.equal(
      result.answerability,
      'verify_targets',
      'the store governs this subject — verify the brief against these targets before dispatching'
    );
    const match = result.matches.find((m) => m.id === record.id);
    assert.ok(match, 'the dominating anti_pattern record surfaces as a match');
    assert.equal(match!.type, 'anti_pattern');
    assert.equal(match!.title, CENTRAL_TITLE);
    assert.ok(match!.matched_on.length > 0, 'matched_on names the overlapping terms');
    assert.ok(match!.central.length > 0, 'central names the covered central terms');
    assert.ok(
      match!.central.some((t) => /boolean|mesh|modifier/i.test(t)),
      "central terms are drawn from the record's own dominant vocabulary, not just any shared word"
    );
  } finally {
    cleanup();
  }
});

test('AC-b: knowledge_preflight — text hitting only the record\'s PERIPHERAL words answers ready with empty matches (centrality floor)', () => {
  const { tools, cleanup } = harness();
  try {
    seedCentralAntiPattern(tools);
    // Shares every peripheral, freq-1 word (game/field/cell) — enough distinct,
    // non-generic hits to satisfy the OLDER stage-2 floors on their own — but
    // NONE of the six dominant modeling terms. Reconstructs the 2026-08-09
    // Blender false positive at the preflight surface: without the centrality
    // floor this record would wrongly surface as a match.
    const result = preflight(
      tools,
      'Write tests for the game field cell logic: cover the game field cell grid, ' +
        'the field cell adjacency rules, and the game field cell lifecycle events.'
    );
    assert.equal(
      result.answerability,
      'ready',
      "the record's central vocabulary never appears in this text — only its peripheral words do"
    );
    assert.deepEqual(result.matches, [], 'peripheral-only overlap must not surface the record as a target');
  } finally {
    cleanup();
  }
});

test('AC-c: knowledge_preflight — fewer than 2 extractable terms answers insufficient/too_little_vocabulary with no matches', () => {
  const { tools, cleanup } = harness();
  try {
    seedCentralAntiPattern(tools);
    const result = preflight(tools, 'the a of');
    assert.equal(result.answerability, 'insufficient');
    assert.equal(result.reason, 'too_little_vocabulary');
    assert.ok(Array.isArray(result.terms), 'terms carries whatever little vocabulary was extractable');
    assert.deepEqual(result.matches, [], 'insufficient vocabulary never carries matches, even with a record in store');
  } finally {
    cleanup();
  }
});

test('AC-d: knowledge_preflight — subject text matching nothing in an empty store answers ready with no matches', () => {
  const { tools, cleanup } = harness();
  try {
    // No records created at all — this text has ample extractable vocabulary
    // (well above the 2-term floor) but nothing in the store can govern it.
    const result = preflight(
      tools,
      'Refactor the vector interpolation code in the physics module for better numerical stability.'
    );
    assert.equal(result.answerability, 'ready', 'nothing in the store governs this subject');
    assert.deepEqual(result.matches, []);
  } finally {
    cleanup();
  }
});

test('AC-g1: knowledge_query envelope — a capped result answers verify_targets (a window, never an inventory)', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }
    const capped = tools.knowledgeQueryResult({ types: ['decision'], cap: 2 }) as unknown as {
      capped: boolean;
      returned: number;
      answerability?: string;
    };
    assert.equal(capped.capped, true, 'sanity: this window is in fact capped');
    assert.equal(
      capped.answerability,
      'verify_targets',
      'more matched than was returned — never conclude absence from a capped window'
    );
  } finally {
    cleanup();
  }
});

test('AC-g2: knowledge_query envelope — a zero-return result answers insufficient', () => {
  const { tools, cleanup } = harness();
  try {
    // No notes were ever created in this fresh store.
    const zero = tools.knowledgeQueryResult({ types: ['note'] }) as unknown as {
      returned: number;
      answerability?: string;
    };
    assert.equal(zero.returned, 0, 'sanity: nothing came back');
    assert.equal(zero.answerability, 'insufficient', 'an empty result carries no basis to answer from');
  } finally {
    cleanup();
  }
});

test('AC-g3: knowledge_query envelope — a normal, uncapped, non-empty result answers ready; existing fields unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.knowledgeCreate('decision', { title: `D${i}`, statement: 'S', alternatives_rejected: [], rationale: 'R' });
    }
    const normal = tools.knowledgeQueryResult({ types: ['decision'], cap: 50 }) as unknown as {
      returned: number;
      matched_filter: number;
      capped: boolean;
      answerability?: string;
    };
    assert.equal(normal.returned, 5);
    assert.equal(normal.matched_filter, 5, 'existing fields are unchanged by the new answerability field');
    assert.equal(normal.capped, false);
    assert.equal(normal.answerability, 'ready', 'a complete, non-empty window is ready to answer from as-is');
  } finally {
    cleanup();
  }
});
