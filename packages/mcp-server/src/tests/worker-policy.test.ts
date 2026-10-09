// Worker mode (GitHub #56 slice A): with --worker-policy/--worker-token the
// server refuses every mutation the run's batch policy does not allow, before
// it runs, and stamps every allowed write's receipt with {run_id, item_id}.
// Without them nothing changes. Driven through the registered MCP surface,
// because that is where the guard sits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { workerPolicySchema } from '@sterling/schemas';
import { createSterlingServer } from '../server.js';
import type { SterlingTools } from '../tools.js';
import { WORKER_STAMP_KEY, WorkerGuard, WorkerPolicyRefusal } from '../worker-policy.js';

type Loose = Record<string, unknown>;
const TOKEN = 'lock-token-1';
const RUN_ID = 'run-1';
const HERE = dirname(fileURLToPath(import.meta.url));

function mkArticle(tools: SterlingTools, slug: string, files: string[], state = 'active'): string {
  const fields = {
    slug,
    title: slug,
    what_it_does: 'does the thing.',
    intended_behavior: 'intends the thing.',
    files: files.map((path) => ({ path, role: 'a file' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state,
    history: [{ date: '2026-10-09T00:00:00.000Z', event: 'seed' }],
    live_test_refs: [],
  };
  return (tools.knowledgeCreate('feature_article', fields as never) as unknown as { record: { id: string } }).record.id;
}

async function harness(opts: { worker?: boolean } = { worker: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-policy-'));
  const policyPath = join(dir, 'maintenance-worker.eligible.json');
  const { server, store, tools } = createSterlingServer(
    join(dir, 'sterling.db'),
    opts.worker === false ? {} : { workerPolicy: { path: policyPath, token: TOKEN } }
  );
  // Seeded through SterlingTools directly: the guard sits on the MCP surface only.
  const recon = mkArticle(tools, 'recon-article', ['src/a/one.ts']);
  const state = mkArticle(tools, 'state-article', ['src/b/one.ts']);
  const join_ = mkArticle(tools, 'join-article', ['src/c/one.ts']);
  const finding = (
    tools.knowledgeCreate('research_finding', {
      question: 'does x hold?',
      answer: 'yes',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
    } as never) as unknown as { record: { id: string } }
  ).record.id;
  const reference = (
    tools.knowledgeCreate('reference_material', {
      title: 'a reference',
      kind: 'url',
      location: 'https://example.com/doc',
      summary: 'old summary',
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
    } as never) as unknown as { record: { id: string } }
  ).record.id;
  const decision = (
    tools.knowledgeCreate('decision', { title: 'a ruling', statement: 'we do x', alternatives_rejected: [], rationale: 'because' } as never) as unknown as {
      record: { id: string };
    }
  ).record.id;
  const queued = (tools.maintenanceEnqueue({ reason: 'stale_research', text: 'does x hold? is stale', feature_link: finding }) as unknown as { record: { id: string } }).record
    .id;
  // An article_missing item as H10 mints it: no feature_link, so the policy
  // carries target_id null. Its second path sits in a directory the join
  // article does not own, so a join of the first path is partial.
  const missing = (
    tools.maintenanceEnqueue({ reason: 'article_missing', text: 'src/c/two.ts and src/d/other.ts have no owning article', file_keys: ['src/c/two.ts', 'src/d/other.ts'] }) as unknown as {
      record: { id: string };
    }
  ).record.id;
  const ids = {
    recon,
    state,
    join: join_,
    finding,
    reference,
    decision,
    reconItem: randomUUID(),
    stateItem: randomUUID(),
    staleItem: queued,
    refItem: randomUUID(),
    missItem: missing,
  };
  const policy = {
    token: TOKEN,
    head: 'abc',
    host: 'claude',
    items: [{ id: queued, file_keys: [], feature_link: finding, slug: null }],
    policy_version: 1,
    run_id: RUN_ID,
    policy_items: [
      { id: ids.reconItem, lane: 'reconcile_needed', target_id: recon, file_keys: ['src/a/one.ts'] },
      { id: ids.stateItem, lane: 'state_review', target_id: state, file_keys: [] },
      { id: ids.staleItem, lane: 'stale_research', target_id: finding, file_keys: [] },
      { id: ids.refItem, lane: 'refresh_reference', target_id: reference, file_keys: [] },
      { id: ids.missItem, lane: 'article_missing', target_id: null, file_keys: ['src/c/two.ts', 'src/d/other.ts'] },
    ],
  };
  const writePolicy = (value: unknown) => writeFileSync(policyPath, typeof value === 'string' ? value : JSON.stringify(value));
  writePolicy(policy);
  const client = new Client({ name: 'worker-policy-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Loose) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content[0].text };
  };
  const ok = async (name: string, args: Loose): Promise<Loose> => {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name} should succeed, got: ${r.text}`);
    return JSON.parse(r.text) as Loose;
  };
  const refused = async (name: string, args: Loose, rule: string, item?: string): Promise<string> => {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} should be refused, got: ${r.text}`);
    assert.match(r.text, new RegExp(`worker policy refused ${name}: rule '${rule}'`), r.text);
    if (item) assert.ok(r.text.includes(item), `the refusal names policy item ${item}: ${r.text}`);
    assert.match(r.text, /Nothing was written/);
    return r.text;
  };
  const version = (id: string) => (tools.knowledgeGet(id) as unknown as { version: number }).version;
  const get = (id: string) => tools.knowledgeGet(id) as unknown as Loose;
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { ids, policy, policyPath, writePolicy, call, ok, refused, version, get, cleanup };
}

test('no policy: without worker mode, writes behave as before and carry no stamp', async () => {
  const h = await harness({ worker: false });
  try {
    const created = await h.ok('knowledge_create', {
      type: 'decision',
      fields: { title: 'free write', statement: 's', alternatives_rejected: [], rationale: 'r' },
    });
    assert.equal(created[WORKER_STAMP_KEY], undefined);
    const updated = await h.ok('knowledge_update', { id: h.ids.decision, body: { statement: 'changed' } });
    assert.equal(updated[WORKER_STAMP_KEY], undefined);
    assert.equal(h.get(h.ids.decision).statement, 'changed');
    await h.ok('board_add', { text: 'a user task', source: 'user', objective: 'standalone' });
  } finally {
    await h.cleanup();
  }
});

test('fail closed: a missing, unparseable, schema-failing or wrong-token policy refuses every mutation; reads still work', async () => {
  const h = await harness();
  try {
    const write = { id: h.ids.recon, body: { what_it_does: 'new sentence.' }, expected_version: h.version(h.ids.recon) };
    const before = h.version(h.ids.recon);
    rmSync(h.policyPath);
    await h.refused('knowledge_update', write, 'policy_unreadable');
    await h.ok('knowledge_get', { id: h.ids.recon });
    h.writePolicy('{not json');
    await h.refused('knowledge_update', write, 'policy_unreadable');
    h.writePolicy({ ...h.policy, policy_version: 2 });
    await h.refused('knowledge_update', write, 'policy_schema');
    h.writePolicy({ ...h.policy, policy_items: [{ ...h.policy.policy_items[0], lane: 'deletion_candidate' }] });
    await h.refused('knowledge_update', write, 'policy_schema');
    h.writePolicy({ ...h.policy, token: 'another-run' });
    await h.refused('knowledge_update', write, 'policy_token_mismatch');
    await h.refused('maintenance_remove', { id: h.ids.reconItem }, 'policy_token_mismatch');
    assert.equal(h.version(h.ids.recon), before, 'nothing was written');
  } finally {
    await h.cleanup();
  }
});

test('reconcile_needed: a factual field on the batch target is allowed and stamped; title and an off-batch target are refused', async () => {
  const h = await harness();
  try {
    const receipt = await h.ok('knowledge_update', {
      id: h.ids.recon,
      body: { what_it_does: 'does the corrected thing.' },
      expected_version: h.version(h.ids.recon),
    });
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.reconItem, resolved: [] });
    assert.equal(h.get(h.ids.recon).what_it_does, 'does the corrected thing.');

    const before = h.version(h.ids.recon);
    await h.refused('knowledge_update', { id: h.ids.recon, body: { title: 'renamed' }, expected_version: before }, 'field_not_allowed', h.ids.reconItem);
    await h.refused('knowledge_edit', { id: h.ids.recon, field: 'slug', find: 'recon', replace: 'other' }, 'field_not_allowed', h.ids.reconItem);
    await h.refused('knowledge_update', { id: h.ids.decision, body: { statement: 'x' }, expected_version: 1 }, 'target_not_in_batch');
    await h.refused('knowledge_update', { id: 'recon-article', body: { what_it_does: 'x.' }, expected_version: before }, 'target_not_in_batch');
    await h.refused('knowledge_update', { id: h.ids.recon, body: { what_it_does: 'x.' } }, 'expected_version_required', h.ids.reconItem);
    assert.equal(h.version(h.ids.recon), before);
  } finally {
    await h.cleanup();
  }
});

test('state_review: state_reason is allowed and stamped; a prose edit is refused', async () => {
  const h = await harness();
  try {
    const receipt = await h.ok('knowledge_update', {
      id: h.ids.state,
      body: { state_reason: 'in use by the runner' },
      expected_version: h.version(h.ids.state),
    });
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.stateItem, resolved: [] });
    await h.refused('knowledge_edit', { id: h.ids.state, field: 'what_it_does', find: 'does', replace: 'did' }, 'field_not_allowed', h.ids.stateItem);
    await h.refused('knowledge_update', { id: h.ids.finding, body: { state_reason: 'x' }, expected_version: 1 }, 'field_not_allowed', h.ids.staleItem);
  } finally {
    await h.cleanup();
  }
});

