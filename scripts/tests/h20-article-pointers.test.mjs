// H20 subject-axis delivery gains feature_article POINTERS (consuming-project
// retro 2026-08-17-2111: two wasted explorer dispatches, ~165k tokens, and a
// wrong statement to the user — a dispatch whose subject an article fully
// answered got hazards and decisions but never the article, because H20's
// record-type carve excludes feature_article entirely).
//
// This file is a SEPARATE test file, not an edit to
// scripts/tests/h20-mechanism-axis.test.mjs or scripts/tests/h20-centrality.test.mjs
// — it reuses their harness idiom (temp project + store fixtures, runHook/
// dispatch helpers) without modifying either.
//
// NOT YET IMPLEMENTED (red gate): feature_article is not delivered by H20 at
// all today, so every test below fails on ITS OWN assertion against current
// behavior (either the payload is empty/silent where a pointer is now
// required, or the ordering/cap/disclosure assertions have nothing to match).
//
// Behavioral spec under test (see task brief):
//   AC1 — pointer delivered: slug + title + knowledge_get reference, NEVER
//         the article's what_it_does prose.
//   AC2 — ranking: question-shaped prompt -> articles BEFORE hazards;
//         change-shaped prompt -> hazards BEFORE articles (existing order).
//   AC3 — disclosure: a matched article is never silently withheld — if
//         hazards are delivered for a subject that also matched an article,
//         the article pointer accompanies them.
//   AC4 — regression: a prompt matching NO articles behaves exactly as
//         today (hazard/decision delivery unchanged; no empty ARTICLES
//         section; no new noise from an unrelated, non-matching article).
//   AC5 — cap: at most 3 article pointers per dispatch; the cap is
//         DISCLOSED ("more matched") when exceeded, never silently truncated.
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
const NOW = '2026-08-20T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
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

// Mirrors the feature_article fixture idiom from scripts/tests/h19-delivery.test.mjs
// and scripts/tests/h19-dispatch-staging.test.mjs (same field set, this file's own
// title/what_it_does content).
function article(slug, title, whatItDoes, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title,
    what_it_does: whatItDoes,
    intended_behavior: `${slug} intends`,
    files: [{ path: `game/unrelated/${slug}.gd`, role: 'owner' }],
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function antiPattern(title, trigger, paths = []) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-articles-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function dispatch(dir, prompt, subagent_type = 'coder') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type, prompt }, cwd: dir };
}

// --- shared domain vocabulary --------------------------------------------
//
// 'breach'/'countdown' proven (in scripts/tests/h20-mechanism-axis.test.mjs)
// to clear the existing stage-2 floors (>=2 distinct hits, at least one
// discriminating, non-generic term) for a decision fixture built from the
// same vocabulary. Repeated 3x+ across title+what_it_does here so the terms
// also dominate the record's OWN top-K frequency, clearing any centrality
// floor (scripts/tests/h20-centrality.test.mjs) that may compose in too.
const ARTICLE_TITLE = 'Breach countdown widget governs the HUD timer subsystem';
const ARTICLE_WHAT_IT_DOES =
  'The breach countdown widget tracks breach countdown seconds and renders the breach countdown ' +
  'arc so the player can see the seconds until the next breach arrives.';

const HAZARD_TITLE = 'Breach countdown widget flips the HUD timer twice';
const HAZARD_TRIGGER =
  'breach countdown breach countdown widget flips the HUD timer twice whenever the breach ' +
  'countdown value updates during a breach';

const QUESTION_PROMPT =
  'Where can I find the breach countdown widget for the HUD — does one already exist, and how many seconds does it show?';
const CHANGE_PROMPT = 'Implement a breach countdown widget for the HUD timer subsystem.';

// --- AC1: pointer, not full body -------------------------------------------

test('AC1: a dispatch matching a feature_article delivers slug + title + knowledge_get reference, never the what_it_does prose', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const a = store.create(article('breach-countdown-hud', ARTICLE_TITLE, ARTICLE_WHAT_IT_DOES));
    const r = runHook(dispatch(dir, CHANGE_PROMPT), dir);
    assert.equal(r.code, 0, 'never blocks (AC7 floor)');
    assert.notEqual(r.stdout, '', 'a matching article must produce SOME delivery — today this is empty (feature_article is excluded)');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /breach-countdown-hud/, 'the slug identifies the article');
    assert.match(ctx, new RegExp(ARTICLE_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the title is named');
    assert.match(ctx, new RegExp(`knowledge_get ${a.id}`), 'a knowledge_get reference resolves the full record');
    assert.doesNotMatch(
      ctx,
      /renders the breach countdown arc so the player can see the seconds/,
      'the what_it_does prose (the article BODY) must never appear — pointer only'
    );
  } finally {
    cleanup();
  }
});

// --- AC2: ranking depends on prompt shape -----------------------------------

