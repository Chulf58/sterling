// ---------------------------------------------------------------------------
// Id-param docs and the destroying-remove refusal hint (user-ruled 2026-10-13,
// "Param docs + hint"; board 242b6244).
//
// OpenCode Code Mode shows a tool as a TypeScript-like signature built from its
// input JSON schema, with each param's description as a comment. board_remove
// showed only `{ id: string }`, so a conductor cited an 8-char prefix and was
// refused. Two fixes are pinned here:
//   1. every id-taking param of every served tool carries a description saying
//      what it accepts, and board_remove.id / maintenance_remove.id say the
//      exact full uuid is required;
//   2. a refused prefix that names exactly ONE removable open item prints that
//      item's full uuid, so one retry suffices. The remove is STILL refused and
//      the item survives
//      (decision id-ladder-extends-to-board-tools-with-collision-guard: destroying paths take the exact full uuid only). An
//      ambiguous or unknown prefix names no uuid.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { createSterlingServer } from '../server.js';

const NOW = '2026-10-13T12:00:00.000Z';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-remove-hint-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

async function servedTools() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-param-docs-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail('expected the call to be refused');
}

// A second todo whose id shares `id`'s first 8 chars, so the prefix is ambiguous.
function seedTodoTwin(store: SterlingStore, tools: SterlingTools, id: string): void {
  const { record } = tools.boardAdd({ text: 'twin seed', source: 'user' }) as unknown as { record: Record<string, unknown> };
  store.remove(String(record.id), NOW);
  store.create({ ...(JSON.parse(JSON.stringify(record)) as Record<string, unknown>), id: `${id.slice(0, 8)}-0000-4000-8000-000000000000` });
}

test('board_remove: a unique live 8-char prefix is refused, the refusal names the matched full uuid, and the item is NOT removed', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as { record: { id: string } };
    const msg = refusal(() => tools.boardRemove(record.id.slice(0, 8)));
    assert.match(msg, /EXACT full uuid only/);
    assert.match(
      msg,
      new RegExp(`At the time of this refusal, the only open user-source item whose id starts with '${record.id.slice(0, 8)}' was ${record.id} \\("ship csv export"\\)`),
      `the refusal reports the matched full uuid and its text as seen at refusal time — got: ${msg}`
    );
    assert.doesNotMatch(msg, /exactly one/i, 'no uniqueness claim: the reads share no snapshot');
    assert.match(msg, /nothing was removed/);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'the item survives the refused call');
    assert.equal(tools.boardRemove(record.id, { outcome: 'done' }).removed, record.id, 'one retry with the named uuid removes it');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: a unique live 8-char prefix of a system item is refused naming its full uuid; the item survives', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/y.ts',
      file_keys: ['src/y.ts'],
    }) as unknown as { record: { id: string } };
    const msg = refusal(() => tools.maintenanceRemove(record.id.slice(0, 8)));
    assert.match(
      msg,
      new RegExp(`At the time of this refusal, the only open system-source item whose id starts with '${record.id.slice(0, 8)}' was ${record.id} `),
      `the refusal names the matched full uuid — got: ${msg}`
    );
    assert.doesNotMatch(msg, /exactly one/i, 'no uniqueness claim: the reads share no snapshot');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the item survives the refused call');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: a unique prefix of a USER item names no uuid (this tool could never remove it)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.boardAdd({ text: 'human task', source: 'user' }) as unknown as { record: { id: string } };
    const msg = refusal(() => tools.maintenanceRemove(record.id.slice(0, 8)));
    assert.doesNotMatch(msg, UUID_RE, `no uuid is offered — got: ${msg}`);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1);
  } finally {
    cleanup();
  }
});