test('stale_research: source_date is allowed and stamped; the question is refused', async () => {
  const h = await harness();
  try {
    const receipt = await h.ok('knowledge_update', {
      id: h.ids.finding,
      body: { source_date: '2026-10-09', capture_date: '2026-10-09' },
      expected_version: h.version(h.ids.finding),
    });
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.staleItem, resolved: [] });
    assert.equal(h.get(h.ids.finding).source_date, '2026-10-09');
    await h.refused('knowledge_update', { id: h.ids.finding, body: { question: 'a new question?' }, expected_version: h.version(h.ids.finding) }, 'field_not_allowed', h.ids.staleItem);
  } finally {
    await h.cleanup();
  }
});

test('refresh_reference: summary is allowed and stamped; location is refused', async () => {
  const h = await harness();
  try {
    const receipt = await h.ok('knowledge_update', {
      id: h.ids.reference,
      body: { summary: 'new summary' },
      expected_version: h.version(h.ids.reference),
    });
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.refItem, resolved: [] });
    await h.refused(
      'knowledge_update',
      { id: h.ids.reference, body: { location: 'https://example.com/elsewhere' }, expected_version: h.version(h.ids.reference) },
      'field_not_allowed',
      h.ids.refItem
    );
  } finally {
    await h.cleanup();
  }
});

