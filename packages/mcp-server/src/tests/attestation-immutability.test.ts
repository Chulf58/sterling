// ---------------------------------------------------------------------------
// Behavior pins for the `attestation` record type's IMMUTABILITY (decision
// a7dbac2f-6d2f-43fa-b890-22a08c2aace5, "attestation record type: a HUMAN
// inspected an artifact and ruled on it — immutable, artifact-keyed, the
// queryable progress ledger", board 259a455f). The type already ships
// (built 2026-08-21) and today only has SCHEMA-SHAPE coverage
// (packages/schemas/src/tests/schemas.test.ts validates the zod shape) —
// nothing exercises it end-to-end through the MCP tool surface. This file
// pins that surface-level behavior.
//
// Required fields discovered via knowledge_schema('attestation') AT RUNTIME
// (CLAUDE.md: "ask the schema instead of guessing it") rather than hardcoded
// from memory of the decision text — the fixture-richness guard test below
// asserts the schema names artifact_key/verdict/inspector/inspected_at
// required BEFORE any other test in this file relies on that fixture shape.
//
// Written BLIND to tools.ts / packages/schemas/src/records.ts. Read for
// harness convention only: knowledge-supersede.test.ts and
// id-resolution.test.ts (harness skeleton, `tools.knowledgeSchema(type)`
// call/response shape `{fields, required, optional}` per
// schema-nested-enums.test.ts, which this file also read for that same
// call convention).
//
// RESOLVED 2026-08-22 BY DEBUGGER ADJUDICATION (no product defect; the
// original draft's refusal guess was wrong): attestation follows the SAME
// decision-style AUTO-SUPERSEDE shape as decision/anti_pattern/
// research_finding — knowledge_update (and knowledge_edit, which delegates
// to it) mints a NEW active version and marks the original superseded,
// rather than refusing. This is exactly what decision a7dbac2f states ("a
// re-inspection or changed verdict is a NEW attestation superseding the
// old"; alternatives_rejected explicitly rejects mutable in-place editing)
// and what the code comment above SUPERSEDE_ALLOWED_TYPES confirms:
// attestation is deliberately EXCLUDED from knowledge_supersede's allowed
// old-record types precisely BECAUSE knowledge_update's ordinary
// fix-forward path already IS its supersession mechanism — a second,
// dedicated supersede path would be redundant, not because attestation is
// immutable in the refuse-outright sense. (b)/(c)/(d) below are re-pinned
// to this verified shape; (a)'s create/enum/schema tests were already
// correct and are unchanged.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-22T12:00:00.000Z';

type Loose = Record<string, unknown>;
type SchemaReport = {
  required: string[];
  optional: string[];
  fields: { name: string; type: string; enum_values?: string[] }[];
};

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attestation-immutability-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function schemaOf(tools: SterlingTools, type: string): SchemaReport {
  return (tools as unknown as { knowledgeSchema: (t: string) => SchemaReport }).knowledgeSchema(type);
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function attestationCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['attestation'] }).length;
}

function mkAttestationFields(overrides: Loose = {}): Loose {
  return {
    artifact_key: 'part-0042',
    verdict: 'approved',
    inspector: 'jane.doe',
    inspected_at: NOW,
    ...overrides,
  };
}

// ===========================================================================
// (a) knowledge_create with the required fields succeeds
// ===========================================================================

test('attestation (a): knowledge_schema names artifact_key/verdict/inspector/inspected_at as required (fixture-richness guard)', () => {
  const { tools, cleanup } = harness();
  try {
    const schema = schemaOf(tools, 'attestation');
    for (const f of ['artifact_key', 'verdict', 'inspector', 'inspected_at']) {
      assert.ok(schema.required.includes(f), `EXPECTED GREEN: knowledge_schema('attestation').required names '${f}' per decision a7dbac2f`);
    }
    const verdictField = schema.fields.find((f) => f.name === 'verdict');
    assert.ok(verdictField, 'verdict is a reported field');
    assert.deepEqual(
      (verdictField?.enum_values ?? []).slice().sort(),
      ['approved', 'needs_rework', 'rejected'],
      'EXPECTED GREEN: verdict is the closed three-value enum the decision names'
    );
  } finally {
    cleanup();
  }
});

test('attestation (a): knowledge_create with its required fields succeeds and is queryable', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('attestation', mkAttestationFields()) as unknown as { record: Loose };
    const rec = created.record;
    assert.equal(rec.type, 'attestation', 'EXPECTED GREEN: the shipped type creates successfully');
    assert.equal(rec.status, 'active');
    assert.equal(rec.artifact_key, 'part-0042');
    assert.equal(rec.verdict, 'approved');
    assert.equal(rec.inspector, 'jane.doe');

    const served = tools.knowledgeQuery({ types: ['attestation'] }) as unknown as Loose[];
    assert.ok(served.some((r) => r.id === rec.id), 'the new attestation is served by knowledge_query');
  } finally {
    cleanup();
  }
});

