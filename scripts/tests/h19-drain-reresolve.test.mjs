// H19 DELIVERY LIFECYCLE-STATUS + DRAIN RE-RESOLVE — SPEC ONLY, red-first.
// Build slice S2a, board 2e8be2c3. Feature is UNBUILT at authoring time.
//
// GOVERNING SPEC (read directly, never inferred from implementation):
// decision db3392db-4118-474c-a2f8-e29ccea50eff
// (slug delivery-lifecycle-and-drain-reresolve-design). Where this file and
// the dispatched ACs differ, the decision wins — divergences are called out
// inline at the test that hits them.
//
// H4 COMPLIANCE: scripts/hooks/lib/delivery.mjs, scripts/hooks/h19-delivery-
// drain.mjs and scripts/hooks/h19-knowledge-delivery.mjs were NOT read to
// author this file. Every fixture below is built from (a) the governing
// decision's prose, (b) prior sibling test files (h19-delivery.test.mjs,
// h19-delivery-oversize.test.mjs, h20-deny-once.test.mjs, h23-output-axis
// .test.mjs, h10-recompute-store-failure.test.mjs) read for HARNESS
// CONVENTION and PROVEN fixture shapes only, and (c) knowledge_schema /
// measured-defects-n25-n26-n28.test.ts for the raw envelope shape a record
// may legally carry at the STORE layer (not the MCP tools layer, which is a
// stricter subset).
//
// THREE DELIBERATE FIXTURE TECHNIQUES, each disclosed once here rather than
// per-test, because each is a genuine departure from the plainer
// `store.create()`-only convention every other hook test file uses:
//
//  (1) RAW STATUS ENVELOPES. `store.create()` — the raw SterlingStore method
//      every hook test in this repo already calls directly — accepts a full
//      envelope object with NO server-owned-field refusal of its own (that
//      refusal lives at the wrapped MCP tools layer, SterlingTools.
//      knowledgeCreate, which this file never calls for plain creates).
//      packages/mcp-server/src/tests/measured-defects-n25-n26-n28.test.ts
//      confirms this directly: it seeds a record via `store.create({...,
//      status: 'flagged_stale', ...})` to reach a state "no legitimate
//      tool-surface call" can produce, calling this "the LEGACY-HONORED
//      shape resolveIdentity reads directly". This file uses the identical
//      technique for `status: 'superseded'` (same enum, same code path) to
//      construct non-active fixtures where the record must be non-active
//      the moment it is first queried — never where a genuine ACTIVE-then-
//      MUTATED sequence matters (that is technique (2)).
//
//  (2) SterlingTools FOR GENUINE POST-ENQUEUE MUTATION. AC3's primary arm
//      needs a record that is ACTIVE when H19 enqueues it (so the cached
//      payload captures real active content) and ONLY THEN becomes
//      superseded — a literal "went stale between enqueue and drain" race,
//      which technique (1) cannot produce (you cannot un-create a record).
//      packages/mcp-server/dist/tools.js ships a built `SterlingTools`
//      class (constructor `{store, now}`, proven in every mcp-server test)
//      whose `knowledgeSupersede(old_id, fields)` is the exact production
//      code path `knowledge_supersede` calls: it flips the OLD id's status
//      to 'superseded' IN PLACE (same row, same id — packages/mcp-server/
//      src/tests/knowledge-supersede.test.ts, AC5) while minting a genuinely
//      new successor. This file wires one `SterlingTools` instance to the
//      SAME `SterlingStore`/db file the hook subprocess reads, exactly the
//      way every other hook test already lets a same-process store.create()
//      call be seen by a spawned hook subprocess.
//
//  (3) SCHEMA-DISCOVERY RAW SQL, for the one case neither (1) nor (2) can
//      reach: a record that no longer resolves AT ALL. Sterling has no
//      hard-delete for ruling records (knowledge_retire/knowledge_supersede
//      both keep the old id resolving as a tombstone; CLAUDE.md: "cleanup
//      never hard-deletes knowledge"). `hardDeleteRecord()` below opens the
//      sqlite file directly (node:sqlite DatabaseSync — the same primitive
//      scripts/tests/h10-recompute-store-failure.test.mjs already uses for
//      a different injection) and DISCOVERS the table holding an `id`
//      column at RUNTIME via `sqlite_master`/`PRAGMA table_info`, rather
//      than assuming a table/column name read from source. This is a
//      fixture-construction technique, not an assertion about the
//      implementation, and it is guarded by an explicit fixture-sanity
//      assertion (`deleted >= 1`) at every call site.
//
// WHAT IS NOT PINNED HERE, AND WHY (report this to the conductor):
//   - AC8's CLAIM-ATOMICITY half ("an enqueue that lands after the drain's
//     claim but before it finishes is not lost") requires a genuine
//     concurrent race with no known, safe injection point from a black-box
//     subprocess harness (unlike H10's git-shim injection, nothing here is
//     known to shell out to an interceptable subprocess mid-drain), and a
//     real wall-clock race would violate the determinism rubric (no timing
//     races). Only AC8's CONTAINMENT half (a per-entry render failure does
//     not lose the rest of the batch) is pinned below.
//   - "retired" as a distinct lifecycle dimension (lifecycle:'retired' with
//     status left 'active') is not separately pinned: the bracket format
//     proven by h20-deny-once.test.mjs is keyed on `status`+`scope`
//     (+superseded_by), never `lifecycle`, so a lifecycle-only fixture would
//     not exercise the annotation at all. "superseded" (status field) is
//     pinned fully instead, which is what the bracket format actually reads.
//
// RED-BEFORE-THE-FIX is asserted per test in a trailing comment: which
// assertion fires today, and the one-line SABOTAGE that must reproduce that
// same red once the feature is built (mutation-verification, decision
// a-ruling-change-is-verified-by-mutation-not-by-a-green-suite).
//
// NO RED OUTPUT IS CLAIMED FROM THIS AUTHOR: the test-writer holds no Bash.
// Run with: node --test scripts/tests/h19-drain-reresolve.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-31T12:00:00.000Z';

