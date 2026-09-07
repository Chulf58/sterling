// ---------------------------------------------------------------------------
// FROZEN PINS — the NAMED mount refusal on every resolves-bearing mutation
// lane, decision `domain-held-subject-queue-items-close-two-step-named-
// mount-refusal-on-every-lane-label-routed-transaction-retired` (knowledge_get
// f2c61919-59ca-482e-8fab-53a7ddf13a2f). Written from the decision's own
// words, never from tools.ts (H4 forbids reading it for this role).
//
// SPEC SUMMARY PINNED HERE:
//   - a `resolves` claim is admitted ONLY beside a PROJECT-held target — a
//     domain-held target sits on a different SQLite connection, so admitting
//     the claim would split the commit;
//   - the refusal is NAMED and fires on EVERY mutation lane (knowledge_update,
//     knowledge_append, knowledge_edit, knowledge_array_remove,
//     knowledge_supersede) BEFORE the store's generic 'nested transaction'
//     guard — that guard is the BACKSTOP, never the message;
//   - it validates/resolves each claimed item FIRST (an unknown id or a
//     forbidden lane still gets its own, more fundamental refusal);
//   - the named refusal states: the target id, its PHYSICAL scope (from
//     scopeOfHolder — never a bare projectStoreHolds:false), the item id, the
//     item's lane, and the lane-qualified remedy: "perform the write WITHOUT
//     resolves; verify it paid this lane; then close the item with
//     maintenance_remove <id>" (for refresh_reference, stale_research,
//     wire_in_dormant, state_review — the lanes this file exercises);
//   - the write WITHOUT resolves succeeds; maintenance_remove then closes it
//     explicitly — a two-step, never a single atomic discharge, for a
//     domain-held target;
//   - the PROJECT-held contrast still discharges atomically in one call.
//
// AMBIGUITY DISCLOSED (not resolved by reading tools.ts): the decision does
// not spell out which specific FIELD/TYPE each of the five lanes mutates in
// this test's fixtures. reference_material has no top-level array field that
// knowledge_append/knowledge_array_remove can address (`links` is barred from
// append for every type per tools.test.ts; `catalog` is a nested object, not
// an array), so this file uses a domain-held REFERENCE_MATERIAL for the
// knowledge_update/knowledge_edit/knowledge_supersede lanes (plain-string
// fields, matching the decision's own reference_material framing) and a
// domain-held FEATURE_ARTICLE for knowledge_append/knowledge_array_remove
// (array fields `history`/`files[]`, the same shapes resolves-claim.test.ts
// already establishes for those two methods) — both targets minted with the
// SAME `refresh_reference` reason via the same server-internal
// `maintenanceEnqueue` path resolves-claim.test.ts uses.
//
// The remedy-wording assertions use permissive regexes on "without resolves"
// / "maintenance_remove", never a verbatim string — the decision states the
// remedy's substance, not its exact punctuation.
//
// EXECUTION DISCLOSURE: this agent holds no shell and cannot run these tests;
// the conductor's red/mutation gate executes them.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SterlingTools } from '../tools.js';
import { harnessMounted as harnessMountedShared } from './test-helpers/mounted-harness.js';

const NOW = '2026-09-06T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harnessMounted(domains: string[] = ['node']) {
  return harnessMountedShared(domains, { now: NOW, prefix: 'sterling-mount-refusal-lanes-' });
}

type ResolvingAll = {
  knowledgeUpdate(id: string, patch: Loose, resolves?: string[]): unknown;
  knowledgeAppend(id: string, field: string, values: unknown[], resolves?: string[]): unknown;
  knowledgeEdit(id: string, field: string, find: string, replace: string, resolves?: string[]): unknown;
  knowledgeArrayRemove(id: string, selector: string, expectedVersion: number, resolves?: string[]): unknown;
  knowledgeSupersede(old_id: string, fields: Loose, orphans_acknowledged?: boolean, resolves?: string[]): unknown;
};
const widenAll = (tools: SterlingTools) => tools as unknown as ResolvingAll;

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

