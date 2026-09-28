// H20 on the AskUserQuestion surface speaks to a QUESTION, not a build (gap-hunt
// idea 13, decision gap-hunt-2026-09-28-rulings; measured in finding
// sterling-gap-hunt-ranked-ideas-september-2026: 93 injections, median 2.8KB,
// with the dispatch-only "RE-DERIVE … fanning out" wording). Three pins:
//   1. no dispatch/fan-out wording on the question surface;
//   2. prior answers and decisions render as ONE line each, `name (id8)`, name
//      first (CLAUDE.md: never a bare id in front of a human);
//   3. the post-answer audit role is kept (header unchanged, never a gate).
// The dispatch surface is untouched — the last test pins that.
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
const NOW = '2026-09-28T12:00:00.000Z';

let SterlingStore;
let guardPath;
let readGuard;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ guardPath, readGuard } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
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

function decisionRecord(title, statement, slug) {
  return {
    ...envelope('decision'),
    ...(slug ? { slug } : {}),
    title,
    statement,
    alternatives_rejected: [{ option: 'a numeric countdown in the HUD', reason: 'kills the dread' }],
    rationale: 'rationale',
    authority: 'standing',
    file_keys: [],
  };
}

function finding(question, slug) {
  return {
    ...envelope('research_finding'),
    ...(slug ? { slug } : {}),
    question,
    answer: 'the recorded answer body — long prose the pointer must never inline',
    source_urls: [],
    source_date: '2026-09-01',
    capture_date: '2026-09-02',
  };
}

function antiPattern(title, trigger, slug, paths = []) {
  return {
    ...envelope('anti_pattern'),
    ...(slug ? { slug } : {}),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text the question surface must never inline',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-question-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function askQuestion(dir, question, options) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header: 'Countdown', multiSelect: false, options }] },
    session_id: 's1',
    cwd: dir,
  };
}

function dispatch(dir, prompt) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'debugger', prompt }, session_id: 's1', cwd: dir };
}

const DECISION_STATEMENT =
  'No surface may display when the next breach arrives — no seconds, no minutes, no numeric or graphical breach countdown widget.';
const FINDING_QUESTION =
  'Does the breach countdown widget reset the breach countdown seconds when the HUD timer subsystem reloads during a breach?';
const QUESTION = 'Should the breach countdown widget show countdown seconds when the HUD timer reloads during a breach?';
const OPTIONS = [
  { label: 'Numeric seconds', description: 'The breach countdown widget shows countdown seconds' },
  { label: 'Hidden', description: 'No breach countdown on the HUD timer' },
];

const DISPATCH_WORDING = /RE-DERIVE|fanning out|fan-out|about to dispatch|before the brief goes out/;

const HAZARD_TITLE = 'Breach countdown widget re-triggers a HUD timer reload mid-breach';
const HAZARD_TRIGGER =
  'Any breach countdown widget that shows countdown seconds while the HUD timer subsystem reloads during a breach — the reload restarts the seconds from zero.';

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks (AC7); stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('question surface: a matching decision renders as ONE line, name first then (id8), rejected options on that same line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create({
      ...decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT, 'breach-timing-never-shown'),
      alternatives_rejected: [
        { option: 'a numeric countdown in the HUD', reason: 'kills the dread' },
        { option: 'a graphical arc filling toward the breach', reason: 'still a countdown' },
      ],
    });
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    const lines = ctx.split('\n').filter((l) => l.includes(d.id.slice(0, 8)));
    assert.equal(lines.length, 1, `the decision occupies exactly one line:\n${ctx}`);
    assert.match(lines[0], new RegExp(`^\\s+→ breach-timing-never-shown \\(${d.id.slice(0, 8)}\\)`), 'name first, then (id8)');
    assert.ok(!ctx.includes(d.id), 'the full uuid is not printed — the id8 beside the name is the pointer');
    // Review MEDIUM-2: the rejected options are the signal a user's pick may
    // collide with, so they ride the SAME line — never a separate line.
    assert.match(
      lines[0],
      / — rejected: a numeric countdown in the HUD; a graphical arc filling toward the breach/,
      'rejected options appear on the decision line itself'
    );
    assert.doesNotMatch(ctx, /✗ ALREADY REJECTED/, 'the separate multi-line dispatch rejected-options line is still absent');
    assert.match(lines[0], /No surface may display when the next breach arrives/, 'the line still says what the decision rules');
  } finally {
    cleanup();
  }
});

test('question surface: a decision with no slug is named by its title', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    assert.match(ctx, new RegExp(`→ Breach timing is never shown to the player \\(${d.id.slice(0, 8)}\\)`));
  } finally {
    cleanup();
  }
});

test('question surface: a prior answer renders as ONE line, name first then (id8), with question-appropriate wording', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const f = store.create(finding(FINDING_QUESTION, 'breach-countdown-reset-on-reload'));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    const lines = ctx.split('\n').filter((l) => l.includes(f.id.slice(0, 8)));
    assert.equal(lines.length, 1, `the finding occupies exactly one line:\n${ctx}`);
    assert.match(lines[0], new RegExp(`^\\s+→ breach-countdown-reset-on-reload \\(${f.id.slice(0, 8)}\\)`), 'name first, then (id8)');
    assert.match(lines[0], /ANSWERED/, 'the line says it is an answer');
    assert.ok(!ctx.includes(f.id), 'no full uuid');
    assert.doesNotMatch(ctx, /the recorded answer body/, 'still a pointer, never the answer prose');
    assert.doesNotMatch(ctx, DISPATCH_WORDING, 'no dispatch/fan-out wording on a question');
    assert.match(ctx, /PRIOR ANSWERS[^\n]*question/, 'the block header speaks about the question just asked');
  } finally {
    cleanup();
  }
});

