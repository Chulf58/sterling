// Tasks-tab card for a tracker of a task handed to another project (GitHub
// issue #105): its detail line says where the task went and the status read
// from that project's store; any other item has no such line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards } from '../viewmodel.js';

const NOW = '2026-10-15T12:00:00.000Z';

function create(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  const rec = { id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], source: 'user', ...over };
  return store.create(rec as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

test('todoCards: a delegated tracker shows `delegated to <project>: <status>`; a plain item does not', () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-tui-delegated-'));
  try {
    const beta = join(base, 'beta');
    mkdirSync(join(beta, '.sterling'), { recursive: true });
    writeFileSync(join(beta, '.sterling', 'config.json'), '{}');
    const b = new SterlingStore(join(beta, '.sterling', 'sterling.db'));
    const transfer = randomUUID();
    const trackerId = randomUUID();
    const remote = create(b, { text: 'Do it there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: trackerId } });
    b.close();

    const a = new SterlingStore(join(base, 'alpha.db'));
    try {
      create(a, { id: trackerId, text: "Handed to project 'beta': Do it there", handoff: { role: 'sent', transfer_id: transfer, to_root: beta, to_name: 'beta', to_item_id: remote.id } });
      const pending = create(a, { text: "Handed to project 'beta': Pending", handoff: { role: 'sent', transfer_id: randomUUID(), to_root: beta, to_name: 'beta', to_item_id: null } });
      const plain = create(a, { text: 'Plain task', priority: 'high' });
      const cards = new Map(todoCards(a).map((c) => [c.id, c]));
      assert.equal(cards.get(trackerId)?.detail, 'delegated to beta: open in beta');
      assert.equal(cards.get(pending.id)?.detail, 'delegated to beta: delivery unconfirmed');
      assert.equal(cards.get(plain.id)?.detail, 'priority: high');
    } finally {
      a.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
