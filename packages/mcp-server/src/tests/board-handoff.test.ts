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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ProjectRegistry, SterlingStore } from '@sterling/store';
import { z } from 'zod';
import { SterlingTools } from '../tools.js';
import { createSterlingServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

test('needs_reason (#107): set with needs user, shown on the sender tracker; cleared by a needs change unless given again; refused without user or grill', () => {
  const h = harness();
  try {
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { tracker: { id: string }; delivered: { id: string } };
    const b = h.betaTools();
    try {
      const item = () => b.tools.boardGet(d.delivered.id) as unknown as Loose;
      assert.throws(() => b.tools.boardUpdate(d.delivered.id, { needs_reason: 'pick a colour' }), /needs_reason says why an item waits, .* this item's needs would be absent\. Nothing was updated\./);
      assert.throws(() => b.tools.boardUpdate(d.delivered.id, { needs: 'investigation', needs_reason: 'pick a colour' }), /this item's needs would be 'investigation'/);
      assert.equal('needs_reason' in item(), false);

      b.tools.boardUpdate(d.delivered.id, { needs: 'user', needs_reason: '  pick a colour ' });
      assert.equal(item().needs_reason, 'pick a colour');
      assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'needs_user', text: 'needs user in beta: pick a colour' });
      const row = h.tools.boardQueryResult({ source: 'user' }).records.find((r) => (r as Loose).id === d.tracker.id) as Loose;
      assert.equal(row.readiness, 'delegated', 'a needs-user hand-off stays in the delegated group');
      assert.equal(h.store.boardReadiness().find((r) => r.id === d.tracker.id)?.state, 'delegated');

      b.tools.boardUpdate(d.delivered.id, { needs: 'user' });
      assert.equal('needs_reason' in item(), false, 'user -> user with no reason clears it');
      assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'needs_user', text: 'needs user in beta' });

      b.tools.boardUpdate(d.delivered.id, { needs: 'grill', needs_reason: 'scope' });
      b.tools.boardUpdate(d.delivered.id, { needs: 'investigation' });
      assert.equal('needs_reason' in item(), false, 'user/grill -> investigation clears it');
      assert.equal(statusOf(h.tools, d.tracker.id)?.state, 'open');

      b.tools.boardUpdate(d.delivered.id, { needs: 'user', needs_reason: 'scope' });
      b.tools.boardUpdate(d.delivered.id, { text: 'Edited\nsee src/a.ts:3' });
      assert.equal(item().needs_reason, 'scope', 'an edit that does not touch needs keeps the reason');
      b.tools.boardUpdate(d.delivered.id, { needs_reason: '' });
      assert.equal('needs_reason' in item(), false, "'' clears it");
      assert.equal(item().needs, 'user');
    } finally {
      b.close();
    }
    const sys = h.tools.boardAdd({ text: 'Queue item', source: 'system', system_reason: 'reconcile_needed' }).record.id;
    assert.throws(() => h.tools.boardUpdate(sys, { needs_reason: 'x' }), /goes only with needs 'user', 'grill' or 'external' on a source:'user' board task/);
  } finally {
    h.cleanup();
  }
});

test('blocked in the receiving project (#107): a live blocker reads blocked; removing the blocker reads open', () => {
  const h = harness();
  try {
    const d = (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as { tracker: { id: string }; delivered: { id: string } };
    const b = h.betaTools();
    try {
      const blocker = b.tools.boardAdd({ text: 'First this\nsee src/b.ts:1', source: 'user', objective: 'standalone' }).record;
      b.tools.boardUpdate(d.delivered.id, { blocked_by: [blocker.id] });
      assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'blocked', text: 'blocked in beta' });
      b.tools.boardRemove(blocker.id);
      assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'open', text: 'open in beta' });
    } finally {
      b.close();
    }
  } finally {
    h.cleanup();
  }
});

// GitHub issue #108: milestone on the tracker, evidence in a sidecar file.
type Delivery = { transfer_id: string; tracker: { id: string }; delivered: { id: string } };
const handOver = (h: ReturnType<typeof harness>, extra: Loose = {}) =>
  (h.tools.boardAdd({ text: 'Do it\nsee src/a.ts:1', source: 'user', target_project: 'beta', ...extra }) as unknown as Loose).handoff_delivery as Delivery;

test('milestone (#108): kept on the tracker, written into the receiver text only, refused when blank or too long', () => {
  const h = harness();
  try {
    assert.throws(() => handOver(h, { milestone: '   ' }), /milestone must be non-blank text of at most 80 characters/);
    assert.throws(() => handOver(h, { milestone: 'x'.repeat(81) }), /at most 80 characters/);
    assert.equal(userCount(h.tools), 0, 'a refused milestone wrote nothing');
    const d = handOver(h, { milestone: '  merged to main ' });
    assert.deepEqual((h.tools.boardGet(d.tracker.id) as unknown as Loose).handoff, { role: 'sent', transfer_id: d.transfer_id, to_root: h.beta, to_name: 'beta', to_item_id: d.delivered.id, milestone: 'merged to main' });
    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'open', text: 'open in beta', milestone: 'merged to main' });
    const b = h.betaTools();
    try {
      const item = b.tools.boardGet(d.delivered.id) as unknown as Loose;
      assert.match(String(item.text), /\n\nMilestone to reach before closing: merged to main\nHanded over from project 'alpha'/);
      assert.deepEqual(item.handoff, { role: 'received', transfer_id: d.transfer_id, from_root: h.alpha, from_name: 'alpha', from_item_id: d.tracker.id }, 'the received handoff carries no milestone');
    } finally {
      b.close();
    }
  } finally {
    h.cleanup();
  }
});

