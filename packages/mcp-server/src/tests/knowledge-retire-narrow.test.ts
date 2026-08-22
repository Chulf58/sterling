// ---------------------------------------------------------------------------
// Behavior pins for knowledge_retire's NARROW RETIREMENT contract (decision
// 9948475b-4e20-46c3-8aeb-8a224e0b8899, "Four tool-surface additions": item
// (2) knowledge_retire(id, in_favor_of)). The tool itself already ships and
// is exercised for id-ladder ADDRESSING by id-resolution.test.ts (SLOT 4:
// uuid/slug/prefix resolution on the id-to-retire argument, ambiguity and
// unresolvable-identifier refusal) — that coverage is NOT repeated here.
// This file pins the BEHAVIORAL guarantees the decision states in prose but
// which id-resolution.test.ts never asserts: retrieval visibility after
// retirement, get()'s forward/disclosure of the survivor, inbound-link
// survival, and all FIVE named refusal conditions (missing in_favor_of,
// absent survivor, self-retirement, an already-superseded survivor —
// "forwarding into a tombstone" — and a non-ruling type such as todo).
//
// Written BLIND to tools.ts / packages/store/src/index.ts. Read for harness
// convention and call/response shapes ONLY: knowledge-supersede.test.ts
// (harness skeleton, mkDecision/mkAntiPattern/mkResearchFinding fixtures,
// the `terminus` disclosure shape `{id, status}` asserted on a superseded
// record read via knowledge_get) and id-resolution.test.ts (the
// `knowledgeRetire(id, in_favor_of)` call shape and its
// `{retired: Loose}` response shape, `res.retired.superseded_by`).
//
// Decision text quoted for the refusal conditions (9948475b, verbatim):
// "in_favor_of is REQUIRED and that is the design... Refuses self-retirement,
// an absent survivor, an already-superseded survivor (forwarding into a
// tombstone), and todo/note." And: "store.retireInFavorOf... status ->
// superseded, superseded_by -> the survivor, NO new row, provenance and
// inbound links intact, and query() already never serves superseded
// records."
//
// EXPECTED FAILURE SHAPE, PER TEST, IS ANNOTATED INLINE — this feature is
// ALREADY SHIPPED (2026-08-03), so unlike a red-first TDD spec these are
// BEHAVIOR PINS: most are expected GREEN today (locking in shipped
// behavior against regression); any that come back RED is itself the
// finding, not an implementation still to be written.
//
// CORRECTED 2026-08-22 per debugger adjudication (no product defect; both
// corrections were wrong probe guesses in the original draft): (a)'s served
// count assertion is before-1, not before (retireInFavorOf writes no new
// row, but query() drops the retired record, so the net served count falls
// by one). (b) is re-pinned as "throws some error" rather than a specific
// /in_favor_of|required/i message, because that required-ness lives at the
// MCP zod input-schema layer (server.ts:155, the sole production caller),
// not inside the tools-layer method this harness calls directly.
//
// CORRECTED 2026-08-22, second round, per slice review: (b)'s
// `assert.throws(fn, '<string>')` was UNFALSIFIABLE — a string second
// argument is a MESSAGE, not a matcher, so any throw (or none, if the
// matcher had silently been treated as absent) would have passed; replaced
// with the argument-less `assert.throws(fn)` form so a throw is actually
// required. Also ADDED the two refusal pins named in this file's own
// decision-9948475b quote but never exercised until now: (e) an
// already-superseded survivor refuses ("forwarding into a tombstone"), and
// (f) a non-ruling type (todo, via boardAdd) refuses naming the type
// restriction.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-22T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-retire-narrow-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mkDecision(tools: SterlingTools, title: string, statement = 's', rationale = 'r'): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale,
  }).record as unknown as Loose;
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function decisionCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['decision'] }).length;
}

function linksOf(record: Loose): { rel: string; target_id: string }[] {
  return (record.links as { rel: string; target_id: string }[] | undefined) ?? [];
}

// knowledge_retire already exists with signature (id, in_favor_of). The
// wrapper only exists to let the missing-in_favor_of case pass `undefined`
// through a call the strict SterlingTools type would otherwise reject at
// compile time — the RUNTIME call still hits the real tool.
function retire(tools: SterlingTools, id: string, inFavorOf?: unknown): unknown {
  return (tools as unknown as { knowledgeRetire: (id: string, inFavorOf?: unknown) => unknown }).knowledgeRetire(
    id,
    inFavorOf
  );
}

const UNRESOLVABLE = 'zzz-totally-unresolvable-survivor-ffff';

// ===========================================================================
// (a) valid in_favor_of: retrieval stops serving the retired record;
//     knowledge_get on the retired id still resolves and forwards/discloses
//     the survivor; inbound links (both the retired record's own outbound
//     links, and a THIRD record's link pointing AT the retired record)
//     survive untouched.
// ===========================================================================

