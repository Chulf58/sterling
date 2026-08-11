// ------------------- board `objective` grouping field, TOOL half -------------------
// decision a8d2ce6c-ccb5-4176-8130-a23d619b6d5a, slice 1.
//
// board_add gains an `objective` parameter; board_update's updatable-fields allowlist
// gains 'objective'; board_query's digest projection carries it. The four rules the
// decision fixes, each asserted head-on below:
//   1. objective: "Animation pass"  -> stored on the todo, echoed in the digest receipt
//   2. objective: "standalone"      -> normalized to ABSENT, the write still succeeds
//   3. objective OMITTED            -> the item is STILL SAVED (never a throw — a
//                                      user-stated task must never be lost) and the
//                                      result carries a loud "objective undeclared"
//                                      notice naming board_update as the remedy
//   4. objective on source:'system' -> refused loudly naming the constraint
//                                      (maintenance items are lane-keyed, never grouped)
// board_update keeps its in-place semantics: id stable, no supersession.
//
// Written RED-FIRST against a surface that does not carry `objective` yet. Every call
// that must SUCCEED is wrapped in assert.doesNotThrow, and every argument carrying the
// not-yet-declared field is cast through `unknown` — so a missing implementation fails
// on an AssertionError, never on a package build error (a crash-red proves nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

// harness() is duplicated from tools.test.ts deliberately: that module is not an
// exporter of its fixtures, and importing it would re-execute its whole suite.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-objective-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;

// the cast-through-unknown seam: `objective` is not on board_add's declared parameter
// type until this slice ships, so the argument is cast rather than referenced.
function addRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

function updateRaw(tools: SterlingTools, id: string, patch: Loose): Loose {
  return tools.boardUpdate(id, patch as unknown as Parameters<SterlingTools['boardUpdate']>[1]) as unknown as Loose;
}

function boardItems(tools: SterlingTools, source: 'user' | 'system' = 'user'): Loose[] {
  return tools.boardQuery({ source }) as unknown as Loose[];
}

test('board_add objective:"Animation pass" — the objective is PERSISTED on the todo and echoed in the digest receipt (decision a8d2ce6c slice 1)', () => {
  const { tools, cleanup } = harness();
  try {
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, { text: 'ship the animation pass', source: 'user', priority: 'high', objective: 'Animation pass' });
    }, 'board_add must ACCEPT objective on a source:user item — the grouping parameter this slice adds');

    const echoed = res!.record as Loose;
    assert.equal(echoed.objective, 'Animation pass', 'the add result echoes the objective it stored');

    // read it back through the store, independently of the echo: persisted, not just echoed
    const stored = boardItems(tools);
    assert.equal(stored.length, 1, 'exactly one item on the board');
    assert.equal(stored[0].objective, 'Animation pass', 'the objective is PERSISTED on the todo, not merely echoed');
    assert.equal(stored[0].text, 'ship the animation pass', 'the item text is untouched');
    assert.equal(stored[0].priority, 'high', 'sibling fields are untouched by the new parameter');

    // the DIGEST RECEIPT (the default write projection since board 7ddf13a7) must carry
    // the grouping — a receipt that drops it leaves the caller unable to confirm the group
    const receipt = (
      tools.writeProjected(res! as unknown as Parameters<SterlingTools['writeProjected']>[0]) as { record: Loose }
    ).record;
    assert.equal(receipt.objective, 'Animation pass', 'the digest receipt echoes the objective');

    // a grouped add is NOT an undeclared add — no undeclared-objective notice fires
    assert.ok(
      !/objective undeclared/i.test(JSON.stringify(res)),
      'a declared objective must not also emit the undeclared notice'
    );
  } finally {
    cleanup();
  }
});

test('board_add objective:"standalone" — normalized to ABSENT, the write still succeeds normally (decision a8d2ce6c slice 1)', () => {
  const { tools, cleanup } = harness();
  try {
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, { text: 'a one-off chore', source: 'user', objective: 'standalone' });
    }, '"standalone" is the declared opt-out sentinel — it must SUCCEED, never be refused as an invalid objective');

    const echoed = res!.record as Loose;
    assert.ok(
      !('objective' in echoed) || echoed.objective === undefined,
      '"standalone" is normalized to ABSENT at the tool layer — never stored as a literal group named "standalone"'
    );

    const stored = boardItems(tools);
    assert.equal(stored.length, 1, 'the item is saved normally — the sentinel is not a rejection');
    assert.equal(stored[0].text, 'a one-off chore');
    assert.ok(
      !('objective' in stored[0]) || stored[0].objective === undefined,
      'the PERSISTED record carries no objective field at all'
    );

    // an explicit "standalone" is a DECLARATION, not an omission — the loud
    // undeclared-objective notice must not fire for it
    assert.ok(
      !/objective undeclared/i.test(JSON.stringify(res)),
      'declaring "standalone" satisfies the declaration — no undeclared notice'
    );
  } finally {
    cleanup();
  }
});

