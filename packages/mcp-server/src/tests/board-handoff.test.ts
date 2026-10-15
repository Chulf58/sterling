// ------------------- board_add target_project: cross-project handoff -------------------
// GitHub issue #105 (user-ruled 2026-10-15). board_add with target_project
// writes a user item into a registered sibling project's store and keeps a
// tracker here. Write order: tracker (to_item_id null), then the target's item
// through the target's own board_add path, then the target id onto the
// tracker. Completion is pulled: the target's board_remove writes a closure
// file before deleting, and the sender resolves the tracker's status at read
// time. Every refusal writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry, SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-15T12:00:00.000Z';
type Loose = Record<string, unknown>;

function projectDir(base: string, name: string, opts: { store?: boolean; config?: Loose } = {}): string {
  const root = join(base, name);
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(opts.config ?? {}));
  if (opts.store !== false) new SterlingStore(join(root, '.sterling', 'sterling.db')).close();
  return root;
}

function harness() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-handoff-'));
  const alpha = projectDir(base, 'alpha');
  const beta = projectDir(base, 'beta');
  const reg = join(base, 'registry.db');
  const registry = new ProjectRegistry(reg);
  const register = (name: string, repo_path: string) => registry.register({ repo_path, name, stack_tags: [], toolchains: [], sterling_version: null, at: NOW });
  register('alpha', alpha);
  register('beta', beta);
  const store = new SterlingStore(join(alpha, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, repoRoot: alpha, registryPath: reg, now: () => NOW });
  /** a tools instance on beta, as beta's own server would be */
  const betaTools = () => {
    const s = new SterlingStore(join(beta, '.sterling', 'sterling.db'));
    return { tools: new SterlingTools({ store: s, repoRoot: beta, now: () => NOW }), close: () => s.close() };
  };
  return {
    base, alpha, beta, reg, register, store, tools, betaTools,
    cleanup: () => {
      store.close();
      registry.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const userCount = (tools: SterlingTools) => tools.boardQuery({ source: 'user' }).length;
const statusOf = (tools: SterlingTools, id: string) => (tools.boardGet(id) as unknown as Loose).handoff_status as { state: string; text: string } | undefined;

test('board_add target_project: refused with nothing written — unknown, ambiguous, self, no store, not SQLite, wrong fields', () => {
  const h = harness();
  try {
    const add = (target_project: string, extra: Loose = {}) => h.tools.boardAdd({ text: 'Do the thing\nsee src/a.ts:1', source: 'user', target_project, ...extra });
    assert.throws(() => add('nobody'), /target_project 'nobody' is refused: no registered project has that name; registered: alpha, beta\. Nothing was written\./);
    h.register('beta', projectDir(h.base, 'beta-clone'));
    assert.throws(() => add('beta'), /the name is ambiguous, 2 registered roots carry it/);
    assert.throws(() => add('alpha'), /it is this session's own project/);
    const bare = projectDir(h.base, 'bare', { store: false });
    h.register('bare', bare);
    assert.throws(() => add('bare'), /it has no store at .*sterling\.db, and a handoff never creates one/);
    assert.equal(existsSync(join(bare, '.sterling', 'sterling.db')), false, 'the refusal created no store');
    h.register('pg', projectDir(h.base, 'pg', { store: false, config: { storage: 'postgres' } }));
    assert.throws(() => add('pg'), /target_project 'pg' is refused: (its storage is postgres|its store settings could not be read)/);
    h.register('gamma', projectDir(h.base, 'gamma'));
    assert.throws(() => add('gamma', { file_keys: ['src/a.ts'] }), /'file_keys' cannot go with target_project/);
    assert.throws(() => h.tools.boardAdd({ text: 'x', source: 'system', system_reason: 'reconcile_needed', target_project: 'gamma' }), /source:'user' board tasks only/);
    assert.equal(userCount(h.tools), 0);
    const g = new SterlingStore(join(h.base, 'gamma', '.sterling', 'sterling.db'));
    assert.equal(g.count({ types: ['todo'] }), 0);
    g.close();
  } finally {
    h.cleanup();
  }
});

test('board_add target_project: tracker here, item on the target board, both ids returned; the tracker is delegated and reads open', () => {
  const h = harness();
  try {
    const res = h.tools.boardAdd({ text: 'Wire the feedback client\nsee src/client.ts:12', source: 'user', target_project: 'beta', objective: 'feedback', priority: 'high', needs: 'investigation' }) as unknown as Loose;
    const d = res.handoff_delivery as { transfer_id: string; tracker: { id: string; slug?: string }; delivered: { project: string; root: string; id: string; slug?: string } };
    assert.equal(d.delivered.project, 'beta');
    assert.equal(d.delivered.root, h.beta);
    assert.ok(d.tracker.slug && d.delivered.slug, 'both items have a slug');

    const tracker = h.tools.boardGet(d.tracker.id) as unknown as Loose;
    assert.deepEqual(tracker.handoff, { role: 'sent', transfer_id: d.transfer_id, to_root: h.beta, to_name: 'beta', to_item_id: d.delivered.id });
    assert.equal(tracker.objective, 'feedback');
    assert.equal(tracker.priority, 'high');
    assert.equal('needs' in tracker, false, 'needs goes to the target item, never the tracker');
    assert.match(String(tracker.text), /^Handed to project 'beta': Wire the feedback client/);
    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'open', text: 'open in beta' });
    const row = h.tools.boardQueryResult({ source: 'user' }).records.find((r) => (r as Loose).id === d.tracker.id) as Loose;
    assert.equal(row.readiness, 'delegated');
    assert.equal((row.handoff_status as Loose).state, 'open');
    assert.equal(h.store.boardReadiness().find((r) => r.id === d.tracker.id)?.state, 'delegated');

    const b = h.betaTools();
    try {
      const rows = b.tools.boardQueryResult({ source: 'user' }).records as Loose[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, d.delivered.id);
      const item = b.tools.boardGet(d.delivered.id) as unknown as Loose;
      assert.deepEqual(item.handoff, { role: 'received', transfer_id: d.transfer_id, from_root: h.alpha, from_name: 'alpha', from_item_id: d.tracker.id });
      assert.equal(item.needs, 'investigation');
      assert.equal(item.priority, 'high');
      assert.equal('objective' in item, false);
      assert.match(String(item.text), /^Wire the feedback client\nsee src\/client\.ts:12\n\nHanded over from project 'alpha' \(.*alpha\); its tracker there is /);
    } finally {
      b.close();
    }
  } finally {
    h.cleanup();
  }
});

test('board_add target_project: a failed step 2 is named, and the tracker it leaves reads delivery unconfirmed', () => {
  const h = harness();
  const db = join(h.beta, '.sterling', 'sterling.db');
  try {
    chmodSync(db, 0o444);
    assert.throws(
      () => h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }),
      /step 2 of 3 \(writing the item into project 'beta' at .*\) failed: .* The tracker [0-9a-f-]{36} is on this board and reads 'delivery unconfirmed'/
    );
    const [tracker] = h.tools.boardQuery({ source: 'user' }) as unknown as Loose[];
    assert.equal((tracker.handoff as Loose).to_item_id, null);
    assert.deepEqual(statusOf(h.tools, tracker.id as string), { state: 'unconfirmed', text: 'delivery unconfirmed' });
  } finally {
    chmodSync(db, 0o644);
    h.cleanup();
  }
});

