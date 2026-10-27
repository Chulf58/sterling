// The one-way board-to-GitHub-issues mirror (scripts/sync-board-issues.mjs).
// The planner is pure, so most cases run it on hand-built snapshots and
// inventories; an in-memory model of GitHub applies each plan, which proves a
// second plan is empty. The end-to-end cases run the script against a temp
// Sterling store and a fake gh first on PATH (no network): a dry run that
// writes nothing, a real run, a second real run with zero writes, a close
// after a removal, the run lock, and the argument errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import {
  FOOTER_RE,
  ISSUE_CEILING,
  PlanError,
  objectiveLabel,
  bodyOf,
  closeCandidates,
  closeReceipt,
  keyMarker,
  lockPathFor,
  parseArgs,
  plan,
  projectIdentityOf,
  projectMarker,
  titleOf,
} from '../sync-board-issues.mjs';
import { withSessionEventsLock } from '../hooks/lib/session-events.mjs';

const SCRIPT = fileURLToPath(new URL('../sync-board-issues.mjs', import.meta.url));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const textOf = (n) => `Task ${n}\nmore detail`;

function item(n, record = {}, readiness = {}) {
  return { record: { id: uuid(n), type: 'todo', source: 'user', text: textOf(n), ...record }, readiness: { id: uuid(n), state: 'ready', ...readiness } };
}
const snap = ({ items = [], journal = [], unreadable = [] } = {}) => ({ schema_version: 2, items, unreadable, journal });
const jrow = (n, outcome, over = {}) => ({ seq: n, item_id: uuid(n), text: textOf(n), source: 'user', outcome, removed_at: '2026-10-27T12:00:00.000Z', ...over });
const P = projectIdentityOf(null, 'alpha');
const mirrored = (number, n, over = {}) => ({ number, state: 'open', title: `Task ${n}`, body: bodyOf(uuid(n), textOf(n), 'alpha'), labels: [], ...over });
const kinds = (actions) => actions.map((a) => a.kind);
const received = { role: 'received', transfer_id: randomUUID(), from_root: '/elsewhere/CH.Hub', from_name: 'CH.Hub', from_item_id: randomUUID() };
const sent = { role: 'sent', transfer_id: randomUUID(), to_root: '/elsewhere/Other', to_name: 'Other', to_item_id: null };

/** An in-memory GitHub that applies a plan's actions the way the executor would. */
function model(issues = [], labels = []) {
  const gh = { issues: issues.map((i) => ({ ...i, labels: [...(i.labels ?? [])] })), labels: [...labels], comments: new Map(), next: 1000 };
  const find = (n) => gh.issues.find((i) => i.number === n);
  gh.apply = (actions) => {
    for (const a of actions) {
      if (a.kind === 'ensure_label') gh.labels.push(a.name);
      else if (a.kind === 'comment') gh.comments.set(a.number, [...(gh.comments.get(a.number) ?? []), a.body]);
      else if (a.kind === 'remove_label') find(a.number).labels = find(a.number).labels.filter((l) => (l.name ?? l) !== a.label);
      else if (a.kind === 'add_labels') find(a.number).labels.push(...a.labels.map((name) => ({ name })));
      else if (a.kind === 'close') Object.assign(find(a.number), { state: 'closed', state_reason: a.state_reason });
      else if (a.kind === 'create') {
        const number = gh.next++;
        gh.issues.push({ number, state: 'open', title: a.title, body: a.body, labels: a.labels.map((name) => ({ name })) });
        if (a.then) {
          gh.comments.set(number, [a.then.comment]);
          Object.assign(find(number), { state: 'closed', state_reason: a.then.state_reason });
        }
      } else throw new Error(`unknown ${a.kind}`);
    }
  };
  gh.receipts = (snapshot) =>
    new Set(closeCandidates(snapshot, gh.issues, P).filter((n) => (gh.comments.get(n) ?? []).some((c) => c.includes('<!-- sterling-close: board:'))));
  gh.plan = (snapshot, opts = {}) => plan({ project: P, snapshot, issues: gh.issues, labels: gh.labels, receipts: gh.receipts(snapshot), ...opts });
  return gh;
}

// ---------- planner ----------

test('an open user task becomes one create with a title from its first line and a body carrying the key and text markers', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1)] }), issues: [] });
  assert.deepEqual(kinds(r.actions), ['create']);
  const c = r.actions[0];
  assert.equal(c.title, 'Task 1');
  assert.equal(c.key, uuid(1));
  assert.deepEqual(c.labels, []);
  assert.ok(c.body.startsWith('Task 1\nmore detail\n\n'));
  assert.ok(c.body.includes(keyMarker(uuid(1))));
  assert.match(c.body, /<!-- sterling-text: sha256:[0-9a-f]{16} -->/);
  assert.equal(c.then, undefined);
});

test('titles are trimmed and capped, and a blank text falls back to the item id', () => {
  assert.equal(titleOf('\n   Hello there  \nsecond', 'x'), 'Hello there');
  const long = titleOf('a'.repeat(300), 'x');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(titleOf('  \n ', uuid(7)), `Board task ${uuid(7).slice(0, 8)}`);
});

test('a hand-off tracker is never created, live or from the journal', () => {
  const r = plan({
    project: P,
    snapshot: snap({
      items: [item(1, { handoff: sent }, { state: 'delegated' }), item(2, {}, { state: 'delegated' })],
      journal: [jrow(3, 'done', { text: "Handed to project 'Other': do the thing" })],
    }),
    issues: [],
  });
  assert.deepEqual(r.actions, []);
});

