// Pending answers (decision answered-question-forms-are-kept-as-pending-answers-in-a-tra):
// payload -> entry for both hosts, the Claude hook and drain end to end, the notice, and
// the resolve tool. The Claude payload is a live PostToolUse capture (Claude Code 2.1.332).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SterlingStore } from '../../packages/store/dist/index.js';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';
import { appendPendingAnswer, entryFromClaude, entryFromOpenCode, pendingAnswersNotice, readPendingAnswers, resolvePendingAnswers, PENDING_ANSWERS_REL } from '../hooks/lib/pending-answers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const claudeFixture = () => JSON.parse(readFileSync(join(here, 'fixtures', 'claude-askuserquestion-posttooluse.json'), 'utf8'));
const NOW = '2026-11-26T13:00:00.000Z';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pending-answers-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const colourForm = [{ header: 'Colour', question: 'Pick a colour', multiple: false, options: [{ label: 'Red', description: 'r' }, { label: 'Green', description: 'g' }] }];

test('Claude Code payload (live fixture) becomes one entry with the picked label', () => {
  const entry = entryFromClaude(claudeFixture(), NOW);
  assert.equal(entry.host, 'claude');
  assert.equal(entry.session, '9ad984d4-6f48-41a0-b799-b29a0d59c0d5');
  assert.equal(entry.call_id, 'toolu_01Dt8VbzRwHBsXZM18cEWJia');
  assert.equal(entry.time, NOW);
  assert.match(entry.id, /^[0-9a-f]{8}$/);
  assert.equal(entry.questions.length, 1);
  assert.equal(entry.questions[0].question, 'Pick a colour');
  assert.deepEqual(entry.questions[0].options.map((o) => o.label), ['Red', 'Green', 'Blue']);
  assert.deepEqual(entry.questions[0].picks, [{ label: 'Red', custom: false }]);
});

test('Claude Code: a typed own answer is custom, and a payload without answers yields nothing', () => {
  const stdin = claudeFixture();
  stdin.tool_response.answers = { 'Pick a colour': 'Teal' };
  assert.deepEqual(entryFromClaude(stdin, NOW).questions[0].picks, [{ label: 'Teal', custom: true }]);
  stdin.tool_response.answers = {};
  assert.equal(entryFromClaude(stdin, NOW), null);
});

test('OpenCode payload becomes an entry; a typed own answer is custom; a multi-select keeps every pick', () => {
  const questions = [
    ...colourForm,
    { header: 'Extras', question: 'Pick extras', multiple: true, options: [{ label: 'Usage', description: 'u' }, { label: 'Duration', description: 'd' }] },
  ];
  const call = { tool: 'question', status: 'completed', id: 'call_1', sessionID: 'ses_a', input: { questions }, result: { content: [], metadata: { answers: [['Green'], ['Usage', 'my own note']] } } };
  const entry = entryFromOpenCode(call, NOW);
  assert.equal(entry.host, 'opencode');
  assert.equal(entry.session, 'ses_a');
  assert.equal(entry.call_id, 'call_1');
  assert.deepEqual(entry.questions[0].picks, [{ label: 'Green', custom: false }]);
  assert.deepEqual(entry.questions[1].picks, [{ label: 'Usage', custom: false }, { label: 'my own note', custom: true }]);
  assert.equal(entry.questions[1].multiple, true);
});

test('OpenCode: a dismissed (aborted) form, another tool and an all-empty answer produce nothing', () => {
  const base = { tool: 'question', id: 'call_2', sessionID: 'ses_a', input: { questions: colourForm } };
  assert.equal(entryFromOpenCode({ ...base, status: 'error', error: { type: 'aborted' } }, NOW), null);
  assert.equal(entryFromOpenCode({ ...base, tool: 'read', status: 'completed', result: { metadata: { answers: [['Red']] } } }, NOW), null);
  assert.equal(entryFromOpenCode({ ...base, status: 'completed', result: { metadata: { answers: [[]] } } }, NOW), null);
});

