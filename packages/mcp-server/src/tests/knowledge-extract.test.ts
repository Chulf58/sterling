// ---------------------------------------------------------------------------
// Spec for the NEW MCP tool `knowledge_extract` (decision
// knowledge-extract-design, knowledge_get 7145aa69-2380-451c-b2b4-589937fba454;
// board ff07e314-04c4-482d-9232-77b794e9b819 — the content half of the
// knowledge_extract/partial-promotion item; the metadata half already shipped
// as decision promote-boundary-sanitisation).
//
// knowledgeExtract(input) DOES NOT EXIST YET on SterlingTools — this file is
// written blind to tools.ts, from the dispatched decision record only.
// `packages/mcp-server/src/tests/knowledge-split.test.ts` and
// `knowledge-update-stale.test.ts` were read for harness convention (fixture
// store setup, the cast-through-`unknown` precedent for a wholly-new tool
// method, the assertParentUntouched/assertNoSlug/articleCount "nothing
// written" idiom, the maintenanceEnqueue/maintenanceQuery resolves-lane
// convention, and the raw `store.create` pattern for constructing a legacy
// non-head record directly). No implementation source (tools.ts, server.ts,
// packages/schemas) was read.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE (every test below, uniformly):
// SterlingTools has no `knowledgeExtract` method at all today, so every call
// through the `runExtract()` helper below throws
// `TypeError: tools.knowledgeExtract is not a function` — the correct RED for
// a wholly new tool (same shape as knowledge-split.test.ts's own documented
// precedent for `knowledgeSplit`). Once knowledgeExtract is implemented, each
// test then discriminates on its own assertions, annotated per-test below.
//
// SPEC AMBIGUITIES HIT (flagged, not resolved — see the handoff report):
//   1. The receipt's `edges{informed_by,cites}` value shape is undocumented
//      by the decision beyond field presence (are the values record ids? edge
//      descriptor objects?) — this file pins only that both keys are PRESENT
//      on the receipt, and discovers the new record's id independently via
//      the ORIGINAL's own materialized `links` array (the `cites` edge),
//      never by guessing the receipt's internal shape.
//   2. The exact wording of the "non-active (superseded) source" refusal is
//      unspecified: it could be extract's own active-guard OR the existing
//      stale-address "version conflict" redirect (per
//      knowledge-update-stale.test.ts) firing first during id resolution.
//      The D2 test below accepts either vocabulary via a permissive regex
//      and this is called out explicitly as unresolved.
//   3. The `resolves` "plain lane... identical to knowledgeUpdate" chain
//      membership predicate is not spelled out for non-article types. This
//      file assumes the same file_keys-overlap convention
//      knowledge-split.test.ts uses for its own reconcile_needed fixtures,
//      since decisions carry a `file_keys` field (confirmed directly on the
//      knowledge-extract-design decision record itself) and the decision
//      states resolves is "identical to knowledgeUpdate" — no split-specific
//      marker text is invented.
//   4. `field.replace(find, replace)` — JS String.replace with a STRING
//      needle only replaces the FIRST occurrence, which happens to coincide
//      with "exactly once" by the time replace() runs (the exactly-once gate
//      already refused >1 matches) — this file relies on that coincidence
//      rather than needing a global replace, matching the decision's own
//      literal `field.replace(find, replace)` wording.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-25T16:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-extract-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// Dedicated MountedStores harness — the file's default harness() above wraps
// a plain project-only SterlingStore and genuinely CANNOT mint a
// domain-scoped record (no mount point exists at all). This mirrors the
// EXACT precedent domain-routing.test.ts's own harness sets for reaching
// domain scope (MountedStores + parseConfig({stack_tags:[name]})) — not
// faked, the same real domain-store write path knowledge_create already
// routes through. Used only by the scope-guard and domain-source pins below.
function domainHarness(domainName = 'genesys') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-extract-domain-'));
  const domainDb = join(dir, 'domains', domainName, 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: domainName, dbPath: domainDb }]);
  const config = parseConfig({ stack_tags: [domainName] });
  const tools = new SterlingTools({ store, config, now: () => NOW, newId: randomUUID });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, domainDb, store, tools, cleanup };
}

// The tool is not declared on SterlingTools yet — cast through `unknown` so
// this file compiles under any TS strictness the runner applies, while the
// RUNTIME call still hits the real (currently absent) method and throws
// honestly. Same precedent as knowledge-split.test.ts's `split()` helper.
interface ExtractCapable {
  knowledgeExtract(input: Loose): unknown;
}
function runExtract(tools: SterlingTools, input: Loose): Loose {
  return (tools as unknown as ExtractCapable).knowledgeExtract(input) as Loose;
}

// ---------------------------------------------------------------------------
// Schema-driven discovery — never guess a field shape, ask knowledge_schema
// (the existing, already-real tool), per CLAUDE.md's own house rule and the
// exact precedent knowledge-split.test.ts sets for `live_test_refs`.
// ---------------------------------------------------------------------------
type FieldDescriptor = {
  name: string;
  type: string;
  required?: boolean;
  enum_values?: string[];
  element_fields?: { name: string; type: string; enum_values?: string[] }[];
};

function fieldNamesOf(field: FieldDescriptor): string[] {
  const fromElements = (field.element_fields ?? []).map((ef) => ef.name);
  if (fromElements.length > 0) return fromElements;
  const fromTypeString = /\{([^}]*)\}/.exec(field.type)?.[1]?.split(',').map((s) => s.trim()) ?? [];
  return fromTypeString;
}