test('a received task gets from:<sending project>, and the missing label is created first', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { handoff: received })] }), issues: [], labels: ['bug'] });
  assert.deepEqual(kinds(r.actions), ['ensure_label', 'create']);
  assert.equal(r.actions[0].name, 'from:CH.Hub');
  assert.deepEqual(r.actions[1].labels, ['from:CH.Hub']);
  const again = plan({ project: P, snapshot: snap({ items: [item(1, { handoff: received })] }), issues: [], labels: ['From:ch.hub'] });
  assert.deepEqual(kinds(again.actions), ['create'], 'label names compare case-insensitively, as GitHub does');
});

test('a from: label longer than GitHub allows refuses the plan', () => {
  assert.throws(() => plan({ project: P, snapshot: snap({ items: [item(1, { handoff: { ...received, from_name: 'x'.repeat(60) } })] }), issues: [] }), PlanError);
});

test('in-progress follows a held claim: added while held, removed when released or expired, untouched when unreadable', () => {
  const held = plan({ project: P, snapshot: snap({ items: [item(1, {}, { claim: { state: 'held' } })] }), issues: [mirrored(5, 1)], labels: ['in-progress'] });
  assert.deepEqual(held.actions, [{ kind: 'add_labels', number: 5, labels: ['in-progress'] }]);
  for (const claim of [undefined, { state: 'expired' }]) {
    const r = plan({ project: P, snapshot: snap({ items: [item(1, {}, claim ? { claim } : {})] }), issues: [mirrored(5, 1, { labels: [{ name: 'in-progress' }] })] });
    assert.deepEqual(r.actions, [{ kind: 'remove_label', number: 5, label: 'in-progress' }]);
  }
  const odd = plan({ project: P, snapshot: snap({ items: [item(1, {}, { claim: { state: 'unreadable' } })] }), issues: [mirrored(5, 1, { labels: [{ name: 'in-progress' }] })] });
  assert.deepEqual(odd.actions, []);
  assert.equal(odd.warnings.length, 1);
  const create = plan({ project: P, snapshot: snap({ items: [item(1, {}, { claim: { state: 'held' } })] }), issues: [], labels: ['in-progress'] });
  assert.deepEqual(create.actions[0].labels, ['in-progress']);
});

test('blocked follows the readiness state (blocked or waiting), never raw blocked_by', () => {
  for (const state of ['blocked', 'waiting']) {
    const r = plan({ project: P, snapshot: snap({ items: [item(1, {}, { state })] }), issues: [mirrored(5, 1)], labels: ['blocked'] });
    assert.deepEqual(r.actions, [{ kind: 'add_labels', number: 5, labels: ['blocked'] }], state);
  }
  const closedBlocker = plan({ project: P, snapshot: snap({ items: [item(1, { blocked_by: ['gone-slug'] }, { state: 'ready' })] }), issues: [mirrored(5, 1, { labels: [{ name: 'blocked' }] })] });
  assert.deepEqual(closedBlocker.actions, [{ kind: 'remove_label', number: 5, label: 'blocked' }]);
  const fresh = plan({ project: P, snapshot: snap({ items: [item(1, {}, { state: 'waiting' })] }), issues: [] });
  assert.deepEqual(kinds(fresh.actions), ['ensure_label', 'create']);
  assert.deepEqual(fresh.actions[1].labels, ['blocked']);
});

test('a task removed as done closes its issue completed after one evidence comment, removing in-progress and blocked and keeping from:', () => {
  const issue = mirrored(5, 1, { labels: [{ name: 'in-progress' }, { name: 'Blocked' }, { name: 'from:CH.Hub' }] });
  const r = plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done', { evidence: { commit: 'abc123', pr: 'https://x/pr/9' }, note: 'shipped' })] }), issues: [issue] });
  assert.deepEqual(kinds(r.actions), ['comment', 'remove_label', 'remove_label', 'close']);
  const [comment, rm1, rm2, close] = r.actions;
  assert.match(comment.body, /Done on the Sterling board\.\n\nEvidence:\n- commit: abc123\n- pr: https:\/\/x\/pr\/9\n\nNote: shipped\n\n/);
  assert.ok(comment.body.endsWith(closeReceipt(uuid(1))));
  assert.deepEqual([rm1.label, rm2.label], ['in-progress', 'Blocked']);
  assert.deepEqual(close, { kind: 'close', number: 5, key: uuid(1), state_reason: 'completed', outcome: 'done' });
});

test('done without evidence still closes completed and says no evidence was recorded', () => {
  const r = plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done')] }), issues: [mirrored(5, 1)] });
  assert.match(r.actions[0].body, /No evidence was recorded\./);
  assert.equal(r.actions[1].state_reason, 'completed');
});

test('dropped, superseded and duplicate close not_planned with a comment naming the outcome', () => {
  for (const outcome of ['dropped', 'superseded', 'duplicate']) {
    const r = plan({ project: P, snapshot: snap({ journal: [jrow(1, outcome, { note: 'why' })] }), issues: [mirrored(5, 1)] });
    assert.deepEqual(kinds(r.actions), ['comment', 'close'], outcome);
    assert.match(r.actions[0].body, new RegExp(`marked ${outcome} on the Sterling board\\.\\n\\nNote: why`));
    assert.equal(r.actions[1].state_reason, 'not_planned');
  }
});

test('a mirrored task gone from the board with no journal row closes not_planned', () => {
  const r = plan({ project: P, snapshot: snap(), issues: [mirrored(5, 1)] });
  assert.deepEqual(kinds(r.actions), ['comment', 'close']);
  assert.match(r.actions[0].body, /without a recorded outcome/);
  assert.deepEqual(r.actions[1], { kind: 'close', number: 5, key: uuid(1), state_reason: 'not_planned', outcome: 'vanished' });
});

test('an unreadable board item keeps its issue open, and an already closed issue is never touched or reopened', () => {
  const r = plan({ project: P, snapshot: snap({ unreadable: [{ id: uuid(1), reason: 'bad' }], items: [item(2)] }), issues: [mirrored(5, 1), mirrored(6, 2, { state: 'closed' }), mirrored(7, 3, { state: 'closed' })] });
  assert.deepEqual(r.actions, []);
  assert.equal(r.warnings.length, 2);
});