test('AC2: a QUESTION-SHAPED prompt ranks article pointers ABOVE hazard/decision blocks', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('breach-countdown-hud', ARTICLE_TITLE, ARTICLE_WHAT_IT_DOES));
    store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, ['game/hud/timer.gd']));
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, '', 'both the article and the hazard match this subject');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const articleIdx = ctx.indexOf('breach-countdown-hud');
    const hazardIdx = ctx.indexOf(HAZARD_TITLE);
    assert.ok(articleIdx >= 0, 'article pointer present');
    assert.ok(hazardIdx >= 0, 'hazard present');
    assert.ok(articleIdx < hazardIdx, 'question-shaped prompt: article pointer must lead the hazard block');
  } finally {
    cleanup();
  }
});

test('AC2: a CHANGE-SHAPED prompt preserves the existing hazard-first order (articles after)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('breach-countdown-hud', ARTICLE_TITLE, ARTICLE_WHAT_IT_DOES));
    store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, ['game/hud/timer.gd']));
    const r = runHook(dispatch(dir, CHANGE_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, '');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const articleIdx = ctx.indexOf('breach-countdown-hud');
    const hazardIdx = ctx.indexOf(HAZARD_TITLE);
    assert.ok(articleIdx >= 0, 'article pointer present');
    assert.ok(hazardIdx >= 0, 'hazard present');
    assert.ok(hazardIdx < articleIdx, 'change-shaped prompt: the existing hazard-first order must be unchanged');
  } finally {
    cleanup();
  }
});

// --- AC3: disclosure — a matched article never rides silently along --------

test('AC3: a hazard delivered for a subject that ALSO matched an article must carry the article pointer too', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('breach-countdown-hud', ARTICLE_TITLE, ARTICLE_WHAT_IT_DOES));
    store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, ['game/hud/timer.gd']));
    const r = runHook(dispatch(dir, CHANGE_PROMPT), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(HAZARD_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the hazard delivers (unchanged)');
    assert.match(ctx, /breach-countdown-hud/, 'the matched article is disclosed alongside it, never silently withheld');
  } finally {
    cleanup();
  }
});

// --- AC4: regression — no articles matched behaves exactly as today --------

test('AC4: a prompt matching NO articles leaves hazard/decision delivery unchanged, with no article noise', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Reuses the proven mechanism-axis fixture (signal/boot domain) so the
    // hazard is known to clear the existing floors on its own.
    store.create(
      antiPattern(
        'Signal connected at boot but emitter initialises later',
        'whenever a node connects a signal in _ready() but finishes initialising LATER',
        ['game/run/worker_crew.gd']
      )
    );
    // An article that shares NO vocabulary with the dispatch subject at all.
    const unrelated = store.create(
      article(
        'invoice-export-csv',
        'Invoice export produces a CSV with a header row',
        'Invoice export renders every invoice line as a CSV row with a fixed header.'
      )
    );
    const r = runHook(
      dispatch(dir, 'Wire the harvester so it connects its ready signal in _ready(), then finishes initialising the crew later in the boot sequence.'),
      dir
    );
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Signal connected at boot but emitter initialises later/, 'the hazard delivery is unchanged (AC4)');
    assert.doesNotMatch(ctx, /invoice-export-csv/, 'the unrelated, non-matching article must never appear');
    assert.doesNotMatch(ctx, /Invoice export produces a CSV/, 'nor its title, as a stray "ARTICLES (0)" section or similar');
    assert.doesNotMatch(ctx, new RegExp(`knowledge_get ${unrelated.id}`), 'no pointer is emitted for a record that never matched');
  } finally {
    cleanup();
  }
});

test('AC4: a prompt matching nothing at all (no hazards, no articles) stays fully silent — no new noise', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      article(
        'invoice-export-csv',
        'Invoice export produces a CSV with a header row',
        'Invoice export renders every invoice line as a CSV row with a fixed header.'
      )
    );
    const r = runHook(dispatch(dir, 'Rename the invoice tax column to vat_amount and update the two callers.'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'an unrelated article sitting in the store must not turn a silent dispatch into a noisy one');
  } finally {
    cleanup();
  }
});

// --- AC5: cap at 3, disclosed when exceeded ---------------------------------

test('AC5: article pointers are capped at 3 per dispatch, and the overflow is DISCLOSED, never silently dropped', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const title = `Breach countdown module ${i} governs the HUD timer subsystem`;
      const whatItDoes =
        `Breach countdown module ${i} tracks breach countdown seconds and renders the breach countdown ` +
        `arc for module ${i} so the player can see the seconds until the next breach arrives.`;
      const rec = store.create(article(`breach-countdown-module-${i}`, title, whatItDoes));
      ids.push(rec.id);
    }
    const r = runHook(dispatch(dir, CHANGE_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, '', 'all four articles match the same dominant breach/countdown vocabulary');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const deliveredCount = ids.filter((id) => ctx.includes(`knowledge_get ${id}`)).length;
    assert.equal(deliveredCount, 3, 'at most 3 article pointers render per dispatch (AC5 cap)');
    assert.match(ctx, /more matched/i, 'the excluded 4th article is disclosed with a "more matched" line, never silently truncated');
  } finally {
    cleanup();
  }
});