test('evidence (#108): refused when empty or blank or on an item not handed over, with nothing removed', () => {
  const h = harness();
  try {
    const plain = h.tools.boardAdd({ text: 'Plain\nsee src/a.ts:1', source: 'user', objective: 'standalone' }).record.id;
    assert.throws(() => h.tools.boardRemove(plain, undefined, { commit: 'abc' }), /'evidence' is sent back to the project a task came from/);
    const d = handOver(h);
    const b = h.betaTools();
    try {
      assert.throws(() => b.tools.boardRemove(d.delivered.id, undefined, {}), /evidence is refused \(evidence needs at least one non-blank value/);
      assert.throws(() => b.tools.boardRemove(d.delivered.id, undefined, { commit: ' ' }), /evidence is refused/);
      assert.throws(() => b.tools.boardRemove(d.delivered.id, undefined, { sha: 'abc' }), /evidence is refused/);
      assert.ok(b.tools.boardGet(d.delivered.id));
      assert.equal(existsSync(join(h.beta, '.sterling', 'handoffs', `${d.transfer_id}.json`)), false);
    } finally {
      b.close();
    }
    assert.ok(h.tools.boardGet(plain));
  } finally {
    h.cleanup();
  }
});

test('evidence (#108): with a milestone the sender reads DONE with the evidence; without evidence DONE, unverified; no milestone reads as before', () => {
  const h = harness();
  try {
    const withEv = handOver(h, { milestone: 'merged' });
    const without = handOver(h, { milestone: 'deployed to prod' });
    const plain = handOver(h);
    const b = h.betaTools();
    try {
      const res = b.tools.boardRemove(withEv.delivered.id, 'all good', { commit: ' 1a2b3c ', pr: '#12', url: '' });
      const sidecar = join(h.beta, '.sterling', 'handoffs', `${withEv.transfer_id}.evidence.json`);
      assert.equal(res.handoff_evidence, sidecar);
      assert.deepEqual(JSON.parse(readFileSync(sidecar, 'utf8')), { transfer_id: withEv.transfer_id, item_id: withEv.delivered.id, evidence: { commit: '1a2b3c', pr: '#12' } });
      b.tools.boardRemove(without.delivered.id);
      b.tools.boardRemove(plain.delivered.id, undefined, { deploy: 'prod 2026-10-15' });
    } finally {
      b.close();
    }
    assert.deepEqual(statusOf(h.tools, withEv.tracker.id), {
      state: 'done',
      text: `DONE in beta ${NOW} (merged): commit 1a2b3c, PR #12; all good`,
      closed_at: NOW,
      note: 'all good',
      evidence: { commit: '1a2b3c', pr: '#12' },
      milestone: 'merged',
    });
    assert.deepEqual(statusOf(h.tools, without.tracker.id), { state: 'done', text: `DONE in beta ${NOW}, unverified (deployed to prod)`, closed_at: NOW, milestone: 'deployed to prod' });
    assert.deepEqual(statusOf(h.tools, plain.tracker.id), { state: 'done', text: `DONE in beta ${NOW}: deploy prod 2026-10-15`, closed_at: NOW, evidence: { deploy: 'prod 2026-10-15' } });
  } finally {
    h.cleanup();
  }
});

test('evidence (#108): a malformed or other hand-off sidecar is no evidence, never proof', () => {
  const h = harness();
  try {
    const a = handOver(h, { milestone: 'merged' });
    const c = handOver(h, { milestone: 'merged' });
    const b = h.betaTools();
    try {
      b.tools.boardRemove(a.delivered.id);
      b.tools.boardRemove(c.delivered.id);
    } finally {
      b.close();
    }
    const dir = join(h.beta, '.sterling', 'handoffs');
    writeFileSync(join(dir, `${a.transfer_id}.evidence.json`), '{ not json');
    writeFileSync(join(dir, `${c.transfer_id}.evidence.json`), JSON.stringify({ transfer_id: c.transfer_id, item_id: a.delivered.id, evidence: { commit: 'abc' } }));
    for (const t of [a, c]) assert.deepEqual(statusOf(h.tools, t.tracker.id), { state: 'done', text: `DONE in beta ${NOW}, unverified (merged)`, closed_at: NOW, milestone: 'merged' });
    // a valid sidecar with an unknown extra key is read
    writeFileSync(join(dir, `${c.transfer_id}.evidence.json`), JSON.stringify({ transfer_id: c.transfer_id, item_id: c.delivered.id, evidence: { commit: 'abc', future: 1 }, extra: true }));
    assert.equal(statusOf(h.tools, c.tracker.id)?.text, `DONE in beta ${NOW} (merged): commit abc`);
  } finally {
    h.cleanup();
  }
});

test('evidence (#108): a failed evidence write keeps the item and writes no closure file', () => {
  const h = harness();
  try {
    const d = handOver(h, { milestone: 'merged' });
    const dir = join(h.beta, '.sterling', 'handoffs');
    // A directory where the sidecar belongs makes its rename fail.
    mkdirSync(join(dir, `${d.transfer_id}.evidence.json`), { recursive: true });
    const b = h.betaTools();
    try {
      assert.throws(() => b.tools.boardRemove(d.delivered.id, undefined, { commit: 'abc' }), /its evidence file could not be written \(.*\)\. Nothing was removed\./);
      assert.ok(b.tools.boardGet(d.delivered.id), 'the item is still on the board');
    } finally {
      b.close();
    }
    assert.equal(existsSync(join(dir, `${d.transfer_id}.json`)), false, 'no closure file was written');
    assert.equal(statusOf(h.tools, d.tracker.id)?.state, 'open');
  } finally {
    h.cleanup();
  }
});

test('skew (#108): the closure file written alongside evidence parses with the old strict closure shape, so an older sender reads done', () => {
  const h = harness();
  try {
    const d = handOver(h, { milestone: 'merged' });
    const b = h.betaTools();
    try {
      b.tools.boardRemove(d.delivered.id, 'shipped', { commit: 'abc' });
    } finally {
      b.close();
    }
    // The pre-#108 handoffClosureSchema, copied verbatim so a later change to the shared schema cannot make this pass.
    const oldClosure = z.object({ transfer_id: z.string().uuid(), item_id: z.string().uuid(), closed_at: z.string().min(1), note: z.string().min(1).optional() }).strict();
    const file = JSON.parse(readFileSync(join(h.beta, '.sterling', 'handoffs', `${d.transfer_id}.json`), 'utf8'));
    assert.equal(oldClosure.safeParse(file).success, true);
  } finally {
    h.cleanup();
  }
});

test('evidence (#108 review): a refused close leaves no sidecar, and a retry without evidence reads DONE, unverified', () => {
  const h = harness();
  try {
    const d = handOver(h, { milestone: 'merged' });
    const sidecar = join(h.beta, '.sterling', 'handoffs', `${d.transfer_id}.evidence.json`);
    const b = h.betaTools();
    try {
      assert.throws(() => b.tools.boardRemove(d.delivered.id, ' ', { deploy: 'old' }), /the note is blank/);
      assert.equal(existsSync(sidecar), false, 'the refused close wrote no evidence file');
      // A sidecar left behind by an earlier close that failed after writing it.
      mkdirSync(join(h.beta, '.sterling', 'handoffs'), { recursive: true });
      writeFileSync(sidecar, JSON.stringify({ transfer_id: d.transfer_id, item_id: d.delivered.id, evidence: { deploy: 'old' } }));
      const res = b.tools.boardRemove(d.delivered.id);
      assert.equal(res.handoff_evidence, undefined);
      assert.equal(existsSync(sidecar), false, 'a close without evidence deletes a leftover sidecar');
    } finally {
      b.close();
    }
    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'done', text: `DONE in beta ${NOW}, unverified (merged)`, closed_at: NOW, milestone: 'merged' });
  } finally {
    h.cleanup();
  }
});