test('a task that opened and closed between runs is created and closed in the same plan, with its origin label from the hand-off line', () => {
  const text = "Do X\n\nHanded over from project 'CH.Hub' (/elsewhere/CH.Hub); its tracker there is abc.";
  const r = plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done', { text, evidence: { deploy: 'prod 1.2' } }), jrow(2, 'dropped')] }), issues: [], labels: ['from:CH.Hub'] });
  assert.deepEqual(kinds(r.actions), ['create', 'create']);
  assert.deepEqual(r.actions[0].labels, ['from:CH.Hub']);
  assert.equal(r.actions[0].title, 'Do X');
  assert.equal(r.actions[0].then.state_reason, 'completed');
  assert.match(r.actions[0].then.comment, /- deploy: prod 1\.2/);
  assert.ok(r.actions[0].then.comment.endsWith(closeReceipt(uuid(1))));
  assert.deepEqual(r.actions[1].labels, []);
  assert.equal(r.actions[1].then.state_reason, 'not_planned');
});

test('journal rows use their hand-off columns: a removed tracker is skipped, a removed received task gets its origin label; the text lines count only when the columns are absent', () => {
  const r = plan({
    project: P,
    snapshot: snap({
      journal: [
        jrow(1, 'done', { handoff_role: 'sent', text: 'A tracker whose text was edited' }),
        jrow(2, 'done', { handoff_role: 'received', handoff_from_name: 'CH.Hub', text: 'Received, no hand-off line' }),
        jrow(3, 'done', { text: "Old row\n\nHanded over from project 'Legacy' (/x); its tracker there is y." }),
      ],
    }),
    issues: [],
    labels: ['from:CH.Hub', 'from:Legacy'],
  });
  assert.deepEqual(r.actions.map((a) => [a.kind, a.key, a.labels]), [
    ['create', uuid(2), ['from:CH.Hub']],
    ['create', uuid(3), ['from:Legacy']],
  ]);
});

test('the issue body ends in the generated footer; issues of another project are never touched, and a key outside a footer is only warned about', () => {
  const create = plan({ project: P, snapshot: snap({ items: [item(1)] }), issues: [] });
  assert.ok(create.actions[0].body.endsWith(`${keyMarker(uuid(1))}\n${projectMarker('alpha')}\n<!-- sterling-text: sha256:${create.actions[0].body.match(/sha256:([0-9a-f]{16})/)[1]} -->\n`));
  const beta = (number, n, over = {}) => ({ number, state: 'open', body: bodyOf(uuid(n), textOf(n), 'beta'), labels: [{ name: 'in-progress' }], ...over });
  const bare = { number: 8, state: 'open', body: `${textOf(4)}\n\n${keyMarker(uuid(4))}\n${projectMarker('alpha')}`, labels: [] };
  const r = plan({ project: P, snapshot: snap({ items: [item(3)], journal: [jrow(4, 'done')] }), issues: [beta(6, 5), beta(7, 3), bare, beta(9, 9), mirrored(10, 3, { state: 'closed' })] });
  assert.deepEqual(r.actions.map((a) => [a.kind, a.key]), [['create', uuid(4)]], 'only the task whose key no footer carries gets an issue');
  assert.ok(r.warnings.some((w) => /3 issue\(s\) carry project marker 'beta', not this project's \('alpha'\): #6, #7, #9/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /1 issue\(s\) show a sterling-key marker outside a generated footer: #8/.test(w)));
  const held = plan({ project: P, snapshot: snap({ items: [item(5)] }), issues: [beta(6, 5)] });
  assert.deepEqual(held.actions, []);
  assert.ok(held.warnings.some((w) => w.startsWith(`board:${uuid(5)} gets no issue, because #6 already carries its key`)));
  const dupAcross = plan({ project: P, snapshot: snap({ items: [item(5)] }), issues: [beta(6, 5), mirrored(11, 5)] });
  assert.deepEqual(dupAcross.actions, [], 'one issue of ours plus one of beta for the same key is not a duplicate of ours');
});

test('the project identity is the project.json id when present, else the name, and only that one value is this project\'s', () => {
  const id = randomUUID();
  assert.deepEqual(projectIdentityOf({ project_id: id }, 'alpha'), { marker: id });
  assert.deepEqual(projectIdentityOf(null, 'alpha'), { marker: 'alpha' });
  const other = randomUUID();
  const theirs = { number: 5, state: 'open', body: bodyOf(uuid(1), textOf(1), other), labels: [] };
  const same = plan({ project: projectIdentityOf({ project_id: id }, 'alpha'), snapshot: snap({ items: [item(2)] }), issues: [theirs, mirrored(6, 3)] });
  assert.deepEqual(same.actions.map((a) => [a.kind, a.key]), [['create', uuid(2)]], 'a project with the same name but another id is foreign: nothing of it is closed');
  assert.ok(same.warnings.some((w) => w.includes(`project marker '${other}'`)) && same.warnings.some((w) => w.includes("project marker 'alpha'")), same.warnings.join('\n'));
  for (const bad of ['a --> b', 'a<b', ' padded', 'two\nlines', '']) assert.throws(() => projectIdentityOf(null, bad), PlanError, JSON.stringify(bad));
});

test('task text that quotes markers is escaped: the issue stays this project\'s, keyed once, and a second plan is empty', () => {
  const quoting = [
    `Quote ${keyMarker(uuid(2))} and ${projectMarker('beta')}`,
    `${keyMarker(uuid(3))}\n${projectMarker('beta')}\n<!-- sterling-text: sha256:0123456789abcdef -->`,
    `also <!--sterling-close: board:${uuid(4)} --> and <!-- Sterling-key: board:x -->`,
  ].join('\n');
  const snapshot = snap({ items: [item(1, { text: quoting }), item(2), item(3)] });
  const gh = model();
  const first = gh.plan(snapshot);
  assert.deepEqual(first.actions.map((a) => a.key).sort(), [uuid(1), uuid(2), uuid(3)]);
  const body = first.actions.find((a) => a.key === uuid(1)).body;
  assert.equal((body.match(/<!-- sterling-key: /g) ?? []).length, 1, 'only the footer carries a key marker');
  assert.equal((body.match(/<!-- sterling-project: /g) ?? []).length, 1);
  assert.ok(body.includes('<!-- sterling\u200B-key: board:'), 'the quoted marker is kept, broken by a zero-width space');
  gh.apply(first.actions);
  const second = gh.plan(snapshot);
  assert.deepEqual(second.actions, []);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(second.drift, []);
});

test('the ceiling stops creates at 200 genuine issues (pull requests excluded) while closes and labels still run', () => {
  assert.equal(ISSUE_CEILING, 200);
  const others = Array.from({ length: 197 }, (_, i) => ({ number: i + 1, state: i % 2 ? 'closed' : 'open', body: 'not ours', labels: [] }));
  const prs = Array.from({ length: 10 }, (_, i) => ({ number: 500 + i, state: 'open', body: keyMarker(uuid(900 + i)), pull_request: {}, labels: [] }));
  const issues = [...others, ...prs, mirrored(300, 1), mirrored(301, 2)];
  const r = plan({ project: P, snapshot: snap({ items: [item(2, {}, { state: 'blocked' }), item(3, { created_at: '2026-10-01T00:00:00.000Z' }), item(4, { created_at: '2026-10-02T00:00:00.000Z' })], journal: [jrow(1, 'done'), jrow(5, 'done')] }), issues, labels: ['blocked'] });
  assert.deepEqual(r.ceiling, { limit: 200, count: 199, skipped: 2, skipped_items: [{ key: uuid(4), title: 'Task 4' }, { key: uuid(5), title: 'Task 5' }] });
  assert.deepEqual(kinds(r.actions), ['comment', 'close', 'add_labels', 'create']);
  assert.equal(r.actions[3].key, uuid(3));
  const full = plan({ project: P, snapshot: snap({ items: [item(3)] }), issues: [...others, mirrored(300, 1), mirrored(301, 2), mirrored(302, 9)] });
  assert.deepEqual(full.ceiling, { limit: 200, count: 200, skipped: 1, skipped_items: [{ key: uuid(3), title: 'Task 3' }] });
  assert.deepEqual(kinds(full.actions), ['comment', 'close', 'comment', 'close', 'comment', 'close']);
});

test('an objective becomes the label objective:<objective>, created when missing, none without an objective', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { objective: 'Animation pass' }), item(2)] }), issues: [], labels: [] });
  assert.deepEqual(kinds(r.actions), ['ensure_label', 'create', 'create']);
  assert.equal(r.actions[0].name, 'objective:Animation pass');
  assert.deepEqual(r.actions[1].labels, ['objective:Animation pass']);
  assert.deepEqual(r.actions[2].labels, []);
  assert.equal(objectiveLabel(undefined), null);
  assert.equal(objectiveLabel('  '), null);
});

