// board_query / maintenance_query DEFAULT row shape: projection:'text'.
// Rows are scalar fields plus `text` clipped to BOARD_TEXT_CLIP; the per-item
// artifact_evidence block collapses to artifact_evidence_count and
// lane_advisory collapses to lane_advisory_count. projection:'full' keeps the
// heavy shape. Envelope counts ride every projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools, BOARD_TEXT_CLIP } from '../tools.js';

type Loose = Record<string, unknown>;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-text-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let clock = '2026-01-02T00:00:00.000Z';
  const tools = new SterlingTools({ store, now: () => clock });
  const add = (args: Loose): Loose => {
    const res = tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
    return (res.record ?? res) as Loose;
  };
  // Three user items with long text sharing one path (a lane collision), then a
  // decision touching that path AFTER them (artifact evidence on every item).
  const items = [0, 1, 2].map((i) =>
    add({ text: `slice ${i}: ${'long body '.repeat(300)}`, source: 'user', objective: 'obj-a', priority: 'high', file_keys: ['src/shared.ts', `src/own-${i}.ts`] })
  );
  clock = '2026-01-03T00:00:00.000Z';
  (tools as unknown as { knowledgeCreate: (t: string, f: Loose) => Loose }).knowledgeCreate('decision', {
    title: 'ruling touching the shared file',
    statement: 'S',
    alternatives_rejected: [],
    rationale: 'R',
    file_keys: ['src/shared.ts'],
  });
  const query = (args: Loose): Loose => (tools as unknown as { boardQueryResult: (a: Loose) => Loose }).boardQueryResult(args);
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, items, query, cleanup };
}

test('CONTROL: projection:"full" still carries lane_advisory, per-item artifact_evidence records and the unclipped text', () => {
  const { query, cleanup } = fixture();
  try {
    const full = query({ source: 'user', projection: 'full' });
    assert.ok(full.lane_advisory, 'full keeps the lane_advisory block');
    const rows = full.records as Loose[];
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const ev = r.artifact_evidence as Loose;
      assert.ok(ev && Array.isArray(ev.records) && (ev.records as unknown[]).length >= 1, 'full rows carry the evidence records list');
      assert.ok((r.text as string).length > BOARD_TEXT_CLIP, 'full rows keep the whole text');
      assert.ok(Array.isArray(r.file_keys));
    }
  } finally {
    cleanup();
  }
});

test('DEFAULT: rows are text-only — clipped text, no artifact_evidence detail, no lane_advisory payload, envelope counts present', () => {
  const { query, items, cleanup } = fixture();
  try {
    const page = query({ source: 'user' });
    for (const k of ['matched_filter', 'returned', 'cap', 'capped', 'offset', 'provenance', 'reconcile_provenance', 'artifact_evidence_provenance']) {
      assert.ok(k in page, `envelope keeps ${k}`);
    }
    assert.equal(page.matched_filter, 3);
    assert.equal(page.returned, 3);
    assert.equal('lane_advisory' in page, false, 'no lane_advisory payload by default');
    assert.equal(page.lane_advisory_count, 1, 'the collision survives as a count');
    const rows = page.records as Loose[];
    assert.equal(rows.length, 3);
    const ids = new Set(items.map((i) => i.id));
    for (const r of rows) {
      assert.ok(ids.has(r.id), 'full id kept');
      assert.equal(r.objective, 'obj-a');
      assert.equal(r.source, 'user');
      assert.equal(r.priority, 'high');
      assert.equal(r.status, 'active');
      assert.ok(typeof r.slug === 'string' && (r.slug as string).length > 0, 'slug kept');
      assert.equal('artifact_evidence' in r, false, 'no per-row evidence block');
      assert.equal(r.artifact_evidence_count, 1, 'evidence reduced to its count');
      assert.equal('file_keys' in r, false, 'file_keys ride full only');
      assert.equal((r.text as string).length, BOARD_TEXT_CLIP, 'text clipped to BOARD_TEXT_CLIP');
      assert.match(r.text as string, /^slice \d: long body/);
      assert.match(r.text as string, /…$/);
    }
    // explicit projection:'text' is the same as omitting it
    assert.deepEqual(query({ source: 'user', projection: 'text' }), page);
  } finally {
    cleanup();
  }
});

test('DEFAULT is much smaller than full on the same board', () => {
  const { query, cleanup } = fixture();
  try {
    const slim = JSON.stringify(query({ source: 'user' })).length;
    const full = JSON.stringify(query({ source: 'user', projection: 'full' })).length;
    assert.ok(slim * 3 < full, `default ${slim}B vs full ${full}B`);
  } finally {
    cleanup();
  }
});
