import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// board db0e2799: knowledge_schema(type) reports each TOP-LEVEL field with
// required/type/enum_values, derived from the registered zod schema — but an
// enum nested INSIDE an array-element object field (e.g. files[]'s `role`,
// current_ac[]'s `verifiable_at`) is invisible in that report. A writer only
// discovers the element shape (and any closed enum inside it) by getting
// each sub-field rejected one at a time — the reported incident was 8
// validation errors on a single feature_article create.
//
// ENVELOPE-KEY ASSUMPTION (flagged per the work order): these tests assume
// the nested shape rides on each field descriptor as `element_fields`, an
// array of `{ name, type, enum_values? }` entries — the same shape already
// used for top-level fields — attached only to fields whose top-level type
// reads as an array-of-objects (e.g. '{path, role}[]'). If the implementer
// names the envelope key differently, rename here consciously; the point
// under test is that the nested shape (and any nested closed enum) is
// reported AT ALL, not the exact key name chosen for it.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-schema-nested-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type FieldDescriptor = {
  name: string;
  type: string;
  enum_values?: string[];
  element_fields?: { name: string; type: string; enum_values?: string[] }[];
};

// Structural invariant shared by every assertion below: whatever the nested
// shape is called, every element field it lists must at minimum name itself
// and describe its type as a non-empty string — and if it carries a closed
// enum, that enum must be a non-empty array. This never pins exact field
// names/values beyond what the interface slice + existing passing tests
// already establish (path/role on files[], ac_id/text/verifiable_at on
// current_ac[], option/reason on alternatives_rejected[]).
function assertWellFormedElementFields(elementFields: unknown, label: string) {
  assert.ok(Array.isArray(elementFields), `${label}: element_fields must be a non-empty array — TODAY this is undefined, the field descriptor has no nested-shape key at all`);
  const arr = elementFields as { name?: unknown; type?: unknown; enum_values?: unknown }[];
  assert.ok(arr.length > 0, `${label}: element_fields must describe at least one sub-field`);
  for (const ef of arr) {
    assert.equal(typeof ef.name, 'string', `${label}: every element field carries a name`);
    assert.ok((ef.name as string).length > 0, `${label}: element field name is non-empty`);
    assert.equal(typeof ef.type, 'string', `${label}: every element field carries a type`);
    assert.notEqual(ef.type, 'unknown', `${label}: no undescribed nested field types`);
    if ('enum_values' in ef) {
      assert.ok(Array.isArray(ef.enum_values) && (ef.enum_values as unknown[]).length > 0, `${label}: a sub-field reporting enum_values must report a non-empty closed set, never an empty or missing one`);
    }
  }
}

test('AC1: knowledge_schema(feature_article) describes files[] element sub-fields (path, role) with types, nested inside the files field report', () => {
  const { tools, cleanup } = harness();
  try {
    const art = tools.knowledgeSchema('feature_article');
    const filesField = art.fields.find((f) => f.name === 'files') as FieldDescriptor | undefined;
    assert.ok(filesField, 'files field is reported at the top level (unchanged)');
    // Unchanged top-level shape. Amended 2026-08-20: the blind-authored literal
    // predated files[]'s optional `unverified` (state-honesty, decision
    // 2e112490) — the reported string reflects the live schema.
    assert.equal(filesField?.type, '{path, role, unverified}[]');

    // RED: the element shape itself (path/role, with their own types, and
    // any closed enum among them) must now be nested on this descriptor.
    assertWellFormedElementFields(filesField?.element_fields, "feature_article.files' element_fields");
    const names = (filesField!.element_fields ?? []).map((ef) => ef.name);
    assert.ok(names.includes('path'), 'files[] element reports its path sub-field');
    assert.ok(names.includes('role'), 'files[] element reports its role sub-field');
  } finally {
    cleanup();
  }
});

test('AC2: knowledge_schema(feature_article) describes current_ac[] element sub-fields likewise (ac_id, text, and whatever else the schema defines)', () => {
  const { tools, cleanup } = harness();
  try {
    const art = tools.knowledgeSchema('feature_article');
    const acField = art.fields.find((f) => f.name === 'current_ac') as FieldDescriptor | undefined;
    assert.ok(acField, 'current_ac field is reported at the top level (unchanged)');

    // RED: same structural requirement — non-empty, each sub-field named +
    // typed, and no sub-field with a closed enum left without enum_values.
    assertWellFormedElementFields(acField?.element_fields, "feature_article.current_ac' element_fields");
    const names = (acField!.element_fields ?? []).map((ef) => ef.name);
    assert.ok(names.includes('ac_id'), 'current_ac[] element reports its ac_id sub-field');
    assert.ok(names.includes('text'), 'current_ac[] element reports its text sub-field');
    // We deliberately do NOT assert the exact enum values of verifiable_at
    // (or assume it is even the closed field) — that would be guessing past
    // the interface slice. The structural invariant inside
    // assertWellFormedElementFields already forces: IF any current_ac[]
    // sub-field reports enum_values, that set is non-empty and visible here,
    // never requiring a rejected write to discover it.
  } finally {
    cleanup();
  }
});

