// ---------------------------------------------------------------------------
// Cited-id resolution warnings on write (board fc053051 — the phantom-id
// propagation defect).
//
// The observed failure: a fabricated decision id was cited by three different
// agents across three sessions because nothing verifies that record ids
// quoted INSIDE record/board text resolve — and the anti_pattern warning
// ABOUT the fabrication itself quoted the phantom id in its own trigger text,
// making the warning the vector that kept propagating it.
//
// Behavioral spec under test (NOT YET IMPLEMENTED — written red-first, blind
// to tools.ts): on knowledge_create / knowledge_update / knowledge_append /
// knowledge_edit / board_add, the server scans the written text content for
// id-shaped citations — full uuids and 8-plus-hex-char prefixes adjacent to
// the word `knowledge_get` or a record-type word (the convention already
// used throughout this store's own prose, e.g. "(knowledge_get 19b506ce-…)"
// and "decision de1a7329") — and for each citation that does NOT resolve to
// any record (ANY status; a superseded tombstone counts as resolving), the
// write still SUCCEEDS but its echo's `warnings` array carries a warning
// naming that unresolved citation. This file exercises knowledge_create and
// board_add, per the assigned ACs.
//
// TODAY, before this ships: knowledge_create/board_add's `warnings` channel
// already exists (decision 9c8e4601 — every write tool's echo carries
// warnings/check_skipped/…) but nothing populates it from cited-id scanning,
// so it is unconditionally `[]` regardless of what the written text
// contains. Every test below pairs a citation that MUST resolve with one
// that must NOT, so each test's "exactly one warning" assertion is false
// today (actual 0, expected 1) — a genuine assertion failure, not a crash,
// naming the exact line that fails in each test's comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

type Loose = Record<string, unknown>;
type WriteEcho = { record: Loose; warnings: string[] };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cited-id-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, cleanup };
}

// Every write tool's echo already carries a `warnings` array today (decision
// 9c8e4601) — the cast is only because the citation-scanning feature under
// test has not yet updated the declared return type with new content.
function asEcho(x: unknown): WriteEcho {
  return x as WriteEcho;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mkDecision(tools: SterlingTools, title: string, statement = 's'): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
  }).record as unknown as Loose;
}

test('AC1 & AC2: knowledge_create draws no warning citing a real record\'s full uuid, but warns exactly once for a fabricated one', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision', 'the seed statement');
    const fake = randomUUID();

    // AC1: a citation to a real, existing record's full uuid — no warning.
    // (Currently trivially true, since nothing warns on anything yet — the
    // point of this half is to pin the NO-FALSE-POSITIVE boundary once AC2
    // ships, not to be independently red.)
    const resolvable = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites the real one',
        statement: `Builds directly on (knowledge_get ${seed.id}).`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.deepEqual(resolvable.warnings, [], 'a citation that resolves draws no citation warning');

    // AC2: a citation to a well-formed but fabricated uuid — the write
    // lands, but the echo warns exactly once, naming the fabricated id.
    // EXPECTED FAILURE TODAY: this assert.equal fires — actual 0, expected 1,
    // because no citation scanning exists yet.
    const unresolved = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites a phantom',
        statement: `Cites a fabricated ruling (knowledge_get ${fake}) as though it were settled.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(unresolved.warnings.length, 1, 'exactly one warning for the one unresolved citation');
    assert.match(
      unresolved.warnings[0],
      new RegExp(escapeRegex(fake)),
      'the warning names the fabricated id verbatim, not a generic "citation" notice'
    );
  } finally {
    cleanup();
  }
});

test("AC3: citing a SUPERSEDED record's id resolves (tombstones are legitimate citations, decision de1a7329) — contrasted against a fabricated sibling citation in the same write", () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkDecision(tools, 'to be superseded', 'v1 statement');
    tools.knowledgeUpdate(v1.id as string, { rationale: 'updated rationale — this supersedes v1' });
    // sanity: v1 really is a tombstone now, not merely renamed
    assert.equal((tools.knowledgeGet(v1.id as string) as unknown as Loose).status, 'superseded', 'precondition: v1 is now a tombstone');

    const fake = randomUUID();
    // EXPECTED FAILURE TODAY: assert.equal below fires — actual 0, expected 1
    // (no scanning exists yet, so neither citation is evaluated).
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites the tombstone and a phantom',
        statement: `The prior ruling (knowledge_get ${v1.id}) still holds; (knowledge_get ${fake}) does not exist.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one unresolved citation — the superseded id resolved, the fabricated one did not');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fake)), 'the single warning names the fabricated id');
    assert.ok(
      !res.warnings.some((w) => w.includes(v1.id as string)),
      'the superseded (but real) id is never reported as unresolved'
    );
  } finally {
    cleanup();
  }
});

