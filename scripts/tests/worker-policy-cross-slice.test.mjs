// GitHub #56, slices A and B together: the eligible.json the launcher writes
// (slice B, maybeLaunchMaintenanceWorker) is the policy the worker's own
// Sterling server enforces (slice A, workerPolicySchema and WorkerGuard), and
// the MCP config resolveMcpConfig builds boots that server in worker mode.
// The launcher's spawn and git probe are fakes; the server is real, spawned
// over stdio from the plugin wiring (the mcp bundle) and from dist/main.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { workerPolicySchema } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { maybeLaunchMaintenanceWorker, resolveMcpConfig, runWorker, workerPaths, DEBOUNCE_MS, STAMP_KEY, WORKER_LANES } from '../hooks/lib/maintenance-worker.mjs';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(REPO, 'mcp', 'sterling-mcp.mjs');
const DIST_MAIN = join(REPO, 'packages', 'mcp-server', 'dist', 'main.js');
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR_AGO = new Date(NOW - 60 * 60_000).toISOString();

const cleanGit = (cmd, args) => (args.includes('rev-parse') ? { status: 0, stdout: `${'a'.repeat(40)}\n\n` } : { status: 0, stdout: '' });
const inertSpawn = () => Object.assign(new EventEmitter(), { pid: 4242, unref() {} });

