// H1 SessionStart — GROUPED TASK COUNT in the systemMessage banner.
//
// Spec under test (decision a8d2ce6c slice 2, display surfaces; given by the launching
// agent, not inferred from implementation). Slice 1 shipped the field: a todo may carry
// an optional non-empty `objective` string (a grouping KEY, absent = standalone).
//
// H1's systemMessage today reads "N task(s) · M maintenance item(s) pending", counting
// user todos FLAT — which is exactly how an exploded slice list reads as noise. The new
// behavior (decision point 6: "H1's session banner counts GROUPED (e.g. 'N tasks (K in M
// objectives)') so the explosion dies at both display surfaces"):
//   AC1  5 open user todos, 3 of them sharing "Animation pass" → the task clause reads
//        "5 tasks (3 in 1 objective)": the TOTAL is unchanged, and a parenthetical
//        discloses how many tasks sit in how many objectives.
//   AC2  todos across 2 objectives (2 + 2) plus 1 standalone → "5 tasks (4 in 2
//        objectives)" — the plural form.
//   AC3  NO grouped todos → the clause stays parenthetical-free: zero behavior change
//        for a flat board.
//   AC4  singular still works: exactly 1 standalone task → "1 task".
//   The maintenance clause (" · M maintenance item(s) pending") is unchanged throughout.
//
// ---------------------------------------------------------------------------------
// CONTRACT THIS ORACLE OWNS (decisions_made):
//   • The PARENTHETICAL is pinned VERBATIM — "(K in M objective)" / "(K in M
//     objectives)", singular below 2 objectives, immediately after the task-count
//     clause. That string is the load-bearing new behavior and is quoted from the
//     decision, so it is asserted literally.
//   • The PRE-EXISTING plural style of the task/maintenance words is deliberately NOT
//     re-litigated: assertions on the count clause itself accept "5 tasks" or
//     "5 task(s)" (`/\b5 task(?:s|\(s\))?/`), so this oracle can never smuggle a
//     rewrite of the flat clause in under an "unchanged" AC. What it DOES pin is that
//     the parenthetical sits directly after that clause.
//   • K counts OPEN, USER-source todos that carry an objective; M counts the DISTINCT
//     objectives among them. An objective with exactly ONE open member still counts
//     (the same 1-vs-0 line the TUI oracle draws): the decision's boundary is a group
//     with ZERO open children, which "stops rendering".
//   • A system-source item carrying an objective is counted only as maintenance —
//     never in N, K or M (lanes group the queue, objectives group the board).
//   • The maintenance clause is asserted as UNCHANGED structurally: the '·'-delimited
//     segment naming it must be byte-identical between a flat board and a grouped
//     board holding the same items.
//
// This file follows scripts/tests/h1-session-residue.test.mjs's harness style
// (runHook / hookInput / envelope / makeProject / h1) so it runs in isolation. H1 does
// not have this behavior yet — every test below fails RED on an AssertionError over the
// missing parenthetical (each test that also asserts a NO-CHANGE case pairs it with a
// grouped case in the same test, so no test is trivially green at red).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1obj-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// --------------------------- H1 invocation ---------------------------

function h1(dir, source = 'startup', envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

/** The HUMAN-facing banner line (the surface these ACs are about). */
function systemMessage(dir) {
  const r = h1(dir);
  assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  assert.ok(r.out, 'H1 must emit parseable JSON');
  assert.equal(typeof r.out.systemMessage, 'string', 'H1 emits a systemMessage banner line for the human');
  return r.out.systemMessage;
}

/** The '·'-delimited segment that names the maintenance queue, for the
 *  unchanged-clause comparison. */
function maintenanceClause(msg) {
  const m = msg.match(/·[^·]*maintenance[^·]*/);
  return m ? m[0].trim() : '';
}

// --------------------------- board fixtures ---------------------------

const userTodo = (store, text, over = {}) => store.create({ ...envelope('todo'), text, source: 'user', ...over });
const groupedTodo = (store, text, objective) => userTodo(store, text, { objective });
const standaloneTodo = (store, text) => userTodo(store, text);
const maintenanceItem = (store, text, over = {}) =>
  store.create({ ...envelope('todo'), text, source: 'system', system_reason: 'reconcile_needed', author: 'system', ...over });

/** No parenthetical of the disclosed shape anywhere in the clause. */
const NO_PARENTHETICAL = /\(\s*\d+\s+in\s+\d+\s+objectives?\s*\)/;

// --------------------------- tests ---------------------------

test('AC1: 5 open user tasks, 3 sharing "Animation pass" → the task clause reads "5 tasks (3 in 1 objective)" — total unchanged, grouped slices disclosed, singular "objective"', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    groupedTodo(store, 'rig the walk cycle', 'Animation pass');
    groupedTodo(store, 'retarget the idle', 'Animation pass');
    groupedTodo(store, 'blend the run', 'Animation pass');
    standaloneTodo(store, 'bump the changelog');
    standaloneTodo(store, 'fix the tooltip typo');

    const msg = systemMessage(dir);
    assert.match(msg, /\(3 in 1 objective\)/, 'the parenthetical discloses 3 tasks in 1 objective, verbatim');
    assert.match(
      msg,
      /\b5 task(?:s|\(s\))? \(3 in 1 objective\)/,
      'the TOTAL is unchanged (5) and the parenthetical sits immediately after the task-count clause'
    );
    assert.doesNotMatch(msg, /1 objectives\b/, 'one objective is singular — never "1 objectives"');
    assert.doesNotMatch(msg, /\b3 task(?:s|\(s\))? \(/, 'the leading number is the TOTAL, not the grouped subset');
  } finally {
    cleanup();
  }
});