const mkReferenceScoped = (tools: SterlingTools, title: string, scope: string): Loose =>
  tools.knowledgeCreate('reference_material', {
    title,
    kind: 'doc',
    location: `docs/${title}.md`,
    summary: 'original summary',
    source_date: '2026-01-01',
    capture_date: '2026-01-01',
    scope,
  }).record as unknown as Loose;

const mkArticleScoped = (tools: SterlingTools, slug: string, paths: string[], scope: string): Loose =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    scope,
  }).record as unknown as Loose;

function decisionFields(): Loose {
  return { title: `probe-${randomUUID().slice(0, 8)}`, statement: 's', alternatives_rejected: [], rationale: 'r' };
}

// A shared assertion for the named-refusal shape, reused by every lane arm
// below so the five tests pin an IDENTICAL contract, not five drifting ones.
function assertNamedMountRefusal(err: Error, targetId: string, physicalScope: string, itemId: string, laneHint: RegExp) {
  assert.match(err.message, new RegExp(targetId), 'names the target id');
  assert.match(err.message, new RegExp(physicalScope.replace(':', '\\:')), "names the target's PHYSICAL scope — scopeOfHolder, never a bare projectStoreHolds:false");
  assert.match(err.message, new RegExp(itemId), 'names the item id');
  assert.match(err.message, laneHint, 'names the lane');
  assert.match(err.message, /without resolves/i, 'remedy: perform the write WITHOUT resolves');
  assert.match(err.message, /maintenance_remove/, 'remedy: then close with maintenance_remove');
  assert.doesNotMatch(err.message, /nested transaction/i, "the NAMED refusal fires BEFORE the store's generic guard — that wording is the backstop, never the message");
}

// ===========================================================================
// FIVE LANES — each: mint refresh_reference -> resolves refused (named) ->
// same write WITHOUT resolves succeeds -> maintenance_remove closes it ->
// both physical stores still validate (no split write).
// ===========================================================================

test('LANE knowledge_update: a resolves claim against a DOMAIN-held target is refused by name; the write WITHOUT resolves succeeds; maintenance_remove then closes it; no split write', () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    const target = mkReferenceScoped(tools, 'guide-update', 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: "refresh 'guide-update'",
      file_keys: [],
      feature_link: target.id as string,
    });
    const before = get(tools, target.id as string) as { version: number };

    assert.throws(
      () => widenAll(tools).knowledgeUpdate(target.id as string, { summary: 'refreshed via resolves' }, [item.id]),
      (err: Error) => {
        assertNamedMountRefusal(err, target.id as string, 'domain:node', item.id, /update/i);
        return true;
      },
      'a resolves claim against a domain-held target is refused'
    );
    assert.equal((get(tools, target.id as string) as { version: number }).version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');

    const updated = tools.knowledgeUpdate(target.id as string, { summary: 'refreshed without resolves' }) as unknown as Loose;
    assert.equal(updated.summary, 'refreshed without resolves', 'the ordinary write, without a claim, lands');
    assert.ok(openIds(tools).includes(item.id), 'and the item stays open — the write ALONE never discharges it (two-step, not atomic)');

    tools.maintenanceRemove(item.id);
    assert.ok(!openIds(tools).includes(item.id), 'maintenance_remove closes it explicitly');

    assert.ok(
      store.querySource('node', { types: ['reference_material'] }).some((r) => (r as unknown as Loose).id === target.id),
      'the domain store still holds the record — no partial write left it corrupted'
    );
    assert.ok(tools.knowledgeCreate('decision', decisionFields()).record, 'the project connection is still healthy after the refused cross-mount attempt — no stuck transaction');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): the refusal's message text is unnamed —
// today's refusal (if any fires at all here) is the store's generic
// 'resolves claim names no open item'-class wording, which fails every
// `assertNamedMountRefusal` sub-check except possibly the target-id/item-id
// regexes; if NO refusal fires at all (the write silently proceeds and splits
// the commit across two connections), `assert.throws` itself fails with
// "Missing expected exception".
// SABOTAGE: restrict the named refusal to knowledge_update only, leaving the
// other four lanes to fall through to the generic guard -> this arm stays
// green while the other four go red on the `doesNotMatch(/nested transaction/i)`
// assertion — proving the fix is per-method rather than per-mutation-core.

