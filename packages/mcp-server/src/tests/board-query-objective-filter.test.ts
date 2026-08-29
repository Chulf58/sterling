// ---------------- board_query({ objective }) — the FILTER half of a8d2ce6c ----------------
// Decision a8d2ce6c-ccb5-4176-8130-a23d619b6d5a gave `todo` an `objective` grouping
// field (write half pinned in board-objective.test.ts). This file pins the READ half:
// board_query gains an `objective` filter clause beside source / system_reason /
// contains. Consuming-project feedback called it "the single most obvious missing
// parameter" — 306 items paged across two lanes to find one objective's slices.
//
// The behaviour under test, stated as contract:
//   1. `objective: 'Animation pass'` is an EXACT match, AND-ed with every other
//      clause in the same pass (never OR, never a substring/prefix match).
//   2. `objective: 'standalone'` matches items with the field ABSENT — mirroring
//      the exact-lowercase sentinel the WRITE side already normalizes to absent.
//   3. The parameter is REGISTERED in server.ts's board_query inputSchema. Unknown
//      parameters are REJECTED, not ignored (AC9 / decision b47889b7), so an
//      unregistered `objective` is unreachable from any real caller no matter how
//      correct boardFiltered is. That defect class is only observable OVER THE WIRE.
//   4. THE CAVEAT: maintenance items are ungrouped too, so `objective:'standalone'`
//      alone is NOT "user items with no objective" — it needs `source:'user'` beside it.
//
// SEAM CHOICE (read this before adding an arm). SterlingTools exposes two board read
// seams and they are NOT interchangeable: boardQuery() is boardFiltered(...).slice(...)
// and NEVER reads `projection`; boardQueryResult() is the seam that projects and
// returns the {matched_filter, returned, cap, capped, note?, records} envelope (AC12).
// Every arm below is a FILTER arm, not a projection arm, so the in-process arms
// deliberately target boardQuery() — the seam that actually filters. The one arm whose
// verdict is about REGISTRATION (OBJ3) goes over the MCP wire, because an in-process
// call bypasses the server's inputSchema entirely and would pass with the parameter
// unregistered — pinning nothing.
//
// Arguments carrying `objective` are cast through `unknown` (the board-objective.test.ts
// idiom): a missing filter field must fail on an AssertionError, never on a build error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-objective-filter-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

async function wireHarness() {
  // Harness idiom copied from server.test.ts (module-private there).
  const dir = mkdtempSync(join(tmpdir(), 'sterling-objective-wire-'));
  const { server, store, tools } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, tools, cleanup };
}

function payload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

function addRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

// the FILTERING seam — boardFiltered, not the projecting one (see SEAM CHOICE above)
function queryRaw(tools: SterlingTools, filter: Loose): Loose[] {
  return tools.boardQuery(filter as unknown as Parameters<SterlingTools['boardQuery']>[0]) as unknown as Loose[];
}

const texts = (items: Loose[]): string[] => items.map((t) => t.text as string).sort();

// One deliberately HETEROGENEOUS fixture: three real objectives, two ungrouped user
// items, and one ungrouped maintenance item. Heterogeneity is what makes "exactly 2"
// evidence of a narrowing rather than of a small board.
function seed(tools: SterlingTools) {
  addRaw(tools, { text: 'wire the shader blend', source: 'user', priority: 'high', objective: 'Animation pass' });
  addRaw(tools, { text: 'retime the walk cycle', source: 'user', objective: 'Animation pass' });
  addRaw(tools, { text: 'collider budget', source: 'user', objective: 'Physics pass' });
  addRaw(tools, { text: 'solver step count', source: 'user', objective: 'Physics pass' });
  addRaw(tools, { text: 'a one-off chore', source: 'user' }); // ungrouped
  addRaw(tools, { text: 'fix the readme typo', source: 'user' }); // ungrouped
  // NOT the sentinel: exact-lowercase only, so this is an ordinary group named
  // "Standalone" (the write-side rule is pinned in board-objective.test.ts).
  addRaw(tools, { text: 'grouped under a literal-looking name', source: 'user', objective: 'Standalone' });
  // lane-keyed maintenance item: ungrouped by construction — an objective on a
  // source:'system' add is refused, so the queue can never carry one.
  addRaw(tools, { text: "reconcile 'auth' article", source: 'system', system_reason: 'reconcile_needed' });
}

