// ---------------------------------------------------------------------------
// Hardening spec for the ALREADY-IMPLEMENTED MCP tool `knowledge_supersede`
// (decision e17794ea-e9bd-4aad-a518-df3cc4adde76, board
// 0b33c27b-f36c-4d66-b92d-83885dbb1725). The frozen spec file
// `knowledge-supersede.test.ts` (AC1–AC11) pins the tool's headline
// contract — id-ladder resolution, complete-body validation, allowed
// old-record types, orphan detection over enumerated rulings, slug
// continuity, promotion_review re-pointing, response shape. This file pins
// SIX additional behaviors that spec does not cover, all derived from the
// design decision's own text rather than from reading tools.ts:
//
//   F1-dash      prose dashes are not ruling units (orphan check must not
//                mis-segment dash-delimited prose as an enumeration)
//   F1-sequence  mid-sentence sentence-terminal numbers that do not form a
//                1-starting ascending run are not ruling units either
//   F1-bullets   genuine line-start bullets (`- foo`) ARE ruling units,
//                exactly like numbered lists ("numbered OR bulleted items"
//                per e17794ea's own orphan-detection clause)
//   F2-no-straddle  for a multi-field type (anti_pattern), orphan units and
//                their excerpts are scoped to the SINGLE field that carries
//                the enumeration (trigger) — never the record's other
//                fields (right_way)
//   F3-citations a fields value that cites a record id which resolves to
//                nothing still succeeds, but returns a citation warning on
//                the existing warnings[] channel (the append/oversize
//                precedent, decisions 8ed62c1b / 6c79a617); the key is
//                always present, empty when nothing was cited
//   F4-slugless  superseding a record that has literally no slug (the
//                de1a7329 "legacy records round-trip unchanged — no
//                migration" case) still mints a fresh slug on the new head,
//                derived from the NEW title, since there is no old slug to
//                inherit
//
// EXPECTED FAILURE SHAPE: knowledgeSupersede EXISTS on SterlingTools today
// (this is a hardening pass on shipped code, unlike the frozen spec's
// blind-red file), so a failure here is a genuine assertion mismatch, not a
// TypeError — each test states, inline, exactly which assertion would fire
// and on what if the corresponding behavior regressed or was never built
// as specified. Per-test annotations below.
//
// Harness, id-ladder helper, and fixture builders are copied from
// knowledge-supersede.test.ts (read in full for this purpose) to keep
// conventions identical; no implementation source (tools.ts,
// store/src/index.ts, schemas/records.ts) was read.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-supersede-hardening-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

