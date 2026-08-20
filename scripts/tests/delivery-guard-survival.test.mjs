// Delivery-guard survival (board 5a807e68 — the ~76KB re-delivery defect).
//
// Spec under test (given by the launching agent, not inferred from implementation):
// the H19/H20 delivery ledger is unified per (cwd, agent_id) but leaks re-delivery in
// two ways today:
//   (1) h19-clear-session.mjs wipes the ENTIRE .sterling/transient/delivery/ tree on
//       every SessionStart — including a rotation-note continuation of the same
//       logical work (the conductor deliberately /clear's mid-campaign via
//       scripts/rotation-note.mjs, restored by H1 on source=clear). That wipe must
//       not happen when a rotation note is present — the conductor's delivery guard
//       (guard-conductor.json) must survive intact. The pending queue MAY still
//       clear (stale pending payloads were staged for a prompt that will never
//       come now that the session turned over).
//   (2) the guard keys delivered knowledge by record ID, and every knowledge_update
//       (store.supersede) mints a new id for the same lineage/slug, so an edited
//       record re-delivers as "fresh" on the next touch of the same file even
//       though it is the same knowledge, just reconciled. A genuinely NEW record
//       (different lineage) on the same path must still deliver (scope-growth
//       re-arm, pinned already in h19-delivery.test.mjs and NOT to be broken here).
//
// This file follows scripts/tests/h19-delivery.test.mjs's harness idiom (runHook /
// article / envelope / makeProject / pendingOf / guard file paths under
// .sterling/transient/delivery/) and scripts/tests/hooks-full.test.mjs's rotation
// fixtures (scripts/rotation-note.mjs CLI, .sterling/transient/rotation-note.json,
// gitProject() for the git anchors rotation-note.mjs requires). Every test below is
// expected to FAIL against the current hooks — see the inline comment on each.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');
const NOW = '2026-08-20T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
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