test('the objective label follows the board: added, changed (old one removed), cleared, and left alone when current', () => {
  const added = plan({ project: P, snapshot: snap({ items: [item(1, { objective: 'A' })] }), issues: [mirrored(5, 1)], labels: ['objective:A'] });
  assert.deepEqual(added.actions, [{ kind: 'add_labels', number: 5, labels: ['objective:A'] }]);
  const changed = plan({ project: P, snapshot: snap({ items: [item(1, { objective: 'B' })] }), issues: [mirrored(5, 1, { labels: [{ name: 'objective:A' }] })], labels: ['objective:A'] });
  assert.deepEqual(changed.actions, [
    { kind: 'ensure_label', name: 'objective:B', color: 'bfd4f2', description: 'Sterling board: the objective this task belongs to' },
    { kind: 'remove_label', number: 5, label: 'objective:A' },
    { kind: 'add_labels', number: 5, labels: ['objective:B'] },
  ]);
  const cleared = plan({ project: P, snapshot: snap({ items: [item(1)] }), issues: [mirrored(5, 1, { labels: [{ name: 'objective:A' }] })], labels: ['objective:A'] });
  assert.deepEqual(cleared.actions, [{ kind: 'remove_label', number: 5, label: 'objective:A' }]);
  const same = plan({ project: P, snapshot: snap({ items: [item(1, { objective: 'A' })] }), issues: [mirrored(5, 1, { labels: [{ name: 'Objective:a' }] })], labels: ['objective:A'] });
  assert.deepEqual(same.actions, []);
});

test('the objective label is kept when the task closes, and a journal-only task is created with its objective', () => {
  const closed = plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done')] }), issues: [mirrored(5, 1, { labels: [{ name: 'objective:A' }, { name: 'blocked' }] })] });
  assert.deepEqual(closed.actions.filter((a) => a.kind === 'remove_label').map((a) => a.label), ['blocked']);
  const short = plan({ project: P, snapshot: snap({ journal: [jrow(2, 'done', { objective: 'A' })] }), issues: [], labels: ['objective:A'] });
  assert.deepEqual(short.actions[0].labels, ['objective:A']);
});