test('evidence (#108 review): a leftover sidecar that cannot be deleted refuses the close, and the item stays', () => {
  const h = harness();
  try {
    const d = handOver(h, { milestone: 'merged' });
    const dir = join(h.beta, '.sterling', 'handoffs');
    // A non-empty directory in the sidecar's place: unlink fails with EISDIR/EPERM, not ENOENT.
    mkdirSync(join(dir, `${d.transfer_id}.evidence.json`, 'x'), { recursive: true });
    const b = h.betaTools();
    try {
      assert.throws(() => b.tools.boardRemove(d.delivered.id), /the evidence file .* left by an earlier close could not be deleted \(.*\); .* Nothing was removed\./);
      assert.ok(b.tools.boardGet(d.delivered.id), 'the item is still on the board');
    } finally {
      b.close();
    }
    assert.equal(existsSync(join(dir, `${d.transfer_id}.json`)), false, 'no closure file was written');
  } finally {
    h.cleanup();
  }
});

test('evidence (#108 review): the served board_remove tool refuses evidence {} at its input schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-evidence-schema-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const served = (await client.listTools()).tools.find((t) => t.name === 'board_remove');
    const evidence = (served?.inputSchema.properties as Record<string, { properties?: Record<string, unknown>; additionalProperties?: unknown }>).evidence;
    assert.deepEqual(Object.keys(evidence.properties ?? {}).sort(), ['commit', 'deploy', 'pr', 'url']);
    assert.equal(evidence.additionalProperties, false);
    const id = '00000000-0000-4000-8000-000000000000';
    const res = (await client.callTool({ name: 'board_remove', arguments: { id, evidence: {} } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /evidence needs at least one non-blank value/);
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------- board_query / board_get target_project: read another project's board -------------------
// Decision read-another-projects-board-board-query-target-project-read-only:
// the other project's USER board, read-only, same filters/order/paging and
// projections, marked with source_project; this repo's own annotations read
// 'unavailable:other_project'; nothing is written there.

/** Add user items to beta through beta's own tools, then close beta's store. */
function seedBeta(h: ReturnType<typeof harness>, items: Loose[]): Loose[] {
  const b = h.betaTools();
  try {
    return items.map((it) => (b.tools.boardAdd({ source: 'user', ...it } as Parameters<SterlingTools['boardAdd']>[0]) as unknown as { record: Loose }).record);
  } finally {
    b.close();
  }
}

test('board_query target_project: filters and paging over the other board, every record marked; a cursor never crosses between local and foreign', () => {
  const h = harness();
  try {
    const seeded = seedBeta(h, [
      { text: 'Apple one', objective: 'x' },
      { text: 'Apple two', objective: 'x', file_keys: ['src/k.ts'] },
      { text: 'Pear', objective: 'x' },
      { text: 'Other objective', objective: 'y' },
    ]);
    for (const text of ['Local a', 'Local b', 'Local c']) h.tools.boardAdd({ text, source: 'user', objective: 'x' });

    const first = h.tools.foreignBoardQuery({ target_project: 'beta', objective: 'x', cap: 2 });
    assert.equal(first.source_project, 'beta');
    assert.equal(first.source_root, h.beta);
    assert.equal(first.matched_filter, 3);
    assert.equal(first.capped, true);
    assert.ok(first.next_cursor);
    const second = h.tools.foreignBoardQuery({ target_project: 'beta', objective: 'x', cap: 2, cursor: first.next_cursor });
    assert.equal(second.capped, false);
    const walked = [...first.records, ...second.records];
    const xIds = seeded.filter((s) => s.objective === 'x').map((s) => s.id);
    assert.deepEqual(walked.map((r) => r.id).sort(), [...xIds].sort(), 'the cursor walk visits each beta item once');
    const byOffset = h.tools.foreignBoardQuery({ target_project: 'beta', objective: 'x', cap: 2, offset: 2 });
    assert.deepEqual(byOffset.records.map((r) => r.id), second.records.map((r) => r.id));
    for (const r of walked) {
      assert.equal(r.source_project, 'beta');
      assert.equal(r.source_root, h.beta);
    }

    assert.equal(h.tools.foreignBoardQuery({ target_project: 'beta', contains: 'APPLE' }).matched_filter, 2);
    assert.deepEqual(h.tools.foreignBoardQuery({ target_project: 'beta', file_keys: ['./src/k.ts'] }).records.map((r) => r.text), ['Apple two']);
    assert.equal(h.tools.foreignBoardQuery({ target_project: 'beta', source: 'user' }).matched_filter, 4);

    assert.throws(() => h.tools.boardQueryResult({ objective: 'x', cap: 2, cursor: first.next_cursor }), /DIFFERENT query \(target_project: "beta" -> null\)/);
    const local = h.tools.boardQueryResult({ objective: 'x', cap: 2 });
    assert.ok(local.next_cursor);
    assert.throws(() => h.tools.foreignBoardQuery({ target_project: 'beta', objective: 'x', cap: 2, cursor: local.next_cursor }), /DIFFERENT query \(target_project: null -> "beta"\)/);
    assert.throws(() => h.tools.boardQueryResult({ target_project: 'beta' }), /target_project is served by foreignBoardQuery/);
  } finally {
    h.cleanup();
  }
});

test('board_query target_project: source:system refused; this repo\'s annotations read unavailable:other_project in every projection', () => {
  const h = harness();
  try {
    seedBeta(h, [{ text: 'Shared path one', objective: 'x', file_keys: ['src/a.ts'] }, { text: 'Shared path two', objective: 'x', file_keys: ['src/a.ts'] }]);
    assert.throws(() => h.tools.foreignBoardQuery({ target_project: 'beta', source: 'system' }), /board_query: source:'system' cannot go with target_project.*Nothing was read\./);
    for (const projection of ['text', 'full', 'digest', 'headline'] as const) {
      const res = h.tools.foreignBoardQuery({ target_project: 'beta', projection });
      assert.equal(res.provenance, 'unavailable:other_project');
      assert.equal(res.reconcile_provenance, 'unavailable:other_project');
      assert.equal(res.artifact_evidence_provenance, 'unavailable:other_project');
      assert.equal(res.lane_advisory, 'unavailable:other_project', 'the two items share a path, yet no advisory is computed');
      assert.equal(res.returned, 2, projection);
      for (const r of res.records) {
        assert.equal(r.source_project, 'beta', projection);
        assert.equal('artifact_evidence' in r || 'artifact_evidence_count' in r, false, projection);
      }
      assert.equal('target_schema_version' in res, false, 'the same schema version is not disclosed');
    }
  } finally {
    h.cleanup();
  }
});

test('board_get target_project: by full uuid, exact slug and 8-char prefix; unknown refused; the alias archive is said to be skipped', () => {
  const h = harness();
  try {
    const [item] = seedBeta(h, [{ text: 'Fetch me whole\nwith a second line', objective: 'x' }]);
    for (const ref of [String(item.id), String(item.slug), String(item.id).slice(0, 8)]) {
      const got = h.tools.foreignBoardGet(ref, 'beta');
      assert.equal(got.id, item.id, ref);
      assert.equal(got.text, 'Fetch me whole\nwith a second line');
      assert.equal(got.source_project, 'beta');
      assert.equal(got.source_root, h.beta);
      assert.match(String(got.historical_ids), /not searched/);
      assert.ok(got.label);
    }
    assert.throws(() => h.tools.foreignBoardGet('no-such-slug', 'beta'), /board_get: 'no-such-slug' names no user board item in project 'beta'.*historical-id archive is not searched/);
  } finally {
    h.cleanup();
  }
});

test('board_query/board_get target_project: unknown and self refused with read wording; board_add keeps its write wording', () => {
  const h = harness();
  try {
    assert.throws(() => h.tools.foreignBoardQuery({ target_project: 'nobody' }), /^Error: board_query: target_project 'nobody' is refused: no registered project has that name; registered: alpha, beta\. Nothing was read\.$/);
    assert.throws(() => h.tools.foreignBoardQuery({ target_project: 'alpha' }), /board_query: target_project 'alpha' is refused: it is this session's own project; read it without target_project\. Nothing was read\./);
    assert.throws(() => h.tools.foreignBoardGet('x', 'alpha'), /board_get: target_project 'alpha' is refused: it is this session's own project; read it without target_project\. Nothing was read\./);
    assert.throws(() => h.tools.foreignBoardGet('x', 'nobody'), /board_get: target_project 'nobody' is refused: no registered project has that name/);
    const bare = projectDir(h.base, 'bare', { store: false });
    h.register('bare', bare);
    assert.throws(() => h.tools.foreignBoardQuery({ target_project: 'bare' }), /it has no store at .*sterling\.db, and a read never creates one\. Nothing was read\./);
    assert.equal(existsSync(join(bare, '.sterling', 'sterling.db')), false, 'the read created no store');
    assert.throws(() => h.tools.boardAdd({ text: 'x', source: 'user', target_project: 'alpha' }), /board_add: target_project 'alpha' is refused: it is this session's own project; add the item without target_project\. Nothing was written\./);
    assert.throws(() => h.tools.boardAdd({ text: 'x', source: 'user', target_project: 'bare' }), /and a handoff never creates one\. Nothing was written\./);
  } finally {
    h.cleanup();
  }
});

test('a receiver renamed in the registry stays followable: the tracker resolves through to_root, and the old name still reads its board (GitHub issue #117)', () => {
  const h = harness();
  const registry = new ProjectRegistry(h.reg);
  try {
    const d = (h.tools.boardAdd({ text: 'Do it there', source: 'user', target_project: 'beta' }) as unknown as Loose).handoff_delivery as {
      tracker: { id: string };
      delivered: { id: string };
    };
    assert.equal(registry.renameIfUnique(h.beta, 'Beta Renamed').status, 'renamed');

    assert.deepEqual(statusOf(h.tools, d.tracker.id), { state: 'open', text: 'open in Beta Renamed', to_name: 'Beta Renamed' }, 'the live status is read through to_root and names the receiver by its current name (GitHub issue #120)');
    const got = h.tools.foreignBoardGet(d.delivered.id, 'beta');
    assert.equal(got.id, d.delivered.id);
    assert.equal(got.source_project, 'Beta Renamed', 'the read names the receiver by its current registry name');
    assert.ok(h.tools.foreignBoardQuery({ target_project: 'beta' }).records.some((r) => r.id === d.delivered.id));
    assert.equal(h.tools.foreignBoardGet(d.delivered.id, 'Beta Renamed').id, d.delivered.id, 'the new name reads it too');
    assert.throws(
      () => h.tools.boardAdd({ text: 'again', source: 'user', target_project: 'beta' }),
      /board_add: target_project 'beta' is refused: no registered project has that name; registered: (alpha, Beta Renamed|Beta Renamed, alpha)\. Nothing was written\./,
      'a write never follows a tracker to a renamed receiver'
    );

    // The receiver is unregistered: refused loud, saying it is no longer registered.
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(registry.remove(h.beta), true);
    assert.throws(
      () => h.tools.foreignBoardGet(d.delivered.id, 'beta'),
      new RegExp(`^Error: board_get: target_project 'beta' is refused: no registered project has that name; registered: alpha; this board's hand-off trackers to 'beta' resolve to no registered project: the project at ${esc(h.beta)} when this tracker was created is no longer registered \\(it was last registered at ${esc(h.beta)} until [0-9T:.Z-]+\\)\\. Nothing was read\\.$`)
    );
  } finally {
    registry.close();
    h.cleanup();
  }
});

test('board_query/board_get target_project: blocked_by_state and unblocks against the other board; its tracker reads handoff_status unavailable', () => {
  const h = harness();
  try {
    const b = h.betaTools();
    let blocker: Loose;
    let waiter: Loose;
    try {
      blocker = (b.tools.boardAdd({ text: 'Blocker there', source: 'user', objective: 'x' }) as unknown as { record: Loose }).record;
      waiter = (b.tools.boardAdd({ text: 'Waits there', source: 'user', objective: 'x', blocked_by: [String(blocker.slug)] }) as unknown as { record: Loose }).record;
    } finally {
      b.close();
    }
    const rows = new Map(h.tools.foreignBoardQuery({ target_project: 'beta' }).records.map((r) => [r.id, r]));
    assert.deepEqual(rows.get(waiter.id)?.blocked_by_state, [{ slug: blocker.slug, state: 'open' }]);
    assert.equal((rows.get(blocker.id)?.unblocks as string[]).length, 1);
    assert.deepEqual(h.tools.foreignBoardGet(String(waiter.id), 'beta').blocked_by_state, [{ slug: blocker.slug, state: 'open' }]);
    const b2 = h.betaTools();
    try {
      b2.tools.boardRemove(String(blocker.id));
    } finally {
      b2.close();
    }
    assert.deepEqual(h.tools.foreignBoardGet(String(waiter.id), 'beta').blocked_by_state, [{ slug: blocker.slug, state: 'closed' }], 'a blocker removed there reads closed');

    // alpha hands a task to beta; beta reads alpha's board and sees the tracker.
    const sent = h.tools.boardAdd({ text: 'Do it over there', source: 'user', target_project: 'beta' }) as unknown as Loose;
    const trackerId = (sent.handoff_delivery as { tracker: { id: string } }).tracker.id;
    const betaStore = new SterlingStore(join(h.beta, '.sterling', 'sterling.db'));
    try {
      const fromBeta = new SterlingTools({ store: betaStore, repoRoot: h.beta, registryPath: h.reg, now: () => NOW });
      const tracker = fromBeta.foreignBoardQuery({ target_project: 'alpha' }).records.find((r) => r.id === trackerId);
      assert.equal(tracker?.readiness, 'delegated');
      assert.equal(tracker?.handoff_status, 'unavailable:other_project');
      assert.equal(tracker?.source_project, 'alpha');
    } finally {
      betaStore.close();
    }
  } finally {
    h.cleanup();
  }
});

test('board_query target_project: budget exhaustion, unreadable rows and a schema-version difference are disclosed', () => {
  const h = harness();
  try {
    seedBeta(h, [{ text: 'Readable', objective: 'x' }]);
    const db = join(h.beta, '.sterling', 'sterling.db');
    const bad = randomUUID();
    const w = new DatabaseSync(db);
    w.prepare(`INSERT INTO records (id, type, status, scope, created_at, updated_at, author, body) VALUES (?, 'todo', 'active', 'project', ?, ?, 'conductor', '{broken')`).run(bad, NOW, NOW);
    w.exec('PRAGMA user_version=3');
    w.close();

    const res = h.tools.foreignBoardQuery({ target_project: 'beta' });
    assert.equal(res.matched_filter, 1);
    assert.deepEqual(res.unreadable, [{ id: bad, reason: 'the stored body is not valid JSON' }]);
    assert.equal(res.target_schema_version, 3);
    assert.match(res.note ?? '', /schema version 3 and this Sterling supports 2/);
    assert.match(res.note ?? '', /1 board row\(s\) could not be read/);
    assert.throws(() => h.tools.foreignBoardGet(bad, 'beta'), /cannot be read by this Sterling: the stored body is not valid JSON/);

    const starved = new SterlingTools({ store: h.store, repoRoot: h.alpha, registryPath: h.reg, now: () => NOW, foreignBoardRead: { budgetMs: 0 } });
    const cut = starved.foreignBoardQuery({ target_project: 'beta' });
    assert.match(cut.truncated ?? '', /time budget exhausted/);
    assert.equal(cut.capped, false);
    assert.match(cut.note ?? '', /matched_filter is a FLOOR and a page that is not capped is NOT the end of that board/);
    assert.throws(() => starved.foreignBoardGet('Readable', 'beta'), /cut short .* NOT proof it is absent/);
  } finally {
    h.cleanup();
  }
});

test('board_query/board_get: the served tools register target_project under the strict input schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-foreign-schema-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = (await client.listTools()).tools;
    for (const name of ['board_query', 'board_get']) {
      const schema = listed.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, { type?: string }>; additionalProperties?: unknown; required?: string[] };
      assert.equal(schema.properties?.target_project?.type, 'string', name);
      assert.equal(schema.additionalProperties, false, name);
      assert.equal((schema.required ?? []).includes('target_project'), false, name);
    }
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Raw rows in beta's store, as another Sterling might have written them; `body` null writes a valid user item. */
function rawBetaRows(h: ReturnType<typeof harness>, rows: { id: string; body?: string; text?: string }[]): void {
  const w = new DatabaseSync(join(h.beta, '.sterling', 'sterling.db'));
  try {
    const ins = w.prepare(`INSERT INTO records (id, type, status, scope, created_at, updated_at, author, body) VALUES (?, 'todo', 'active', 'project', ?, ?, 'conductor', ?)`);
    w.exec('BEGIN');
    for (const r of rows) {
      const body =
        r.body ??
        JSON.stringify({ id: r.id, type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], source: 'user', text: r.text ?? 'Raw item' });
      ins.run(r.id, NOW, NOW, body);
    }
    w.exec('COMMIT');
  } finally {
    w.close();
  }
}

test('board_query/board_get target_project (review #1): a board past 1000 items is paged to its last item, and board_get reaches the oldest', () => {
  const h = harness();
  try {
    const ids = Array.from({ length: 1001 }, () => randomUUID());
    rawBetaRows(h, ids.map((id, i) => ({ id, text: `Item ${i}` })));
    const oldest = [...ids].sort()[0];
    const first = h.tools.foreignBoardQuery({ target_project: 'beta', cap: 1000, projection: 'headline' });
    assert.equal(first.matched_filter, 1001);
    assert.equal(first.capped, true);
    assert.ok(first.next_cursor, 'a continuation is offered');
    const second = h.tools.foreignBoardQuery({ target_project: 'beta', cap: 1000, projection: 'headline', cursor: first.next_cursor });
    assert.deepEqual(second.records.map((r) => r.id), [oldest]);
    assert.equal(second.capped, false);
    assert.equal(second.truncated, undefined);
    assert.deepEqual(h.tools.foreignBoardQuery({ target_project: 'beta', cap: 1000, offset: 1000, projection: 'headline' }).records.map((r) => r.id), [oldest]);
    assert.equal(h.tools.foreignBoardGet(oldest, 'beta').id, oldest);
    assert.equal(h.tools.foreignBoardGet(oldest.slice(0, 8), 'beta').id, oldest);
  } finally {
    h.cleanup();
  }
});

test('board_get target_project (review #2): an 8-char prefix shared by a readable and an unreadable row is ambiguous; a cut-short prefix lookup is refused', () => {
  const h = harness();
  try {
    const readable = 'abcdef12-0000-4000-8000-000000000001';
    const broken = 'abcdef12-0000-4000-8000-000000000002';
    rawBetaRows(h, [{ id: readable, text: 'Readable' }, { id: broken, body: '{broken' }]);
    assert.throws(
      () => h.tools.foreignBoardGet('abcdef12', 'beta'),
      (e: Error) => /^board_get: 'abcdef12' is ambiguous in project 'beta', 2 live todo rows match it: /.test(e.message) && e.message.includes(readable) && e.message.includes(broken)
    );
    assert.equal(h.tools.foreignBoardGet(readable, 'beta').id, readable, 'the full uuid still resolves');
    assert.throws(() => h.tools.foreignBoardGet(broken, 'beta'), /cannot be read by this Sterling: the stored body is not valid JSON/);
    const starved = new SterlingTools({ store: h.store, repoRoot: h.alpha, registryPath: h.reg, now: () => NOW, foreignBoardRead: { budgetMs: 0 } });
    assert.throws(() => starved.foreignBoardGet('abcdef12', 'beta'), /was not found in project 'beta': the lookup was cut short .* NOT proof it is absent/);
  } finally {
    h.cleanup();
  }
});

test('board_add target_project resolves by the registry name after a rename; the old name is refused (GitHub #113)', () => {
  const h = harness();
  try {
    const registry = new ProjectRegistry(h.reg);
    try {
      assert.deepEqual(registry.renameIfUnique(h.beta, 'beta-renamed'), { status: 'renamed' });
    } finally {
      registry.close();
    }
    const add = (target_project: string) => h.tools.boardAdd({ text: 'Do the thing\nsee src/a.ts:1', source: 'user', target_project });
    assert.throws(() => add('beta'), /target_project 'beta' is refused: no registered project has that name; registered: alpha, beta-renamed\./);
    const res = add('beta-renamed') as unknown as Loose;
    assert.equal((res.handoff_delivery as { delivered: { project: string; root: string } }).delivered.project, 'beta-renamed');
    assert.equal((res.handoff_delivery as { delivered: { root: string } }).delivered.root, h.beta);
  } finally {
    h.cleanup();
  }
});

// GitHub issue #119: a receiver whose folder was moved and repointed with
// list-projects --move (ProjectRegistry.moveProject) keeps resolving at its
// new path, for status, closure and evidence alike; a project that registers
// at the old path later does not capture trackers created before the move.
const MOVED_AT = '2026-10-16T09:00:00.000Z';
const LATER = '2026-10-17T09:00:00.000Z';

function moveBeta(h: ReturnType<typeof harness>, registry: ProjectRegistry): string {
  const moved = join(h.base, 'beta-moved');
  renameSync(h.beta, moved);
  assert.equal(registry.moveProject(h.beta, moved, MOVED_AT).status, 'moved');
  return moved;
}

/** A tools instance on the receiver at `root`, as its own server would be. */
function receiverTools(root: string) {
  const s = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  return { tools: new SterlingTools({ store: s, repoRoot: root, now: () => NOW }), close: () => s.close() };
}

test('a receiver moved with --move resolves at its new path: open stays open, closed reads DONE with its note and evidence (GitHub issue #119)', () => {
  const h = harness();
  const registry = new ProjectRegistry(h.reg);
  try {
    const open = handOver(h);
    const noted = handOver(h);
    const evidenced = handOver(h, { milestone: 'merged' });
    const moved = moveBeta(h, registry);

    assert.deepEqual(statusOf(h.tools, open.tracker.id), { state: 'open', text: 'open in beta' });
    const b = receiverTools(moved);
    try {
      assert.equal(b.tools.boardRemove(noted.delivered.id, 'shipped in 1a2b3c').handoff_closure, join(moved, '.sterling', 'handoffs', `${noted.transfer_id}.json`));
      b.tools.boardRemove(evidenced.delivered.id, undefined, { commit: '1a2b3c' });
    } finally {
      b.close();
    }
    assert.deepEqual(statusOf(h.tools, open.tracker.id), { state: 'open', text: 'open in beta' });
    assert.deepEqual(statusOf(h.tools, noted.tracker.id), { state: 'done', text: `DONE in beta ${NOW}: shipped in 1a2b3c`, closed_at: NOW, note: 'shipped in 1a2b3c' });
    assert.deepEqual(statusOf(h.tools, evidenced.tracker.id), {
      state: 'done',
      text: `DONE in beta ${NOW} (merged): commit 1a2b3c`,
      closed_at: NOW,
      evidence: { commit: '1a2b3c' },
      milestone: 'merged',
    });
    assert.equal((h.tools.boardGet(open.tracker.id) as unknown as Loose).handoff_status !== undefined, true);
    assert.deepEqual((h.tools.boardGet(open.tracker.id) as unknown as Loose).handoff, { role: 'sent', transfer_id: open.transfer_id, to_root: h.beta, to_name: 'beta', to_item_id: open.delivered.id }, 'the stored tracker is never rewritten');
  } finally {
    registry.close();
    h.cleanup();
  }
});

test('a new project registered at the old path: a pre-move tracker still resolves to the moved project, a later tracker to the new one; nothing located reads unknown (GitHub issue #119)', () => {
  const h = harness();
  const registry = new ProjectRegistry(h.reg);
  const laterStore = new SterlingStore(join(h.alpha, '.sterling', 'sterling.db'));
  try {
    const before = handOver(h);
    moveBeta(h, registry);
    projectDir(h.base, 'beta');
    h.register('newcomer', h.beta);

    const later = new SterlingTools({ store: laterStore, repoRoot: h.alpha, registryPath: h.reg, now: () => LATER });
    const after = (later.boardAdd({ text: 'For the newcomer', source: 'user', target_project: 'newcomer' }) as unknown as Loose).handoff_delivery as Delivery;
    assert.equal((h.tools.boardGet(after.tracker.id) as unknown as Loose).created_at, LATER);

    assert.deepEqual(statusOf(h.tools, before.tracker.id), { state: 'open', text: 'open in beta' }, 'the pre-move tracker follows the alias');
    assert.deepEqual(statusOf(h.tools, after.tracker.id), { state: 'open', text: 'open in newcomer' }, 'the later tracker reads the project now at that path');

    // The moved project is unregistered: its key's history stays and the pre-move tracker reads unknown, never the newcomer's board.
    assert.equal(registry.remove(join(h.base, 'beta-moved')), true);
    const lost = statusOf(h.tools, before.tracker.id);
    assert.equal(lost?.state, 'unknown');
    assert.match(String(lost?.text), /^status unknown: beta's project cannot be located: the project at .*\/beta when this tracker was created is no longer registered \(it was last registered at .*\/beta-moved until [0-9T:.Z-]+\)$/);
    assert.deepEqual(statusOf(h.tools, after.tracker.id), { state: 'open', text: 'open in newcomer' });
  } finally {
    laterStore.close();
    registry.close();
    h.cleanup();
  }
});

// GitHub issue #120: a receiver renamed in the registry reads under its
// CURRENT name in the status text; the stored to_name is never rewritten.
test('a receiver renamed in the registry reads under its current name in handoff_status, whichever state it is in; the stored to_name is unchanged (GitHub issue #120)', () => {
  const h = harness();
  const registry = new ProjectRegistry(h.reg);
  try {
    const open = handOver(h);
    const done = handOver(h);
    const closed = h.betaTools();
    try {
      closed.tools.boardRemove(done.delivered.id, 'shipped');
    } finally {
      closed.close();
    }
    assert.equal(registry.renameIfUnique(h.beta, 'Beta Renamed').status, 'renamed');

    assert.deepEqual(statusOf(h.tools, open.tracker.id), { state: 'open', text: 'open in Beta Renamed', to_name: 'Beta Renamed' });
    assert.deepEqual(statusOf(h.tools, done.tracker.id), { state: 'done', text: `DONE in Beta Renamed ${NOW}: shipped`, closed_at: NOW, note: 'shipped', to_name: 'Beta Renamed' });
    assert.equal((h.tools.boardGet(open.tracker.id) as unknown as Loose).readiness, 'delegated');
    assert.deepEqual((h.tools.boardGet(open.tracker.id) as unknown as Loose).handoff, { role: 'sent', transfer_id: open.transfer_id, to_root: h.beta, to_name: 'beta', to_item_id: open.delivered.id }, 'the stored tracker is never rewritten');
  } finally {
    registry.close();
    h.cleanup();
  }
});

test("board_query handoff_to_item_id (#175): finds the tracker by the receiver's item id; foreign rows carry readiness", () => {
  const h = harness();
  try {
    const d = handOver(h);
    handOver(h);
    const found = h.tools.boardQueryResult({ source: 'user', handoff_to_item_id: d.delivered.id }).records as Loose[];
    assert.deepEqual(found.map((r) => r.id), [d.tracker.id]);
    assert.equal(found[0].readiness, 'delegated');
    assert.deepEqual(h.tools.boardQueryResult({ source: 'user', handoff_to_item_id: '00000000-0000-4000-8000-000000000000' }).records, []);
    assert.throws(() => handOver(h, { needs: 'external' }), /needs 'external' cannot go with target_project/);
    const b = h.betaTools();
    try {
      b.tools.boardUpdate(d.delivered.id, { needs: 'external', needs_reason: 'reply from the supplier' });
    } finally {
      b.close();
    }
    const foreign = h.tools.foreignBoardQuery({ target_project: 'beta' }).records as Loose[];
    const row = foreign.find((r) => r.id === d.delivered.id) as Loose;
    assert.equal(row.readiness, 'waiting');
    assert.equal(row.needs, 'external');
    const waiting = h.tools.foreignBoardQuery({ target_project: 'beta', readiness: ['waiting'] }).records as Loose[];
    assert.deepEqual(waiting.map((r) => r.id), [d.delivered.id]);
    assert.ok(foreign.filter((r) => r.readiness === 'ready').length >= 1, 'the other handed-over item is ready there');
  } finally {
    h.cleanup();
  }
});