test('knowledge_retire (a): retiring with a valid in_favor_of survivor stops knowledge_query from serving the retired record, while the survivor is served', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire-a-dupe', 'duplicate statement');
    const survivor = mkDecision(tools, 'retire-a-survivor', 'survivor statement');
    const before = decisionCount(tools);

    const res = retire(tools, dupe.id as string, survivor.id as string) as unknown as { retired: Loose };
    assert.equal(res.retired.id, dupe.id, 'EXPECTED GREEN (shipped behavior): the retired record named in the response is the dupe');

    const served = tools.knowledgeQuery({ types: ['decision'] }) as unknown as Loose[];
    // DEBUGGER-VERIFIED: retireInFavorOf flips the retired record's status
    // in place (no new row is written) — but query() never serves a
    // superseded record, so the SERVED count drops by exactly one (the
    // dupe drops out; the survivor was already active and already
    // counted). `before` counted both the dupe and the survivor as active,
    // so the correct post-retire assertion is before - 1, not before.
    assert.equal(served.length, before - 1, 'EXPECTED GREEN: no new row is written, but the retired record drops out of what is served — served count is before minus one');
    assert.ok(served.every((r) => r.id !== dupe.id), 'EXPECTED GREEN: knowledge_query no longer serves the retired record');
    assert.ok(served.some((r) => r.id === survivor.id), 'the survivor remains served');
  } finally {
    cleanup();
  }
});

test('knowledge_retire (a): knowledge_get on the retired id still resolves, is marked superseded, forwards superseded_by to the survivor, and discloses it via the terminus field', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire-a-get-dupe', 'duplicate statement');
    const survivor = mkDecision(tools, 'retire-a-get-survivor', 'survivor statement');

    retire(tools, dupe.id as string, survivor.id as string);

    const pinned = get(tools, dupe.id as string);
    assert.equal(pinned.status, 'superseded', 'EXPECTED GREEN: knowledge_get(dupe.id) still resolves, marked superseded (never a "no record" refusal for a retired id)');
    assert.equal(pinned.superseded_by, survivor.id, 'forwards to the survivor');

    // terminus is the SAME read-time disclosure feature knowledge-supersede.test.ts
    // pins for supersession (AC5: `{id, status}` on any superseded record) — never
    // guessed here, only reused with the same shape.
    const terminus = pinned.terminus as { id: string; status: string } | undefined;
    assert.ok(terminus, 'EXPECTED GREEN: a superseded-by-retirement record carries the same terminus disclosure as a superseded-by-update/supersede record');
    assert.equal(terminus!.id, survivor.id);
    assert.equal(terminus!.status, 'active');
  } finally {
    cleanup();
  }
});

