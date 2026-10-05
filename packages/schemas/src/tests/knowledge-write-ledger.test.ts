import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeWriteSchema, KNOWLEDGE_WRITES_REL, KNOWLEDGE_WRITES_DIR_REL, KNOWLEDGE_WRITES_PROCESS_FILE, KNOWLEDGE_WRITES_RETENTION_MS, KNOWLEDGE_WRITES_COMPACT_LINES, KNOWLEDGE_WRITES_KEEP_IDS, knowledgeWritesProcessFile, knowledgeWritesOwnerPid } from '../index.js';

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

test('one ledger file per server process: the name carries the owner pid, and only that exact name matches', () => {
  const uuid = '0b0d5cf6-f282-4d29-b7f0-aeb649697361';
  const name = knowledgeWritesProcessFile(4321, uuid);
  assert.equal(name, `knowledge-writes.4321-${uuid}.jsonl`);
  assert.equal(KNOWLEDGE_WRITES_DIR_REL, '.sterling/transient');
  assert.equal(KNOWLEDGE_WRITES_REL.startsWith(`${KNOWLEDGE_WRITES_DIR_REL}/`), true, 'the legacy file sits in the same folder');
  assert.equal(KNOWLEDGE_WRITES_PROCESS_FILE.test(name), true);
  assert.equal(knowledgeWritesOwnerPid(name), 4321);
  assert.equal(knowledgeWritesOwnerPid('knowledge-writes.jsonl'), null, 'the legacy file has no owner');
  assert.equal(knowledgeWritesOwnerPid(`${name}.tmp-4321-${uuid}`), null, 'a compaction temp file is not a ledger file');
  assert.equal(KNOWLEDGE_WRITES_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
});
