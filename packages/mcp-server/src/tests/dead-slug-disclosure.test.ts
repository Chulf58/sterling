// ---------------------------------------------------------------------------
// Spec for DEAD-SLUG DISCLOSURE on knowledge_get (board
// 2b9f2f1a-15ac-4195-9651-8837c1c39558, part 3, user-decided 'supersede +
// disclose').
//
// TODAY: a slug carried only by superseded record(s) — no LIVE record still
// carries it — makes knowledge_get(slug) throw the ordinary
// unresolved-identifier refusal, exactly as if the slug had never existed.
// This is wrong: the slug WAS real, it points into a real lineage, and the
// reader deserves the standard supersession-terminus disclosure
// (terminus-disclosure.test.ts / decision de1a7329: ids and — per this
// slice — dead slugs stay version-pinned to the record they actually name;
// they are never silently redirected to the live head) rather than a bare
// "no such thing" refusal.
//
// THE FIX (spec, not implementation): when a slug's live carrier lookup
// finds nothing, knowledge_get falls through to the NEWEST superseded
// record that still carries that slug in its own (immutable) body, returns
// it version-pinned (own id, own fields, status 'superseded'), and adds the
// existing `terminus` field (see terminus-disclosure.test.ts) pointing at
// the true chain end. This fallthrough is knowledge_get-ONLY: the write
// tools (knowledge_update / knowledge_append / knowledge_edit /
// knowledge_retire) keep refusing a dead-slug address exactly as they do
// today, because a dead slug is not a write handle — fix-forward addresses
// the live head.
//
// Harness conventions (mkdtempSync + SterlingStore + SterlingTools + fixed
// clock, node:test + node:assert/strict), the `get()`/`escapeRegex()`
// idioms, and the fixture shapes below were read from
// terminus-disclosure.test.ts, knowledge-supersede.test.ts, and
// id-resolution.test.ts — no implementation source (tools.ts,
// store/src/index.ts) was read. `knowledge_supersede` already exists and is
// used here only to ARRANGE fixtures (dead slugs), per the dispatch note.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE:
//   - Every "dead slug resolves" assertion below (tests 2 and 3) fails on
//     the THROWN unresolved-identifier error itself — the call
//     `tools.knowledgeGet(deadSlug)` throws today, so execution never
//     reaches the `assert.equal`/`assert.ok` lines that check `.status`,
//     `.id`, or `.terminus`. Where the assertion is wrapped in
//     `assert.doesNotThrow`, THAT is what reports red (a thrown error where
//     none is expected).
//   - Tests 1, 4, 5 (write-tool refusals) and 6 are REGRESSION CONTROLS —
//     they pin behavior that is already true today and must stay true after
//     the fix. They are not expected to be red; they exist so a fix that
//     over-reaches (e.g. making knowledge_update also follow dead slugs, or
//     making knowledge_get redirect instead of pin) is caught.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dead-slug-'));
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

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function mkDecision(tools: SterlingTools, title: string, statement: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

// knowledge_supersede is used only to ARRANGE dead-slug fixtures. It already
// exists on SterlingTools (29 passing specs per the dispatch note), so it is
// called directly and typed — no cast needed, unlike the file that first
// specified it blind.
function terminusOf(record: Loose): { id: string; status: string; hops?: number } | undefined {
  return record.terminus as { id: string; status: string; hops?: number } | undefined;
}

// ===========================================================================
// 1 — Baseline unchanged: a slug carried by a LIVE record resolves to that
//     live head (existing behavior, pinned so this fix cannot regress it).
// ===========================================================================

test('baseline (regression control): knowledge_get on a slug carried by a LIVE record resolves to that live head', () => {
  const { tools, cleanup } = harness();
  try {
    const rec = mkDecision(tools, 'Baseline live slug decision', 'live body.');
    const slug = rec.slug as string;
    assert.ok(slug, 'precondition: the decision auto-minted a slug from its title');

    const resolved = get(tools, slug);
    assert.equal(resolved.id, rec.id, 'the slug resolves to the live record carrying it');
    assert.equal(resolved.status, 'active');
    assert.ok(!('terminus' in resolved), 'a live record served by slug carries no terminus field (parity with terminus-disclosure AC6)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 2 — Dead-slug fallthrough: a slug carried only by a superseded record
//     resolves to that retired record, version-pinned, with a terminus
//     disclosure pointing at the live replacement.
// ===========================================================================

test('dead-slug fallthrough: knowledge_get(deadSlug) does NOT throw, and returns the retired record version-pinned with terminus disclosure', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Dead slug origin decision', 'original statement body.');
    const oldSlug = old.slug as string;
    assert.ok(oldSlug, 'precondition: origin auto-minted a slug');

    tools.knowledgeSupersede(old.id as string, {
      title: 'Dead slug replacement decision',
      statement: 'replacement statement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'dead-slug-replacement-slug',
    });

    const pinnedOld = get(tools, old.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'precondition: supersede left the origin superseded');
    const newId = pinnedOld.superseded_by as string;
    assert.ok(newId, 'precondition: origin forwards to the new record');
    assert.notEqual(get(tools, 'dead-slug-replacement-slug').id, old.id, 'precondition: the new explicit slug now belongs to the new record, not the old one');

    let byDeadSlug: Loose | undefined;
    assert.doesNotThrow(() => {
      byDeadSlug = get(tools, oldSlug);
    }, 'EXPECTED FAILURE (red): knowledge_get(oldSlug) throws the unresolved-identifier error TODAY — the old slug has no live carrier. Once the fallthrough exists, this call must not throw');

    assert.ok(byDeadSlug, 'sanity: the assignment above ran');
    assert.equal(byDeadSlug!.id, old.id, "resolves to the RETIRED record's OWN id — version-pinned, never redirected to the new record's id");
    assert.equal(byDeadSlug!.status, 'superseded');
    assert.equal(byDeadSlug!.statement, 'original statement body.', "the retired record's own body is served untouched");

    const terminus = terminusOf(byDeadSlug!);
    assert.ok(terminus, 'the dead-slug-served retired record carries the standard terminus disclosure');
    assert.equal(terminus!.id, newId, 'terminus points at the live replacement');
    assert.equal(terminus!.status, 'active');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 3 — Newest-carrier rule: several superseded rows in one lineage carrying
//     the same dead slug resolve to the NEWEST carrier, not the oldest.
// ===========================================================================

test('newest-carrier rule: a dead slug carried by several superseded rows in one lineage resolves to the NEWEST carrier', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'Newest carrier origin decision', 'v1 body.');
    const slug = a.slug as string;
    assert.ok(slug, 'precondition: origin auto-minted a slug');

    // test-repair 2026-08-22: knowledge_update mutates in place under
    // stable-identity-design-v2 (id stable) — a multi-row lineage of several
    // DISTINCT superseded ids sharing one dead slug can only be built via
    // real knowledge_supersede calls now (an update no longer mints the
    // rows). The newest-carrier rule assertion is unchanged. [stable-identity-design-v2]
    const b = tools.knowledgeSupersede(a.id as string, {
      title: 'Newest carrier origin decision v2',
      statement: 'v2 body.',
      alternatives_rejected: [],
      rationale: 'r2',
    }) as unknown as Loose;
    assert.equal(b.slug, slug, 'precondition: knowledge_supersede carries the slug forward when fields omit it (parity with knowledge_supersede AC9)');
    const c = tools.knowledgeSupersede(b.id as string, {
      title: 'Newest carrier origin decision v3',
      statement: 'v3 body.',
      alternatives_rejected: [],
      rationale: 'r2',
    }) as unknown as Loose;
    assert.equal(c.slug, slug, 'precondition: the second supersede also carries the slug forward');

    tools.knowledgeSupersede(c.id as string, {
      title: 'Newest carrier replacement decision',
      statement: 'v4 replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'newest-carrier-replacement-slug',
    });

    assert.equal(get(tools, a.id as string).status, 'superseded', 'precondition: a is superseded');
    assert.equal(get(tools, b.id as string).status, 'superseded', 'precondition: b is superseded');
    const pinnedC = get(tools, c.id as string);
    assert.equal(pinnedC.status, 'superseded', 'precondition: c is superseded');
    const newId = pinnedC.superseded_by as string;
    assert.ok(newId, 'precondition: c forwards to the new record');

    let byDeadSlug: Loose | undefined;
    assert.doesNotThrow(() => {
      byDeadSlug = get(tools, slug);
    }, 'EXPECTED FAILURE (red): knowledge_get(slug) throws the unresolved-identifier error TODAY. Once the fallthrough exists, this call must not throw');

    assert.ok(byDeadSlug, 'sanity: the assignment above ran');
    assert.equal(byDeadSlug!.id, c.id, 'the NEWEST superseded carrier (c) is served');
    assert.notEqual(byDeadSlug!.id, a.id, 'must not serve the oldest carrier (a)');
    assert.notEqual(byDeadSlug!.id, b.id, 'must not serve the middle carrier (b)');

    const terminus = terminusOf(byDeadSlug!);
    assert.ok(terminus, 'the newest-carrier record still carries the terminus disclosure');
    assert.equal(terminus!.id, newId, 'terminus points at the true live replacement, even served from the newest dead-slug carrier');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 4 — Unknown slug: a slug no record has ever carried still errors exactly
//     as today (regression control on the refusal path).
// ===========================================================================

test('unknown slug (regression control): a slug no record has ever carried still errors exactly as today, naming it verbatim', () => {
  const { tools, cleanup } = harness();
  try {
    const neverCarried = 'zzz-never-carried-by-any-record-ffff';
    assert.throws(
      () => get(tools, neverCarried),
      new RegExp(escapeRegex(neverCarried)),
      'a genuinely unknown identifier must keep refusing, naming it as given — the dead-slug fallthrough must not turn "never existed" into a false resolution'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 5 — Read-only scope: the WRITE surface is unchanged. A dead slug is not a
//     write handle for knowledge_update / knowledge_append / knowledge_edit
//     / knowledge_retire — they refuse/fail to resolve exactly as today.
// ===========================================================================

test('read-only scope: knowledge_update addressed by a dead slug still refuses/fails to resolve exactly as today', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Write-refusal update origin decision', 'original body.');
    const oldSlug = old.slug as string;
    tools.knowledgeSupersede(old.id as string, {
      title: 'Write-refusal update replacement decision',
      statement: 'replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'write-refusal-update-replacement-slug',
    });
    assert.equal(get(tools, old.id as string).status, 'superseded', 'precondition: the old slug now has no live carrier');

    assert.throws(
      () => tools.knowledgeUpdate(oldSlug, { rationale: 'should never land' }),
      new RegExp(escapeRegex(oldSlug)),
      'knowledge_update must still refuse a dead-slug address exactly as it does today — the dead-slug fallthrough is knowledge_get-only; fix-forward addresses the live head'
    );
    assert.notEqual(get(tools, old.id as string).rationale, 'should never land', 'nothing written by the refused update');
  } finally {
    cleanup();
  }
});

test('read-only scope: knowledge_append addressed by a dead slug still refuses/fails to resolve exactly as today', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Write-refusal append origin decision', 'original body.');
    const oldSlug = old.slug as string;
    tools.knowledgeSupersede(old.id as string, {
      title: 'Write-refusal append replacement decision',
      statement: 'replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'write-refusal-append-replacement-slug',
    });
    assert.equal(get(tools, old.id as string).status, 'superseded', 'precondition: the old slug now has no live carrier');

    assert.throws(
      () => tools.knowledgeAppend(oldSlug, 'alternatives_rejected', [{ option: 'x', reason: 'y' }]),
      new RegExp(escapeRegex(oldSlug)),
      'knowledge_append must still refuse a dead-slug address exactly as it does today'
    );
    const untouched = get(tools, old.id as string);
    assert.deepEqual(untouched.alternatives_rejected, [], 'nothing appended by the refused call');
  } finally {
    cleanup();
  }
});

test('read-only scope: knowledge_edit addressed by a dead slug still refuses/fails to resolve exactly as today', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Write-refusal edit origin decision', 'MARKER_TO_EDIT lives here.');
    const oldSlug = old.slug as string;
    tools.knowledgeSupersede(old.id as string, {
      title: 'Write-refusal edit replacement decision',
      statement: 'replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'write-refusal-edit-replacement-slug',
    });
    assert.equal(get(tools, old.id as string).status, 'superseded', 'precondition: the old slug now has no live carrier');

    assert.throws(
      () => tools.knowledgeEdit(oldSlug, 'statement', 'MARKER_TO_EDIT', 'EDITED_MARKER'),
      new RegExp(escapeRegex(oldSlug)),
      'knowledge_edit must still refuse a dead-slug address exactly as it does today'
    );
    const untouched = get(tools, old.id as string);
    assert.equal(untouched.statement, 'MARKER_TO_EDIT lives here.', 'nothing edited by the refused call');
  } finally {
    cleanup();
  }
});

test('read-only scope: knowledge_retire addressed by a dead slug still refuses/fails to resolve exactly as today', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Write-refusal retire origin decision', 'original body.');
    const oldSlug = old.slug as string;
    const survivor = mkDecision(tools, 'Write-refusal retire survivor decision', 'survivor body.');
    tools.knowledgeSupersede(old.id as string, {
      title: 'Write-refusal retire replacement decision',
      statement: 'replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
      slug: 'write-refusal-retire-replacement-slug',
    });
    assert.equal(get(tools, old.id as string).status, 'superseded', 'precondition: the old slug now has no live carrier');

    assert.throws(
      () => tools.knowledgeRetire(oldSlug, survivor.id as string),
      new RegExp(escapeRegex(oldSlug)),
      'knowledge_retire must still refuse a dead-slug address exactly as it does today'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 6 — 8-char-prefix and full-uuid resolution of the retired record's own id
//     are untouched by this change (already covered elsewhere; cheap
//     regression pin added here since a dead-slug fix easily touches shared
//     resolution code).
// ===========================================================================

test('regression control: 8-char prefix and full uuid still resolve the retired record\'s own id after a supersede', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Prefix uuid regression origin decision', 'original body.');
    tools.knowledgeSupersede(old.id as string, {
      title: 'Prefix uuid regression replacement decision',
      statement: 'replacement body.',
      alternatives_rejected: [],
      rationale: 'r2',
    });

    const byUuid = get(tools, old.id as string);
    assert.equal(byUuid.id, old.id, 'full uuid still resolves to the retired record');

    const byPrefix = get(tools, (old.id as string).slice(0, 8));
    assert.equal(byPrefix.id, old.id, "the retired record's own 8-char id prefix still resolves to it");
  } finally {
    cleanup();
  }
});
