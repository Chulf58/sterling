// board_remove and the board removal journal (decisions
// board-remove-records-outcome-and-evidence-in-a-removal-journal and
// board-issue-mirror-design-required-outcome-snapshot-read-single-writer): a
// user task needs an outcome, its removal writes one journal row with the
// outcome, evidence and note, and a maintenance-queue item is removed as
// before, with no journal row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { createSterlingServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const NOW = '2026-10-27T12:00:00.000Z';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sterling-removal-journal-'));
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), '{}');
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: root, now: () => NOW });
  return {
    root,
    store,
    tools,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('board_remove refuses a user task without an outcome, naming the field and the four values; nothing is removed or journaled', () => {
  const h = harness();
  try {
    const { record } = h.tools.boardAdd({ text: 'Ship the export\nsee src/a.ts:1', source: 'user', objective: 'exports' });
    assert.throws(() => h.tools.boardRemove(record.id), /'outcome' is required to remove the user board task '[0-9a-f-]{36}': one of done, dropped, superseded, duplicate/);
    assert.throws(() => h.tools.boardRemove(record.id, { outcome: 'finished' }), /outcome 'finished' is not one of done, dropped, superseded, duplicate\. Nothing was removed\./);
    assert.throws(() => h.tools.boardRemove(record.id, { outcome: 'done', note: '   ' }), /the note for '[0-9a-f-]{36}' is blank/);
    assert.ok(h.tools.boardGet(record.id), 'the task is still on the board');
    assert.deepEqual(h.store.boardRemovalJournal(), []);
  } finally {
    h.cleanup();
  }
});

test('board_remove journals a user task with its outcome, evidence and note, as the task was', () => {
  const h = harness();
  try {
    const { record } = h.tools.boardAdd({ text: 'Ship the export\nsee src/a.ts:1', source: 'user', objective: 'exports', priority: 'high' });
    const slug = (record as unknown as { slug: string }).slug;
    const res = h.tools.boardRemove(record.id, { outcome: 'done', evidence: { commit: ' 1a2b3c ', pr: '#12', url: '' }, note: 'shipped in 1a2b3c' });
    assert.equal(res.removed, record.id);
    assert.equal(res.outcome, 'done');
    assert.equal(h.store.get(record.id), undefined, 'the task is gone');
    assert.deepEqual(h.store.boardRemovalJournal(), [
      {
        seq: 1,
        item_id: record.id,
        slug,
        text: 'Ship the export\nsee src/a.ts:1',
        source: 'user',
        objective: 'exports',
        priority: 'high',
        outcome: 'done',
        evidence: { commit: '1a2b3c', pr: '#12' },
        note: 'shipped in 1a2b3c',
        removed_at: NOW,
        // a plain task (no hand-off) is journaled with role 'none'; only a 0.19.130 row has no role
        handoff_role: 'none',
      },
    ]);
    const second = h.tools.boardAdd({ text: 'Old idea\nsee src/b.ts:1', source: 'user', objective: 'exports' }).record;
    h.tools.boardRemove(second.id, { outcome: 'dropped' });
    const rows = h.store.boardRemovalJournal();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].outcome, 'dropped');
    assert.equal(rows[1].evidence, undefined);
    assert.equal(rows[1].note, undefined);
  } finally {
    h.cleanup();
  }
});

test('board_remove of a maintenance-queue item is unchanged: no journal row, the drain log records it, and an outcome, note or evidence is refused', () => {
  const h = harness();
  try {
    const qi = h.tools.maintenanceEnqueue({ reason: 'capture_owed', text: 'capture owed on the widget work', file_keys: ['src/widget.ts'] });
    assert.throws(() => h.tools.boardRemove(qi.record.id, { outcome: 'done' }), /is a maintenance-queue item, and 'outcome' is recorded for user board tasks only\. Remove it with its id alone\. Nothing was removed\./);
    assert.throws(() => h.tools.boardRemove(qi.record.id, { note: 'x', evidence: { commit: 'a' } }), /'note', 'evidence' are recorded for user board tasks only/);
    assert.ok(h.store.get(qi.record.id), 'the refused removal left the item');
    const res = h.tools.boardRemove(qi.record.id);
    assert.equal(res.removed, qi.record.id);
    assert.equal(res.outcome, undefined);
    assert.equal(h.store.drainLogEntry(qi.record.id)?.system_reason, 'capture_owed');
    assert.deepEqual(h.store.boardRemovalJournal(), []);
  } finally {
    h.cleanup();
  }
});

test('board_remove over MCP: outcome is in the input schema, and the user-task refusal reaches the caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-removal-journal-mcp-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'removal-journal-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = (await client.listTools()).tools.find((t) => t.name === 'board_remove');
    const outcome = (listed?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.outcome;
    assert.deepEqual(outcome?.enum, ['done', 'dropped', 'superseded', 'duplicate']);
    const added = (await client.callTool({ name: 'board_add', arguments: { text: 'Ship it\nsee src/a.ts:1', source: 'user', objective: 'exports' } })) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(added.isError, true, added.content[0]?.text);
    const id = (JSON.parse(added.content[0].text) as { record: { id: string } }).record.id;
    const refused = (await client.callTool({ name: 'board_remove', arguments: { id } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /'outcome' is required/);
    const ok = (await client.callTool({ name: 'board_remove', arguments: { id, outcome: 'superseded', note: 'folded into the import task' } })) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(ok.isError, true, ok.content[0]?.text);
    const reader = new SterlingStore(join(dir, 'sterling.db'));
    try {
      assert.deepEqual(
        reader.boardRemovalJournal().map((r) => [r.item_id, r.outcome, r.note]),
        [[id, 'superseded', 'folded into the import task']]
      );
    } finally {
      reader.close();
    }
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
