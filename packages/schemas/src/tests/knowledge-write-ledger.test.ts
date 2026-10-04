import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeWriteSchema, KNOWLEDGE_WRITES_REL, KNOWLEDGE_WRITES_COMPACT_LINES, KNOWLEDGE_WRITES_KEEP_IDS } from '../index.js';

// The domain-write ledger entry (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger): the shape
// the MCP server writes and the session-end duty reads consume, defined once.

test('knowledgeWriteSchema: an entry is exactly {id, type, at}', () => {
  const entry = { id: 'a1', type: 'decision', at: '2026-10-04T12:00:00.000Z' };
  assert.deepEqual(knowledgeWriteSchema.parse(entry), entry);
  for (const missing of ['id', 'type', 'at'] as const) {
    const { [missing]: _dropped, ...rest } = entry;
    assert.equal(knowledgeWriteSchema.safeParse(rest).success, false, `an entry without '${missing}' is refused`);
    assert.equal(knowledgeWriteSchema.safeParse({ ...entry, [missing]: '' }).success, false, `an empty '${missing}' is refused`);
  }
});

test('knowledgeWriteSchema: nothing about the writing project or session rides on an entry', () => {
  const entry = { id: 'a1', type: 'decision', at: '2026-10-04T12:00:00.000Z' };
  assert.equal(knowledgeWriteSchema.safeParse({ ...entry, project: '/home/u/repo' }).success, false, 'an unknown key is refused, not stripped');
  assert.equal(knowledgeWriteSchema.safeParse({ ...entry, session_id: 's1' }).success, false);
});

test('the ledger location and bounds are stated once, beside the shape', () => {
  assert.equal(KNOWLEDGE_WRITES_REL, '.sterling/transient/knowledge-writes.jsonl');
  assert.equal(KNOWLEDGE_WRITES_COMPACT_LINES, 1000);
  assert.equal(KNOWLEDGE_WRITES_KEEP_IDS, 500);
  assert.ok(KNOWLEDGE_WRITES_KEEP_IDS < KNOWLEDGE_WRITES_COMPACT_LINES, 'a compaction must shrink the file');
});