test('board_add objective:"standalone" is EXACT-LOWERCASE — "Standalone" / " standalone " are ordinary objectives, not the sentinel (decision a8d2ce6c slice 1)', () => {
  const { tools, cleanup } = harness();
  try {
    // the decision pins the sentinel as the exact lowercase literal; a near-miss must be
    // stored as the group the caller named, never silently swallowed into ungrouped
    let capitalized: Loose | undefined;
    assert.doesNotThrow(() => {
      capitalized = addRaw(tools, { text: 'grouped under a literal-looking name', source: 'user', objective: 'Standalone' });
    }, 'a non-sentinel objective is an ordinary non-empty string');
    assert.equal(
      (capitalized!.record as Loose).objective,
      'Standalone',
      '"Standalone" is NOT the exact-lowercase sentinel — it is stored verbatim as a real objective'
    );

    let padded: Loose | undefined;
    assert.doesNotThrow(() => {
      padded = addRaw(tools, { text: 'another grouped item', source: 'user', objective: ' standalone ' });
    }, 'a padded near-miss is an ordinary non-empty string');
    assert.equal(
      (padded!.record as Loose).objective,
      ' standalone ',
      'the sentinel match is on the exact literal — a padded value is stored verbatim, never trimmed into the sentinel'
    );
  } finally {
    cleanup();
  }
});

test('board_add with the objective OMITTED — the item is STILL SAVED and the result carries a loud "objective undeclared" notice naming board_update (decision a8d2ce6c slice 1)', () => {
  const { tools, cleanup } = harness();
  try {
    // THE RULE THIS PROTECTS: a user-stated task must never be lost to a missing
    // grouping key. Omission is a NOTICE, never a throw.
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, { text: "the user's own item", source: 'user' });
    }, 'an add with no objective must NEVER throw — a user-stated task must never be lost');

    const stored = boardItems(tools);
    assert.equal(stored.length, 1, 'the item IS on the board — an undeclared objective never costs the item');
    assert.equal(stored[0].text, "the user's own item", 'saved verbatim');
    assert.ok(
      !('objective' in stored[0]) || stored[0].objective === undefined,
      'an undeclared objective is stored as absent, not as a placeholder string'
    );

    // The decision does not name the field that carries the notice, so the oracle asserts
    // on the SERIALIZED result: whichever channel carries it, the caller must SEE both the
    // loud phrase and the remedy.
    const serialized = JSON.stringify(res);
    assert.match(serialized, /objective undeclared/i, 'the result carries the loud "objective undeclared" notice');
    assert.match(serialized, /board_update/, 'and names board_update as the remedy for a slice that should have been grouped');
  } finally {
    cleanup();
  }
});

test("board_add: an objective on a source:'system' add is REFUSED loudly naming the constraint; nothing is written (decision a8d2ce6c slice 1)", () => {
  const { tools, cleanup } = harness();
  try {
    assert.throws(
      () =>
        addRaw(tools, {
          text: 'reconcile auth article',
          source: 'system',
          system_reason: 'reconcile_needed',
          objective: 'Animation pass',
        }),
      (err: Error) => {
        assert.match(err.message, /objective/i, 'the refusal names the offending parameter');
        assert.match(
          err.message,
          /system|maintenance|lane/i,
          'and the constraint: maintenance items are lane-keyed (system_reason), never objective-grouped'
        );
        return true;
      },
      "only source:'user' items take an objective"
    );
    assert.equal(tools.boardQuery({ source: 'system' }).length, 0, 'the refused add wrote NOTHING — no half-written queue item');

    // ...and a LEGITIMATE system add is unaffected: it still succeeds, and it must NOT
    // draw the undeclared-objective notice (a lane-keyed item has no objective to declare).
    let queued: Loose | undefined;
    assert.doesNotThrow(() => {
      queued = addRaw(tools, { text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    }, 'an ordinary maintenance add is untouched by this slice');
    assert.equal(tools.boardQuery({ source: 'system' }).length, 1, 'the maintenance item is enqueued as before');
    assert.ok(
      !/objective undeclared/i.test(JSON.stringify(queued)),
      'the undeclared notice is a USER-board concern only — a lane-keyed maintenance item never draws it'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'and it never lands on the user board');
  } finally {
    cleanup();
  }
});

test("board_update: 'objective' joins the updatable-fields allowlist — grouped IN PLACE, id stable, no supersession (decision a8d2ce6c slice 1)", () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship the animation pass', source: 'user', priority: 'low' });

    // a second clock over the SAME store so updated_at's refresh is observable
    const LATER = '2026-06-10T13:00:00.000Z';
    const laterTools = new SterlingTools({ store, now: () => LATER });

    let grouped: Loose | undefined;
    assert.doesNotThrow(() => {
      grouped = updateRaw(laterTools, original.id, { objective: 'Animation pass' });
    }, "board_update must accept 'objective' — the allowlist gains it in this slice");
    assert.equal(grouped!.objective, 'Animation pass', 'the objective is set on the existing item');
    assert.equal(grouped!.id, original.id, 'the id is STABLE — grouping an item never mints a second record (in-place semantics)');
    assert.equal(grouped!.status, 'active', 'and never supersedes it');
    assert.equal(grouped!.created_at, original.created_at, 'created_at is preserved');
    assert.equal(grouped!.updated_at, LATER, 'updated_at is refreshed to the write-time clock');
    assert.equal(grouped!.priority, 'low', 'untouched fields persist');
    assert.equal(tools.boardQuery({}).length, 1, 'still exactly one item — an update never mints a second record');
    assert.equal(boardItems(tools)[0].objective, 'Animation pass', 'the new objective is PERSISTED, not merely echoed');

    // RE-GROUPING overwrites in place — no second record, no stale group left behind
    let regrouped: Loose | undefined;
    assert.doesNotThrow(() => {
      regrouped = updateRaw(tools, original.id, { objective: 'Physics pass' });
    }, 'an item can be moved between objectives');
    assert.equal(regrouped!.objective, 'Physics pass', 'the objective is overwritten, not appended to');
    assert.equal(regrouped!.id, original.id, 'still the same record');
    assert.equal(tools.boardQuery({}).length, 1, 'still exactly one item after a re-group');
    assert.equal(boardItems(tools)[0].objective, 'Physics pass', 'the store reflects the newest group only');

    // "standalone" CLEARS the grouping back to absent
    let cleared: Loose | undefined;
    assert.doesNotThrow(() => {
      cleared = updateRaw(tools, original.id, { objective: 'standalone' });
    }, '"standalone" is the declared opt-out on update too — it must succeed');
    assert.ok(
      !('objective' in cleared!) || cleared!.objective === undefined,
      '"standalone" CLEARS the field to absent — never stored as a literal group'
    );
    const reread = boardItems(tools)[0];
    assert.ok(
      !('objective' in reread) || reread.objective === undefined,
      'the cleared field is absent in the STORE, not just in the echo'
    );
    assert.equal(reread.text, 'ship the animation pass', 'clearing a group never touches the item text');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'and clearing a group never closes the item');
  } finally {
    cleanup();
  }
});