test('an objective label over 50 characters is cut to 33 characters, ~ and 6 hex of the objective\'s SHA-256, and is stable', () => {
  const objective = 'Long objective name that goes well past what GitHub allows for a label';
  const name = objectiveLabel(objective);
  assert.equal(name.length, 50);
  assert.match(name, /^objective:Long objective name that goes wel~[0-9a-f]{6}$/);
  assert.equal(name, objectiveLabel(objective));
  assert.notEqual(name, objectiveLabel(`${objective}!`));
  assert.equal(objectiveLabel('x'.repeat(40)), `objective:${'x'.repeat(40)}`, 'exactly 50 characters is kept whole');
  assert.equal(objectiveLabel('x'.repeat(41)).length, 50);
});

test('at the ceiling, new issues go by priority (high, normal, low) then oldest first; the left-out tasks are listed in that order', () => {
  const others = Array.from({ length: 196 }, (_, i) => ({ number: i + 1, state: 'closed', body: 'not ours', labels: [] }));
  const at = (d) => `2026-10-${String(d).padStart(2, '0')}T08:00:00.000Z`;
  const items = [
    item(1, { priority: 'low', created_at: at(1) }),
    item(2, { created_at: at(5) }),
    item(3, { priority: 'high', created_at: at(9) }),
    item(4, { priority: 'normal', created_at: at(2) }),
    item(5, { priority: 'high', created_at: at(3) }),
  ];
  const r = plan({ project: P, snapshot: snap({ items }), issues: others });
  assert.deepEqual(r.actions.map((a) => a.key), [uuid(5), uuid(3), uuid(4), uuid(2)].slice(0, 4));
  assert.deepEqual(r.ceiling.skipped_items.map((s) => s.key), [uuid(1)]);
  const tight = plan({ project: P, snapshot: snap({ items }), issues: [...others, mirrored(300, 90), mirrored(301, 91)] });
  assert.deepEqual(tight.actions.filter((a) => a.kind === 'create').map((a) => a.key), [uuid(5), uuid(3)]);
  assert.deepEqual(tight.ceiling.skipped_items.map((s) => s.key), [uuid(4), uuid(2), uuid(1)]);
});

test('a journal-only task ranks by its row\'s priority and removed_at, like a live task by priority and created_at', () => {
  const others = Array.from({ length: 197 }, (_, i) => ({ number: i + 1, state: 'closed', body: 'not ours', labels: [] }));
  const r = plan({
    project: P,
    snapshot: snap({
      items: [item(1, { created_at: '2026-10-20T00:00:00.000Z' })],
      journal: [jrow(2, 'done', { priority: 'high', removed_at: '2026-10-26T00:00:00.000Z' }), jrow(3, 'done', { removed_at: '2026-10-10T00:00:00.000Z' })],
    }),
    issues: others,
  });
  assert.deepEqual(r.actions.map((a) => a.key), [uuid(2), uuid(3), uuid(1)].slice(0, 3));
  assert.equal(r.ceiling.skipped, 0);
  const tight = plan({ project: P, snapshot: snap({ items: [item(1, { created_at: '2026-10-20T00:00:00.000Z' })], journal: [jrow(2, 'done', { priority: 'high' }), jrow(3, 'done', { removed_at: '2026-10-10T00:00:00.000Z' })] }), issues: [...others, mirrored(300, 90)] });
  assert.deepEqual(tight.actions.filter((a) => a.kind === 'create').map((a) => a.key), [uuid(2), uuid(3)]);
  assert.deepEqual(tight.ceiling.skipped_items.map((s) => s.key), [uuid(1)]);
});

test('the documented footer regex gets the board uuid and project back from a generated body, and ignores a quoted marker', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../skills/sync-board-issues/SKILL.md', import.meta.url)), 'utf8');
  assert.ok(doc.includes(FOOTER_RE.source), 'the skill documents the exact regex the script uses');
  const text = `Quote: <!-- sterling-key: board:${uuid(99)} -->\n<!-- sterling-project: evil -->`;
  const body = bodyOf(uuid(7), text, 'My Project');
  const found = [...body.matchAll(new RegExp(FOOTER_RE.source, 'g'))].pop();
  assert.equal(found[1], uuid(7));
  assert.equal(found[2], 'My Project');
  assert.match(found[3], /^[0-9a-f]{16}$/);
  assert.equal([...body.matchAll(new RegExp(FOOTER_RE.source, 'g'))].length, 1);
});

test('two of this project\'s issues with one key refuse the plan and name the issues; a pull request never counts', () => {
  assert.throws(() => plan({ project: P, snapshot: snap({ items: [item(1)] }), issues: [mirrored(5, 1), mirrored(9, 1, { state: 'closed' })] }), /board:00000000-0000-4000-8000-000000000001 on issues #5 \(open\), #9 \(closed\)/);
  const pr = plan({ project: P, snapshot: snap({ items: [item(1)] }), issues: [mirrored(5, 1), { ...mirrored(9, 1), pull_request: {} }] });
  assert.deepEqual(pr.actions, [], 'a pull request with the same marker is not an issue');
});

test('a journal row with handoff_role none is a plain task even when its text starts like a tracker; only a row with no role falls back to the text', () => {
  const text = "Handed to project 'Other': this is my own wording";
  const r = plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done', { handoff_role: 'none', text }), jrow(2, 'done', { text })] }), issues: [] });
  assert.deepEqual(r.actions.map((a) => [a.kind, a.key]), [['create', uuid(1)]]);
});

test('an empty board with no journal plans nothing; journal-backed closures still run on an empty board', () => {
  assert.deepEqual(plan({ project: P, snapshot: snap(), issues: [] }).actions, []);
  assert.deepEqual(kinds(plan({ project: P, snapshot: snap({ journal: [jrow(1, 'done')] }), issues: [mirrored(5, 1)] }).actions), ['comment', 'close']);
});

test('text drift is reported and never becomes an edit', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { text: 'Task 1, reworded' })] }), issues: [mirrored(5, 1)] });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.drift, [{ number: 5, key: uuid(1), title: 'Task 1, reworded' }]);
});