test('board_update keeps handoff intact on both sides and refuses to set it', () => {
  const h = harness();
  try {
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { tracker: { id: string }; delivered: { id: string } };
    const before = (h.tools.boardGet(d.tracker.id) as unknown as Loose).handoff;
    h.tools.boardUpdate(d.tracker.id, { text: 'Edited tracker\nsee src/a.ts:2', priority: 'low', needs: 'user' });
    h.tools.boardEdit(d.tracker.id, 'Edited', 'Re-edited');
    assert.deepEqual((h.tools.boardGet(d.tracker.id) as unknown as Loose).handoff, before);
    assert.throws(() => h.tools.boardUpdate(d.tracker.id, { handoff: { ...(before as Loose), to_item_id: null } }), /'handoff' is not editable through board_update/);
    assert.equal(statusOf(h.tools, d.tracker.id)?.state, 'open');
    const b = h.betaTools();
    try {
      const received = (b.tools.boardGet(d.delivered.id) as unknown as Loose).handoff;
      b.tools.boardUpdate(d.delivered.id, { text: 'Edited there\nsee src/b.ts:1' });
      assert.deepEqual((b.tools.boardGet(d.delivered.id) as unknown as Loose).handoff, received);
    } finally {
      b.close();
    }
  } finally {
    h.cleanup();
  }
});

test('board_remove of a received item writes the closure file first; the sender reads DONE with the note', () => {
  const h = harness();
  try {
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { transfer_id: string; tracker: { id: string }; delivered: { id: string } };
    const b = h.betaTools();
    try {
      const res = b.tools.boardRemove(d.delivered.id, 'shipped in 1a2b3c');
      const file = join(h.beta, '.sterling', 'handoffs', `${d.transfer_id}.json`);
      assert.equal(res.handoff_closure, file);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { transfer_id: d.transfer_id, item_id: d.delivered.id, closed_at: NOW, note: 'shipped in 1a2b3c' });
    } finally {
      b.close();
    }
    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'done', text: `DONE in beta ${NOW}: shipped in 1a2b3c`, closed_at: NOW, note: 'shipped in 1a2b3c' });
  } finally {
    h.cleanup();
  }
});

test('board_remove of a received item is refused when the closure file cannot be written, and the item stays', () => {
  const h = harness();
  try {
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { tracker: { id: string }; delivered: { id: string } };
    // A file where the handoffs directory belongs makes the write fail.
    writeFileSync(join(h.beta, '.sterling', 'handoffs'), 'not a directory');
    const b = h.betaTools();
    try {
      assert.throws(() => b.tools.boardRemove(d.delivered.id), /was handed over from another project, .* that file could not be written \(.*\)\. Nothing was removed\./);
      assert.ok(b.tools.boardGet(d.delivered.id), 'the item is still on the board');
    } finally {
      b.close();
    }
    assert.equal(statusOf(h.tools, d.tracker.id)?.state, 'open');
  } finally {
    h.cleanup();
  }
});

test('board_remove: a note on an item that was not handed over is refused; a received item removed by an old server reads gone', () => {
  const h = harness();
  try {
    const plain = h.tools.boardAdd({ text: 'Plain\nsee src/a.ts:1', source: 'user', objective: 'standalone' }).record.id;
    assert.throws(() => h.tools.boardRemove(plain, 'done'), /'note' is sent back to the project a task came from/);
    assert.ok(h.tools.boardGet(plain));
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { tracker: { id: string }; delivered: { id: string } };
    // An older Sterling removes the row without a closure file.
    const s = new SterlingStore(join(h.beta, '.sterling', 'sterling.db'));
    s.remove(d.delivered.id, NOW);
    s.close();
    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'gone', text: "gone from beta's board, completion unverified" });
  } finally {
    h.cleanup();
  }
});