// Discovers the `links` array's element key names (a relation-type key and a
// target-record key) for a given record type, at RUNTIME, via
// knowledge_schema — never by reading tools.ts or packages/schemas.
function linksFieldShape(tools: SterlingTools, recordType: string): { relKey: string; targetKey: string } {
  const schema = tools.knowledgeSchema(recordType) as unknown as { fields: FieldDescriptor[] };
  const field = schema.fields.find((f) => f.name === 'links');
  assert.ok(field, `${recordType} schema declares a 'links' field (every fixture created carries links: [])`);
  const names = fieldNamesOf(field!);
  assert.ok(names.length >= 2, "links' element shape must name at least a relation-type key and a target-record key");
  const relKey = names.find((n) => /rel|type|kind/i.test(n)) ?? names[0];
  const targetKey = names.find((n) => n !== relKey) ?? names[1];
  return { relKey, targetKey };
}

// Best-effort minimal-valid-fields synthesizer, schema-driven, used only to
// prove a barred new_record.type ('todo'/'attestation') is refused for
// BEING that type — not confounded by an incidental missing-field error.
// CAVEAT (disclosed in the header + report): this is a generic synthesizer
// and may not satisfy every required field's actual constraint (e.g. a
// nested-object shape); it is not relied on for any success-path assertion.
function minimalRequiredFields(tools: SterlingTools, type: string): Loose {
  const schema = tools.knowledgeSchema(type) as unknown as { fields: FieldDescriptor[] };
  const fields: Loose = {};
  for (const f of schema.fields) {
    if (!f.required) continue;
    if (f.enum_values && f.enum_values.length > 0) {
      fields[f.name] = f.enum_values[0];
    } else if (/\[\]|array/i.test(f.type)) {
      fields[f.name] = [];
    } else if (/bool/i.test(f.type)) {
      fields[f.name] = false;
    } else if (/number|int/i.test(f.type)) {
      fields[f.name] = 1;
    } else {
      fields[f.name] = `placeholder value for ${f.name}`;
    }
  }
  return fields;
}

// Finds a required field of `type`, other than any in `exclude`, so an
// atomicity/missing-field test can omit something genuinely required without
// hardcoding a guess at which field that is.
function pickOmittableRequiredField(tools: SterlingTools, type: string, exclude: string[]): string {
  const schema = tools.knowledgeSchema(type) as unknown as { fields: FieldDescriptor[] };
  const required = schema.fields.filter((f) => f.required && !exclude.includes(f.name));
  assert.ok(required.length > 0, `${type} schema must declare at least one required field beyond ${exclude.join(', ')}`);
  return required[0].name;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkSourceDecision(
  tools: SterlingTools,
  opts?: { slugSuffix?: string; findText?: string; fileKeys?: string[] }
): { record: Loose; find: string } {
  const find = opts?.findText ?? 'the extracted clause about widget batching stands alone';
  const record = tools.knowledgeCreate('decision', {
    title: `extract source decision ${opts?.slugSuffix ?? 'default'}`,
    statement: `Context before the clause. ${find}. Context after the clause.`,
    alternatives_rejected: [{ option: 'do nothing', reason: 'status quo does not scale' }],
    rationale: 'the batching clause needs to be independently citable',
    file_keys: opts?.fileKeys ?? ['src/widgets/batching.ts'],
  }).record as unknown as Loose;
  return { record, find };
}

function decisionNewRecordFields(overrides?: Partial<Loose>): Loose {
  return {
    title: 'extracted standalone decision',
    statement: 'This is the standalone restatement of the extracted clause.',
    alternatives_rejected: [],
    rationale: 'kept independently citable',
    ...overrides,
  };
}

function rawSupersededDecision(
  store: SterlingStore,
  opts: { oldId: string; newId: string; slug: string }
): { oldRecord: Loose; newRecord: Loose } {
  const newRecord = store.create({
    id: opts.newId,
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['sterling'],
    slug: opts.slug,
    title: opts.slug,
    statement: 'the live replacement statement',
    alternatives_rejected: [],
    rationale: 'live replacement rationale',
    file_keys: [],
  } as never) as unknown as Loose;
  const oldRecord = store.create({
    id: opts.oldId,
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'superseded',
    superseded_by: opts.newId,
    links: [],
    scope: 'project',
    stack_tags: ['sterling'],
    slug: opts.slug,
    title: opts.slug,
    statement: 'Statement of the superseded decision, containing a findable clause: THE_CLAUSE.',
    alternatives_rejected: [],
    rationale: 'superseded rationale',
    file_keys: [],
  } as never) as unknown as Loose;
  return { oldRecord, newRecord };
}

function decisionCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['decision'] }).length;
}

// Finds a required, plain (non-enum, non-array/bool/number) string field of
// `type` — schema-driven, mirrors minimalRequiredFields' own branching so the
// field named here is guaranteed to carry that synthesizer's
// `placeholder value for ${f.name}` fallback text, giving a genuine findable
// string without hardcoding a guess at the type's field names.
function firstRequiredStringField(tools: SterlingTools, type: string, exclude: string[] = []): string {
  const schema = tools.knowledgeSchema(type) as unknown as { fields: FieldDescriptor[] };
  const f = schema.fields.find(
    (fd) =>
      fd.required &&
      !exclude.includes(fd.name) &&
      !(fd.enum_values && fd.enum_values.length > 0) &&
      !/\[\]|array|bool|number|int/i.test(fd.type)
  );
  assert.ok(f, `${type} schema must declare at least one plain required string field beyond ${exclude.join(', ')}`);
  return f!.name;
}