/** A project whose store holds one feature_article, and the launcher run over one queue item per worker lane, the first targeting it. */
function launchedProject() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-worker-cross-'));
  const project = join(base, 'project');
  mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
  const store = new SterlingStore(join(project, '.sterling', 'sterling.db'));
  let article;
  try {
    const tools = new SterlingTools({ store, now: () => new Date(NOW).toISOString() });
    article = tools.knowledgeCreate('feature_article', {
      slug: 'cross-article',
      title: 'cross article',
      what_it_does: 'does the thing.',
      intended_behavior: 'intends the thing.',
      files: [{ path: 'src/a/one.ts', role: 'a file' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      history: [{ date: '2026-10-09T00:00:00.000Z', event: 'seed' }],
      live_test_refs: [],
    }).record.id;
  } finally {
    store.close();
  }
  const items = WORKER_LANES.map((lane, i) => ({
    id: randomUUID(),
    system_reason: lane,
    text: `item for ${lane}`,
    file_keys: [`src/${lane}/f${i}.ts`],
    feature_link: i === 0 ? article : null,
    created_at: HOUR_AGO,
  }));
  const result = maybeLaunchMaintenanceWorker({
    root: project,
    config: null,
    items,
    trigger: 'stop',
    now: NOW,
    pluginRoot: REPO,
    env: {},
    isAlive: () => false,
    spawnSync: cleanGit,
    spawn: inertSpawn,
  });
  assert.equal(result.launched, true, JSON.stringify(result));
  const eligiblePath = workerPaths(project).eligible;
  const eligible = JSON.parse(readFileSync(eligiblePath, 'utf8'));
  return { base, project, article, items, eligible, eligiblePath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("the launcher's eligible.json parses under workerPolicySchema, with one policy item per worker lane", () => {
  const fx = launchedProject();
  try {
    const parsed = workerPolicySchema.safeParse(fx.eligible);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    assert.deepEqual(
      parsed.data.policy_items.map((p) => p.lane),
      WORKER_LANES,
      'every lane the worker drains is a lane the server policy accepts'
    );
    assert.deepEqual(parsed.data.policy_items[0], { id: fx.items[0].id, lane: 'reconcile_needed', target_id: fx.article, file_keys: fx.items[0].file_keys });
  } finally {
    fx.cleanup();
  }
});

test('resolveMcpConfig worker args boot the server in worker mode: one allowed write is stamped, one refused write writes nothing', async () => {
  const fx = launchedProject();
  try {
    const entry = JSON.parse(resolveMcpConfig(REPO, fx.project, { path: fx.eligiblePath, token: fx.eligible.token })).mcpServers.sterling;
    assert.deepEqual(entry.args.slice(-4), ['--worker-policy', fx.eligiblePath, '--worker-token', fx.eligible.token]);
    assert.ok(entry.args.includes(BUNDLE), `the plugin wiring runs the mcp bundle: ${entry.args.join(' ')}`);
    const item = fx.eligible.policy_items[0];
    // The plugin wiring as resolved, then the same argv against dist/main.js.
    for (const args of [entry.args, entry.args.map((a) => (a === BUNDLE ? DIST_MAIN : a))]) {
      const transport = new StdioClientTransport({ command: entry.command, args, cwd: fx.project, stderr: 'pipe' });
      let stderr = '';
      transport.stderr?.on('data', (d) => (stderr += d));
      const client = new Client({ name: 'worker-cross-slice-test', version: '0.0.1' });
      try {
        await client.connect(transport);
        const call = async (name, a) => {
          const r = await client.callTool({ name, arguments: a });
          return { isError: r.isError === true, text: r.content[0].text };
        };
        const read = async () => JSON.parse((await call('knowledge_get', { id: fx.article })).text);
        const before = await read();

        const allowed = await call('knowledge_update', { id: fx.article, body: { what_it_does: `corrected by ${args.includes(BUNDLE) ? 'bundle' : 'dist'}.` }, expected_version: before.version });
        assert.equal(allowed.isError, false, `${allowed.text}\n${stderr}`);
        assert.deepEqual(JSON.parse(allowed.text)[STAMP_KEY], { run_id: fx.eligible.run_id, item_id: item.id, resolved: [] });

        const mid = await read();
        assert.equal(mid.version, before.version + 1);
        const refused = await call('knowledge_update', { id: fx.article, body: { title: 'renamed' }, expected_version: mid.version });
        assert.equal(refused.isError, true, refused.text);
        assert.match(refused.text, /worker policy refused knowledge_update: rule 'field_not_allowed'/);
        assert.ok(refused.text.includes(item.id), refused.text);
        const after = await read();
        assert.equal(after.version, mid.version, 'the refused write wrote nothing');
        assert.equal(after.title, 'cross article');
      } finally {
        await client.close();
      }
    }
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ article_missing joins (H10 items carry no feature_link)

/** A project whose store holds a feature_article owning src/c/one.ts and one
 *  article_missing item minted the way H10 mints it: file_keys, no feature_link. */
function articleMissingProject(fileKeys) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-worker-join-'));
  const project = join(base, 'project');
  const db = join(project, '.sterling', 'sterling.db');
  mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
  const store = new SterlingStore(db);
  let article;
  let item;
  try {
    const tools = new SterlingTools({ store, now: () => HOUR_AGO });
    article = tools.knowledgeCreate('feature_article', {
      slug: 'join-article',
      title: 'join article',
      what_it_does: 'does the thing.',
      intended_behavior: 'intends the thing.',
      files: [{ path: 'src/c/one.ts', role: 'a file' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      history: [{ date: '2026-10-09T00:00:00.000Z', event: 'seed' }],
      live_test_refs: [],
    }).record.id;
    item = tools.maintenanceEnqueue({ reason: 'article_missing', text: `${fileKeys.join(', ')} have no owning article`, file_keys: fileKeys }).record.id;
  } finally {
    store.close();
  }
  const withStore = (fn) => {
    const s = new SterlingStore(db);
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  // The launcher reads the open queue from the store, as the Stop hook does.
  const launch = (now = NOW) =>
    withStore((s) => maybeLaunchMaintenanceWorker({ root: project, config: null, store: s, trigger: 'stop', now, pluginRoot: REPO, env: {}, isAlive: () => false, spawnSync: cleanGit, spawn: inertSpawn }));
  const eligible = () => JSON.parse(readFileSync(workerPaths(project).eligible, 'utf8'));
  /** Start the worker's server from resolveMcpConfig, as the runner does, and append `path` to the article resolving the item. */
  const join_ = async (path) => {
    const e = eligible();
    const entry = JSON.parse(resolveMcpConfig(REPO, project, { path: workerPaths(project).eligible, token: e.token })).mcpServers.sterling;
    const client = new Client({ name: 'worker-join-test', version: '0.0.1' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: project, stderr: 'pipe' }));
    try {
      const input = { id: article, field: 'files', entries: [{ path, role: 'the joined file' }], resolves: [item] };
      const r = await client.callTool({ name: 'knowledge_append', arguments: input });
      return { input, isError: r.isError === true, text: r.content[0].text };
    } finally {
      await client.close();
    }
  };
  return { project, article, item, launch, eligible, join: join_, withStore, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('an H10 article_missing item (no feature_link, so target_id null) goes through the launcher and a real worker server: the join into an article owning the same directory is allowed and closes the item', async () => {
  const fx = articleMissingProject(['src/c/two.ts']);
  try {
    assert.equal(fx.launch().launched, true);
    const policy = fx.eligible().policy_items;
    assert.deepEqual(policy, [{ id: fx.item, lane: 'article_missing', target_id: null, file_keys: ['src/c/two.ts'] }]);
    const r = await fx.join('src/c/two.ts');
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text)[STAMP_KEY], { run_id: fx.eligible().run_id, item_id: fx.item, resolved: [fx.item] });
    fx.withStore((s) => {
      assert.deepEqual(s.get(fx.article).files.map((f) => f.path), ['src/c/one.ts', 'src/c/two.ts']);
      assert.equal(s.get(fx.item), undefined, 'the fully joined item is closed');
    });
  } finally {
    fx.cleanup();
  }
});

test('a partial article_missing join through a real worker server leaves the item open: the runner does not count it closed, and the next launch offers it again with the path still unowned', async () => {
  const fx = articleMissingProject(['src/c/two.ts', 'src/d/other.ts']);
  try {
    assert.equal(fx.launch().launched, true);
    const first = fx.eligible();
    const r = await fx.join('src/c/two.ts');
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text)[STAMP_KEY], { run_id: first.run_id, item_id: fx.item, resolved: [] }, 'the server says it closed nothing');

    // The runner reads that same receipt from the child's stream.
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'mcp__sterling__knowledge_append', input: r.input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: [{ type: 'text', text: r.text }] }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"none","reason":"partial join"}', total_cost_usd: 0.1, permission_denials: [] },
    ];
    const child = () => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      setImmediate(() => {
        c.stdout.emit('data', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        c.emit('close', 0);
      });
      return c;
    };
    const code = await runWorker({ root: fx.project, pluginRoot: REPO, spawn: child, token: first.token, budgetUsd: 2, now: () => NOW, log: () => {}, relaunch: () => ({ launched: false, reason: 'test' }) });
    assert.equal(code, 0);
    const last = JSON.parse(readFileSync(workerPaths(fx.project).state, 'utf8')).last_run;
    assert.deepEqual([last.ok, last.writes_ok, last.resolves_closed], [true, 1, 0], 'a requested resolves the server retained closes nothing');

    // The next external trigger, past the debounce, offers the item again with what is still unowned.
    assert.equal(fx.launch(NOW + DEBOUNCE_MS + 1).launched, true);
    assert.deepEqual(fx.eligible().policy_items, [{ id: fx.item, lane: 'article_missing', target_id: null, file_keys: ['src/d/other.ts'] }]);
  } finally {
    fx.cleanup();
  }
});
