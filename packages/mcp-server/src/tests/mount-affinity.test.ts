import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { harnessMounted } from './test-helpers/mounted-harness.js';

// ===========================================================================
// MOUNT AFFINITY / HOLDER-DERIVED SCOPE
//
// SPEC (authoritative over the implementation — a red pin here means the code
// has a defect, not that the test is wrong): decision
// `scope-drift-closed-by-column-authoritative-reads-not-format-change`
// (knowledge_get 74b67d0f-be6e-4bbb-8d4a-95f67f842190), specifically its
// "PHYSICAL HOLDER IDENTITY NEEDS ITS OWN ACCESSOR" clause and its
// TRANSACTION-TO-HOLDER AFFINITY section, plus anti_pattern
// `record-body-scope-is-not-physical-store-identity` (a61cbdf3).
//
// THE CONTRACT PINNED HERE, in the decision's own words:
//   - `storeHolding(id)` answers WHICH STORE holds a record, but nothing
//     exposes WHAT SCOPE THAT STORE IS, so both `knowledgeSupersede` and
//     extract's `sourceScope` reconstructed it as
//     `held-by-project ? 'project' : original.scope` — physically derived for
//     the project case and straight back to the untrusted field for every
//     DOMAIN case. Add `scopeOfHolder(id)` on MountedStores and route both
//     paths through it.
//   - `storeHolding` resolves a DUPLICATE id project-first WITHOUT detecting
//     the ambiguity — it must fail loudly on multiple holders.
//   - `withTransactionForScope(label)` routes by the LABEL while
//     `updateRecord()` routes by the HOLDER, so a drifted label opens the
//     transaction on the wrong database. Fixed by `withTransactionForRecord(id)`
//     routing on physical identity, PLUS a backstop refusing cross-mount
//     WRITES inside a transaction "while cross-store READS stay allowed".
//
// WHY EVERY PIN BELOW USES A REAL TWO-STORE FIXTURE. An earlier pin in this
// territory stood up ONE plain SterlingStore and wrote a `scope:'domain:node'`
// row into the PROJECT database — a shape production cannot produce — and
// passed review twice while pinning nothing: with only one physical store
// present, a body-field check and a physical-holder check are INDISTINGUISHABLE.
// Everything here runs on `harnessMounted`, the shared real MountedStores
// fixture (a genuine project store + N genuine mounted domain stores reached
// through the real SterlingTools surface).
//
// THE DRIFT SHAPE — REDUCED TO ONE CLASS ON 2026-09-06, READ THIS BEFORE
// "SIMPLIFYING" ANY FIXTURE BELOW. `scope` is a REQUIRED schema field and the
// dedicated `scope` SQL COLUMN is NOT NULL, so a genuinely scope-less ROW was
// never constructible at any level. Until today TWO corrupt shapes were still
// reachable through a raw row rewrite:
//   (a) the `scope` COLUMN stays set while the JSON BODY omits the key, and
//   (b) the BODY contradicts the COLUMN,
// both of them exploiting the old asymmetry that reads parsed the BODY while
// storage and routing used the COLUMN. PART 4 OF THE GOVERNING DECISION HAS
// SINCE SHIPPED: one central live-record decoder overwrites the parsed body's
// `scope` with the row's `scope` COLUMN on EVERY live materializing read
// (get(), both query() branches, articlesBySlug, recordsBySlug,
// supersededRecordsBySlug, and enqueueSystemTodo's dedup return). Body-vs-column
// disagreement is therefore UNREPRESENTABLE ON READ by design — shapes (a) and
// (b) can still be written to disk, but NO READ WILL EVER SHOW YOU THE RESULT,
// so any pin whose PRECONDITION observes them is permanently red. That is the
// decoder working, not a defect.
//
// THE ONE DRIFT CLASS STILL REACHABLE, and the one every fixture below is now
// built from, is `column contradicts mounted location`, named by the governing
// decision's own audit: a row PHYSICALLY held by store X whose `scope` column
// (and therefore its read value) says Y. The decoder cannot see it — it makes
// the body agree with the COLUMN, and the column is precisely what disagrees
// with the mount. It is forged with a raw `.create()` on a second handle opened
// on the target database (`inDomainDb`) or on `store.project` directly; the tool
// surface will never produce it, because creation routes ON the label.
//
// FIVE ARMS WERE RE-BASED ONTO THAT CLASS on 2026-09-06 (the two A1
// unmounted-label arms, B1, C1, C3), each carrying a local note saying so.
// AUDITED AT THE SAME TIME AND FOUND TO NEED NO CHANGE: B2 and C4 already forge
// column-contradicts-mount (a raw envelope's `scope` becomes BOTH the column and
// the body, so a raw seed into a store that disagrees with it IS the surviving
// class — proven green by resolves-append-join.test.ts's two mount-boundary arms,
// which read exactly such a row back through the tool surface). If B2 is red it
// is red at an ASSERTION, not at a precondition, and that red is a code finding
// about holder-derived replacement scope — do not "fix" it by editing the arm.
//
// EXECUTION DISCLOSURE: this agent holds no shell and cannot run these tests.
// Every test carries its EXPECTED FAILURE SHAPE and its NAMED SABOTAGE in the
// comment beside it; the conductor executes the red/mutation gate.
// ===========================================================================

const NOW = '2026-09-06T12:00:00.000Z';

type Loose = Record<string, unknown>;

/** The two NOT-YET-EXISTING MountedStores primitives this file specifies, cast
 *  through `unknown` so the file compiles under any TS strictness while the
 *  RUNTIME call still hits the real (currently absent) method. Same precedent
 *  knowledge-split.test.ts / knowledge-extract.test.ts set for a wholly-new
 *  method. `scopeOfHolder` and `withTransactionForRecord` are named EXACTLY as
 *  the governing decision names them — if the implementation lands them under
 *  different names that is a spec deviation to adjudicate, not a test defect. */
type MountAffinityCapable = {
  scopeOfHolder(id: string): string;
  withTransactionForRecord<T>(id: string, fn: () => T): T;
};
const affinity = (store: unknown) => store as MountAffinityCapable;

/** knowledge_extract — already implemented; called through a cast because the
 *  input is a loose object literal (same helper knowledge-extract.test.ts uses). */
type ExtractCapable = { knowledgeExtract(input: Loose): unknown };
const runExtract = (tools: SterlingTools, input: Loose): Loose =>
  (tools as unknown as ExtractCapable).knowledgeExtract(input) as Loose;

/** knowledge_supersede — already implemented; same cast idiom as
 *  knowledge-supersede.test.ts:64-68. `scope` is deliberately NEVER passed in
 *  `fields`: the governing decision makes it immutable after creation and the
 *  tool surface refuses it on supersession, which is precisely WHY the
 *  replacement's scope has to be DERIVED — from the holder, per this spec. */
type SupersedeCapable = { knowledgeSupersede(old_id: string, fields: Loose, orphans_acknowledged?: boolean): unknown };
const supersede = (tools: SterlingTools, oldId: string, fields: Loose): unknown =>
  (tools as unknown as SupersedeCapable).knowledgeSupersede(oldId, fields);

