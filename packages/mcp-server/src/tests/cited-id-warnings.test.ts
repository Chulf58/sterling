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

// ---------------------------------------------------------------------------
// Extension: the scan wired only on knowledge_create / board_add left the
// update/append/edit paths silent — and those are exactly the paths a
// long-lived article travels through most (appended history, edited prose),
// per the independent review that reopened this board. AC-U / AC-AP / AC-E
// below pin the same warn-but-never-block behavior on those three tools.
// Each pairs a citation that resolves with one that does not, and — per the
// brief — asserts on the PRESENCE/ABSENCE of a warning naming the specific
// cited id, never on warnings.length (knowledge_update in particular may
// legitimately carry unrelated warnings, e.g. history rotation, alongside a
// citation warning).
//
// AC-R (regression, not a new test): the five tests above this comment block
// must keep passing unmodified — nothing below touches them.
// ---------------------------------------------------------------------------

// Minimal feature_article fixture, mirroring the shape used throughout
// tools.test.ts's own append/edit coverage (array fields need a record type
// that declares them; decision does not).
function mkArticleFixture(tools: SterlingTools, slug: string, extraWhatItDoes = 'does the thing.'): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: extraWhatItDoes,
    intended_behavior: 'b',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

test('AC-U: knowledge_update warns when the NEW field text cites a fabricated uuid, not when it cites a real id (coexisting warnings ignored)', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision for update', 'seed statement');
    const target = mkDecision(tools, 'to be updated with a citation', 'v1 rationale');
    const fake = randomUUID();

    // Updating with text citing the REAL seed id: no citation warning naming
    // it. (Other warnings, if any, are irrelevant — asserted by content, not
    // by count, per the brief.)
    // Amended 2026-08-20: warnings ride the MCP envelope (knowledgeUpdateResult)
    // — knowledgeUpdate is the internal bare-record method dozens of frozen
    // assertions depend on, exactly as the real knowledge_update tool serves it.
    const resolved = tools.knowledgeUpdateResult(target.id as string, {
      rationale: `Builds directly on (knowledge_get ${seed.id}).`,
    });
    assert.ok(
      !resolved.warnings.some((w) => w.includes(seed.id as string)),
      'a citation that resolves in updated text draws no citation warning naming it'
    );

    // Updating again (the head id rotated with the first update, exactly as
    // knowledge_append's id rotates) with text citing a FABRICATED uuid.
    // EXPECTED FAILURE TODAY: this assert.ok fires — .some() finds nothing,
    // because knowledge_update's written text is not scanned for citations
    // at all yet, so no warning naming `fake` is ever produced.
    const unresolved = tools.knowledgeUpdateResult(resolved.record.id as string, {
      rationale: `Cites a fabricated ruling (knowledge_get ${fake}) as though it were settled.`,
    });
    assert.ok(
      unresolved.warnings.some((w) => new RegExp(escapeRegex(fake)).test(w)),
      'knowledge_update warns naming the fabricated id cited in the newly-written field text'
    );
  } finally {
    cleanup();
  }
});

test('AC-AP: knowledge_append warns when an appended history entry cites a fabricated uuid, not when it cites a real id', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision for append', 'seed statement');
    const fake = randomUUID();
    const article = mkArticleFixture(tools, 'cited-id-append-fixture');

    // Appending a history entry citing the REAL seed id: no citation warning
    // naming it.
    const resolved = asEcho(
      tools.knowledgeAppend(article.id as string, 'history', [
        { date: NOW, event: `References (knowledge_get ${seed.id}) as prior art.` },
      ])
    );
    assert.ok(
      !resolved.warnings.some((w) => w.includes(seed.id as string)),
      'a citation that resolves in an appended entry draws no citation warning naming it'
    );

    // Appending again (the id rotates with every append, per tools.test.ts's
    // own append coverage) with an entry citing a FABRICATED uuid.
    // EXPECTED FAILURE TODAY: this assert.ok fires — .some() finds nothing,
    // because knowledge_append's newly-appended entries are not scanned for
    // citations at all yet, so no warning naming `fake` is ever produced.
    const unresolved = asEcho(
      tools.knowledgeAppend(resolved.record.id as string, 'history', [
        { date: NOW, event: `Cites a fabricated ruling (knowledge_get ${fake}) as though it were settled.` },
      ])
    );
    assert.ok(
      unresolved.warnings.some((w) => new RegExp(escapeRegex(fake)).test(w)),
      'knowledge_append warns naming the fabricated id cited in the newly-appended entry'
    );
  } finally {
    cleanup();
  }
});