let SterlingStore;
let SterlingTools;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SterlingTools } = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'tools.js')).href));
});

// ---------------------------------------------------------------------------
// Harness (idiom mirrored from h19-delivery.test.mjs / h23-output-axis.test.mjs)
// ---------------------------------------------------------------------------

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function drain(dir) {
  return runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
}

function ctxOf(r) {
  if (!r.stdout) return '';
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return r.stdout;
  }
}

function envelope(type, extra = {}) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    ...extra,
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

function decisionRec(statement, paths, extra = {}) {
  return {
    ...envelope('decision'),
    title: statement,
    statement,
    alternatives_rejected: [],
    rationale: `${statement} rationale`,
    file_keys: paths,
    ...extra,
  };
}

function makeProject({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-drain-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  const cleanup = () => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, dbPath, closeStore, cleanup };
}

function mkTools(store) {
  return new SterlingTools({ store, now: () => NOW });
}

const pendingPath = (dir) => join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
const pendingOf = (dir) => (existsSync(pendingPath(dir)) ? JSON.parse(readFileSync(pendingPath(dir), 'utf8')) : []);

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

const postBash = (dir, command, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd: dir,
  ...extra,
});

/**
 * Technique (3): discovers the table holding an `id` column at RUNTIME (never
 * assumed from source) and deletes the matching row(s). Returns the number of
 * rows removed across all discovered tables, so every call site can assert
 * `>= 1` as a fixture-sanity check rather than trusting a silent no-op.
 */
function hardDeleteRecord(dbPath, id) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    let deleted = 0;
    for (const t of tables) {
      let cols;
      try {
        cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      } catch {
        continue;
      }
      if (cols.includes('id')) {
        try {
          const info = db.prepare(`DELETE FROM "${t}" WHERE id = ?`).run(id);
          deleted += info.changes ?? 0;
        } catch {
          // not every table with an `id` column is necessarily writable this way
        }
      }
    }
    return deleted;
  } finally {
    db.close();
  }
}

// The exact bracket grammar h20-deny-once.test.mjs proves the deny-once
// formatter uses: `[status·scope]` or `[status·scope, superseded_by: <id>]`.
// Reused VERBATIM (not re-derived) so a pass here means "the same formatter",
// not "a formatter that happens to look similar".
function supersededBracket(scope, supersededBy) {
  return new RegExp(`\\[superseded·${scope}, superseded_by: ${supersededBy}\\]`);
}

// ===========================================================================
// AC1 + AC2 — STATUS ANNOTATION, ONE FORMATTER
// ===========================================================================

test('AC1 (control): an ACTIVE anti_pattern hazard pointer carries NO status/scope bracket at all', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('ac1-active-hazard', ['src/a.mjs']));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = ctxOf(r);
    const line = ctx.split('\n').find((l) => l.includes('ac1-active-hazard'));
    assert.ok(line, 'the hazard header line renders');
    assert.doesNotMatch(line, /\[active·project\]/, 'an ACTIVE record carries no status annotation at all');
    assert.doesNotMatch(line, /\[superseded/, 'nor any other status token');
  } finally {
    cleanup();
  }
});
// RED TODAY: passes vacuously today (no annotation exists at all yet), so this
// is a CONTROL that must stay green both before and after the fix.
// SABOTAGE: annotate every record unconditionally, including active ones —
// this test goes red on the doesNotMatch(/\[active·project\]/) assertion.

