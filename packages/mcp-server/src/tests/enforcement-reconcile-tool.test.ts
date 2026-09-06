// enforcement_reconcile — MCP tool surface pins.
//
// SPEC (per this task's dispatch brief — the underlying enforcement-taint
// module is deliberately NOT read to derive these expectations):
//   - a new MCP tool named `enforcement_reconcile` is served.
//   - input schema: strict({ adopt: z.boolean().default(false) }) — `adopt`
//     is the ONLY input.
//   - it returns { cleared, reason } verbatim from the underlying module.
//   - it is a FRONT DOOR onto the clearer, NOT an authority boundary — the
//     MCP server has no authenticated caller identity, so this tool must
//     never be exercised or described as though "only the conductor can
//     clear". That is exactly what ARM 3 pins: the served schema carries no
//     caller-identity key (no callerRole, no callerAgentId) for a caller to
//     even attempt to assert one through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSterlingServer } from '../server.js';

// FIX (defect 2, correctness review): server.ts derives `repoRoot` as
// `dirname(dirname(storePath))` (confirmed via KB todo b8639752, which
// documents this exact derivation and flags enforcement_reconcile as its
// first DESTRUCTIVE consumer). A store path of `join(dir, 'sterling.db')`
// (no intermediate directory) derives repoRoot as the SHARED OS temp
// directory, not this fixture — harmless today only because the no-latch
// VERIFY arm returns before any write, but a live hazard for any future
// adopt:true arm (which would mint/overwrite `<repoRoot>/.sterling/
// enforcement-baseline.json` outside the fixture, contaminating/depending on
// whatever else touches the shared temp dir). Nesting the store one level
// under a `.sterling/` directory INSIDE the fixture makes the derived
// repoRoot the fixture itself.
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-enforcement-reconcile-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const { server, store, tools } = createSterlingServer(join(dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, store, tools, cleanup };
}

function payload(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

// FIX (defect 1, correctness review): a plain /latch/i or /incident/i match
// cannot discriminate the no-latch verify arm from the identity-gate refusal
// family, because several identity-gate refusals ALSO say "the latch" (e.g.
// the shared "...refusing rather than degrading...; the latch is left in
// place" trailer documented for the platform-refusal family) — so a wrong
// hardcoded identity (concretely: `callerRole: 'conductor'` mistyped as
// `'Conductor'` at tools.ts:7093, or a non-empty callerAgentId threaded
// through) makes the tool refuse EVERY call, forever, on every project, while
// still satisfying a bare /latch/i test. These two families are copied
// VERBATIM from the established, already-mutation-verified REASON vocabulary
// contract in the sibling suite scripts/tests/enforcement-reconcile.test.mjs
// (its own header names this exact confusion as the reason `reason` is part
// of the contract at all — AC9: "carries reason wording unique to its
// family") — not from a guessed literal string, since I could not open the
// implementation file directly to confirm an exact quoted prefix.
const NO_LATCH_FAMILY = /\bno-?op\b|\bno latch\b|\bnothing to (do|clear)\b|latch (is )?absent|absent latch|no latch (is )?present/i;
const CALLER_GATE_FAMILY =
  /conductor|agent|authoriz|not permitted|callerRole|caller role|unidentified caller/i;
// WIN32 DOUBLE-CAUSE (flagged by review): per the same sibling suite's
// documented history (R4 CLOSED — "win32 now REFUSES before any I/O and
// leaves the latch present"), a native-Windows host refuses BEFORE checking
// whether a latch even exists, so the no-latch verify arm is UNREACHABLE on
// win32 — this call instead surfaces the platform-refusal family on that
// host. Branching on process.platform below keeps the pin honest about which
// arm each platform actually exercises, rather than loosening the assertion
// into an OR that could silently mask either arm breaking.
const PLATFORM_REFUSAL_FAMILY = /win(dows|32)|platform|unsupported/i;

test('ARM 1: enforcement_reconcile is served on the MCP tool surface', async () => {
  const { client, cleanup } = await harness();
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    // SABOTAGE: unregistering the tool (or renaming it away from
    // 'enforcement_reconcile' in the server's tool registration) makes this
    // go red — the name drops out of `names`.
    assert.ok(
      names.includes('enforcement_reconcile'),
      'enforcement_reconcile must be served alongside the rest of the tool surface'
    );
  } finally {
    await cleanup();
  }
});