test('article_missing: with target_id null (as H10 mints it), a join that names its item in resolves is allowed in a directory the article already owns; another directory, a foreign path, another write or no resolves is refused', async () => {
  const h = await harness();
  try {
    const join = (path: string, extra: Loose = {}) => ({ id: h.ids.join, field: 'files', entries: [{ path, role: 'a file' }], resolves: [h.ids.missItem], ...extra });
    const before = h.version(h.ids.join);
    const dir = await h.refused('knowledge_append', join('src/d/other.ts'), 'append_join', h.ids.missItem);
    assert.match(dir, /owns no path in src\/d\//);
    const foreign = await h.refused('knowledge_append', join('src/c/three.ts'), 'append_join', h.ids.missItem);
    assert.match(foreign, /not one of the item's file_keys/);
    await h.refused('knowledge_append', { id: h.ids.join, field: 'history', entries: [{ date: '2026-10-09T00:00:00.000Z', event: 'x' }], resolves: [h.ids.missItem] }, 'field_not_allowed', h.ids.missItem);
    await h.refused('knowledge_edit', { id: h.ids.join, field: 'what_it_does', find: 'does', replace: 'did', resolves: [h.ids.missItem] }, 'field_not_allowed', h.ids.missItem);
    await h.refused('knowledge_append', { id: h.ids.join, field: 'files', entries: [{ path: 'src/c/two.ts', role: 'x' }] }, 'target_not_in_batch');
    await h.refused('knowledge_append', join('src/c/two.ts', { id: h.ids.decision }), 'field_not_allowed', h.ids.missItem);
    assert.equal(h.version(h.ids.join), before);

    // The join covers one of the item's two paths: the server rewrites the
    // item and keeps it open, and the stamp says it closed nothing.
    const receipt = await h.ok('knowledge_append', join('src/c/two.ts'));
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.missItem, resolved: [] });
    assert.deepEqual(
      (h.get(h.ids.join).files as { path: string }[]).map((f) => f.path),
      ['src/c/one.ts', 'src/c/two.ts']
    );
    assert.deepEqual(h.get(h.ids.missItem).file_keys, ['src/d/other.ts'], 'the item stays open with the path nothing owns');
  } finally {
    await h.cleanup();
  }
});