test('LANE knowledge_append: a resolves claim against a DOMAIN-held target is refused by name; the write WITHOUT resolves succeeds; maintenance_remove then closes it; no split write', () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    const target = mkArticleScoped(tools, 'thing-append', ['src/thing.ts'], 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: "refresh 'thing-append'",
      file_keys: [],
      feature_link: target.id as string,
    });
    const before = get(tools, target.id as string) as { version: number };

    assert.throws(
      () => widenAll(tools).knowledgeAppend(target.id as string, 'history', [{ date: NOW, event: 'via resolves' }], [item.id]),
      (err: Error) => {
        assertNamedMountRefusal(err, target.id as string, 'domain:node', item.id, /append/i);
        return true;
      },
      'a resolves claim against a domain-held target is refused'
    );
    assert.equal((get(tools, target.id as string) as { version: number }).version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');

    const appended = tools.knowledgeAppend(target.id as string, 'history', [{ date: NOW, event: 'without resolves' }]) as unknown as { record: Loose };
    assert.ok(
      ((appended.record.history as Loose[]) ?? []).some((h) => h.event === 'without resolves'),
      'the ordinary append, without a claim, lands'
    );
    assert.ok(openIds(tools).includes(item.id), 'and the item stays open — two-step, not atomic');

    tools.maintenanceRemove(item.id);
    assert.ok(!openIds(tools).includes(item.id), 'maintenance_remove closes it explicitly');

    assert.ok(
      store.querySource('node', { types: ['feature_article'] }).some((r) => (r as unknown as Loose).id === target.id),
      'the domain store still holds the record'
    );
    assert.ok(tools.knowledgeCreate('decision', decisionFields()).record, 'the project connection is still healthy');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): same shape as the update lane above —
// either an un-named generic refusal (every sub-check but the id regexes
// fails) or no refusal at all ("Missing expected exception").
// SABOTAGE: name the refusal correctly but forget the item-open-until-closed
// contract (auto-drain the item on the FIRST successful without-resolves
// write regardless of whether a claim was ever made) -> the
// `openIds(...).includes(item.id)` assertion right after the plain append
// goes red, while the refusal assertions above it stay green.

test('LANE knowledge_edit: a resolves claim against a DOMAIN-held target is refused by name; the write WITHOUT resolves succeeds; maintenance_remove then closes it; no split write', () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    const target = mkReferenceScoped(tools, 'guide-edit', 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: "refresh 'guide-edit'",
      file_keys: [],
      feature_link: target.id as string,
    });
    const before = get(tools, target.id as string) as { version: number };

    assert.throws(
      () => widenAll(tools).knowledgeEdit(target.id as string, 'summary', 'original summary', 'edited via resolves', [item.id]),
      (err: Error) => {
        assertNamedMountRefusal(err, target.id as string, 'domain:node', item.id, /edit/i);
        return true;
      },
      'a resolves claim against a domain-held target is refused'
    );
    assert.equal((get(tools, target.id as string) as { version: number }).version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');

    const edited = tools.knowledgeEdit(target.id as string, 'summary', 'original summary', 'edited without resolves') as unknown as { record: Loose };
    assert.equal(edited.record.summary, 'edited without resolves', 'the ordinary edit, without a claim, lands');
    assert.ok(openIds(tools).includes(item.id), 'and the item stays open — two-step, not atomic');

    tools.maintenanceRemove(item.id);
    assert.ok(!openIds(tools).includes(item.id), 'maintenance_remove closes it explicitly');

    assert.ok(
      store.querySource('node', { types: ['reference_material'] }).some((r) => (r as unknown as Loose).id === target.id),
      'the domain store still holds the record'
    );
    assert.ok(tools.knowledgeCreate('decision', decisionFields()).record, 'the project connection is still healthy');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): same shape as the update lane.
// SABOTAGE: implement the named check for the whole-field edit form but skip
// it when `knowledgeEdit`'s underlying write happens to route through a
// shared internal update helper with a DIFFERENT resolves plumbing path
// (a second, un-guarded entry point) -> this arm alone goes red while the
// update lane above stays green.

