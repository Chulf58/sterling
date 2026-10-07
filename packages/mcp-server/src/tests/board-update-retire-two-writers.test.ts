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
// Same store: the second is refused because its survivor is retired. Across a
// project store and a mounted domain store each retire locks only its own
// store, so a cross-store knowledge_retire is refused outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores, SterlingStore } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';
import { harnessMounted } from './test-helpers/mounted-harness.js';

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

test('knowledge_retire across a project store and a domain store from two sessions: crossed retirements cannot both commit', () => {
  const h = harnessMounted(['genesys'], { now: NOW, prefix: 'sterling-two-sessions-cross-' });
  const storeB = new MountedStores(join(h.dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: h.domainDbPath('genesys') }]);
  try {
    const b = new SterlingTools({ store: storeB, config: parseConfig({ stack_tags: ['genesys'] }), now: () => NOW });
    const ref = (scope: string, title: string) =>
      h.tools.knowledgeCreate('reference_material', {
        scope,
        title,
        kind: 'doc',
        location: 'docs/genesys.md',
        summary: 's',
        source_date: '2026-10-06',
        capture_date: '2026-10-06',
        basis: 'platform',
      }).record as unknown as Loose & { id: string };
    const x = ref('project', 'Genesys routing rule, project copy');
    const y = ref('domain:genesys', 'Genesys routing rule, domain copy');
    // B's call runs inside A's call, just before A takes its write lock. If A
    // is refused before reaching the lock, B runs right after instead.
    let bRan = false;
    let bError: unknown;
    const runB = () => {
      bRan = true;
      try {
        b.knowledgeRetire(y.id, x.id);
      } catch (err) {
        bError = err;
      }
    };
    beforeFirstCall(h.store.project, 'tx', runB);
    assert.throws(() => h.tools.knowledgeRetire(x.id, y.id), /cross-store retirement refused/, 'A retires project X in favour of domain Y');
    if (!bRan) runB();
    assert.match(String(bError), /cross-store retirement refused/, 'B retires domain Y in favour of project X');
    assert.equal((b.knowledgeGet(x.id) as unknown as Loose).status, 'active', 'X stays live');
    assert.equal((b.knowledgeGet(y.id) as unknown as Loose).status, 'active', 'Y stays live, so no retire cycle');
  } finally {
    storeB.close();
    h.cleanup();
  }
});
