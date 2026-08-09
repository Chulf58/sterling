// H19 hazard COUNT CAP with STATED OVERFLOW (spec-only, TDD-red).
//
// New behavior under test (not yet implemented):
//   1. renderHazards / its H19 call sites cap at HAZARD_CAP (default 3),
//      exported as a named constant from scripts/hooks/lib/delivery.mjs.
//   2. The cap applies AFTER sorting by severity (block > warn > info,
//      absent severity == warn) — the rendered hazards are the MOST severe.
//   3. When hazards are dropped by the cap, the payload states the dropped
//      COUNT and a widening `knowledge_query` naming the anti_pattern type
//      and the touched path. When <= cap hazards match, no overflow line
//      renders at all.
//   4. AC8: the session guard only marks hazards that actually rendered — a
//      capped-away hazard is delivered on the NEXT touch of the same path by
//      the same agent, and the already-rendered ones are not repeated.
//
// This file follows the harness conventions of scripts/tests/h19-delivery.test.mjs
// (temp project + store, runHook, article/antiPattern envelope builders, rung
// 'read' for direct additionalContext injection) without modifying that file.
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
const NOW = '2026-07-19T12:00:00.000Z';

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

function makeProject({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-hazcap-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

function ctxOf(result) {
  assert.equal(result.code, 0, `hook must not block (AC7): ${result.stderr}`);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

// ---------------------------------------------------------------------------
// Interface: the cap is a named, exported constant, default 3.
// ---------------------------------------------------------------------------

test('HAZARD_CAP: lib/delivery.mjs exports the cap constant, default 3', async () => {
  const m = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href);
  assert.equal(m.HAZARD_CAP, 3, 'the hazard renderer caps at a named, exported constant (default 3)');
});

// ---------------------------------------------------------------------------
// 1 + 4: cap after sort, severity order preserved within the cap.
// ---------------------------------------------------------------------------

test('H19 hazard cap: with 5 hazards of mixed severity, exactly 3 render, most-severe-first', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('sev-block', ['src/a.mjs'], { severity: 'block' }));
    store.create(antiPattern('sev-warn-1', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('sev-warn-2', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('sev-none', ['src/a.mjs'])); // absent severity reads as warn
    store.create(antiPattern('sev-info', ['src/a.mjs'], { severity: 'info' }));

    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    const blocks = ctx.match(/ANTI-PATTERN \[[A-Z]+\] for this path/g) || [];
    assert.equal(blocks.length, 3, `exactly HAZARD_CAP hazard blocks render, got ${blocks.length}`);

    assert.match(ctx, /'sev-block'/, 'the single block-severity hazard is always kept (most severe)');
    assert.doesNotMatch(ctx, /'sev-info'/, 'the sole info-severity hazard is dropped (least severe)');

    const warnTier = ['sev-warn-1', 'sev-warn-2', 'sev-none'];
    const presentWarnTier = warnTier.filter((t) => ctx.includes(`'${t}'`));
    assert.equal(presentWarnTier.length, 2, 'exactly one of the three warn-tier hazards is dropped to make room for the cap');

    // Severity order preserved within the cap: block leads every surviving warn-tier hazard.
    const blockIdx = ctx.indexOf("'sev-block'");
    for (const t of presentWarnTier) {
      assert.ok(blockIdx < ctx.indexOf(`'${t}'`), `block-severity hazard must render before warn-tier hazard '${t}'`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2: stated overflow, never silent — and never present when nothing was dropped.
// ---------------------------------------------------------------------------

test('H19 hazard cap: overflow states the dropped count and a widening query naming anti_pattern + the touched path', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('h-block', ['src/a.mjs'], { severity: 'block' }));
    store.create(antiPattern('h-warn-1', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('h-warn-2', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('h-none', ['src/a.mjs']));
    store.create(antiPattern('h-info', ['src/a.mjs'], { severity: 'info' }));

    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    assert.match(ctx, /2 more/, '5 hazards capped to 3 drops exactly 2 — the count is stated, never silent');

    const widening = ctx
      .split('\n')
      .find((l) => l.includes('knowledge_query') && l.includes('anti_pattern') && l.includes('src/a.mjs'));
    assert.ok(
      widening,
      `expected a widening-query line naming anti_pattern + the touched path + knowledge_query; got:\n${ctx}`
    );
  } finally {
    cleanup();
  }
});

test('H19 hazard cap: 3 or fewer hazards render all of them and state no overflow', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern('only-block', ['src/a.mjs'], { severity: 'block' }));
    store.create(antiPattern('only-warn', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('only-info', ['src/a.mjs'], { severity: 'info' }));

    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    // This half must PASS against current (uncapped) behavior too — pinned anyway.
    assert.match(ctx, /'only-block'/);
    assert.match(ctx, /'only-warn'/);
    assert.match(ctx, /'only-info'/);
    assert.doesNotMatch(ctx, /\d+ more/i, 'no overflow phrase renders when nothing was dropped by the cap');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3 (AC8): guard only marks what actually rendered — capped-away hazards
// surface on the next touch instead of vanishing, and already-rendered ones
// do not repeat.
// ---------------------------------------------------------------------------

test('H19 hazard cap (AC8): a second touch of the same path delivers the previously-capped hazards, not the already-shown ones', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const titles = ['g-block', 'g-warn-1', 'g-warn-2', 'g-none', 'g-info'];
    store.create(antiPattern('g-block', ['src/a.mjs'], { severity: 'block' }));
    store.create(antiPattern('g-warn-1', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('g-warn-2', ['src/a.mjs'], { severity: 'warn' }));
    store.create(antiPattern('g-none', ['src/a.mjs']));
    store.create(antiPattern('g-info', ['src/a.mjs'], { severity: 'info' }));

    const ctx1 = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    const delivered1 = titles.filter((t) => ctx1.includes(`'${t}'`));
    const dropped1 = titles.filter((t) => !ctx1.includes(`'${t}'`));
    assert.equal(delivered1.length, 3, 'sanity: the cap held on the first touch');
    assert.equal(dropped1.length, 2, 'sanity: exactly 2 were capped away on the first touch');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0, `second touch must not block (AC7): ${second.stderr}`);
    assert.notEqual(second.stdout, '', 'the second touch must deliver — the capped hazards were never marked as delivered');
    const ctx2 = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;

    for (const t of dropped1) {
      assert.match(ctx2, new RegExp(`'${t}'`), `previously-capped hazard '${t}' must surface on the next touch (AC8)`);
    }
    for (const t of delivered1) {
      assert.doesNotMatch(ctx2, new RegExp(`'${t}'`), `already-rendered hazard '${t}' must not repeat (AC4 still holds)`);
    }

    // Only the 2 never-rendered hazards remain — under the cap, so no overflow this time.
    assert.doesNotMatch(ctx2, /\d+ more/i, 'nothing is dropped on the second touch, so nothing is disclosed as dropped');

    // A third touch re-delivers nothing: everything governing the path has now been shown.
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(third.code, 0);
    assert.equal(third.stdout, '', 'the guard converges once every hazard has actually been rendered (AC4)');
  } finally {
    cleanup();
  }
});