interface SupersedeCapable {
  knowledgeSupersede(old_id: string, fields: Loose, orphans_acknowledged?: boolean): unknown;
}
function supersede(tools: SterlingTools, old_id: string, fields: Loose, orphans_acknowledged?: boolean): Loose {
  return (tools as unknown as SupersedeCapable).knowledgeSupersede(old_id, fields, orphans_acknowledged) as Loose;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function countOf(tools: SterlingTools, type: string): number {
  return tools.knowledgeQuery({ types: [type] }).length;
}

// Fixture builders — same minimal valid bodies as knowledge-supersede.test.ts.
function mkDecision(tools: SterlingTools, title: string, statement: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

function mkAntiPattern(tools: SterlingTools, title: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('anti_pattern', {
    title,
    trigger: 'trigger text',
    guidance: 'guidance text',
    wrong_way: 'wrong way text',
    right_way: 'right way text',
    source_evidence: 'evidence text',
    ...overrides,
  }).record as unknown as Loose;
}

// Mimics a pre-slug legacy record: built directly through the store, the
// same way seedPrefixTwin (knowledge-supersede.test.ts) bypasses the public
// create tool to reach a shape the tool surface itself cannot produce.
// Decision de1a7329 states slug is OPTIONAL and "legacy records round-trip
// unchanged — no migration", i.e. exactly this shape is expected to exist.
function mkSluglessDecision(store: SterlingStore, tools: SterlingTools, title: string, statement: string): Loose {
  const donor = mkDecision(tools, `${title} (slug donor, discarded)`, statement);
  const body = JSON.parse(JSON.stringify(donor)) as Loose;
  delete body.slug;
  body.id = 'deadbeef-0000-4000-8000-000000000099';
  body.title = title;
  store.create(body as never);
  return { ...body };
}

// ===========================================================================
// F1 — ruling-unit segmentation edge cases
// ===========================================================================

test('F1-dash: prose dashes are not ruling units — a wholly different replacement is never orphan-refused', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(
      tools,
      'f1-dash-origin',
      'The gate holds - which surprised us - even under load, so we keep it.'
    );
    // FAILURE SHAPE: if the segmenter mis-parses " - " delimited prose as
    // >=2 enumerated units, this throws an orphan-refusal Error and
    // doesNotThrow reports it — that IS the discriminating failure.
    assert.doesNotThrow(
      () =>
        supersede(tools, old.id as string, {
          title: 'f1-dash-new',
          statement: 'A completely unrelated replacement statement about a different subject entirely.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      'prose dashes must never be parsed as enumerated ruling units'
    );
    assert.equal(get(tools, old.id as string).status, 'superseded', 'the supersede proceeded to completion, unblocked');
  } finally {
    cleanup();
  }
});

test('F1-sequence: mid-sentence sentence-terminal numbers not forming a 1-starting ascending run are not ruling units', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(
      tools,
      'f1-sequence-origin',
      '…as of step 2. Then the run resumes… fixed in phase 3. The rest stands.'
    );
    // FAILURE SHAPE: if a naive scan treats "2." and "3." as enumeration
    // markers (ignoring that no "1." precedes them and they are not
    // line-start), this throws an orphan-refusal Error and doesNotThrow
    // reports it.
    assert.doesNotThrow(
      () =>
        supersede(tools, old.id as string, {
          title: 'f1-sequence-new',
          statement: 'An unrelated replacement statement about a wholly different topic.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      'numbers embedded mid-sentence that do not start a 1-based ascending enumeration must not be treated as ruling units'
    );
    assert.equal(get(tools, old.id as string).status, 'superseded');
  } finally {
    cleanup();
  }
});

const BULLET_STATEMENT =
  '- Alpha widgets mount on the north bracket.\n' + '- Beta widgets are assigned by frame category.';

test('F1-bullets: genuine line-start bullets ARE ruling units — an uncovering replacement is orphan-refused naming the Beta excerpt', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'f1-bullets-origin', BULLET_STATEMENT);
    const before = countOf(tools, 'decision');
    // FAILURE SHAPE: if bullets are NOT recognized as enumerated units, this
    // assert.throws fails because supersede() returns normally instead of
    // throwing (the callback form of assert.throws is never invoked).
    assert.throws(
      () =>
        supersede(tools, old.id as string, {
          title: 'f1-bullets-new',
          statement: 'Alpha widgets mount on the north bracket, confirmed and unchanged.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      (err: Error) => {
        assert.match(err.message, /Beta|frame category/i, 'the orphaned Beta ruling is named/excerpted');
        assert.match(err.message, /orphans_acknowledged/, 'names the re-call-with-acknowledgement remedy');
        return true;
      },
      'a two-bullet statement must be orphan-checked exactly like a two-item numbered list'
    );
    assert.equal(countOf(tools, 'decision'), before, 'nothing written on the orphan refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

test('F1-bullets: orphans_acknowledged:true proceeds past the bullet-detected orphan and discloses the accepted candidate', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'f1-bullets-ack-origin', BULLET_STATEMENT);
    let result: Loose = {};
    // FAILURE SHAPE: if acknowledgement is honoured only for numbered lists
    // and not for bullets, this throws and doesNotThrow reports it.
    assert.doesNotThrow(() => {
      result = supersede(
        tools,
        old.id as string,
        {
          title: 'f1-bullets-ack-new',
          statement: 'Alpha widgets mount on the north bracket, confirmed and unchanged.',
          alternatives_rejected: [],
          rationale: 'r2',
        },
        true
      );
    }, 'orphans_acknowledged:true must proceed past a bullet-detected orphan just as it does for numbered rulings');
    assert.equal(get(tools, old.id as string).status, 'superseded');
    const disclosed = JSON.stringify(result);
    assert.match(disclosed, /Beta|frame category/i, 'the response discloses the accepted Beta orphan candidate');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F2 — orphan units and excerpts never straddle field boundaries
// ===========================================================================

const F2_TRIGGER =
  '1. Never deploy widget-clusters before the frost-check completes. ' +
  '2. Never merge frame-batches without the calendar sign-off.';
const F2_RIGHT_WAY =
  'Run the greenhouse-verification checklist first, confirming with the distinctive marker ZANTHORP-COMPLIANCE-TOKEN before any rollout.';

test('F2-no-straddle: orphan excerpts for an anti_pattern come from trigger only — right_way vocabulary never leaks into the refusal', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkAntiPattern(tools, 'f2-no-straddle-origin', {
      trigger: F2_TRIGGER,
      right_way: F2_RIGHT_WAY,
    });
    const before = countOf(tools, 'anti_pattern');
    // FAILURE SHAPE: if the segmenter concatenates trigger+right_way (or any
    // other field) before excerpting orphans, err.message would contain
    // ZANTHORP-COMPLIANCE-TOKEN and the doesNotMatch assertion fails; if
    // trigger is not orphan-checked at all, the outer assert.throws fails
    // because the call returns instead of throwing.
    assert.throws(
      () =>
        supersede(tools, old.id as string, {
          title: 'f2-no-straddle-new',
          trigger: 'Never deploy widget-clusters before the frost-check completes, confirmed and unchanged.',
          guidance: 'guidance text',
          wrong_way: 'wrong way text',
          right_way: 'a wholly different right-way text sharing no vocabulary with the original at all',
          source_evidence: 'fresh evidence',
        }),
      (err: Error) => {
        assert.match(err.message, /frame-batches|calendar sign-off/i, 'the orphaned second trigger ruling is named/excerpted');
        assert.doesNotMatch(
          err.message,
          /ZANTHORP-COMPLIANCE-TOKEN/,
          "no reported excerpt draws from right_way's distinctive vocabulary — units never straddle field boundaries"
        );
        return true;
      },
      'the orphan check must scope its enumerated units and their excerpts to trigger only'
    );
    assert.equal(countOf(tools, 'anti_pattern'), before, 'nothing written on the orphan refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F3 — citation warnings on the existing warnings[] channel
// ===========================================================================

const NONEXISTENT_ID = '12345678-dead-beef-0000-000000000000';

test('F3-citations: a fields.statement citing a nonexistent record id still succeeds, but the response carries a citation warning', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'f3-citations-origin', 'plain single-ruling prose statement.');
    let result: Loose = {};
    // FAILURE SHAPE: if a dangling citation is not checked at all, the
    // warnings assertions below fail (empty array / wrong length); if it is
    // treated as a hard refusal instead of a warning, assert.doesNotThrow
    // reports the thrown Error.
    assert.doesNotThrow(() => {
      result = supersede(tools, old.id as string, {
        title: 'f3-citations-new',
        // The house citation scan (CITATION_RE, shared by every write path)
        // flags an id only when a trigger word precedes it — 'knowledge_get'
        // or a record-type name. Bare ids in prose are deliberately not
        // scanned, so the fixture cites the way siblings' fixtures do.
        statement: `supersedes the ruling in decision ${NONEXISTENT_ID}`,
        alternatives_rejected: [],
        rationale: 'r2',
      });
    }, 'a dangling citation warns, it does not refuse the write');
    assert.equal(get(tools, old.id as string).status, 'superseded', 'the write went through despite the dangling citation');
    assert.ok(Array.isArray(result.warnings), 'the warnings key is present and is an array');
    assert.equal((result.warnings as unknown[]).length, 1, 'exactly one citation warning');
    const warning = (result.warnings as string[])[0];
    assert.match(warning, new RegExp(escapeRegex(NONEXISTENT_ID)), 'the warning names the unresolved id');
    assert.match(warning, /resolve|citation/i, 'the warning explains the id does not resolve');
  } finally {
    cleanup();
  }
});

test('F3-citations: a fields.statement with no citations at all returns warnings as an empty array — the key is always present', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'f3-no-citations-origin', 'plain single-ruling prose statement.');
    const result = supersede(tools, old.id as string, {
      title: 'f3-no-citations-new',
      statement: 'a replacement statement citing nothing at all.',
      alternatives_rejected: [],
      rationale: 'r2',
    });
    // FAILURE SHAPE: if the warnings key is only added when non-empty, this
    // deepEqual fails because result.warnings is undefined rather than [].
    assert.deepEqual(result.warnings, [], 'no citations means an empty warnings array, not an absent key');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F4 — slugless legacy record supersession mints a fresh slug
// ===========================================================================

test('F4-slugless: superseding a legacy record with NO slug mints a fresh auto-slug on the new head, derived from the NEW title, resolvable via knowledge_get', () => {
  const { store, tools, cleanup } = harness();
  try {
    const legacy = mkSluglessDecision(
      store,
      tools,
      'F4 legacy record with no slug',
      'plain single-ruling prose statement, legacy shape.'
    );
    assert.equal(legacy.slug, undefined, 'precondition: the legacy record carries no slug at all');
    assert.equal(get(tools, legacy.id as string).id, legacy.id, 'sanity: the slugless legacy record is reachable by its full id');

    // FAILURE SHAPE: if slug minting only runs on the inherit-from-old-slug
    // path (AC9 of the frozen spec) and has no fallback for "old record had
    // no slug at all", newRec.slug is falsy and the first assert.ok fails.
    supersede(tools, legacy.id as string, {
      title: 'F4 legacy replacement with a brand new title',
      statement: 'replacement statement for the slugless legacy record.',
      alternatives_rejected: [],
      rationale: 'r2',
    });

    const pinned = get(tools, legacy.id as string);
    assert.equal(pinned.status, 'superseded', 'the legacy record was superseded');
    const newId = pinned.superseded_by as string;
    const newRec = get(tools, newId);
    assert.ok(newRec.slug, 'the new head carries an auto-minted slug even though the old record had none to inherit');
    assert.match(newRec.slug as string, /^[a-z0-9-]+$/, 'the slug is kebab-case, per the auto-mint convention');
    assert.match(newRec.slug as string, /legacy-replacement/, 'the slug derives from the NEW title, not the old (slugless) one');

    // FAILURE SHAPE: if the minted slug is never registered for resolution,
    // this knowledge_get throws "no record" instead of returning newId.
    const resolved = get(tools, newRec.slug as string);
    assert.equal(resolved.id, newId, 'the auto-minted slug resolves the new head via knowledge_get');
  } finally {
    cleanup();
  }
});