test('append dedupes the same call; the notice counts entries and is silent at zero', () => {
  const p = project();
  try {
    assert.equal(pendingAnswersNotice(p.dir), '');
    const entry = entryFromClaude(claudeFixture(), NOW);
    assert.equal(appendPendingAnswer(p.dir, entry), true);
    assert.equal(appendPendingAnswer(p.dir, entry), false, 'the same call is kept once');
    const notice = pendingAnswersNotice(p.dir);
    assert.match(notice, /^PENDING ANSWERS: 1 answered question form not yet recorded/);
    assert.ok(notice.includes(entry.id));
    appendPendingAnswer(p.dir, { ...entry, id: 'deadbeef', call_id: 'other' });
    assert.match(pendingAnswersNotice(p.dir), /^PENDING ANSWERS: 2 answered question forms/);
    resolvePendingAnswers(p.dir, [entry.id, 'deadbeef']);
    assert.equal(pendingAnswersNotice(p.dir), '', 'silent again at zero');
  } finally {
    p.cleanup();
  }
});

test('an unreadable pending file is said, never read as zero', () => {
  const p = project();
  try {
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(p.dir, PENDING_ANSWERS_REL))}, '{ nope')`]);
    assert.match(pendingAnswersNotice(p.dir), /^PENDING ANSWERS UNREADABLE/);
  } finally {
    p.cleanup();
  }
});

test('pending_answers_resolve removes named entries, refuses unknown ids without removing anything, and needs record_id for recorded', () => {
  const p = project();
  const store = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
  try {
    const tools = new SterlingTools({ store, now: () => NOW, repoRoot: p.dir });
    const a = entryFromClaude(claudeFixture(), NOW);
    appendPendingAnswer(p.dir, a);
    appendPendingAnswer(p.dir, { ...a, id: 'cafef00d', call_id: 'two' });
    assert.throws(() => tools.pendingAnswersResolve({ ids: [a.id, 'ffffffff'], outcome: 'not_a_decision' }), /no pending answer with id ffffffff/);
    assert.equal(readPendingAnswers(p.dir).length, 2, 'a refused call removes nothing');
    assert.throws(() => tools.pendingAnswersResolve({ ids: [a.id], outcome: 'recorded' }), /record_id/);
    assert.deepEqual(tools.pendingAnswersResolve({ ids: [a.id], outcome: 'recorded', record_id: 'my-decision' }), { resolved: [a.id], outcome: 'recorded', record_id: 'my-decision' });
    assert.deepEqual(readPendingAnswers(p.dir).map((e) => e.id), ['cafef00d']);
    tools.pendingAnswersResolve({ ids: ['cafef00d'], outcome: 'not_a_decision' });
    assert.equal(readPendingAnswers(p.dir).length, 0);
  } finally {
    store.close();
    p.cleanup();
  }
});

test('Claude hooks end to end: H32 appends the live payload once, H19 drain tells the next prompt, silent after resolve', () => {
  const p = project();
  try {
    const payload = { ...claudeFixture(), cwd: p.dir };
    const run = (hook, input) => spawnSync('node', [join(repo, 'hooks', hook)], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(run('h32-pending-answers.mjs', payload).status, 0);
    assert.equal(run('h32-pending-answers.mjs', payload).status, 0);
    const entries = readPendingAnswers(p.dir);
    assert.equal(entries.length, 1, 'the same tool_use_id is kept once');
    const drain = run('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', session_id: payload.session_id, cwd: p.dir, prompt: 'hi' });
    assert.match(JSON.parse(drain.stdout).hookSpecificOutput.additionalContext, /PENDING ANSWERS: 1 answered question form not yet recorded/);
    resolvePendingAnswers(p.dir, [entries[0].id]);
    const quiet = run('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', session_id: payload.session_id, cwd: p.dir, prompt: 'hi' });
    assert.doesNotMatch(quiet.stdout, /PENDING ANSWERS/);
  } finally {
    p.cleanup();
  }
});

test('hooks.json registers H32 on PostToolUse for AskUserQuestion (a direct-invocation test bypasses the matcher)', () => {
  const hooks = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse;
  const entry = hooks.find((h) => h.matcher === 'AskUserQuestion');
  assert.ok(entry, 'PostToolUse has an AskUserQuestion matcher');
  assert.ok(entry.hooks.some((h) => h.command.includes('h32-pending-answers.mjs')));
  assert.ok(existsSync(join(repo, 'hooks', 'h32-pending-answers.mjs')));
});