test('cross-lane: a write that resolves an item is judged by that item\'s lane only; resolves names one item; a line-reference fix needs a reconcile_needed item', async () => {
  const h = await harness();
  try {
    const stateOnRecon = randomUUID();
    h.writePolicy({ ...h.policy, policy_items: [...h.policy.policy_items, { id: stateOnRecon, lane: 'state_review', target_id: h.ids.recon, file_keys: [] }] });
    const before = h.version(h.ids.recon);
    const edit = { id: h.ids.recon, body: { what_it_does: 'does the corrected thing.' }, expected_version: before };
    // reconcile_needed allows what_it_does, but the write closes the state_review item.
    const crossed = await h.refused('knowledge_update', { ...edit, resolves: [stateOnRecon] }, 'field_not_allowed', stateOnRecon);
    assert.match(crossed, /lane state_review/);
    assert.doesNotMatch(crossed, /reconcile_needed\)/, 'the reconcile_needed item is not consulted');
    await h.refused('knowledge_update', { ...edit, resolves: [h.ids.reconItem, stateOnRecon] }, 'resolves_one_item');
    await h.refused('knowledge_update', { ...edit, resolves: [h.ids.stateItem] }, 'target_not_in_batch', h.ids.stateItem);
    assert.equal(h.version(h.ids.recon), before);

    const fix = { field: 'what_it_does', find: 'src/b/one.ts:1', replace: 'src/b/one.ts:2', anchor: 'export const b' };
    const lane = await h.refused('knowledge_line_ref_fix', { id: h.ids.state, ...fix }, 'line_ref_fix_lane', h.ids.stateItem);
    assert.match(lane, /is state_review/);
    assert.equal(h.version(h.ids.state), 1);

    // Without resolves the write closes nothing, and the stamp names the item whose lane allowed it.
    const receipt = await h.ok('knowledge_update', edit);
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.reconItem, resolved: [] });
  } finally {
    await h.cleanup();
  }
});

test('resolves naming an item outside the batch is refused before the write', async () => {
  const h = await harness();
  try {
    const before = h.version(h.ids.recon);
    const outsider = randomUUID();
    const text = await h.refused(
      'knowledge_update',
      { id: h.ids.recon, body: { what_it_does: 'x.' }, expected_version: before, resolves: [outsider] },
      'resolves_outside_batch',
      h.ids.reconItem
    );
    assert.ok(text.includes(outsider));
    assert.equal(h.version(h.ids.recon), before);
  } finally {
    await h.cleanup();
  }
});