test('LANE knowledge_array_remove: a resolves claim against a DOMAIN-held target is refused by name; the write WITHOUT resolves succeeds; maintenance_remove then closes it; no split write', () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    const target = mkArticleScoped(tools, 'thing-arr', ['src/keep.ts', 'src/drop.ts'], 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: "refresh 'thing-arr'",
      file_keys: [],
      feature_link: target.id as string,
    });
    const before = get(tools, target.id as string) as { version: number };

    assert.throws(
      () => widenAll(tools).knowledgeArrayRemove(target.id as string, 'files[path=src/drop.ts]', before.version as number, [item.id]),
      (err: Error) => {
        assertNamedMountRefusal(err, target.id as string, 'domain:node', item.id, /array.?remove/i);
        return true;
      },
      'a resolves claim against a domain-held target is refused'
    );
    assert.equal((get(tools, target.id as string) as { version: number }).version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');

    const removedResult = tools.knowledgeArrayRemove(target.id as string, 'files[path=src/drop.ts]', before.version as number) as unknown as { record: Loose };
    assert.ok(
      !((removedResult.record.files as Loose[]) ?? []).some((f) => f.path === 'src/drop.ts'),
      'the ordinary array-remove, without a claim, lands'
    );
    assert.ok(openIds(tools).includes(item.id), 'and the item stays open — two-step, not atomic');

    tools.maintenanceRemove(item.id);
    assert.ok(!openIds(tools).includes(item.id), 'maintenance_remove closes it explicitly');

    assert.ok(
      store.querySource('node', { types: ['feature_article'] }).some((r) => (r as unknown as Loose).id === target.id),
      'the domain store still holds the record'
    );
    assert.ok(tools.knowledgeCreate('decision', decisionFields()).record, 'the project connection is still healthy');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): `knowledgeArrayRemove`'s established
// signature (knowledge-array-remove.test.ts) is `(id, selector,
// expectedVersion)` with NO resolves parameter at all — calling it through
// `widenAll`'s cast with a 4th argument either (a) is silently ignored by a
// function that only reads its first three parameters, in which case the
// write just proceeds normally and `assert.throws` fails with "Missing
// expected exception" (RED), or (b) if resolves support already exists but
// is unguarded for domain targets, the call falls through to the store's
// generic guard and the `doesNotMatch(/nested transaction/i)` sub-assertion
// fails instead. Either is the correct RED for new lane coverage.
// SABOTAGE: wire resolves support into knowledge_array_remove WITHOUT the
// mount-affinity check (a bare pass-through to the existing resolves-claim
// validator that never consults scopeOfHolder) -> "Missing expected
// exception" here while the update/append/edit lanes above stay green.

// LANE knowledge_supersede — REMOVED 2026-09-07: decision f2c61919 (`domain-held-subject-queue-items-close-two-step-named-mount-refusal-on-every-lane-label-routed-transaction-retired`)
// was corrected — knowledge_supersede takes NO `resolves` parameter (verified: packages/mcp-server/src/tools.ts:9497,
// signature `knowledgeSupersede(oldId, fields, orphansAcknowledged?)`) and is therefore not a resolves lane at all.

// ===========================================================================
// CONTROL: the PROJECT-held contrast — the same resolves claim, on an
// ordinary project-scoped target, succeeds ATOMICALLY (one call, no
// maintenance_remove needed). Placed so every refusal above carries evidence:
// an implementation that refused EVERY resolves claim regardless of scope
// would satisfy the five refusal arms identically and this control would
// catch it.
// ===========================================================================

test('CONTROL: the same resolves claim against a PROJECT-held target succeeds ATOMICALLY in one call — no two-step, no maintenance_remove needed', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const target = mkReferenceScoped(tools, 'guide-project', 'project');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: "refresh 'guide-project'",
      file_keys: [],
      feature_link: target.id as string,
    });

    const updated = widenAll(tools).knowledgeUpdate(target.id as string, { summary: 'refreshed atomically' }, [item.id]) as unknown as Loose;
    assert.equal(updated.summary, 'refreshed atomically', 'the write landed');
    assert.ok(!openIds(tools).includes(item.id), 'the item drained in the SAME call — atomic, unlike the domain-held arms above');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN — this is the pre-existing, already-shipped
