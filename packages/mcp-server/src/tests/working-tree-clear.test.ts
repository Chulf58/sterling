// GitHub #118: the article-missing settlement notice tells the operator to clear
// a merged branch's working_tree through knowledge_update, but the field's schema
// (string, min 1, optional) refused both null and ''. knowledge_update now takes
// working_tree: null as the explicit unset; '' stays refused, and so does a null
// on any other field.
//
// GitHub #123 (OpenCode, reported against 0.19.81, the release before the #118
// fix) is the same defect seen through the served knowledge_update tool. The
// MCP-surface tests below pin that path: the call an operator makes, through the
// registered tool schema, clears working_tree on a feature_article and on a
// reference_material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-16T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wt-clear-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'x');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: dir, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function articleFields(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: `art-${randomUUID().slice(0, 8)}`,
    title: 'an article',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'src/a.mjs', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...overrides,
  };
}

type Stored = { id: string; working_tree?: string; title: string; version?: number };

test('knowledge_update working_tree:null clears the field; the record reads back without it and other fields are untouched', () => {
  const { store, tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'merged-branch' })).record as Stored;
    assert.equal((store.get(created.id) as unknown as Stored).working_tree, 'merged-branch');

    tools.knowledgeUpdate(created.id, { working_tree: null });

    const after = store.get(created.id) as unknown as Stored & Record<string, unknown>;
    assert.equal('working_tree' in after, false, 'the key is gone, not stored as null');
    assert.equal(after.title, 'an article');
    assert.deepEqual(after.files, [{ path: 'src/a.mjs', role: 'impl' }]);
    assert.equal(after.version, 2, 'a versioned write');

    // Cleared again (already absent) is a no-op write, not a refusal.
    tools.knowledgeUpdate(created.id, { working_tree: null, title: 'renamed' });
    const again = store.get(created.id) as unknown as Stored;
    assert.equal('working_tree' in again, false);
    assert.equal(again.title, 'renamed');
  } finally {
    cleanup();
  }
});

test("knowledge_update working_tree:'' is still refused and writes nothing", () => {
  const { store, tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'merged-branch' })).record as Stored;
    assert.throws(() => tools.knowledgeUpdate(created.id, { working_tree: '' }), /working_tree/);
    const after = store.get(created.id) as unknown as Stored;
    assert.equal(after.working_tree, 'merged-branch');
    assert.equal(after.version, 1);
  } finally {
    cleanup();
  }
});

test('knowledge_create still refuses working_tree:null and working_tree:""', () => {
  const { tools, cleanup } = harness();
  try {
    assert.throws(() => tools.knowledgeCreate('feature_article', articleFields({ working_tree: null })), /working_tree/);
    assert.throws(() => tools.knowledgeCreate('feature_article', articleFields({ working_tree: '' })), /working_tree/);
  } finally {
    cleanup();
  }
});

test('null stays refused on every other field of the update path', () => {
  const { store, tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('feature_article', articleFields({ working_tree: 'merged-branch' })).record as Stored;
    assert.throws(() => tools.knowledgeUpdate(created.id, { concept_family: null }), /concept_family/);
    assert.equal((store.get(created.id) as unknown as Stored).working_tree, 'merged-branch');
  } finally {
    cleanup();
  }
});

async function mcpHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-wt-clear-mcp-'));
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

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

function payload(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  assert.notEqual(r.isError, true, `the tool call failed: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

async function createThenClear(fields: Record<string, unknown>, type: 'feature_article' | 'reference_material'): Promise<void> {
  const { client, cleanup } = await mcpHarness();
  try {
    const created = payload(
      await client.callTool({ name: 'knowledge_create', arguments: { type, fields: { type, ...fields }, projection: 'full' } })
    ) as { record: { id: string; working_tree?: string } };
    const id = created.record.id;
    assert.equal(created.record.working_tree, 'merged-branch');

    payload(await client.callTool({ name: 'knowledge_update', arguments: { id, body: { working_tree: null } } }));

    const after = payload(await client.callTool({ name: 'knowledge_get', arguments: { id } }));
    assert.equal('working_tree' in after, false, 'the served tool cleared the field');
    assert.equal(after.version, 2);

    const blank = (await client.callTool({ name: 'knowledge_update', arguments: { id, body: { working_tree: '' } } })) as ToolResult;
    assert.equal(blank.isError, true, 'an empty string is not a clear and stays refused');
    assert.match(blank.content[0].text, /working_tree/);
  } finally {
    await cleanup();
  }
}

test('#123: through the served knowledge_update tool, working_tree:null clears a feature_article', async () => {
  await createThenClear(articleFields({ working_tree: 'merged-branch' }), 'feature_article');
});

test('#123: through the served knowledge_update tool, working_tree:null clears a reference_material', async () => {
  await createThenClear(
    {
      title: 'a reference',
      kind: 'doc',
      location: 'docs/ref.md',
      summary: 'x',
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
      working_tree: 'merged-branch',
    },
    'reference_material'
  );
});
