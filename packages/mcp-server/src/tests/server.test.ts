import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';

const SPINE_TOOLS = [
  'knowledge_create',
  'knowledge_query',
  'knowledge_get',
  'knowledge_update',
  'board_add',
  'board_query',
  'board_remove',
  'run_state',
  'agent_exit',
  'run_signal',
  'handoff_write',
  'handoff_read',
];

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mcp-'));
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
  return { client, store, cleanup };
}

function payload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

test('MCP integration: the spine tool surface is served and callable end-to-end', async () => {
  const { client, store, cleanup } = await harness();
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...SPINE_TOOLS].sort(), 'exactly the §16.1 spine tools are served');

    // knowledge round trip over the wire
    const created = payload(
      await client.callTool({
        name: 'knowledge_create',
        arguments: {
          type: 'decision',
          fields: { title: 'T', statement: 'S', alternatives_rejected: [], rationale: 'R', file_keys: ['src\\x.ts'] },
        },
      })
    ) as { record: { id: string; file_keys: string[] }; check_skipped: unknown[] };
    assert.deepEqual(created.record.file_keys, ['src/x.ts'], 'path invariant holds across the MCP boundary');
    assert.equal(created.check_skipped.length, 1, 'check_skipped surfaces in the tool result');

    const queried = payload(
      await client.callTool({ name: 'knowledge_query', arguments: { types: ['decision'], rank_terms: ['T'] } })
    ) as unknown[];
    assert.equal(queried.length, 1);

    // protocol loop over the wire
    store.createRun({
      id: 'r-0001',
      brief_ref: randomUUID(),
      branch: 'sterling/run-r-0001',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: '2026-06-10T12:00:00.000Z',
    });

    const badExit = await client.callTool({
      name: 'agent_exit',
      arguments: { phase_id: 'p1', agent_role: 'coder', signal: 'victory' },
    });
    assert.equal(badExit.isError, true, 'invalid signal rejected in-band so the agent can self-correct');
    assert.match((badExit.content as { text: string }[])[0].text, /enum is closed/);

    await client.callTool({
      name: 'handoff_write',
      arguments: {
        handoff: {
          phase_id: 'p1',
          agent_role: 'coder',
          what_changed: [{ path: 'src/x.ts', change_role: 'implemented' }],
          wired: [],
          deferred: [],
          decisions_made: [],
          tests_produced: [],
          exit_signal: 'complete',
          unresolved: [],
        },
      },
    });
    await client.callTool({
      name: 'agent_exit',
      arguments: { phase_id: 'p1', agent_role: 'coder', signal: 'complete' },
    });
    const signal = payload(await client.callTool({ name: 'run_signal', arguments: {} })) as {
      action: { action: string };
      machine_state: string;
    };
    assert.equal(signal.action.action, 'complete_run', 'single-phase run goes straight to the completion sequence');
    assert.equal(signal.machine_state, 'completing');

    const state = payload(await client.callTool({ name: 'run_state', arguments: {} })) as { machine_state: string };
    assert.equal(state.machine_state, 'completing');

    const handoffs = payload(
      await client.callTool({ name: 'handoff_read', arguments: { files: ['src\\x.ts'] } })
    ) as unknown[];
    assert.equal(handoffs.length, 1, 'handoff file-key read joins across the path boundary');
  } finally {
    await cleanup();
  }
});
