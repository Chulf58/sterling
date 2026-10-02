// ---------------------------------------------------------------------------
// Spec: board c6e3561f-af44-4a9c-8465-b49bbc07fce5, PART (a) ONLY.
//   "a record overridden in ONE clause by a newer record carries an INBOUND
//    rel:'supersedes' link (newer record --supersedes--> old) but no status
//    change, so today the old record reads live-and-fresh with no hint...
//    Fix order: (a) surface INBOUND rel:'supersedes' edges when reading the
//    OLD record (the graph holds the relation, it only serves forward)."
// Part (b), the clause_superseded_by annotation, is explicitly OUT OF SCOPE
// for this file.
//
// Fix under test: knowledge_get on a record that has inbound rel:'supersedes'
// edges (i.e. some OTHER record's own `links` array holds
// {rel:'supersedes', target_id: <this record's id>}) surfaces them as a new
// additive field `inbound_supersedes`: an array of {id, ...} — one entry per
// holder. id is the only pinned projection field; slug/title are permitted
// but not required.
//
// Governing facts, established by reading existing tests/harness (never
// implementation — H4): `links` is a caller-suppliable, non-server-owned
// field at knowledge_create time (tools.test.ts "create-defaulted envelope
// fields are optional" — links is in optional[], not required[]/refused).
// `rel:'supersedes'` is an already-valid closed-set member: the existing
// whole-record supersession chain has the NEWER/head record hold an
// OUTBOUND {rel:'supersedes', target_id: <predecessor id>} link on itself
// (tools.test.ts: "knowledge_get keeps the chain edge (one hop per record
// under relations — walk continues on each predecessor)"). That mechanism
// already proves the edge can exist; what is MISSING today is any reverse
// (inbound) read on the OLD record — which is exactly board c6e3561f's
// complaint, and exactly what this file pins.
//
// Written BLIND to tools.ts / packages/store/src/index.ts. Harness skeleton,
// mkDecision fixture shape, get()/inboundIds() helpers, and the `terminus`
// `{id, status}` shape reused in the CONTROL test are all read from
// knowledge-supersede.test.ts, terminus-disclosure.test.ts, and
// knowledge-retire-narrow.test.ts for harness convention only.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE: knowledge_get returns the pinned
// record with NO `inbound_supersedes` field at all today (the graph "only
// serves forward" per the board item) — so every "membership" assertion
// below (`inboundIds(...).includes(...)`) fails on an actual `[]` not
// containing the expected id; not a thrown error. The CONTROL test and the
// "no inbound edges" / "direction honesty" tests are expected to PASS today
// too, but for the WRONG reason (the field is simply absent, not correctly
// computed as empty) — annotated per-test below.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-26T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-inbound-supersedes-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkDecision(tools: SterlingTools, title: string, statement = 's', overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

// Accepts EITHER absent-field or empty-array as "none" — the spec explicitly
// asks for a test that passes under both shapes for the no-edges case, while
// still failing on any phantom entry.
function inboundIds(record: Loose): string[] {
  const field = record.inbound_supersedes;
  if (field === undefined) return [];
  assert.ok(Array.isArray(field), 'inbound_supersedes, when present, must be an array');
  return (field as Loose[]).map((e) => {
    assert.ok(typeof e.id === 'string' && e.id.length > 0, 'each inbound_supersedes entry carries an id');
    return e.id as string;
  });
}

function retire(tools: SterlingTools, id: string, inFavorOf: string): { retired: Loose } {
  return (tools as unknown as { knowledgeRetire: (id: string, inFavorOf: string) => { retired: Loose } }).knowledgeRetire(
    id,
    inFavorOf
  );
}

// Full entries (not just ids) — needed by the retired-superseder-status pin,
// which asserts on a member OTHER than id (status). Same absent-is-empty
// tolerance as inboundIds(); the omission-exactness pin above already covers
// the absent-vs-empty distinction directly on the object shape, so this
// helper does not need to repeat that check.
function inboundEntries(record: Loose): Loose[] {
  const field = record.inbound_supersedes;
  if (field === undefined) return [];
  assert.ok(Array.isArray(field), 'inbound_supersedes, when present, must be an array');
  return field as Loose[];
}

