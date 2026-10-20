// Tasks-tab card for an item waiting on an outside party (needs 'external',
// GitHub issue #175): its detail line reads `waiting on others: <reason>
// (since <date>, <age>)`, apart from the user's own waits, which keep
// `needs: <value>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { needsLine, todoCards } from '../viewmodel.js';

const NOW = '2026-10-18T09:00:00.000Z';

test('needsLine: external shows the reason and age; other needs show needs: <value>; none shows nothing', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  assert.equal(needsLine({ needs: 'external', needs_reason: 'vendor reply', needs_set_at: NOW }, now), 'waiting on others: vendor reply (since 2026-10-18, 2d ago)');
  assert.equal(needsLine({ needs: 'external', needs_reason: 'vendor reply' }, now), 'waiting on others: vendor reply (since unknown)');
  assert.equal(needsLine({ needs: 'grill' }, now), 'needs: grill');
  assert.equal(needsLine({}, now), undefined);
});

test('todoCards: an external wait card carries the waiting-on-others line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-external-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const rec = {
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], source: 'user', text: 'Vendor reply', needs: 'external', needs_reason: 'mail to Kim', needs_set_at: NOW,
    };
    store.create(rec as unknown as Parameters<SterlingStore['create']>[0]);
    const card = todoCards(store).find((c) => c.id === rec.id);
    assert.match(card?.detail ?? '', /waiting on others: mail to Kim \(since 2026-10-18, \d+d ago\)/);
    assert.doesNotMatch(card?.detail ?? '', /needs: external/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