// A VALID attestation fixture — minimalRequiredFields' generic synthesizer
// fills every plain (non-enum/array/bool/number) required field with a
// placeholder string, but attestation's `inspected_at` is a required ISO
// DATE (checked live: knowledgeCreate refused the generic placeholder with
// "inspected_at: ISO date required"), so this fixture is schema-driven for
// every other field and supplies a real ISO date only for inspected_at —
// the one field the generic synthesizer cannot satisfy.
function mkValidAttestationFields(tools: SterlingTools): Loose {
  const schema = tools.knowledgeSchema('attestation') as unknown as { fields: FieldDescriptor[] };
  const fields: Loose = {};
  for (const f of schema.fields) {
    if (!f.required) continue;
    if (f.name === 'inspected_at') {
      fields[f.name] = NOW; // required ISO date
    } else if (f.enum_values && f.enum_values.length > 0) {
      fields[f.name] = f.enum_values[0];
    } else if (/\[\]|array/i.test(f.type)) {
      fields[f.name] = [];
    } else if (/bool/i.test(f.type)) {
      fields[f.name] = false;
    } else if (/number|int/i.test(f.type)) {
      fields[f.name] = 1;
    } else {
      fields[f.name] = `placeholder value for ${f.name}`;
    }
  }
  return fields;
}

// Discovers live_test_refs' element-key names for feature_article via
// knowledge_schema, at runtime — same precedent knowledge-split.test.ts sets
// (reuses this file's own generic fieldNamesOf(), never guessed).
function liveTestRefsFieldNames(tools: SterlingTools): { acKey: string; pathsKey: string } {
  const schema = tools.knowledgeSchema('feature_article') as unknown as { fields: FieldDescriptor[] };
  const field = schema.fields.find((f) => f.name === 'live_test_refs');
  assert.ok(field, "feature_article schema declares a 'live_test_refs' field");
  const names = fieldNamesOf(field!);
  const acKey = names.find((n) => n === 'ac_id') ?? names[0];
  const pathsKey = names.find((n) => n !== acKey) ?? names[1];
  return { acKey, pathsKey };
}