test('AC3: knowledge_schema(decision) describes alternatives_rejected[] element sub-fields (option, reason)', () => {
  const { tools, cleanup } = harness();
  try {
    const dec = tools.knowledgeSchema('decision');
    const altsField = dec.fields.find((f) => f.name === 'alternatives_rejected') as FieldDescriptor | undefined;
    assert.ok(altsField, 'alternatives_rejected field is reported at the top level (unchanged)');
    // Unchanged top-level shape, per the existing passing schema test.
    assert.equal(altsField?.type, '{option, reason}[]');

    // RED: the element shape (option/reason, each with its own type) nested
    // on the descriptor — this is the exact shape the feedback's 8 rejected
    // writes were trying to learn by trial and error.
    assertWellFormedElementFields(altsField?.element_fields, "decision.alternatives_rejected' element_fields");
    const names = (altsField!.element_fields ?? []).map((ef) => ef.name);
    assert.ok(names.includes('option'), 'alternatives_rejected[] element reports its option sub-field');
    assert.ok(names.includes('reason'), 'alternatives_rejected[] element reports its reason sub-field');
  } finally {
    cleanup();
  }
});

test('AC4 (regression): top-level enum reporting and required/optional list shape are unchanged by the nested-enum fix', () => {
  const { tools, cleanup } = harness();
  try {
    // research_finding.volatility_hint is a TOP-LEVEL closed enum (not nested
    // inside an array element) — must keep reporting exactly as before.
    const vol = tools.knowledgeSchema('research_finding').fields.find((f) => f.name === 'volatility_hint');
    assert.ok(vol, 'volatility_hint is still reported');
    assert.deepEqual(vol?.enum_values, ['fast', 'medium', 'stable'], 'top-level enum values unchanged by the nested-enum fix');

    // required/optional stay flat string arrays — the nested-shape work must
    // not fold element sub-field names into these top-level lists.
    const dec = tools.knowledgeSchema('decision');
    assert.ok(Array.isArray(dec.required) && dec.required.every((f) => typeof f === 'string'));
    assert.ok(Array.isArray(dec.optional) && dec.optional.every((f) => typeof f === 'string'));
    assert.ok(dec.required.includes('title'));
    assert.ok(dec.required.includes('statement'));
    assert.ok(dec.required.includes('rationale'));
    assert.ok(dec.optional.includes('file_keys'));
    // No sub-field name (e.g. 'option', 'reason') leaked into the top-level
    // required/optional lists as if it were a field of `decision` itself.
    assert.ok(!dec.required.includes('option') && !dec.optional.includes('option'));
    assert.ok(!dec.required.includes('reason') && !dec.optional.includes('reason'));

    const art = tools.knowledgeSchema('feature_article');
    for (const f of ['slug', 'history', 'live_test_refs']) {
      assert.ok(art.required.includes(f), `${f} still reported required — unchanged`);
    }
    // test-repair 2026-08-22: version/status/superseded_by are server-owned
    // under stable-identity-design-v2 — never caller-required (mirrors pin
    // S3-10a/S3-10b in stable-identity-tools.test.ts). [stable-identity-design-v2]
    assert.ok(!art.required.includes('version'), 'version is server-owned — never caller-required');
    assert.ok(art.fields.some((f) => f.name === 'version'), 'version is still reported as a field');
    assert.ok(!art.required.includes('status'), 'status is server/lifecycle-derived — never caller-required');
    assert.ok(!art.required.includes('superseded_by'), 'superseded_by is server/relation-derived — never caller-required');
    assert.ok(art.optional.includes('concept_family'), 'concept_family still optional — unchanged');
    assert.equal(art.fields.find((f) => f.name === 'concept_family')?.type, 'string');
    // No files[]/current_ac[] sub-field name leaked into the top-level lists.
    for (const leaked of ['path', 'role', 'ac_id', 'text']) {
      assert.ok(!art.required.includes(leaked), `${leaked} must not leak into feature_article's top-level required list`);
      assert.ok(!art.optional.includes(leaked), `${leaked} must not leak into feature_article's top-level optional list`);
    }
  } finally {
    cleanup();
  }
});
