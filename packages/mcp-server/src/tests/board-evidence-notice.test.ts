// board_add: NON-BLOCKING evidence notice on evidence-free item text
// (board fd0e0907-5029-46a4-a0d0-626e39461b9e).
//
// WHY (quoted from the board item / CLAUDE.md): "A BOARD ITEM STATES ITS
// EVIDENCE, NOT ITS CONCLUSION. Quote the deciding file:line or the measured
// number: 'the view faces one fixed direction (camera.gd:1591 writes an
// identity basis)' can be re-checked in one grep; 'the facing is broken'
// cannot, and rots invisibly." Measured cost: of eight open defects
// re-audited in a consuming project, 5 of 8 were wrong.
//
// SPEC pinned here:
//   AC1 — a source:'user' item whose text carries NO checkable evidence gets
//         a notice naming the omission; the write still SUCCEEDS.
//   AC2 — ANY ONE of seven forms suffices: repo-relative path, path:line,
//         double-quoted literal, backticked literal, measured number/count,
//         a spelled-out count (the AC's own worked example, "three
//         commits"), or a record id / 8-char hex prefix.
//   AC3 — the notice fires on the ABSENCE of ALL forms together, never on
//         the absence of any single one (pinned by AC1 + the AC2 series
//         together: each AC2 case shows ONE present form is enough).
//   AC4 — source:'system' items (mechanism-minted, system_reason-carrying)
//         are NEVER noticed.
//   AC5 — the notice text names a CONCRETE example of an accepted form.
//
// Written RED-FIRST against a boardAdd that performs no text-shape check at
// all today (verified absent at HEAD, board fd0e0907). Every write that must
// SUCCEED is wrapped in assert.doesNotThrow — a refusal-shaped regression
// must be caught exactly as loudly as a missing notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-30T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-evidence-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;

// the cast-through-unknown seam: mirrors board-objective.test.ts's addRaw —
// safe regardless of whether `objective` is (still) a declared parameter.
function addRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

function boardItems(tools: SterlingTools, source: 'user' | 'system' = 'user'): Loose[] {
  return tools.boardQuery({ source }) as unknown as Loose[];
}

function serialized(res: unknown): string {
  return JSON.stringify(res);
}

// Flexible alternation, not an exact string — same convention as
// board-remove-prefix-collision-guard.test.ts's FULL_UUID_REQUIRED: the
// precise wording is the implementer's to choose, the SUBSTANCE is pinned.
const EVIDENCE_NOTICE = /no checkable evidence|lacks (a )?checkable evidence|evidence-free|missing (a )?checkable evidence|no evidence/i;

