// ------------------- SPEC: research_finding.source_urls becomes OPTIONAL, default [] -------------------
// (board 37862e86 — SCHEMA FRICTION measured 2026-08-26: code-review/repo-measured findings
// have no external URL to cite, forcing an empty-array workaround. Fix: source_urls goes
// from required to optional-with-default([]). ALL OTHER genuinely-required research_finding
// fields must remain required — this file's CONTROL test pins that boundary.)
//
// Authored BLIND to the implementation edit per H4 (test-writer never reads the schema diff).
// The required-field set (question/answer/source_date/capture_date all required; source_urls
// currently required; file_keys/volatility_hint/evidence_basis+measured_by already optional)
// is read from the existing behavioral pins in schemas.test.ts (every research_finding literal
// there always supplies question/answer/source_date/capture_date; several omit file_keys,
// volatility_hint, and evidence_basis/measured_by without failing) — never from records.ts.
//
// envelope() is duplicated from schemas.test.ts deliberately: importing it from that module
// would re-execute every test it declares (same rationale documented in
// decision-authority-and-article-honesty.test.ts and board-objective.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateRecord } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function baseFinding(extra: Record<string, unknown> = {}) {
  return {
    ...envelope('research_finding'),
    question: 'does a repo-measured finding carry an external URL to cite?',
    answer: 'no — findings sourced from HEAD/code-review have nothing external to point at',
    source_date: '2026-08-26',
    capture_date: '2026-08-26',
    ...extra,
  };
}

// CONTROL — placed FIRST. A green result here is what lets a green result on the two
// tests below actually mean "source_urls specifically loosened", rather than "the whole
// record loosened". Omit `question` (never touched by this change) and require the thrown
// error to NAME `question` — a bare "it threw" would pass under an over-loosened schema
// that dropped every requirement, which is exactly the regression this control exists to
// catch.
test('CONTROL: research_finding still refuses a record missing `question` — the fix must not spread past source_urls', () => {
  const missingQuestion = baseFinding({ source_urls: [] }) as Record<string, unknown>;
  delete missingQuestion.question;
  assert.throws(
    () => validateRecord(missingQuestion),
    /question/i,
    'omitting `question` must still fail, and the thrown error must name `question` specifically — not merely throw for an unrelated reason'
  );
});

// (1) source_urls OMITTED ENTIRELY parses, and the parsed result's source_urls is [].
test('research_finding: source_urls OMITTED entirely parses successfully, defaulting to [] (board 37862e86)', () => {
  let rf: { source_urls?: string[] } | undefined;
  assert.doesNotThrow(() => {
    rf = validateRecord(baseFinding()) as unknown as { source_urls?: string[] };
  }, 'a research_finding omitting source_urls must parse once the field is optional-with-default — this is the fix itself');
  assert.ok(Array.isArray(rf!.source_urls), 'source_urls must be present as an array even though it was never supplied — not left undefined');
  assert.deepEqual(rf!.source_urls, [], 'the default value is an empty array, not undefined/null/omitted');
});

// (2) source_urls PROVIDED as a non-empty string array still parses and is preserved unchanged.
test('research_finding: source_urls PROVIDED as a non-empty array parses and round-trips unchanged', () => {
  const urls = ['https://developer.genesys.cloud/x', 'https://example.com/y'];
  const rf = validateRecord(baseFinding({ source_urls: urls })) as unknown as { source_urls: string[] };
  assert.deepEqual(rf.source_urls, urls, 'a supplied non-empty source_urls array must survive unchanged — the new default must not overwrite or coerce a provided value');
});