// A feature_article SOURCE — feature_article is the type whose schema DOES
// define history (unlike decision, pinned above), used to pin the
// typeHasHistory TRUE branch directly rather than only its FALSE branch.
function mkSourceArticle(tools: SterlingTools, opts?: { slugSuffix?: string; findText?: string }): { record: Loose; find: string } {
  const find = opts?.findText ?? 'the extracted clause about widget batching stands alone';
  const { acKey, pathsKey } = liveTestRefsFieldNames(tools);
  const record = tools.knowledgeCreate('feature_article', {
    slug: `extract-history-source-${opts?.slugSuffix ?? 'default'}`,
    title: 'Extract history source article',
    what_it_does: `Context before the clause. ${find}. Context after the clause.`,
    intended_behavior: 'Behaves as documented.',
    files: [{ path: 'src/history/source.ts', role: 'core' }],
    current_ac: [{ ac_id: 'AC1', text: 'AC1: the core path works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [{ [acKey]: 'AC1', [pathsKey]: ['tests/ac1.test.ts'] }],
  }).record as unknown as Loose;
  return { record, find };
}

// A domain-scoped reference_material — the only type/mechanism demonstrated
// anywhere in this codebase's tests to reach domain scope directly on create
// (domain-routing.test.ts's own refFields precedent).
function domainRefFields(find: string): Loose {
  return {
    scope: 'domain:genesys',
    title: 'domain-scoped reference for extract refusal',
    kind: 'doc',
    location: 'docs/genesys-extract.md',
    summary: `Context before the clause. ${find}. Context after the clause.`,
    source_date: '2026-06-16',
    capture_date: '2026-06-16',
    basis: 'platform',
  };
}

// ===========================================================================
// Invariant 1 — HAPPY PATH + both-ways provenance (the architect-flagged
// highest-risk path, pinned unambiguously).
// ===========================================================================

test('invariant 1 — happy path: extract lifts a passage from decision.statement into a new decision; original stays live minus the claim; provenance linked BOTH ways', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'happy-path', fileKeys: ['src/happy/path.ts'] });
    const beforeSource = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const newFields = decisionNewRecordFields({ title: 'extracted standalone happy-path decision' });

    const raw = runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: newFields },
      reason: 'lift the widget-batching clause into its own citable decision',
    });
    const result = raw as unknown as { extracted: string; source: { id: string; version: number }; edges: Loose; warnings?: unknown[] };

    // --- receipt shape: Receipt {extracted, source{id,version}, edges{informed_by,cites}, warnings} ---
    // SABOTAGE: return `find` unmodified/truncated instead of the matched
    // passage for `extracted` -> this assertion goes red.
    assert.equal(
      result.extracted,
      find,
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, the receipt echoes the extracted passage verbatim'
    );
    // SABOTAGE: echo the pre-bump version in `source.version` -> red.
    assert.equal(result.source.id, source.id, 'receipt names the source id');
    assert.equal(result.source.version, (beforeSource.version as number) + 1, "receipt names the source's NEW (post-bump) version");
    // SABOTAGE: drop either key from `edges` -> red.
    assert.ok(result.edges && typeof result.edges === 'object', 'receipt carries an edges object');
    // SABOTAGE: put the WRONG record's id under informed_by (e.g. swap it
    // with cites' value, or echo the new record's own id) -> red.
    assert.equal(result.edges.informed_by, source.id, "receipt's edges.informed_by VALUE is the original source's id, not merely a present key");
    assert.ok('cites' in result.edges, "receipt's edges object names the cites edge (its VALUE is cross-checked against the links-derived id below, once discovered)");

    // --- original stays live, minus the claim ---
    const afterSource = tools.knowledgeGet(source.id as string) as unknown as Loose;
    // SABOTAGE: mint a NEW id for the trimmed original instead of updating in place -> red.
    assert.equal(afterSource.id, source.id, 'the original id is unchanged — no re-mint');
    assert.equal(afterSource.status, 'active', 'the original stays ACTIVE');
    assert.equal(afterSource.version, (beforeSource.version as number) + 1, 'the original version bumps by exactly one');
    // SABOTAGE: skip the field.replace() and leave statement untouched -> red.
    assert.equal(
      afterSource.statement,
      (beforeSource.statement as string).replace(find, ''),
      'the original field becomes field.replace(find, replace) — replace defaults to "" (empty string)'
    );

    // --- discover the new record's id via the ORIGINAL's own 'cites' edge
    // (never by guessing the receipt's undocumented internal id field) ---
    const { relKey, targetKey } = linksFieldShape(tools, 'decision');
    const afterLinks = (afterSource.links ?? []) as Loose[];
    const citesEdge = afterLinks.find((l) => l[relKey] === 'cites');
    // SABOTAGE: never write the original->new 'cites' edge -> `citesEdge` is
    // undefined and this assertion goes red (this is HALF of the both-ways pin).
    assert.ok(citesEdge, "the original's own links carry a 'cites' edge — the forward half of both-ways provenance");
    const newId = citesEdge![targetKey] as string;
    // SABOTAGE: put the WRONG record's id under edges.cites (e.g. echo
    // source.id or the informed_by value instead of the new record's own id)
    // -> this equality goes red.
    assert.equal(result.edges.cites, newId, "receipt's edges.cites VALUE equals the new record's own id, cross-checked against the links-derived id (never guessed)");

    // --- the new record: caller's type+fields, active, project scope ---
    const newRecord = tools.knowledgeGet(newId) as unknown as Loose;
    assert.equal(newRecord.type, 'decision', 'the new record is the caller-chosen type');
    assert.equal(newRecord.status, 'active');
    // SABOTAGE: hardcode scope:'domain' on the new record -> red (Q5: extract never crosses scope).
    assert.equal(newRecord.scope, 'project', "extract does not cross scope — new record inherits the source's project scope");
    assert.equal(newRecord.version, 1, 'the new record starts at version 1');
    // SABOTAGE: silently reuse the SOURCE's title/statement instead of the caller's new_record.fields -> red.
    assert.equal(newRecord.title, newFields.title, 'the new record carries the caller-authored fields verbatim');
    assert.equal(newRecord.statement, newFields.statement, "the new record carries the caller-authored statement verbatim, NOT a copy of the extracted passage");
    assert.equal(newRecord.rationale, newFields.rationale);

    // --- BOTH-WAYS provenance, unambiguous (the architect-flagged
    // highest-risk path): new --informed_by--> original AND
    // original --cites--> new, each a REAL row readable via the OWNING
    // record's own `links` array. ---
    const newLinks = (newRecord.links ?? []) as Loose[];
    // SABOTAGE: write only the forward (cites) edge and skip addLink(new,
    // informed_by, original) -> this assertion goes red (the OTHER half of
    // the both-ways pin — together with the citesEdge assertion above, this
    // is the single highest-risk behavior in the whole spec).
    assert.ok(
      newLinks.some((l) => l[relKey] === 'informed_by' && l[targetKey] === source.id),
      "the new record's links carry an 'informed_by' edge targeting the original — the backward half of both-ways provenance (same edge shape knowledge_promote writes)"
    );
    assert.ok(
      afterLinks.some((l) => l[relKey] === 'cites' && l[targetKey] === newId),
      "the original's links carry a 'cites' edge targeting the new record — the forward half of both-ways provenance, re-asserted explicitly"
    );

    // --- history: PRE-ADJUDICATED (conductor-sanctioned, resumed from stash) —
    // decision's schema defines NO history field (typeHasHistory guard,
    // tools.ts:3944), so the correct pinned behavior is that extract appends
    // NOTHING and the record still carries no history field, not that a
    // one-entry-longer array exists. Confirmed schema-driven (never guessed)
    // and asserted as absence, not as a `.length` off an undefined array. ---
    const decisionSchema = tools.knowledgeSchema('decision') as unknown as { fields: FieldDescriptor[] };
    assert.ok(
      !decisionSchema.fields.some((f) => f.name === 'history'),
      'sanity: decision schema declares no history field — the typeHasHistory guard governs this type'
    );
    // SABOTAGE: fabricate a history field/entry on a type whose schema
    // defines none -> either assertion below goes red.
    assert.equal(beforeSource.history, undefined, 'sanity: no history field on the source before extract either');
    assert.equal(afterSource.history, undefined, 'no history field/entry is fabricated on the original — decision defines no history field');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 2 — EXACTLY-ONCE carriage. Control FIRST.
// ===========================================================================

test('invariant 2 control: find matching the field EXACTLY ONCE succeeds — necessary control before the zero/two-match refusals below', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'exactly-once-control' });
    const raw = runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
    });
    // SABOTAGE: make the exactly-once gate refuse ALL calls unconditionally
    // -> this control goes red, which is exactly what proves B1/B2 below are
    // not dead detectors (an always-refuse implementation would otherwise
    // pass both of them for the wrong reason).
    assert.ok(raw, 'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, an exactly-once find succeeds and returns a receipt');
    const after = tools.knowledgeGet(source.id as string) as unknown as Loose;
    assert.equal((after.statement as string).includes(find), false, 'the matched passage is gone from the field after a successful extract');
  } finally {
    cleanup();
  }
});

