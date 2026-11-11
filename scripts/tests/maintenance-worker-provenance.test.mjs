// The maintenance worker's launcher against REAL git and a REAL store (decision
// maintenance-reconciliation-retains-checkout-evidence-and-use): a main
// checkout with a linked worktree, debt minted by settlement in either
// checkout, and maybeLaunchMaintenanceWorker deciding what the next run gets.
// Only the detached spawn is faked (it would start a real Claude run); no
// checkout-evidence stub is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../../packages/store/dist/index.js';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';
import { parseConfig } from '../../packages/schemas/dist/index.js';
import { mintSettlementReconcile } from '../hooks/lib/settlement.mjs';
import { observePaths } from '../hooks/lib/reconcile-origins.mjs';
import { EventEmitter } from 'node:events';
import { openStore } from '../hooks/lib/common.mjs';
import { judgedVerdicts, maybeLaunchMaintenanceWorker, rotateJournal, runWorker, workerPaths } from '../hooks/lib/maintenance-worker.mjs';

const NOW_ISO = '2026-11-02T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-mworker-prov-')));
  const plugin = join(base, 'plugin');
  for (const d of ['.claude-plugin', 'templates', 'bin', 'agent-templates']) mkdirSync(join(plugin, d), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"sterling"}');
  writeFileSync(join(plugin, 'agent-templates', 'librarian.md'), '---\nname: librarian\ntools: Read, Grep\n---\n\nLIBRARIAN BODY\n');
  writeFileSync(
    join(plugin, '.claude-plugin', 'sterling-mcp.json'),
    JSON.stringify({ mcpServers: { sterling: { command: '/usr/bin/node', args: ['/clone/main.js', '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'] } } })
  );
  writeFileSync(join(plugin, 'templates', 'maintenance-worker-prompt.md'), 'PROMPT BODY');
  writeFileSync(join(plugin, 'bin', 'maintenance-worker-run.mjs'), '// replaced by the real bundle where a test runs the runner\n');
  const main = join(base, 'main');
  mkdirSync(join(main, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(main, '.sterling', 'config.json'), '{}');
  writeFileSync(join(main, '.gitignore'), '.sterling/\n');
  writeFileSync(join(main, 'f.txt'), 'A\n');
  writeFileSync(join(main, 'g.txt'), 'G\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'A');
  // A second repository mapped as working_tree 'side' (decision a0fc8743).
  const side = join(base, 'side');
  mkdirSync(side, { recursive: true });
  writeFileSync(join(side, 's.txt'), 'A\n');
  writeFileSync(join(side, 't.txt'), 'T\n');
  git(side, 'init', '-q', '-b', 'main');
  git(side, 'config', 'user.email', 't@t.t');
  git(side, 'config', 'user.name', 't');
  git(side, 'add', '-A');
  git(side, 'commit', '-q', '-m', 'A');
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW_ISO, repoRoot: main, config: parseConfig({ working_trees: { side, later: side } }) });
  const mk = (slug, path, extra = {}) =>
    tools.knowledgeCreate('feature_article', {
      ...extra,
      slug, title: slug, what_it_does: 'x', intended_behavior: 'x', files: [{ path, role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] },
      state: 'active', version: 1, history: [{ date: NOW_ISO, event: 'seed' }], live_test_refs: [],
    }).record;
  const f = mk('feat-f', 'f.txt');
  const g = mk('feat-g', 'g.txt');
  const wt = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  git(wt, 'config', 'user.email', 't@t.t');
  git(wt, 'config', 'user.name', 't');
  const spawned = [];
  const spawn = (cmd, args, o) => {
    spawned.push({ cmd, args, cwd: o?.cwd });
    return { pid: 4242, unref() {}, on() {}, once() {} };
  };
  const launch = (root, over = {}) =>
    maybeLaunchMaintenanceWorker({ root, config: { working_trees: { side } }, store, trigger: 'chain', now: NOW, pluginRoot: plugin, env: {}, isAlive: () => true, spawn, ...over });
  const paths = workerPaths(main);
  const eligibleIds = () => JSON.parse(readFileSync(paths.eligible, 'utf8')).items.map((i) => i.id);
  const runEnded = () => rmSync(paths.lock, { force: true });
  const itemFor = (articleId) => store.query({ types: ['todo'], cap: 1000 }).find((t) => t.system_reason === 'reconcile_needed' && t.feature_link === articleId);
  const verdicts = (id) =>
    existsSync(paths.journal)
      ? readFileSync(paths.journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((v) => v.kind === 'verdict' && v.item_id === id)
      : [];
  return { base, main, wt, side, mk, store, tools, f, g, launch, spawned, paths, eligibleIds, runEnded, itemFor, verdicts, cleanup: () => (store.close(), rmSync(base, { recursive: true, force: true })) };
}