test('AC1 (delivery kind — RE-AIMED per conductor repair 2026-08-31, item 1: a superseded record never reaches a live query at all, packages/store/src/index.ts:1987 / store.test.ts:245 §3.2.4, so the annotation is only observable at the DRAIN\'s re-resolve): control - a still-active decision drains with no bracket; case - the same decision queued while active via the real producer hook, then superseded, drains as a stub carrying [superseded·scope, superseded_by]', () => {
  // CONTROL first.
  const ctl = makeProject({ rung: 'prompt' });
  try {
    ctl.store.create(article('owner-ctl', ['src/a.mjs']));
    const toolsCtl = mkTools(ctl.store);
    toolsCtl.knowledgeCreate('decision', {
      title: 'ac1-delivery-ctl',
      statement: 'AC1_DELIVERY_CTL_BODY_SENTINEL',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    });
    const enqCtl = runHook('h19-knowledge-delivery.mjs', postRead(ctl.dir, 'src/a.mjs'), ctl.dir);
    assert.equal(enqCtl.code, 0, enqCtl.stderr);
    const dCtl = drain(ctl.dir);
    assert.equal(dCtl.code, 0, dCtl.stderr);
    const ctxCtl = ctxOf(dCtl);
    assert.match(ctxCtl, /AC1_DELIVERY_CTL_BODY_SENTINEL/, 'the still-active decision drains served');
    assert.doesNotMatch(ctxCtl, /\[active·project\]/, 'an active record carries no bracket at all');
    assert.doesNotMatch(ctxCtl, /\[superseded/, 'nor any superseded token');
  } finally {
    ctl.cleanup();
  }

  // CASE — the AC3 technique: active at enqueue, superseded strictly after.
  const kase = makeProject({ rung: 'prompt' });
  try {
    kase.store.create(article('owner-case', ['src/a.mjs']));
    const tools = mkTools(kase.store);
    const original = tools.knowledgeCreate('decision', {
      title: 'ac1-delivery-case',
      statement: 'AC1_DELIVERY_CASE_STALE_BODY_SENTINEL',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    }).record;
    const enq = runHook('h19-knowledge-delivery.mjs', postRead(kase.dir, 'src/a.mjs'), kase.dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(kase.dir)[0]?.payload ?? '';
    assert.match(cached, /AC1_DELIVERY_CASE_STALE_BODY_SENTINEL/, 'fixture sanity: cached while active');

    tools.knowledgeSupersede(original.id, {
      title: 'ac1-delivery-successor',
      statement: 'replacement text',
      alternatives_rejected: [],
      rationale: 'r2',
      file_keys: ['src/a.mjs'],
    });
    const successorId = tools.knowledgeGet(original.id).superseded_by;
    assert.ok(successorId, 'fixture sanity: supersede recorded a successor id');

    const d = drain(kase.dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, new RegExp(original.id), 'the drained stub names the queued (original) id');
    assert.match(ctx, supersededBracket('project', successorId), 'and carries the deny-once-format bracket naming the successor');
  } finally {
    kase.cleanup();
  }
});
// REPAIR NOTE (conductor adjudication 2026-08-31, item 1 of 7 — collapses the
// old "hazard/one-hop-article/decision-pointer" trio into this delivery-kind
// pair): the retired fixtures assumed a superseded record still reaches a
// LIVE pointer-surface query with no status filter — verified FALSE (every
// store query excludes superseded records). This test uses the AC3
// active-then-supersede sequencing instead, for the 'delivery' producer kind.
// See the sibling 'bash_pointers kind' test below for the other producer kind
// the conductor named.
// EXPECTED GREEN against the now-built S2a implementation.
// SABOTAGE: render the bracket unconditionally on every drained decision
// (including still-active ones) — the CONTROL's doesNotMatch(/\[active/)
// assertion goes red while the CASE would misleadingly still pass.

test('AC1 (bash_pointers kind — RE-AIMED per conductor repair 2026-08-31, item 1, same underlying invalidity as the delivery-kind pair above): control - a still-active anti_pattern drains with no bracket; case - queued while active via a real Bash touch, then superseded, drains as a stub carrying the bracket', () => {
  // CONTROL.
  const ctl = makeProject({ rung: 'prompt' });
  try {
    mkdirSync(join(ctl.dir, 'src'), { recursive: true });
    writeFileSync(join(ctl.dir, 'src', 'h1.mjs'), 'x\n');
    ctl.store.create(antiPattern('ac1-bash-ctl-active', ['src/h1.mjs']));
    const enq = runHook('h19-bash-delivery.mjs', postBash(ctl.dir, 'cat src/h1.mjs'), ctl.dir);
    assert.equal(enq.code, 0, enq.stderr);
    const d = drain(ctl.dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    const line = ctx.split('\n').find((l) => l.includes('ac1-bash-ctl-active'));
    assert.ok(line, 'the active bash hazard pointer line renders after drain');
    assert.doesNotMatch(line, /\[active·project\]/);
    assert.doesNotMatch(line, /\[superseded/);
  } finally {
    ctl.cleanup();
  }

  // CASE — active at the real Bash-touch enqueue, superseded strictly after.
  const kase = makeProject({ rung: 'prompt' });
  try {
    mkdirSync(join(kase.dir, 'src'), { recursive: true });
    writeFileSync(join(kase.dir, 'src', 'h2.mjs'), 'x\n');
    const tools = mkTools(kase.store);
    const original = tools.knowledgeCreate('anti_pattern', {
      title: 'ac1-bash-case-original',
      trigger: 't',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'e',
      file_keys: ['src/h2.mjs'],
    }).record;
    const enq = runHook('h19-bash-delivery.mjs', postBash(kase.dir, 'cat src/h2.mjs'), kase.dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(kase.dir)[0]?.payload ?? '';
    assert.match(cached, /ac1-bash-case-original/, 'fixture sanity: cached while active');

    tools.knowledgeSupersede(original.id, {
      title: 'ac1-bash-case-successor',
      trigger: 't2',
      guidance: 'g2',
      wrong_way: 'w2',
      right_way: 'r2',
      source_evidence: 'e2',
      file_keys: ['src/h2.mjs'],
    });
    const successorId = tools.knowledgeGet(original.id).superseded_by;
    assert.ok(successorId, 'fixture sanity: supersede recorded a successor id');

    const d = drain(kase.dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, new RegExp(original.id), 'the drained stub names the queued (original) id');
    assert.match(ctx, supersededBracket('project', successorId), 'and carries the deny-once-format bracket naming the successor');
  } finally {
    kase.cleanup();
  }
});
// REPAIR NOTE: same invalidity as the delivery-kind pair above, exercised
// for the 'bash_pointers' producer kind and its
// {version:1, mode:'pointer_verify', record_ids[]} recipe rather than the
// delivery kind's {mode:'rerender', ...} recipe.
// EXPECTED GREEN against the now-built S2a implementation.
// SABOTAGE: apply the bracket annotation to the 'delivery' kind's re-resolve
// path only and never to 'bash_pointers' — this test goes red while the
// delivery-kind pair above stays green, proving each producer kind is pinned
// independently (the AC1 requirement that "any pointer surface" — including
// the queue-only Bash surface — carries the annotation).

test('AC2 (RE-AIMED to the drain per conductor repair 2026-08-31, item 2 — see AC1\'s repair note for why a live pointer-surface fixture is invalid): two independently-superseded drain stubs share the EXACT same bracket shape — one formatter, not a second spelling; the grammar matches the exact deny-once regex (h20-deny-once.test.mjs pins the identical grammar on the AskUserQuestion surface — this cross-suite pair is what proves single-formatter-ness, not a coincidental resemblance)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('owner', ['src/a.mjs']));
    const tools = mkTools(store);
    const d1 = tools.knowledgeCreate('decision', {
      title: 'ac2-d1',
      statement: 'AC2_D1_BODY_SENTINEL',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    }).record;
    const d2 = tools.knowledgeCreate('decision', {
      title: 'ac2-d2',
      statement: 'AC2_D2_BODY_SENTINEL',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    }).record;

    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);

    tools.knowledgeSupersede(d1.id, { title: 'ac2-d1-succ', statement: 's', alternatives_rejected: [], rationale: 'r2', file_keys: ['src/a.mjs'] });
    tools.knowledgeSupersede(d2.id, { title: 'ac2-d2-succ', statement: 's', alternatives_rejected: [], rationale: 'r2', file_keys: ['src/a.mjs'] });

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);

    // Exact grammar the conductor named (matches h20-deny-once.test.mjs's
    // proven deny-once shape): `[status·scope]` or
    // `[status·scope, superseded_by: <id>]`.
    const GRAMMAR = /\[[a-z_]+·[a-z_:]+(, superseded_by: [0-9a-f-]+)?\]/g;
    const matches = [...ctx.matchAll(GRAMMAR)].map((m) => m[0]);
    assert.ok(matches.length >= 2, `expected two independently-superseded stubs, each with a bracket — found ${matches.length}: ${JSON.stringify(matches)}`);
    const shapes = matches.map((m) => m.replace(/superseded_by: [0-9a-f-]+/, 'superseded_by: <id>'));
    assert.ok(shapes.every((s) => s === shapes[0]), `both stubs must share the exact same bracket shape (one formatter) — got ${JSON.stringify(shapes)}`);
    assert.match(matches[0], /\[superseded·project, superseded_by: [0-9a-f-]{36}\]/, 'and the grammar matches the deny-once shape exactly');
  } finally {
    cleanup();
  }
});
// REPAIR NOTE: same invalidity as AC1 — a superseded decision created before
// its own owning query ever ran would never be queued at all, so the
// annotation is pinned via the same active-then-supersede sequencing AC3
// uses, with TWO decisions superseded before ONE drain so their two stubs
// can be compared for shape-identity directly (cheaper than spanning two
// producer kinds, per the conductor's own suggested shortcut).
// EXPECTED GREEN against the now-built S2a implementation.
// SABOTAGE: give one decision's stub `[superseded·project,superseded_by:<id>]`
// (no space after the comma) while the other keeps the spaced form —
// `shapes.every((s) => s === shapes[0])` goes red even though both
// individually match the loose GRAMMAR regex.

// ===========================================================================
// AC3 — SUPERSEDED AT DRAIN
// ===========================================================================

test('AC3: a decision queued while ACTIVE, then superseded before drain, is served as a stub naming the queued id and its successor — never the stale cached body', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    const tools = mkTools(store);
    store.create(article('owner', ['src/a.mjs']));
    const original = tools.knowledgeCreate('decision', {
      title: 'ac3-original',
      statement: 'AC3_STALE_BODY_SENTINEL the original ruling text that must never survive to the drained output',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    }).record;

    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(dir)[0]?.payload ?? '';
    assert.match(cached, /AC3_STALE_BODY_SENTINEL/, 'fixture sanity: the cached payload really captured the original, still-active ruling text');

    // Strictly AFTER the cache was populated: the record becomes superseded.
    tools.knowledgeSupersede(original.id, {
      title: 'ac3-successor',
      statement: 'the replacement ruling text',
      alternatives_rejected: [],
      rationale: 'r2',
      file_keys: ['src/a.mjs'],
    });
    const successorId = tools.knowledgeGet(original.id).superseded_by;
    assert.ok(successorId, 'fixture sanity: the supersede recorded a successor id');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);

    assert.match(ctx, new RegExp(original.id), 'the drained stub names the QUEUED (original) id');
    assert.match(ctx, new RegExp(successorId), 'the drained stub names the served successor id');
    assert.doesNotMatch(ctx, /AC3_STALE_BODY_SENTINEL/, 'the stale cached body must never be served once the record is superseded');
  } finally {
    cleanup();
  }
});
// RED TODAY: h19-delivery-drain.mjs replays the cached payload verbatim (it
// does not open the store today, per the governing decision's own text) —
// AC3_STALE_BODY_SENTINEL DOES appear in ctx, so doesNotMatch fails. Correct
// red.
// SABOTAGE: revert the drain to `additionalContext += entry.payload` with no
// re-query — the doesNotMatch(STALE_BODY_SENTINEL) assertion goes red
// immediately, even though the id-naming assertions might still coincidentally
// pass if the cached payload happened to also mention the id.