test('invariant 2: find matching ZERO times in the field is refused, reporting the character count; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source } = mkSourceDecision(tools, { slugSuffix: 'zero-match' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    const absentFind = 'this exact phrase is absent from the statement entirely';

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find: absentFind,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      (err: Error) => {
        assert.match(err.message, /0|zero/i, 'the refusal reports zero occurrences');
        assert.match(err.message, /\d/, 'the refusal reports a character count');
        return true;
      },
      // SABOTAGE: silently no-op (leave the field untouched, refuse nothing) OR
      // silently create the new record anyway on a zero-match find -> this
      // assert.throws goes red ("Missing expected exception").
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a zero-match find is refused, reporting the (zero) character count'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source is byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
  } finally {
    cleanup();
  }
});

test('invariant 2 + invariant 3 (find-ambiguous arm): find matching TWICE in the field is refused ("extend find"); nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const twiceFind = 'REPEATED_CLAUSE_MARKER';
    const source = tools.knowledgeCreate('decision', {
      title: 'extract source decision two-match',
      statement: `First ${twiceFind} occurrence. Second ${twiceFind} occurrence, deliberately duplicated.`,
      alternatives_rejected: [],
      rationale: 'two-match fixture',
      file_keys: [],
    }).record as unknown as Loose;
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find: twiceFind,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /extend find/i,
      // SABOTAGE: extract on the FIRST match only (String.replace's natural
      // behavior) without ever checking occurrence count -> the call would
      // silently succeed instead of throwing, so "Missing expected exception".
      "EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a two-match find is refused with the 'extend find' message, matching knowledge_edit's own convention"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract (atomicity: find-ambiguous arm)');
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created (atomicity: find-ambiguous arm)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 3 — ATOMICITY. Each sabotage arm paired with a control placed
// first (the find-ambiguous arm is already covered by the test immediately
// above, with its own control immediately above that).
// ===========================================================================

test('invariant 3 control: new_record carrying every required field for its type succeeds — the store gains exactly one new record', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'control-fields' });
    const before_count = decisionCount(tools);

    runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
    });

    assert.equal(
      decisionCount(tools),
      before_count + 1,
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a complete new_record succeeds and the store gains exactly one decision'
    );
  } finally {
    cleanup();
  }
});

test('invariant 3: new_record missing a required field for its type is refused — nothing written (byte-identical source, no orphan new record, no dangling edge)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'missing-field' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    const omit = pickOmittableRequiredField(tools, 'decision', ['title', 'statement']);
    const fields = decisionNewRecordFields();
    delete fields[omit];

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields },
        }),
      new RegExp(omit, 'i'),
      // SABOTAGE: call knowledgeCreate(new) but validate its schema AFTER
      // already having applied the update to the original (wrong order) ->
      // either this assert.throws fails ("Missing expected exception") if
      // the field ends up optional in practice, or the byte-identical check
      // below fails because the original was mutated before the failed
      // create rolled back.
      `EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a new_record missing its required '${omit}' field must be refused, naming it`
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source is byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

test('invariant 3 + invariant 6 control: resolves naming a genuine reconcile_needed item on the source\'s chain is closed by the extract\'s source-update', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'resolves-control', fileKeys: ['src/resolves/control.ts'] });
    const item = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `decision '${source.title as string}' needs its extracted-clause debt reconciled`,
      file_keys: ['src/resolves/control.ts'],
    });

    runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
      resolves: [item.record.id],
    });

    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(
      !open.some((t) => (t as unknown as Loose).id === item.record.id),
      // SABOTAGE: never drain `resolves` at all (always leave every named
      // item open) -> this assertion goes red.
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, the item named in resolves is closed by a successful extract'
    );
  } finally {
    cleanup();
  }
});

test('invariant 3: resolves naming a NON-EXISTENT id is refused — nothing written (byte-identical source, no orphan new record)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'resolves-bogus' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
          resolves: ['00000000-0000-0000-0000-000000000000'],
        }),
      Error,
      // SABOTAGE: validate `resolves` AFTER the transaction commits (or skip
      // validating it entirely, treating an unknown id as a silent no-op) ->
      // "Missing expected exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a resolves id that resolves to nothing must be refused'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source is byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 4 — REFUSAL SHAPES, each writing nothing.
// ===========================================================================

test('invariant 4: a non-resolving id is refused, naming it; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const before_count = decisionCount(tools);
    assert.throws(
      () =>
        runExtract(tools, {
          id: 'does-not-exist-anywhere',
          field: 'statement',
          find: 'anything',
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /does-not-exist-anywhere|not found|unresolvable/i,
      // SABOTAGE: skip id resolution entirely and let a later step throw an
      // unrelated low-context error, or silently create the new record
      // regardless -> either the regex fails to match or "Missing expected
      // exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a non-resolving id is refused, naming it'
    );
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
  } finally {
    cleanup();
  }
});

test('invariant 4: a non-active (superseded) source is refused; nothing written', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { oldRecord } = rawSupersededDecision(store, { oldId: randomUUID(), newId: randomUUID(), slug: 'extract-superseded-source' });
    const before_count = decisionCount(tools);
    assert.throws(
      () =>
        runExtract(tools, {
          id: oldRecord.id,
          field: 'statement',
          find: 'THE_CLAUSE',
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      // Permissive on wording — see header ambiguity #2: this could be
      // extract's own active-guard OR the stale-address version-conflict
      // redirect firing first during resolution.
      /active|superseded|version conflict/i,
      // SABOTAGE: skip the active-status guard and extract straight from a
      // superseded row -> "Missing expected exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a superseded (non-active) source must be refused before any write'
    );
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
    assert.equal((tools.knowledgeGet(oldRecord.id as string) as unknown as Loose).status, 'superseded', 'the superseded source is untouched');
  } finally {
    cleanup();
  }
});

