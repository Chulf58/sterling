import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDomain } from '@sterling/store';
import { createSterlingServer, unreadableDomainWarning } from '../server.js';

// Board a-mounted-pre-v2-domain-store-breaks-knowledge-query-and-kno (06f72a10),
// the server side: boot prints one stderr line per mounted domain that cannot
// be read, and the knowledge_query and knowledge_preflight descriptions name
// the unreadable_domains key their results carry.

function payload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

/** Run fn with process.stderr.write captured; returns what was written. */
function captureStderr<T>(fn: () => T): { value: T; text: string } {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), text };
  } finally {
    process.stderr.write = original;
  }
}

test('unreadableDomainWarning: one line naming the domain, its path and the error, saying reads skip it', () => {
  const line = unreadableDomainWarning({ name: 'old', dbPath: '/tmp/domains/old/sterling.db', error: 'no such table: record_relations' });
  assert.ok(line.includes("'old'") && line.includes('/tmp/domains/old/sterling.db') && line.includes('no such table: record_relations'), line);
  assert.match(line, /reads skip it until the store is updated or repaired/);
  assert.ok(!line.includes('\n'), 'one line');
});

test('MCP boot with a pre-v2 domain mounted prints one unreadable-domain line, and knowledge_query answers with unreadable_domains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mcp-unreadable-boot-'));
  const presentDb = join(dir, 'domains', 'present', 'sterling.db');
  const oldDb = join(dir, 'domains', 'old', 'sterling.db');
  createDomain('present', 'present domain', presentDb);
  createDomain('old', 'old domain', oldDb);
  const raw = new DatabaseSync(oldDb);
  raw.exec('DROP TABLE record_relations; PRAGMA user_version = 1;');
  raw.close();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ stack_tags: ['present', 'old'], domain_paths: { present: presentDb, old: oldDb } }));

  const { value, text } = captureStderr(() => createSterlingServer(join(dir, 'sterling.db')));
  const { server, store } = value;
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const lines = text.split('\n').filter((l) => l.includes('could not be read'));
    assert.equal(lines.length, 1, text);
    assert.equal(lines[0], unreadableDomainWarning(store.unreadableDomains[0]));
    assert.ok(lines[0].includes("'old'") && lines[0].includes(oldDb) && lines[0].includes('record_relations'), lines[0]);
    assert.ok(!text.includes("'present'"), 'the readable domain gets no line');

    const listed = await client.listTools();
    for (const name of ['knowledge_query', 'knowledge_preflight']) {
      const description = listed.tools.find((t) => t.name === name)?.description ?? '';
      assert.match(description, /missing_domains/, name);
      assert.match(description, /unreadable_domains/, name);
    }

    const res = payload(await client.callTool({ name: 'knowledge_query', arguments: {} })) as { unreadable_domains?: { name: string; error: string }[] };
    assert.equal(res.unreadable_domains?.[0]?.name, 'old');
    assert.match(res.unreadable_domains?.[0]?.error ?? '', /record_relations/);
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
