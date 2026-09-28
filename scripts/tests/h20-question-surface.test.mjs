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

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks (AC7); stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('question surface: a matching decision renders as ONE line, name first then (id8), no second rejected-options line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT, 'breach-timing-never-shown'));
    const ctx = ctxOf(runHook(askQuestion(dir, QUESTION, OPTIONS), dir));
    const lines = ctx.split('\n').filter((l) => l.includes(d.id.slice(0, 8)));
    assert.equal(lines.length, 1, `the decision occupies exactly one line:\n${ctx}`);
    assert.match(lines[0], new RegExp(`^\\s+→ breach-timing-never-shown \\(${d.id.slice(0, 8)}\\)`), 'name first, then (id8)');
    assert.ok(!ctx.includes(d.id), 'the full uuid is not printed — the id8 beside the name is the pointer');
    assert.doesNotMatch(ctx, /ALREADY REJECTED/, 'the multi-line dispatch rendering is not used on the question surface');
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

test('dispatch surface is unchanged: prior answers keep the RE-DERIVE wording and decisions keep the full pointer', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const d = store.create(decisionRecord('Breach timing is never shown to the player', DECISION_STATEMENT, 'breach-timing-never-shown'));
    const f = store.create(finding(FINDING_QUESTION, 'breach-countdown-reset-on-reload'));
    const ctx = ctxOf(
      runHook(dispatch(dir, 'Investigate: should the breach countdown widget show countdown seconds when the HUD timer reloads during a breach?'), dir)
    );
    assert.match(ctx, /RE-DERIVE/);
    assert.ok(ctx.includes(`knowledge_get ${f.id}`), 'prior answer keeps the full-id read');
    assert.ok(ctx.includes(`knowledge_get ${d.id}`), 'decision keeps the full-id read');
    assert.match(ctx, /ALREADY REJECTED/);
  } finally {
    cleanup();
  }
});
