// ---------------------------------------------------------------------------
// Hardening spec for the DEAD-SLUG DISCLOSURE fallthrough on knowledge_get
// (dead-slug-disclosure.test.ts / decision de1a7329 / board
// 2b9f2f1a-15ac-4195-9651-8837c1c39558 part 3). A review found TWO behaviors
// the frozen spec file does not pin, both load-bearing on the fallthrough
// added there ("when a slug's live carrier lookup finds nothing, fall
// through to the NEWEST superseded record that still carries that slug"):
//
//   1. COLLISION REFUSAL SURVIVES THE FALLTHROUGH — the fallthrough is a
//      last-resort path that only applies when NO live record carries the
//      slug. It must never let a superseded carrier interfere with (mask,
//      soften, or get confused with) the ordinary live-collision refusal
//      when two or more LIVE records carry the same slug. A naive
//      implementation that runs "does any record — live or dead — carry
//      this slug, and if there is ambiguity just fall through to picking
//      one" would silently resolve a live collision to a stale record
//      instead of refusing.
//
//   2. CROSS-STORE NEWEST CARRIER — the fallthrough's "newest superseded
//      carrier" rule must compare timestamps ACROSS every mounted store, not
//      just within whichever store the naive implementation happens to
//      check first. Every other cross-store retrieval path in this codebase
//      is project-first-biased (§3.3: domain-routing.test.ts, "project
//      results rank ahead of domain"); "newest" is a different axis than
//      "project first", and a fallthrough that inherits the project-first
//      bias instead of comparing clocks would serve a stale project-store
//      tombstone over a genuinely newer domain-store one.
//
// Harness conventions (mkdtempSync + SterlingStore/MountedStores +
// SterlingTools + fixed/mutable clock, node:test + node:assert/strict), the
// `get()`/`escapeRegex()` idioms, and the direct-store seeding technique
// (build a valid record through the tool as a "donor", JSON-deep-copy it,
// override the fields that matter, then `store.create()` the copy to reach
// a shape the tool surface itself refuses to produce — e.g. two live
// records sharing a slug, or a raw tombstone with a chosen `updated_at`)
// were read from dead-slug-disclosure.test.ts, knowledge-supersede.test.ts
// (`seedPrefixTwin`), knowledge-supersede-hardening.test.ts
// (`mkSluglessDecision`), domain-routing.test.ts (SterlingTools over a
// MountedStores, `refFields`), and packages/store/src/tests/mounted.test.ts
// (`stores.create()` routes a raw envelope by its own `scope` field,
// independent of any tool-level type/scope restriction). No implementation
// source (tools.ts, packages/store/src/index.ts, packages/store/src/mounted.ts)
// was read.
//
// A fixer is landing the dead-slug-fallthrough code in parallel with this
// file, so either test may be RED or GREEN depending on exactly how that
// landed — each test states its own discriminating failure shape inline.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, MountedStores } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// test-repair 2026-08-22: a tools-served body carries lifecycle:'live' (and
// freshness metadata) since S2 — cloning that body and then forcing
// status:'superseded' on top is a self-contradiction under stable-identity-
// design-v2 (status now derives from lifecycle, so a stale raw column would
// be masked or fought by the still-'live' lifecycle it was cloned from).
// Strip lifecycle/freshness from the clone first so the forged raw row is a
// clean legacy-shaped tombstone whose status/superseded_by pair is read
// verbatim, exactly as the collision/newest-carrier logic under test expects. [stable-identity-design-v2]
function stripLifecycle(body: Loose): Loose {
  const clone = { ...body };
  delete clone.lifecycle;
  delete clone.freshness;
  return clone;
}

// ===========================================================================
// 1 — Collision refusal survives the dead-slug fallthrough.
// ===========================================================================

