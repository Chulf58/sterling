// ---------------------------------------------------------------------------
// Frozen spec pins — citedIdWarnings: AMBIGUOUS 8-char prefixes and
// origin-ids EXEMPT regions (extends packages/mcp-server/src/tests/
// cited-id-warnings.test.ts, which pins the base resolve/warn contract on
// knowledge_create/board_add/knowledge_update/knowledge_append/knowledge_edit
// but does not cover prefix ambiguity, historical aliases, or [origin-ids]
// exemption).
//
// SPEC SOURCE: the dispatched work-order spec (four numbered rules — ambiguous
// prefix resolution, origin-ids exempt regions with fail-safe on imbalance,
// never-throw/never-refuse, full-uuid regression), cross-checked against the
// store rather than taken on faith:
//   - board c3705a15 ("PROSE CITATION RESOLUTION"): names exactly this
//     remaining slice — "the WRITE-TIME prose-citation warning arm — scan at
//     knowledge_create/update/append/edit and emit unresolved/ambiguous
//     citations as a receipt WARNING, never a refusal" — and confirms
//     knowledge_supersede is a write path worth surfacing.
//   - decision c6985ed4 (sibling static-scan arm, check-record-citations.mjs):
//     "An 8-char prefix matching more than one record fails as
//     citation_ambiguous ('cite more of the id')" — the source of the exact
//     ambiguous-prefix instructional phrasing pinned below.
//   - feature_article knowledge-export-script: documents the SAME
//     `[origin-ids: <reason>] ... [/origin-ids]` marker convention
//     (per-field balance-checked, fail loud on unclosed markers there) and
//     explicitly states "the write-time prose-citation warning arm (same
//     design) is a LATER slice" — i.e. this file. The write-time arm's own
//     fail-safe direction (never refuses; an unbalanced marker instead
//     leaves the enclosed ids IN SCOPE to warn) is per the dispatched spec.
//
// Harness/fixture conventions copied from sibling test files — no
// implementation source (tools.ts, store/src/index.ts) was read (H4):
//   - cited-id-warnings.test.ts: harness shape, asEcho/escapeRegex, the
//     "(knowledge_get <id>)" and bare "decision <id>" trigger-word citation
//     forms, the warn-never-refuse assertion shape.
//   - id-resolution.test.ts: seedPrefixTwin's store.create() forced-id
//     convention for constructing a genuine 8-char prefix collision (ids are
//     server-minted, so a collision cannot be produced through the public
//     create tool alone).
//   - stable-identity-tools.test.ts: rawInsertAlias's direct record_aliases
//     insert, for constructing a prefix collision against a historical alias
//     rather than a second live record.
//   - knowledge-supersede-hardening.test.ts (F3-citations): confirms
//     knowledge_supersede's response carries the same {record, warnings}
//     envelope as the other write tools, warnings always present (empty
//     array when nothing cited).
//
// EXPECTED RESULT: per the dispatch, this behavior is ALREADY SHIPPED —
// every test below is expected to PASS against current code. A failure is a
// genuine spec/implementation divergence, not an expected-red pin; each
// test's comment states what a failure would mean.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-25T12:00:00.000Z';

type Loose = Record<string, unknown>;
type WriteEcho = { record: Loose; warnings: string[] };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cited-id-ambig-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

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

interface SupersedeCapable {
  knowledgeSupersede(old_id: string, fields: Loose): unknown;
}
function supersede(tools: SterlingTools, old_id: string, fields: Loose): WriteEcho {
  return asEcho((tools as unknown as SupersedeCapable).knowledgeSupersede(old_id, fields));
}

// Forces a second LIVE record whose id shares `primaryId`'s first 8 chars —
// the same convention id-resolution.test.ts uses for its own ambiguity
// tests (ids are server-minted, so a collision cannot be produced through
// the public create tool alone).
function seedPrefixTwin(store: SterlingStore, tools: SterlingTools, primaryId: string): string {
  const prefix = primaryId.slice(0, 8);
  const seed = mkDecision(tools, 'ambiguity twin seed');
  store.create({
    ...(JSON.parse(JSON.stringify(seed)) as Loose),
    id: `${prefix}-0000-4000-8000-000000000000`,
  });
  return prefix;
}

