// Pending answers (decision answered-question-forms-are-kept-as-pending-answers-in-a-tra):
// payload -> entry for both hosts, the Claude hook and drain end to end, the notice, and
// the resolve tool. The Claude payload is a live PostToolUse capture (Claude Code 2.1.332).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SterlingStore } from '../../packages/store/dist/index.js';
import { SterlingTools } from '../../packages/mcp-server/dist/tools.js';
import { appendPendingAnswer, pendingAnswersBlock, entryFromClaude, entryFromOpenCode, pendingAnswersNotice, readPendingAnswers, resolvePendingAnswers, PENDING_ANSWERS_REL } from '../hooks/lib/pending-answers.mjs';

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
  assert.match(entry.id, /^[0-9a-f]{32}$/);
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

const NOW_ISO = '2026-11-26T13:00:00.000Z';
const recordEnvelope = (type, status = 'active') => ({ id: randomUUID(), type, created_at: NOW_ISO, updated_at: NOW_ISO, author: 'conductor', status, superseded_by: null, links: [], scope: 'project', stack_tags: [] });
const decisionRecord = (title) => ({ ...recordEnvelope('decision'), title, statement: 'We keep pending answers until resolved.', alternatives_rejected: [{ option: 'drop them', reason: 'loses rulings' }], rationale: 'r', file_keys: [] });
const hazardRecord = (title) => ({ ...recordEnvelope('anti_pattern'), title, trigger: 'a trigger', guidance: 'g', wrong_way: 'w', right_way: 'r', source_evidence: 'e', basis: 'codebase', file_keys: [] });

function toolsFor(p, extra = {}) {
  const store = new SterlingStore(join(p.dir, '.sterling', 'sterling.db'));
  return { store, tools: new SterlingTools({ store, now: () => NOW, repoRoot: p.dir, ...extra }) };
}

test('pending_answers_resolve: a recorded outcome needs a live decision, refuses the whole batch otherwise, and removes only on success', () => {
  const p = project();
  const { store, tools } = toolsFor(p);
  try {
    const live = decisionRecord('pending answers are kept until resolved');
    const hazard = hazardRecord('a hazard, not a decision');
    store.create(live);
    store.create(hazard);
    const a = entryFromClaude(claudeFixture(), NOW);
    appendPendingAnswer(p.dir, a);
    appendPendingAnswer(p.dir, { ...a, id: 'c'.repeat(32), call_id: 'two' });
    const refused = (args, re) => {
      assert.throws(() => tools.pendingAnswersResolve(args), re);
      assert.equal(readPendingAnswers(p.dir).length, 2, 'a refused call changes nothing');
    };
    refused({ ids: [a.id, 'f'.repeat(32)], outcome: 'not_a_decision' }, /no pending answer with id f{32}/);
    refused({ ids: [a.id], outcome: 'recorded' }, /record_id/);
    refused({ ids: [a.id], outcome: 'recorded', record_id: '   ' }, /record_id|too_small|at least 1/);
    refused({ ids: [a.id], outcome: 'recorded', record_id: 'no-such-decision-anywhere' }, /no-such-decision-anywhere/);
    refused({ ids: [a.id], outcome: 'recorded', record_id: hazard.id }, /needs a live decision/);
    const done = tools.pendingAnswersResolve({ ids: [a.id], outcome: 'recorded', record_id: live.id });
    assert.deepEqual(done, { resolved: [a.id], outcome: 'recorded', record_id: live.id });
    assert.deepEqual(readPendingAnswers(p.dir).map((e) => e.id), ['c'.repeat(32)]);
    tools.pendingAnswersResolve({ ids: ['c'.repeat(32)], outcome: 'not_a_decision' });
    assert.equal(readPendingAnswers(p.dir).length, 0);
  } finally {
    store.close();
    p.cleanup();
  }
});

test('pending_answers_resolve works on the checkout root, never the store root, when the two differ', () => {
  const storeProject = project();
  const checkout = project();
  const { store, tools } = toolsFor(storeProject, { checkoutRoot: checkout.dir });
  try {
    const e = entryFromClaude(claudeFixture(), NOW);
    appendPendingAnswer(storeProject.dir, e);
    appendPendingAnswer(checkout.dir, e);
    tools.pendingAnswersResolve({ ids: [e.id], outcome: 'not_a_decision' });
    assert.equal(readPendingAnswers(checkout.dir).length, 0, "the checkout's file is the one resolved");
    assert.deepEqual(readPendingAnswers(storeProject.dir).map((x) => x.id), [e.id], "the store root's file is untouched");
  } finally {
    store.close();
    storeProject.cleanup();
    checkout.cleanup();
  }
});