test('invariant 4: an empty find string is refused; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source } = mkSourceDecision(tools, { slugSuffix: 'empty-find' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find: '',
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /find/i,
      // SABOTAGE: treat '' as a valid needle (JS split('') behaves oddly but
      // is not "zero occurrences") and let it fall through to the
      // exactly-once machinery unchecked -> "Missing expected exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, an empty find string is refused'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
  } finally {
    cleanup();
  }
});

test('invariant 4: an unknown field name is refused, naming it; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source } = mkSourceDecision(tools, { slugSuffix: 'unknown-field' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'nonexistent_field',
          find: 'x',
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /nonexistent_field/i,
      // SABOTAGE: use bracket-property access on the record without
      // validating `field` against the type's known string fields -> either
      // it throws a generic/unnamed TypeError (regex fails) or silently
      // treats undefined as '' and proceeds -> "Missing expected exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, an unknown field is refused, naming it'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
  } finally {
    cleanup();
  }
});

test('invariant 4: a non-string field (e.g. alternatives_rejected, an array) is refused; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source } = mkSourceDecision(tools, { slugSuffix: 'non-string-field' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'alternatives_rejected',
          find: 'x',
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /alternatives_rejected|string/i,
      // SABOTAGE: call .replace()/.split() on whatever `field` resolves to
      // without a string-type guard -> either it throws an uncaught
      // low-context runtime TypeError (regex fails to match) instead of a
      // named refusal, or coerces the array to a string and "succeeds"
      // wrongly -> "Missing expected exception".
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a non-string field is refused'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new record created');
  } finally {
    cleanup();
  }
});

test("invariant 4: new_record.type 'todo' is a barred extraction target; nothing written", () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'barred-todo' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    const fields = minimalRequiredFields(tools, 'todo');
    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'todo', fields },
        }),
      /todo/i,
      // SABOTAGE: drop the UNPROMOTABLE-style type-bar check for extract
      // targets, allowing any registered type through -> "Missing expected
      // exception" (a new todo record would actually be created).
      "EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, new_record.type 'todo' is refused as a barred target (mirrors promote's UNPROMOTABLE)"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

test("invariant 4: new_record.type 'attestation' is a barred extraction target; nothing written", () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'barred-attestation' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    const fields = minimalRequiredFields(tools, 'attestation');
    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'attestation', fields },
        }),
      /attestation/i,
      // SABOTAGE: same as the todo case — drop the type-bar check -> "Missing
      // expected exception".
      "EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, new_record.type 'attestation' is refused as a barred target (mirrors promote's UNPROMOTABLE)"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 5 — the original loses EXACTLY the claim (a diff of the whole
// record).
// ===========================================================================

test('invariant 5: the original loses exactly the claim — every field except the edited field, history, links, and version is byte-identical before/after', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'diff-precision', fileKeys: ['src/diff/precision.ts'] });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;

    runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
    });

    const after = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const { relKey } = linksFieldShape(tools, 'decision');

    // SABOTAGE: forget the replace() and leave statement untouched -> red.
    assert.equal(
      after.statement,
      (before.statement as string).replace(find, ''),
      'statement === before.statement.replace(find, "") (replace defaults to empty string)'
    );
    // SABOTAGE: bump version twice (once for the create's back-reference,
    // once for the field edit) -> red.
    assert.equal(after.version, (before.version as number) + 1, 'version bumps by exactly one');

    // PRE-ADJUDICATED (conductor-sanctioned, resumed from stash): decision's
    // schema defines NO history field (typeHasHistory guard, tools.ts:3944),
    // so the diff-precision invariant here is absence, not a longer array —
    // asserted directly rather than dereferencing `.length` on undefined.
    // SABOTAGE: fabricate a history field/entry on a type whose schema
    // defines none -> either assertion below goes red.
    assert.equal(before.history, undefined, 'sanity: no history field on the source before extract either');
    assert.equal(after.history, undefined, 'no history field/entry is fabricated on the original — decision defines no history field');

    const beforeLinks = (before.links ?? []) as Loose[];
    const afterLinks = (after.links ?? []) as Loose[];
    // SABOTAGE: write the cites edge TWICE (once eagerly, once in a retry
    // path) -> this length check goes red.
    assert.equal(afterLinks.length, beforeLinks.length + 1, 'exactly one link entry added to the original');
    const addedLinks = afterLinks.filter((l) => !beforeLinks.some((b) => JSON.stringify(b) === JSON.stringify(l)));
    assert.equal(addedLinks.length, 1);
    assert.equal(addedLinks[0][relKey], 'cites', 'the single added link is the cites edge');

    const exempt = new Set(['statement', 'version', 'history', 'links', 'updated_at']);
    for (const key of Object.keys(before)) {
      if (exempt.has(key)) continue;
      // SABOTAGE: incidentally overwrite an unrelated field (e.g. rationale,
      // file_keys, title, stack_tags) while applying the edit -> this
      // per-field deepEqual goes red on exactly that field.
      assert.deepEqual(after[key], before[key], `field '${key}' must be byte-identical before/after — the extract must not touch anything but the edited field, history, links, and version`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 6 — resolves PLAIN LANE: the positive case is already pinned by
// the "invariant 3 + invariant 6 control" test above. These pin the negative
// cases: off-chain and wrong-lane.
// ===========================================================================

test("invariant 6: resolves naming an item OFF the source's chain (file_keys do not overlap) is refused; nothing written, the item stays open", () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'resolves-off-chain', fileKeys: ['src/off-chain/owned.ts'] });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    const item = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: 'unrelated reconcile debt, no relation to the off-chain source decision',
      file_keys: ['completely/unrelated/path.ts'],
    });

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
          resolves: [item.record.id],
        }),
      Error,
      // SABOTAGE: drain ANY item named in `resolves` regardless of whether it
      // is actually on the source's chain -> "Missing expected exception".
      "EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, resolves naming an off-chain item is refused"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(open.some((t) => (t as unknown as Loose).id === item.record.id), 'the off-chain item stays open, untouched by the refused extract');
  } finally {
    cleanup();
  }
});

