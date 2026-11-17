// GitHub #270: on OpenCode, board_query({id, cap}) returned the whole board with no error,
// although the server's top-level schema is strict and refuses `id` when the key reaches it.
// The key never reached it. OpenCode's built-in tool-input repair (repairObject in
// packages/core/src/plugin/tool-input-repair.ts, anomalyco/opencode #57051 and #62130)
// rewrites the arguments against the SERVED JSON Schema before the call is sent, and
// deletes every key not in `properties` when the schema says `additionalProperties: false`:
//
//   if (!P && a.additionalProperties === false && !d && !x) { const H = { ...y }; return delete H[M], H; }
//
// So advertising strictness is what made the host drop the key. These tests run the same
// rule over the schema the server actually serves (tools/list), then send the repaired
// arguments through the SDK's tools/call path, so they fail whenever a tool's served
// schema would let the host strip an unknown key the server is meant to refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';

type Served = { properties?: Record<string, unknown>; additionalProperties?: unknown };

// The top-level part of OpenCode's repair rule quoted above: an undeclared key is deleted
// only when the served schema closes the object with additionalProperties:false.
function opencodeRepair(schema: Served, args: Record<string, unknown>): Record<string, unknown> {
  if (schema.additionalProperties !== false) return { ...args };
  const declared = new Set(Object.keys(schema.properties ?? {}));
  return Object.fromEntries(Object.entries(args).filter(([k]) => declared.has(k)));
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-host-repair-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, cleanup };
}

const text = (res: unknown) => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');

test('#270: board_query({id}) sent through the OpenCode input repair is refused naming id and pointing at board_get, never answered with the whole board', async () => {
  const { client, cleanup } = await harness();
  try {
    await client.callTool({ name: 'board_add', arguments: { text: 'one item', source: 'user' } });
    await client.callTool({ name: 'board_add', arguments: { text: 'another item', source: 'user' } });
    const served = (await client.listTools()).tools.find((t) => t.name === 'board_query')!.inputSchema as Served;
    const sent = opencodeRepair(served, { id: 'cd24016e', cap: 1 });
    assert.deepEqual(Object.keys(sent).sort(), ['cap', 'id'], 'the host repair keeps the unknown key, so the server can refuse it');
    const res = await client.callTool({ name: 'board_query', arguments: sent });
    assert.equal(res.isError, true, `board_query with an unknown id key answered instead of refusing: ${text(res).slice(0, 200)}`);
    assert.match(text(res), /unrecognized_keys/);
    assert.match(text(res), /"id"/, 'the refusal names the key');
    assert.match(text(res), /board_get/, 'the refusal points at board_get for a one-item read');
  } finally {
    await cleanup();
  }
});

test('#270: every strict tool keeps an unknown top-level key through the OpenCode input repair and refuses it on the wire', async () => {
  const { client, cleanup } = await harness();
  try {
    const listed = (await client.listTools()).tools;
    const stripped: string[] = [];
    for (const tool of listed) {
      if (tool.name === 'knowledge_create') continue; // its own advertised schema, outside the shared strict() helper
      const sent = opencodeRepair(tool.inputSchema as Served, { zz_not_a_parameter: 1 });
      if (!('zz_not_a_parameter' in sent)) stripped.push(tool.name);
    }
    assert.deepEqual(stripped, [], 'no served top-level schema lets the host delete an unknown key');
    for (const name of ['board_query', 'knowledge_query', 'board_update', 'board_get']) {
      const res = await client.callTool({ name, arguments: { id: 'x', zz_not_a_parameter: 1 } });
      assert.equal(res.isError, true, `${name} refuses an unknown key`);
      assert.match(text(res), /zz_not_a_parameter/, `${name}'s refusal names the key`);
    }
    // board_get takes id, so the board_get pointer belongs to board_query only
    const get = await client.callTool({ name: 'board_get', arguments: { id: 'x', zz_not_a_parameter: 1 } });
    assert.doesNotMatch(text(get), /has no id filter/);
  } finally {
    await cleanup();
  }
});

test('#282: board_update naming only session is refused, nothing renews, and the refusal points at board_reaffirm', async () => {
  const { client, cleanup } = await harness();
  try {
    const added = JSON.parse(text(await client.callTool({ name: 'board_add', arguments: { text: 'claimed item', source: 'user' } }))) as { record: { id: string } };
    const id = added.record.id;
    const res = await client.callTool({ name: 'board_update', arguments: { id, session: 'ses_a' } });
    assert.equal(res.isError, true);
    assert.match(text(res), /no fields to update/);
    assert.match(text(res), /board_reaffirm/, 'a session-only call is told how to renew a claim without an edit');
    const listed = (await client.listTools()).tools;
    const desc = (n: string) => listed.find((t) => t.name === n)!.description ?? '';
    const sessionDoc = ((listed.find((t) => t.name === 'board_update')!.inputSchema as Served).properties!.session as { description?: string }).description ?? '';
    assert.match(sessionDoc, /only alongside a real edit/, 'board_update.session says it renews only with a real edit');
    assert.match(sessionDoc, /board_reaffirm/);
    assert.match(desc('board_claim'), /board_update that changes a field and passes your session/);
    assert.match(desc('board_reaffirm'), /a board_update naming only session is refused/);
  } finally {
    await cleanup();
  }
});