test('applying a plan and planning again yields no actions', () => {
  const snapshot = snap({
    items: [item(1, { handoff: received }, { claim: { state: 'held' } }), item(2, {}, { state: 'blocked' }), item(3, { handoff: sent }, { state: 'delegated' })],
    journal: [jrow(4, 'done', { evidence: { commit: 'f00' } }), jrow(6, 'superseded')],
  });
  const gh = model([mirrored(10, 6, { labels: [{ name: 'in-progress' }] }), mirrored(11, 7), { number: 12, state: 'open', body: 'unrelated', labels: [] }]);
  const first = gh.plan(snapshot);
  assert.ok(first.actions.length > 0);
  gh.apply(first.actions);
  assert.deepEqual(gh.plan(snapshot).actions, []);
  assert.equal(gh.issues.find((i) => i.number === 10).state_reason, 'not_planned');
  assert.equal(gh.issues.find((i) => i.number === 11).state_reason, 'not_planned');
  assert.equal(gh.issues.find((i) => i.number === 12).state, 'open', 'an issue without a key is never touched');
  assert.equal(gh.issues.filter((i) => i.body.includes(keyMarker(uuid(3)))).length, 0, 'no tracker issue');
});

test('an interrupted close (receipt comment posted, issue still open) closes without a second comment', () => {
  const snapshot = snap({ journal: [jrow(1, 'done', { evidence: { url: 'https://x' } })] });
  const gh = model([mirrored(5, 1)]);
  const first = gh.plan(snapshot);
  gh.apply(first.actions.filter((a) => a.kind === 'comment'));
  const second = gh.plan(snapshot);
  assert.deepEqual(kinds(second.actions), ['close']);
  gh.apply(second.actions);
  assert.equal(gh.comments.get(5).length, 1);
  assert.deepEqual(gh.plan(snapshot).actions, []);
});

test('parseArgs takes --dry-run, --project and --help and refuses anything else', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--project', '/p']), { dryRun: true, project: '/p', help: false });
  assert.deepEqual(parseArgs(['--project=/q']), { dryRun: false, project: '/q', help: false });
  assert.match(parseArgs(['--project']).error, /--project needs a directory/);
  assert.match(parseArgs(['--yes']).error, /unknown argument '--yes'/);
});

// ---------- end to end, fake gh ----------

