// Board task claims on the tool surface (decision
// board-task-claims-for-parallel-sessions-claim-generation-ren): the four
// claim tools are served, board_update cannot set a claim but renews the
// caller's own claim inside its write, and board_get / board_query report the
// claim state, including through target_project reads of another project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry, SterlingStore } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingTools } from '../tools.js';
import { createSterlingServer } from '../server.js';

const T0 = '2026-10-25T09:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
type Loose = Record<string, unknown>;
type ClaimState = { state: string; holder_session?: string; checkout?: string; generation?: number; minutes_since_renewal?: number };

function projectDir(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), '{}');
  new SterlingStore(join(root, '.sterling', 'sterling.db')).close();
  return root;
}

function harness(leaseMinutes = 60) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-claims-'));
  const alpha = projectDir(base, 'alpha');
  const beta = projectDir(base, 'beta');
  const reg = join(base, 'registry.db');
  const registry = new ProjectRegistry(reg);
  for (const [name, repo_path] of [['alpha', alpha], ['beta', beta]]) registry.register({ repo_path, name, stack_tags: [], toolchains: [], sterling_version: null, at: T0 });
  const clock = { now: T0 };
  const store = new SterlingStore(join(alpha, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: alpha, registryPath: reg, now: () => clock.now, config: parseConfig({ board_claims: { lease_minutes: leaseMinutes } }) });
  return {
    beta,
    clock,
    store,
    tools,
    cleanup: () => {
      store.close();
      registry.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function addItem(tools: SterlingTools, text: string): { id: string; slug: string } {
  const r = tools.boardAdd({ text, source: 'user', objective: 'standalone' }) as unknown as { record: { id: string; slug: string } };
  return r.record;
}

const claimOf = (tools: SterlingTools, id: string) => (tools.boardGet(id) as unknown as Loose).claim_state as ClaimState | undefined;

test('claim, reaffirm, takeover and release through the tools; board_get reports held, expired and none', () => {
  const h = harness(60);
  try {
    const item = addItem(h.tools, 'Ship the claim tools\nsee packages/store/src/index.ts');
    assert.equal(claimOf(h.tools, item.id), undefined, 'an unclaimed item carries no claim_state');
    const claimed = h.tools.boardClaim(item.slug, 'sess-A', 'main') as { claim_state: ClaimState };
    assert.equal(claimed.claim_state.state, 'held');
    const g1 = claimed.claim_state.generation!;
    assert.throws(() => h.tools.boardClaim(item.id, 'sess-B', 'wt-b'), /session 'sess-A' in checkout 'main' holds this task/);

    h.clock.now = at(45);
    assert.deepEqual(
      { state: claimOf(h.tools, item.id)?.state, minutes: claimOf(h.tools, item.id)?.minutes_since_renewal },
      { state: 'held', minutes: 45 }
    );
    h.clock.now = at(61);
    assert.equal(claimOf(h.tools, item.id)?.state, 'expired', 'past the configured lease the claim shows as check owner');
    const query = h.tools.boardQueryResult({ source: 'user' }).records as unknown as Loose[];
    assert.equal((query[0].claim_state as ClaimState).state, 'expired', 'board_query text rows carry the claim state');

    const taken = h.tools.boardTakeover(item.id, 'sess-B', 'wt-b', 'sess-A', g1) as { claim_state: ClaimState; notice: string };
    assert.ok(taken.claim_state.generation! > g1);
    assert.match(taken.notice, /taken over from session 'sess-A'/);
    assert.throws(() => h.tools.boardReaffirm(item.id, 'sess-A', g1), /the task moved — session 'sess-B' in checkout 'wt-b'/);
    assert.throws(() => h.tools.boardRelease(item.id, 'sess-A', g1), /the task moved/);
    h.tools.boardReaffirm(item.id, 'sess-B', taken.claim_state.generation!);
    const released = h.tools.boardRelease(item.id, 'sess-B', taken.claim_state.generation!) as { claim_state: ClaimState };
    assert.deepEqual(released.claim_state, { state: 'none' });
    assert.equal(claimOf(h.tools, item.id), undefined);
    assert.throws(() => h.tools.boardClaim(item.id, '  ', 'main'), /session is required/);
  } finally {
    h.cleanup();
  }
});

test('board_update renews the caller-holder claim inside its own write, at most once per quarter lease', () => {
  const h = harness(60);
  try {
    const item = addItem(h.tools, 'Renew by task work\nsee packages/store/src/index.ts');
    h.tools.boardClaim(item.id, 'sess-A', 'main');
    const renewedAt = () => ((h.store.get(item.id) as unknown as { claim: { renewed_at: string } }).claim.renewed_at);
    h.clock.now = at(10);
    h.tools.boardUpdate(item.id, { priority: 'high' }, { session: 'sess-A' });
    assert.equal(renewedAt(), T0, 'inside lease/4: no renewal');
    h.clock.now = at(20);
    h.tools.boardUpdate(item.id, { priority: 'low' }, { session: 'sess-B' });
    assert.equal(renewedAt(), T0, 'an edit by a non-holder renews nothing');
    h.tools.boardUpdate(item.id, { priority: 'normal' });
    assert.equal(renewedAt(), T0, 'an edit naming no session renews nothing');
    const before = (h.store.get(item.id) as unknown as { version: number }).version;
    h.tools.boardUpdate(item.id, { priority: 'high' }, { session: 'sess-A' });
    assert.equal(renewedAt(), at(20), 'the holder editing its item renews the claim');
    assert.equal((h.store.get(item.id) as unknown as { version: number }).version, before + 1, 'the renewal rides the edit: one write, one version');
  } finally {
    h.cleanup();
  }
});

test('board_update cannot set a claim: the tool layer refuses it by name and the served schema is strict', async () => {
  const h = harness();
  try {
    const item = addItem(h.tools, 'No claim by edit\nsee packages/store/src/index.ts');
    const forged = { holder_session: 'x', checkout: 'y', generation: 1, claimed_at: T0, renewed_at: T0 };
    assert.throws(() => h.tools.boardUpdate(item.id, { claim: forged }), /'claim' is not editable through board_update/);
    assert.equal(claimOf(h.tools, item.id), undefined);
  } finally {
    h.cleanup();
  }

  const dir = mkdtempSync(join(tmpdir(), 'sterling-claims-mcp-'));
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const item = addItem(tools, 'Served schema check\nsee packages/store/src/index.ts');
    const refused = (await client.callTool({ name: 'board_update', arguments: { id: item.id, claim: { holder_session: 'x' } } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /claim/);
    const ok = (await client.callTool({ name: 'board_claim', arguments: { id: item.id, session: 's1', checkout: 'main' } })) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(ok.isError, true, ok.content[0]?.text);
    assert.equal((JSON.parse(ok.content[0].text) as { claim_state: ClaimState }).claim_state.holder_session, 's1');
    const edited = (await client.callTool({ name: 'board_update', arguments: { id: item.id, priority: 'high', session: 's1' } })) as { isError?: boolean };
    assert.notEqual(edited.isError, true, 'session is accepted on board_update');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cross-project read (target_project) shows the other board claim state', () => {
  const h = harness(60);
  try {
    const betaStore = new SterlingStore(join(h.beta, '.sterling', 'sterling.db'));
    let betaId: string;
    try {
      const betaTools = new SterlingTools({ store: betaStore, repoRoot: h.beta, now: () => T0 });
      betaId = addItem(betaTools, 'Beta task\nsee src/b.ts').id;
      betaStore.claimTodo(betaId, { session: 'beta-sess', checkout: 'beta-main', now: T0 });
    } finally {
      betaStore.close();
    }
    h.clock.now = at(30);
    const got = h.tools.foreignBoardGet(betaId, 'beta');
    assert.deepEqual(
      { state: (got.claim_state as ClaimState).state, holder: (got.claim_state as ClaimState).holder_session, minutes: (got.claim_state as ClaimState).minutes_since_renewal },
      { state: 'held', holder: 'beta-sess', minutes: 30 }
    );
    h.clock.now = at(120);
    const rows = h.tools.foreignBoardQuery({ target_project: 'beta' }).records as Loose[];
    assert.equal((rows[0].claim_state as ClaimState).state, 'expired');
    assert.equal((rows[0].claim_state as ClaimState).checkout, 'beta-main');
  } finally {
    h.cleanup();
  }
});