test("board_update: the unknown-field refusal message now LISTS 'objective' among the valid fields (decision a8d2ce6c slice 1)", () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.boardAdd({ text: 'ship the animation pass', source: 'user', priority: 'low' });

    // the refusal teaches the CURRENT valid set — a stale list sends the caller to a
    // field that no longer exists and hides the one that now does
    assert.throws(
      () => updateRaw(tools, item.id, { source: 'system' }),
      (err: Error) => {
        assert.match(err.message, /'source'/, 'names the offending field');
        assert.match(err.message, /objective/, "and lists 'objective' among the valid fields now that the allowlist carries it");
        return true;
      }
    );
    // the same refusal, from another rejected field — the valid set is not conditional
    assert.throws(
      () => updateRaw(tools, item.id, { status: 'superseded' }),
      (err: Error) => {
        assert.match(err.message, /'status'/);
        assert.match(err.message, /objective/, "the valid-field list includes 'objective' regardless of which field was refused");
        return true;
      }
    );

    // the existing guards are unchanged by the allowlist growth
    assert.throws(() => updateRaw(tools, item.id, {}), /no fields to update/, 'an empty patch is still refused');
    assert.throws(() => updateRaw(tools, randomUUID(), { objective: 'Animation pass' }), /no record/, 'an unknown id is still refused');
    const { record: d } = tools.knowledgeCreate('decision', { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' });
    assert.throws(() => updateRaw(tools, d.id, { objective: 'Animation pass' }), /not a task/, 'a non-todo id is still refused');
  } finally {
    cleanup();
  }
});

test("board_query projection:'digest': a grouped item's digest line carries its objective; an ungrouped one shows none (decision a8d2ce6c slice 1)", () => {
  const { tools, cleanup } = harness();
  try {
    // a digest board read is the TRIAGE read: grouping by objective is exactly what it is
    // for, so the grouping key must survive the projection that clips the bodies
    assert.doesNotThrow(() => {
      addRaw(tools, { text: `grouped item ${'y'.repeat(2000)}`, source: 'user', priority: 'high', objective: 'Animation pass' });
    }, 'board_add accepts the objective');
    addRaw(tools, { text: 'ungrouped item', source: 'user' });

    const digest = tools.boardQueryResult({ source: 'user', projection: 'digest' });
    const records = digest.records as Loose[];
    assert.equal(records.length, 2, 'both items are returned by the digest read');

    const grouped = records.find((r) => (r.text as string).startsWith('grouped item'));
    assert.ok(grouped, 'the grouped item is in the digest result');
    assert.equal(grouped!.objective, 'Animation pass', "the digest line carries the item's objective — the grouping survives the projection");
    assert.match(grouped!.text as string, /…$/, 'while the body is still clipped — the objective is a headline, not a body');

    const ungrouped = records.find((r) => (r.text as string).startsWith('ungrouped item'));
    assert.ok(ungrouped, 'the ungrouped item is in the digest result');
    assert.ok(!('objective' in ungrouped!), 'an ungrouped item shows no objective — no null placeholder');
  } finally {
    cleanup();
  }
});