test('two checkouts trigger ONE worker: the lock, policy and journal live at the store root, never the worktree', () => {
  const x = fixture();
  try {
    writeFileSync(join(x.main, 'g.txt'), 'G2\n');
    git(x.main, 'commit', '-qam', 'G2');
    mintSettlementReconcile(x.store, x.main, ['g.txt'], NOW_ISO);
    const fromWorktree = x.launch(x.wt);
    assert.equal(fromWorktree.launched, true, JSON.stringify(fromWorktree));
    assert.equal(x.spawned[0].cwd, x.main, 'the runner starts at the store root');
    assert.ok(existsSync(x.paths.lock));
    assert.equal(existsSync(workerPaths(x.wt).lock), false, 'no second lock in the worktree');
    assert.deepEqual(x.launch(x.main), { launched: false, reason: 'already_running' });
  } finally {
    x.cleanup();
  }
});

test('unmerged worktree debt waits while an unrelated item drains; after a real merge it is offered', () => {
  const x = fixture();
  try {
    writeFileSync(join(x.wt, 'f.txt'), 'B\n');
    git(x.wt, 'commit', '-qam', 'B');
    mintSettlementReconcile(x.store, x.wt, ['f.txt'], NOW_ISO);
    writeFileSync(join(x.main, 'g.txt'), 'G2\n');
    git(x.main, 'commit', '-qam', 'G2');
    mintSettlementReconcile(x.store, x.main, ['g.txt'], NOW_ISO);
    const itemF = x.itemFor(x.f.id);
    const itemG = x.itemFor(x.g.id);
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds(), [itemG.id], 'only the integrated debt is offered');
    assert.equal(x.verdicts(itemF.id).length, 0, 'waiting for integration is not a hand-off');
    x.runEnded();
    git(x.main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds().sort(), [itemF.id, itemG.id].sort(), 'merged debt is offered');
  } finally {
    x.cleanup();
  }
});

test('unknown evidence is handed to the conductor once, and re-arms when the item\'s evidence or its target changes', () => {
  const x = fixture();
  try {
    x.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-f' — legacy", file_keys: ['f.txt'], feature_link: x.f.id });
    const legacy = x.itemFor(x.f.id);
    assert.deepEqual(x.launch(x.main), { launched: false, reason: 'none_eligible' });
    assert.equal(x.verdicts(legacy.id).length, 1, 'one standing needs_conductor verdict');
    assert.equal(x.verdicts(legacy.id)[0].verdict, 'needs_conductor');
    x.launch(x.main);
    x.launch(x.wt);
    assert.equal(x.verdicts(legacy.id).length, 1, 'no duplicate from later launches, whichever checkout triggers');
    writeFileSync(join(x.main, 'f.txt'), 'M\n');
    git(x.main, 'commit', '-qam', 'M');
    mintSettlementReconcile(x.store, x.main, ['f.txt'], NOW_ISO);
    x.launch(x.main);
    const after = x.verdicts(legacy.id).filter((v) => v.verdict === 'needs_conductor');
    assert.equal(after.length, 2, 'new evidence re-arms the item; the legacy unknown still needs the conductor');
    assert.ok(after[1].item_version > after[0].item_version);
    x.tools.knowledgeUpdate(x.f.id, { what_it_does: 'conductor prose' });
    x.launch(x.main);
    const third = x.verdicts(legacy.id).filter((v) => v.verdict === 'needs_conductor');
    assert.equal(third.length, 3, 'a target change re-arms it');
    assert.ok(third[2].target_version > third[1].target_version);
  } finally {
    x.cleanup();
  }
});

const handoffs = (x, id) => x.verdicts(id).filter((v) => v.verdict === 'needs_conductor');
const standing = (x, id) => judgedVerdicts(x.main).get(id);

