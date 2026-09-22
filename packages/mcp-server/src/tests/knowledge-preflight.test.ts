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

test(
  'AC-b: knowledge_preflight — text hitting only the record\'s PERIPHERAL words answers ungoverned, but the ' +
    'record now LISTS as a non-central match (B2G: centrality is no longer a listing floor, only an ' +
    'answerability floor)',
  () => {
    const { tools, cleanup } = harness();
    try {
      const record = seedCentralAntiPattern(tools);
      // Shares every peripheral, freq-1 word (game/field/cell) — enough distinct,
      // non-generic hits to satisfy the OLDER stage-2 floors on their own — but
      // NONE of the six dominant modeling terms. Reconstructs the 2026-08-09
      // Blender false positive at the preflight surface: hasRecordCentralityHit
      // still fails on this text, so matched_total/answerability are unaffected
      // by this record — but B2G (findings f6ada94d and
      // preflight-verdict-false-governed-on-hard-negatives-and-b2g-measured-
      // september-2026) widened the LIST itself to include a centrality-failing
      // survivor as a disclosed, non-central candidate rather than hiding it.
      const result = preflight(
        tools,
        'Write tests for the game field cell logic: cover the game field cell grid, ' +
          'the field cell adjacency rules, and the game field cell lifecycle events.'
      ) as unknown as { answerability: string; matched_total: number; matches: { id: string; central: string[] }[] };
      assert.equal(
        result.answerability,
        'ungoverned',
        "the record's central vocabulary never appears in this text — only its peripheral words do, so " +
          'answerability still reads the store as not governing this subject'
      );
      assert.equal(result.matched_total, 0, 'matched_total is still computed from the centrality-passing subset — zero here');
      assert.equal(result.matches.length, 1, 'the peripheral-only survivor now appears in the widened matches list');
      assert.equal(result.matches[0].id, record.id);
      assert.deepEqual(result.matches[0].central, [], "the listed record is explicitly non-central — its central field is empty");
    } finally {
      cleanup();
    }
  }
);

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
// (knowledge_get 5f3e0a42, reproducing decision foreign_e9387b85 / research_finding foreign_79942bda's
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
// entirely (field mapping confirmed via decision foreign_00b23915, which cites
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
// ONLY — slug and answer are both excluded (confirmed via decision foreign_00b23915, which cites axis.ts:99;
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

// --- candidate-sort tie-break pins (decision 17fa1c59, STEP 1): the sort shared by
// knowledgePreflight and the same_subject write suggestions (axisCandidateMatches,
// tools.ts ~:5031-5037) must go hit count desc, then record-centrality hits desc,
// then updated_at desc, then id asc — never fall back to the fixed per-type query
// concatenation order (anti_pattern, decision, feature_article, ...) on a tie
// (measured cause: research_finding a6503bf7, mechanism 4, benchmark cases p-003/p-006).
//
// Fixture math below is verified directly against axisHits/recordCentralityHits
// (packages/store/src/axis.ts), not guessed: a record with <= AXIS_RECORD_TOP_K (6)
// distinct extractable narrow terms has EVERY one of them central (documented "known
// limit" on hasRecordCentralityHit); a record whose narrow text adds >=6 higher-frequency
// filler words crowds its shared terms out of that top-6, leaving only its TITLE-arm
// terms central (decision foreign_00b23915's title-union) — this is what lets two
// fixtures share an equal raw hit count while differing in centrality.
const QUERY_TEXT = 'Quaternion manifold topology geodesic curvature analysis.';
const FILLER_TERMS =
  'vertex vertex vertex lattice lattice lattice tensor tensor tensor scalar scalar scalar ' +
  'vector vector vector matrix matrix matrix';

function seedFeatureArticle(tools: SterlingTools, title: string) {
  return tools.knowledgeCreate('feature_article', {
    slug: 'quaternion-manifold-topology',
    title,
    what_it_does: 'Owns the math.',
    intended_behavior: 'Stable output.',
    files: [{ path: 'src/quat.ts', role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: new Date().toISOString(), event: 'seed' }],
    live_test_refs: [],
  }).record;
}