test('AC3 (malformed chain): a decision superseded with NO resolvable successor is disclosed in words — never "see null" and never the literal string "null" as a successor id', () => {
  const { dir, store, dbPath, cleanup } = makeProject({ rung: 'prompt' });
  try {
    const tools = mkTools(store);
    store.create(article('owner', ['src/a.mjs']));
    // REPAIRED 2026-08-31 (test-repair register): the original fixture created
    // {status:'superseded', superseded_by: null} directly, which the store
    // REFUSES at creation (index.ts:1247 — born-retired without a successor),
    // and delivery queries exclude superseded records anyway, so a record
    // superseded BEFORE enqueue is never queued. The malformed chain is
    // constructed the way it arises in reality: queued while ACTIVE (same
    // entry as the primary AC3 arm), superseded via the sanctioned path, then
    // the SUCCESSOR row hard-deleted via the file's raw-SQL primitive, leaving
    // the queued record's pointer genuinely dangling at drain time.
    // Title deliberately avoids every word of the disclosure assertion
    // (malform/resolv/dangl/broken/cannot) so the pin cannot match its own fixture.
    const doomed = tools.knowledgeCreate('decision', {
      title: 'ac3-doomed-ruling',
      statement: 'AC3_ORPHANCHAIN_BODY_SENTINEL ruling text queued while active',
      alternatives_rejected: [],
      rationale: 'r',
      file_keys: ['src/a.mjs'],
    }).record;

    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(dir)[0]?.payload ?? '';
    assert.match(cached, /AC3_ORPHANCHAIN_BODY_SENTINEL/, 'fixture sanity: the decision was genuinely queued while active');

    tools.knowledgeSupersede(doomed.id, {
      title: 'ac3-vanishing-successor',
      statement: 'the successor that will vanish',
      alternatives_rejected: [],
      rationale: 'r2',
      file_keys: ['src/a.mjs'],
    });
    const successorId = tools.knowledgeGet(doomed.id).superseded_by;
    assert.ok(successorId, 'fixture sanity: the supersede recorded a successor id');
    const deleted = hardDeleteRecord(dbPath, successorId);
    assert.ok(deleted >= 1, 'fixture sanity: the successor row was genuinely removed, so the chain is dangling');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);

    assert.doesNotMatch(ctx, /see null/i, 'a malformed chain must never render "see null"');
    assert.doesNotMatch(ctx, /\bnull\b/i, 'a malformed chain must never render the literal string "null" as a successor id');
    assert.match(ctx, /malform|no resolvable|unresolvable|dangling|broken chain|cannot resolve/i, 'the malformed chain is disclosed in words');
  } finally {
    cleanup();
  }
});
// RED TODAY (for the WRONG reason initially, then the right one): today's
// drain just replays the cached payload, which never says "null" either — so
// the doesNotMatch assertions pass VACUOUSLY today. The disclosure assertion
// (`/malform|.../i`) is the one that actually fails today (no such wording
// exists pre-fix), which is the correct red for this pin.
// SABOTAGE: implement the stub as `` `see ${record.superseded_by}` `` without
// guarding a null/absent successor — with this fixture `record.superseded_by`
// is `null`, so the template literal renders "see null" and the
// doesNotMatch(/see null/i) assertion goes red, catching exactly the
// laundering shape this arm exists for.