test('mapped tree: another checkout\'s dirty B is handed off while T=A; advancing ONLY the mapped tree to B offers it again and withdraws the hand-off', () => {
  const x = fixture();
  try {
    const s = x.mk('feat-s', 's.txt', { working_tree: 'side' });
    writeFileSync(join(x.side, 's.txt'), 'B\n');
    const seen = observePaths(x.side, ['s.txt'], x.main);
    x.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-s' — s.txt", file_keys: ['s.txt'], feature_link: s.id }, seen.observations);
    const item = x.itemFor(s.id);
    const mainHead = git(x.main, 'rev-parse', 'HEAD');
    assert.deepEqual(x.launch(x.main), { launched: false, reason: 'none_eligible' });
    assert.equal(handoffs(x, item.id).length, 1, 'handed to the conductor');
    x.launch(x.main);
    assert.equal(handoffs(x, item.id).length, 1, 'not repeated while nothing changed');
    git(x.side, 'commit', '-qam', 'B');
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds(), [item.id], 'offered again: the mapped T now holds B');
    assert.equal(standing(x, item.id), undefined, 'the hand-off is withdrawn, so H1 no longer shows it');
    assert.equal(git(x.main, 'rev-parse', 'HEAD'), mainHead, 'main HEAD unchanged');
    assert.equal(x.itemFor(s.id).version, item.version, 'debt unchanged');
    assert.equal(x.store.get(s.id).version, s.version, 'article unchanged');
  } finally {
    x.cleanup();
  }
});

test('mapping-only repair: an unmapped working_tree is the conductor\'s; mapping it offers the item with no other change', () => {
  const x = fixture();
  try {
    const u = x.mk('feat-u', 't.txt', { working_tree: 'later' });
    const seen = observePaths(x.side, ['t.txt'], x.main);
    x.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-u' — t.txt", file_keys: ['t.txt'], feature_link: u.id }, seen.observations);
    const item = x.itemFor(u.id);
    assert.deepEqual(x.launch(x.main), { launched: false, reason: 'none_eligible' });
    assert.match(handoffs(x, item.id)[0].reason, /not mapped/);
    assert.equal(x.launch(x.main, { config: { working_trees: { side: x.side, later: x.side } } }).launched, true);
    assert.deepEqual(x.eligibleIds(), [item.id]);
    assert.equal(standing(x, item.id), undefined);
  } finally {
    x.cleanup();
  }
});

test('blocking linked debt: an item waits while a sibling on the same owner is unprovable, and is offered when the sibling is removed', () => {
  const x = fixture();
  try {
    writeFileSync(join(x.main, 'g.txt'), 'G2\n');
    git(x.main, 'commit', '-qam', 'G2');
    mintSettlementReconcile(x.store, x.main, ['g.txt'], NOW_ISO);
    const good = x.itemFor(x.g.id);
    // A second open item on the same owner (only legacy data has one; the fold
    // keeps one per owner today), carrying no evidence.
    x.store.create(
      { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', type: 'todo', created_at: NOW_ISO, updated_at: NOW_ISO, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: "reconcile article 'feat-g' — legacy", source: 'system', system_reason: 'reconcile_needed', file_keys: ['g.txt'], feature_link: x.g.id },
      { operation_id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' }
    );
    assert.deepEqual(x.launch(x.main), { launched: false, reason: 'none_eligible', detail: `1 reconcile item(s) wait for another checkout's change to reach ${git(x.main, 'rev-parse', 'HEAD').slice(0, 8)}: ${good.id}` });
    assert.equal(handoffs(x, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d').length, 1, 'the unprovable sibling is the conductor\'s');
    x.store.remove('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', NOW_ISO);
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds(), [good.id]);
  } finally {
    x.cleanup();
  }
});

test('journal rotation keeps the hand-off\'s identity, and a chained launch from the queue snapshot proves evidence again', () => {
  const x = fixture();
  try {
    x.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-f' — legacy", file_keys: ['f.txt'], feature_link: x.f.id });
    const legacy = x.itemFor(x.f.id);
    x.launch(x.main);
    rotateJournal(x.main, 1);
    const carried = x.verdicts(legacy.id);
    assert.equal(carried.length, 1);
    assert.equal(carried[0].carried, true);
    assert.equal(carried[0].source, 'launcher');
    assert.equal(carried[0].item_version, legacy.version);
    x.launch(x.main);
    assert.equal(handoffs(x, legacy.id).length, 1, 'no repeat after rotation');
    writeFileSync(join(x.wt, 'g.txt'), 'GB\n');
    git(x.wt, 'commit', '-qam', 'GB');
    mintSettlementReconcile(x.store, x.wt, ['g.txt'], NOW_ISO);
    writeFileSync(join(x.main, 'f.txt'), 'M\n');
    git(x.main, 'commit', '-qam', 'M');
    mintSettlementReconcile(x.store, x.main, ['f.txt'], NOW_ISO);
    git(x.main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    const gItem = x.itemFor(x.g.id);
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds(), [gItem.id], 'merged g debt offered; legacy f debt still the conductor\'s');
    const snapshot = JSON.parse(readFileSync(x.paths.eligible, 'utf8')).queue_snapshot;
    assert.equal(snapshot[0].version, gItem.version);
    assert.ok(Array.isArray(snapshot[0].observations) && snapshot[0].observations.length);
    assert.equal(snapshot[0].target_snapshot.id, x.g.id);
    x.runEnded();
    const chained = maybeLaunchMaintenanceWorker({ root: x.main, config: null, items: snapshot, trigger: 'chain', now: NOW, pluginRoot: join(x.base, 'plugin'), env: {}, isAlive: () => true, spawn: () => ({ pid: 4243, unref() {}, on() {}, once() {} }) });
    assert.equal(chained.launched, true, 'a chained launch (no store) proves the snapshot evidence again');
    assert.deepEqual(x.eligibleIds(), [gItem.id]);
  } finally {
    x.cleanup();
  }
});

// ---- the REAL runner: runWorker with a fake process spawn only ----
function fakeClaude(events) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end() {} });
    child.kill = () => setImmediate(() => child.emit('close', null));
    setImmediate(() => {
      child.stdout.emit('data', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}
const removeCall = (toolId, itemId) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'mcp__sterling__maintenance_remove', input: { id: itemId } }] } });
const removeResult = (toolId, item, runId) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: JSON.stringify({ removed: item, worker_stamp: { run_id: runId, item_id: item, resolved: [item] } }) }] } });
const resultEvent = { type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.25, permission_denials: [] };