test('collision refusal survives the dead-slug fallthrough: two LIVE records sharing a slug still refuse, even with a superseded carrier of the same slug also present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dead-slug-hardening-collision-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const NOW = '2026-08-20T12:00:00.000Z';
  const tools = new SterlingTools({ store, now: () => NOW });
  try {
    const SHARED_SLUG = 'collision-hardening-shared-slug';

    // Two LIVE records forced to carry the identical slug via direct
    // store.create — ids are server-minted and the create tool itself
    // refuses a colliding slug, so this collision can only be forced
    // beneath the tool surface (the seedPrefixTwin technique).
    const donorA = mkDecision(tools, 'Collision hardening live A (donor)', 'live body A.');
    const liveA = {
      ...(JSON.parse(JSON.stringify(donorA)) as Loose),
      id: 'aaaaaaaa-c011-4000-8000-000000000001',
      slug: SHARED_SLUG,
    };
    store.create(liveA as never);

    const donorB = mkDecision(tools, 'Collision hardening live B (donor)', 'live body B.');
    const liveB = {
      ...(JSON.parse(JSON.stringify(donorB)) as Loose),
      id: 'bbbbbbbb-c011-4000-8000-000000000002',
      slug: SHARED_SLUG,
    };
    store.create(liveB as never);

    // A third, SUPERSEDED record also carrying the identical slug — the
    // dead-slug-fallthrough candidate that must NEVER win over, mask, or be
    // confused with the live collision above. Superseded through the tools
    // surface's own supersede semantics is not needed here; seeding it
    // already-superseded directly is sufficient to arrange the fixture and
    // matches the dispatch note's stated allowance.
    const survivor = mkDecision(tools, 'Collision hardening survivor', 'survivor body.');
    const donorC = mkDecision(tools, 'Collision hardening dead C (donor)', 'dead body C.');
    const deadC = {
      ...stripLifecycle(JSON.parse(JSON.stringify(donorC)) as Loose),
      id: 'cccccccc-c011-4000-8000-000000000003',
      slug: SHARED_SLUG,
      status: 'superseded',
      superseded_by: survivor.id,
    };
    store.create(deadC as never);

    assert.throws(
      () => tools.knowledgeGet(SHARED_SLUG),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(
          msg,
          /resolves to 2|ambiguous|cite the id/i,
          `EXPECTED FAILURE SHAPE: if the dead-slug fallthrough runs before (or instead of) the live-collision check, this call either returns a record (assert.throws never fires, reported as "Missing expected exception") or throws a differently-worded refusal that misses this pattern — got message: ${JSON.stringify(msg)}`
        );
        assert.doesNotMatch(
          msg,
          new RegExp(escapeRegex(deadC.id as string)),
          "EXPECTED FAILURE SHAPE: the refusal message must never name the superseded record's id as a candidate — if it does, the fallthrough logic leaked into the collision-refusal path"
        );
        return true;
      },
      'knowledge_get(sharedSlug) must throw the live-collision refusal naming the count/ambiguity, never fall through to (or get confused by) the superseded carrier of the same slug'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 2 — Cross-store newest carrier: dead-slug carriers spanning two mounted
//     stores resolve to the NEWER one, not the project-first one.
// ===========================================================================

// Carriers must be a SLUG-BEARING type: reference_material defines no slug
// field, so a forged slug on it is stripped at store.create's schema parse
// and the carrier never matches json_extract('$.slug') — the original
// fixture's silent hole. decision carries slug (de1a7329).
test('cross-store newest carrier: a dead slug carried by tombstones in TWO mounted stores resolves to the NEWER one, regardless of project-first store ordering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dead-slug-hardening-crossstore-'));
  const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
  const config = parseConfig({ stack_tags: ['genesys'] });
  let clock = '2026-08-20T09:00:00.000Z';
  const tools = new SterlingTools({ store, config, now: () => clock, newId: randomUUID });
  // Direct handle on the domain DB file, so the newer carrier genuinely
  // lives in the DOMAIN store — MountedStores.create routes writes to the
  // project store, so it cannot forge a domain-resident row.
  const domainStore = new SterlingStore(domainDb);
  try {
    const SHARED_DEAD_SLUG = 'cross-store-dead-slug-hardening';

    clock = '2026-08-20T09:00:00.000Z';
    const survivor = mkDecision(tools, 'Cross-store dead slug survivor', 'the live end of both chains.');

    // OLDER dead-slug carrier, forged directly into the PROJECT store.
    clock = '2026-08-20T10:00:00.000Z';
    const olderDonor = mkDecision(tools, 'Cross-store dead slug older carrier donor', 'older carrier body.');
    const olderCarrier = {
      ...stripLifecycle(JSON.parse(JSON.stringify(olderDonor)) as Loose),
      id: 'aaaaaaaa-1001-4000-8000-000000000001',
      slug: SHARED_DEAD_SLUG,
      status: 'superseded',
      superseded_by: survivor.id,
    };
    store.create(olderCarrier as never);

    // NEWER dead-slug carrier, forged directly into the DOMAIN (genesys)
    // store. Every other cross-store retrieval path in this codebase is
    // project-first-biased (§3.3) — that bias is exactly the wrong answer
    // here, since "newest" and "project-first" are different axes.
    clock = '2026-08-20T12:00:00.000Z';
    const newerDonor = mkDecision(tools, 'Cross-store dead slug newer carrier donor', 'newer carrier body.');
    const newerCarrier = {
      ...stripLifecycle(JSON.parse(JSON.stringify(newerDonor)) as Loose),
      id: 'bbbbbbbb-2002-4000-8000-000000000002',
      slug: SHARED_DEAD_SLUG,
      scope: 'domain:genesys',
      status: 'superseded',
      superseded_by: survivor.id,
    };
    // The donor row itself stays in the project store (harmless — different
    // slug); the forged carrier is written into the domain store directly.
    domainStore.create(newerCarrier as never);

    const resolved = tools.knowledgeGet(SHARED_DEAD_SLUG) as unknown as Loose;
    assert.equal(
      resolved.id,
      newerCarrier.id,
      `EXPECTED FAILURE SHAPE: if newest-carrier selection is store-order-biased (project checked/preferred first) rather than clock-compared across mounts, this equality fails because the OLDER project-store carrier (id ${olderCarrier.id}) is served instead of the NEWER domain-store one (id ${newerCarrier.id})`
    );
    assert.equal(resolved.scope, 'domain:genesys', 'the served carrier is the one that actually lives in the domain store');
    assert.notEqual(resolved.id, olderCarrier.id, 'must not serve the older project-store carrier');
  } finally {
    domainStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