test('attestation (a boundary): knowledge_create with a verdict outside the closed enum is refused, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const before = attestationCount(tools);
    assert.throws(
      () => tools.knowledgeCreate('attestation', mkAttestationFields({ verdict: 'sort-of-ok' })),
      /verdict|approved|rejected|needs_rework/i,
      'EXPECTED GREEN: free-text verdict is refused — the decision explicitly rejects free-text verdict as an alternative'
    );
    assert.equal(attestationCount(tools), before, 'nothing written on the invalid-verdict refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (b) knowledge_update on an attestation AUTO-SUPERSEDES it
// ===========================================================================

test('attestation (b): knowledge_update on an attestation auto-supersedes it — mints a new active version, marks the original superseded', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('attestation', mkAttestationFields()) as unknown as { record: Loose };
    const originalId = created.record.id as string;

    // DEBUGGER-VERIFIED: attestation is excluded from SUPERSEDE_ALLOWED_TYPES
    // precisely because knowledge_update's ordinary fix-forward path already
    // IS its supersession mechanism (decision a7dbac2f). knowledge_update
    // therefore behaves exactly as it does for decision/anti_pattern/
    // research_finding: it mints a NEW active row and marks the original
    // superseded, rather than mutating in place or refusing.
    const updated = tools.knowledgeUpdate(originalId, { notes: 'follow-up inspection notes' }) as unknown as Loose;
    assert.equal(updated.status, 'active', 'EXPECTED GREEN: the update produces a new ACTIVE version');
    assert.notEqual(updated.id, originalId, 'EXPECTED GREEN: the new version carries a NEW id — never the same row mutated in place');
    assert.equal(updated.notes, 'follow-up inspection notes', 'the new version carries the updated field');

    const original = get(tools, originalId);
    assert.equal(original.status, 'superseded', 'EXPECTED GREEN: the original version is marked superseded');
    assert.equal(original.superseded_by, updated.id, 'the original forwards to the new version');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (c) knowledge_edit on a string field of an attestation auto-supersedes it
//     too (it delegates to knowledge_update)
// ===========================================================================

test('attestation (c): knowledge_edit on a string field (notes) likewise auto-supersedes — it delegates to knowledge_update', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'attestation',
      mkAttestationFields({ notes: 'MARKER_TO_EDIT lives right here.' })
    ) as unknown as { record: Loose };
    const originalId = created.record.id as string;

    const res = tools.knowledgeEdit(originalId, 'notes', 'MARKER_TO_EDIT', 'EDITED_MARKER') as unknown as {
      record: Loose;
    };
    assert.equal(res.record.status, 'active', 'EXPECTED GREEN: knowledge_edit delegates to knowledge_update (decision 9948475b item 4), so it auto-supersedes identically');
    assert.notEqual(res.record.id, originalId, 'EXPECTED GREEN: a new id, not an in-place mutation');
    assert.equal(res.record.notes, 'EDITED_MARKER lives right here.', 'the replacement landed on the new version');

    const original = get(tools, originalId);
    assert.equal(original.status, 'superseded');
    assert.equal(original.superseded_by, res.record.id);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (d) knowledge_query serves only the newest version; knowledge_get on the
//     original id still resolves with a terminus disclosure naming the
//     active survivor
// ===========================================================================

test('attestation (d): after auto-supersede, knowledge_query serves only the newest version, and knowledge_get on the original id discloses the survivor via terminus', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'attestation',
      mkAttestationFields({ notes: 'MARKER_TO_EDIT lives right here.' })
    ) as unknown as { record: Loose };
    const originalId = created.record.id as string;
    const before = attestationCount(tools);

    const updated = tools.knowledgeUpdate(originalId, { notes: 'revised inspection notes' }) as unknown as Loose;

    // No new row net: one row (original) drops out of what is served, one
    // row (the new version) is added — same pattern knowledge_retire (a)
    // pins for supersession-by-retirement.
    assert.equal(attestationCount(tools), before, 'EXPECTED GREEN: served count is unchanged — the original drops out, the new version takes its place');
    const served = tools.knowledgeQuery({ types: ['attestation'] }) as unknown as Loose[];
    assert.ok(served.every((r) => r.id !== originalId), 'EXPECTED GREEN: the original version is no longer served');
    assert.ok(served.some((r) => r.id === (updated.id as string)), 'EXPECTED GREEN: only the newest version is served');

    const original = get(tools, originalId);
    assert.equal(original.status, 'superseded', 'knowledge_get on the original id still resolves');
    const terminus = original.terminus as { id: string; status: string } | undefined;
    assert.ok(terminus, 'EXPECTED GREEN: the original carries a terminus disclosure naming the survivor');
    assert.equal(terminus!.id, updated.id);
    assert.equal(terminus!.status, 'active');
  } finally {
    cleanup();
  }
});