test('AC2: todos across TWO objectives (2 + 2) plus 1 standalone → "5 tasks (4 in 2 objectives)" — the plural form', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    groupedTodo(store, 'rig the walk cycle', 'Animation pass');
    groupedTodo(store, 'retarget the idle', 'Animation pass');
    groupedTodo(store, 'tune the ragdoll', 'Physics pass');
    groupedTodo(store, 'fix the cloth jitter', 'Physics pass');
    standaloneTodo(store, 'bump the changelog');

    const msg = systemMessage(dir);
    assert.match(msg, /\(4 in 2 objectives\)/, 'four tasks across two objectives, plural');
    assert.match(msg, /\b5 task(?:s|\(s\))? \(4 in 2 objectives\)/, 'the total stays 5 and the parenthetical follows it');
    assert.doesNotMatch(msg, /in 2 objective\)/, 'two objectives is plural — never "in 2 objective"');
  } finally {
    cleanup();
  }
});

test('AC3: a FLAT board keeps the clause parenthetical-free (zero behavior change), while an otherwise identical board with one objective declared discloses it', () => {
  // flat half — five standalone tasks, nothing grouped
  const flat = makeProject();
  try {
    for (const text of ['a', 'b', 'c', 'd', 'e']) standaloneTodo(flat.store, `flat task ${text}`);
    const msg = systemMessage(flat.dir);
    assert.match(msg, /\b5 task/, 'the flat board still reports its five tasks');
    assert.doesNotMatch(msg, NO_PARENTHETICAL, 'no grouped todos → NO parenthetical at all (zero change for flat boards)');
    assert.doesNotMatch(msg, /objectives?\b/i, 'the word "objective" never appears for an ungrouped board');
  } finally {
    flat.cleanup();
  }

  // grouped half — the same five tasks, three of them declared under one objective
  const grouped = makeProject();
  try {
    groupedTodo(grouped.store, 'rig the walk cycle', 'Animation pass');
    groupedTodo(grouped.store, 'retarget the idle', 'Animation pass');
    groupedTodo(grouped.store, 'blend the run', 'Animation pass');
    standaloneTodo(grouped.store, 'bump the changelog');
    standaloneTodo(grouped.store, 'fix the tooltip typo');
    const msg = systemMessage(grouped.dir);
    assert.match(msg, /\(3 in 1 objective\)/, 'the same five tasks, now grouped, DO carry the parenthetical');
  } finally {
    grouped.cleanup();
  }
});

test('AC4: singular still works — exactly 1 standalone task reads "1 task" with no parenthetical; a single grouped member is still an objective ("2 tasks (1 in 1 objective)")', () => {
  // one standalone task only
  const one = makeProject();
  try {
    standaloneTodo(one.store, 'the only task');
    const msg = systemMessage(one.dir);
    assert.match(msg, /\b1 task\b/, 'a single task is singular');
    assert.doesNotMatch(msg, /\b1 tasks\b/, 'never "1 tasks"');
    assert.doesNotMatch(msg, NO_PARENTHETICAL, 'a lone standalone task carries no parenthetical');
  } finally {
    one.cleanup();
  }

  // one grouped + one standalone: an objective with a single open member still counts
  const pair = makeProject();
  try {
    groupedTodo(pair.store, 'the single declared slice', 'Physics pass');
    standaloneTodo(pair.store, 'bump the changelog');
    const msg = systemMessage(pair.dir);
    assert.match(msg, /\(1 in 1 objective\)/, 'an objective with ONE open member is still an objective (the line is drawn at zero)');
    assert.match(msg, /\b2 task(?:s|\(s\))? \(1 in 1 objective\)/, 'the total counts both tasks');
  } finally {
    pair.cleanup();
  }
});