test('ids cover host, session and call: entries whose old 8-hex digests collide stay separate and resolve one at a time', () => {
  const old8 = (call) => createHash('sha256').update(`opencode\0${call}`).digest('hex').slice(0, 8);
  const seen = new Map();
  let pair;
  for (let i = 0; !pair; i++) {
    const call = `call_${i}`;
    const key = old8(call);
    if (seen.has(key)) pair = [seen.get(key), call];
    else seen.set(key, call);
  }
  const mk = (call) => entryFromOpenCode({ tool: 'question', status: 'completed', id: call, sessionID: 'ses_a', input: { questions: colourForm }, result: { metadata: { answers: [['Red']] } } }, NOW);
  const [a, b] = pair.map(mk);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  const sameCallOtherSession = entryFromOpenCode({ tool: 'question', status: 'completed', id: pair[0], sessionID: 'ses_b', input: { questions: colourForm }, result: { metadata: { answers: [['Red']] } } }, NOW);
  assert.notEqual(sameCallOtherSession.id, a.id, 'the same call id in another session is another entry');
  const p = project();
  try {
    for (const e of [a, b, sameCallOtherSession]) assert.equal(appendPendingAnswer(p.dir, e), true);
    assert.equal(readPendingAnswers(p.dir).length, 3);
    resolvePendingAnswers(p.dir, [a.id]);
    assert.deepEqual(readPendingAnswers(p.dir).map((e) => e.id).sort(), [b.id, sameCallOtherSession.id].sort());
  } finally {
    p.cleanup();
  }
});

test('Claude multi-select: split only when every part is an exact option label; a label containing ", " stays whole; the raw answer is kept', () => {
  const stdin = claudeFixture();
  const q = stdin.tool_response.questions[0];
  q.multiSelect = true;
  q.options = [{ label: 'Red, dark', description: '' }, { label: 'Green', description: '' }, { label: 'Blue', description: '' }];
  const picksOf = (answer) => {
    stdin.tool_response.answers = { 'Pick a colour': answer };
    const entry = entryFromClaude(stdin, NOW);
    assert.equal(entry.questions[0].raw_answer, answer, 'the raw answer is stored verbatim');
    return entry.questions[0].picks;
  };
  assert.deepEqual(picksOf('Red, dark'), [{ label: 'Red, dark', custom: false }]);
  assert.deepEqual(picksOf('Green, Blue'), [{ label: 'Green', custom: false }, { label: 'Blue', custom: false }]);
  assert.deepEqual(picksOf('Green, Red, dark'), [{ label: 'Green, Red, dark', custom: true }], 'a part that is no label keeps the raw value as one custom pick');
  assert.deepEqual(picksOf('Green, my own'), [{ label: 'Green, my own', custom: true }]);
});

