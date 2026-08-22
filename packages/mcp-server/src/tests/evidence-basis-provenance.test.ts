// ---------------------------------------------------------------------------
// Behavior pins for the `evidence_basis` / `measured_by` fields on the three
// ruling types (decision / anti_pattern / research_finding) — decision
// e09b2afc-1495-4fb3-8952-114bb5840819, "evidence_basis (measured|inferred)
// + measured_by on the three ruling types". The fields already ship
// (2026-08-21) with schema-shape coverage only
// (packages/schemas/src/tests/schemas.test.ts) — nothing exercises the
// PROVENANCE RULE this dispatch asks to pin through the MCP tool surface.
//
// RESOLVED 2026-08-22 BY DEBUGGER ADJUDICATION (no product defect; the
// original draft's refusal guess for AC3(a) was wrong): decision e09b2afc's
// own rationale states, verbatim, "No cross-field constraint (measured_by
// without evidence_basis is legal): over-constraining optional metadata
// trains omission." AC3(a) is a PERMISSIVE pin, not a refusal: writing
// evidence_basis:'measured' without measured_by SUCCEEDS by design — there
// is no required-together constraint in EITHER direction between these two
// optional fields, and the decision explicitly rejects adding one.
//
// Written BLIND to tools.ts / packages/schemas/src/records.ts. Read for
// harness convention and fixture shapes only: knowledge-supersede.test.ts
// (mkDecision/mkAntiPattern/mkResearchFinding fixture bodies, read
// verbatim from that file, not guessed).
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

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-evidence-basis-provenance-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkDecisionFields(overrides: Loose = {}): Loose {
  return {
    title: 'evidence-basis pin decision',
    statement: 'a decision whose load-bearing claim needs a provenance marker',
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  };
}

function mkAntiPatternFields(overrides: Loose = {}): Loose {
  return {
    title: 'evidence-basis pin anti-pattern',
    trigger: 'trigger text',
    guidance: 'guidance text',
    wrong_way: 'wrong way text',
    right_way: 'right way text',
    source_evidence: 'evidence text',
    ...overrides,
  };
}

function mkResearchFindingFields(overrides: Loose = {}): Loose {
  return {
    question: 'evidence-basis pin research finding?',
    answer: 'a',
    source_urls: [],
    source_date: '2026-05-20',
    capture_date: '2026-06-01',
    ...overrides,
  };
}

// ===========================================================================
// AC3(a) — evidence_basis:'measured' WITHOUT measured_by SUCCEEDS by design
// ===========================================================================

test("AC3(a) decision: evidence_basis:'measured' WITHOUT measured_by SUCCEEDS by design (decision e09b2afc: no cross-field constraint), both fields round-trip as given", () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'decision',
      mkDecisionFields({ evidence_basis: 'measured' })
    ) as unknown as { record: Loose };
    assert.equal(
      created.record.status,
      'active',
      "EXPECTED GREEN (decision e09b2afc: \"No cross-field constraint (measured_by without evidence_basis is legal): over-constraining optional metadata trains omission\"): 'measured' without measured_by is a legal, permitted write"
    );
    assert.equal(created.record.evidence_basis, 'measured');
    assert.equal(created.record.measured_by, undefined, 'measured_by was never supplied and is not synthesized or required');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3(b) — evidence_basis:'measured' WITH measured_by succeeds
// ===========================================================================

test("AC3(b) decision: evidence_basis:'measured' WITH measured_by succeeds and both fields round-trip", () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'decision',
      mkDecisionFields({ evidence_basis: 'measured', measured_by: 'grep -c foo src/**/*.ts' })
    ) as unknown as { record: Loose };
    assert.equal(created.record.status, 'active', 'EXPECTED GREEN: measured + measured_by together is the fully-provenanced happy path');
    assert.equal(created.record.evidence_basis, 'measured');
    assert.equal(created.record.measured_by, 'grep -c foo src/**/*.ts', 'measured_by round-trips verbatim so the claim can be re-derived');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3(c) — evidence_basis:'inferred' WITHOUT measured_by succeeds
// ===========================================================================

test("AC3(c) decision: evidence_basis:'inferred' without measured_by succeeds (measured_by is only meaningful for a measured claim)", () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'decision',
      mkDecisionFields({ evidence_basis: 'inferred' })
    ) as unknown as { record: Loose };
    assert.equal(created.record.status, 'active', 'EXPECTED GREEN: inferred claims never need a re-derivation command');
    assert.equal(created.record.evidence_basis, 'inferred');
    assert.equal(created.record.measured_by, undefined, 'measured_by was never supplied and is not synthesized');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Cross-type parity (b)/(c) — the fields are generic across all three ruling
// types, not decision-specific. Limited to the success paths to avoid
// re-litigating AC3(a)'s already-disclosed ambiguity three more times.
// ===========================================================================

test("AC3(b) anti_pattern: evidence_basis:'measured' WITH measured_by succeeds", () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'anti_pattern',
      mkAntiPatternFields({ evidence_basis: 'measured', measured_by: 'reproduced via node --test' })
    ) as unknown as { record: Loose };
    assert.equal(created.record.status, 'active', 'EXPECTED GREEN: the fields apply generically to anti_pattern, not only decision');
    assert.equal(created.record.evidence_basis, 'measured');
    assert.equal(created.record.measured_by, 'reproduced via node --test');
  } finally {
    cleanup();
  }
});

test("AC3(c) research_finding: evidence_basis:'inferred' without measured_by succeeds", () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate(
      'research_finding',
      mkResearchFindingFields({ evidence_basis: 'inferred' })
    ) as unknown as { record: Loose };
    assert.equal(created.record.status, 'active', 'EXPECTED GREEN: the fields apply generically to research_finding, not only decision');
    assert.equal(created.record.evidence_basis, 'inferred');
  } finally {
    cleanup();
  }
});