test('invariant 6: resolves naming a promotion_review item is refused — a human gate never drains through an extract, even when on-chain; nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'resolves-wrong-lane', fileKeys: ['src/wrong-lane/owned.ts'] });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);
    // deliberately ON-chain (file_keys overlap the source) to isolate the
    // lane check from the chain-membership check pinned by the previous test
    const item = tools.maintenanceEnqueue({
      reason: 'promotion_review',
      text: `promotion review pending for '${source.title as string}'`,
      file_keys: ['src/wrong-lane/owned.ts'],
    });

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
          resolves: [item.record.id],
        }),
      /promotion_review/i,
      // SABOTAGE: gate resolves only on chain-membership (file_keys overlap)
      // without checking the item's `reason` against the plain lane's
      // allowed set (reconcile_needed, refresh_reference) -> "Missing
      // expected exception" (a human review gate would silently drain).
      "EXPECTED FAILURE (red): TypeError before this line — knowledgeExtract does not exist yet. Once built, a promotion_review item named in resolves is refused by name, even on-chain"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(open.some((t) => (t as unknown as Loose).id === item.record.id), 'the promotion_review item stays open, untouched by the refused extract');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 7 — SCOPE GUARD. new_record.fields.scope explicitly set and
// DIFFERENT from the source's scope is refused, naming both values; set and
// IDENTICAL succeeds. Uses domainHarness() so 'domain:genesys' is an actually
// MOUNTED, valid scope — isolating the mismatch guard from an unrelated
// unmounted-domain error. Control FIRST.
// ===========================================================================

test('scope guard control: new_record.fields.scope explicitly set and IDENTICAL to the source scope succeeds — extract completes normally', () => {
  const { tools, cleanup } = domainHarness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'scope-identical' });
    assert.equal(source.scope, 'project', 'sanity: the source is project-scoped by default');
    const before_count = decisionCount(tools);

    const raw = runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields({ scope: 'project' }) },
    });
    // SABOTAGE: treat ANY explicit new_record.fields.scope as a mismatch,
    // even one identical to the source's own scope -> this call throws
    // instead of succeeding, `raw` is never reached.
    assert.ok(raw, 'an explicit scope identical to the source scope must succeed, not be treated as a mismatch');
    assert.equal(decisionCount(tools), before_count + 1, 'the store gains exactly one new decision');
  } finally {
    cleanup();
  }
});

test("scope guard: new_record.fields.scope explicitly set and DIFFERENT from the source's scope is refused, naming both values; nothing written", () => {
  const { tools, cleanup } = domainHarness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'scope-mismatch' });
    assert.equal(source.scope, 'project', 'sanity: the source is project-scoped by default');
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionNewRecordFields({ scope: 'domain:genesys' }) },
        }),
      /project[\s\S]*domain:genesys|domain:genesys[\s\S]*project/i,
      // SABOTAGE: never validate new_record.fields.scope against the
      // source's scope at all (let it flow straight into the create) -> the
      // scope silently crosses instead of refusing -> "Missing expected
      // exception".
      "a new_record.fields.scope explicitly different from the source's scope must be refused, naming BOTH values"
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 8 — LITERAL REPLACEMENT. A replace string containing $-patterns
// (e.g. "$&") must land LITERALLY, never JS String.replace's special
// $-substitution expansion (which would re-insert the extracted passage).
// ===========================================================================