test('the maintenance clause is UNCHANGED: a grouped board discloses its parenthetical and leaves " · M maintenance item(s) pending" byte-identical to the flat board\'s', () => {
  const flat = makeProject();
  const grouped = makeProject();
  try {
    // identical item counts on both boards: 5 user tasks + 2 maintenance items
    for (const text of ['a', 'b', 'c', 'd', 'e']) standaloneTodo(flat.store, `flat task ${text}`);
    maintenanceItem(flat.store, "reconcile article 'tui-dashboard'");
    maintenanceItem(flat.store, "reconcile article 'hook-session-guards'");

    groupedTodo(grouped.store, 'rig the walk cycle', 'Animation pass');
    groupedTodo(grouped.store, 'retarget the idle', 'Animation pass');
    groupedTodo(grouped.store, 'blend the run', 'Animation pass');
    standaloneTodo(grouped.store, 'bump the changelog');
    standaloneTodo(grouped.store, 'fix the tooltip typo');
    maintenanceItem(grouped.store, "reconcile article 'tui-dashboard'");
    maintenanceItem(grouped.store, "reconcile article 'hook-session-guards'");

    const flatMsg = systemMessage(flat.dir);
    const groupedMsg = systemMessage(grouped.dir);

    // the new behavior fires on the grouped board...
    assert.match(groupedMsg, /\(3 in 1 objective\)/, 'the grouped board discloses its parenthetical');
    // ...and the maintenance half is untouched by it
    const flatClause = maintenanceClause(flatMsg);
    const groupedClause = maintenanceClause(groupedMsg);
    assert.ok(flatClause.length > 0, 'the flat board names its maintenance queue in the banner');
    assert.match(flatClause, /\b2\b/, 'and names the count (2 items)');
    assert.match(flatClause, /pending/, 'and reads as pending');
    assert.equal(
      groupedClause,
      flatClause,
      'the maintenance clause is byte-identical on the grouped board — the objective disclosure touches the task clause only'
    );
    // the maintenance items are never counted as objectives
    assert.doesNotMatch(groupedMsg, /in 2 objectives/, 'maintenance items are lane-keyed and never contribute an objective');
  } finally {
    flat.cleanup();
    grouped.cleanup();
  }
});

test('neither number is inflated by CLOSED children or by a system item carrying an objective: 2 open grouped + 2 standalone + 1 closed grouped + 1 maintenance item → "4 tasks (2 in 1 objective)"', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    groupedTodo(store, 'rig the walk cycle', 'Animation pass');
    groupedTodo(store, 'retarget the idle', 'Animation pass');
    const closed = groupedTodo(store, 'blend the run', 'Animation pass');
    store.remove(closed.id, '2026-06-10T12:30:00.000Z'); // closed → counts nowhere
    standaloneTodo(store, 'bump the changelog');
    standaloneTodo(store, 'fix the tooltip typo');
    // a maintenance item physically carrying the same objective string: lanes group the
    // queue, objectives group the board — it must land in the maintenance clause only
    maintenanceItem(store, "reconcile article 'tui-dashboard'", { objective: 'Animation pass' });

    const msg = systemMessage(dir);
    assert.match(msg, /\(2 in 1 objective\)/, 'the closed child drops out of the grouped subset');
    assert.match(msg, /\b4 task(?:s|\(s\))? \(2 in 1 objective\)/, 'and out of the total (4 open user tasks, not 5)');
    assert.doesNotMatch(msg, /\b5 task/, 'a closed task is never counted');
    assert.doesNotMatch(msg, /\(3 in/, 'the grouped subset counts OPEN members only');
    assert.doesNotMatch(msg, /in 2 objectives/, 'the system item contributes no second objective');
    assert.match(maintenanceClause(msg), /\b1\b/, 'the system item is counted exactly once, as maintenance');
  } finally {
    cleanup();
  }
});
