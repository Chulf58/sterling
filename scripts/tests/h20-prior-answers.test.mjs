// H20 gains PRIOR-ANSWER pointers (board e7157d0b): a dispatch whose subject an
// existing research_finding already ANSWERS, or a disconfirmed_hypothesis has
// already REFUTED, surfaces those records before the fan-out re-derives them
// (measured waste: a 158k-token debugger re-deriving a recorded diagnosis; a
// 6,142-file sweep on an answered question). Separate file per the h20 test
// convention; harness idiom mirrored from scripts/tests/h20-article-pointers.test.mjs.
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

function finding(question, extra = {}) {
  return {
    ...envelope('research_finding'),
    question,
    answer: 'the recorded answer body — long prose the pointer must never inline',
    source_urls: [],
    source_date: '2026-08-01',
    capture_date: '2026-08-02',
    ...extra,
  };
}

function refuted(question, rejected_answer) {
  return {
    ...envelope('disconfirmed_hypothesis'),
    question,
    rejected_answer,
    evidence: 'debug run evidence',
  };
}

function antiPattern(title, trigger) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-prior-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function dispatch(dir, prompt) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'debugger', prompt }, cwd: dir };
}

// Same proven floor-clearing vocabulary idiom as the sibling h20 files.
const FINDING_QUESTION =
  'Does the breach countdown widget reset the breach countdown seconds when the HUD timer subsystem reloads during a breach?';
const REFUTED_QUESTION =
  'Is the breach countdown widget stalling because the HUD timer subsystem caches breach countdown seconds?';
const QUESTION_PROMPT =
  'Investigate: does the breach countdown widget reset its countdown seconds when the HUD timer reloads — where does the breach countdown state live?';

test('an answered question surfaces as a PRIOR ANSWER pointer — question + both clocks + knowledge_get id, never the answer prose', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const f = store.create(finding(FINDING_QUESTION));
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    assert.equal(r.code, 0, 'never blocks');
    assert.match(r.stdout, /PRIOR ANSWERS in the store/);
    assert.match(r.stdout, /ANSWERED: .*breach countdown widget/);
    assert.match(r.stdout, /source 2026-08-01, captured 2026-08-02/);
    assert.match(r.stdout, new RegExp(`knowledge_get ${f.id}`));
    assert.doesNotMatch(r.stdout, /the recorded answer body/, 'a pointer, never the answer inline');
  } finally {
    cleanup();
  }
});

test('a refuted trail surfaces as REFUTED TRAIL with the rejected answer clipped; a flagged_stale finding carries the re-verify caveat', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(refuted(REFUTED_QUESTION, 'no — the cache was correct; the stall was clock skew'));
    store.create(finding(FINDING_QUESTION, { status: 'flagged_stale' }));
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /REFUTED TRAIL: .*breach countdown widget/);
    assert.match(r.stdout, /rejected: no — the cache was correct/);
    assert.match(r.stdout, /FLAGGED STALE — re-verify before trusting/);
  } finally {
    cleanup();
  }
});

test('question-shaped prompt: the PRIOR ANSWERS block leads, before hazards', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(finding(FINDING_QUESTION));
    store.create(antiPattern('Breach countdown widget flips the HUD timer twice', 'breach countdown widget flips the HUD timer during a breach countdown update'));
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    const prior = r.stdout.indexOf('PRIOR ANSWERS');
    const hazard = r.stdout.indexOf('ANTI-PATTERN');
    assert.ok(prior >= 0, 'prior block present');
    // The hazard MUST fire — without this the ordering assert below passes
    // vacuously whenever a floor tweak silences the seeded anti-pattern
    // (review finding, 2026-08-21).
    assert.ok(hazard >= 0, 'hazard block present');
    assert.ok(prior < hazard, 'prior answers lead on a question-shaped prompt');
  } finally {
    cleanup();
  }
});

test('change-shaped prompt: hazards lead, the PRIOR ANSWERS block follows', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(finding(FINDING_QUESTION));
    store.create(antiPattern('Breach countdown widget flips the HUD timer twice', 'breach countdown widget flips the HUD timer during a breach countdown update'));
    const r = runHook(
      dispatch(dir, 'Fix the breach countdown widget so it never resets the breach countdown seconds when the HUD timer subsystem reloads during a breach.'),
      dir,
    );
    const prior = r.stdout.indexOf('PRIOR ANSWERS');
    const hazard = r.stdout.indexOf('ANTI-PATTERN');
    assert.ok(prior >= 0, 'prior block present');
    assert.ok(hazard >= 0, 'hazard block present');
    assert.ok(hazard < prior, 'hazards lead on a change-shaped prompt');
  } finally {
    cleanup();
  }
});

test('delivered guard: shown prior answers do not re-deliver; a capped-out 4th delivers on the next dispatch', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(store.create(finding(`${FINDING_QUESTION} variant ${i}`)).id);
    }
    const first = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    const shownFirst = ids.filter((id) => first.stdout.includes(id));
    assert.equal(shownFirst.length, 3, 'first dispatch shows 3');
    const second = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    const shownSecond = ids.filter((id) => second.stdout.includes(id));
    // The exact bug the shown-slice rule prevents: marking the CAPPED-OUT 4th
    // as delivered on the first dispatch would silently lose it for the session.
    assert.equal(shownSecond.length, 1, 'second dispatch delivers exactly the capped-out remainder');
    assert.ok(!shownFirst.includes(shownSecond[0]), 'the remainder is the record the cap hid, not a re-delivery');
  } finally {
    cleanup();
  }
});

test('no matching finding/hypothesis: no PRIOR ANSWERS section (silence regression)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(finding('Completely unrelated: how does the shader compiler batch materials for the terrain renderer?'));
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /PRIOR ANSWERS/);
  } finally {
    cleanup();
  }
});

test('cap: more than 3 prior answers shows 3 and discloses the remainder with a widening query', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    for (let i = 0; i < 4; i++) {
      store.create(finding(`${FINDING_QUESTION} variant ${i}`));
    }
    const r = runHook(dispatch(dir, QUESTION_PROMPT), dir);
    const shown = (r.stdout.match(/→ ANSWERED:/g) ?? []).length;
    assert.equal(shown, 3, 'at most 3 pointers shown');
    // stdout is the raw hook JSON, so quotes inside the widening query arrive
    // escaped — assert the escaping-agnostic parts.
    assert.match(r.stdout, /\(\+1 more — knowledge_query types:\[/);
    assert.match(r.stdout, /research_finding.*disconfirmed_hypothesis.*cap:4/);
  } finally {
    cleanup();
  }
});