test('ARM 2: no taint latch present — adopt:false is a no-op naming why, and omitting adopt entirely takes the same verify arm (default false)', async () => {
  const { client, cleanup } = await harness();
  try {
    // A fresh harness is a fresh store: no taint latch has ever been raised,
    // so this is the "nothing to discharge" case for both calls below.
    const explicit = payload(
      await client.callTool({ name: 'enforcement_reconcile', arguments: { adopt: false } })
    ) as { cleared: boolean; reason: string };
    assert.equal(explicit.cleared, false, 'no latch to discharge — adopt:false must not report a clear');

    // CONTROL: whichever family fires below, it must NEVER be the
    // identity-gate family — that would mean the wire never reached the
    // no-latch verify arm at all (e.g. the hardcoded caller identity is wrong
    // and the call is refused before the latch is even considered).
    assert.ok(
      !CALLER_GATE_FAMILY.test(explicit.reason),
      `no-latch verify must not be an identity-gate refusal in disguise (got: ${JSON.stringify(explicit.reason)})`
    );

    if (process.platform === 'win32') {
      assert.match(
        explicit.reason,
        PLATFORM_REFUSAL_FAMILY,
        `win32: the no-latch verify arm is unreachable — expected the platform-refusal family (got: ${JSON.stringify(explicit.reason)})`
      );
    } else {
      assert.match(
        explicit.reason,
        NO_LATCH_FAMILY,
        `reason must name the no-latch/nothing-to-clear family (got: ${JSON.stringify(explicit.reason)})`
      );
    }
    // SABOTAGE (concrete regression, correctness review 2026-09-06): change
    // `callerRole: 'conductor'` at tools.ts:7093 to `'Conductor'`, or thread a
    // non-empty callerAgentId — the tool then refuses EVERY call, forever, and
    // the CALLER_GATE_FAMILY assertion above goes red (it will match). A
    // simpler sabotage — making the no-latch path report cleared:true
    // unconditionally, or stripping its family wording — flips the
    // cleared/NO_LATCH_FAMILY assertions instead.

    // CONTROL: omitting `adopt` altogether must take the SAME verify arm as
    // an explicit adopt:false, because the schema default is false — asserted
    // by exact reason equality, not just by cleared:false again, so a handler
    // that branches differently on "omitted" vs "explicit false" cannot pass
    // vacuously (both could independently say cleared:false for different
    // reasons and this would still look green without the equality check).
    const omitted = payload(
      await client.callTool({ name: 'enforcement_reconcile', arguments: {} })
    ) as { cleared: boolean; reason: string };
    assert.equal(omitted.cleared, false, 'omitted adopt defaults to false — same verify arm as explicit adopt:false');
    assert.equal(
      omitted.reason,
      explicit.reason,
      'omitted adopt must produce the IDENTICAL reason as explicit adopt:false — proves the schema default, not a coincidence'
    );
    // SABOTAGE: changing the schema default from false to true (or handling
    // an omitted `adopt` differently from an explicit `adopt:false` in the
    // handler) makes the reason-equality assertion above go red.
  } finally {
    await cleanup();
  }
});

test("ARM 3: the served inputSchema carries no caller-identity keys — exactly ['adopt'], additionalProperties:false, no callerRole/callerAgentId", async () => {
  const { client, cleanup } = await harness();
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'enforcement_reconcile');
    assert.ok(tool, 'enforcement_reconcile is served');
    const inputSchema = tool!.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown };

    // CONTROL FIRST: `adopt` really is present in the served schema, so the
    // exact-key-set assertion below cannot pass vacuously against an
    // undefined/empty properties object (e.g. if listTools() ever served a
    // blank schema, the arm below would otherwise show a false EXACTLY-['adopt']
    // pass by both sides being empty).
    assert.ok(
      inputSchema.properties !== undefined && 'adopt' in inputSchema.properties,
      "CONTROL: 'adopt' is present in the served schema"
    );

    // ARM: the property key set is EXACTLY ['adopt'] — no callerRole, no
    // callerAgentId, no other caller-identity key smuggled onto the schema.
    // The tool is a front door with no authenticated caller identity to
    // check; it must never be shaped as though it enforces "only the
    // conductor can clear".
    //
    // SABOTAGE (named per the dispatch brief): add
    //   callerRole: z.string().optional()
    // to the tool's input schema definition. That one-line change must make
    // this assertion go red (the key set becomes ['adopt', 'callerRole']).
    assert.deepEqual(
      Object.keys(inputSchema.properties ?? {}).sort(),
      ['adopt'],
      'the served schema exposes exactly one caller-suppliable key: adopt — no caller-identity field'
    );
    assert.equal(
      inputSchema.additionalProperties,
      false,
      'the schema is strict — no additional properties admitted over the wire'
    );
    assert.ok(!('callerRole' in (inputSchema.properties ?? {})), 'no callerRole key on the served schema');
    assert.ok(!('callerAgentId' in (inputSchema.properties ?? {})), 'no callerAgentId key on the served schema');
  } finally {
    await cleanup();
  }
});
