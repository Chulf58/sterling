// Two writers on one store through the tool surface (board 895d3c6c). Two
// sessions are two SterlingTools over two SterlingStore handles on the same
// SQLite file. The interleaving is forced deterministically: session B's whole
// call runs from a hook on session A's store, after A's tool has read the
// record and before A's write.
//
// board_update: B changes the priority while A is rewording the text. A's
// write was merged from its earlier read, so without a CAS it reverted B's
// priority. It is now refused with the store's stale-expected_version error.
//
// knowledge_retire: A retires X in favour of Y while B retires Y in favour of
// X. Both used to commit, leaving two retired records forwarding to each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-06T12:00:00.000Z';

type Loose = Record<string, unknown>;

function twoSessions() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-two-sessions-'));
  const path = join(dir, 'sterling.db');
  const storeA = new SterlingStore(path);
  const storeB = new SterlingStore(path);
  const a = new SterlingTools({ store: storeA, now: () => NOW });
  const b = new SterlingTools({ store: storeB, now: () => NOW });
  const cleanup = () => {
    storeA.close();
    storeB.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { storeA, a, b, cleanup };
}

/** Run `between` once, the first time `store`'s `method` is called, before the call itself. */
function beforeFirstCall(store: SterlingStore, method: 'updateTodo' | 'tx', between: () => void): void {
  const handle = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = handle[method].bind(store);
  let fired = false;
  handle[method] = (...args: unknown[]) => {
    if (!fired) {
      fired = true;
      between();
    }
    return original(...args);
  };
}

test('board_update from two sessions: a write merged from a stale read is refused and never reverts the other session\'s field', () => {
  const { storeA, a, b, cleanup } = twoSessions();
  try {
    const item = a.boardAdd({ text: 'board item, first wording', source: 'user', priority: 'normal', objective: 'standalone' })
      .record as unknown as Loose & { id: string; version: number };
    beforeFirstCall(storeA, 'updateTodo', () => b.boardUpdate(item.id, { priority: 'high' }));
    assert.throws(
      () => a.boardUpdate(item.id, { text: 'board item, second wording' }),
      /stale expected_version/,
      'session A read the item before B wrote it, so its merged write must be refused'
    );
    const final = b.boardGet(item.id) as unknown as Loose;
    assert.equal(final.priority, 'high', "B's priority survives");
    assert.equal(final.text, 'board item, first wording', "A's refused text never landed");
    assert.equal(final.version, item.version + 1, 'exactly one write landed');
  } finally {
    cleanup();
  }
});

test('knowledge_retire from two sessions: crossed retirements X->Y and Y->X cannot both commit', () => {
  const { storeA, a, b, cleanup } = twoSessions();
  try {
    const mk = (title: string) =>
      a.knowledgeCreate('decision', { title, statement: `${title} statement`, alternatives_rejected: [], rationale: 'r' })
        .record as unknown as Loose & { id: string };
    const x = mk('two-session retire x');
    const y = mk('two-session retire y');
    beforeFirstCall(storeA, 'tx', () => b.knowledgeRetire(y.id, x.id));
    assert.throws(() => a.knowledgeRetire(x.id, y.id), /is itself retired/, 'A must see that B retired its survivor');
    const xAfter = b.knowledgeGet(x.id) as unknown as Loose;
    const yAfter = b.knowledgeGet(y.id) as unknown as Loose;
    assert.equal(yAfter.status, 'superseded', "B's retirement of Y stands");
    assert.equal(xAfter.status, 'active', 'X stays live, so no retire cycle');
  } finally {
    cleanup();
  }
});
