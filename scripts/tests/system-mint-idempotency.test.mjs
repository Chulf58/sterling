// Hook-side maintenance mints become idempotent (H10).
//
// SPEC UNDER TEST (not yet implemented — every AC-numbered test here is
// expected to be RED, or at minimum incomplete, against today's h10 code):
// h10-direct-capture.mjs currently mints its durable queue items (capture_owed,
// article_missing, …) via ad hoc, per-lane pre-checks in front of a raw
// store.create — NOT through SterlingStore.enqueueSystemTodo, the single
// atomic dedup choke point (key: system_reason, feature_link, sorted
// file_keys, or — when neither identifying field exists — the text; decision
// 194f43e4). This change routes the mints through enqueueSystemTodo instead.
//
// Store-level key semantics (same-key returns existing / different-file is
// distinct / text-differs updates / identical text is a no-op churn) are
// ALREADY covered by packages/store/src/tests/store.test.ts and are
// deliberately NOT re-tested here. These tests exercise the HOOK end-to-end
// through real Stop invocations:
//
//   AC1 (capture lane, primary target) — two SEPARATE session encounters of
//        the identical unmet capture duty (same touched file, nothing
//        captured, in each) leave exactly ONE capture_owed item — the second
//        encounter's release step mints nothing new. capture_owed has no
//        existing pre-check in front of its mint (unlike article_missing,
//        research_owed and concept_article_missing, which already have
//        bespoke per-lane guards per the existing suite) — this is the
//        cleanest place to see the bug.
//   AC1 (article-demand lane, regression) — the same two-encounter shape for
//        article_missing; today's ad hoc overlap pre-check likely already
//        keeps this at one item, so this test protects that behavior across
//        the migration to enqueueSystemTodo rather than proving it broken.
//   AC2 — an article-demand duty whose situation ESCALATES between two
//        encounters (a fourth unowned file appears the second time) still
//        leaves exactly one item, and that item's updated_at moves. Today's
//        ad hoc overlap check suppresses the second mint (so the count may
//        already read 1) but does not refresh anything about the surviving
//        record — updated_at will NOT have moved, which is the concrete red
//        assertion.
//   AC3 — two GENUINELY DIFFERENT demands still mint two distinct items:
//        (a) two different lanes (capture_owed + article_missing) coexisting
//            in one session, and
//        (b) the same lane (article_missing), a different subject (disjoint
//            file set) across two sessions, the first subject having since
//            been given an owning article.
//   AC4 — every system item h10 mints carries a system_reason that is an
//        actual member of the registered SYSTEM_REASONS set (packages/schemas)
//        — never missing, never a blank/ad hoc string that would sit in the
//        queue undrainable because DRAIN_VERBS has no entry for it.
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

let SterlingStore;
let SYSTEM_REASONS;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SYSTEM_REASONS } = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href));
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

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function envelope(type, at) {
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

function makeH10Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mint-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

/** Simulates a session's file-touch register — files that exist, at a given time. */
function touchRegister(dir, paths, at) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function captureDecision(store, at) {
  return store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

function article(store, slug, files, at) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);
const systemItems = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === reason);
const allSystemItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system');

// =========================================================================
// AC1 — repeat firing of an UNCHANGED unmet duty mints nothing new
// =========================================================================

test('AC1 (capture lane): two session encounters of the identical unmet capture duty leave exactly one capture_owed item', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1: a file touched, nothing captured since — the plain unmet
    // capture duty, no pending declaration, no research/debug event involved.
    touchRegister(dir, ['src/only.mjs'], '2026-08-06T09:00:00.000Z');
    assert.equal(stop(dir).code, 2, 'session 1: capture nag (soft-block once, P1)');
    assert.equal(stop(dir).code, 0, 'session 1: release mints the durable item');
    const first = systemItems(store, 'capture_owed');
    assert.equal(first.length, 1, 'exactly one item minted after session 1');

    // Session 2: a brand-new session touches the SAME file again with nothing
    // captured since — the identical unmet duty recurring, exactly as it
    // would if the session-1 item was never drained (it is still open here).
    touchRegister(dir, ['src/only.mjs'], '2026-08-06T10:00:00.000Z');
    assert.equal(stop(dir).code, 2, 'session 2: nags again — the nag marker is per-session, not suppressed by the durable item');
    assert.equal(stop(dir).code, 0, 'session 2: release');

    const second = systemItems(store, 'capture_owed');
    assert.equal(second.length, 1, 'AC1: the repeat firing mints NOTHING NEW — still exactly one capture_owed item');
    assert.equal(second[0].id, first[0].id, 'the surviving item is the ORIGINAL — not a fresh duplicate with a new id');
  } finally {
    cleanup();
  }
});