// Direct record_aliases insert — the same pattern stable-identity-tools.test.ts
// uses to construct a historical-alias row without going through a real
// supersession (which would mint a fresh, unpredictable canonical id).
function rawInsertAlias(store: SterlingStore, historicalId: string, canonicalId: string, archivedVersion: number, createdAt: string): void {
  const s = store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } };
  s.db
    .prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historicalId, canonicalId, archivedVersion, createdAt);
}

// ===========================================================================
// RULE 1 — ambiguous 8-char prefix resolution (zero / exactly-one / many)
// ===========================================================================

test('AMBIG-ONE-RECORD (control): an 8-hex-char prefix matching exactly ONE live record id resolves silently — control for the ambiguous-many tests below, proving the scan actually counts matches rather than blanket-warning any bare prefix', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'unambiguous prefix target');
    const prefix = (seed.id as string).slice(0, 8);
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites an unambiguous live prefix',
        statement: `Follows decision ${prefix} for the settled half.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.deepEqual(res.warnings, [], 'exactly one match by prefix resolves — no warning');
  } finally {
    cleanup();
  }
});

test('AMBIG-ONE-ALIAS (control): an 8-hex-char prefix matching exactly ONE historical alias, with NO live record sharing it, also resolves silently — aliases count toward resolution, not only live records', () => {
  const { store, tools, cleanup } = harness();
  try {
    const canonical = mkDecision(tools, 'alias canonical target');
    const aliasPrefix = 'a1a1a1a1';
    const historicalId = `${aliasPrefix}-0000-4000-8000-000000000000`;
    rawInsertAlias(store, historicalId, canonical.id as string, 1, NOW);

    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites an alias-only prefix',
        statement: `Per decision ${aliasPrefix} this still holds.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    // EXPECTED FAILURE if aliases are never consulted: this prefix would be
    // reported as matching ZERO records (a false "does not resolve" warning)
    // even though it legitimately resolves via record_aliases.
    assert.deepEqual(res.warnings, [], 'a prefix resolving to exactly one alias (no live record) draws no citation warning');
  } finally {
    cleanup();
  }
});

test('AMBIG-MANY-RECORDS: an 8-hex-char prefix matching TWO live record ids warns "ambiguous" and tells the caller to cite more of the id', () => {
  const { store, tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'ambiguity primary (records)');
    const prefix = seedPrefixTwin(store, tools, seed.id as string);

    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites an ambiguous prefix (two records)',
        statement: `Per decision ${prefix} this holds.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one warning for the one ambiguous citation');
    assert.match(res.warnings[0], new RegExp(escapeRegex(prefix)), 'the warning names the cited prefix verbatim');
    assert.match(res.warnings[0], /ambiguous/i, 'the warning states the prefix is ambiguous, not merely unresolved');
    assert.match(
      res.warnings[0],
      /(cite|specify|provide|include|use) more|more of the id|more characters|full id|longer (prefix|id)/i,
      'the warning instructs the caller to cite more of the id (decision c6985ed4\'s "cite more of the id" phrasing for the sibling static-scan arm)'
    );
  } finally {
    cleanup();
  }
});

test('AMBIG-MANY-ALIAS: an 8-hex-char prefix matching ONE live record AND a SEPARATE historical alias (different underlying canonical record) is ALSO ambiguous — aliases count toward the collision, not only toward resolution', () => {
  const { store, tools, cleanup } = harness();
  try {
    const liveSeed = mkDecision(tools, 'ambiguity live half');
    const prefix = (liveSeed.id as string).slice(0, 8);
    const otherCanonical = mkDecision(tools, 'ambiguity alias half canonical');
    const historicalId = `${prefix}-0000-4000-8000-000000000000`;
    rawInsertAlias(store, historicalId, otherCanonical.id as string, 1, NOW);

    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites a live+alias ambiguous prefix',
        statement: `Per decision ${prefix} this holds.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    // EXPECTED FAILURE if the ambiguity check only counts live record ids:
    // this would be treated as EXACTLY ONE match (the live record) and
    // resolve silently, warnings.length === 0.
    assert.equal(res.warnings.length, 1, 'exactly one warning — the live id plus the separate alias together make the prefix ambiguous');
    assert.match(res.warnings[0], new RegExp(escapeRegex(prefix)), 'the warning names the cited prefix verbatim');
    assert.match(res.warnings[0], /ambiguous/i, 'the warning states the prefix is ambiguous');
  } finally {
    cleanup();
  }
});

