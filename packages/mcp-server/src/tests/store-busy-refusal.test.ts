// Issue #59: when another connection holds the store's write lock past the busy
// timeout, a write tool's refusal says nothing from the transaction was written
// and whether the call is safe to re-send. The words 'database is locked' stay
// in the text: the maintenance worker's runner classifies a busy result by them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore, StoreBusyError } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-09T12:00:00.000Z';

/** Another connection takes BEGIN IMMEDIATE plus a DDL statement, which forces the write lock to materialize. */
function holdWriteLock(path: string): DatabaseSync {
  const holder = new DatabaseSync(path);
  holder.exec('PRAGMA busy_timeout=0');
  holder.exec('BEGIN IMMEDIATE');
  holder.exec('CREATE TABLE IF NOT EXISTS zz_lock (x)');
  return holder;
}

function release(holder: DatabaseSync): void {
  holder.exec('ROLLBACK');
  holder.close();
}

const DECISION = { title: 'busy refusal', statement: 'a locked store refuses with a named error', alternatives_rejected: [], rationale: 'issue 59' };

test('knowledge_append and knowledge_update under a held lock refuse with the safe-to-re-send text, write nothing, and succeed after release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-busy-refusal-'));
  const path = join(dir, 'sterling.db');
  const store = new SterlingStore(path, { busyTimeoutMs: 200 });
  const tools = new SterlingTools({ store, now: () => NOW });
  let holder: DatabaseSync | undefined;
  try {
    const { record } = tools.knowledgeCreate('decision', DECISION);
    holder = holdWriteLock(path);

    const attempts: Array<[string, () => unknown]> = [
      ['knowledge_append', () => tools.knowledgeAppend(record.id, 'alternatives_rejected', [{ option: 'raw error', reason: 'says nothing about the write' }])],
      ['knowledge_update', () => tools.knowledgeUpdate(record.id, { rationale: 'changed under a lock' })],
    ];
    for (const [op, attempt] of attempts) {
      assert.throws(
        attempt,
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.ok(e.message.startsWith(`${op}: `), `names the tool: ${e.message}`);
          assert.match(e.message, /locked by another connection for longer than 200 ms; this transaction was rolled back and nothing from it was written/);
          assert.match(e.message, /database is locked/);
          assert.match(e.message, /safe to re-send/);
          assert.doesNotMatch(e.message, /may have landed/);
          assert.ok(e.cause instanceof StoreBusyError, 'the store error is kept as cause');
          return true;
        },
        op
      );
    }

    release(holder);
    holder = undefined;
    const stored = store.get(record.id) as { alternatives_rejected: unknown[]; rationale: string; version: number };
    assert.equal(stored.alternatives_rejected.length, 0, 'the refused append wrote no row');
    assert.equal(stored.rationale, 'issue 59', 'the refused update wrote nothing');
    assert.equal(stored.version, 1, 'neither refusal bumped the version');

    assert.doesNotThrow(() => attempts[0][1](), 'the append succeeds once the lock is released');
    assert.equal((store.get(record.id) as { alternatives_rejected: unknown[] }).alternatives_rejected.length, 1);
  } finally {
    if (holder) release(holder);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A write tool nobody cleared as one transaction reaches the wire with the
// other wording: it cannot promise a clean refusal. The server waits the
// default 5000 ms busy timeout here, so this arm takes about five seconds.
test('a write tool not cleared as single-transaction refuses with the may-have-landed text over the wire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-busy-refusal-wire-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const path = join(dir, '.sterling', 'sterling.db');
  const { server, store } = createSterlingServer(path);
  const client = new Client({ name: 'busy-refusal-test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let holder: DatabaseSync | undefined;
  try {
    holder = holdWriteLock(path);
    const result = await client.callTool({ name: 'knowledge_create', arguments: { type: 'decision', fields: DECISION } });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /^knowledge_create: the store was locked by another connection for longer than 5000 ms/);
    assert.match(text, /database is locked/);
    assert.match(text, /an earlier write in this call may have landed; check before re-sending/i);
    assert.doesNotMatch(text, /safe to re-send/);
  } finally {
    if (holder) release(holder);
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