// Dedicated MountedStores harness — the file's default harness() wraps a
// plain project-only SterlingStore and genuinely cannot mint a domain-scoped
// record. Exact precedent: knowledge-extract.test.ts's own domainHarness()
// (MountedStores + parseConfig({stack_tags:[name]})) — the same real
// domain-store write path knowledge_create already routes through, not
// faked. Used only by the domain-crossing pin below.
function domainHarness(domainName = 'genesys') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-inbound-supersedes-domain-'));
  const domainDb = join(dir, 'domains', domainName, 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: domainName, dbPath: domainDb }]);
  const config = parseConfig({ stack_tags: [domainName] });
  const tools = new SterlingTools({ store, config, now: () => NOW, newId: randomUUID });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, domainDb, store, tools, cleanup };
}

// ===========================================================================
// CONTROL — placed first so a green on the pins below always carries its
// evidence. This isolates the ALREADY-SHIPPED, server-owned full-record
// supersession terminus/status mechanism (knowledge_retire) from the NEW
// inbound_supersedes surfacing under test. Two different code paths could
// independently make PIN 1 below pass (a genuine reverse-edge query, OR a
// bug that conflates the new field with the existing terminus computation);
// this control passes for the OPPOSITE reason — it proves the OLD mechanism
// is untouched by the new one, using a record that carries no ad-hoc
// clause-level `links`-array supersedes edge at all, only the real
// server-owned retirement.
// ===========================================================================

test("CONTROL: a record fully retired via the server-owned supersession path (knowledge_retire) still shows its existing terminus/status behavior unchanged by the inbound_supersedes fix", () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'control-retire-dupe', 'duplicate statement');
    const survivor = mkDecision(tools, 'control-retire-survivor', 'survivor statement');

    const res = retire(tools, dupe.id as string, survivor.id as string);
    assert.equal(res.retired.id, dupe.id);

    const pinned = get(tools, dupe.id as string);
    assert.equal(
      pinned.status,
      'superseded',
      'EXPECTED GREEN both before and after the fix: this is the already-shipped retirement mechanism (knowledge-retire-narrow.test.ts), untouched by inbound_supersedes'
    );
    assert.equal(pinned.superseded_by, survivor.id, 'forwards to the survivor, unaffected');

    const terminus = pinned.terminus as { id: string; status: string } | undefined;
    assert.ok(terminus, 'the existing terminus disclosure is still present');
    assert.equal(terminus!.id, survivor.id);
    assert.equal(terminus!.status, 'active');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 1 — the core fix: an inbound rel:'supersedes' edge surfaces on the
// OLD record's knowledge_get result.
// ===========================================================================