test('AMBIG-ZERO: a bare 8-hex-char citation matching ZERO record ids and ZERO aliases warns that it "does not resolve" — distinct wording from the ambiguous-prefix warning', () => {
  const { tools, cleanup } = harness();
  try {
    const zeroMatch = 'deadbeef'; // well-formed 8-hex-char string, matches nothing seeded in this fresh store
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites a prefix matching nothing',
        statement: `Per decision ${zeroMatch} this holds.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one warning for the zero-match prefix');
    assert.match(res.warnings[0], new RegExp(escapeRegex(zeroMatch)), 'the warning names the cited prefix verbatim');
    assert.match(res.warnings[0], /does not resolve/i, 'zero-match prefix warning uses "does not resolve" phrasing per spec');
    assert.ok(!/ambiguous/i.test(res.warnings[0]), 'the zero-match warning is worded distinctly from the ambiguous-prefix warning — they are different failure modes');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RULE 4 — full-uuid regression guard (pre-existing behavior must survive)
// ===========================================================================

test('REGRESSION-FULL-UUID: a full dashed uuid that exists resolves silently; a full dashed uuid that does not exist warns — the pre-existing full-uuid behavior is unchanged by adding prefix-ambiguity/exemption handling', () => {
  const { tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'a real decision cited by full uuid');
    const fakeUuid = randomUUID();
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'cites a real full uuid and a fake one',
        statement: `The real one (knowledge_get ${seed.id}) holds; the fake one (knowledge_get ${fakeUuid}) does not.`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one warning — only the fabricated full uuid is unresolved');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fakeUuid)), 'the warning names the fabricated full uuid');
    assert.ok(
      !res.warnings.some((w) => w.includes(seed.id as string)),
      'the real, existing full uuid is never reported as unresolved'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RULE 2 — [origin-ids: <reason>] ... [/origin-ids] exempt regions
// ===========================================================================

test('ORIGIN-EXEMPT-BALANCED: a fabricated id INSIDE a balanced [origin-ids: reason] ... [/origin-ids] region draws no warning; a DIFFERENT fabricated id OUTSIDE the region, in the same write, still warns (built-in control proving the scanner recognizes this exact citation shape at all)', () => {
  const { tools, cleanup } = harness();
  try {
    const insideFake = randomUUID();
    const outsideFake = randomUUID();
    const statement =
      `[origin-ids: imported from another machine, ids below are origin-only] ` +
      `Historical note cites (knowledge_get ${insideFake}) from the source machine. [/origin-ids] ` +
      `Separately this write also cites (knowledge_get ${outsideFake}) outside any exempt region.`;
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'origin-ids balanced exemption with an outside control citation',
        statement,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(res.warnings.length, 1, 'exactly one warning — the OUTSIDE citation warns, the INSIDE one does not');
    assert.match(res.warnings[0], new RegExp(escapeRegex(outsideFake)), 'the single warning names the OUTSIDE fabricated id');
    assert.ok(
      !res.warnings.some((w) => w.includes(insideFake)),
      'the fabricated id inside the balanced [origin-ids] region is never warned about'
    );
  } finally {
    cleanup();
  }
});

test('ORIGIN-UNBALANCED-OPEN: an [origin-ids: ...] marker with NO matching [/origin-ids] close anywhere in the text grants NO exemption — a fabricated id after the unmatched open still warns (fail-safe)', () => {
  const { tools, cleanup } = harness();
  try {
    const fake = randomUUID();
    const statement = `[origin-ids: imported, but the close marker is missing on purpose] this cites (knowledge_get ${fake}) after an unmatched open marker.`;
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'origin-ids unbalanced: open with no close',
        statement,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    // EXPECTED FAILURE if imbalance is fail-OPEN (grants exemption on any
    // open marker regardless of a matching close): warnings would be [].
    assert.equal(res.warnings.length, 1, 'the fabricated id after an unbalanced (open-only) marker still warns');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id');
  } finally {
    cleanup();
  }
});

test('ORIGIN-UNBALANCED-EXTRA-CLOSE: an extra/orphan [/origin-ids] close (1 open, 2 closes — the region LOOKS well-nested and locally matched) still counts as an UNEQUAL total and grants no exemption (fail-safe against naive sequential-pairing, distinct from the open-only case above)', () => {
  const { tools, cleanup } = harness();
  try {
    const fake = randomUUID();
    const statement =
      `[origin-ids: single region, but an orphan close follows later] cites (knowledge_get ${fake}) inside the region. ` +
      `[/origin-ids] [/origin-ids]`;
    const res = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'origin-ids unbalanced: extra orphan close',
        statement,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    // EXPECTED FAILURE if the implementation pairs opens/closes sequentially
    // (first open with first close) instead of requiring equal TOTAL counts:
    // a naive pairer would treat the region as matched, exempt the fake id,
    // and silently ignore the orphan trailing close — warnings would be [].
    assert.equal(res.warnings.length, 1, 'unequal marker counts (1 open, 2 closes) void exemption even for the well-nested-looking region');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RULE 3 — never throws, never refuses
// ===========================================================================

test('NEVER-THROWS-MARKER-SOUP: pathological/malformed [origin-ids] marker soup (orphan close before any open, an open with no closing bracket at all) never throws — the write succeeds and a fabricated citation placed cleanly outside the mess still warns', () => {
  const { tools, cleanup } = harness();
  try {
    const fake = randomUUID();
    const statement =
      `Cites a fabricated ruling (knowledge_get ${fake}) right up front, before any markers. ` +
      `Then a mess follows: [/origin-ids][origin-ids: r][origin-ids: r2] some text [origin-ids: r3 unclosed forever and ever`;
    let res: WriteEcho | undefined;
    assert.doesNotThrow(() => {
      res = asEcho(
        tools.knowledgeCreate('decision', {
          title: 'pathological origin-ids marker soup',
          statement,
          alternatives_rejected: [],
          rationale: 'r',
        })
      );
    }, 'the citation scanner must never throw on malformed/unbalanced [origin-ids] marker soup');
    assert.ok(res, 'sanity: the write call returned normally');
    assert.ok((res as WriteEcho).record.id, 'the record was actually created despite the malformed marker soup');
    assert.equal((res as WriteEcho).warnings.length, 1, 'the cleanly-placed fabricated id (before any marker soup) still warns exactly once');
    assert.match((res as WriteEcho).warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id');
  } finally {
    cleanup();
  }
});

test('NEVER-A-GATE: a fabricated citation produces a warning but the write still succeeds and the record is fully usable afterward', () => {
  const { tools, cleanup } = harness();
  try {
    const fake = randomUUID();
    const created = asEcho(
      tools.knowledgeCreate('decision', {
        title: 'phantom citation still lands',
        statement: `Cites a phantom (knowledge_get ${fake}).`,
        alternatives_rejected: [],
        rationale: 'r',
      })
    );
    assert.equal(created.warnings.length, 1, 'the fabricated citation is flagged');
    assert.match(created.warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id');
    assert.ok(created.record.id, 'the record was actually created and has an id');
    const stored = (tools.knowledgeGet(created.record.id as string) as unknown) as Loose;
    assert.equal(stored.status, 'active', 'the write succeeded — the warning never blocked or gated it');
    assert.equal(
      tools.knowledgeQuery({ types: ['decision'] }).some((r) => (r as unknown as Loose).id === created.record.id),
      true,
      'and it is retrievable through the ordinary query surface, not just by direct id'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Write-surface coverage — knowledge_supersede is named alongside
// create/append/edit/update as a path citedIdWarnings must reach
// (board c3705a15).
// ===========================================================================

test('SURFACE-SUPERSEDE: knowledge_supersede scans the NEW record\'s written text for citations exactly like the other write tools — a fabricated id warns, the write still succeeds', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkDecision(tools, 'to be superseded, citation surface check');
    const fake = randomUUID();
    const res = supersede(tools, v1.id as string, {
      title: 'superseding v2 with a phantom citation',
      statement: `Cites a phantom (knowledge_get ${fake}) in the new version's statement.`,
      alternatives_rejected: [],
      rationale: 'updated rationale',
    });
    // EXPECTED FAILURE if citedIdWarnings is wired on create/append/edit/update
    // but knowledge_supersede's own new-record text was never routed through
    // it: warnings would be [] (or the key absent).
    assert.equal(res.warnings.length, 1, 'knowledge_supersede warns on a fabricated citation in the NEW record text, exactly like the other write tools');
    assert.match(res.warnings[0], new RegExp(escapeRegex(fake)), 'the warning names the fabricated id');
  } finally {
    cleanup();
  }
});