test(
  'sort pin 1 (centrality, not type order): equal hit counts break by record-centrality hits ' +
    'descending — an article tied with a decision on hits, but with MORE central hits, sorts first',
  () => {
    const { tools, cleanup } = harness();
    try {
      // decision: 4 raw hits (quaternion, manifold, topology, geodesic all present in
      // title+statement) but only 2 are CENTRAL — the statement's six filler words
      // (freq 3 each) crowd topology/geodesic out of the record's own top-6
      // narrow-central set, leaving only quaternion/manifold central via the title arm.
      const decision = tools.knowledgeCreate('decision', {
        title: 'quaternion manifold',
        statement: `${FILLER_TERMS} topology geodesic`,
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      // feature_article: same 4 raw hits, but its narrow text (slug+family+title) is
      // small enough that all 4 are automatically central.
      const article = seedFeatureArticle(tools, 'quaternion manifold topology geodesic');
      const result = preflight(tools, QUERY_TEXT);
      assert.equal(result.matches.length, 2, 'both the decision and the article qualify as candidates');
      assert.equal(
        result.matches[0].id,
        article.id,
        'equal hits (4=4): the article, with MORE central hits (4 vs 2), sorts first — the fixed type ' +
          'order (anti_pattern, decision, feature_article, ...) would have put the decision first on this tie'
      );
      assert.equal(result.matches[1].id, decision.id);
    } finally {
      cleanup();
    }
  }
);

test(
  'sort pin 2 (recency, not type order): equal hits AND equal centrality break by updated_at ' +
    'descending — the more recently updated record sorts first regardless of type',
  () => {
    const { store, cleanup } = harness();
    try {
      const OLDER = '2026-08-01T00:00:00.000Z';
      const NEWER = '2026-09-01T00:00:00.000Z';
      const olderTools = new SterlingTools({ store, now: () => OLDER });
      const newerTools = new SterlingTools({ store, now: () => NEWER });
      // decision is earlier than feature_article in axisCandidateMatches' fixed
      // per-type query order — under the old hit-count-only sort, a tie would fall
      // to that concatenation order and the OLDER decision would wrongly win.
      const decision = olderTools.knowledgeCreate('decision', {
        title: 'quaternion manifold topology geodesic',
        statement: 'Quaternion manifold topology geodesic rule.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const article = seedFeatureArticle(newerTools, 'quaternion manifold topology geodesic');
      const result = preflight(newerTools, QUERY_TEXT);
      assert.equal(result.matches.length, 2);
      assert.equal(
        result.matches[0].id,
        article.id,
        'equal hits (4=4) and equal centrality (4=4): the more recently updated record (the article) ' +
          'sorts first, even though it is LATER in the fixed per-type concatenation order'
      );
      assert.equal(result.matches[1].id, decision.id);
    } finally {
      cleanup();
    }
  }
);

test(
  // REWRITTEN (B2G, decision quoted in this session's brief: "sort the list by
  // centrality hit count DESC, then hits DESC"): knowledgePreflight's OWN
  // sort key order flipped from hits-primary/centrality-secondary to
  // centrality-primary/hits-secondary — the old title/assertion here
  // ("primary key unchanged: more raw hits still outranks fewer hits with
  // higher centrality") pinned exactly the contract this change reverses for
  // knowledgePreflight. axisCandidateMatches' OWN internal sort (still used
  // unchanged by sameSubjectDigest / same_subject) stays hits-primary — see
  // same-subject-surfacing.test.ts, which this file's fixtures never touch.
  'sort pin 3 (B2G: centrality is now the PRIMARY sort key for knowledge_preflight): fewer raw hits with ' +
    'higher centrality now outranks more raw hits with lower centrality',
  () => {
    const { tools, cleanup } = harness();
    try {
      // anti_pattern: 5 raw hits (quaternion, curvature, geodesic, manifold, topology)
      // but only 2 are central — the filler-diluted trigger crowds the rest out of
      // its own top-6 narrow-central set.
      const moreHits = tools.knowledgeCreate('anti_pattern', {
        title: 'quaternion manifold',
        trigger: `topology geodesic curvature ${FILLER_TERMS} topology geodesic`,
        guidance: 'guidance',
        wrong_way: 'wrong way',
        right_way: 'right way text',
        source_evidence: 'evidence',
      }).record;
      // decision: only 3 raw hits (quaternion, manifold, topology) but ALL 3 are
      // central (small, undiluted narrow text).
      const moreCentral = tools.knowledgeCreate('decision', {
        title: 'quaternion manifold topology',
        statement: 'Rule applies always.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const result = preflight(tools, QUERY_TEXT);
      assert.equal(result.matches.length, 2);
      assert.equal(
        result.matches[0].id,
        moreCentral.id,
        'centrality hit count is now the PRIMARY sort key: the 3-hit decision, with MORE central hits ' +
          '(3 vs 2), now sorts ahead of the 5-hit anti_pattern'
      );
      assert.equal(result.matches[1].id, moreHits.id);
    } finally {
      cleanup();
    }
  }
);

test(
  'sort pin 4 (updated_at compared numerically, not lexicographically — cross-family review MEDIUM finding): ' +
    'equal hits and equal centrality, updated_at values differing ONLY in fractional-second precision — the ' +
    'string-larger-but-epoch-older record must NOT win',
  () => {
    const { store, cleanup } = harness();
    try {
      // z.string().datetime() (packages/schemas/src/envelope.ts) permits variable
      // UTC precision, so both of these are schema-valid — but '...:00Z' sorts
      // AFTER '...:00.001Z' lexicographically ('Z' > '.' at that byte) even
      // though '...:00.001Z' is 1ms LATER in real time (Date.parse difference
      // verified: 1767261600000 vs 1767261600001). A lexicographic compare picks
      // the wrong record; a numeric epoch compare does not.
      const STRING_LARGER_BUT_OLDER = '2026-01-01T10:00:00Z';
      const STRING_SMALLER_BUT_NEWER = '2026-01-01T10:00:00.001Z';
      const olderEpochTools = new SterlingTools({ store, now: () => STRING_LARGER_BUT_OLDER });
      const newerEpochTools = new SterlingTools({ store, now: () => STRING_SMALLER_BUT_NEWER });
      const decision = olderEpochTools.knowledgeCreate('decision', {
        title: 'quaternion manifold topology geodesic',
        statement: 'Quaternion manifold topology geodesic rule.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const article = seedFeatureArticle(newerEpochTools, 'quaternion manifold topology geodesic');
      const result = preflight(newerEpochTools, QUERY_TEXT);
      assert.equal(result.matches.length, 2);
      assert.equal(
        result.matches[0].id,
        article.id,
        "equal hits (4=4) and equal centrality (4=4): the article's updated_at (...:00.001Z) is 1ms LATER " +
          "by epoch than the decision's (...:00Z), even though the decision's string sorts lexicographically " +
          'larger — the article must sort first'
      );
      assert.equal(result.matches[1].id, decision.id);
    } finally {
      cleanup();
    }
  }
);

// --- V4 one-hit minimum pins (measured 2026-09-21, research findings on the
// preflight-floor counterfactual and its validation): knowledgePreflight now
// admits a candidate on ONE matched term once hasDiscriminatingHit and
// hasRecordCentralityHit both already pass — sameSubjectDigest (the write-time
// same_subject surface, pinned separately in same-subject-surfacing.test.ts)
// keeps the AXIS_MIN_HITS=2 floor unchanged. The centrality pass below relies
// on the SAME prefix quirk the validation finding documents for p-009: a
// record narrow text containing both an inflected pair ('manifold' /
// 'manifolds') as separate top-K central terms lets one query word cover both
// via symmetric prefix matching, so hasRecordCentralityHit's minTerms=2 floor
// is satisfied even though axisHits only ever counts ONE distinct matched term.

test(
  'AC-h1 (V4 one-hit): a record whose single shared term is discriminating and passes centrality is now returned — previously excluded by the two-hit floor',
  () => {
    const { tools, cleanup } = harness();
    try {
      const record = tools.knowledgeCreate('anti_pattern', {
        title: 'Manifold subsystem',
        trigger:
          'manifold manifold manifold manifolds manifolds manifolds other padding words here to fill space and avoid collision',
        guidance: 'guidance',
        wrong_way: 'wrong way',
        right_way: 'right way text',
        source_evidence: 'evidence',
      }).record;
      const result = preflight(
        tools,
        'Investigate the manifold behavior during unrelated deployment scheduling review.'
      );
      assert.equal(
        result.answerability,
        'verify_targets',
        'a single discriminating, central hit is now sufficient to qualify a candidate'
      );
      const match = result.matches.find((m) => m.id === record.id);
      assert.ok(match, 'the one-hit record surfaces as a match');
      assert.deepEqual(match!.matched_on, ['manifold'], 'exactly one matched term, not two');
    } finally {
      cleanup();
    }
  }
);

test(
  'AC-h2 (discriminating floor still applies, centrality genuinely passes): a record whose only hit is a GENERIC dev term is NOT returned, even though that same hit already clears centrality — the discriminating floor alone must be what blocks it',
  () => {
    const { tools, cleanup } = harness();
    try {
      // REBUILT (fix round, cross-family review HIGH finding): the prior
      // fixture failed hasRecordCentralityHit too (the query covered only
      // one central term), so it stayed 'ungoverned' even with the
      // discriminating floor stubbed out — a hollow proof. Repeats BOTH
      // 'test' and 'tests' (mirroring the p-009 quirk documented in the
      // validation finding) so the single query word 'test' symmetric-prefix
      // covers two central terms ('test', 'tests') and centrality passes
      // GENUINELY on its own — see the single-protection proof below.
      tools.knowledgeCreate('anti_pattern', {
        title: 'Xylophone resonance study',
        trigger:
          'test test test tests tests tests padding filler placeholder more random content here',
        guidance: 'guidance',
        wrong_way: 'wrong way',
        right_way: 'right way text',
        source_evidence: 'evidence',
      });
      const query = 'Please test the widget before shipping it forward for review.';
      // Fixture guard (kept blind to the centrality helper, per this file's
      // own spec: assert through knowledgePreflight's own result only): AC-a
      // above already pins that this store returns 'verify_targets' whenever
      // centrality genuinely passes on a record's dominant vocabulary; the
      // single-protection proof that THIS fixture's centrality independently
      // passes on 'test'/'tests' was run out-of-band against a temporarily
      // neutralized discriminating check (fix-round session evidence) rather
      // than baked in here as a direct import of the centrality helper.
      const result = preflight(tools, query);
      assert.equal(
        result.answerability,
        'ungoverned',
        "a lone GENERIC hit ('test') is still rejected by hasDiscriminatingHit even though centrality independently passes"
      );
      assert.deepEqual(result.matches, []);
    } finally {
      cleanup();
    }
  }
);

test(
  'AC-h3 (centrality floor still applies to answerability; B2G widens the LIST): a record whose only hit is a ' +
    'discriminating but PERIPHERAL term still answers ungoverned, but now lists as a non-central match',
  () => {
    const { tools, cleanup } = harness();
    try {
      // Single-protection fixture (confirmed genuine, fix-round session
      // evidence): 'gizmo' independently clears hasDiscriminatingHit (it is
      // not in GENERIC_DEV_TERMS) — only hasRecordCentralityHit rejects it,
      // since 'gizmo' never appears among the record's top-K central terms.
      const record = tools.knowledgeCreate('anti_pattern', {
        title: 'Boolean modifier mesh manifold topology solver',
        trigger:
          'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver gizmo',
        guidance: 'guidance',
        wrong_way: 'wrong way',
        right_way: 'right way text',
        source_evidence: 'evidence',
      }).record;
      const result = preflight(tools, 'Please check the gizmo compatibility with unrelated hardware today.') as unknown as {
        answerability: string;
        matched_total: number;
        matches: { id: string; central: string[] }[];
      };
      assert.equal(
        result.answerability,
        'ungoverned',
        "'gizmo' is discriminating but never central to the record's own dominant vocabulary — hasRecordCentralityHit still rejects it for answerability"
      );
      assert.equal(result.matched_total, 0, 'matched_total is still decided from the centrality-passing subset');
      assert.equal(
        result.matches.length,
        1,
        'B2G: centrality is no longer required to LIST a candidate — this non-central survivor now appears'
      );
      assert.equal(result.matches[0].id, record.id);
      assert.deepEqual(result.matches[0].central, [], 'the listed record is explicitly non-central');
    } finally {
      cleanup();
    }
  }
);

test('AC-h4 (input guard unchanged): a one-word question still answers insufficient/too_little_vocabulary, even with a store record that would otherwise one-hit-qualify', () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('anti_pattern', {
      title: 'Manifold subsystem',
      trigger:
        'manifold manifold manifold manifolds manifolds manifolds other padding words here to fill space and avoid collision',
      guidance: 'guidance',
      wrong_way: 'wrong way',
      right_way: 'right way text',
      source_evidence: 'evidence',
    });
    const result = preflight(tools, 'manifold');
    assert.equal(
      result.answerability,
      'insufficient',
      'one MATCHING word in a candidate is now enough, but a one-word INPUT is a separate guard and stays insufficient'
    );
    assert.equal(result.reason, 'too_little_vocabulary');
    assert.deepEqual(result.matches, []);
  } finally {
    cleanup();
  }
});

test(
  'AC-h5 (order pin): a two-hit record still sorts ahead of a one-hit record newly admitted by the relaxed floor',
  () => {
    const { tools, cleanup } = harness();
    try {
      const twoHit = tools.knowledgeCreate('decision', {
        title: 'Widget calibration',
        statement: 'Widget calibration procedure text short.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const oneHit = tools.knowledgeCreate('anti_pattern', {
        title: 'Manifold subsystem',
        trigger:
          'manifold manifold manifold manifolds manifolds manifolds other padding words here to fill space and avoid collision',
        guidance: 'guidance',
        wrong_way: 'wrong way',
        right_way: 'right way text',
        source_evidence: 'evidence',
      }).record;
      const result = preflight(
        tools,
        'Investigate the widget calibration behavior during unrelated deployment scheduling review manifold.'
      );
      assert.equal(result.matches.length, 2, 'both the two-hit decision and the one-hit anti_pattern qualify');
      assert.equal(result.matches[0].id, twoHit.id, 'hit count desc is still the primary sort key');
      assert.equal(result.matches[1].id, oneHit.id, 'the one-hit addition lands after every existing (higher-hit) match');
    } finally {
      cleanup();
    }
  }
);

test(
  'sort pin 5 (id ascending is the final tie-break — cross-family review LOW finding): equal hits, equal ' +
    'centrality and equal updated_at — order is decided by id ascending',
  () => {
    const { tools, cleanup } = harness();
    try {
      // Same fixed NOW for both (harness's default clock) — updated_at ties too,
      // so nothing but id can decide the order. Ids are server-minted UUIDs the
      // public create path gives no way to choose, so the expected order is
      // read back from the created records and compared against their own
      // ascending sort, per the reviewer's suggested approach.
      const decision = tools.knowledgeCreate('decision', {
        title: 'quaternion manifold topology geodesic',
        statement: 'Quaternion manifold topology geodesic rule.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const article = seedFeatureArticle(tools, 'quaternion manifold topology geodesic');
      const result = preflight(tools, QUERY_TEXT);
      assert.equal(result.matches.length, 2);
      assert.equal(decision.updated_at, article.updated_at, 'sanity: both records share the same updated_at');
      const expectedOrder = [decision.id, article.id].sort();
      assert.deepEqual(
        result.matches.map((m) => m.id),
        expectedOrder,
        'with hits, centrality and updated_at all tied, the listed order equals the ids sorted ascending — ' +
          'reversing the id branch would list them the other way around'
      );
    } finally {
      cleanup();
    }
  }
);

// --- PREFLIGHT_MATCH_CAP pins (fix round, cross-family review MEDIUM finding):
// the relaxed one-hit floor makes a very large qualifying set plausible (up to
// 6 types x 40 candidates surviving the floors). `matches` is capped AFTER the
// sort at 20; `matched_total` always reports the true pre-cap count;
// `capped: true` is present only when the cap actually bound; the verdict is
// decided from the full set, not the window.

function seedCapCandidate(tools: SterlingTools, i: number) {
  return tools.knowledgeCreate('decision', {
    title: `Zephyr triton calibration variant ${i}`,
    statement: `Zephyr triton procedure for variant ${i} short text.`,
    alternatives_rejected: [],
    rationale: 'rationale',
  }).record;
}

const CAP_QUERY = 'Investigate the zephyr triton behavior for deployment scheduling.';

test('AC-h6 (cap): more than PREFLIGHT_MATCH_CAP qualifying records returns exactly 20, in sort order, with matched_total the true count and capped:true', () => {
  const { tools, cleanup } = harness();
  try {
    const records = [];
    for (let i = 0; i < 25; i++) {
      records.push(seedCapCandidate(tools, i));
    }
    const result = preflight(tools, CAP_QUERY) as unknown as {
      answerability: string;
      matched_total: number;
      capped?: boolean;
      matches: { id: string }[];
    };
    assert.equal(result.matched_total, 25, 'matched_total reports the true pre-cap count, not the windowed length');
    assert.equal(result.capped, true, 'capped is present and true once the cap bound');
    assert.equal(result.matches.length, 20, '`matches` is truncated to the cap');
    assert.equal(result.answerability, 'verify_targets', 'the verdict is decided from the full 25-record set, not the 20-record window');
    // Every fixture ties on hits, centrality and updated_at (same harness
    // clock) — the sort's final tie-break, id ascending, decides order, so
    // the returned window is exactly the 20 smallest ids among the 25.
    const expectedWindow = records.map((r) => r.id as string).sort().slice(0, 20);
    assert.deepEqual(result.matches.map((m) => m.id), expectedWindow, 'the window holds the first 20 in sort order, not an arbitrary 20');
  } finally {
    cleanup();
  }
});

test('AC-h7 (cap, negative control): a small qualifying set carries matched_total but no capped flag at all', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 3; i++) {
      seedCapCandidate(tools, i);
    }
    const result = preflight(tools, CAP_QUERY) as unknown as {
      matched_total: number;
      capped?: boolean;
      matches: { id: string }[];
    };
    assert.equal(result.matched_total, 3);
    assert.equal(result.matches.length, 3);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'capped'),
      false,
      'capped is OMITTED (never `false`) when the window is already complete — mirrors inbound_supersedes-style presence-only disclosure'
    );
  } finally {
    cleanup();
  }
});

// --- B2G widening pins (this session): the record-centrality floor is no
// longer required to LIST a candidate in knowledge_preflight's `matches` —
// only to decide matched_total/answerability, exactly as before. See
// findings f6ada94d and
// preflight-verdict-false-governed-on-hard-negatives-and-b2g-measured-
// september-2026. Test (a) (a non-central-only survivor, ungoverned with
// matched_total 0 but matches.length 1) is already pinned above by the
// rewritten AC-b and AC-h3. The two tests below cover (b) centrality-first
// sort against a higher-hit non-central competitor, and (c) `capped`
// reflecting the widened (not just centrality-passing) list length.

test(
  'AC-i1 (B2G sort): a central record with FEWER raw hits sorts ahead of a non-central record with MORE raw ' +
    'hits — centrality is the primary key regardless of which side has more matched terms',
  () => {
    const { tools, cleanup } = harness();
    try {
      // CENTRAL: 2 hits (boolean, modifier), both central (covered >= min(2,6)).
      const central = seedCentralAntiPattern(tools);
      // NON-CENTRAL: 5 hits (alpha/beta/gamma/delta/epsilon), all peripheral —
      // FILLER_TERMS' six words (freq 3 each) dominate this record's own
      // top-6 narrow-central set, crowding every alpha/beta/gamma/delta/epsilon
      // (freq 1 each) out of it entirely.
      const nonCentral = tools.knowledgeCreate('decision', {
        title: 'Filler decision baseline',
        statement: `${FILLER_TERMS} alpha beta gamma delta epsilon`,
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      const result = preflight(
        tools,
        'Investigate boolean modifier alpha beta gamma delta epsilon issue for review.'
      ) as unknown as { answerability: string; matched_total: number; matches: { id: string; central: string[] }[] };
      assert.equal(result.answerability, 'verify_targets', 'the central record alone already governs this subject');
      assert.equal(result.matched_total, 1, 'only the central record passes the centrality floor for matched_total');
      assert.equal(result.matches.length, 2, 'both the central and the widened non-central survivor are listed');
      assert.equal(
        result.matches[0].id,
        central.id,
        'centrality is the PRIMARY sort key: 2 central hits outranks 5 non-central hits'
      );
      assert.equal(result.matches[1].id, nonCentral.id);
      assert.deepEqual(result.matches[1].central, [], 'the lower-ranked survivor is explicitly non-central');
    } finally {
      cleanup();
    }
  }
);

test(
  'AC-i2 (B2G cap): the widened list caps at 20 even when the centrality-passing subset (matched_total) is far ' +
    'smaller — capped reflects the FULL widened list, not just the central survivors',
  () => {
    const { tools, cleanup } = harness();
    try {
      // The one centrality-passing record: a small, undiluted narrow text
      // (title+statement) where every extractable term is automatically
      // central (<=6 distinct terms total).
      const central = tools.knowledgeCreate('decision', {
        title: 'Kappa nexus register',
        statement: 'Kappa nexus register control plane operation.',
        alternatives_rejected: [],
        rationale: 'rationale',
      }).record;
      // 20 non-central survivors: each shares exactly one peripheral,
      // discriminating word ('omega') with the query, crowded out of its own
      // top-6 narrow-central set by FILLER_TERMS' six higher-frequency words.
      const fillers = [];
      for (let i = 0; i < 20; i++) {
        fillers.push(
          tools.knowledgeCreate('decision', {
            title: `Filler variant ${i}`,
            statement: `${FILLER_TERMS} omega`,
            alternatives_rejected: [],
            rationale: 'rationale',
          }).record
        );
      }
      const result = preflight(tools, 'Kappa nexus omega review today.') as unknown as {
        answerability: string;
        matched_total: number;
        capped?: boolean;
        matches: { id: string }[];
      };
      assert.equal(result.matched_total, 1, 'matched_total counts only the one centrality-passing record');
      assert.equal(
        result.capped,
        true,
        'the widened list (1 central + 20 non-central = 21 survivors) exceeds the 20 cap even though matched_total is 1'
      );
      assert.equal(result.matches.length, 20, '`matches` is truncated to the cap over the WIDENED list');
      assert.equal(result.matches[0].id, central.id, 'the sole central survivor still sorts first');
      const expectedFillerWindow = fillers.map((r) => r.id as string).sort().slice(0, 19);
      assert.deepEqual(
        result.matches.slice(1).map((m) => m.id),
        expectedFillerWindow,
        'the remaining 19 slots hold the 19 smallest-id non-central fillers (tied on hits/centrality/updated_at)'
      );
    } finally {
      cleanup();
    }
  }
);
