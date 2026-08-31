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
      'ungoverned',
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

test('AC-d: knowledge_preflight — subject text matching nothing in an empty store answers ungoverned with no matches', () => {
  const { tools, cleanup } = harness();
  try {
    // No records created at all — this text has ample extractable vocabulary
    // (well above the 2-term floor) but nothing in the store can govern it.
    const result = preflight(
      tools,
      'Refactor the vector interpolation code in the physics module for better numerical stability.'
    );
    assert.equal(result.answerability, 'ungoverned', 'nothing in the store governs this subject');
    assert.deepEqual(result.matches, []);
  } finally {
    cleanup();
  }
});

test('coverage (board 39c3d762): a feature_article-governed subject answers verify_targets, never a false ungoverned', () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('feature_article', {
      slug: 'quaternion-interpolation',
      title: 'Quaternion interpolation — slerp pipeline for the camera rig',
      what_it_does: 'Owns the slerp math.',
      intended_behavior: 'Smooth camera transitions.',
      files: [{ path: 'src/quat.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: new Date().toISOString(), event: 'seed' }],
      live_test_refs: [],
    });
    const result = preflight(
      tools,
      'Design the quaternion interpolation change: the slerp pipeline for the camera rig needs quaternion interpolation smoothing.'
    );
    assert.equal(result.answerability, 'verify_targets', 'an article now governs — the old decision+anti_pattern-only scope answered a false ungoverned here');
    assert.equal(result.matches[0].type, 'feature_article');
    assert.match(result.matches[0].title, /Quaternion interpolation/);
  } finally {
    cleanup();
  }
});