test('an invalid pending file ([null]) is never read as zero and its bytes survive; H19 still delivers its other notices', () => {
  const p = project();
  try {
    const file = join(p.dir, PENDING_ANSWERS_REL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[null]');
    assert.throws(() => readPendingAnswers(p.dir), /valid pending answers/);
    assert.match(pendingAnswersNotice(p.dir), /^PENDING ANSWERS UNREADABLE/);
    const noticesDir = join(p.dir, '.sterling', 'transient', 'notices');
    mkdirSync(noticesDir, { recursive: true });
    writeFileSync(join(noticesDir, 'a-queued.json'), JSON.stringify({ text: 'QUEUED-UNRELATED-NOTICE' }));
    const run = (hook, input) => spawnSync('node', [join(repo, 'hooks', hook)], { input: JSON.stringify(input), encoding: 'utf8' });
    const drain = run('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: p.dir, prompt: 'hi' });
    const context = JSON.parse(drain.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /QUEUED-UNRELATED-NOTICE/);
    assert.match(context, /PENDING ANSWERS UNREADABLE/);
    const h32 = run('h32-pending-answers.mjs', { ...claudeFixture(), cwd: p.dir });
    assert.equal(h32.status, 1, 'H32 warns non-blocking (exit 1), never denies (exit 2)');
    assert.match(h32.stderr, /H32 pending answers failed: .*valid pending answers/);
    assert.equal(readFileSync(file, 'utf8'), '[null]', 'the invalid file is left byte for byte');
  } finally {
    p.cleanup();
  }
});

test('H32 leaves a directory that is not a Sterling project untouched, and writes a linked worktree into the worktree', () => {
  const bare = mkdtempSync(join(tmpdir(), 'sterling-pending-answers-bare-'));
  const p = project();
  const wt = `${p.dir}-wt`;
  try {
    const run = (cwd) => spawnSync('node', [join(repo, 'hooks', 'h32-pending-answers.mjs')], { input: JSON.stringify({ ...claudeFixture(), cwd }), encoding: 'utf8' });
    assert.equal(run(bare).status, 0);
    assert.equal(existsSync(join(bare, '.sterling')), false, 'no .sterling is created outside a Sterling project');
    const git = (...args) => spawnSync('git', args, { cwd: p.dir, encoding: 'utf8' });
    writeFileSync(join(p.dir, '.gitignore'), '.sterling/\n');
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@e.x', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    assert.equal(git('worktree', 'add', '-q', wt, '-b', 'wt-branch').status, 0);
    assert.equal(run(wt).status, 0);
    assert.equal(readPendingAnswers(wt).length, 1, "a linked worktree's answer lands in the worktree's own file");
    assert.equal(existsSync(join(p.dir, PENDING_ANSWERS_REL)), false, "the main checkout's file is not touched");
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
    p.cleanup();
  }
});

test('the pending file is written with mode 0600', () => {
  const p = project();
  try {
    appendPendingAnswer(p.dir, entryFromClaude(claudeFixture(), NOW));
    assert.equal(statSync(join(p.dir, PENDING_ANSWERS_REL)).mode & 0o777, 0o600);
    resolvePendingAnswers(p.dir, [readPendingAnswers(p.dir)[0].id]);
    assert.equal(statSync(join(p.dir, PENDING_ANSWERS_REL)).mode & 0o777, 0o600, 'a rewrite keeps it private');
  } finally {
    p.cleanup();
  }
});

test('the agy drain does not carry the pending-answers notice and still drains its own queue', () => {
  const p = project();
  try {
    appendPendingAnswer(p.dir, entryFromClaude(claudeFixture(), NOW));
    const noticesDir = join(p.dir, '.sterling', 'transient', 'notices');
    mkdirSync(noticesDir, { recursive: true });
    writeFileSync(join(noticesDir, 'agy-queued.json'), JSON.stringify({ text: 'AGY-QUEUED-NOTICE' }));
    const agy = spawnSync('node', [join(repo, 'hooks', 'h19-delivery-drain.mjs')], { input: JSON.stringify({ hookEventName: 'PreInvocation', conversationId: 'c1', cwd: p.dir, lastUserInput: 'hi', invocationNum: 0 }), encoding: 'utf8' });
    assert.doesNotMatch(agy.stdout, /PENDING ANSWERS/);
    assert.match(agy.stdout, /AGY-QUEUED-NOTICE/);
  } finally {
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

test('pendingAnswersBlock derives text and signature from one snapshot: a write landing mid-call cannot mark an old notice with the new set', () => {
  const p = project();
  try {
    const base = entryFromClaude(claudeFixture(), NOW);
    const entryN = (n) => ({ ...base, id: String(n).padStart(32, '0'), call_id: `c${n}` });
    for (let n = 1; n <= 3; n++) appendPendingAnswer(p.dir, entryN(n));
    let injected = false;
    // The seam stands in for the old second read: the append lands right after the snapshot is taken.
    const read = (root) => {
      const snapshot = readPendingAnswers(root);
      if (!injected) {
        injected = true;
        appendPendingAnswer(root, entryN(4));
      }
      return snapshot;
    };
    const during = pendingAnswersBlock(p.dir, { read });
    assert.match(during.text, /^PENDING ANSWERS: 3 answered question forms/);
    const after = pendingAnswersBlock(p.dir);
    assert.match(after.text, /^PENDING ANSWERS: 4 answered question forms/);
    assert.notEqual(during.sig, after.sig, 'the next prompt sees a different signature, so the 4-entry notice is delivered');
    const unreadable = pendingAnswersBlock(p.dir, { read: () => { throw new Error('bad second snapshot'); } });
    assert.match(unreadable.text, /^PENDING ANSWERS UNREADABLE \(bad second snapshot\)/);
    assert.equal(unreadable.sig, unreadable.text);
  } finally {
    p.cleanup();
  }
});