test('AC1 (article-demand lane, regression): two session encounters of the identical unowned territory leave exactly one article_missing item', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'], '2026-08-07T09:00:00.000Z');
    captureDecision(store, '2026-08-07T09:05:00.000Z');
    assert.equal(stop(dir).code, 2, 'session 1: article demand nags');
    assert.equal(stop(dir).code, 0, 'session 1: release');
    const first = systemItems(store, 'article_missing');
    assert.equal(first.length, 1);

    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'], '2026-08-07T10:00:00.000Z');
    captureDecision(store, '2026-08-07T10:05:00.000Z');
    assert.equal(stop(dir).code, 2, 'session 2: nags again');
    assert.equal(stop(dir).code, 0, 'session 2: release');

    const second = systemItems(store, 'article_missing');
    assert.equal(second.length, 1, 'AC1: the identical unowned territory recurring mints nothing new');
    assert.equal(second[0].id, first[0].id);
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC2 — an ESCALATING duty updates the existing item rather than duplicating
// =========================================================================

test('AC2: an article-demand ESCALATES on repeat (a fourth unowned file appears the second time) — still one item, with updated_at moved', async () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'], '2026-08-08T09:00:00.000Z');
    captureDecision(store, '2026-08-08T09:05:00.000Z');
    assert.equal(stop(dir).code, 2);
    assert.equal(stop(dir).code, 0);
    const first = systemItems(store, 'article_missing');
    assert.equal(first.length, 1, 'baseline: one item after the first encounter');

    // Deterministic ordering safeguard: guarantee the second encounter's
    // updated_at is observably later than the first's. This does not race
    // anything external — it only orders two sequential local writes, exactly
    // as a real second session always follows the first in wall-clock time.
    await new Promise((r) => setTimeout(r, 10));

    // ESCALATION: the same territory, now with a FOURTH unowned file too —
    // still nothing owns any of them.
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs', 'src/w.mjs'], '2026-08-08T11:00:00.000Z');
    captureDecision(store, '2026-08-08T11:05:00.000Z');
    assert.equal(stop(dir).code, 2, 'second encounter: still unowned, still nags');
    assert.equal(stop(dir).code, 0, 'second encounter: release');

    const second = systemItems(store, 'article_missing');
    assert.equal(second.length, 1, 'AC2: escalation UPDATES the existing item rather than duplicating it');
    assert.notEqual(
      second[0].updated_at,
      first[0].updated_at,
      'AC2: the surviving item\'s updated_at must move to reflect the newer, escalated state — a silent overlap-suppression that never refreshes anything leaves this equal, which is the bug'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC3 — genuinely DIFFERENT demands still mint two distinct items
// =========================================================================

test('AC3a: two different lanes in one session (capture_owed and article_missing) both mint — one lane is never collapsed into the other', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Neither duty is satisfied: nothing captured, three unowned files touched.
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'], '2026-08-09T09:00:00.000Z');
    assert.equal(stop(dir).code, 2, 'nag: both duties unmet');
    assert.equal(stop(dir).code, 0, 'release');

    const owed = systemItems(store, 'capture_owed');
    const missing = systemItems(store, 'article_missing');
    assert.equal(owed.length, 1, 'a distinct capture_owed item exists');
    assert.equal(missing.length, 1, 'AND a distinct article_missing item exists — different lanes are never merged together');
  } finally {
    cleanup();
  }
});

test('AC3b: the same lane (article_missing), a genuinely different subject across two sessions, mints a second distinct item', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1: an unowned subject {a,b,c}, captured, demand raised.
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-10T09:00:00.000Z');
    captureDecision(store, '2026-08-10T09:05:00.000Z');
    assert.equal(stop(dir).code, 2);
    assert.equal(stop(dir).code, 0);
    const first = systemItems(store, 'article_missing');
    assert.equal(first.length, 1);

    // That subject is resolved the RIGHT way — an owning article is created —
    // so a NEW session touching a totally disjoint, still-unowned set of files
    // is a genuinely different subject, not a repeat of the same unmet state.
    article(store, 'feat-abc', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-10T09:06:00.000Z');

    touchRegister(dir, ['src/p.mjs', 'src/q.mjs', 'src/r.mjs'], '2026-08-10T10:00:00.000Z');
    captureDecision(store, '2026-08-10T10:05:00.000Z');
    assert.equal(stop(dir).code, 2, 'a genuinely new unowned subject still nags');
    assert.equal(stop(dir).code, 0);

    const second = systemItems(store, 'article_missing');
    assert.equal(second.length, 2, 'AC3: a genuinely different subject mints its OWN item — never collapsed with the resolved first one');
    const newItem = second.find((r) => r.id !== first[0].id);
    assert.ok(newItem, 'a new item exists for the new subject');
    assert.deepEqual([...newItem.file_keys].sort(), ['src/p.mjs', 'src/q.mjs', 'src/r.mjs']);
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC4 — every hook-minted system item carries a REGISTERED system_reason
// =========================================================================

test('AC4: every hook-minted system item carries a system_reason that is a member of the registered SYSTEM_REASONS set', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // drives both reachable lanes at once (capture_owed + article_missing)
    touchRegister(dir, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs'], '2026-08-11T09:00:00.000Z');
    assert.equal(stop(dir).code, 2);
    assert.equal(stop(dir).code, 0);

    const minted = allSystemItems(store);
    assert.ok(minted.length > 0, 'the fixture actually minted something to check (a vacuous pass proves nothing)');
    assert.ok(Array.isArray(SYSTEM_REASONS) && SYSTEM_REASONS.length > 0, 'SYSTEM_REASONS must be a real, non-empty registry (packages/schemas)');
    for (const item of minted) {
      assert.equal(typeof item.system_reason, 'string', `item ${item.id} is missing system_reason entirely`);
      assert.ok(item.system_reason.length > 0, `item ${item.id} has a blank system_reason`);
      assert.ok(
        SYSTEM_REASONS.includes(item.system_reason),
        `item ${item.id} carries system_reason '${item.system_reason}', which is NOT a member of the registered SYSTEM_REASONS set`
      );
    }
  } finally {
    cleanup();
  }
});