// ---------------------------------------------------------------------------
// OBJ0 — CONTROL, FIRST. Passes for the OPPOSITE reason to every arm below it:
// it asserts that WITHOUT the objective filter nothing is narrowed, and that the
// board genuinely holds four distinct groupings across two sources. Without this,
// a later "returns exactly 2" could be explained by a board that only held 2, and
// the standalone caveat could not be shown to bite.
// ---------------------------------------------------------------------------
test('OBJ0 (control): an unfiltered board read narrows NOTHING — 7 user items across 4 distinct groupings, and the read spans BOTH sources (decision a8d2ce6c)', () => {
  const { tools, cleanup } = harness();
  try {
    seed(tools);

    const users = queryRaw(tools, { source: 'user' });
    assert.equal(users.length, 7, 'every user item is returned when no objective clause is given');
    const groups = new Set(users.map((t) => (t.objective as string) ?? '<ungrouped>'));
    assert.deepEqual(
      [...groups].sort(),
      ['<ungrouped>', 'Animation pass', 'Physics pass', 'Standalone'],
      'the fixture is genuinely heterogeneous — so any narrowing below is the FILTER, not the fixture'
    );

    const everything = queryRaw(tools, {});
    assert.equal(
      everything.length,
      8,
      'an unfiltered board read spans user AND system items — which is exactly what makes the standalone caveat true (OBJ2)'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// OBJ1 — the filter is an EXACT match, AND-ed with the sibling clauses.
// ---------------------------------------------------------------------------
test('OBJ1: objective:"Animation pass" returns EXACTLY that objective\'s slices, exact-matched and AND-ed with sibling clauses (decision a8d2ce6c)', () => {
  const { tools, cleanup } = harness();
  try {
    seed(tools);

    const anim = queryRaw(tools, { objective: 'Animation pass' });
    assert.deepEqual(
      texts(anim),
      ['retime the walk cycle', 'wire the shader blend'],
      'exactly the two slices of that objective — the 306-item paging this parameter exists to end'
    );
    assert.ok(
      !anim.some((t) => /collider|solver|chore|typo|literal-looking|reconcile/.test(t.text as string)),
      'and nothing from another objective, from the ungrouped items, or from the maintenance lane'
    );

    // GENUINE AND, in the same pass as `contains` — never OR, never a widening.
    const both = queryRaw(tools, { objective: 'Animation pass', contains: 'shader' });
    assert.deepEqual(texts(both), ['wire the shader blend'], 'objective AND contains narrows to their intersection');
    const crossed = queryRaw(tools, { objective: 'Physics pass', contains: 'shader' });
    assert.deepEqual(
      crossed,
      [],
      'an item matching `contains` but NOT the objective is excluded — the clauses AND, they do not OR'
    );

    // EXACT match: not a prefix, not a substring, not case-insensitive.
    assert.deepEqual(queryRaw(tools, { objective: 'Animation' }), [], 'a prefix of an objective matches nothing');
    assert.deepEqual(queryRaw(tools, { objective: 'pass' }), [], 'a substring of an objective matches nothing');
    assert.deepEqual(queryRaw(tools, { objective: 'animation pass' }), [], 'the match is case-sensitive');
    assert.deepEqual(queryRaw(tools, { objective: 'Rendering pass' }), [], 'an objective nobody used returns empty, never everything');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// OBJ2 — the 'standalone' sentinel selects FIELD-ABSENT items, and the caveat.
// ---------------------------------------------------------------------------
test('OBJ2: objective:"standalone" selects the UNGROUPED items (field-absent) — and alone it is NOT "user items with no objective" (decision a8d2ce6c)', () => {
  const { tools, cleanup } = harness();
  try {
    seed(tools);

    // The sentinel mirrors the write side: "standalone" means the field is ABSENT,
    // never a literal group named "standalone".
    const standaloneAll = queryRaw(tools, { objective: 'standalone' });
    assert.equal(standaloneAll.length, 3, 'every ungrouped item on the board — 2 user items + 1 lane-keyed maintenance item');
    assert.ok(
      standaloneAll.every((t) => !('objective' in t) || t.objective === undefined),
      'each match carries NO objective field at all — the sentinel is field-absence, not a stored string'
    );

    // THE CAVEAT, pinned head-on: maintenance items are ungrouped too, so the
    // sentinel alone spans the queue. A caller reading this as "my ungrouped tasks"
    // gets the maintenance lane mixed in.
    assert.ok(
      standaloneAll.some((t) => t.system_reason === 'reconcile_needed'),
      "the caveat: maintenance items are ungrouped BY CONSTRUCTION, so objective:'standalone' alone also returns the queue"
    );

    // ...and the remedy: combine it with source, which ANDs as usual.
    const standaloneUser = queryRaw(tools, { objective: 'standalone', source: 'user' });
    assert.deepEqual(
      texts(standaloneUser),
      ['a one-off chore', 'fix the readme typo'],
      "objective:'standalone' + source:'user' IS \"user items with no objective\" — the combination is the answer, not the sentinel alone"
    );
    assert.ok(
      !standaloneUser.some((t) => t.objective === 'Standalone'),
      'the capital-S group is a REAL objective and never answers the sentinel'
    );

    // The mirror image: the exact-lowercase rule read from the filter side. A
    // near-miss addresses the ordinary group of that name, never the ungrouped set.
    const literal = queryRaw(tools, { objective: 'Standalone' });
    assert.deepEqual(
      texts(literal),
      ['grouped under a literal-looking name'],
      '"Standalone" is NOT the sentinel — it selects the group literally named that, and no ungrouped item'
    );
    assert.deepEqual(queryRaw(tools, { objective: ' standalone ' }), [], 'a padded near-miss is an ordinary objective name nobody used — never trimmed into the sentinel');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// OBJ3-CONTROL — placed BEFORE the wire arm, and it must pass for the OPPOSITE
// reason: it proves the wire is STRICT about parameter names at all. Without it,
// "the objective call was accepted" has two possible causes — the parameter is
// registered, or this tool accepts anything.
// ---------------------------------------------------------------------------
test('OBJ3 (control): over the wire, board_query REJECTS an unknown parameter name in-band — so acceptance below is evidence of REGISTRATION (AC9, decision b47889b7)', async () => {
  const { client, cleanup } = await wireHarness();
  try {
    const bogus = await client.callTool({
      name: 'board_query',
      arguments: { source: 'user', objectve: 'Animation pass' }, // deliberate typo
    });
    assert.equal(bogus.isError, true, 'a misspelt parameter is REJECTED, never silently stripped');
    const text = (bogus.content as { text: string }[])[0].text;
    assert.match(text, /unrecognized_keys/, 'the refusal is a schema validation error, not tool logic');
    assert.match(text, /objectve/, 'and it NAMES the offending key so the caller can self-correct');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// OBJ3 — the WIRE registration. This is the arm that pins reachability: an
// unregistered parameter is refused by the SDK BEFORE the handler runs, so a
// perfect boardFiltered clause is still unreachable from every real caller.
// No in-process arm can observe this.
// ---------------------------------------------------------------------------
test('OBJ3: board_query({objective}) is REGISTERED in the server inputSchema — the wire call is accepted and returns exactly that objective (decision a8d2ce6c)', async () => {
  const { client, tools, cleanup } = await wireHarness();
  try {
    seed(tools); // seeded in-process; only the QUERY goes over the wire

    const result = await client.callTool({
      name: 'board_query',
      arguments: { source: 'user', objective: 'Animation pass' },
    });
    assert.notEqual(
      result.isError,
      true,
      '`objective` must be a DECLARED board_query parameter — an unregistered one is refused here and the filter is unreachable from any caller'
    );

    // board_query answers with the AC12 envelope, not a bare array.
    const env = payload(result) as { records: Loose[] };
    assert.ok(Array.isArray(env.records), 'board_query returns the {matched_filter, returned, cap, capped, records} envelope (AC12)');
    assert.deepEqual(
      texts(env.records),
      ['retime the walk cycle', 'wire the shader blend'],
      'the filter reaches the store end-to-end across the MCP boundary — exactly the objective asked for'
    );
  } finally {
    await cleanup();
  }
});
