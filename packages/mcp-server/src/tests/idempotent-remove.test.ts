import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// Idempotent maintenance_remove (board 83478fc6).
//
// Background this file pins: maintenance_remove on an item that was already
// drained — auto-drained by a knowledge_update re-baseline (decision 8ecd435f),
// or removed a moment earlier by a concurrent librarian call — currently
// THROWS (decision 4c09401d / board 97d773ef only taught the throw to tell
// "already removed" apart from "never existed"; it did not stop it being a
// throw). A throw here reads as a FAILED drain when the state on disk is
// exactly what the caller wanted. This suite asserts the fix: the
// already-removed case must SUCCEED with an explicit already_drained:true
// marker, idempotently — while a genuinely unknown id must still refuse,
// because collapsing that distinction would let a typo silently read as
// success.

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-idempotent-remove-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

// Tolerant of the exact field the fix chooses to carry the id on — the
// directive names "already_drained:true" and "the result names the id" but
// does not fix a field name (removed vs id), so either satisfies the AC.
function idOf(result: unknown): string | undefined {
  const r = result as { removed?: string; id?: string };
  return r.removed ?? r.id;
}

test('AC1: maintenance_remove on an open system item removes it and returns the normal removal result (regression pin)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/y.ts',
      file_keys: ['src/y.ts'],
    });

    const result = tools.maintenanceRemove(item.id) as { removed?: string; already_drained?: boolean };
    assert.equal(result.removed, item.id, 'a live removal names the removed id — unchanged shape');
    assert.notEqual(result.already_drained, true, 'a genuine live removal must not be marked already_drained');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'the item is gone from the open queue');
  } finally {
    cleanup();
  }
});

test('AC2: maintenance_remove on an id closed by an explicit knowledge_update resolves claim SUCCEEDS with already_drained:true, and repeats idempotently (board 83478fc6; decision 68988832-2ef5-4ff3-b693-4f0f0ea8dae1)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });

    // the routine race this AC exists for: the reconcile closes the item via
    // an EXPLICIT resolves claim (decision 68988832-2ef5-4ff3-b693-4f0f0ea8dae1
    // retired the old implicit auto-drain pinned by decision 8ecd435f) BEFORE
    // maintenance_remove is ever called.
    (
      tools as unknown as {
        knowledgeUpdate(id: string, patch: Record<string, unknown>, resolves?: string[]): unknown;
      }
    ).knowledgeUpdate(article.id, { state: 'active' }, [item.id]);
    assert.equal(
      tools.maintenanceQuery({ cap: 1000 }).length,
      0,
      'precondition: the claimed item is already gone from the open queue before we call remove'
    );

    // EXPECTED TO FAIL TODAY: this currently throws (assert.throws is pinned
    // at the sibling test "removes distinguish 'already removed' ... (board
    // 97d773ef)"). The fix must make this a non-throwing success.
    let first: unknown;
    assert.doesNotThrow(() => {
      first = tools.maintenanceRemove(item.id);
    }, 'an already-drained id must SUCCEED, never throw — a throw here reads as a failed drain when the state is exactly what the caller wanted');

    assert.equal((first as { already_drained?: boolean }).already_drained, true, 'the result marks the already-drained state explicitly');
    assert.equal(idOf(first), item.id, 'the result names the id the caller asked to drain');

    // idempotent: repeat calls (e.g. a retried librarian dispatch) must see the
    // SAME result, not a different answer and not an error.
    const second = tools.maintenanceRemove(item.id);
    const third = tools.maintenanceRemove(item.id);
    assert.deepEqual(second, first, 'a second call on the same id repeats the identical result');
    assert.deepEqual(third, first, 'idempotent across more than one repeat, not just once');
  } finally {
    cleanup();
  }
});

test('AC2: maintenance_remove on an id already closed by a DIRECT removal a moment earlier (concurrent-librarian race) succeeds idempotently too', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/z.ts',
      file_keys: ['src/z.ts'],
    });

    // the "concurrent librarian" — a first caller genuinely closes the item.
    const firstCall = tools.maintenanceRemove(item.id) as { removed?: string; already_drained?: boolean };
    assert.notEqual(firstCall.already_drained, true, 'the FIRST call is a live removal, not already-drained');
    assert.equal(firstCall.removed, item.id);

    // a second caller unaware the librarian just closed it must not see an
    // error reading as a failed drain.
    let repeat: unknown;
    assert.doesNotThrow(() => {
      repeat = tools.maintenanceRemove(item.id);
    }, 'a concurrent-close race must not surface as a throw to the second caller');

    assert.equal((repeat as { already_drained?: boolean }).already_drained, true);
    assert.equal(idOf(repeat), item.id, 'the result names the id even on the concurrent-removal path');

    // idempotent here too — a third call changes nothing further.
    const again = tools.maintenanceRemove(item.id);
    assert.deepEqual(again, repeat, 'idempotent on the concurrent-removal path as well as the auto-drain path');
  } finally {
    cleanup();
  }
});

test('AC3 (boundary): maintenance_remove on an id that never existed at all still REFUSES — unknown id is not read as already-drained', () => {
  const { tools, cleanup } = harness();
  try {
    // No trace in the queue_drain_log for a fabricated id (decision 4c09401d
    // gives the log a record_id column — the one observable distinction
    // between "was a maintenance item, now already removed" and "never
    // existed"; if that distinction is ever unavailable, this test pins
    // whichever refusal wording IS observably still in force for an unknown id).
    assert.throws(
      () => tools.maintenanceRemove(randomUUID()),
      /no trace of it in the drain log/,
      'a genuinely unknown id must still refuse loudly — conflating it with "already drained" would let a typo silently read as success'
    );
  } finally {
    cleanup();
  }
});

test('AC4 (regression): maintenance_remove still refuses a user-source board item exactly as today', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: usr } = tools.boardAdd({ text: "the human's own item", source: 'user' });

    assert.throws(
      () => tools.maintenanceRemove(usr.id),
      (e: Error) => {
        assert.match(e.message, /not a maintenance-queue item/);
        assert.match(e.message, /board_remove/, 'names the conductor path rather than only blocking');
        return true;
      },
      'a real user-source item is refused outright — never mistaken for an already-drained system item'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, "the user's board item is untouched by the refused call");
  } finally {
    cleanup();
  }
});