test('AC-E: knowledge_edit warns when the REPLACE text introduces a fabricated citation, not when it cites a real id — and never rescans a pre-existing citation elsewhere in the record', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision for edit', 'seed statement');
    const fake = randomUUID();
    // A phantom citation baked into the record BEFORE either edit below, in
    // text neither edit's `find`/`replace` ever touches. Scan scope: only
    // the written/changed text needs scanning, not the whole record — an
    // edit must not warn about a pre-existing stale citation elsewhere in
    // the record just because that record happens to get written again.
    const staleFake = randomUUID();
    const article = mkArticleFixture(
      tools,
      'cited-id-edit-fixture',
      `does the thing. ANCHOR_A here. Unrelated pre-existing note (knowledge_get ${staleFake}) untouched by either edit below.`
    );

    // Edit 1: replace text unrelated to the pre-existing stale citation,
    // introducing a citation to the REAL seed id. No citation warning
    // naming the seed id, and — the scope guarantee — no warning naming the
    // untouched pre-existing staleFake either.
    const resolvedEdit = asEcho(
      tools.knowledgeEdit(article.id as string, 'what_it_does', 'ANCHOR_A here', `follows (knowledge_get ${seed.id})`)
    );
    assert.ok(
      !resolvedEdit.warnings.some((w) => w.includes(seed.id as string)),
      'a citation that resolves in the replace text draws no citation warning naming it'
    );
    assert.ok(
      !resolvedEdit.warnings.some((w) => w.includes(staleFake)),
      'an edit never rescans untouched pre-existing text elsewhere in the record for citations'
    );

    // Edit 2 (on the id that rotated after edit 1, exactly as knowledge_edit's
    // own coverage in tools.test.ts does): replace text unrelated to the
    // stale citation, this time introducing a FABRICATED citation.
    // EXPECTED FAILURE TODAY: the first assert.ok below fires — .some() finds
    // nothing, because knowledge_edit's replace text is not scanned for
    // citations at all yet, so no warning naming `fake` is ever produced.
    const unresolvedEdit = asEcho(
      tools.knowledgeEdit(
        resolvedEdit.record.id as string,
        'what_it_does',
        'does the thing.',
        `does the thing, but cites a phantom (knowledge_get ${fake}).`
      )
    );
    assert.ok(
      unresolvedEdit.warnings.some((w) => new RegExp(escapeRegex(fake)).test(w)),
      'knowledge_edit warns naming the fabricated id introduced in the replace text'
    );
    assert.ok(
      !unresolvedEdit.warnings.some((w) => w.includes(staleFake)),
      'even on a second write, the pre-existing stale citation elsewhere in the record is still never scanned/warned'
    );
  } finally {
    cleanup();
  }
});

test('AC-S: fabricated citations spelled with backticks or a colon after the trigger word still warn; the same spellings citing a real id do not; a bare git sha with no trigger word nearby never warns', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real, citable decision for alt-spellings', 'seed statement');
    const seedPrefix = (seed.id as string).slice(0, 8);
    const fakeBacktick = 'deadbeef12345678'; // well-formed 16-hex-char fabricated id, backticked spelling: `decision `id`` `
    const fakeColon = 'deadbeef1234'; // well-formed 12-hex-char fabricated id, colon spelling: `decision: id`
    // 40-hex-char git sha, deliberately with NO trigger word (knowledge_get /
    // a record-type word) anywhere near it — the conservative-direction
    // boundary: this must never be treated as a citation.
    const bareSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

    // Two fabricated ids, in the two under-tested spellings, both warn.
    // EXPECTED FAILURE TODAY: the scanner (once it exists at all) only
    // targets the "(knowledge_get <id>)" parenthetical form described in the
    // file header — backtick and bare-colon spellings are not recognized,
    // so actual is 0 matching warnings, expected 2, and this assert.equal
    // fires.
    const fabricated = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites two phantom ids in the backtick and colon spellings',
        statement: `Per decision \`${fakeBacktick}\` this holds; also see decision: ${fakeColon} for context. Unrelated hex string mentioned in passing, ${bareSha}, ends the thought.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(
      fabricated.warnings.filter((w) => w.includes(fakeBacktick) || w.includes(fakeColon)).length,
      2,
      'both the backticked and colon-spelled fabricated citations are individually warned about'
    );
    assert.ok(
      fabricated.warnings.some((w) => new RegExp(escapeRegex(fakeBacktick)).test(w)),
      'the backticked spelling names the fabricated id verbatim'
    );
    assert.ok(
      fabricated.warnings.some((w) => new RegExp(escapeRegex(fakeColon)).test(w)),
      'the colon spelling names the fabricated id verbatim'
    );
    assert.ok(
      !fabricated.warnings.some((w) => w.includes(bareSha)),
      'a bare 40-char git sha with no trigger word nearby is never treated as a citation (conservative direction)'
    );

    // The same two spellings, this time citing the REAL seed's prefix, draw
    // no citation warning naming it.
    const resolved = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites the real prefix in the backtick and colon spellings',
        statement: `Per decision \`${seedPrefix}\` this holds; also see decision: ${seedPrefix} for context.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.ok(
      !resolved.warnings.some((w) => w.includes(seedPrefix)),
      'the same two spellings citing a real, resolving id draw no citation warning naming it'
    );
  } finally {
    cleanup();
  }
});