// ---------------------------------------------------------------------------
// CONTROL ARM — written FIRST. Proves the suite is detecting the EVIDENCE
// check specifically, not merely "some notice fired" / "notices is
// non-empty". An item that both (a) carries a clear file:line citation and
// (b) omits its objective (a DIFFERENT, pre-existing notice) must show the
// pre-existing objective-undeclared notice but must NOT show the evidence
// notice. A suite that only asserted "a notice fired" would pass this
// identically under an implementation with NO evidence check at all — the
// objective notice alone would satisfy it. Asserting the absence of the
// evidence notice specifically, beside the presence of the unrelated one, is
// what rules that out.
// ---------------------------------------------------------------------------
test('CONTROL: an item with a clear file:line citation and an omitted objective shows the pre-existing objective-undeclared notice but NOT the evidence notice (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, {
        text: 'the view faces one fixed direction (camera.gd:1591 writes an identity basis)',
        source: 'user',
      });
    });
    const s = serialized(res);
    assert.match(s, /objective undeclared/i, 'the unrelated, pre-existing notice still fires (no objective was declared)');
    assert.doesNotMatch(
      s,
      EVIDENCE_NOTICE,
      'the evidence notice must NOT fire — this text carries a clear path:line citation; the control proves the suite tells the two notices apart rather than just checking "a notice exists"'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC1 + AC3 — total absence of evidence gets the notice; the write succeeds.
// ---------------------------------------------------------------------------
test("AC1/AC3: a source:'user' item whose text carries NO checkable evidence gets the evidence notice; the write still SUCCEEDS and the item is created (board fd0e0907)", () => {
  const { tools, cleanup } = harness();
  try {
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, { text: 'the facing is broken', source: 'user', objective: 'standalone' });
    }, 'an evidence-free item must NEVER be refused — only noticed');

    assert.match(serialized(res), EVIDENCE_NOTICE, 'the evidence-free item draws the evidence notice');

    const stored = boardItems(tools);
    assert.equal(stored.length, 1, 'the item IS on the board — the notice never costs the write');
    assert.equal(stored[0].text, 'the facing is broken', 'saved verbatim');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — any ONE of seven forms is sufficient; one dedicated case per form.
// Each form's sabotage is "the evidence detector drops recognition of THIS
// pattern" — narrowing the detector to miss exactly this form must flip
// this ONE test red without touching its siblings.
// ---------------------------------------------------------------------------

test('AC2a: a repo-relative path alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'the parser mis-handles unicode, see scripts/foo.mjs', source: 'user', objective: 'standalone' });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'a bare repo-relative path is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

test('AC2b: a path with a line number alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, {
      text: 'the view faces one fixed direction (camera.gd:1591 writes an identity basis)',
      source: 'user',
      objective: 'standalone',
    });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'a path:line citation is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

test('AC2c: a double-quoted literal alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'the error surfaced is "connection refused" on every retry', source: 'user', objective: 'standalone' });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'a double-quoted literal is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

test('AC2d: a backticked literal alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, {
      text: 'the function `computeTotal()` returns the wrong value on empty carts',
      source: 'user',
      objective: 'standalone',
    });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'a backticked literal is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

test('AC2e: a measured number with a unit/count alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'the reaudit found 47 of 48 defects already fixed', source: 'user', objective: 'standalone' });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'a measured count ("47 of 48") is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

test('AC2f: a spelled-out measured count alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'three commits landed on this branch without a review trailer', source: 'user', objective: 'standalone' });
    assert.doesNotMatch(
      serialized(res),
      EVIDENCE_NOTICE,
      'a spelled-out count ("three commits") is checkable evidence on its own — the AC\'s own worked example'
    );
  } finally {
    cleanup();
  }
});

test('AC2g: a record id / 8-char hex prefix alone is sufficient checkable evidence — no notice fires (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'this duplicates the open item fd0e0907', source: 'user', objective: 'standalone' });
    assert.doesNotMatch(serialized(res), EVIDENCE_NOTICE, 'an 8-char hex record-id prefix is checkable evidence on its own');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — source:'system' items are never noticed, however evidence-free.
// ---------------------------------------------------------------------------
test("AC4: source:'system' items are NEVER noticed for evidence-free text — that lane is mechanism-minted, not prose evidence (board fd0e0907)", () => {
  const { tools, cleanup } = harness();
  try {
    let res: Loose | undefined;
    assert.doesNotThrow(() => {
      res = addRaw(tools, { text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    });
    assert.doesNotMatch(
      serialized(res),
      EVIDENCE_NOTICE,
      'a maintenance-queue item never draws the evidence notice, however evidence-free its text'
    );
    assert.equal(tools.boardQuery({ source: 'system' }).length, 1, 'the item is enqueued normally');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — the notice names a concrete example, not just an abstract rule.
// ---------------------------------------------------------------------------
test('AC5: the evidence notice names at least one CONCRETE example of an accepted form (board fd0e0907)', () => {
  const { tools, cleanup } = harness();
  try {
    const res = addRaw(tools, { text: 'the facing is broken', source: 'user', objective: 'standalone' });
    const s = serialized(res);
    assert.match(s, EVIDENCE_NOTICE, 'precondition: the evidence notice fired');
    assert.match(
      s,
      /[\w./-]+\.\w+:\d+/,
      'the notice names a CONCRETE example of an accepted form (a file.ext:line citation) so the reader can fix the item without going to look up the rule'
    );
  } finally {
    cleanup();
  }
});