async function chainAfterRun(x, openStoreFn, acted) {
  const first = JSON.parse(readFileSync(x.paths.eligible, 'utf8'));
  const token = JSON.parse(readFileSync(x.paths.lock, 'utf8')).token;
  // The fake child's close is a REAL removal in the temporary store plus the
  // server's stamp, exactly what a stamped maintenance_remove leaves behind.
  x.store.remove(acted, NOW_ISO);
  const relaunches = [];
  const spawn = (cmd, args, o) => {
    if (cmd === process.execPath) {
      relaunches.push(args);
      return { pid: 5151, unref() {}, on() {}, once() {} };
    }
    return fakeClaude([removeCall('c1', acted), removeResult('c1', acted, first.run_id), resultEvent])(cmd, args, o);
  };
  const prev = { flag: process.env.STERLING_MAINTENANCE_WORKER, off: process.env.STERLING_MAINTENANCE_WORKER_DISABLE };
  process.env.STERLING_MAINTENANCE_WORKER = '1';
  delete process.env.STERLING_MAINTENANCE_WORKER_DISABLE;
  try {
    await runWorker({ root: x.main, pluginRoot: join(x.base, 'plugin'), spawn, token, budgetUsd: 2, now: () => NOW, ...(openStoreFn ? { openStore: openStoreFn } : {}), log: () => {} });
  } finally {
    if (prev.flag === undefined) delete process.env.STERLING_MAINTENANCE_WORKER;
    else process.env.STERLING_MAINTENANCE_WORKER = prev.flag;
    if (prev.off !== undefined) process.env.STERLING_MAINTENANCE_WORKER_DISABLE = prev.off;
  }
  const chain = readFileSync(x.paths.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'chain');
  return { acted, chain, relaunches };
}

function twoPayableItems(x) {
  // h.txt is committed BEFORE its article exists, so the article baselines it.
  writeFileSync(join(x.main, 'h.txt'), 'H0\n');
  git(x.main, 'add', '-A');
  git(x.main, 'commit', '-qm', 'H0');
  const h = x.mk('feat-h', 'h.txt');
  writeFileSync(join(x.main, 'g.txt'), 'G2\n');
  writeFileSync(join(x.main, 'h.txt'), 'H\n');
  git(x.main, 'add', '-A');
  git(x.main, 'commit', '-qm', 'G2 H');
  mintSettlementReconcile(x.store, x.main, ['g.txt'], NOW_ISO);
  mintSettlementReconcile(x.store, x.main, ['h.txt'], NOW_ISO);
  const g = x.itemFor(x.g.id);
  const hItem = x.itemFor(h.id);
  assert.ok(g && hItem, 'fixture: both items minted');
  return { h, g, hItem };
}

