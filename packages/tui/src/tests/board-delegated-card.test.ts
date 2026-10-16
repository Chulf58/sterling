// Tasks-tab card for a tracker of a task handed to another project (GitHub
// issue #105): its detail line says where the task went and the status read
// from that project's store; any other item has no such line. The receiver is
// located through the project registry (GitHub issue #119), so every case sets
// STERLING_REGISTRY_DB to a temp registry and never reads the machine's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry, SterlingStore } from '@sterling/store';
import { todoCards } from '../viewmodel.js';

const NOW = '2026-10-15T12:00:00.000Z';
const MOVED_AT = '2026-10-16T09:00:00.000Z';

function create(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  const rec = { id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], source: 'user', ...over };
  return store.create(rec as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

/** A temp base with a registry (STERLING_REGISTRY_DB points at it for the case) and a receiver 'beta' holding one received item. */
function withSandbox(fn: (s: { base: string; beta: string; registry: ProjectRegistry; trackerId: string; transfer: string; remoteId: string }) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'sterling-tui-delegated-'));
  const prevEnv = process.env.STERLING_REGISTRY_DB;
  process.env.STERLING_REGISTRY_DB = join(base, 'registry.db');
  const registry = new ProjectRegistry(process.env.STERLING_REGISTRY_DB);
  try {
    const beta = join(base, 'beta');
    mkdirSync(join(beta, '.sterling'), { recursive: true });
    writeFileSync(join(beta, '.sterling', 'config.json'), '{}');
    registry.register({ repo_path: beta, name: 'beta', stack_tags: [], toolchains: [], sterling_version: null, at: NOW });
    const b = new SterlingStore(join(beta, '.sterling', 'sterling.db'));
    const transfer = randomUUID();
    const trackerId = randomUUID();
    const remote = create(b, { text: 'Do it there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: trackerId } });
    b.close();
    fn({ base, beta, registry, trackerId, transfer, remoteId: remote.id });
  } finally {
    registry.close();
    if (prevEnv === undefined) delete process.env.STERLING_REGISTRY_DB;
    else process.env.STERLING_REGISTRY_DB = prevEnv;
    rmSync(base, { recursive: true, force: true });
  }
}

test('todoCards: a delegated tracker shows `delegated to <project>: <status>`; a plain item does not', () => {
  withSandbox(({ base, beta, trackerId, transfer, remoteId }) => {
    const a = new SterlingStore(join(base, 'alpha.db'));
    try {
      create(a, { id: trackerId, text: "Handed to project 'beta': Do it there", handoff: { role: 'sent', transfer_id: transfer, to_root: beta, to_name: 'beta', to_item_id: remoteId } });
      const pending = create(a, { text: "Handed to project 'beta': Pending", handoff: { role: 'sent', transfer_id: randomUUID(), to_root: beta, to_name: 'beta', to_item_id: null } });
      const plain = create(a, { text: 'Plain task', priority: 'high' });
      const cards = new Map(todoCards(a).map((c) => [c.id, c]));
      assert.equal(cards.get(trackerId)?.detail, 'delegated to beta: open in beta');
      assert.equal(cards.get(pending.id)?.detail, 'delegated to beta: delivery unconfirmed');
      assert.equal(cards.get(plain.id)?.detail, 'priority: high');
    } finally {
      a.close();
    }
  });
});

test('todoCards: a receiver moved with list-projects --move shows its real status at the new path, not gone or unknown (GitHub issue #119)', () => {
  withSandbox(({ base, beta, registry, trackerId, transfer, remoteId }) => {
    const a = new SterlingStore(join(base, 'alpha.db'));
    try {
      create(a, { id: trackerId, text: "Handed to project 'beta': Do it there", handoff: { role: 'sent', transfer_id: transfer, to_root: beta, to_name: 'beta', to_item_id: remoteId } });
      const moved = join(base, 'beta-moved');
      renameSync(beta, moved);
      assert.equal(registry.moveProject(beta, moved, MOVED_AT).status, 'moved');
      const cards = new Map(todoCards(a).map((c) => [c.id, c]));
      assert.equal(cards.get(trackerId)?.detail, 'delegated to beta: open in beta');
    } finally {
      a.close();
    }
  });
});