// ===========================================================================
// AC4 — STILL-ACTIVE AT DRAIN (+ flagged_stale)
// ===========================================================================

test('AC4 (control): a STILL-ACTIVE record\'s queued pointer drains with its content served plainly', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('owner', ['src/a.mjs']));
    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /owner does the owner thing/, 'the active article\'s substance is served');
    assert.doesNotMatch(ctx, /UNVERIFIED AT DRAIN/, 'a healthy still-active record never carries the unverified banner');
  } finally {
    cleanup();
  }
});
// PASSES TODAY AND AFTER: this is the existing, unchanged happy path
// (h19-delivery.test.mjs already pins the same shape). Kept here as the
// control the flagged_stale case below is judged against.
// SABOTAGE: make the drain always append "UNVERIFIED AT DRAIN" regardless of
// store health — this control goes red on the doesNotMatch assertion.

test('AC4 (RE-AIMED per conductor repair 2026-08-31, item 3 — flagged_stale is schema-legal on research_finding ONLY, records.ts:169 / schemas.test.ts:279; a decision cannot legally carry it): a flagged_stale research_finding, named in a hand-written pointer_verify recipe, drains SERVED carrying a [flagged_stale·scope] disclosure — never withheld', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    const rf = store.create({
      ...envelope('research_finding', { status: 'flagged_stale' }),
      question: 'AC4_FLAGGED_QUESTION_SENTINEL?',
      answer: 'AC4_FLAGGED_ANSWER_SENTINEL',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
    });

    // Hand-written pending entry (the same Group-C technique AC10 already
    // uses). SYNCED TO RECIPE v2 2026-08-31 (test-repair register): the F1
    // review fix moved pointer_verify recipes to per-record captured LINES
    // ({version:2, header, entries:[{id,line}], tail}) so the drain rebuilds
    // the block instead of replaying cached text; the v1 shape now correctly
    // takes the legacy payload+banner arm and can never render the bracket.
    const pDir = join(dir, '.sterling', 'transient', 'delivery');
    mkdirSync(pDir, { recursive: true });
    const rfLine = `  • src/a.mjs — research_finding stub · knowledge_get ${rf.id}`;
    writeFileSync(
      join(pDir, 'pending.json'),
      JSON.stringify([
        {
          kind: 'bash_pointers',
          payload: `STERLING KNOWLEDGE POINTERS (H19)\n${rfLine}\n`,
          recipe: {
            version: 2,
            mode: 'pointer_verify',
            header: 'STERLING KNOWLEDGE POINTERS (H19)',
            entries: [{ id: rf.id, line: rfLine }],
            tail: '',
          },
        },
      ])
    );

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.doesNotMatch(ctx, /withheld|dropped/i, 'a flagged_stale record must never be treated as withheld');
    assert.match(ctx, new RegExp(rf.id), 'the record is still named/served');
    assert.match(ctx, /\[flagged_stale·project\]/, 'and carries the flagged_stale disclosure');
  } finally {
    cleanup();
  }
});
// REPAIR NOTE: the original fixture set status:'flagged_stale' on a decision
// envelope, which the schema refuses (flagged_stale is legal on
// research_finding only — a crash, not a meaningful red). The fixture now
// uses the legal type AND writes the pending entry directly (a live enqueue
// sequence is not needed here — AC4 only needs a queued reference to a
// flagged_stale record present at drain time).
// EXPECTED GREEN against the now-built S2a implementation.
// SABOTAGE: treat every non-active status identically to 'superseded' and
// withhold the body — the doesNotMatch(/withheld|dropped/i) assertion goes
// red, distinguishing "served with disclosure" from "withheld".

