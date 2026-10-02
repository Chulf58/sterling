// ---------------------------------------------------------------------------
// Spec: board c6e3561f-af44-4a9c-8465-b49bbc07fce5 — disclosure-carry slice.
//
// PART (a) ALREADY SHIPPED (pinned by inbound-supersedes-disclosure.test.ts):
//   knowledge_get on a record X that has INBOUND rel:'supersedes' edges
//   (i.e. some OTHER record Y carries links:[{rel:'supersedes', target_id: X.id}])
//   surfaces them as an additive field `inbound_supersedes`: an array of
//   {id, slug?, title?, status, superseded_by?} — one entry per holder. The
//   field is OMITTED entirely when there are no inbound superseders; `status`
//   is a PINNED member (part (a) PIN 6 asserts entry.status); superseded_by is
//   present only when that inbound superseder is itself not active.
//
// THIS SLICE carries the SAME disclosure into two MORE read surfaces:
//   AC1  knowledge_query, FULL projection: a returned record that HAS inbound
//        superseders carries `inbound_supersedes` with the SAME shape.
//   AC2  knowledge_query, DIGEST projection (CONTROL): stays NARROW — the
//        field is intentionally NOT carried on a digest (perf).
//   AC3  knowledge_preflight: a matched record that HAS inbound superseders
//        carries `inbound_supersedes` on its match entry, same shape.
//   AC4  empty CONTROL: a record with NO inbound superseders has the field
//        OMITTED (not present as []/null) on both query-full and preflight —
//        matching knowledge_get's omit-when-empty contract.
//
// Written BLIND to tools.ts / packages/store (H4). Harness idiom, the
// knowledgeQueryResult envelope ({records, matched_filter, returned, cap,
// capped}), the default-is-full / projection:'digest' distinction, the
// knowledgePreflight match shape ({id, type, title, matched_on, central}), the
// CENTRAL_TITLE/CENTRAL_TRIGGER dominant-vocabulary fixture, and the
// inbound_supersedes {id, status} entry shape are all read from sibling TESTS
// only — never implementation: inbound-supersedes-disclosure.test.ts,
// knowledge-preflight.test.ts, count-projection.test.ts, tools.test.ts.
//
// EXPECTED RED SHAPE ON CURRENT CODE (feature absent on these two surfaces):
//   AC1 FAILS — the query-full record carries no inbound_supersedes key, so
//       inboundIds(...) is [] and .includes(B.id) is false (membership miss,
//       not a thrown error).
//   AC3 FAILS — the preflight match entry carries no inbound_supersedes key,
//       so the match's inboundIds is [] and .includes(B.id) is false.
//   AC2 PASSES today (digest never carried it) — it is a CONTROL that must
//       STAY green once the feature lands (digest deliberately omits).
//   AC4 PASSES today (field simply absent everywhere) — it is a CONTROL that
//       earns its keep once the feature is built: omit-when-empty, never [].
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-26T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-inbound-carry-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkDecision(tools: SterlingTools, title: string, statement = 's', overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

// A holder B that carries an INBOUND rel:'supersedes' edge onto `targetId`.
function mkSuperseder(tools: SterlingTools, title: string, targetId: string): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: 'newer statement overriding one clause of the target',
    alternatives_rejected: [],
    rationale: 'r',
    links: [{ rel: 'supersedes', target_id: targetId }],
  }).record as unknown as Loose;
}

// Same absent-is-empty tolerance the part-(a) test uses for its membership
// pins: an ABSENT field and an empty array both read as "no inbound ids". The
// omit-vs-empty distinction is tested DIRECTLY on the object shape by AC4, not
// through this lossy helper.
function inboundIds(record: Loose): string[] {
  const field = record.inbound_supersedes;
  if (field === undefined) return [];
  assert.ok(Array.isArray(field), 'inbound_supersedes, when present, must be an array');
  return (field as Loose[]).map((e) => {
    assert.ok(typeof e.id === 'string' && (e.id as string).length > 0, 'each inbound_supersedes entry carries an id');
    return e.id as string;
  });
}

function inboundEntries(record: Loose): Loose[] {
  const field = record.inbound_supersedes;
  if (field === undefined) return [];
  assert.ok(Array.isArray(field), 'inbound_supersedes, when present, must be an array');
  return field as Loose[];
}

// Fixture vocabulary copied verbatim from knowledge-preflight.test.ts's
// CENTRAL_TITLE/CENTRAL_TRIGGER — six modeling-domain words repeated 3x each so
// they deterministically dominate the record's own top-6 by raw frequency,
// guaranteeing a preflight match on the AC-a matching text below. (An
// anti_pattern is used as the match TARGET because that is the exact shape
// knowledge-preflight.test.ts already proves surfaces; inbound_supersedes is
// type-agnostic — any record can be the target of another record's supersedes
// edge.)
const CENTRAL_TITLE = 'Boolean modifier mesh manifold topology solver stability failure';
const CENTRAL_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
// Proven-matching probe text (verbatim from knowledge-preflight.test.ts AC-a).
const MATCHING_TEXT =
  'Investigate why the boolean operation corrupts the mesh: check whether the modifier ' +
  'stack introduces non-manifold geometry that breaks downstream processing.';