test('maintenance_remove: an item outside the batch is refused; a batch item is removed and stamped', async () => {
  const h = await harness();
  try {
    await h.refused('maintenance_remove', { id: randomUUID() }, 'item_not_in_batch');
    const receipt = await h.ok('maintenance_remove', { id: h.ids.staleItem });
    assert.deepEqual(receipt[WORKER_STAMP_KEY], { run_id: RUN_ID, item_id: h.ids.staleItem, resolved: [h.ids.staleItem] });
  } finally {
    await h.cleanup();
  }
});

test('creates, retires, links, board writes and config writes are refused in worker mode', async () => {
  const h = await harness();
  try {
    await h.refused('knowledge_create', { type: 'decision', fields: { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' } }, 'tool_not_allowed_in_worker_mode');
    await h.refused('knowledge_retire', { id: h.ids.recon, in_favor_of: h.ids.state }, 'tool_not_allowed_in_worker_mode');
    await h.refused('knowledge_link', { from: h.ids.recon, to: h.ids.state, rel: 'cites' }, 'tool_not_allowed_in_worker_mode');
    await h.refused('board_add', { text: 'x', source: 'user', objective: 'standalone' }, 'tool_not_allowed_in_worker_mode');
    await h.refused('board_remove', { id: h.ids.reconItem }, 'tool_not_allowed_in_worker_mode');
    await h.refused('config_set', { path: 'tdd.enabled', value: true }, 'tool_not_allowed_in_worker_mode');
    await h.refused('domain_describe', { domain: 'x', description: 'y' }, 'tool_not_allowed_in_worker_mode');
  } finally {
    await h.cleanup();
  }
});

test('the shared fixture parses under workerPolicySchema and keeps its unknown keys', () => {
  const fixture = JSON.parse(readFileSync(join(HERE, '..', '..', '..', '..', 'scripts', 'tests', 'fixtures', 'worker-policy.json'), 'utf8'));
  const parsed = workerPolicySchema.parse(fixture);
  assert.equal(parsed.policy_items.length, 4);
  assert.equal((parsed as Loose).host, 'claude');
  assert.ok(Array.isArray((parsed as Loose).items), 'the runner\'s own items list passes through');
});

test('argv: one worker flag without the other, or a relative policy path, refuses boot', () => {
  const mainJs = join(HERE, '..', 'main.js');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-argv-'));
  try {
    const store = join(dir, 'sterling.db');
    for (const extra of [['--worker-policy', join(dir, 'p.json')], ['--worker-token', 't'], ['--worker-policy', 'rel.json', '--worker-token', 't']]) {
      const r = spawnSync(process.execPath, [mainJs, '--store', store, ...extra], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 2, `${extra.join(' ')} -> ${r.stderr}`);
      assert.match(r.stderr, /--worker-policy/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a batch target the project store does not hold is refused by the storage layer answer, whatever its scope field says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-held-'));
  try {
    const target = randomUUID();
    const item = randomUUID();
    const path = join(dir, 'eligible.json');
    writeFileSync(
      path,
      JSON.stringify({ policy_version: 1, token: TOKEN, run_id: RUN_ID, policy_items: [{ id: item, lane: 'reconcile_needed', target_id: target, file_keys: [] }] })
    );
    // The record claims scope 'project' in its body; only projectStoreHolds decides.
    const records = {
      projectStoreHolds: (id: string) => id !== target,
      get: () => ({ id: target, type: 'feature_article', scope: 'project', files: [] }),
    };
    const guard = new WorkerGuard({ path, token: TOKEN }, records as never);
    assert.throws(
      () => guard.authorize('knowledge_update', { id: target, body: { what_it_does: 'x.' }, expected_version: 1 }),
      (e: unknown) => e instanceof WorkerPolicyRefusal && e.rule === 'target_not_project_held' && e.itemIds.includes(item)
    );
    assert.equal(guard.authorize('knowledge_get', { id: target }), null, 'reads are not judged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
