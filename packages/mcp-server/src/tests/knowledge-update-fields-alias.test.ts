// GitHub #200: knowledge_create takes its payload as `fields`, knowledge_update
// took it only as `body`, so a caller who copied create's shape was refused
// with a bare zod "body: Missing key". knowledge_update now takes exactly one
// of `body` or `fields` (same partial-patch shape); both or neither is refused
// by name, and the tool's parameters stay strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-update-fields-'));
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, tools, cleanup };
}

const text = (res: unknown): string => (res as { content: { text: string }[] }).content[0]!.text;

function decision(tools: ReturnType<typeof createSterlingServer>['tools']): string {
  const rec = tools.knowledgeCreate('decision', {
    title: 'update alias fixture decision',
    statement: 'the statement before the update',
    alternatives_rejected: [],
    rationale: 'fixture',
  }).record as unknown as { id: string };
  return rec.id;
}

test('knowledge_update: body is applied (unchanged contract)', async () => {
  const { client, tools, cleanup } = await harness();
  try {
    const id = decision(tools);
    const res = await client.callTool({ name: 'knowledge_update', arguments: { id, body: { statement: 'via body' }, projection: 'full' } });
    assert.notEqual(res.isError, true, text(res));
    assert.equal((tools.knowledgeGet(id) as unknown as { statement: string }).statement, 'via body');
  } finally {
    await cleanup();
  }
});

test('knowledge_update: fields is accepted as an alias of body', async () => {
  const { client, tools, cleanup } = await harness();
  try {
    const id = decision(tools);
    const res = await client.callTool({ name: 'knowledge_update', arguments: { id, fields: { statement: 'via fields' }, projection: 'full' } });
    assert.notEqual(res.isError, true, text(res));
    assert.equal((tools.knowledgeGet(id) as unknown as { statement: string }).statement, 'via fields');
  } finally {
    await cleanup();
  }
});

test('knowledge_update: body and fields together are refused naming both, and nothing is written', async () => {
  const { client, tools, cleanup } = await harness();
  try {
    const id = decision(tools);
    const res = await client.callTool({ name: 'knowledge_update', arguments: { id, body: { statement: 'a' }, fields: { statement: 'b' } } });
    assert.equal(res.isError, true);
    assert.match(text(res), /body or fields, not both/);
    assert.equal((tools.knowledgeGet(id) as unknown as { statement: string }).statement, 'the statement before the update');
  } finally {
    await cleanup();
  }
});

test('knowledge_update: neither body nor fields is refused with the alias hint', async () => {
  const { client, tools, cleanup } = await harness();
  try {
    const id = decision(tools);
    const res = await client.callTool({ name: 'knowledge_update', arguments: { id } });
    assert.equal(res.isError, true);
    assert.match(text(res), /knowledge_update takes the payload as body \(or fields\)/);
  } finally {
    await cleanup();
  }
});

test('knowledge_update: parameters stay strict — an unknown top-level key is still refused', async () => {
  const { client, tools, cleanup } = await harness();
  try {
    const id = decision(tools);
    const res = await client.callTool({ name: 'knowledge_update', arguments: { id, body: { statement: 'x' }, patch: {} } });
    assert.equal(res.isError, true);
    assert.match(text(res), /patch/);
  } finally {
    await cleanup();
  }
});

test('knowledge_update: the served description and schema mention the alias', async () => {
  const { client, cleanup } = await harness();
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'knowledge_update')!;
    assert.match(tool.description ?? '', /alias `fields`/);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['body', 'expected_version', 'fields', 'id', 'projection', 'resolves']);
    assert.deepEqual(tool.inputSchema.required, ['id']);
    // OpenCode does not resolve a $ref between properties and shows the field as unknown (#73)
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"\$ref"/, 'the served schema inlines every property');
    for (const key of ['body', 'fields']) {
      const prop = tool.inputSchema.properties?.[key] as { type?: string } | undefined;
      assert.equal(prop?.type, 'object', `${key} is served as an inline object`);
    }
  } finally {
    await cleanup();
  }
});
