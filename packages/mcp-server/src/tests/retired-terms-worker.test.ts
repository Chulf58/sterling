// Retired terms through worker mode and through failure (GitHub #188, Sol review
// round 1): a complete worker-mode MCP knowledge_update with `resolves` closes
// its retired_term_use item and changes the record; protected spans hold at the
// worker write on both the `body` and `fields` aliases; and a failure in the
// advisory scan after a write committed never turns the write into an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';
import type { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
const TOKEN = 'tok';
const RENAME = { term: 'North Barn', replacement: 'Hay Barn' };

const mkDecision = (tools: SterlingTools, fields: Loose) =>
  (tools.knowledgeCreate('decision', { alternatives_rejected: [], rationale: 'r', ...fields } as never) as unknown as { record: { id: string; version: number } }).record;

async function workerHarness(targetFields: Loose) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-retired-worker-'));
  const policyPath = join(dir, 'eligible.json');
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'), { workerPolicy: { path: policyPath, token: TOKEN } });
  const target = mkDecision(tools, targetFields);
  mkDecision(tools, { title: 'Rename North Barn to Hay Barn', statement: 'North Barn is now Hay Barn.', retired_terms: [RENAME] });
  const item = (tools.maintenanceQuery({ system_reason: 'retired_term_use', cap: 10 }) as unknown as { id: string; feature_link: string }[]).find((i) => i.feature_link === target.id)!;
  writeFileSync(policyPath, JSON.stringify({ policy_version: 1, token: TOKEN, run_id: 'run-1', policy_items: [{ id: item.id, lane: 'retired_term_use', target_id: target.id, file_keys: [] }] }));
  const client = new Client({ name: 'retired-worker-test', version: '0.0.1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Loose) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, target, item, call, cleanup };
}

const itemOpen = (tools: SterlingTools, id: string) => (tools.maintenanceQuery({ system_reason: 'retired_term_use', cap: 10 }) as unknown as { id: string }[]).some((i) => i.id === id);

test('worker mode, through the MCP server: the exact swap with resolves is written, stamped, and closes the item', async () => {
  const h = await workerHarness({ title: 'Feed in North Barn', statement: 'Hay goes to north barn; the user said "North Barn".' });
  try {
    assert.ok(itemOpen(h.tools, h.item.id), 'the item is open before the write');
    const r = await h.call('knowledge_update', {
      id: h.target.id,
      body: { title: 'Feed in Hay Barn', statement: 'Hay goes to Hay Barn; the user said "North Barn".' },
      expected_version: h.target.version,
      resolves: [h.item.id],
    });
    assert.equal(r.isError, false, r.text);
    const out = JSON.parse(r.text) as { worker_stamp?: { item_id: string; resolved: string[] } };
    assert.deepEqual(out.worker_stamp?.resolved, [h.item.id], 'the receipt says the item was closed');
    assert.equal(itemOpen(h.tools, h.item.id), false, 'the item is gone');
    const stored = h.tools.knowledgeGet(h.target.id) as unknown as { title: string; statement: string };
    assert.equal(stored.title, 'Feed in Hay Barn');
    assert.equal(stored.statement, 'Hay goes to Hay Barn; the user said "North Barn".');
  } finally {
    await h.cleanup();
  }
});

test('worker mode: a partial swap that would close the item while a use remains is refused', async () => {
  const h = await workerHarness({ title: 'Feed in North Barn', statement: 'Hay goes to north barn.' });
  try {
    const r = await h.call('knowledge_update', { id: h.target.id, body: { title: 'Feed in Hay Barn' }, expected_version: h.target.version, resolves: [h.item.id] });
    assert.equal(r.isError, true);
    assert.match(r.text, /worker policy refused knowledge_update/);
    assert.match(r.text, /still uses 'North Barn' in statement/);
    assert.ok(itemOpen(h.tools, h.item.id), 'the item stays open');
    assert.equal((h.tools.knowledgeGet(h.target.id) as unknown as { title: string }).title, 'Feed in North Barn', 'nothing was written');
  } finally {
    await h.cleanup();
  }
});

for (const alias of ['body', 'fields'] as const) {
  test(`worker mode (${alias} alias): a blockquote that breaks the term across a newline is protected, so rewriting it is refused`, async () => {
    const h = await workerHarness({ title: 'Quoted use', statement: 'Plain North Barn text.\n\n> North\nBarn stays quoted.' });
    try {
      const write = (statement: string) => h.call('knowledge_update', { id: h.target.id, [alias]: { statement }, expected_version: h.target.version, resolves: [h.item.id] });
      const bad = await write('Plain Hay Barn text.\n\n> Hay Barn stays quoted.');
      assert.equal(bad.isError, true, bad.text);
      assert.match(bad.text, /worker policy refused knowledge_update/);
      assert.match(bad.text, /not the stored value with the retired term/);
      const good = await write('Plain Hay Barn text.\n\n> North\nBarn stays quoted.');
      assert.equal(good.isError, false, good.text);
      assert.equal(itemOpen(h.tools, h.item.id), false);
    } finally {
      await h.cleanup();
    }
  });
}

test('a failure in the advisory scan after the write committed: the write result stands, with one explicit warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-retired-fault-'));
  const { store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  try {
    const original = store.retiredTermDecisions.bind(store);
    store.retiredTermDecisions = () => {
      throw new Error('injected scan failure');
    };
    const created = tools.knowledgeCreate('decision', { title: 'Rename North Barn', statement: 's', alternatives_rejected: [], rationale: 'r', retired_terms: [RENAME] } as never) as unknown as {
      record: { id: string };
      warnings: string[];
    };
    assert.ok(store.get(created.record.id), 'the record IS stored');
    assert.ok(created.warnings.some((w) => /retired-term check FAILED after the write committed \(injected scan failure\).*IS written/.test(w)), created.warnings.join('\n'));

    const upd = tools.knowledgeUpdateResult(created.record.id, { rationale: 'r2' });
    assert.ok(upd.warnings.some((w) => /retired-term check FAILED/.test(w)), 'an update carries the same warning');
    assert.equal((store.get(created.record.id) as unknown as { rationale: string }).rationale, 'r2', 'and the update is stored');

    const pre = tools.knowledgePreflight('Write fixtures for the feeding schedule tests today');
    assert.ok(pre.retired_terms?.some((w) => /retired-term check FAILED/.test(w)), 'preflight says the check did not run instead of throwing');

    store.retiredTermDecisions = original;
    assert.equal(tools.knowledgePreflight('Write the north barn feeding schedule tests').retired_terms?.length, 1, 'the check works again once the fault is gone');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