test('batch (board 39c3d762 slice 2): an agenda returns one verdict row per question, in order', () => {
  const { tools, cleanup } = harness();
  try {
    seedCentralAntiPattern(tools);
    const { verdicts } = (tools as unknown as {
      knowledgePreflightBatch: (texts: string[]) => { verdicts: { text: string; answerability: string }[] };
    }).knowledgePreflightBatch([
      'the a of',
      'Refactor the vector interpolation code in the physics module for better numerical stability.',
    ]);
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0].answerability, 'insufficient');
    assert.equal(verdicts[1].answerability, 'ungoverned');
    assert.match(verdicts[1].text, /vector interpolation/, 'each row carries its question back');
    assert.throws(
      () =>
        (tools as unknown as { knowledgePreflightBatch: (t: string[]) => unknown }).knowledgePreflightBatch([]),
      /non-empty array/
    );
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
    // No anti-patterns were ever created in this fresh store.
    const zero = tools.knowledgeQueryResult({ types: ['anti_pattern'] }) as unknown as {
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

// --- H23 regression pins: a ruling's transferable principle is unretrievable by its
// own subject when the record's body is dominated by the incident that justified it
// (knowledge_get 5f3e0a42, reproducing decision e9387b85 / research_finding 79942bda's
// SHAPE — never their real ids/content, which would rot and would bind this test to
// production data). Every fixture below is synthetic, seeded fresh per test. This file
// was authored spec-only, blind to any fix: no scoring/centrality internals were read.

const PRINCIPLE_TITLE =
  'Visual render artifact commits require human attestation — attestation is the check no automated test can replace';
const PRINCIPLE_STATEMENT =
  'Any commit that touches visual or render artifacts requires a human attestation at the authority boundary, ' +
  'because no automated test can verify visual correctness.';
const PRINCIPLE_QUESTION =
  'Should Sterling require a human attestation before a commit touching visual or render artifacts that no automated test can verify?';

// Deliberately shares NO word with PRINCIPLE_* above — exists only to dilute, exactly
// as e9387b85's ~2000 words of H17 revert mechanics diluted its own title's 'attestation'.
const INCIDENT_SENTENCE =
  'The h17 bash write sweep hardened the hook bundle against a hardlink-safe stamp producer path, adding an ' +
  'allowlist admission gate before the esbuild bundle staged into mkdtemp, then the revert cleared the ' +
  'enforcement latch and tripwire consumer taint clearer. ';
// 20 repeats ~= 5300+ characters of pure incident vocabulary — "several thousand
// characters" dominated by unrelated words, per the measured defect's shape.
const INCIDENT_BODY = INCIDENT_SENTENCE.repeat(20);

// CORRECTED (this session, see AC1 below): the matcher's narrow text for a
// `decision` record is `title + statement` only — `rationale` is excluded
// entirely (field mapping confirmed via decision 00b23915, which cites
// axis.ts:97; cited rather than read — H4 forbids reading axis.ts itself
// from this role, field mapping only). The ORIGINAL shape of this fixture
// put INCIDENT_BODY in `rationale`, a field the matcher never looks at, so
// the record's narrow text was just title + PRINCIPLE_STATEMENT (~300
// chars) in BOTH the pre-fix and post-fix code paths — nothing was ever
// diluted, the measured defect was never reproduced, and AC1 passed
// vacuously on baseline. The dilution must live in `statement` itself,
// which is what actually happened to the real record (00b23915: "narrow_text
// = 4285 chars (title 178 + statement 4106)").
function seedDilutedPrincipleDecision(tools: SterlingTools) {
  return tools.knowledgeCreate('decision', {
    title: PRINCIPLE_TITLE,
    statement: `${PRINCIPLE_STATEMENT} ${INCIDENT_BODY}`,
    alternatives_rejected: [],
    rationale:
      'See the H17 bash write sweep incident record for full mechanical detail; kept out of the narrow-text ' +
      'fields deliberately, so this fixture does not also (accidentally) depend on rationale ever being scored.',
  }).record;
}

function seedFocusedPrincipleDecision(tools: SterlingTools) {
  return tools.knowledgeCreate('decision', {
    title: PRINCIPLE_TITLE,
    statement: PRINCIPLE_STATEMENT,
    alternatives_rejected: [],
    rationale:
      'A human attestation is the only mechanism that can verify visual correctness; automated tests cannot ' +
      'render-check pixels, so the authority boundary requires this attestation on every visual commit.',
  }).record;
}

test(
  'AC1 (core pin): a decision whose TITLE states the principle in plain subject vocabulary, but whose ' +
    'STATEMENT is dominated by thousands of characters of unrelated incident vocabulary, is still returned ' +
    'for a plain-language question about the principle',
  () => {
    const { tools, cleanup } = harness();
    try {
      const record = seedDilutedPrincipleDecision(tools);
      const result = preflight(tools, PRINCIPLE_QUESTION);
      assert.equal(
        result.answerability,
        'verify_targets',
        'the store DOES govern this subject via the diluted record — a false "ungoverned" here reproduces the measured defect (knowledge_get 5f3e0a42)'
      );
      assert.equal(result.matches.length, 1, 'exactly the one diluted decision seeded in this store should surface');
      assert.equal(result.matches[0]?.id, record.id);
      assert.equal(result.matches[0]?.type, 'decision');
      assert.equal(result.matches[0]?.title, PRINCIPLE_TITLE);
    } finally {
      cleanup();
    }
  }
);

// Genuine control (post-repair): seedFocusedPrincipleDecision's `statement` is the short
// PRINCIPLE_STATEMENT alone — no INCIDENT_BODY anywhere in title+statement — while
// seedDilutedPrincipleDecision's `statement` is now PRINCIPLE_STATEMENT+INCIDENT_BODY. The two
// fixtures diverge exactly in the field the matcher reads (statement length), which is what a
// dilution control requires. Before the repair they were identical in narrow text (both diluted
// only rationale, which the matcher never reads) — AC1 and AC2 were the same test.
test(
  'AC2 (dilution control, must already pass): the SAME title/principle with a SHORT, undiluted statement is ' +
    'returned by the IDENTICAL question — isolates body-dilution, not vocabulary, as the cause of AC1',
  () => {
    const { tools, cleanup } = harness();
    try {
      const record = seedFocusedPrincipleDecision(tools);
      const result = preflight(tools, PRINCIPLE_QUESTION);
      assert.equal(
        result.answerability,
        'verify_targets',
        'an undiluted record sharing the identical title/principle must already be governed today'
      );
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.id, record.id);
      assert.equal(result.matches[0]?.title, PRINCIPLE_TITLE);
    } finally {
      cleanup();
    }
  }
);

// NOTE on scope (checked this session, not fixed): a research_finding's narrow text is `question`
// ONLY — slug and answer are both excluded (confirmed via decision 00b23915, which cites axis.ts:99;
// field mapping cited, axis.ts itself not read by this role per H4). The same decision states the
// title-union arm's "title-ish" text for research_finding is ALSO just `question`. So narrowText ===
// titleishText for this type, always — the union is a mathematical no-op and NO fixture, however the
// vocabulary is arranged, can make a research_finding diverge between pre-fix and post-fix behavior.
// This test cannot be repaired into a title-union pin; it is left as what it actually is below — a
// sound, narrower claim that research_finding participates in preflight's queried candidate set at
// all — and is expected to PASS identically before and after the title-union change.
test(
  'AC3: a research_finding whose slug/question states the principle plainly is returned by preflight — pins ' +
    'that research_finding is genuinely in the queried candidate set',
  () => {
    const { tools, cleanup } = harness();
    try {
      const record = tools.knowledgeCreate('research_finding', {
        slug: 'human-attestation-required-at-authority-boundary-automation-cannot-verify',
        question: PRINCIPLE_QUESTION,
        answer:
          'A human attestation is the only mechanism that can verify visual correctness at the authority ' +
          'boundary; automated tests cannot check rendered pixels.',
        source_date: '2026-08-10',
        capture_date: '2026-08-10',
      }).record;
      const result = preflight(tools, PRINCIPLE_QUESTION);
      assert.equal(result.matches.length, 1, 'the seeded research_finding is the only record in this store');
      assert.equal(result.matches[0]?.id, record.id);
      assert.equal(result.matches[0]?.type, 'research_finding');
      assert.equal(result.answerability, 'verify_targets');
    } finally {
      cleanup();
    }
  }
);

const REVIEW_TITLE =
  'Merge gate requires an independent review trailer — a review trailer is the only proof self-verification cannot fake';
const REVIEW_QUESTION =
  'Does Sterling require an independent review trailer before a commit merges, since self-verification does not count as independent proof?';

// NOTE on scope (checked this session, not fixed): REVIEW_TITLE/statement/rationale all state the
// principle directly in title+statement with no dilution attempted (narrow text stays well under
// ~300 chars) — this exercises the fields the matcher reads (title+statement for a decision) but
// does not exercise the title-union defect at all, since there is nothing here for a long body to
// crowd out. Expected to PASS identically before and after the title-union change; it pins the
// answerability-string contract (never a bare "not ungoverned"), not the dilution fix.
test('AC4 (answerability pin): a governed question answers the EXACT string "verify_targets", never "ungoverned"', () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('decision', {
      title: REVIEW_TITLE,
      statement:
        'Every code-touching commit must carry an independent review trailer before it merges, because ' +
        'self-verification never counts as independent proof.',
      alternatives_rejected: [],
      rationale:
        'A review trailer is the only mechanical evidence that an independent reviewer checked the diff; ' +
        'without it, self-verification could silently stand in for review.',
    });
    const result = preflight(tools, REVIEW_QUESTION);
    assert.notEqual(
      result.answerability,
      'ungoverned',
      'a false "ungoverned" reads as a positive assurance that nothing governs the subject'
    );
    assert.equal(result.answerability, 'verify_targets');
  } finally {
    cleanup();
  }
});

// Unaffected by the AC1 repair: this test's premise is that the query shares NO vocabulary with
// either seeded decision, diluted or not, so which field the incident vocabulary lives in is
// irrelevant here — the daylight-saving/log-timestamp query overlaps with neither record's content
// words regardless. Expected to PASS identically before and after.
test(
  'AC5 (negative control, must already pass): a subject the store genuinely does not govern still answers ' +
    '"ungoverned" with no matches, even with unrelated records present in the store — the arm a blanket ' +
    'threshold drop must break',
  () => {
    const { tools, cleanup } = harness();
    try {
      seedDilutedPrincipleDecision(tools);
      seedFocusedPrincipleDecision(tools);
      const result = preflight(
        tools,
        'How should the terminal interface handle daylight saving clock shifts when formatting log timestamps for the maintenance queue view?'
      );
      assert.equal(result.answerability, 'ungoverned');
      assert.deepEqual(result.matches, []);
    } finally {
      cleanup();
    }
  }
);
