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
    assert.throws(
      () => h.tools.boardUpdate(item.id, { priority: 'low' }, { session: 'sess-B' }),
      /board_update: the task moved — session 'sess-A' in checkout 'main' holds it now/,
      'an edit naming a session that does not hold the claim is refused, nothing written'
    );
    assert.equal((h.store.get(item.id) as unknown as { priority: string }).priority, 'high');
    assert.equal(renewedAt(), T0);
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

test('generic knowledge writes cannot set or restore a claim: A to B takeover, then knowledge_update naming A is refused', () => {
  const h = harness(60);
  try {
    const item = addItem(h.tools, 'Takeover then restore attempt\nsee packages/store/src/index.ts');
    const gA = (h.tools.boardClaim(item.id, 'sess-A', 'wt-a') as { claim_state: ClaimState }).claim_state.generation!;
    h.clock.now = at(70);
    h.tools.boardTakeover(item.id, 'sess-B', 'wt-b', 'sess-A', gA);
    const storedA = { holder_session: 'sess-A', checkout: 'wt-a', generation: gA, claimed_at: T0, renewed_at: T0 };
    assert.throws(() => h.tools.knowledgeUpdate(item.id, { claim: storedA }), /'claim' is SERVER-OWNED/);
    assert.throws(() => h.tools.knowledgeEdit(item.id, 'claim', 'sess-B', 'sess-A'), /'claim' is SERVER-OWNED/);
    assert.throws(() => h.tools.boardRelease(item.id, 'sess-A', gA), /the task moved — session 'sess-B' in checkout 'wt-b'/);
    assert.throws(() => h.tools.boardUpdate(item.id, { priority: 'high' }, { session: 'sess-A' }), /board_update: the task moved — session 'sess-B'.*taken over from you at/);
    h.tools.knowledgeUpdate(item.id, { text: 'Takeover then restore attempt\nsee packages/store/src/index.ts, reworded' });
    assert.equal(claimOf(h.tools, item.id)?.holder_session, 'sess-B', 'an unrelated generic write keeps the claim');
  } finally {
    h.cleanup();
  }
});

test('claim_state is judged from the returned row, never from a second board read', () => {
  const h = harness(60);
  try {
    const item = addItem(h.tools, 'Row and claim agree\nsee packages/store/src/index.ts');
    const gA = (h.tools.boardClaim(item.id, 'sess-A', 'main') as { claim_state: ClaimState }).claim_state.generation!;
    // A takeover lands between the row read and the readiness read (as from another session).
    const handle = h.store as unknown as { boardReadiness: (...a: unknown[]) => unknown };
    const original = handle.boardReadiness.bind(h.store);
    let fired = false;
    handle.boardReadiness = (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        h.store.takeoverClaim(item.id, { session: 'sess-B', checkout: 'wt-b', expected_holder: 'sess-A', expected_generation: gA, now: T0 });
      }
      return original(...args);
    };
    const got = h.tools.boardGet(item.id) as unknown as { claim: { holder_session: string }; claim_state: ClaimState };
    assert.ok(fired, 'the takeover ran between the two reads');
    assert.equal(got.claim.holder_session, 'sess-A', 'the row was read before the takeover');
    assert.equal(got.claim_state.holder_session, got.claim.holder_session, 'claim_state agrees with the record it sits beside');
  } finally {
    h.cleanup();
  }
});