function makeProject({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dgs-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

/**
 * Mirrors hooks-full.test.mjs's gitProject(): rotation-note.mjs refuses to write
 * outside a real git repo (it stamps git anchors — branch/HEAD — into the note),
 * so AC1/AC2 need an actual git-initialized project, not just a bare .sterling/.
 */
function gitProject(opts) {
  const { dir, store, cleanup } = makeProject(opts);
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  writeFileSync(join(dir, 'base.mjs'), '// base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, store, cleanup };
}

function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

const DELIVERY_DIR = ['.sterling', 'transient', 'delivery'];
const GUARD_FILE = [...DELIVERY_DIR, 'guard-conductor.json'];
const PENDING_FILE = [...DELIVERY_DIR, 'pending.json'];
const ROTATION_NOTE_FILE = ['.sterling', 'transient', 'rotation-note.json'];

const guardPath = (dir) => join(dir, ...GUARD_FILE);
const pendingPath = (dir) => join(dir, ...PENDING_FILE);
const rotationNotePath = (dir) => join(dir, ...ROTATION_NOTE_FILE);

const pendingOf = (dir) => {
  const p = pendingPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const guardOf = (dir) => {
  const p = guardPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

function clearSession(dir) {
  return runHook('h19-clear-session.mjs', { hook_event_name: 'SessionStart', cwd: dir }, dir);
}

// ---------------------------------------------------------------------------
// AC1 — rotation survival: a rotation-note continuation must not wipe the guard.
// ---------------------------------------------------------------------------

test('AC1: a rotation-note continuation leaves the conductor delivery guard intact across SessionStart', () => {
  const { dir, store, cleanup } = gitProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const delivered = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.ok(existsSync(guardPath(dir)), 'fixture sanity: the guard file exists before any SessionStart');
    const guardBefore = guardOf(dir);
    assert.ok(guardBefore, 'fixture sanity: guard content is readable JSON');

    const note = runRotationNote(dir, ['--next-slice', 'Continue the delivery-guard-survival slice']);
    assert.equal(note.status, 0, note.stderr);
    assert.ok(existsSync(rotationNotePath(dir)), 'fixture sanity: rotation note written');

    const r = clearSession(dir);
    assert.equal(r.code, 0, r.stderr);

    // Today h19-clear-session unconditionally rmSync's the whole delivery/ tree —
    // this is expected to FAIL: existsSync(guardPath) is currently false, and even
    // if it survived, the file is currently gone entirely rather than merely
    // re-created, so the deepEqual would fail too.
    assert.ok(existsSync(guardPath(dir)), 'a rotation-note continuation must not wipe the delivery guard');
    assert.deepEqual(guardOf(dir), guardBefore, 'the guard content itself is untouched, not reset-then-rebuilt');

    // h19-clear-session only DECIDES whether to wipe; consuming the note is H1's
    // job (source=clear, single-shot). If h19-clear-session also deletes it, H1
    // never sees it to restore ROTATION RESTORE context.
    assert.ok(existsSync(rotationNotePath(dir)), 'the rotation note itself is left for H1 to consume — h19-clear-session must not eat it');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — regression: a genuine new session (no rotation note) wipes exactly as today.
// This is a REGRESSION guard, not a red test: it is expected to PASS against the
// current implementation and must keep passing once AC1's fix lands.
// ---------------------------------------------------------------------------

test('AC2: with no rotation note present, SessionStart wipes delivery state exactly as today', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.ok(existsSync(join(dir, ...DELIVERY_DIR)), 'fixture sanity: delivery state exists');
    assert.ok(!existsSync(rotationNotePath(dir)), 'fixture sanity: no rotation note in this project');

    const r = clearSession(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, ...DELIVERY_DIR)), 'a genuine new session still wipes the whole delivery tree');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — id-churn survival: an edited (superseded) record must not re-deliver as
// "fresh" on the next touch of the file it governs; a genuinely NEW record on
// the same path must still deliver (scope-growth re-arm untouched).
// ---------------------------------------------------------------------------

test('AC3: a record superseded by knowledge_update (new id, same slug) does not re-deliver, but a genuinely new record on the same path still does', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const alpha = store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(first.code, 0, first.stderr);
    let pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'fixture sanity: alpha delivered once');
    assert.match(pending[0].payload, /alpha does the alpha thing/);

    // Simulate a knowledge_update: the store's supersede path mints a NEW id for
    // the SAME lineage/slug — this is the exact shape a fix-it-forward correction
    // takes (CLAUDE.md "To correct a wrong record, fix it FORWARD").
    store.supersede(alpha.id, {
      ...alpha,
      id: randomUUID(),
      version: 2,
      what_it_does: 'alpha does the alpha thing, reconciled',
      created_at: NOW,
      updated_at: NOW,
      status: 'active',
      superseded_by: null,
      links: [],
    });

    // Expected to FAIL today: the guard keys on the OLD id, which is now
    // superseded and no longer returned by an owner query, so the NEW id looks
    // never-delivered and re-enqueues — pending.length becomes 2 with the same
    // (reconciled) knowledge the reader already saw.
    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0, second.stderr);
    pending = pendingOf(dir);
    assert.equal(pending.length, 1, 'an edited version of already-delivered knowledge must not re-deliver');

    // Scope growth must still re-arm: a genuinely NEW article (different lineage)
    // added to the SAME path is new knowledge, not a re-delivery of old knowledge.
    store.create(article('gamma', ['src/a.mjs']));
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(third.code, 0, third.stderr);
    pending = pendingOf(dir);
    assert.equal(pending.length, 2, 'a genuinely new record on the same path still delivers');
    assert.match(pending[1].payload, /gamma does the gamma thing/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — regression smoke: the existing once-per-session dedup for an unchanged
// record is untouched. The full battery for this is pinned in
// h19-delivery.test.mjs ("guard: same file and same-article new file stay
// silent..."); this is a single smoke assertion, not a duplicate of that suite.
// ---------------------------------------------------------------------------

test('AC4 (smoke): an unchanged record does not re-deliver on a repeat touch of the same file', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1);
    runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(pendingOf(dir).length, 1, 'no repeat delivery for an unchanged record (regression against h19-delivery.test.mjs)');
  } finally {
    cleanup();
  }
});