test('AC4: board_add citing a fabricated uuid carries the same warning behavior on the board surface, contrasted with one that resolves', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision (board case)', 'the seed statement');
    const fake = randomUUID();

    // EXPECTED FAILURE TODAY: assert.equal below fires — actual 0, expected 1
    // (board_add's warnings channel exists but nothing populates it from
    // cited-id scanning yet).
    const res = asEcho(
      tools.boardAdd({
        text: `Investigate per (knowledge_get ${seed.id}); the other reference (knowledge_get ${fake}) does not resolve.`,
        source: 'user',
        objective: 'standalone',
      })
    );
    assert.equal(res.warnings.length, 1, 'the board surface warns exactly once, for the one unresolved citation');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id verbatim');
    assert.ok(
      !res.warnings.some((w) => w.includes(seed.id as string)),
      'the real, resolving citation is never reported as unresolved'
    );
  } finally {
    cleanup();
  }
});

test('AC5 (never a gate): a write carrying an unresolved citation still succeeds — the warning is advisory, not a refusal', () => {
  const { tools, cleanup } = harness();
  try {
    const fake = randomUUID();
    const created = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'phantom citation, advisory only',
        statement: `Cites a phantom (knowledge_get ${fake}) yet must still land as a record.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );

    // EXPECTED FAILURE TODAY: this assert.equal fires — actual 0, expected 1.
    assert.equal(created.warnings.length, 1, 'the unresolved citation is flagged');

    // The point of AC5: the flag never blocked the write. This half already
    // holds today (there is no gate to trip), and must keep holding once the
    // scan ships — it is asserted here so a future "upgrade the warning into
    // a refusal" change is caught by this suite.
    assert.ok(created.record.id, 'the record was actually created and has an id');
    const stored = tools.knowledgeGet(created.record.id as string) as unknown as Loose;
    assert.equal(stored.status, 'active', 'the record exists and is active — the warning never blocked the write');
    assert.equal(
      tools.knowledgeQuery({ types: ['decision'] }).some((r) => (r as unknown as Loose).id === created.record.id),
      true,
      'and it is retrievable through the ordinary query surface, not just by direct id'
    );
  } finally {
    cleanup();
  }
});

test('AC6: an 8-char prefix matching an existing id resolves (no warning), but an 8-char hex string matching nothing warns', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a decision addressable by prefix', 'the seed statement');
    const prefix = (seed.id as string).slice(0, 8);
    const unresolvedPrefix = 'deadbeef'; // well-formed 8-hex-char string, matches no seeded record

    // EXPECTED FAILURE TODAY: this assert.equal fires — actual 0, expected 1
    // (prefix-form citations are not scanned at all yet).
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites by prefix, real and phantom',
        statement: `Follows decision ${prefix} for the settled half; decision ${unresolvedPrefix} does not exist.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one unresolved citation — the real prefix resolved, the phantom one did not');
    assert.match(res.warnings[0], new RegExp(unresolvedPrefix), 'the warning names the unresolved prefix verbatim');
    assert.ok(
      !res.warnings.some((w) => w.includes(prefix)),
      'the prefix that matches a real record is never reported as unresolved'
    );
  } finally {
    cleanup();
  }
});