test('compact projections: digest rows carry claim_state, locally and through target_project; headline rows stay unchanged', () => {
  const h = harness(60);
  try {
    const local = addItem(h.tools, 'Local claimed\nsee packages/store/src/index.ts');
    h.tools.boardClaim(local.id, 'sess-A', 'main');
    const betaStore = new SterlingStore(join(h.beta, '.sterling', 'sterling.db'));
    let betaId: string;
    try {
      betaId = addItem(new SterlingTools({ store: betaStore, repoRoot: h.beta, now: () => T0 }), 'Beta claimed\nsee src/b.ts').id;
      betaStore.claimTodo(betaId, { session: 'beta-sess', checkout: 'beta-main', now: T0 });
    } finally {
      betaStore.close();
    }
    h.clock.now = at(90);
    const digest = h.tools.boardQueryResult({ source: 'user', projection: 'digest' }).records as unknown as Loose[];
    assert.deepEqual(
      { state: (digest[0].claim_state as ClaimState).state, holder: (digest[0].claim_state as ClaimState).holder_session },
      { state: 'expired', holder: 'sess-A' }
    );
    const headline = h.tools.boardQueryResult({ source: 'user', projection: 'headline' }).records as unknown as Loose[];
    assert.equal('claim_state' in headline[0], false, 'headline rows are left as they were');
    const foreign = h.tools.foreignBoardQuery({ target_project: 'beta', projection: 'digest' }).records as Loose[];
    assert.deepEqual(
      { id: foreign[0].id, state: (foreign[0].claim_state as ClaimState).state, holder: (foreign[0].claim_state as ClaimState).holder_session },
      { id: betaId, state: 'expired', holder: 'beta-sess' }
    );
    const foreignHeadline = h.tools.foreignBoardQuery({ target_project: 'beta', projection: 'headline' }).records as Loose[];
    assert.equal('claim_state' in foreignHeadline[0], false);
  } finally {
    h.cleanup();
  }
});

// Claim hand-over across /new (board 05fbab98): board_adopt moves an ended session's
// claims in this checkout, refuses ones in another checkout, and repeats as a no-op.
test('board_adopt: adopts the predecessor\'s claims, refuses another checkout, repeats as a no-op, and is served', async () => {
  const h = harness();
  try {
    const mine = addItem(h.tools, 'Handed over task\nsee packages/store/src/index.ts');
    const away = addItem(h.tools, 'Task in another worktree\nsee packages/store/src/index.ts');
    h.tools.boardClaim(mine.id, 'old', '/repo');
    h.tools.boardClaim(away.id, 'old', '/repo/wt-b');
    h.clock.now = at(3);
    const r = h.tools.boardAdopt('old', 'new', '/repo') as unknown as { adopted: Loose[]; already: Loose[]; refused: Loose[]; notice: string };
    assert.deepEqual(r.adopted.map((x) => x.id), [mine.id]);
    assert.equal(r.adopted[0].label, 'Handed over task');
    assert.deepEqual(r.refused.map((x) => [x.id, x.reason]), [[away.id, 'other_checkout']]);
    assert.match(String(r.refused[0].why), /board_takeover \(expected_holder 'old', expected_generation \d+\)/);
    assert.equal(claimOf(h.tools, mine.id)?.holder_session, 'new');
    assert.equal(claimOf(h.tools, away.id)?.holder_session, 'old', 'the other checkout keeps its holder');
    const again = h.tools.boardAdopt('old', 'new', '/repo') as unknown as { adopted: Loose[]; already: Loose[] };
    assert.deepEqual(again.adopted, []);
    assert.deepEqual(again.already.map((x) => x.id), [mine.id]);
    const none = h.tools.boardAdopt('nobody', 'new', '/repo') as unknown as { notice: string };
    assert.match(none.notice, /no board item is claimed by session 'nobody'; nothing was written/);
    assert.throws(() => h.tools.boardAdopt('', 'new', '/repo'), /from_session is required/);
  } finally {
    h.cleanup();
  }

  const dir = mkdtempSync(join(tmpdir(), 'sterling-adopt-mcp-'));
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const item = addItem(tools, 'Served adopt\nsee packages/store/src/index.ts');
    tools.boardClaim(item.id, 'old', 'main');
    const res = (await client.callTool({ name: 'board_adopt', arguments: { from_session: 'old', session: 'new', checkout: 'main' } })) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(res.isError, true, res.content[0]?.text);
    assert.equal((JSON.parse(res.content[0].text) as { adopted: Loose[] }).adopted.length, 1);
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