function seedCentralAntiPattern(tools: SterlingTools, title = CENTRAL_TITLE): Loose {
  return tools.knowledgeCreate('anti_pattern', {
    title,
    trigger: CENTRAL_TRIGGER,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
  }).record as unknown as Loose;
}

type PreflightResult = {
  answerability: string;
  terms: string[];
  matches: Loose[];
};

function preflight(tools: SterlingTools, text: string): PreflightResult {
  return (tools as unknown as { knowledgePreflight: (t: string) => PreflightResult }).knowledgePreflight(text);
}

// ===========================================================================
// AC1 — knowledge_query FULL projection carries inbound_supersedes on a
// record that HAS inbound superseders, with the SAME shape knowledge_get
// produces ({id, ..., status, superseded_by?}).
// SABOTAGE: the query projection path never computes inbound edges (returns
// the raw stored record, which never holds inbound_supersedes — it is a
// computed reverse-edge field, exactly as on knowledge_get) — that keeps this
// red, which IS the correct red for the feature-absent state today.
// ===========================================================================

test('AC1: knowledge_query (default/full projection) surfaces inbound_supersedes on record A, containing holder B — same shape as knowledge_get', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'ac1-old-record', 'old clause-bearing statement');
    const b = mkSuperseder(tools, 'ac1-new-record', a.id as string);

    // Default projection is 'full' (tools.test.ts: "'full' is still the default
    // and still carries bodies"). No projection param == full.
    const result = tools.knowledgeQueryResult({ types: ['decision'] }) as unknown as { records: Loose[] };
    const aRow = result.records.find((r) => r.id === a.id);
    assert.ok(aRow, 'precondition: A is returned in the full-projection window');

    const ids = inboundIds(aRow!);
    assert.ok(
      ids.includes(b.id as string),
      "EXPECTED RED today: knowledge_query full records carry no inbound_supersedes key, so B's id is absent. " +
        'SABOTAGE: never compute inbound edges in the query projection (return the raw stored record, which never ' +
        'holds this computed reverse-edge field) — keeps this membership assertion red forever, the correct red.'
    );

    // Shape parity with knowledge_get: B is ACTIVE, so its entry names status
    // 'active' and carries NO superseded_by (present only when the inbound
    // superseder is itself not active).
    const bEntry = inboundEntries(aRow!).find((e) => e.id === b.id);
    assert.ok(bEntry, 'B has an entry in A.inbound_supersedes');
    assert.equal(
      bEntry!.status,
      'active',
      "EXPECTED RED today (bEntry undefined). Once built: the entry names the holder's own current status, exactly " +
        "as knowledge_get does (inbound-supersedes-disclosure.test.ts PIN 6). SABOTAGE: hydrate entries with only " +
        '{id} and no status member — fails to distinguish a live holder from a retired one.'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(bEntry!, 'superseded_by'),
      false,
      'B is active, so superseded_by is OMITTED — matching knowledge_get. SABOTAGE: always attach superseded_by, ' +
        'even for an active holder.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC2 (CONTROL, placed to carry its own evidence) — the DIGEST projection
// stays narrow: it does NOT carry inbound_supersedes, even for the very same
// record A that DOES surface it under full projection (proven in AC1). The
// only reason the field is absent here is the digest projection intentionally
// omitting it — not the absence of an inbound edge.
// SABOTAGE: digest starts carrying inbound_supersedes (the unintended perf
// cost the digest projection exists to avoid) — turns this assertion red.
// ===========================================================================

test('AC2 CONTROL: knowledge_query projection:"digest" does NOT carry inbound_supersedes, even for a record that HAS inbound superseders', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'ac2-old-record', 'old clause-bearing statement');
    mkSuperseder(tools, 'ac2-new-record', a.id as string);

    const digest = tools.knowledgeQueryResult({ types: ['decision'], projection: 'digest' }) as unknown as {
      records: Loose[];
    };
    const aRow = digest.records.find((r) => r.id === a.id);
    assert.ok(aRow, 'precondition: A is present in the digest window (digest carries id/type/title — tools.test.ts)');

    assert.equal(
      Object.prototype.hasOwnProperty.call(aRow!, 'inbound_supersedes'),
      false,
      'EXPECTED GREEN both before and after the fix: a digest is the LANDSCAPE, not the bodies — it deliberately ' +
        'omits the computed reverse-edge field. SABOTAGE: make the digest projection also compute and attach ' +
        'inbound_supersedes — that reintroduces the exact per-record cost the digest exists to avoid, turning this red.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3 — knowledge_preflight match entries carry inbound_supersedes for a
// matched record that HAS inbound superseders, same shape.
// SABOTAGE: preflight match projection omits inbound_supersedes (builds each
// match from only {id, type, title, matched_on, central}) — keeps this red.
// ===========================================================================

test('AC3: knowledge_preflight — a matched record A that HAS an inbound superseder B carries inbound_supersedes (containing B) on its match entry', () => {
  const { tools, cleanup } = harness();
  try {
    const a = seedCentralAntiPattern(tools, 'ac3-central-target');
    // B supersedes A. B's vocabulary is deliberately unrelated to the probe
    // text, so B itself does not become a spurious preflight match — but that
    // is irrelevant to the assertion, which locates A's match by id.
    const b = mkSuperseder(tools, 'ac3-superseder', a.id as string);

    const result = preflight(tools, MATCHING_TEXT);
    assert.equal(result.answerability, 'verify_targets', 'precondition: the store governs this subject');
    const match = result.matches.find((m) => m.id === a.id);
    assert.ok(match, 'precondition: A surfaces as a preflight match on its own dominant vocabulary');

    const ids = inboundIds(match!);
    assert.ok(
      ids.includes(b.id as string),
      "EXPECTED RED today: preflight match entries carry no inbound_supersedes key, so B's id is absent. " +
        'SABOTAGE: build each preflight match from only {id, type, title, matched_on, central} and never compute ' +
        'the inbound edges for the matched record — keeps this membership assertion red, the correct red.'
    );

    const bEntry = inboundEntries(match!).find((e) => e.id === b.id);
    assert.ok(bEntry, 'B has an entry on the preflight match');
    assert.equal(
      bEntry!.status,
      'active',
      "EXPECTED RED today (bEntry undefined). Once built: the entry names the holder's own status, same shape as " +
        'knowledge_get / knowledge_query-full. SABOTAGE: hydrate preflight entries with only {id}, no status.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC4 (empty CONTROL) — a record with NO inbound superseders has the field
// OMITTED (not present as []/null) on BOTH query-full and preflight, matching
// knowledge_get's omit-when-empty contract. An UNRELATED supersedes edge
// exists elsewhere in the same store, so a "return every supersedes edge"
// sabotage would leak into the isolated record's result and be caught.
// SABOTAGE: emit `inbound_supersedes: []` (or null) instead of OMITTING the
// key when there are no inbound superseders — turns both hasOwnProperty
// assertions red.
// ===========================================================================

test('AC4 CONTROL: a record with NO inbound superseders OMITS inbound_supersedes entirely on query-full (not []/null), unaffected by an unrelated supersedes edge elsewhere', () => {
  const { tools, cleanup } = harness();
  try {
    const isolated = mkDecision(tools, 'ac4-isolated-query', 'nothing points at this');

    // Unrelated pair elsewhere in the same store: a "return every supersedes
    // edge in the store" sabotage (unfiltered by target_id) would leak into
    // `isolated`'s result.
    const unrelatedOld = mkDecision(tools, 'ac4-unrelated-old', 'unrelated old record');
    mkSuperseder(tools, 'ac4-unrelated-new', unrelatedOld.id as string);

    const result = tools.knowledgeQueryResult({ types: ['decision'] }) as unknown as { records: Loose[] };
    const row = result.records.find((r) => r.id === isolated.id);
    assert.ok(row, 'precondition: the isolated record is in the full window');

    assert.deepEqual(
      inboundIds(row!),
      [],
      'no leaked/phantom entry: neither a placeholder nor the unrelated edge. SABOTAGE: return every supersedes ' +
        'edge in the store unfiltered by target_id — leaks unrelatedNew into this list, turning this red.'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(row!, 'inbound_supersedes'),
      false,
      'EXPECTED GREEN today (key simply absent) — earns its keep once the feature lands: the key must be OMITTED, ' +
        'never present-and-empty, when there is nothing to disclose. SABOTAGE: attach `inbound_supersedes: []` ' +
        'unconditionally to every query-full record regardless of whether inbound edges exist — turns this red.'
    );
  } finally {
    cleanup();
  }
});

test('AC4 CONTROL: a matched record with NO inbound superseders OMITS inbound_supersedes entirely on its preflight match (not []/null)', () => {
  const { tools, cleanup } = harness();
  try {
    const isolated = seedCentralAntiPattern(tools, 'ac4-isolated-preflight');

    // Unrelated supersedes pair, distinct vocabulary so it does not itself
    // match the probe text — present only to catch a store-wide-edge leak.
    const unrelatedOld = mkDecision(tools, 'ac4-pf-unrelated-old', 'unrelated old record');
    mkSuperseder(tools, 'ac4-pf-unrelated-new', unrelatedOld.id as string);

    const result = preflight(tools, MATCHING_TEXT);
    const match = result.matches.find((m) => m.id === isolated.id);
    assert.ok(match, 'precondition: the isolated record surfaces as a preflight match');

    assert.deepEqual(
      inboundIds(match!),
      [],
      'no leaked/phantom entry on the preflight match. SABOTAGE: return every supersedes edge unfiltered — leaks in.'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(match!, 'inbound_supersedes'),
      false,
      'EXPECTED GREEN today (key absent) — once built, a preflight match with no inbound superseders must OMIT the ' +
        'key, never carry an empty array. SABOTAGE: attach `inbound_supersedes: []` unconditionally to every ' +
        'preflight match — turns this red.'
    );
  } finally {
    cleanup();
  }
});