test("PIN 1: knowledge_get on record A surfaces record B's id in inbound_supersedes, when B was created carrying links:[{rel:'supersedes', target_id: A.id}]", () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'pin1-old-record', 'old clause-bearing statement');

    const b = tools.knowledgeCreate('decision', {
      title: 'pin1-new-record',
      statement: 'newer statement overriding one clause of A',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: a.id }],
    }).record as unknown as Loose;

    // Sanity precondition: A is untouched by this — no status change, exactly
    // the board complaint ("no status change ... reads live-and-fresh").
    const pinnedA = get(tools, a.id as string);
    assert.equal(pinnedA.status, 'active', 'precondition: A carries no status change from the inbound edge — the board complaint');

    const ids = inboundIds(pinnedA);
    assert.ok(
      ids.includes(b.id as string),
      "EXPECTED FAILURE (red) today: inbound_supersedes is absent/empty on current code, so B's id is not found. " +
        'Sabotage: never query inbound edges at all (e.g. omit the reverse-links lookup entirely, or hardcode ' +
        'inbound_supersedes:[] unconditionally) — that keeps this assertion red forever, which IS the correct red.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — absence case, with a precision guard: no phantom entry, and no
// leakage from an UNRELATED supersedes edge that exists elsewhere in the
// same store (catches a "return every supersedes edge in the store"
// sabotage that a single-record test could not).
// ===========================================================================

test('PIN 2: a record with no inbound supersedes edges reports none — no phantom entry, and unaffected by an unrelated supersedes edge elsewhere in the same store', () => {
  const { tools, cleanup } = harness();
  try {
    const isolated = mkDecision(tools, 'pin2-isolated-record', 'nothing points at this');

    // An unrelated pair elsewhere in the same store, so a sabotage that
    // returns "every supersedes edge in the store" rather than genuinely
    // filtering by target_id would leak into `isolated`'s result.
    const unrelatedOld = mkDecision(tools, 'pin2-unrelated-old', 'unrelated old record');
    tools.knowledgeCreate('decision', {
      title: 'pin2-unrelated-new',
      statement: 'unrelated newer record',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: unrelatedOld.id }],
    });

    const pinned = get(tools, isolated.id as string);
    const ids = inboundIds(pinned);
    assert.deepEqual(
      ids,
      [],
      'EXPECTED PASS today for the WRONG reason (field is simply absent, not correctly computed as empty): no entry at all — ' +
        'neither a phantom placeholder nor a leaked unrelated edge. Sabotage: hardcode a fixed phantom entry ' +
        "(e.g. inbound_supersedes:[{id:'phantom'}]) unconditionally, OR return every supersedes edge in the store " +
        'unfiltered by target_id — either makes this assertion red.'
    );

    // review-directed addition: the spec clause is OMITTED-when-empty, not
    // present-and-empty. inboundIds() above treats an absent field the same
    // as an empty array, so a sabotage that unconditionally attaches
    // `inbound_supersedes: []` to every knowledge_get result would pass the
    // assertion above (and all of PIN 1 / PIN 4, which only check
    // membership/non-membership) while still violating the spec. This
    // assertion closes that gap directly on the object shape, not through
    // the lossy helper.
    assert.equal(
      Object.prototype.hasOwnProperty.call(pinned, 'inbound_supersedes'),
      false,
      'EXPECTED FAILURE (red) today: current code has no inbound_supersedes key at all, so this is vacuously true today — ' +
        'it earns its keep once the fixer builds the feature. Sabotage: attach `inbound_supersedes: []` UNCONDITIONALLY to ' +
        'every knowledge_get result regardless of whether inbound edges actually exist — that satisfies the ids-empty ' +
        'assertion above (and every PIN 1/PIN 4 membership check) but fails this one, because the key must be OMITTED, not ' +
        'present-and-empty, when there is nothing to disclose.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 5 (review-directed addition) — MULTIPLE holders: two distinct records
// (B and C) each independently carry an inbound rel:'supersedes' edge onto
// A. Both must surface, with no duplicates. The fixer is concurrently
// adding ORDER BY + cross-mount dedupe for this exact case — this pin
// covers membership + uniqueness only, deliberately never order.
// ===========================================================================

test("PIN 5: two DISTINCT holders (B and C), each carrying links:[{rel:'supersedes', target_id: A.id}], both surface on knowledge_get(A) with no duplicates", () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'pin5-old-record', 'old clause-bearing statement, overridden by two later records');
    const b = tools.knowledgeCreate('decision', {
      title: 'pin5-new-record-b',
      statement: 'first newer statement overriding one clause of A',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: a.id }],
    }).record as unknown as Loose;
    const c = tools.knowledgeCreate('decision', {
      title: 'pin5-new-record-c',
      statement: 'second, independent newer statement overriding a different clause of A',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: a.id }],
    }).record as unknown as Loose;

    const pinned = get(tools, a.id as string);
    const ids = inboundIds(pinned);

    assert.ok(
      ids.includes(b.id as string),
      "EXPECTED FAILURE (red) today: field absent on current code. Sabotage: cap the inbound lookup at a single row " +
        '(e.g. LIMIT 1, or `find` instead of `filter`) — combined with the C assertion below, dropping EITHER holder is caught.'
    );
    assert.ok(
      ids.includes(c.id as string),
      'same as above for C — together with the B assertion this catches a sabotage that surfaces only one of the two ' +
        'real holders instead of every inbound edge.'
    );

    const unique = new Set(ids);
    assert.equal(
      unique.size,
      ids.length,
      'no duplicate entries for the same holder — catches a sabotage that lists a holder once per its own internal edge ' +
        'row (e.g. once per mount/table it is stored under) instead of deduping by holder id, the cross-mount dedupe the ' +
        'fixer is concurrently adding'
    );
    assert.equal(
      unique.size,
      2,
      'exactly the two real holders, nothing more and nothing fewer — catches both under-reporting and any stray/duplicate ' +
        'over-reporting in one assertion. Deliberately makes no claim about ORDER.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6 (Codex review addition) — a holder that is later ITSELF retired
// still surfaces on the old record's inbound_supersedes (the clause
// override it represents does not go away just because B's own lifecycle
// advanced), and B's entry names its OWN current (non-active) status —
// distinguishing a live holder from a retired one, not just an id.
// ===========================================================================

test("PIN 6: a holder (B) that is later itself RETIRED still surfaces on A's inbound_supersedes, carrying B's own non-active status", () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'pin6-old-record', 'old clause-bearing statement');
    const b = tools.knowledgeCreate('decision', {
      title: 'pin6-holder-b',
      statement: 'newer statement overriding a clause of A, later retired itself',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: a.id }],
    }).record as unknown as Loose;
    const c = mkDecision(tools, 'pin6-survivor-c', 'the record B retires in favor of, unrelated to A');

    retire(tools, b.id as string, c.id as string);
    assert.equal(get(tools, b.id as string).status, 'superseded', 'precondition: B is now retired/tombstoned itself');

    const pinnedA = get(tools, a.id as string);
    const entries = inboundEntries(pinnedA);
    const bEntry = entries.find((e) => e.id === b.id);
    assert.ok(
      bEntry,
      "EXPECTED FAILURE (red) today: field absent on current code. Once built, a naive implementation might filter the " +
        "inbound query to ACTIVE holders only (treating 'B is no longer active' as 'B's override no longer applies') — " +
        "that would be WRONG: the clause override A suffered is unaffected by B's own later lifecycle. Sabotage: filter " +
        "the inbound-edge query to WHERE holder.status = 'active' — B silently disappearing from this list is exactly " +
        'the red this pin exists to catch.'
    );
    assert.equal(
      bEntry?.status,
      'superseded',
      "EXPECTED FAILURE (red) today: bEntry is undefined today, so bEntry?.status is undefined, never equal to " +
        "'superseded'. Once built, B's entry must carry ITS OWN current lifecycle status (known exact value: " +
        "knowledge_retire sets status:'superseded', pinned in knowledge-retire-narrow.test.ts). Sabotage: hydrate " +
        'inbound_supersedes entries with only {id} and no status member at all, or a hardcoded status:\'active\' — ' +
        'either makes this fail to distinguish a live holder from a retired one.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 7 (Codex review addition) — DOMAIN-CROSSING: a DOMAIN-scoped holder's
// inbound rel:'supersedes' edge onto a PROJECT-scoped target must surface on
// knowledge_get of the project target, fanning across MountedStores exactly
// as knowledge_get/knowledge_query already do (domain-routing.test.ts,
// §3.3/§3.4). REACHABILITY EVIDENCE (documentary, not executed — H4 forbids
// running code as a test-writer): domain-routing.test.ts's own
// knowledge_promote test already proves a DOMAIN-scoped record's `links`
// array can hold a real, persisted, knowledge_get-readable outbound edge
// targeting a PROJECT-scoped record's id (`out.promoted.links` holds
// {rel:'informed_by', target_id: ref.id} where ref is project-scoped) — so
// the pair this pin needs is not invented. What is NOT independently
// verified (no execution available) is whether passing `links` directly at
// knowledge_create time (rather than through knowledge_promote's own
// internal write) is validated against the TARGET existing in a specific
// store. Per the review instruction, this is handled by ATTEMPTING the
// construction and, if knowledge_create itself refuses it, SKIPPING with the
// refusing message quoted verbatim — never faking reachability.
// ===========================================================================

test("PIN 7: a DOMAIN-scoped holder's inbound rel:'supersedes' edge onto a PROJECT-scoped target surfaces on knowledge_get of the target, fanning across MountedStores", (t) => {
  const { tools, cleanup } = domainHarness();
  try {
    const a = mkDecision(tools, 'pin7-project-old-record', 'project-scoped old clause-bearing statement');
    assert.equal(a.scope, 'project', 'sanity: A is project-scoped by default');

    let b: Loose;
    try {
      b = tools.knowledgeCreate('reference_material', {
        scope: 'domain:genesys',
        title: 'pin7-domain-holder',
        kind: 'doc',
        location: 'docs/pin7-domain-holder.md',
        summary: 'domain-scoped record overriding one clause of the project-scoped A',
        source_date: '2026-08-26',
        capture_date: '2026-08-26',
        basis: 'platform',
        links: [{ rel: 'supersedes', target_id: a.id }],
      }).record as unknown as Loose;
    } catch (err) {
      t.skip(
        `harness cannot express a domain-scoped holder linking directly to a project-scoped target at create time — ` +
          `knowledge_create refused with: "${(err as Error).message}". Pin left unreachable per review instruction ` +
          `("check, don't assume"), not faked. The reachable half (PIN 1-6, same-store) still exercises the core fix.`
      );
      return;
    }
    assert.equal(b.scope, 'domain:genesys', 'sanity: B really landed domain-scoped');

    const pinnedA = get(tools, a.id as string);
    const ids = inboundIds(pinnedA);
    assert.ok(
      ids.includes(b.id as string),
      "EXPECTED FAILURE (red) today: field absent on current code. Once built, a naive implementation that queries " +
        "inbound edges only in the record's OWN (project) store — mirroring how the existing whole-record chain's " +
        'outbound edge is read locally — would miss B entirely, since B\'s row lives in the domain store. Sabotage: ' +
        'scope the inbound-edge query to store.project only, never fanning out to mounted domain stores — that is ' +
        'exactly the cross-mount fan-out/dedupe gap this pin exists to catch.'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4 — direction honesty: the record that HOLDS the outbound
// rel:'supersedes' link (B) must not itself gain inbound_supersedes from
// the very edge it holds. This is the realistic naive-implementation trap:
// reusing a record's OWN `links` array (already used for the existing
// whole-record chain's OUTBOUND edge) as if it were the new INBOUND field.
// ===========================================================================

test("PIN 4: direction honesty — B (which holds links:[{rel:'supersedes', target_id: A.id}]) does not itself gain inbound_supersedes from that pair", () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 'pin4-old-record', 'old clause-bearing statement');
    const b = tools.knowledgeCreate('decision', {
      title: 'pin4-new-record',
      statement: 'newer statement overriding one clause of A',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'supersedes', target_id: a.id }],
    }).record as unknown as Loose;

    const pinnedB = get(tools, b.id as string);
    const ids = inboundIds(pinnedB);
    assert.ok(
      !ids.includes(a.id as string),
      "EXPECTED PASS today for the WRONG reason (field absent on current code, vacuously excludes A). Once inbound_supersedes " +
        "is implemented, this must stay green for the RIGHT reason. Sabotage: compute inbound_supersedes by reading the " +
        "record's OWN outbound `links` array filtered on rel==='supersedes' (the mechanism already used for the existing " +
        "whole-record chain's forward edge) instead of a genuine reverse query keyed on target_id === this record's id — " +
        "that swap makes B wrongly report A here, turning this assertion red."
    );
  } finally {
    cleanup();
  }
});