// ===========================================================================
// AC5 — MISSING AT DRAIN
// ===========================================================================

test('AC5: a queued pointer whose record id no longer resolves drains as a one-line disclosure, body dropped', () => {
  const { dir, store, dbPath, closeStore, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('owner', ['src/a.mjs']));
    const rec = store.create(decisionRec('AC5_DOOMED_BODY_SENTINEL', ['src/a.mjs']));

    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(dir)[0]?.payload ?? '';
    assert.match(cached, /AC5_DOOMED_BODY_SENTINEL/, 'fixture sanity: the record is genuinely cached before deletion');

    closeStore();
    const deleted = hardDeleteRecord(dbPath, rec.id);
    assert.ok(deleted >= 1, `fixture sanity: the hard-delete actually removed a row for ${rec.id} (removed ${deleted})`);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.doesNotMatch(ctx, /AC5_DOOMED_BODY_SENTINEL/, 'the body must be DROPPED once the record no longer resolves');
    assert.match(ctx, new RegExp(rec.id), 'the one-line disclosure still names the id that no longer resolves');
    assert.match(ctx, /missing|no longer|not found|unresolvable|gone/i, 'and states in words that the record no longer resolves');
  } finally {
    cleanup();
  }
});
// RED TODAY: the drain replays the cached payload verbatim, so
// AC5_DOOMED_BODY_SENTINEL DOES appear — doesNotMatch fails. Correct red.
// SABOTAGE: on a failed re-resolve lookup, fall back to serving the cached
// payload instead of the one-line disclosure — the doesNotMatch(SENTINEL)
// assertion goes red, catching the exact "silent stale serve" this AC bars.

// ===========================================================================
// AC6 — STORE UNAVAILABLE
// ===========================================================================

test('AC6: store unreachable at drain — the stored payload is still injected with an UNVERIFIED AT DRAIN banner, and the queue still drains (no indefinite requeue)', () => {
  const { dir, store, dbPath, closeStore, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('owner', ['src/a.mjs']));
    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(dir)[0]?.payload ?? '';
    assert.match(cached, /owner does the owner thing/, 'fixture sanity: a real delivery is queued before the store goes away');

    closeStore();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }
    assert.equal(existsSync(dbPath), false, 'fixture sanity: the store file is genuinely gone');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr, 'delivery never blocks, even with the store unreachable');
    const ctx = ctxOf(d);
    assert.match(ctx, /owner does the owner thing/, 'the STORED (cached) payload is still injected — fail-open, never silence');
    assert.match(ctx, /UNVERIFIED AT DRAIN/, 'each affected entry carries the UNVERIFIED AT DRAIN banner');
    assert.equal(pendingOf(dir).length, 0, 'the queue still drains to empty — no indefinite requeue');
  } finally {
    cleanup();
  }
});
// RED TODAY: the payload injects fine (drain does not open the store today,
// so it is untouched by the missing file), but no "UNVERIFIED AT DRAIN"
// banner exists anywhere — that assertion fails. Correct red.
// SABOTAGE: on a store-open failure, drop the entry from the batch instead of
// serving it with the banner — the "owner does the owner thing" assertion
// goes red (payload no longer injected) AND pendingOf length may end up
// nonzero if the entry gets left behind — either one catches this.

// ===========================================================================
// AC7 — MIXED KINDS
// ===========================================================================