test('board_remove: an AMBIGUOUS prefix, an unknown prefix and a prefix of a non-todo record name no uuid; nothing is removed', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as { record: { id: string } };
    seedTodoTwin(store, tools, record.id);
    const decision = tools.knowledgeCreate('decision', { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' })
      .record as unknown as { id: string };

    for (const cited of [record.id.slice(0, 8), 'zzzzzzzz', decision.id.slice(0, 8)]) {
      const msg = refusal(() => tools.boardRemove(cited, { outcome: 'done' }));
      assert.match(msg, /EXACT full uuid only/);
      assert.doesNotMatch(msg, UUID_RE, `'${cited}' must name no uuid — got: ${msg}`);
    }
    assert.equal(tools.boardQuery({ source: 'user' }).length, 2, 'both todos survive');
  } finally {
    cleanup();
  }
});

test('served input schemas: board_remove.id and maintenance_remove.id carry the exact-full-uuid description', async () => {
  const served = await servedTools();
  for (const name of ['board_remove', 'maintenance_remove']) {
    const tool = served.find((t) => t.name === name)!;
    const id = (tool.inputSchema.properties as Record<string, { description?: string }>).id;
    assert.match(id.description ?? '', /EXACT full uuid.*slug or an 8-char prefix is refused/, `${name}.id`);
  }
});

test('served input schemas: every id-taking param of every tool says what it accepts', async () => {
  const ID_PARAMS = new Set(['id', 'ids', 'old_id', 'in_favor_of', 'from', 'to', 'blocked_by', 'feature_link', 'resolves']);
  const undocumented: string[] = [];
  let checked = 0;
  for (const tool of await servedTools()) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    for (const [param, schema] of Object.entries(props)) {
      if (!ID_PARAMS.has(param)) continue;
      checked++;
      if (!/uuid/i.test(schema.description ?? '')) undocumented.push(`${tool.name}.${param}`);
    }
  }
  assert.ok(checked > 20, `the sweep saw the id params (${checked})`);
  assert.deepEqual(undocumented, [], 'each id param names the id forms it accepts');
});

test('board_remove: a prefix of a RETIRED (superseded) todo names no uuid — a retired row stays in the id index but is not an open item', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: retired } = tools.boardAdd({ text: 'retired task', source: 'user' }) as unknown as { record: { id: string } };
    const { record: survivor } = tools.boardAdd({ text: 'survivor task', source: 'user' }) as unknown as { record: { id: string } };
    store.retireInFavorOf(retired.id, survivor.id, NOW);
    assert.equal(store.get(retired.id)?.status, 'superseded', 'precondition: the todo is retired and still in the store');
    assert.ok(store.recordIdIndex().some((r) => r.id === retired.id), 'precondition: the retired todo is still in the id index');

    const msg = refusal(() => tools.boardRemove(retired.id.slice(0, 8)));
    assert.match(msg, /EXACT full uuid only/);
    assert.doesNotMatch(msg, UUID_RE, `a retired todo is not offered — got: ${msg}`);
    assert.ok(store.get(retired.id), 'nothing was removed');
  } finally {
    cleanup();
  }
});

test('board_remove: when the cited id is task B\'s exact slug AND a prefix of task A\'s uuid, no uuid is offered (the ladder would resolve the slug, not the prefix)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: a } = tools.boardAdd({ text: 'task A', source: 'user' }) as unknown as { record: { id: string } };
    const cited = a.id.slice(0, 8);
    const { record: bSeed } = tools.boardAdd({ text: 'task B', source: 'user' }) as unknown as { record: Record<string, unknown> };
    store.remove(String(bSeed.id), NOW);
    const bId = '00000000-0000-4000-8000-0000000000bb';
    store.create({ ...(JSON.parse(JSON.stringify(bSeed)) as Record<string, unknown>), id: bId, slug: cited });

    const got = tools.boardGet(cited) as unknown as { id?: string; record?: { id: string } };
    assert.equal(got.record?.id ?? got.id, bId, 'precondition: board_get resolves the cited id to task B by slug');

    const msg = refusal(() => tools.boardRemove(cited, { outcome: 'done' }));
    assert.match(msg, /EXACT full uuid only/);
    assert.doesNotMatch(msg, UUID_RE, `task A's uuid must not be offered for task B's slug — got: ${msg}`);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 2, 'both tasks survive');
  } finally {
    cleanup();
  }
});