const FAKE_GH = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_GH_STATE;
const file = join(dir, 'state.json');
const s = JSON.parse(readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(argv) + '\\n');
const save = () => writeFileSync(file, JSON.stringify(s));
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (argv[0] === '--version') { console.log('gh version 9.9.9 (fake)'); process.exit(0); }
if (argv[0] === 'auth') process.exit(s.auth_fail ? 1 : 0);
if (argv[0] !== 'api') { console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3); }
const flag = (f) => argv[argv.indexOf(f) + 1];
const method = flag('--method');
const path = argv[5];
const body = argv.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
const [route, query = ''] = path.split('?');
const q = Object.fromEntries(query.split('&').filter(Boolean).map((kv) => kv.split('=')));
const page = (rows) => out(rows.slice((Number(q.page) - 1) * Number(q.per_page), Number(q.page) * Number(q.per_page)));
const base = 'repos/' + s.repo;
const issue = (n) => s.issues.find((i) => i.number === Number(n));
let m;
if (method === 'GET' && route === base + '/issues') page(s.issues);
if (method === 'GET' && route === base + '/labels') page(s.labels.map((name) => ({ name })));
if (method === 'GET' && (m = route.match(/\\/issues\\/(\\d+)\\/comments$/))) page(s.comments[m[1]] ?? []);
if (method === 'POST' && route === base + '/labels') { if (s.label_create_fail) { console.error('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1); } s.labels.push(body.name); save(); out({ name: body.name }); }
if (method === 'POST' && route === base + '/issues' && s.slow_create_ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.slow_create_ms);
if (method === 'POST' && route === base + '/issues') { const n = s.issues.length + 1; s.issues.push({ number: n, state: 'open', title: body.title, body: body.body, labels: (body.labels ?? []).map((name) => ({ name })) }); save(); out({ number: n }); }
if (method === 'POST' && (m = route.match(/\\/issues\\/(\\d+)\\/comments$/))) { (s.comments[m[1]] ??= []).push({ body: body.body }); save(); out({ id: 1 }); }
if (method === 'POST' && (m = route.match(/\\/issues\\/(\\d+)\\/labels$/))) { issue(m[1]).labels.push(...body.labels.map((name) => ({ name }))); save(); out(issue(m[1]).labels); }
if (method === 'DELETE' && (m = route.match(/\\/issues\\/(\\d+)\\/labels\\/(.+)$/))) { const name = decodeURIComponent(m[2]); issue(m[1]).labels = issue(m[1]).labels.filter((l) => l.name !== name); save(); out(issue(m[1]).labels); }
if (method === 'PATCH' && (m = route.match(/\\/issues\\/(\\d+)$/))) { Object.assign(issue(m[1]), body); save(); out(issue(m[1])); }
console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3);
`;

const NOW = '2026-10-27T12:00:00.000Z';
function envelope() {
  return { id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

/** A Sterling project at base/<name> whose origin is acme/widgets; `config` and `identity` become its config.json and project.json. */
function makeProject(base, name, { config, identity } = {}) {
  const root = join(base, name);
  mkdirSync(join(root, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  if (identity) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify(identity));
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: root, encoding: 'utf8' }).status, 0, `git ${a.join(' ')}`);
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  return { root, store, mk: (over) => store.create({ ...envelope(), source: 'user', ...over }) };
}

function harness({ preexisting = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-sync-issues-'));
  const { root, store, mk } = makeProject(base, 'project', { config: { project_name: 'alpha' } });
  const state = join(base, 'ghstate');
  mkdirSync(state);
  const issues = Array.from({ length: preexisting }, (_, i) => ({ number: i + 1, state: 'closed', title: `old ${i}`, body: 'not ours', labels: [] }));
  issues.push({ number: issues.length + 1, state: 'open', title: 'a PR', body: 'pr', labels: [], pull_request: {} });
  writeFileSync(join(state, 'state.json'), JSON.stringify({ repo: 'acme/widgets', issues, labels: ['bug'], comments: {} }));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(base, 'fake-gh.mjs'), FAKE_GH);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(base, 'fake-gh.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const tmp = join(base, 'tmp');
  mkdirSync(tmp);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, TMPDIR: tmp };
  const extra = [];
  const h = {
    base,
    root,
    store,
    mk,
    env,
    run: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: 'utf8' }),
    gh: () => JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')),
    setGh: (patch) => writeFileSync(join(state, 'state.json'), JSON.stringify({ ...h.gh(), ...patch })),
    writes: () =>
      readFileSync(join(state, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((a) => a[0] === 'api' && a[a.indexOf('--method') + 1] !== 'GET'),
    resetCalls: () => writeFileSync(join(state, 'calls.jsonl'), ''),
    callsText: () => (existsSync(join(state, 'calls.jsonl')) ? readFileSync(join(state, 'calls.jsonl'), 'utf8') : ''),
    /** Another project in the same repo, run with the same fake gh. */
    another: (name, opts) => {
      const p = makeProject(base, name, opts);
      extra.push(p);
      return { ...p, run: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: p.root, env, encoding: 'utf8' }) };
    },
    cleanup: () => {
      for (const p of extra) p.store.close();
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
  return h;
}

function seedBoard(h) {
  const open = h.mk({ text: 'Ship export\nwith CSV' });
  const recv = h.mk({ text: 'From CH.Hub: add a field', handoff: received });
  h.mk({ text: "Handed to project 'Other': do X", handoff: sent });
  h.mk({ source: 'system', system_reason: 'capture_owed', text: 'capture owed', file_keys: ['src/a.ts'] });
  const short = h.mk({ text: 'Quick fix' });
  h.store.remove(short.id, NOW, { outcome: 'done', evidence: { commit: 'abc123' } });
  const tracker = h.mk({ text: 'A tracker whose text no longer starts with the hand-off line', handoff: sent });
  h.store.remove(tracker.id, NOW, { outcome: 'done' });
  const recvShort = h.mk({ text: 'Received and done quickly', handoff: received });
  h.store.remove(recvShort.id, NOW, { outcome: 'done' });
  const lookalike = h.mk({ text: "Handed to project 'Other': my own wording, no hand-off" });
  h.store.remove(lookalike.id, NOW, { outcome: 'dropped' });
  return { open, recv, short, recvShort, lookalike };
}

test('end to end: a dry run lists the plan and writes nothing; a real run mirrors; a second run writes nothing; a removal closes', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness({ preexisting: 120 });
  try {
    const ids = seedBoard(h);
    const dry = h.run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would create label 'from:CH\.Hub'/);
    assert.match(dry.stdout, /would create issue "Ship export" for board:/);
    assert.match(dry.stdout, /would create issue "From CH\.Hub: add a field" with 'from:CH\.Hub'/);
    assert.match(dry.stdout, /would create issue "Quick fix" for board:\S+, then comment and close it as completed \(done\)/);
    assert.match(dry.stdout, /would create issue "Received and done quickly" with 'from:CH\.Hub' for board:\S+, then comment and close it as completed \(done\)/);
    assert.doesNotMatch(dry.stdout, /Handed to project 'Other': do X|capture owed|A tracker whose text/);
    assert.match(dry.stdout, /would create issue "Handed to project 'Other': my own wording, no hand-off" for board:\S+, then comment and close it as not_planned \(dropped\)/);
    assert.match(dry.stdout, /github\.com\/acme\/widgets: 1 ensure_label, 5 create \(dry run: nothing was written\); 120 issue\(s\) in the repo before this run/);
    assert.deepEqual(h.writes(), [], 'a dry run makes no write call');

    const real = h.run();
    assert.equal(real.status, 0, real.stderr);
    const gh = h.gh();
    const ours = gh.issues.filter((i) => i.body?.includes('<!-- sterling-key: board:'));
    assert.equal(ours.length, 5);
    assert.ok(ours.every((i) => i.body.includes(projectMarker('alpha'))));
    assert.deepEqual(ours.find((i) => i.body.includes(keyMarker(ids.recvShort.id))).labels, [{ name: 'from:CH.Hub' }]);
    const byKey = (id) => ours.find((i) => i.body.includes(keyMarker(id)));
    assert.equal(byKey(ids.open.id).state, 'open');
    assert.deepEqual(byKey(ids.recv.id).labels, [{ name: 'from:CH.Hub' }]);
    const short = byKey(ids.short.id);
    assert.equal(short.state, 'closed');
    assert.equal(short.state_reason, 'completed');
    assert.equal(gh.comments[short.number].length, 1);
    assert.match(gh.comments[short.number][0].body, /- commit: abc123/);
    assert.ok(gh.labels.includes('from:CH.Hub'));

    h.resetCalls();
    const again = h.run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to do/);
    assert.deepEqual(h.writes(), [], 'the second run makes no write call');

    h.store.remove(ids.open.id, NOW, { outcome: 'dropped', note: 'not needed' });
    const close = h.run();
    assert.equal(close.status, 0, close.stderr);
    const closed = h.gh().issues.find((i) => i.number === byKey(ids.open.id).number);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.state_reason, 'not_planned');
    assert.match(h.gh().comments[closed.number][0].body, /marked dropped[\s\S]*Note: not needed[\s\S]*<!-- sterling-close: board:/);
    h.resetCalls();
    assert.equal(h.run().status, 0);
    assert.deepEqual(h.writes(), []);
  } finally {
    h.cleanup();
  }
});

test('end to end: two projects mirroring into one repo never touch each other\'s issues', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    const betaId = randomUUID();
    const beta = h.another('beta', { config: { project_name: 'beta' }, identity: { project_id: betaId } });
    const a = h.mk({ text: 'Alpha task' });
    const b = beta.mk({ text: 'Beta task' });
    assert.equal(h.run().status, 0);
    const second = beta.run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /1 issue\(s\) carry project marker 'alpha', not this project's \('[0-9a-f-]{36}'\): #2/);
    const issueOf = (id) => h.gh().issues.find((i) => i.body?.includes(keyMarker(id)));
    assert.ok(issueOf(a.id).body.includes(projectMarker('alpha')));
    assert.ok(issueOf(b.id).body.includes(projectMarker(betaId)), 'a project with project.json writes its project_id');

    h.store.remove(a.id, NOW, { outcome: 'done' });
    h.resetCalls();
    assert.equal(beta.run().status, 0);
    assert.deepEqual(h.writes(), [], 'beta neither closes alpha\'s finished task nor creates one for it');
    assert.equal(issueOf(a.id).state, 'open');
    assert.equal(h.run().status, 0);
    assert.equal(issueOf(a.id).state, 'closed');
    assert.equal(issueOf(b.id).state, 'open', 'alpha never closes beta\'s task, which is not on alpha\'s board');
  } finally {
    h.cleanup();
  }
});

test('end to end: two projects on one repo take turns: a concurrent run is refused, and at 199 issues only one create happens', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, async () => {
  const h = harness({ preexisting: 199 });
  try {
    const beta = h.another('beta', { config: { project_name: 'beta' } });
    h.mk({ text: 'Alpha task' });
    beta.mk({ text: 'Beta task' });
    h.setGh({ slow_create_ms: 3000 });
    const alpha = spawn(process.execPath, [SCRIPT], { cwd: h.root, env: h.env });
    let alphaErr = '';
    alpha.stderr.on('data', (d) => (alphaErr += d));
    const alphaExit = new Promise((done) => alpha.on('exit', (code) => done(code)));
    const deadline = Date.now() + 15_000;
    // alpha takes the lock before its first inventory read (a GET), and its create then sleeps in the fake gh
    while (!h.callsText().includes('"--method","GET"')) {
      assert.ok(Date.now() < deadline, 'alpha never started reading the inventory');
      await new Promise((r) => setTimeout(r, 20));
    }
    const during = beta.run();
    assert.equal(during.status, 1, during.stderr);
    assert.match(during.stderr, /another sync-board-issues run holds the lock for github\.com\/acme\/widgets/);
    assert.equal(await alphaExit, 0, alphaErr);
    const after = beta.run();
    assert.equal(after.status, 3, after.stderr);
    assert.match(after.stderr, /CEILING github\.com\/acme\/widgets holds 200 issues/);
    const genuine = h.gh().issues.filter((i) => !i.pull_request);
    assert.equal(genuine.length, 200, 'only one create happened across both projects');
    assert.ok(genuine.some((i) => i.title === 'Alpha task'));
  } finally {
    h.cleanup();
  }
});

test('end to end: a label the account cannot create fails loudly and names gh', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    h.mk({ text: 'From CH.Hub: a task', handoff: received });
    h.setGh({ label_create_fail: true });
    const r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gh at \S+\/bin\/gh: POST repos\/acme\/widgets\/labels failed \(gh: Resource not accessible by integration \(HTTP 403\)\)\. The label 'from:CH\.Hub' is missing and could not be created/);
    assert.equal(h.gh().issues.filter((i) => !i.pull_request).length, 0, 'nothing was created after the failure');
  } finally {
    h.cleanup();
  }
});

test('end to end: a run while the repo lock is held (any spelling of the repo) exits 1 and writes nothing', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    h.mk({ text: 'A task' });
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = h.env.TMPDIR;
    let lockPath;
    try {
      lockPath = lockPathFor('GitHub.com/Acme/Widgets');
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }
    const r = withSessionEventsLock(lockPath, () => h.run(), { timeoutMs: 0 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /another sync-board-issues run holds the lock for github\.com\/acme\/widgets/);
    assert.deepEqual(h.writes(), []);
    const after = h.run();
    assert.equal(after.status, 0, after.stderr);
    assert.equal(h.gh().issues.filter((i) => !i.pull_request).length, 1);
  } finally {
    h.cleanup();
  }
});

test('end to end: at the ceiling a run creates nothing, says so loudly and exits 3', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness({ preexisting: 200 });
  try {
    h.mk({ text: 'One too many' });
    const r = h.run();
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /skipped \(ceiling\): "One too many" for board:/);
    assert.match(r.stderr, /CEILING github\.com\/acme\/widgets holds 200 issues \(pull requests excluded\) and the limit is 200 \(Clear View's cap\): 1 board task\(s\) got NO issue\. Closing and labelling still ran\./);
    assert.deepEqual(h.writes(), []);
  } finally {
    h.cleanup();
  }
});

test('end to end: no origin remote and an unreadable store refuse with exit 1', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    spawnSync('git', ['remote', 'remove', 'origin'], { cwd: h.root });
    const noOrigin = h.run('--dry-run');
    assert.equal(noOrigin.status, 1);
    assert.match(noOrigin.stderr, /has no 'origin' remote/);
    const other = mkdtempSync(join(tmpdir(), 'sterling-sync-issues-empty-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: other });
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: other });
      const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--project', other], { env: h.env, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /board snapshot: .*no database at/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

test('--help exits 0 with the usage; an unknown flag exits 2', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: sync-board-issues \[--dry-run\] \[--project <dir>\]/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--force'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument '--force'/);
});