// Proven axis-clearing vocabulary reused VERBATIM from
// scripts/tests/h23-output-axis.test.mjs so this fixture's H23 match is not a
// guess at H23's own threshold.
const H23_TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const H23_CONTENT =
  'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';

test('AC7: an H23-shaped entry and a frontier (no-record) entry drain served alongside a normal delivery — never falsely reported missing, never dropped', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    // (1) a normal owned delivery
    store.create(article('owner', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);

    // (2) an H23-shaped entry (real hook, ungoverned content match)
    store.create(antiPattern('AC7-MARKER breach countdown widget flywheel ballast klaxon failure', [], { trigger: H23_TRIGGER }));
    const h23r = runHook('h23-output-axis.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat run.log' }, tool_response: H23_CONTENT, cwd: dir }, dir);
    assert.equal(h23r.code, 0, h23r.stderr);

    // (3) a frontier (no-record) entry
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/orphan.mjs'), dir);

    const kinds = pendingOf(dir).map((e) => e.kind);
    assert.ok(kinds.includes('frontier'), `fixture sanity: the frontier entry is genuinely queued (kinds: ${JSON.stringify(kinds)})`);
    assert.equal(pendingOf(dir).length, 3, `fixture sanity: all three entries are queued before drain (kinds: ${JSON.stringify(kinds)})`);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /owner does the owner thing/, 'the normal delivery still serves');
    assert.match(ctx, /AC7-MARKER/, 'the H23-shaped entry still serves');
    assert.match(ctx, /src\/orphan\.mjs/, 'the frontier entry still serves');
    const orphanLine = ctx.split('\n').find((l) => l.includes('src/orphan.mjs'));
    assert.ok(orphanLine, 'the frontier line exists');
    assert.doesNotMatch(orphanLine, /missing|no longer resolves|not found/i, 'a frontier entry (no record at all) must never be reported as a MISSING record');
  } finally {
    cleanup();
  }
});
// RED TODAY (partially — for the wrong reason): all three currently drain
// served today (the drain does not yet re-resolve anything, so nothing is
// dropped or mis-reported) — the failure mode this AC guards against is a
// NAIVE re-resolver added by the fix that assumes every entry is
// article-shaped and either crashes on the frontier entry or reports it
// missing. Once the fix lands, if it mishandles the frontier/H23 kinds, the
// orphanLine doesNotMatch assertion or the AC7-MARKER/owner assertions go red.
// SABOTAGE: make the new re-resolver assume every queue entry names exactly
// one record id and treat a frontier entry's absent id as "missing" — the
// doesNotMatch(/missing.../i) assertion on orphanLine goes red.

// ===========================================================================
// AC8 — CONTAINMENT (claim-atomicity's concurrent half is not pinnable here;
// see file header)
// ===========================================================================

test('AC8 (containment): a per-entry render failure (one entry references a hard-deleted record) does not lose the OTHER entries in the same drained batch', () => {
  const { dir, store, dbPath, closeStore, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('ownerA', ['src/a.mjs']));
    store.create(article('ownerB', ['src/b.mjs']));
    const doomed = store.create(decisionRec('AC8_DOOMED_SENTINEL', ['src/a.mjs']));

    const e1 = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir); // entry 1: healthy article + a decision about to be deleted
    assert.equal(e1.code, 0, e1.stderr);
    const e2 = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir); // entry 2: wholly unrelated and healthy
    assert.equal(e2.code, 0, e2.stderr);
    assert.equal(pendingOf(dir).length, 2, 'fixture sanity: both entries are queued');

    closeStore();
    const deleted = hardDeleteRecord(dbPath, doomed.id);
    assert.ok(deleted >= 1, `fixture sanity: the doomed decision was actually removed (removed ${deleted})`);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /ownerA does the ownerA thing/, 'entry 1 still serves its healthy half despite the doomed decision inside it');
    assert.match(ctx, /ownerB does the ownerB thing/, 'entry 2 (wholly unrelated) is not lost because entry 1 had a render problem');
    assert.match(ctx, new RegExp(doomed.id), 'the corrupt reference is disclosed rather than silently vanishing');
  } finally {
    cleanup();
  }
});
// RED TODAY (for the wrong reason): both entries serve fine today because
// nothing is re-resolved yet, so ownerA/ownerB assertions already pass; the
// doomed.id disclosure assertion fails (nothing names it today, since the
// cached payload never needed to). Once the re-resolver exists, a naive
// per-entry crash-without-containment implementation would take the whole
// batch down with it (ownerB would also disappear), which is the real
// scenario this pins against post-fix.
// SABOTAGE: let a per-entry render exception propagate uncaught out of the
// whole drain loop instead of being caught and disclosed per-entry — with
// this fixture, entry 1's render throws on the deleted decision, the
// uncaught throw aborts BEFORE entry 2 is ever rendered, and the
// "ownerB does the ownerB thing" assertion goes red.

// ===========================================================================
// AC9 — ORDER + NO DEDUP
// ===========================================================================

