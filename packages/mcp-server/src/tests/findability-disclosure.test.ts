import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// Decision make-records-findable-authoring-rule-disclosure-lint-then-blind-
// experiment, part (2): knowledge_create and knowledge_update DISCLOSE the
// record's central terms (what push delivery and knowledge_preflight match on)
// and WARN when a path-carrying record has no file paths. Disclosure only —
// nothing here refuses a write or changes what is stored.

const NOW = '2026-10-03T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-findability-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  return {
    tools,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Receipt = { record: Record<string, unknown>; warnings: string[]; central_terms?: string[] };

const mkDecision = (tools: SterlingTools, fields: Record<string, unknown> = {}) =>
  tools.knowledgeCreate('decision', {
    title: 'Latch rotation uses a monotonic generation counter',
    statement: 'The latch rotation increments a monotonic generation counter on every write.',
    alternatives_rejected: [],
    rationale: 'r',
    ...fields,
  }) as unknown as Receipt;

const pathWarnings = (r: Receipt) => r.warnings.filter((w) => w.startsWith('no file paths'));

test('create decision with file_keys: central_terms present, no path warning', () => {
  const { tools, cleanup } = harness();
  try {
    const r = mkDecision(tools, { file_keys: ['src/latch.ts'] });
    assert.ok(Array.isArray(r.central_terms) && r.central_terms.length > 0);
    assert.ok(r.central_terms.includes('latch'), `central_terms: ${JSON.stringify(r.central_terms)}`);
    assert.equal(pathWarnings(r).length, 0);
  } finally {
    cleanup();
  }
});

test('create decision without file_keys: path warning, still stored', () => {
  const { tools, cleanup } = harness();
  try {
    const r = mkDecision(tools);
    assert.equal(pathWarnings(r).length, 1);
    assert.match(pathWarnings(r)[0], /push by file will never surface this record/);
    assert.ok(r.central_terms && r.central_terms.length > 0);
    assert.equal(r.record.status, 'active');
  } finally {
    cleanup();
  }
});

test('create decision with empty file_keys counts as missing', () => {
  const { tools, cleanup } = harness();
  try {
    assert.equal(pathWarnings(mkDecision(tools, { file_keys: [] })).length, 1);
  } finally {
    cleanup();
  }
});

test('create feature_article without files warns; with files does not', () => {
  const { tools, cleanup } = harness();
  try {
    const base = {
      title: 'Latch article',
      what_it_does: 'does',
      intended_behavior: 'b',
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [],
      live_test_refs: [],
    };
    const bare = tools.knowledgeCreate('feature_article', { slug: 'latch-bare', ...base, files: [] }) as unknown as Receipt;
    assert.equal(pathWarnings(bare).length, 1);
    assert.match(pathWarnings(bare)[0], /files/);
    const owned = tools.knowledgeCreate('feature_article', {
      slug: 'latch-owned',
      ...base,
      files: [{ path: 'src/latch-owned.ts', role: 'impl' }],
    }) as unknown as Receipt;
    assert.equal(pathWarnings(owned).length, 0);
    assert.ok(owned.central_terms?.includes('latch'));
  } finally {
    cleanup();
  }
});

test('update changing title/statement: central_terms reflect the new text', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('anti_pattern', {
      title: 'Swallowing errors in the quasar scheduler',
      trigger: 'quasar scheduler swallows errors',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'e',
      severity: 'warn',
      file_keys: ['src/q.ts'],
    }) as unknown as Receipt;
    assert.ok(created.central_terms?.includes('quasar'));
    const id = created.record.id as string;
    const updated = tools.knowledgeUpdateResult(id, {
      title: 'Hoarding handles in the zephyr allocator',
      trigger: 'zephyr allocator hoards handles',
    }) as unknown as Receipt;
    assert.ok(updated.central_terms?.includes('zephyr'), JSON.stringify(updated.central_terms));
    assert.ok(!updated.central_terms?.includes('quasar'), JSON.stringify(updated.central_terms));
    assert.equal(pathWarnings(updated).length, 0);
  } finally {
    cleanup();
  }
});

test('update of a path-less decision-shaped record warns; digest receipt keeps both fields', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('research_finding', {
      question: 'Does the quasar scheduler leak handles?',
      answer: 'yes',
      source_date: '2026-10-01',
      capture_date: '2026-10-03',
      evidence_basis: 'measured',
    }) as unknown as Receipt;
    const updated = tools.knowledgeUpdateResult(created.record.id as string, { answer: 'no' });
    const receipt = tools.writeProjected(updated, 'digest') as unknown as Receipt;
    assert.equal(pathWarnings(receipt).length, 1);
    assert.ok(receipt.central_terms?.includes('quasar'));
  } finally {
    cleanup();
  }
});