test('question surface: a matching hazard renders as ONE line, name first then (id8), with HAZARD: and the clipped trigger', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, 'breach-countdown-hud-reload'));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    const lines = ctx.split('\n').filter((l) => l.includes(ap.id.slice(0, 8)));
    assert.equal(lines.length, 1, `the hazard occupies exactly one line:\n${ctx}`);
    assert.match(
      lines[0],
      new RegExp(`^\\s+→ breach-countdown-hud-reload \\(${ap.id.slice(0, 8)}\\) — HAZARD: `),
      'name first, then (id8), then HAZARD:'
    );
    assert.ok(!ctx.includes(ap.id), 'the full uuid is not printed — the id8 beside the name is the pointer');
    assert.doesNotMatch(ctx, /RIGHT WAY:/, 'the right-way body is never inlined on the question surface');
    assert.doesNotMatch(ctx, /right way text the question surface must never inline/, 'the right_way field itself is never inlined');
    assert.doesNotMatch(ctx, /⚠ ANTI-PATTERN \[/, 'the whole-hazard header form is not used here');
    assert.match(lines[0], /HAZARD: Any breach countdown widget that shows countdown seconds/, 'the clipped trigger rides the line');
  } finally {
    cleanup();
  }
});

test('question surface: a hazard with no slug is named by its title', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    assert.match(ctx, new RegExp(`→ ${HAZARD_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(${ap.id.slice(0, 8)}\\) — HAZARD: `));
  } finally {
    cleanup();
  }
});

test('same-session guard: a hazard shown as a question pointer must still render WHOLE on a later dispatch (decision 6300c1e8)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, 'breach-countdown-hud-reload'));
    // First: AskUserQuestion — the hazard renders as a one-line pointer, which
    // marks it DISCOVERY only (never substance — it was never shown whole).
    const first = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    assert.match(first, /HAZARD: Any breach countdown widget that shows countdown seconds/, 'the pointer rendered on the question surface');
    // Then: a Task dispatch on the SAME subject, same session (shared guard).
    // A discovery mark must never suppress dispatch's own WHOLE rendering —
    // that would violate 301d8a0a's "dispatch keeps hazards whole" via the
    // pre-filter alone, with no record of it ever having been shown whole.
    const second = runHook(
      dispatch(dir, 'Investigate: should the breach countdown widget show countdown seconds when the HUD timer reloads during a breach?'),
      dir
    );
    assert.equal(second.code, 0, 'never blocks (AC7)');
    assert.notEqual(second.stdout, '', 'the hazard must still be delivered on this later dispatch, not silently dropped by the pre-filter');
    const ctx2 = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(
      ctx2,
      /⚠ ANTI-PATTERN \[WARN\] for this subject — 'Breach countdown widget re-triggers a HUD timer reload mid-breach'/,
      'the hazard renders WHOLE on dispatch, even though it was already shown as a question pointer'
    );
    assert.match(ctx2, /TRIGGER: Any breach countdown widget that shows countdown seconds/);
    assert.match(ctx2, /RIGHT WAY: right way text the question surface must never inline/);
  } finally {
    cleanup();
  }
});

test('same-session guard: after the question surface, the hazard sits in guard.discovery, never guard.substance', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ap = store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, 'breach-countdown-hud-reload'));
    ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    const gPath = guardPath(dir, undefined, 's1');
    const guard = readGuard(gPath);
    assert.ok(guard.discovery.some((e) => e.id === ap.id), 'the question-surface pointer marks discovery');
    assert.ok(!guard.substance.some((e) => e.id === ap.id), 'but never substance — a pointer is not the whole hazard');
  } finally {
    cleanup();
  }
});

test('question surface: the post-answer audit role is kept', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT, 'breach-timing-never-shown'));
    store.create(finding(FINDING_QUESTION, 'breach-countdown-reset-on-reload'));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    assert.match(ctx, /put a CHOICE TO THE USER/);
    assert.match(ctx, /POST-ANSWER AUDIT, NOT A GATE/);
    assert.match(ctx, /re-affirm before acting on the answer/);
    assert.doesNotMatch(ctx, DISPATCH_WORDING);
  } finally {
    cleanup();
  }
});

test('dispatch surface is unchanged: prior answers keep the RE-DERIVE wording, decisions keep the full pointer, and hazards still render WHOLE', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT, 'breach-timing-never-shown'));
    const f = store.create(finding(FINDING_QUESTION, 'breach-countdown-reset-on-reload'));
    const ap = store.create(antiPattern(HAZARD_TITLE, HAZARD_TRIGGER, 'breach-countdown-hud-reload'));
    const ctx = ctxOf(
      runHook(dispatch(dir, 'Investigate: should the breach countdown widget show countdown seconds when the HUD timer reloads during a breach?'), dir)
    );
    assert.match(ctx, /RE-DERIVE/);
    assert.ok(ctx.includes(`knowledge_get ${f.id}`), 'prior answer keeps the full-id read');
    assert.ok(ctx.includes(`knowledge_get ${d.id}`), 'decision keeps the full-id read');
    assert.match(ctx, /ALREADY REJECTED/);
    // 301d8a0a still governs the dispatch surface: hazards render WHOLE there,
    // never as the question surface's one-line pointer.
    assert.match(ctx, /⚠ ANTI-PATTERN \[WARN\] for this subject — '.*Breach countdown widget re-triggers/);
    assert.match(ctx, /TRIGGER: Any breach countdown widget that shows countdown seconds/);
    assert.match(ctx, /RIGHT WAY: right way text the question surface must never inline/);
    assert.ok(ctx.includes(`knowledge_get ${ap.id}`), 'hazard keeps the full-id read on the dispatch surface');
  } finally {
    cleanup();
  }
});