test('AC9: queue append order is preserved in the injected output', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(article('beta', ['src/b.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir);
    assert.equal(pendingOf(dir).length, 2, 'fixture sanity: both entries queued, alpha first');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    const ia = ctx.indexOf('alpha does the alpha thing');
    const ib = ctx.indexOf('beta does the beta thing');
    assert.ok(ia >= 0 && ib >= 0, 'both entries render');
    assert.ok(ia < ib, 'alpha was enqueued first and must appear first in the injected output');
  } finally {
    cleanup();
  }
});
// PASSES TODAY AND AFTER: order preservation is not something this fix
// changes (the queue is a plain array, replayed in order, today and after).
// Kept as a regression floor the re-resolve fix must not invert.
// SABOTAGE: process/render entries in reverse (or by some non-append-order
// key such as re-resolved status) — `ia < ib` goes red.

test('AC9 (RE-AIMED per conductor repair 2026-08-31, item 4 — the per-agent session guard at h19-knowledge-delivery.mjs:107 dedups a second LIVE enqueue of the same record, so two real touches never produce two entries naming the same id): two hand-written pending entries whose recipes both name the SAME decision id each render it at drain — no cross-entry dedup', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    const shared = store.create(decisionRec('AC9_SHARED_SENTINEL', []));
    const pDir = join(dir, '.sterling', 'transient', 'delivery');
    mkdirSync(pDir, { recursive: true });
    writeFileSync(
      join(pDir, 'pending.json'),
      JSON.stringify([
        {
          kind: 'delivery',
          payload: `STERLING KNOWLEDGE DELIVERY — owning knowledge for 'src/a.mjs'\nDECISIONS for this path (1)\n  → AC9_SHARED_SENTINEL (knowledge_get ${shared.id})\n`,
          // SYNCED TO v2 2026-08-31 (test-repair register): version 2 + tails, so
          // this pin exercises the real rerender path — at v1 it fell to the
          // banner arm and passed HOLLOW on cached-payload sentinels.
          recipe: { version: 2, mode: 'rerender', rel: 'src/a.mjs', unowned: true, char_cap: 8192, hazard_ids: [], owner_ids: [], decision_ids: [shared.id], tails: { hazards: 0, decisions: 0 }, trailing_blocks: [] },
        },
        {
          kind: 'delivery',
          payload: `STERLING KNOWLEDGE DELIVERY — owning knowledge for 'src/b.mjs'\nDECISIONS for this path (1)\n  → AC9_SHARED_SENTINEL (knowledge_get ${shared.id})\n`,
          recipe: { version: 2, mode: 'rerender', rel: 'src/b.mjs', unowned: true, char_cap: 8192, hazard_ids: [], owner_ids: [], decision_ids: [shared.id], tails: { hazards: 0, decisions: 0 }, trailing_blocks: [] },
        },
      ])
    );

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    const count = ctx.split('AC9_SHARED_SENTINEL').length - 1;
    assert.equal(count, 2, 'the shared decision must render in BOTH entries — no cross-entry dedup');
  } finally {
    cleanup();
  }
});
// REPAIR NOTE: the original fixture relied on two real touches of two
// different owned files sharing one governing decision, assuming the real
// producer would enqueue the decision twice — invalid, because the
// per-agent session guard dedups a second live enqueue of the SAME record
// regardless of which file triggered it. The two entries are now
// hand-written directly (the same Group-C technique AC10 uses) with recipes
// naming the same decision id, bypassing the guard entirely (which only
// governs the ENQUEUE path, never the drain) — this is the only way to
// construct "two entries naming the same id" at all, since the guard makes
// it unreachable through any real touch. `recipe`/`unowned`/`rel`/
// `char_cap`/`hazard_ids`/`owner_ids`/`decision_ids`/`trailing_blocks` field
// names are taken verbatim from the conductor's disclosed shape;
// `unowned: true` is inferred (no owning article was created for either rel
// path) and flagged as an assumption.
// EXPECTED GREEN against the now-built S2a implementation.
// SABOTAGE: add a drain-wide re-resolve cache keyed only by record id (skip
// re-rendering a record already resolved once this drain) — `count === 2`
// goes red (count becomes 1).

// ===========================================================================
// AC10 — LEGACY ENTRIES
// ===========================================================================

test('AC10: a payload-only legacy entry (no render recipe) drains SERVED with the UNVERIFIED banner, never dropped, never crashing the drain', () => {
  const { dir, cleanup } = makeProject({ rung: 'prompt' });
  try {
    const pDir = join(dir, '.sterling', 'transient', 'delivery');
    mkdirSync(pDir, { recursive: true });
    writeFileSync(
      join(pDir, 'pending.json'),
      JSON.stringify([{ kind: 'delivery', payload: 'LEGACY_ENTRY_SENTINEL an old queued entry with no recipe at all' }])
    );
    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr, 'a legacy entry must never crash the drain');
    const ctx = ctxOf(d);
    assert.match(ctx, /LEGACY_ENTRY_SENTINEL/, 'the legacy entry is served, not dropped');
    assert.match(ctx, /UNVERIFIED AT DRAIN/, 'and carries the UNVERIFIED banner since it cannot be re-resolved without a recipe');
  } finally {
    cleanup();
  }
});
// RED TODAY: the entry serves fine today (LEGACY_ENTRY_SENTINEL renders),
// but no "UNVERIFIED AT DRAIN" banner exists — that assertion fails. Correct
// red.
// SABOTAGE: make the re-resolver REQUIRE a recipe and throw/drop the entry
// when one is absent instead of falling back to payload+banner — either the
// LEGACY_ENTRY_SENTINEL assertion goes red (entry dropped) or `d.code`
// stops being 0 (crash), depending on exactly how the missing-recipe case is
// mishandled.
