// Worker mode and the busy refusal together (GitHub #56 with #59): server.ts
// installs guardWorkerTools before the busy registerTool wrapper, so a call
// runs worker authorization, then the busy-mapped handler, then the receipt
// stamp. A policy refusal under a held lock stays a policy refusal, and an
// allowed write under a held lock keeps the busy text, 'database is locked'
// included, which the worker's runner matches to classify a busy result.
// The allowed arm waits the server's default 5000 ms busy timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';
import { WORKER_STAMP_KEY } from '../worker-policy.js';

const TOKEN = 'lock-token-busy';

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

test('worker mode under a held lock: a refused write is the policy refusal, an allowed write is the busy text with database is locked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-busy-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const path = join(dir, '.sterling', 'sterling.db');
  const policyPath = join(dir, 'maintenance-worker.eligible.json');
  const { server, store, tools } = createSterlingServer(path, { workerPolicy: { path: policyPath, token: TOKEN } });
  const article = (
    tools.knowledgeCreate('feature_article', {
      slug: 'busy-article',
      title: 'busy article',
      what_it_does: 'does the thing.',
      intended_behavior: 'intends the thing.',
      files: [{ path: 'src/a/one.ts', role: 'a file' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      history: [{ date: '2026-10-09T00:00:00.000Z', event: 'seed' }],
      live_test_refs: [],
    } as never) as unknown as { record: { id: string } }
  ).record.id;
  const itemId = randomUUID();
  writeFileSync(
    policyPath,
    JSON.stringify({ token: TOKEN, policy_version: 1, run_id: 'run-busy', policy_items: [{ id: itemId, lane: 'reconcile_needed', target_id: article, file_keys: ['src/a/one.ts'] }] })
  );
  const version = (tools.knowledgeGet(article) as unknown as { version: number }).version;
  const client = new Client({ name: 'worker-policy-busy-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: 'knowledge_update', arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  let holder: DatabaseSync | undefined;
  try {
    holder = holdWriteLock(path);

    const refused = await call({ id: article, body: { title: 'renamed under a lock' }, expected_version: version });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /worker policy refused knowledge_update: rule 'field_not_allowed'/, refused.text);
    assert.match(refused.text, /Nothing was written/);
    assert.doesNotMatch(refused.text, /database is locked|locked by another connection|may have landed/, 'a policy refusal is never relabelled as busy');

    const busy = await call({ id: article, body: { what_it_does: 'does the corrected thing.' }, expected_version: version });
    assert.equal(busy.isError, true);
    assert.match(busy.text, /^knowledge_update: the store was locked by another connection/, busy.text);
    assert.match(busy.text, /database is locked/, 'the worker runner classifies a busy result by these words');
    assert.doesNotMatch(busy.text, /worker policy refused/);
    assert.ok(!busy.text.includes(WORKER_STAMP_KEY), 'a write that did not land carries no worker stamp');

    release(holder);
    holder = undefined;
    const stored = tools.knowledgeGet(article) as unknown as { version: number; title: string; what_it_does: string };
    assert.equal(stored.version, version, 'neither call wrote anything');
    assert.equal(stored.title, 'busy article');
    assert.equal(stored.what_it_does, 'does the thing.');
  } finally {
    if (holder) release(holder);
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