function h(domains: string[], prefix: string) {
  return harnessMounted(domains, { now: NOW, prefix: `sterling-mount-affinity-${prefix}-` });
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function decisionSlugs(tools: SterlingTools): (string | undefined)[] {
  return (tools.knowledgeQuery({ types: ['decision'], cap: 1000 }) as unknown as Loose[]).map(
    (r) => r.slug as string | undefined
  );
}

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

function decisionFields(slug: string, statement: string): Loose {
  return {
    slug,
    title: slug,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
  };
}

/** A raw decision ENVELOPE for the DIRECT-STORE SEEDING technique — bypasses
 *  knowledge_create/MountedStores routing entirely, which is the only way to
 *  make the `scope` column and the PHYSICAL location disagree (the tool surface
 *  will never produce that shape). Mirrors knowledge-extract.test.ts's own
 *  `rawSupersededDecision` envelope field-for-field; the caller supplies the id
 *  itself (dead-slug-hardening.test.ts's idiom) so nothing depends on what
 *  `.create()` happens to return. */
function rawDecisionEnvelope(id: string, scope: string, slug: string, statement = 'raw seeded statement'): Loose {
  return {
    id,
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope,
    stack_tags: [],
    slug,
    title: slug,
    statement,
    alternatives_rejected: [],
    rationale: 'raw seeded rationale',
    file_keys: [],
  };
}

/* TOMBSTONE — `stripScopeFromStoredRow` lived here until 2026-09-06 and has been
 * DELETED, deliberately, not lost. It rewrote a row's JSON BODY column to remove
 * the `scope` key while leaving the NOT NULL `scope` COLUMN intact, which used to
 * make a record READ BACK with no scope at all. The column-authoritative decoder
 * (part 4 of the governing decision, now shipped) makes that outcome
 * unobservable: every live read overwrites the parsed body's scope with the
 * column's, so the helper still "works" on disk while every read shows the column
 * value. Five arms in this file were built on it and every one of them failed at
 * its PRECONDITION, not at its assertion. Do not resurrect it — a pin built on it
 * is permanently red (or, worse, quietly re-written to assert the column value and
 * thereby pinning nothing). Forge `column contradicts mounted location` instead:
 * `store.project.create(rawDecisionEnvelope(id, 'domain:x', …))` or
 * `inDomainDb(domainDbPath('node'), (dh) => dh.create(rawDecisionEnvelope(id, 'project', …)))`.
 */

/** Opens a SECOND physical handle on an already-mounted domain database to
 *  perform a raw seed or a body rewrite, then closes it. Proven pattern:
 *  resolves-append-join.test.ts:1184-1190 ("two readers, one file"). */
function inDomainDb<T>(dbPath: string, fn: (store: SterlingStore) => T): T {
  const handle = new SterlingStore(dbPath);
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

// ===========================================================================
// GROUP A — scopeOfHolder(id): the scope of the store PHYSICALLY HOLDING the
// record, from the mount, never a body field.
//
// A1's two CONTROL arms come first: they establish that the accessor answers
// correctly when body and physical location AGREE. Without them, the drifted
// arms below could not distinguish "reads the holder" from "the fixture is
// broken"; with them alone, nothing distinguishes "reads the holder" from
// "returns the body field" — which is why the drifted arms exist. Both halves
// are required; neither is redundant.
// ===========================================================================

test('A1 CONTROL (agreeing): scopeOfHolder returns "project" for a project-held record whose body also says project', () => {
  const { store, tools, cleanup } = h(['node'], 'a1-control-project');
  try {
    const rec = tools.knowledgeCreate('decision', decisionFields('a1-ctl-project', 's')).record as unknown as Loose;
    assert.equal(rec.scope, 'project', 'precondition: created project-scoped');
    assert.ok(store.project.get(rec.id as string), 'precondition: the row physically lives in the PROJECT database');

    assert.equal(
      affinity(store).scopeOfHolder(rec.id as string),
      'project',
      'the project store\'s scope is the literal string "project"'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): `TypeError: store.scopeOfHolder is not a
// function` — the primitive does not exist yet. Red-because-absent, not
// red-because-wrong.
// SABOTAGE (once built): make scopeOfHolder return the DOMAIN name (or
// 'domain:project') for the project store instead of the literal 'project'
// -> this equality goes red. NOTE: this control is deliberately weak on its own
// — a `return record.scope` implementation passes it. That is its job: it is the
// baseline the drifted arms below are read against.

test('A1 CONTROL (agreeing): scopeOfHolder returns "domain:node" for a domain-held record whose body also says domain:node', () => {
  const { store, tools, cleanup } = h(['node'], 'a1-control-domain');
  try {
    const rec = tools.knowledgeCreate('decision', {
      ...decisionFields('a1-ctl-domain', 's'),
      scope: 'domain:node',
    }).record as unknown as Loose;
    assert.equal(rec.scope, 'domain:node', 'precondition: created domain-scoped');
    assert.equal(store.project.get(rec.id as string), undefined, 'precondition: the row is NOT in the project database');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === rec.id),
      'precondition: the row physically lives in the node domain database'
    );

    assert.equal(affinity(store).scopeOfHolder(rec.id as string), 'domain:node', 'the mounted domain store reports its own scope label');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — primitive absent.
// SABOTAGE (once built): hardcode 'project' as the return for every holder ->
// red here while the project control above stays green.

test('A1: scopeOfHolder returns "project" for a PROJECT-held record whose BODY CLAIMS domain:node — the holder wins over the field', () => {
  const { store, tools, cleanup } = h(['node'], 'a1-drift-body-domain');
  try {
    // Raw seed straight into the PROJECT database with a body+column that both
    // claim domain:node — the "column contradicts mounted location" drift class
    // the governing decision's own audit names. Unreachable through
    // knowledge_create by construction (it would route the row to node).
    const id = randomUUID();
    store.project.create(rawDecisionEnvelope(id, 'domain:node', 'a1-drift-body-domain') as never);
    assert.equal(
      (get(tools, id).scope as string),
      'domain:node',
      'precondition: the record READS as domain:node while physically living in the project database'
    );
    assert.ok(store.project.get(id), 'precondition: physically project-held');

    assert.equal(
      affinity(store).scopeOfHolder(id),
      'project',
      'scopeOfHolder answers from the MOUNT, so a body claiming domain:node on a project-held row still reports project'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — primitive absent.
// SABOTAGE (once built): implement scopeOfHolder as `return this.get(id).scope`
// -> returns 'domain:node' and this goes red, while BOTH A1 controls stay green.
// THIS IS THE ARM THAT MAKES THE GROUP LOAD-BEARING.

test('A1: scopeOfHolder returns "domain:node" for a DOMAIN-held record whose BODY CLAIMS project — the holder wins over the field', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'a1-drift-body-project');
  try {
    const id = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(id, 'project', 'a1-drift-body-project') as never)
    );
    assert.equal(get(tools, id).scope, 'project', 'precondition: the record READS as project while physically living in the node database');
    assert.equal(store.project.get(id), undefined, 'precondition: NOT in the project database');

    assert.equal(
      affinity(store).scopeOfHolder(id),
      'domain:node',
      'a body claiming project on a domain-held row still reports the holding domain'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — primitive absent.
// SABOTAGE (once built): `held-by-project ? 'project' : record.scope` (the
// EXACT reconstruction the governing decision names as the defect) -> returns
// 'project' and this goes red.

test('A1: scopeOfHolder returns "project" for a PROJECT-held record whose scope COLUMN NAMES AN UNMOUNTED DOMAIN — the label is never consulted, so an unresolvable one cannot mislead it', () => {
  const { store, tools, cleanup } = h(['node'], 'a1-unmounted-project');
  try {
    // WHY THIS CONSTRUCTION CHANGED (2026-09-06). This arm previously forged
    // "BODY OMITS scope" — knowledge_create, then strip the `scope` key out of
    // the stored JSON body — and asserted the record read back with no scope at
    // all. THAT SHAPE IS ABOLISHED: the column-authoritative decoder (part 4 of
    // the governing decision, shipped) refills the parsed body's scope from the
    // NOT NULL `scope` COLUMN on every live read, so the old precondition
    // (`assert.ok(!get(...).scope)`) can never hold again. Do NOT restore the
    // simpler body-level forgery — it yields a permanently-red precondition that
    // reads like a code defect and is not one. The only surviving drift class is
    // COLUMN CONTRADICTS MOUNT, forged here as a row physically in the PROJECT
    // database whose column names a domain that is not even mounted in this
    // harness.
    const id = randomUUID();
    store.project.create(rawDecisionEnvelope(id, 'domain:unmounted', 'a1-unmounted-project') as never);
    assert.equal(
      get(tools, id).scope,
      'domain:unmounted',
      'precondition: the record READS as an UNMOUNTED domain (column-authoritative) while physically living in the project database'
    );
    assert.ok(store.project.get(id), 'precondition: physically project-held');

    assert.equal(
      affinity(store).scopeOfHolder(id),
      'project',
      'scopeOfHolder answers from the MOUNT alone — it never resolves the label, so a label naming no mounted store is irrelevant rather than an error'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN if scopeOfHolder is genuinely mount-derived.
// SABOTAGE: `return record.scope` -> returns 'domain:unmounted' and this goes
// red. SECOND SABOTAGE, and the one this arm uniquely carries: implement
// scopeOfHolder by resolving the record's LABEL through the mount manifest
// (`storeFor(record.scope).scope`) -> it throws "no such mount: domain:unmounted"
// here, while the A1 drift arm above (label 'domain:node', which IS mounted)
// stays green.
// HONEST NOTE ON OVERLAP: for the plain body-read mutant this arm and the A1
// project-held drift arm above are redundant — the drift arm kills it too. What
// survives that arm and dies here is ONLY the label-resolving mutant. Its
// original job, "an absent field can never default", died with the shape it was
// built on: an absent field is no longer observable anywhere.

test('A1: scopeOfHolder returns "domain:node" for a NODE-held record whose scope COLUMN NAMES AN UNMOUNTED DOMAIN — the holding mount answers, and an unresolvable label is neither consulted nor defaulted', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'a1-unmounted-domain');
  try {
    // WHY THIS CONSTRUCTION CHANGED (2026-09-06) — same abolition as its
    // project-held sibling above: this arm used to strip the `scope` key out of
    // the stored JSON body, and the column-authoritative decoder now refills it
    // from the column on every read, so a scope-less READ is unreachable. Forged
    // instead as the surviving class, column-contradicts-mount, with a column
    // naming a domain this harness does not mount at all.
    const id = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(id, 'domain:unmounted', 'a1-unmounted-domain') as never)
    );
    assert.equal(
      get(tools, id).scope,
      'domain:unmounted',
      'precondition: the record READS as an UNMOUNTED domain while physically living in the node database'
    );
    assert.equal(store.project.get(id), undefined, 'precondition: NOT in the project database');

    assert.equal(
      affinity(store).scopeOfHolder(id),
      'domain:node',
      'the holding mount answers — the label is neither resolved nor fallen back on'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN if scopeOfHolder is genuinely mount-derived.
// SABOTAGE: `return record.scope` -> 'domain:unmounted', red. SECOND SABOTAGE:
// `held-by-project ? 'project' : record.scope` (the EXACT reconstruction the
// governing decision names as the defect) -> 'domain:unmounted', red. THIRD, and
// the one this arm uniquely carries: resolve the LABEL through the mount
// manifest -> throws on an unmounted name, while the A1 domain-held drift arm
// above (label 'project', which resolves) stays green.
// HONEST NOTE ON OVERLAP: the "an absent scope is never defaulted to 'project'"
// claim this arm used to carry is GONE with the shape — an absent scope is no
// longer observable. That half of the contract is now carried entirely by the A1
// drift arm above (a node-held row LABELLED 'project' must still report
// 'domain:node'), which kills the `record.scope ?? 'project'` mutant on its own.

test('A2: scopeOfHolder on an id NO store holds refuses, naming the id', () => {
  const { store, cleanup } = h(['node'], 'a2-unheld');
  try {
    const ghost = randomUUID();
    assert.throws(
      () => affinity(store).scopeOfHolder(ghost),
      (err: Error) => {
        assert.match(err.message, new RegExp(ghost), 'the refusal names the id it could not place — a bare "not found" is unactionable');
        return true;
      },
      'an unheld id must refuse, never return a default scope'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — primitive absent (assert.throws
// DOES catch the TypeError, so the discriminating assertion is the id-naming
// regex, which a TypeError message does not satisfy -> red on that assertion).
// SABOTAGE (once built): return 'project' (or undefined) for an unheld id
// instead of throwing -> "Missing expected exception".
// Wording is deliberately NOT pinned beyond the id itself, per the brief.

// ===========================================================================
// GROUP B — knowledgeSupersede derives the REPLACEMENT's scope from the HOLDER.
//
// The governing decision names the exact defect: the replacement scope was
// reconstructed as `held-by-project ? 'project' : old.scope` — correct for
// project, straight back to the untrusted field for every domain case.
//
// EVERY ARM ASSERTS AGAINST THE PHYSICAL STORE, not only the returned echo: a
// correct echo over a wrongly-placed row is the failure mode this whole file
// exists for (`store.querySource(name, ...)` is the per-PHYSICAL-store
// projection; `store.project.get(id)` is the project database directly).
// ===========================================================================

test('B3 CONTROL: an ordinary PROJECT-held supersede yields a project-scoped replacement, physically in the PROJECT store', () => {
  const { store, tools, cleanup } = h(['node'], 'b3-control');
  try {
    const old = tools.knowledgeCreate('decision', decisionFields('b3-old', 'original statement.')).record as unknown as Loose;
    assert.ok(store.project.get(old.id as string), 'precondition: physically project-held');

    supersede(tools, old.id as string, decisionFields('b3-new', 'replacement statement.'));

    const pinned = get(tools, old.id as string);
    const newId = pinned.superseded_by as string;
    assert.ok(newId, 'the old record forwards to a replacement');
    assert.equal(get(tools, newId).scope, 'project', 'the replacement is project-scoped');
    assert.ok(store.project.get(newId), 'and the replacement ROW physically landed in the project database');
    assert.equal(
      store.querySource('node', { types: ['decision'] }).length,
      0,
      'nothing leaked into the mounted domain store'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN. This is a regression control on already-correct
// behaviour, placed FIRST so that B1/B2's verdicts carry evidence: without it,
// an implementation that put EVERY replacement in the domain store would satisfy
// B1/B2 for entirely the wrong reason and nothing would notice.
// SABOTAGE: route every supersede replacement through the first mounted domain
// store -> this control goes red while B1/B2 stay green — which is exactly the
// discrimination it is here to provide.

test('B1: supersede on a NODE-HELD record whose scope COLUMN SAYS "project" produces a domain:node replacement in the NODE store — never a project-labelled one', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'b1-label-project');
  try {
    // WHY THIS CONSTRUCTION CHANGED (2026-09-06). The source used to be a
    // node-held record with the `scope` key stripped out of its stored body, so
    // that "derive the replacement's scope from the source's field" would read
    // UNDEFINED. The column-authoritative decoder abolished that: the body is
    // refilled from the column on every read, so the field can never be absent
    // again and the old precondition was permanently red. Re-based onto the one
    // surviving drift class, column-contradicts-mount, with the sharpest possible
    // label: the source is PHYSICALLY IN NODE while its column says 'project'.
    // A field-derived implementation therefore produces a PROJECT replacement —
    // exactly the wrong outcome the original arm's title names — and a
    // holder-derived one produces a node one. The intent, the assertion target
    // and the "never a project-labelled one" claim are unchanged.
    const oldId = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(oldId, 'project', 'b1-old', 'original statement.') as never)
    );
    assert.equal(get(tools, oldId).scope, 'project', 'precondition: the source READS as project while its MOUNT is node');
    assert.equal(store.project.get(oldId), undefined, 'precondition: physically domain-held');

    supersede(tools, oldId, decisionFields('b1-new', 'replacement statement.'));

    const newId = get(tools, oldId).superseded_by as string;
    assert.ok(newId, 'the old record forwards to a replacement');
    // THE ECHO...
    assert.equal(get(tools, newId).scope, 'domain:node', 'the replacement carries the HOLDING DOMAIN\'s scope, not project');
    // ...AND THE PHYSICAL ROW. Both, deliberately: a correct label over a row
    // written to the wrong database is the exact failure this pin exists for.
    assert.equal(store.project.get(newId), undefined, 'the replacement ROW must NOT be in the project database');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === newId),
      'the replacement ROW physically landed in the node domain database, beside the record it replaces'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE if the derivation is still field-based — RED BECAUSE
// THE BEHAVIOUR IS WRONG, never because a fixture is unbuildable: the source is
// NOT project-held, so `held-by-project ? 'project' : old.scope` reads the
// drifted label 'project'. Two possible landings, BOTH red:
//   (a) the replacement is created project-scoped and lands in the PROJECT
//       database -> the `scope` equality fires ("expected 'domain:node', got
//       'project'") and the store.project.get / querySource assertions fire; or
//   (b) the cross-mount backstop refuses the write (the transaction opens on the
//       HOLDER, node, while the create routes on the LABEL, project) -> the
//       supersede call throws before any assertion.
// Both are the same defect: the replacement's home was decided by a label.
// GREEN once the replacement scope comes from scopeOfHolder(old.id).
// SABOTAGE (once fixed): change the derivation back to
// `held-by-project ? 'project' : old.scope` -> red again, on (a) or (b) above.
// NOT REDUNDANT WITH B2: B2's label names a DIFFERENT MOUNTED DOMAIN, so its
// field-derived failure is a silent split across two domain databases; B1's
// label says 'project', so its field-derived failure is a chain split across the
// project/domain boundary and it additionally kills any project-defaulting
// shape. Neither mutation is caught by both arms in the same way.

test('B2: supersede on a NODE-held record whose BODY NAMES A DIFFERENT MOUNTED DOMAIN produces a domain:node replacement in the NODE store — the holder wins', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node', 'extra'], 'b2-wrong-domain');
  try {
    // Physically seeded into NODE, labelled `domain:extra` — both mounts are
    // real and both are mounted, so the mislabel names a genuinely reachable
    // OTHER store. That is what makes "the holder wins" a distinguishable claim
    // rather than "an invalid label was rejected".
    const id = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(id, 'domain:extra', 'b2-old', 'original statement.') as never)
    );
    assert.equal(get(tools, id).scope, 'domain:extra', 'precondition: the source READS as domain:extra');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === id),
      'precondition: while physically living in the NODE database'
    );

    supersede(tools, id, decisionFields('b2-new', 'replacement statement.'));

    const newId = get(tools, id).superseded_by as string;
    assert.ok(newId, 'the old record forwards to a replacement');
    assert.equal(get(tools, newId).scope, 'domain:node', 'the replacement takes the HOLDING mount\'s scope, not the body\'s claim');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === newId),
      'the replacement ROW landed in NODE — beside the record it replaces'
    );
    assert.equal(
      store.querySource('extra', { types: ['decision'] }).filter((r) => (r as unknown as Loose).id === newId).length,
      0,
      'and specifically NOT in the domain the drifted body named'
    );
    assert.equal(store.project.get(newId), undefined, 'nor in the project database');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today) — RED BECAUSE CURRENT BEHAVIOUR IS WRONG:
// old.scope is 'domain:extra', which is a MOUNTED, VALID scope, so the create
// succeeds and the replacement lands in the EXTRA store. The `scope` equality
// fires ("expected 'domain:node', got 'domain:extra'"), the node-membership
// assertion fires, and the extra-exclusion assertion fires. Nothing throws —
// this arm produces a SILENT split of a supersede chain across two physical
// databases, which is the whole reason it is worth pinning.
// SABOTAGE (once fixed): derive the replacement scope from `old.scope` again ->
// red. Note this arm is NOT satisfied by defaulting-to-project either: that
// would trip the project-database assertion.

// ===========================================================================
// GROUP C — knowledge_extract's `sourceScope` derives from the HOLDER.
//
// C2 (control) first. C3/C4 pin the MISMATCH-ONLY refusal on
// `new_record.fields.scope`, compared against the PHYSICALLY-derived source
// scope. The governing decision explicitly WITHDREW the broader "refuse any
// explicit scope on extract replacement fields" clause: `new_record.fields` is
// CREATION-shaped, `scope` is legitimate creation input there, and the frozen
// pin knowledge-extract.test.ts:1116 requiring an identical scope to SUCCEED
// was ruled RIGHT by two independent reviews. C3 below is the PHYSICAL
// generalisation of that frozen pin — it must not be read as contradicting it.
// ===========================================================================

test('C2 CONTROL: extract on a PROJECT-held source succeeds and the new record lands in the PROJECT store', () => {
  const { store, tools, cleanup } = h(['node'], 'c2-control');
  try {
    const find = 'the clause that stands alone';
    const source = tools.knowledgeCreate(
      'decision',
      decisionFields('c2-source', `Context before. ${find}. Context after.`)
    ).record as unknown as Loose;

    const raw = runExtract(tools, {
      id: source.id,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionFields('c2-extracted', 'standalone restatement.') },
    });
    assert.ok(raw, 'a project-held extract succeeds');

    const newRec = (tools.knowledgeQuery({ types: ['decision'], cap: 1000 }) as unknown as Loose[]).find(
      (r) => r.slug === 'c2-extracted'
    );
    assert.ok(newRec, 'the extracted record exists');
    assert.ok(store.project.get(newRec!.id as string), 'and its ROW physically landed in the PROJECT database');
    assert.equal(
      store.querySource('node', { types: ['decision'] }).length,
      0,
      'nothing leaked into the mounted domain store'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN (regression control on shipped behaviour).
// It is placed first because C1's verdict — "extract succeeded" — has more than
// one possible cause: an implementation that succeeded for EVERY source
// regardless of placement would satisfy C1 identically. This control fails
// under exactly that mutant if placement is wrong, so a green C1 carries
// evidence.
// SABOTAGE: route every extract's new record into the first mounted domain
// store -> this control goes red on the store.project.get assertion.

test('C1: extract on a NODE-HELD source whose scope COLUMN SAYS "project" SUCCEEDS, landing the new record in that SAME node store', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'c1-label-project');
  try {
    // WHY THIS CONSTRUCTION CHANGED (2026-09-06). The source used to be a
    // node-held record with `scope` stripped from its stored body, making the
    // field-derived `sourceScope` undefined. The column-authoritative decoder
    // abolished that shape (the body is refilled from the column on every read),
    // so the arm failed at its precondition rather than at its assertion.
    // Re-based onto column-contradicts-mount: the source is PHYSICALLY IN NODE
    // and LABELLED 'project'. The pin's intent is untouched — a valid extraction
    // on a domain-held source must SUCCEED and land beside its source, never be
    // turned into a refusal (the governing decision rejects that outcome by name,
    // alternative 5) and never be routed by the label.
    const find = 'the domain-owned clause that stands alone';
    const sourceId = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(sourceId, 'project', 'c1-source', `Context before. ${find}. Context after.`) as never)
    );
    assert.equal(get(tools, sourceId).scope, 'project', 'precondition: the source READS as project while its MOUNT is node');
    assert.equal(store.project.get(sourceId), undefined, 'precondition: physically domain-held');
    const beforeNodeDecisions = store.querySource('node', { types: ['decision'] }).length;

    const raw = runExtract(tools, {
      id: sourceId,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionFields('c1-extracted', 'standalone restatement.') },
    });
    assert.ok(raw, 'a domain-held source whose label contradicts its holder is EXTRACTABLE — the governing decision rejected turning this into a refusal (alternative 5)');

    const after = get(tools, sourceId);
    assert.equal(after.statement, 'Context before. . Context after.', 'the source field was trimmed in place');

    const nodeDecisions = store.querySource('node', { types: ['decision'] }) as unknown as Loose[];
    assert.equal(nodeDecisions.length, beforeNodeDecisions + 1, 'exactly one new decision landed in the NODE database');
    const newRec = nodeDecisions.find((r) => r.slug === 'c1-extracted');
    assert.ok(newRec, 'and it is the extracted record — not some other row');
    assert.equal(store.project.get(newRec!.id as string), undefined, 'the extracted record did NOT land in the project database');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE if `sourceScope` is still field-derived — RED BECAUSE
// THE BEHAVIOUR IS WRONG: `held-by-project ? 'project' : original.scope` reads
// the drifted label 'project' on a node-held source, so either the new record is
// routed to the PROJECT database (the node-count and project-absence assertions
// fire) or the affinity backstop refuses the cross-mount write and turns a VALID
// extraction into a REFUSAL — the call THROWS and the test fails at
// `runExtract(...)` before `assert.ok(raw, ...)`. The governing decision names
// that second outcome by name in alternative 5 ("turning a valid extraction into
// a refusal rather than making it work") and REJECTS it.
// GREEN once sourceScope comes from scopeOfHolder(source.id).
// SABOTAGE (once fixed): derive sourceScope from the record's scope field again
// -> red on `raw` (refusal) or on the node-membership assertion (wrong database).

test('C3: extract with an explicit new_record scope IDENTICAL to the PHYSICALLY-derived source scope SUCCEEDS — even when the source LABEL says something else', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'c3-identical');
  try {
    // WHY THIS CONSTRUCTION CHANGED (2026-09-06). The source used to be a
    // node-held record with its body `scope` stripped, so that "the only
    // remaining way to know this source is domain:node is the mount" held. The
    // column-authoritative decoder abolished that (the body is refilled from the
    // column on read), so it is re-based onto column-contradicts-mount: the
    // source is PHYSICALLY IN NODE and LABELLED 'project', and the explicit
    // new_record scope below is 'domain:node' — IDENTICAL to the physically
    // derived scope and DIFFERENT from the label. That makes this arm STRICTLY
    // SHARPER than the shape it replaces and the exact mirror of C4: C3 =
    // explicit matches HOLDER, contradicts label -> must SUCCEED; C4 = explicit
    // matches LABEL, contradicts holder -> must REFUSE. Together they pin that
    // the comparison is against the holder in both directions; neither alone can.
    // Still the physical generalisation of the frozen pin at
    // knowledge-extract.test.ts:1116 (identical scope SUCCEEDS), not a
    // contradiction of it.
    const find = 'the clause whose explicit scope matches its holder';
    const sourceId = randomUUID();
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(sourceId, 'project', 'c3-source', `Context before. ${find}. Context after.`) as never)
    );
    assert.equal(get(tools, sourceId).scope, 'project', 'precondition: the label says project — only the MOUNT knows this record is domain:node');
    assert.equal(store.project.get(sourceId), undefined, 'precondition: physically held by the node database');

    const raw = runExtract(tools, {
      id: sourceId,
      field: 'statement',
      find,
      new_record: {
        type: 'decision',
        fields: { ...decisionFields('c3-extracted', 'standalone restatement.'), scope: 'domain:node' },
      },
    });
    assert.ok(raw, 'an explicit scope IDENTICAL to the physically-derived source scope must SUCCEED — the unconditional refusal was withdrawn by the governing decision');
    assert.ok(
      (store.querySource('node', { types: ['decision'] }) as unknown as Loose[]).some((r) => r.slug === 'c3-extracted'),
      'and the record lands in the node database'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE if `sourceScope` is still field-derived — the same
// defect as C1: the derived source scope is the label 'project', the explicit
// 'domain:node' is compared against it and refused as a mismatch (or the affinity
// backstop refuses first). Either way `runExtract` THROWS and the test fails
// before `assert.ok(raw, ...)`. RED BECAUSE THE BEHAVIOUR IS WRONG.
// GREEN once the comparison is against scopeOfHolder(source.id).
// SABOTAGE (once fixed): reinstate the withdrawn unconditional refusal of ANY
// explicit new_record.fields.scope -> red here (and red on the frozen pin at
// knowledge-extract.test.ts:1116, which is the cross-check that the withdrawal
// really is the governing rule). SECOND SABOTAGE, NEW WITH THIS CONSTRUCTION AND
// NOT AVAILABLE UNDER THE OLD ONE: compare the explicit scope against the
// record's scope FIELD instead of the holder -> 'domain:node' vs 'project' is a
// mismatch, the extract refuses, and this goes red. Under the old body-stripped
// shape that same mutation compared against `undefined` and its outcome depended
// on how undefined was handled; here it is unambiguous.

test('C4: extract with an explicit new_record scope MISMATCHING the PHYSICAL source scope is REFUSED — even when it matches the drifted body', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node', 'extra'], 'c4-mismatch');
  try {
    const find = 'the clause whose explicit scope contradicts its holder';
    const id = randomUUID();
    // Physically NODE, body+column claim EXTRA (both mounts real). The explicit
    // scope below is 'domain:extra' — which AGREES with the drifted body and
    // DISAGREES with the holder. A body-derived implementation sees "identical"
    // and accepts; a holder-derived one sees a mismatch and refuses. That is the
    // only construction that separates the two.
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(id, 'domain:extra', 'c4-source', `Context before. ${find}. Context after.`) as never)
    );
    assert.equal(get(tools, id).scope, 'domain:extra', 'precondition: the body claims domain:extra');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === id),
      'precondition: while physically held by NODE'
    );
    const before = get(tools, id);
    const beforeExtra = store.querySource('extra', { types: ['decision'] }).length;

    assert.throws(
      () =>
        runExtract(tools, {
          id,
          field: 'statement',
          find,
          new_record: {
            type: 'decision',
            fields: { ...decisionFields('c4-extracted', 'standalone restatement.'), scope: 'domain:extra' },
          },
        }),
      (err: Error) => {
        assert.match(
          err.message,
          /domain:node/,
          'the refusal names the PHYSICALLY-derived source scope — otherwise the caller cannot tell which of the two disagreeing values won'
        );
        return true;
      },
      'an explicit scope that contradicts the HOLDER must be refused, however well it matches the body'
    );

    assert.deepEqual(get(tools, id), before, 'the source is byte-identical after the refused extract');
    assert.equal(
      (store.querySource('extra', { types: ['decision'] }) as unknown as Loose[]).length,
      beforeExtra,
      'no orphan record landed in the domain the body named'
    );
    assert.ok(!decisionSlugs(tools).includes('c4-extracted'), 'and none anywhere else either');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today) — RED BECAUSE CURRENT BEHAVIOUR IS WRONG:
// sourceScope is read from the body ('domain:extra'), the explicit scope is
// identical to it, the mismatch guard therefore does NOT fire, and the extract
// proceeds -> "Missing expected exception" from assert.throws. (If the affinity
// backstop instead refuses on the label/holder disagreement, the throw fires but
// the message will not name 'domain:node' and the regex assertion goes red —
// which is the point of asserting on the DERIVED value rather than merely on
// "something threw": a refusal that cannot say which scope it derived is not
// evidence that it derived the right one.)
// SABOTAGE (once fixed): compare the explicit scope against `original.scope`
// instead of scopeOfHolder(id) -> "Missing expected exception".

// ===========================================================================
// GROUP D — the pin a review specifically asked for: an ancestor-pointing
// promotion_review item against a DOMAIN-HELD supersede chain, across two real
// mounts, must refuse and roll back COMPLETELY. Today this refusal rests on an
// unreachability ARGUMENT with no test.
//
// HONEST DISCLOSURE ABOUT WHAT D1 DOES AND DOES NOT PROVE (the brief's
// "say so explicitly instead of claiming it is load-bearing alone"):
// D1's refusal has TWO INDEPENDENTLY SUFFICIENT CAUSES in the current design —
//   (i) the domain-source + non-empty-resolves bar (pinned already by
//       knowledge-extract.test.ts's "domain source + resolves" arm), and
//   (ii) the promotion_review LANE bar (pinned already, on a PROJECT source, by
//       knowledge-extract.test.ts invariant 6).
// Removing EITHER ONE alone leaves D1 GREEN. That is defence in depth, not a
// hollow pin, and it is stated here rather than glossed: what D1 uniquely
// carries is ROLLBACK COMPLETENESS across TWO PHYSICAL MOUNTS with a
// genuinely on-chain, ancestor-pointing item — the created record, the source
// trim, BOTH provenance edges and the resolves-drain, all absent afterwards.
// The mutation that turns D1 red on its own is a partial/non-atomic refusal
// path, named in the sabotage below.
// ===========================================================================

test('D CONTROL: the same two-mount, domain-held supersede chain extracts SUCCESSFULLY when no resolves claim is made', () => {
  const { store, tools, cleanup } = h(['node', 'extra'], 'd-control');
  try {
    const find = 'the terminus clause that stands alone';
    const ancestor = tools.knowledgeCreate('decision', {
      ...decisionFields('d-ctl-ancestor', 'the ancestor statement.'),
      scope: 'domain:node',
    }).record as unknown as Loose;
    supersede(tools, ancestor.id as string, decisionFields('d-ctl-terminus', `Context before. ${find}. Context after.`));
    const terminusId = get(tools, ancestor.id as string).superseded_by as string;
    assert.ok(terminusId, 'precondition: a two-link supersede chain exists');
    assert.equal(store.project.get(terminusId), undefined, 'precondition: the live terminus is domain-held, not project-held');

    const raw = runExtract(tools, {
      id: terminusId,
      field: 'statement',
      find,
      new_record: { type: 'decision', fields: decisionFields('d-ctl-extracted', 'standalone restatement.') },
    });
    assert.ok(raw, 'the fixture is extractable on its own — so D1\'s refusal below is caused by the resolves claim, not by the chain, the mounts, or the fixture');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN if knowledgeSupersede places the replacement in
// the node store (it should: the ancestor's body scope is intact here, so both
// the current body-derived rule and the specified holder-derived rule agree) —
// this control is deliberately built WITHOUT drift so it is stable across the
// fix. If it is RED today it means the domain-source extract path is broken more
// broadly than C1 describes, which is itself the finding, and D1's verdict must
// not be read until it is green.
// SABOTAGE: refuse every extract whose source sits on a supersede chain, or
// every extract on a domain-held source -> this control goes red while D1 stays
// green, exposing D1 as passing for the wrong reason.

test('D1: an ancestor-pointing promotion_review item on a DOMAIN-HELD chain refuses the whole extract and rolls back completely — no record, no trim, no edges, no drain', () => {
  const { store, tools, cleanup } = h(['node', 'extra'], 'd1-promotion-review');
  try {
    const find = 'the terminus clause guarded by a human gate';
    const ancestor = tools.knowledgeCreate('decision', {
      ...decisionFields('d1-ancestor', 'the ancestor statement.'),
      scope: 'domain:node',
    }).record as unknown as Loose;
    supersede(tools, ancestor.id as string, decisionFields('d1-terminus', `Context before. ${find}. Context after.`));
    const terminusId = get(tools, ancestor.id as string).superseded_by as string;
    assert.ok(terminusId, 'precondition: a two-link supersede chain exists');
    assert.equal(store.project.get(terminusId), undefined, 'precondition: the live terminus is domain-held');
    assert.equal(get(tools, ancestor.id as string).status, 'superseded', 'precondition: the ancestor is the PRE-SUPERSESSION member of the chain');

    // The item points at the ANCESTOR, not at the terminus — the on-chain
    // reachability the review asked about. Built entirely through the tool
    // surface (maintenance_enqueue takes both `reason` and `feature_link` per
    // knowledge_schema('todo')); nothing here is a hand-written row.
    const item = tools.maintenanceEnqueue({
      reason: 'promotion_review',
      text: `promotion review pending for the ancestor of ${terminusId}`,
      file_keys: [],
      feature_link: ancestor.id as string,
    });

    const beforeTerminus = get(tools, terminusId);
    const beforeAncestor = get(tools, ancestor.id as string);
    const beforeNode = store.querySource('node', { types: ['decision'] }).length;
    const beforeExtra = store.querySource('extra', { types: ['decision'] }).length;

    assert.throws(
      () =>
        runExtract(tools, {
          id: terminusId,
          field: 'statement',
          find,
          new_record: { type: 'decision', fields: decisionFields('d1-extracted', 'standalone restatement.') },
          resolves: [item.record.id],
        }),
      Error,
      'a promotion_review item — a HUMAN GATE — must never drain through an extract, on-chain or not'
    );

    // --- ROLLBACK, all four legs, checked physically ---
    assert.deepEqual(get(tools, terminusId), beforeTerminus, 'the source trim did not land: the terminus is byte-identical (this also covers the source->cites->new provenance edge, which lives in links)');
    assert.deepEqual(get(tools, ancestor.id as string), beforeAncestor, 'the pre-supersession ancestor is untouched too');
    assert.ok(!decisionSlugs(tools).includes('d1-extracted'), 'no created record survives ANYWHERE across the project store and both mounts');
    assert.equal(store.querySource('node', { types: ['decision'] }).length, beforeNode, 'the node database gained nothing');
    assert.equal(store.querySource('extra', { types: ['decision'] }).length, beforeExtra, 'the extra database gained nothing');
    assert.ok(openIds(tools).includes(item.record.id), 'the resolves-drain did not happen: the promotion_review item is still open');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE TODAY: GREEN — and the header above says exactly why that green
// is weaker than it looks (two independently sufficient guards). What it pins
// that nothing else does is the ATOMICITY of the refusal across two physical
// mounts with an ancestor-pointing item.
// SABOTAGE (the one that turns THIS test red on its own): move the resolves
// lane/chain validation from BEFORE the write to AFTER it — i.e. run
// knowledgeCreate + the source update + the link writes first and validate the
// resolves claim last — so the call still throws but the created record, the
// trimmed statement and the cites edge have already committed. The
// `decisionSlugs`/`querySource`/`deepEqual` assertions then fire while the
// `assert.throws` still passes. That mutation is invisible to every other
// resolves pin in the suite, because none of them spans two physical mounts.
// SECOND SABOTAGE (kills the lane half, but only in company with
// knowledge-extract.test.ts invariant 6): gate resolves on chain membership
// alone without checking the item's `reason` -> the item drains, the last
// assertion goes red.

// ===========================================================================
// GROUP E — holder resolution FAILS LOUDLY on a duplicate id.
//
// The governing decision: "storeHolding resolves a DUPLICATE id project-first
// (or first-in-manifest-order) WITHOUT detecting the ambiguity — it must fail
// loudly on multiple holders, because every other guarantee here assumes a
// single holder." Silently picking project-first is exactly how a
// holder-derived write lands in the wrong database while every echo looks right.
// ===========================================================================

test('E2 CONTROL: a normal single-holder id resolves cleanly through holder resolution', () => {
  const { store, tools, cleanup } = h(['node'], 'e2-control');
  try {
    const rec = tools.knowledgeCreate('decision', {
      ...decisionFields('e2-single', 's'),
      scope: 'domain:node',
    }).record as unknown as Loose;

    assert.equal(affinity(store).scopeOfHolder(rec.id as string), 'domain:node', 'a single holder resolves without refusing');
    assert.equal(
      affinity(store).withTransactionForRecord(rec.id as string, () => 'ran'),
      'ran',
      'and the transaction router accepts it too — the same resolver, exercised on both surfaces'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — neither primitive exists yet.
// WHY THIS CONTROL IS REQUIRED: E1's verdict is "holder resolution refused".
// That has more than one possible cause — an implementation that refused EVERY
// id would satisfy E1 identically and pin nothing. This control must pass for
// the OPPOSITE reason (a clean resolve), so a green E1 carries its evidence.
// SABOTAGE: make the multi-holder guard refuse whenever the id is found at all
// (e.g. compare a count with `>= 1` instead of `> 1`) -> this control goes red
// while E1 stays green — the precise discrimination it exists for.

test('E1: an id present in TWO mounted stores makes holder resolution REFUSE, naming the id and BOTH holders — never a silent project-first pick', () => {
  const { store, domainDbPath, tools, cleanup } = h(['node'], 'e1-duplicate');
  try {
    const dupId = randomUUID();
    // The SAME id written into two separate physical databases. Unreachable
    // through the tool surface by construction (routing places a record in
    // exactly one store), so it is seeded raw into each — which is precisely the
    // corrupt-store condition the guard exists for.
    store.project.create(rawDecisionEnvelope(dupId, 'project', 'e1-dup-project') as never);
    inDomainDb(domainDbPath('node'), (dh) =>
      dh.create(rawDecisionEnvelope(dupId, 'domain:node', 'e1-dup-node') as never)
    );
    assert.ok(store.project.get(dupId), 'precondition: held by the project database');
    assert.ok(
      store.querySource('node', { types: ['decision'] }).some((r) => (r as unknown as Loose).id === dupId),
      'precondition: AND by the node database'
    );

    assert.throws(
      () => affinity(store).scopeOfHolder(dupId),
      (err: Error) => {
        assert.match(err.message, new RegExp(dupId), 'the refusal names the ambiguous id');
        assert.match(err.message, /project/, 'and names the project holder');
        assert.match(err.message, /node/, 'and names the node holder — "all holders", so the operator can repair the right one');
        return true;
      },
      'a duplicate id must refuse, not resolve project-first'
    );

    assert.throws(
      () => affinity(store).withTransactionForRecord(dupId, () => 'ran'),
      (err: Error) => {
        assert.match(err.message, new RegExp(dupId), 'the transaction router shares the same holder resolution and refuses identically');
        return true;
      },
      'the ambiguity must be detected wherever holder resolution happens, not only in the accessor'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError — primitives absent. assert.throws
// DOES catch a TypeError, so the discriminating assertions are the three regexes
// (id / project / node), which "store.scopeOfHolder is not a function" does not
// satisfy -> red on the id regex.
// SABOTAGE (once built): return the FIRST holder found (project-first, or
// first-in-manifest-order) instead of detecting multiplicity -> "Missing
// expected exception" on the first assert.throws.
// LOAD-BEARING NOTE: the two arms are NOT redundant defence-in-depth — they
// exercise two different call sites of the same resolver, and the decision
// requires both. If the implementation shares one private resolver, a single
// mutation reddens both; if it does not, only one reddens, and that difference
// is itself the finding.

// ===========================================================================
// GROUP F — withTransactionForRecord(id, fn) routes by PHYSICAL HOLDER, and the
// backstop refuses a cross-mount WRITE inside the transaction while PERMITTING
// cross-store READS.
//
// The decision is explicit that both halves are the contract: "refusing
// cross-mount writes; ... while cross-store READS stay allowed". A backstop that
// refused reads too would be a different, wrong mechanism that a
// refusal-only pin could not tell apart — hence the read arm sits inside the
// CONTROL, where it must SUCCEED.
// ===========================================================================

test('F2 CONTROL: inside withTransactionForRecord, a SAME-MOUNT write commits and a CROSS-STORE READ is permitted', () => {
  const { store, tools, cleanup } = h(['node'], 'f2-control');
  try {
    const anchor = tools.knowledgeCreate('decision', decisionFields('f2-anchor', 's')).record as unknown as Loose;
    const domainRec = tools.knowledgeCreate('decision', {
      ...decisionFields('f2-domain-neighbour', 's'),
      scope: 'domain:node',
    }).record as unknown as Loose;
    assert.ok(store.project.get(anchor.id as string), 'precondition: the anchor is project-held, so the transaction opens on the project database');

    let readBack: Loose | undefined;
    const outcome = affinity(store).withTransactionForRecord(anchor.id as string, () => {
      // CROSS-STORE READ — must be permitted, not refused.
      readBack = get(tools, domainRec.id as string);
      // SAME-MOUNT WRITE — project-scoped, same database the transaction opened on.
      tools.knowledgeCreate('decision', decisionFields('f2-committed', 'written inside the transaction.'));
      return 'committed';
    });

    assert.equal(outcome, 'committed', 'the callback\'s return value is passed through');
    assert.ok(readBack, 'the cross-store read returned a record rather than throwing');
    assert.equal(readBack!.id, domainRec.id, 'and it is the domain-held record — reads genuinely span mounts inside the transaction');
    assert.ok(decisionSlugs(tools).includes('f2-committed'), 'the same-mount write COMMITTED');
    const committed = (tools.knowledgeQuery({ types: ['decision'], cap: 1000 }) as unknown as Loose[]).find(
      (r) => r.slug === 'f2-committed'
    );
    assert.ok(store.project.get(committed!.id as string), 'and its ROW is in the project database — the mount the anchor id selected');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): `TypeError: store.withTransactionForRecord
// is not a function` — the primitive does not exist yet. Red-because-absent.
// WHY IT MUST BE FIRST: F1 proves "a write was refused". An implementation whose
// backstop refused EVERY write, or every cross-store operation including reads,
// would satisfy F1 identically and be badly wrong. This control must pass for
// the opposite reason.
// SABOTAGE (once built): make the backstop refuse cross-store READS as well as
// writes -> the `readBack` line throws and this control goes red while F1 stays
// green. SECOND SABOTAGE: route withTransactionForRecord by a LABEL instead of
// the holder -> the anchor's own mount is no longer the transaction's mount and
// the same-mount write becomes a cross-mount one, reddening the commit
// assertions.

test('F1: a CROSS-MOUNT write inside withTransactionForRecord is refused AND the outer transaction rolls back — nothing from either side survives', () => {
  const { store, tools, cleanup } = h(['node'], 'f1-cross-mount');
  try {
    const anchor = tools.knowledgeCreate('decision', decisionFields('f1-anchor', 's')).record as unknown as Loose;
    assert.ok(store.project.get(anchor.id as string), 'precondition: the anchor is project-held');
    // NOT ceremony — the anti-vacuous guard. Every assertion after the
    // assert.throws below is satisfied when the callback NEVER RUNS, and
    // assert.throws happily accepts a `TypeError: ... is not a function`. Without
    // this line the whole test passes GREEN against a tree where the primitive
    // does not exist, which is the hollow shape this file is written to avoid.
    assert.equal(
      typeof (store as unknown as Record<string, unknown>).withTransactionForRecord,
      'function',
      'EXPECTED FAILURE (red): MountedStores.withTransactionForRecord does not exist yet — this assertion is what makes that red instead of a vacuous green'
    );
    const beforeNode = store.querySource('node', { types: ['decision'] }).length;

    assert.throws(
      () =>
        affinity(store).withTransactionForRecord(anchor.id as string, () => {
          // (1) A legitimate SAME-MOUNT write, which would succeed on its own —
          //     it is here so the rollback has something to undo. Without it,
          //     "nothing survives" would be trivially true.
          tools.knowledgeCreate('decision', decisionFields('f1-same-mount', 'same-mount write.'));
          // (2) The CROSS-MOUNT write the backstop must refuse.
          tools.knowledgeCreate('decision', {
            ...decisionFields('f1-cross-mount', 'cross-mount write.'),
            scope: 'domain:node',
          });
          return 'should never be reached';
        }),
      Error,
      'a write resolving to a different physical store than the active transaction\'s must be refused'
    );

    const slugs = decisionSlugs(tools);
    assert.ok(!slugs.includes('f1-cross-mount'), 'the refused cross-mount write left nothing behind');
    assert.ok(
      !slugs.includes('f1-same-mount'),
      'AND the legitimate same-mount write rolled back too — the refusal aborts the OUTER transaction, it does not merely skip the offending statement'
    );
    assert.equal(
      store.querySource('node', { types: ['decision'] }).length,
      beforeNode,
      'the node database is physically unchanged'
    );
    assert.ok(store.project.get(anchor.id as string), 'the anchor itself survives — the rollback undoes the transaction, not the fixture');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): the `typeof ... === 'function'` guard
// fires — "MountedStores.withTransactionForRecord does not exist yet".
// Red-because-absent, on an ASSERTION rather than a crash.
// WHY THE GUARD IS THERE: every assertion after the assert.throws is satisfied
// when the callback never runs, and assert.throws accepts a `TypeError: ... is
// not a function` as a perfectly good exception — so without the guard this test
// would report GREEN against a tree with no implementation at all. It is the one
// place in this file where the natural red is a false green.
// SABOTAGE (once built): drop the assertMountAffinity backstop from the
// scope-routed create() path -> "Missing expected exception". SECOND SABOTAGE
// (the one the first would hide): keep the backstop but let it throw AFTER the
// same-mount write has been committed independently (i.e. do not run the two
// writes in one transaction) -> the `f1-same-mount` assertion goes red while the
// `f1-cross-mount` one stays green.