test('literal replacement: replace text containing $-substitution patterns (e.g. "$&") lands LITERALLY in the source field, never re-inserting the extracted passage', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceDecision(tools, { slugSuffix: 'literal-replace' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const replace = 'pre-$&-post';

    runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      replace,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
    });

    const after = tools.knowledgeGet(source.id as string) as unknown as Loose;
    // Expected value computed via a REPLACER FUNCTION (the only String API
    // that bypasses $-pattern expansion), never by string-concatenating the
    // pieces by hand — same "compute, don't hardcode" idiom the file already
    // uses for the plain replace() checks above.
    // SABOTAGE: implement via the naive `field.replace(find, replace)` with
    // BOTH arguments as plain strings — JS honors $&/$$/etc. even when the
    // search pattern is a string, so "$&" re-inserts the WHOLE matched
    // passage -> both assertions below go red (the equality, and the
    // "extracted passage is gone" check, since it would silently reappear
    // wrapped in "pre-...-post").
    assert.equal(
      after.statement,
      (before.statement as string).replace(find, () => replace),
      'the replace text lands LITERALLY — a replacer FUNCTION is the only way this exact byte sequence results without $-pattern expansion'
    );
    assert.ok(
      (after.statement as string).includes('pre-$&-post'),
      'the literal replace string, including its literal "$&" characters, must appear verbatim in the field'
    );
    assert.ok(
      !(after.statement as string).includes(find),
      'the extracted passage itself must be GONE — a naive $-pattern expansion would have silently re-inserted it'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 9 — ATTESTATION SOURCE. Extracting FROM an attestation is
// refused: an attestation's only mutation path is auto-supersession
// (knowledge_update mints a new active row); extract's update-in-place
// contract cannot apply to it.
// ===========================================================================

test('attestation source: extracting FROM an attestation record is refused, referencing the supersession/stays-live conflict; attestation untouched (same version, still active)', () => {
  const { tools, cleanup } = harness();
  try {
    const fields = mkValidAttestationFields(tools);
    const created = tools.knowledgeCreate('attestation', fields) as unknown as { record: Loose };
    const source = created.record;
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    // exclude inspected_at: it is a required plain-string-typed field by the
    // generic schema shape but carries an ISO date, not free text — picking
    // it here would still work mechanically but obscures the fixture's intent
    const targetField = firstRequiredStringField(tools, 'attestation', ['inspected_at']);
    const findText = fields[targetField] as string; // this fixture's own text for that field

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: targetField,
          find: findText,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /supersed|stays?.?live|attestation/i,
      // SABOTAGE: apply extract's ordinary "update the source field in
      // place, stays active" contract to an attestation too (skip the
      // type-level guard that bars it) -> "Missing expected exception" (the
      // attestation's field would actually be edited in place).
      "extracting from an attestation must be refused — its only mutation path is auto-supersession, which conflicts with extract's stays-live update-in-place contract"
    );
    const after = tools.knowledgeGet(source.id as string) as unknown as Loose;
    assert.equal(after.version, before.version, 'the attestation version is unchanged — no supersession, no in-place edit');
    assert.equal(after.status, 'active', 'the attestation stays active, untouched by the refused extract');
    assert.deepEqual(after, before, 'the attestation is byte-identical after the refused extract');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 10 — DOMAIN SOURCE. Extracting FROM a domain-scoped source is
// refused loudly, naming the domain scope. The file's default harness()
// wraps a plain project-only SterlingStore and genuinely CANNOT mint a
// domain-scoped record — domainHarness() (declared above, mirroring
// domain-routing.test.ts's own precedent) is what makes this reachable, not
// faked.
// ===========================================================================

test('domain source: extracting FROM a domain-scoped source record is refused loudly, naming the domain scope; nothing written', () => {
  const { tools, cleanup } = domainHarness();
  try {
    const find = 'the domain-owned clause that must never be extracted from here';
    const created = tools.knowledgeCreate('reference_material', domainRefFields(find)) as unknown as { record: Loose };
    const source = created.record;
    assert.equal(source.scope, 'domain:genesys', 'sanity: the source really landed domain-scoped');
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const before_count = decisionCount(tools);

    assert.throws(
      () =>
        runExtract(tools, {
          id: source.id,
          field: 'summary',
          find,
          new_record: { type: 'decision', fields: decisionNewRecordFields() },
        }),
      /domain:genesys|domain/i,
      // SABOTAGE: apply extract's ordinary project-source update-in-place
      // path to a domain-scoped source too (skip the domain-source bar
      // entirely) -> "Missing expected exception".
      'extracting from a domain-scoped source must be refused loudly, naming the domain scope'
    );
    assert.deepEqual(tools.knowledgeGet(source.id as string), before, 'domain source byte-identical after the refused extract');
    assert.equal(decisionCount(tools), before_count, 'no orphan new decision record created');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Invariant 11 — HISTORY TRUE-BRANCH. feature_article's schema DOES define
// history (unlike decision, pinned throughout as the FALSE branch above) —
// this pins the other half directly, so deleting the typeHasHistory block
// goes red here even if it happened to survive on a no-history type.
// ===========================================================================

test('history TRUE-branch: extracting from a feature_article source appends EXACTLY ONE history entry referencing the extraction', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: source, find } = mkSourceArticle(tools, { slugSuffix: 'history-true-branch' });
    const before = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const beforeHistory = (before.history ?? []) as Loose[];
    assert.ok(beforeHistory.length > 0, 'sanity: the fixture seeds a non-empty history so the +1 delta is unambiguous');

    runExtract(tools, {
      id: source.id,
      field: 'what_it_does',
      find,
      new_record: { type: 'decision', fields: decisionNewRecordFields() },
    });

    const after = tools.knowledgeGet(source.id as string) as unknown as Loose;
    const afterHistory = (after.history ?? []) as Loose[];
    // SABOTAGE: delete/no-op the typeHasHistory append block entirely (or
    // gate it so it never fires for ANY type, matching decision's correct
    // no-op) -> afterHistory.length stays equal to beforeHistory.length,
    // this assertion goes red.
    assert.equal(afterHistory.length, beforeHistory.length + 1, 'exactly one history entry appended to a type that DOES define history (feature_article)');
    // SABOTAGE: rewrite/reorder an existing history entry instead of only
    // appending -> red.
    assert.deepEqual(afterHistory.slice(0, beforeHistory.length), beforeHistory, 'the seeded history is preserved verbatim, in order — extract only appends');
    const added = afterHistory[afterHistory.length - 1];
    // SABOTAGE: append a generic/unrelated history entry disconnected from
    // this extract (e.g. a blank/boilerplate stub) -> this assertion goes red.
    assert.match(JSON.stringify(added), /extract/i, "the appended entry's own text references the extraction (not a generic/unrelated stub)");
  } finally {
    cleanup();
  }
});