// project-held resolves contract (resolves-claim.test.ts). Placed as the
// baseline the domain-scoped refusals above must differ from.
// SABOTAGE: refuse EVERY resolves claim regardless of scope (an
// over-broad fix that treats "domain-aware" as "resolves is gone") -> this
// control goes red while all five refusal arms above stay green — exactly
// the discrimination this control exists to provide.

// ===========================================================================
// PRECEDENCE: an unknown item id, or a lane the item's system_reason
// forbids, gets its OWN, more fundamental refusal FIRST — never the mount
// message, even against a domain-held target.
// ===========================================================================

test('PRECEDENCE: resolves naming an id with NO open maintenance item at all is refused for THAT reason — even against a domain-held target, never as if it were a mount problem', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const target = mkReferenceScoped(tools, 'guide-unknown-item', 'domain:node');
    const bogus = randomUUID();

    assert.throws(
      () => widenAll(tools).knowledgeUpdate(target.id as string, { summary: 'x' }, [bogus]),
      (err: Error) => {
        assert.match(err.message, new RegExp(bogus), 'names the offending (nonexistent) item id');
        assert.doesNotMatch(err.message, /maintenance_remove/, 'this is NOT the mount refusal — there is no valid item to remedy via maintenance_remove');
        return true;
      },
      'an unresolvable item id is refused before the mount is ever considered'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): if the current resolves-claim validator
// already refuses an unknown id (resolves-claim.test.ts pins this for
// project-held targets), the risk is that a mount-aware rewrite reorders the
// checks so the SCOPE is validated before the ITEM, producing the wrong
// (mount-shaped) message for what is really an unknown-id problem — this
// arm's `doesNotMatch(/maintenance_remove/)` catches exactly that reordering.
// If no refusal fires at all against a domain target (the write proceeds),
// `assert.throws` fails with "Missing expected exception".
// SABOTAGE: validate the target's scope BEFORE resolving the claimed item ids
// -> the message becomes the mount refusal (names domain:node, "maintenance_
// remove") for what is actually an unknown-id problem, and the
// `doesNotMatch` assertion goes red.

test('PRECEDENCE: resolves naming an item whose system_reason FORBIDS this lane is refused for THAT reason — even against a domain-held target, never as if it were a mount problem', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const target = mkArticleScoped(tools, 'thing-wrong-lane', ['src/thing.ts'], 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'capture_owed',
      text: "capture owed for 'thing-wrong-lane'",
      file_keys: ['src/thing.ts'],
      feature_link: target.id as string,
    });

    assert.throws(
      () => widenAll(tools).knowledgeUpdate(target.id as string, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending item id');
        assert.match(err.message, /capture_owed/, 'names the wrong-lane reason — capture_owed discharges via knowledge_create, not knowledge_update, regardless of scope');
        assert.doesNotMatch(err.message, /maintenance_remove/, 'this is NOT the mount refusal — the lane mismatch is the more fundamental problem, checked first');
        return true;
      },
      'a wrong-lane item is refused before the mount is ever considered, even though the target happens to be domain-held'
    );
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): analogous to the unknown-id arm above —
// either the lane-mismatch refusal already exists (project-held precedent:
// resolves-claim-update-lanes.test.ts AC-EXT4) and a mount-aware rewrite
// reorders the checks so THIS arm's target being domain-held produces the
// mount message instead (the `doesNotMatch` assertion fires), or no refusal
// fires at all against a domain target and `assert.throws` fails outright.
// SABOTAGE: check scope affinity before lane validity -> the message becomes
// the mount refusal instead of the capture_owed wrong-lane refusal, and the
// `doesNotMatch(/maintenance_remove/)` assertion goes red while the
// project-held AC-EXT4 precedent (a different file, not re-run here) stays
// green — proving the reordering is scope-conditional.