test('runner: evidence that changed AFTER the launch snapshot is re-proven from the live store before the chain, so a stale snapshot never admits it', async () => {
  const x = fixture();
  try {
    const { h, g, hItem } = twoPayableItems(x);
    assert.equal(x.launch(x.main).launched, true);
    assert.deepEqual(x.eligibleIds().sort(), [g.id, hItem.id].sort(), 'both offered at launch');
    // After the snapshot, another checkout's uncommitted change folds into h's debt.
    writeFileSync(join(x.wt, 'h.txt'), 'HB\n');
    mintSettlementReconcile(x.store, x.wt, ['h.txt'], NOW_ISO);
    const r = await chainAfterRun(x, openStore, g.id);
    assert.deepEqual(r.chain.map((l) => [l.launched, l.reason]), [[false, 'none_eligible']], 'the live evidence keeps h out of the chain');
    assert.equal(r.relaunches.length, 0, 'no runner started on the stale snapshot');
    assert.equal(handoffs(x, hItem.id).length, 1, 'h is handed to the conductor from its live evidence');
    assert.ok(x.store.get(h.id));
  } finally {
    x.cleanup();
  }
});

test('runner: a blocking sibling removed after the snapshot lets the chain offer the item', async () => {
  const x = fixture();
  try {
    const { g, hItem } = twoPayableItems(x);
    const sib = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e';
    assert.equal(x.launch(x.main).launched, true);
    // Snapshot taken with g and h offered; now an unprovable sibling appears
    // on h's owner, then is removed again before the chain.
    x.store.create(
      { id: sib, type: 'todo', created_at: NOW_ISO, updated_at: NOW_ISO, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: "reconcile article 'feat-h' — legacy", source: 'system', system_reason: 'reconcile_needed', file_keys: ['h.txt'], feature_link: hItem.feature_link },
      { operation_id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f' }
    );
    const blocked = await chainAfterRun(x, openStore, g.id);
    assert.deepEqual(blocked.chain.map((l) => [l.launched, l.reason]), [[false, 'none_eligible']], 'the live sibling blocks the chain');
    x.store.remove(sib, NOW_ISO);
    rmSync(x.paths.lock, { force: true });
    assert.equal(x.launch(x.main).launched, true);
    assert.ok(x.eligibleIds().includes(hItem.id), 'with the sibling gone the item is offered again');
  } finally {
    x.cleanup();
  }
});

test('runner: a store that cannot be opened refuses the chain loudly instead of trusting the snapshot', async () => {
  const x = fixture();
  try {
    const { g } = twoPayableItems(x);
    assert.equal(x.launch(x.main).launched, true);
    const r = await chainAfterRun(
      x,
      () => {
        throw new Error('route unavailable');
      },
      g.id
    );
    assert.equal(r.chain.length, 1);
    assert.equal(r.chain[0].launched, false);
    assert.equal(r.chain[0].reason, 'store_unavailable');
    assert.match(r.chain[0].detail, /route unavailable/);
    assert.equal(r.relaunches.length, 0);
  } finally {
    x.cleanup();
  }
});

// ---- the SHIPPED runner: bin/maintenance-worker-run.mjs as its own process ----
// Copied alone into a plugin directory under the OS temp dir, so no ancestor
// node_modules, workspace package or packages/*/dist can resolve anything for
// it (STERLING_TEST_PACKED_PLUGIN points at an extracted `npm pack` instead).
// The one faked process is `claude`, a script on PATH replaying a stamped
// maintenance_remove; git and the store are real.
const REPO = new URL('../..', import.meta.url).pathname;
function shippedRunner(x, runnerRel) {
  const packed = process.env.STERLING_TEST_PACKED_PLUGIN;
  const plugin = packed ?? join(x.base, 'plugin');
  if (!packed) {
    writeFileSync(join(plugin, 'bin', 'maintenance-worker-run.mjs'), readFileSync(join(REPO, 'bin', 'maintenance-worker-run.mjs')));
    cpSync(join(REPO, 'scripts'), join(plugin, 'scripts'), { recursive: true, filter: (src) => !src.includes('/scripts/tests') });
  }
  return join(plugin, runnerRel);
}
function runShipped(x, runner, acted) {
  const first = JSON.parse(readFileSync(x.paths.eligible, 'utf8'));
  const token = JSON.parse(readFileSync(x.paths.lock, 'utf8')).token;
  x.store.remove(acted, NOW_ISO);
  const fakeBin = join(x.base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__sterling__maintenance_remove', input: { id: acted } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: JSON.stringify({ removed: acted, worker_stamp: { run_id: first.run_id, item_id: acted, resolved: [acted] } }) }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.25, permission_denials: [] },
  ];
  writeFileSync(join(fakeBin, 'claude'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join('\n') + '\n')});\n`, { mode: 0o755 });
  const env = { PATH: `${fakeBin}:${process.env.PATH}`, HOME: x.base };
  const r = spawnSync(process.execPath, [runner, '--project', x.main, '--trigger', 'chain', '--token', token, '--budget-usd', '2'], { cwd: x.base, env, encoding: 'utf8', timeout: 60_000 });
  const chain = existsSync(x.paths.journal) ? readFileSync(x.paths.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'chain') : [];
  return { r, chain };
}

test('shipped runner: the bundled bin opens the live store with no workspace packages and re-proves the chain (stale snapshot refused, h handed off)', () => {
  const x = fixture();
  try {
    const { g, hItem } = twoPayableItems(x);
    const runner = shippedRunner(x, 'bin/maintenance-worker-run.mjs');
    assert.equal(x.launch(x.main).launched, true);
    writeFileSync(join(x.wt, 'h.txt'), 'HB\n');
    mintSettlementReconcile(x.store, x.wt, ['h.txt'], NOW_ISO);
    const { r, chain } = runShipped(x, runner, g.id);
    assert.equal(r.status, 0, `runner exit ${r.status}: ${r.stderr}`);
    assert.deepEqual(chain.map((l) => [l.launched, l.reason]), [[false, 'none_eligible']], `the chain re-proved from the live store: ${JSON.stringify(chain)}`);
    assert.equal(handoffs(x, hItem.id).length, 1, 'h, changed after the snapshot, is the conductor\'s');
  } finally {
    x.cleanup();
  }
});

test('shipped runner: the scripts/ source runner cannot load its store opener without workspace packages, which is why the launcher spawns the bundle', () => {
  const x = fixture();
  try {
    const runner = shippedRunner(x, 'scripts/maintenance-worker-run.mjs');
    const r = spawnSync(process.execPath, [runner, '--project', x.main, '--dry-run'], { cwd: x.base, env: { PATH: process.env.PATH, HOME: x.base }, encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package '@sterling\//);
  } finally {
    x.cleanup();
  }
});

test('runner: with nothing changed, the live chain offers the item the run left', async () => {
  const x = fixture();
  try {
    const { g, hItem } = twoPayableItems(x);
    assert.equal(x.launch(x.main).launched, true);
    const r = await chainAfterRun(x, openStore, g.id);
    assert.deepEqual(r.chain.map((l) => [l.launched, l.reason]), [[true, 'launched']]);
    assert.equal(r.relaunches.length, 1);
    assert.deepEqual(x.eligibleIds(), [hItem.id]);
  } finally {
    x.cleanup();
  }
});

test('[RED] launcher: debt linked to a RETIRED main article whose live successor owns the path in a mapped tree is offered against the successor, with the successor as policy target', () => {
  const x = fixture();
  try {
    const old = x.mk('feat-old-s', 's.txt');
    const live = x.mk('feat-live-s', 's.txt', { working_tree: 'side' });
    x.tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: "reconcile article 'feat-old-s' — s.txt", file_keys: ['s.txt'], feature_link: old.id }, observePaths(x.side, ['s.txt'], x.main).observations);
    x.tools.knowledgeRetire(old.id, live.id);
    const item = x.itemFor(old.id);
    assert.equal(x.launch(x.main).launched, true, 'the committed evidence is integrated in the successor\'s mapped tree');
    assert.deepEqual(x.eligibleIds(), [item.id]);
    const policy = JSON.parse(readFileSync(x.paths.eligible, 'utf8')).policy_items;
    assert.equal(policy[0].target_id, live.id, 'the worker writes the live successor, never the retired address');
    assert.equal(handoffs(x, item.id).length, 0);
  } finally {
    x.cleanup();
  }
});