test('knowledge_retire (a): inbound links from a THIRD record survive retirement untouched, and the retired record\'s own outbound links survive too', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire-a-links-dupe', 'duplicate statement');
    const survivor = mkDecision(tools, 'retire-a-links-survivor', 'survivor statement');
    const outboundTarget = mkDecision(tools, 'retire-a-links-outbound-target', 'irrelevant target');
    const citer = mkDecision(tools, 'retire-a-links-citer', 'a third record that cites the dupe');

    // dupe's own outbound link (provenance)
    tools.knowledgeLink(dupe.id as string, 'informed_by', outboundTarget.id as string);
    // an INBOUND link: a third record pointing AT the dupe
    tools.knowledgeLink(citer.id as string, 'cites', dupe.id as string);

    retire(tools, dupe.id as string, survivor.id as string);

    const pinnedDupe = get(tools, dupe.id as string);
    assert.ok(
      linksOf(pinnedDupe).some((l) => l.rel === 'informed_by' && l.target_id === outboundTarget.id),
      'EXPECTED GREEN: the retired record\'s own outbound links are intact (decision 9948475b: "provenance and inbound links intact")'
    );

    const pinnedCiter = get(tools, citer.id as string);
    assert.ok(
      linksOf(pinnedCiter).some((l) => l.rel === 'cites' && l.target_id === dupe.id),
      'EXPECTED GREEN: the third record\'s inbound link still points at the (now-superseded) dupe id — retirement never rewrites another record\'s links'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (b) retire WITHOUT in_favor_of is refused
// ===========================================================================

test('knowledge_retire (b): calling the tools-layer method directly WITHOUT in_favor_of throws (bypassing the zod-enforced requirement), nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire-b-no-survivor', 'duplicate statement');
    const before = decisionCount(tools);

    // DEBUGGER-VERIFIED (2026-08-22): in_favor_of's REQUIRED-ness is enforced
    // at the MCP zod input-schema layer (server.ts:155's strict inputSchema
    // z.string() — the SOLE production caller of knowledgeRetire). This
    // test's `retire()` wrapper deliberately bypasses that layer with an
    // unsafe cast so it can hand `undefined` straight to the tools-layer
    // method — which has no independent required-ness check of its own and
    // throws a raw SQLite TypeError instead of a named-field refusal.
    //
    // CORRECTED, second round: `assert.throws(fn, '<string>')` is
    // UNFALSIFIABLE — a string second argument is a MESSAGE, never a
    // matcher, so it would have passed regardless of what (or whether
    // anything) threw. The argument-less form below only proves the bypass
    // call cannot silently SUCCEED — it throws SOMETHING. It does NOT prove
    // in_favor_of is "required" in any designed sense: that guarantee lives
    // entirely at the zod layer this harness bypasses, and is out of reach
    // from a tools-only test. The two nothing-written assertions below carry
    // the actual value of this test.
    assert.throws(() => retire(tools, dupe.id as string, undefined));
    assert.equal(decisionCount(tools), before, 'nothing written on the throw');
    assert.equal(get(tools, dupe.id as string).status, 'active', 'the record is untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (c) retire in_favor_of a NONEXISTENT id is refused
// ===========================================================================

test('knowledge_retire (c): in_favor_of naming a nonexistent id is refused, naming the identifier as given, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire-c-absent-survivor', 'duplicate statement');
    const before = decisionCount(tools);

    assert.throws(
      () => retire(tools, dupe.id as string, UNRESOLVABLE),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'EXPECTED GREEN (decision 9948475b: "Refuses ... an absent survivor"): an in_favor_of that resolves to nothing is refused, naming the identifier AS GIVEN — the house convention every other write-tool refusal in this suite follows'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the absent-survivor refusal');
    assert.equal(get(tools, dupe.id as string).status, 'active', 'the record is untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (d) retire the survivor onto ITSELF (in_favor_of = own id) is refused
// ===========================================================================

test('knowledge_retire (d): in_favor_of equal to the record\'s own id (self-retirement) is refused, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const solo = mkDecision(tools, 'retire-d-self', 'a record that cannot retire into itself');
    const before = decisionCount(tools);

    assert.throws(
      () => retire(tools, solo.id as string, solo.id as string),
      /self|itself|same record|own id/i,
      'EXPECTED GREEN (decision 9948475b: "Refuses self-retirement"): a record cannot forward to itself — that would tombstone a record while claiming it as its own survivor'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the self-retirement refusal');
    assert.equal(get(tools, solo.id as string).status, 'active', 'the record is untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (e) in_favor_of naming an ALREADY-SUPERSEDED survivor is refused — a
//     retired record must forward to an ACTIVE record, never into a
//     tombstone (decision 9948475b, verbatim: "Refuses ... an
//     already-superseded survivor (forwarding into a tombstone)").
// ===========================================================================

test('knowledge_retire (e): in_favor_of naming an already-superseded (tombstoned) survivor is refused, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'retire-e-tombstone-a', 'a record that will itself be superseded');
    // Supersede A via an ordinary knowledge_update — A's OLD id is now a
    // tombstone (status: 'superseded'), forwarding to a NEW active id.
    tools.knowledgeUpdate(a.id as string, { rationale: 'v2 via an ordinary knowledge_update' });
    assert.equal(get(tools, a.id as string).status, 'superseded', "precondition: A's old id is now a tombstone");

    const b = mkDecision(tools, 'retire-e-tombstone-b', 'a separate record attempting to retire into a tombstone');
    const before = decisionCount(tools);

    assert.throws(
      () => retire(tools, b.id as string, a.id as string),
      /superseded|tombstone|active/i,
      'EXPECTED GREEN (decision 9948475b: "an already-superseded survivor (forwarding into a tombstone)"): retiring INTO a tombstoned id is refused — a retired record must forward to an ACTIVE survivor'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the tombstone-forwarding refusal');
    assert.equal(get(tools, b.id as string).status, 'active', 'B is untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (f) retiring a NON-RULING type (todo) is refused, naming the type
//     restriction (decision 9948475b, verbatim: "Refuses ... todo/note").
//     Reachable through this harness via `tools.boardAdd` (the same
//     fixture shape knowledge-supersede.test.ts's AC3 todo-refusal test
//     uses) — `note` is not exercised here since the note surface was
//     retired in full (decision note-surface-retired, 2026-08-11) and is no
//     longer creatable through any harness.
// ===========================================================================

test('knowledge_retire (f): retiring a todo (non-ruling type) is refused, naming the type restriction, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: todo } = tools.boardAdd({ text: 'a todo item', source: 'user' });
    const survivor = mkDecision(tools, 'retire-f-survivor', 'an unrelated valid survivor');
    const before = decisionCount(tools);

    assert.throws(
      () => retire(tools, todo.id as string, survivor.id as string),
      /todo|board_remove|type/i,
      'EXPECTED GREEN (decision 9948475b: "Refuses ... todo/note"): a todo cannot be retired — P4 removal (board_remove) is its own exit path'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the type-restriction refusal (decision count, unaffected either way, checked for parity with the other refusal tests)');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'the todo is untouched');
  } finally {
    cleanup();
  }
});
