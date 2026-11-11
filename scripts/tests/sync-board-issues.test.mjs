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
  CeilingSettingError,
  ceilingOf,
  excludedComment,
  excludePrefixesOf,
  mirrorSettingsOf,
  PlanError,
  objectiveLabel,
  bodyOf,
  closeCandidates,
  closeComment,
  closeReceipt,
  describe,
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
  gh.receipts = (snapshot, prefixes = []) =>
    new Set(closeCandidates(snapshot, gh.issues, P, prefixes).filter((n) => (gh.comments.get(n) ?? []).some((c) => c.includes('<!-- sterling-close: board:'))));
  gh.plan = (snapshot, opts = {}) => plan({ project: P, snapshot, issues: gh.issues, labels: gh.labels, receipts: gh.receipts(snapshot, opts.excludePrefixes), ...opts });
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

test('objectives that differ only in case share one label: one ensure_label, both issues labelled with its first spelling', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { objective: 'API' }), item(2, { objective: 'api' })] }), issues: [], labels: [] });
  assert.deepEqual(r.actions.filter((a) => a.kind === 'ensure_label').map((a) => a.name), ['objective:API']);
  assert.deepEqual(r.actions.filter((a) => a.kind === 'create').map((a) => a.labels), [['objective:API'], ['objective:API']]);
  const open = plan({ project: P, snapshot: snap({ items: [item(3, { objective: 'API' }), item(4, { objective: 'api' })] }), issues: [mirrored(5, 3), mirrored(6, 4)], labels: [] });
  assert.deepEqual(open.actions.filter((a) => a.kind === 'ensure_label').map((a) => a.name), ['objective:API']);
});

test('the 50-character label limit counts code points: 49, 50 and 51 non-BMP characters in the objective', () => {
  const emoji = (n) => '😀'.repeat(n);
  assert.equal(objectiveLabel(emoji(40)), `objective:${emoji(40)}`, 'objective: plus 40 code points is exactly 50');
  assert.equal(objectiveLabel(emoji(39)), `objective:${emoji(39)}`);
  const cut = objectiveLabel(emoji(41));
  assert.match(cut, new RegExp(`^objective:(😀){33}~[0-9a-f]{6}$`, 'u'));
  assert.equal(Array.from(cut).length, 50);
});

test('a label that cannot exist on a task the ceiling leaves out does not block the plan; the pending close still runs', () => {
  const others = Array.from({ length: 198 }, (_, i) => ({ number: i + 1, state: 'closed', body: 'not ours', labels: [] }));
  const r = plan({
    project: P,
    snapshot: snap({ items: [item(2, { handoff: { ...received, from_name: 'x'.repeat(60) } })] }),
    issues: [...others, mirrored(300, 1), mirrored(301, 3)],
  });
  assert.ok(kinds(r.actions).includes('close'), 'the close of the task that left the board is planned');
  assert.deepEqual(r.ceiling.skipped_items.map((s) => s.key), [uuid(2)]);
  assert.throws(() => plan({ project: P, snapshot: snap({ items: [item(2, { handoff: { ...received, from_name: 'x'.repeat(60) } })] }), issues: [] }), PlanError);
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
if (method === 'POST' && route === base + '/labels') { if (s.label_create_raw) { if (s.label_create_raw.stdout) process.stdout.write(s.label_create_raw.stdout); if (s.label_create_raw.stderr) process.stderr.write(s.label_create_raw.stderr); process.exit(1); } if (s.label_create_fail) { console.error('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1); } s.labels.push(body.name); save(); out({ name: body.name }); }
if (method === 'POST' && route === base + '/issues' && s.slow_create_ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.slow_create_ms);
if (method === 'POST' && route === base + '/issues') { const n = s.issues.length + 1; s.issues.push({ number: n, state: 'open', title: body.title, body: body.body, labels: (body.labels ?? []).map((name) => ({ name })) }); save(); out({ number: n }); }
if (method === 'POST' && (m = route.match(/\\/issues\\/(\\d+)\\/comments$/))) { (s.comments[m[1]] ??= []).push({ body: body.body }); save(); out({ id: 1 }); }
if (method === 'POST' && (m = route.match(/\\/issues\\/(\\d+)\\/labels$/))) { issue(m[1]).labels.push(...body.labels.map((name) => ({ name }))); save(); out(issue(m[1]).labels); }
if (method === 'DELETE' && (m = route.match(/\\/issues\\/(\\d+)\\/labels\\/(.+)$/))) { const name = decodeURIComponent(m[2]); issue(m[1]).labels = issue(m[1]).labels.filter((l) => l.name !== name); save(); out(issue(m[1]).labels); }
if (method === 'PATCH' && s.patch_fail) { console.error('gh: Server Error (HTTP 500)'); process.exit(1); }
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

const LABEL_ADVICE = /needs triage or write access/;
/** The script's own 422 sentence: it names the status and draws no conclusion about the cause. */
const NEUTRAL_422 = /The label 'from:CH\.Hub' could not be created: GitHub refused the request with HTTP 422, which is not an access refusal; the reason is only what GitHub said above\./;
/** A 422 can mean a validation failure or a spam block, so the script's own words never call the label invalid. */
const OWN_INVALID_CLAIM = /rejected it as invalid|label is invalid/i;

/** What gh said, as the label-create failure quotes it: the text between "failed (" and "). The label". */
function saidOf(r) {
  const start = r.stderr.indexOf('labels failed (');
  const end = r.stderr.lastIndexOf('). The label');
  assert.ok(start >= 0 && end > start, `not a quoted label-create failure: ${r.stderr}`);
  return r.stderr.slice(start + 'labels failed ('.length, end);
}

/** Run a label create that the fake gh fails with the given raw streams; returns the script's result. */
function labelFailure(raw) {
  const h = harness();
  try {
    h.mk({ text: 'From CH.Hub: a task', handoff: received });
    h.setGh({ label_create_raw: raw });
    return h.run();
  } finally {
    h.cleanup();
  }
}

const GH_SKIP = { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' };

test('end to end: a 422 keeps GitHub\'s validation code, field and message from stdout beside the stderr line, and never blames access', GH_SKIP, () => {
  const body = { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'name', message: 'name is too long' }], documentation_url: 'https://docs.github.com/rest/issues/labels#create-a-label' };
  const r = labelFailure({ stdout: JSON.stringify(body), stderr: 'gh: Validation Failed (HTTP 422)\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed \(gh: Validation Failed \(HTTP 422\)/);
  assert.match(r.stderr, /Validation Failed: Label name invalid \(name is too long\)/);
  assert.match(r.stderr, NEUTRAL_422);
  assert.doesNotMatch(r.stderr, OWN_INVALID_CLAIM);
  assert.doesNotMatch(r.stderr, LABEL_ADVICE);
});

test('end to end: a 422 that only says "Validation Failed, or the endpoint has been spammed" keeps that sentence and is not called an invalid label', GH_SKIP, () => {
  const body = { message: 'Validation Failed, or the endpoint has been spammed.', documentation_url: 'https://docs.github.com/rest/issues/labels#create-a-label' };
  const r = labelFailure({ stdout: JSON.stringify(body), stderr: 'gh: Validation Failed (HTTP 422)\n' });
  assert.equal(r.status, 1);
  assert.match(saidOf(r), /^gh: Validation Failed \(HTTP 422\) \| Validation Failed, or the endpoint has been spammed\.$/);
  assert.match(r.stderr, NEUTRAL_422);
  assert.doesNotMatch(r.stderr, OWN_INVALID_CLAIM);
  assert.doesNotMatch(r.stderr, LABEL_ADVICE);
});

test('end to end: a 422 already_exists keeps GitHub\'s code beside stderr and is not called an invalid label', GH_SKIP, () => {
  const body = { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] };
  const r = labelFailure({ stdout: JSON.stringify(body), stderr: 'gh: Validation Failed (HTTP 422)\n' });
  assert.equal(r.status, 1);
  assert.equal(saidOf(r), 'gh: Validation Failed (HTTP 422) | Validation Failed: Label name already_exists');
  assert.match(r.stderr, NEUTRAL_422);
  assert.doesNotMatch(r.stderr, OWN_INVALID_CLAIM);
});

test('end to end: a non-JSON stdout (a proxy page) is kept beside a non-empty stderr', GH_SKIP, () => {
  const r = labelFailure({ stdout: 'upstream connect error or disconnect/reset before headers. reset reason: overflow\n', stderr: 'gh: HTTP 502 (HTTP 502)\n' });
  assert.equal(r.status, 1);
  assert.equal(saidOf(r), 'gh: HTTP 502 (HTTP 502) | upstream connect error or disconnect/reset before headers. reset reason: overflow');
  assert.doesNotMatch(r.stderr, LABEL_ADVICE);
});

test('end to end: a long stderr warning cannot crowd out GitHub\'s validation detail or the gh status line, and the cut is marked', GH_SKIP, () => {
  const warning = `warning: ${'w'.repeat(700)}`;
  const body = { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'name', message: 'name is too long' }] };
  const r = labelFailure({ stdout: JSON.stringify(body), stderr: `${warning}\ngh: Validation Failed (HTTP 422)\n` });
  assert.equal(r.status, 1);
  const said = saidOf(r);
  assert.ok(said.length <= 600, `the detail is bounded to 600 characters, got ${said.length}`);
  assert.match(said, /^warning: w+/);
  assert.match(said, /cut from \d+ chars/);
  assert.match(said, /gh: Validation Failed \(HTTP 422\) \| Validation Failed: Label name invalid \(name is too long\)$/);
  assert.match(r.stderr, NEUTRAL_422);
});

test('end to end: one very long validation message is cut on its own, and the other errors and the 5-error cap stay visible', GH_SKIP, () => {
  const errors = [
    { resource: 'Label', code: 'invalid', field: 'name', message: 'm'.repeat(3000) },
    { resource: 'Label', code: 'custom', field: 'color', message: 'color is bad' },
    ...Array.from({ length: 5 }, (_, i) => ({ resource: 'Label', code: 'custom', field: `f${i}` })),
  ];
  const r = labelFailure({ stdout: JSON.stringify({ message: 'Validation Failed', errors }), stderr: 'gh: Validation Failed (HTTP 422)\n' });
  assert.equal(r.status, 1);
  const said = saidOf(r);
  assert.ok(said.length <= 600, `the detail is bounded to 600 characters, got ${said.length}`);
  assert.match(said, /^gh: Validation Failed \(HTTP 422\) \| Validation Failed: Label name invalid \(m+ \[\.\.\. cut from 3021 chars \.\.\.\] m+\); Label color custom \(color is bad\); Label f0 custom; Label f1 custom; Label f2 custom \(and 2 more errors not shown\)$/);
});

test('end to end: a rate-limit or not-logged-in line after a long warning is still classed as such, without access advice', GH_SKIP, () => {
  const warning = `warning: ${'w'.repeat(700)}\n`;
  const rate = labelFailure({ stdout: '', stderr: `${warning}gh: API rate limit exceeded for installation ID 1 (HTTP 403)\n` });
  assert.equal(rate.status, 1);
  assert.match(rate.stderr, /was rate limited by github\.com/);
  assert.match(rate.stderr, /API rate limit exceeded for installation ID 1 \(HTTP 403\)/);
  assert.doesNotMatch(rate.stderr, LABEL_ADVICE);
  const auth = labelFailure({ stdout: '', stderr: `${warning}gh: not logged in to any GitHub hosts\n` });
  assert.equal(auth.status, 1);
  assert.match(auth.stderr, /refused as unauthenticated/);
  assert.doesNotMatch(auth.stderr, LABEL_ADVICE);
});

test('end to end: a rate limit named only in GitHub\'s JSON body is still classed as a rate limit', GH_SKIP, () => {
  const r = labelFailure({ stdout: JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }), stderr: 'gh: HTTP 403 (HTTP 403)\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /was rate limited by github\.com/);
  assert.doesNotMatch(r.stderr, LABEL_ADVICE);
});

test('end to end: a token inside a JSON error body is scrubbed and the body is still read as GitHub\'s message', GH_SKIP, () => {
  const r = labelFailure({ stdout: JSON.stringify({ message: 'Problems parsing token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Bearer abc.def' }), stderr: 'gh: Problems parsing JSON (HTTP 400)\n' });
  assert.equal(saidOf(r), 'gh: Problems parsing JSON (HTTP 400) | Problems parsing token [redacted] and Bearer [redacted]');
});

test('end to end: a 422 whose only text is on stdout is not lost, and an oversized body is bounded', GH_SKIP, () => {
  const r = labelFailure({ stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }], blob: 'x'.repeat(5000) }), stderr: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Label name already_exists/);
  assert.doesNotMatch(r.stderr, /xxxxxxxxxx/);
  assert.doesNotMatch(r.stderr, LABEL_ADVICE);
});

test('end to end: credentials in the response are scrubbed from the error', GH_SKIP, () => {
  const r = labelFailure({ stdout: '', stderr: 'gh: Validation Failed (HTTP 422) token ghp_abcdefghijklmnopqrstuvwxyz0123456789 Bearer abc.def\n' });
  assert.doesNotMatch(r.stderr, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(r.stderr, /Bearer abc\.def/);
});

test('end to end: 403 and 404 on a label create keep the access advice', GH_SKIP, () => {
  for (const [code, text] of [[403, 'Resource not accessible by integration'], [404, 'Not Found']]) {
    const r = labelFailure({ stdout: JSON.stringify({ message: text }), stderr: `gh: ${text} (HTTP ${code})\n` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`\\(HTTP ${code}\\)`));
    assert.match(r.stderr, LABEL_ADVICE);
  }
});

test('end to end: a rate limit, an auth failure and a non-JSON stderr keep their own wording, without access advice on the first two', GH_SKIP, () => {
  const rate = labelFailure({ stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)\n' });
  assert.match(rate.stderr, /was rate limited by/);
  assert.doesNotMatch(rate.stderr, LABEL_ADVICE);
  const auth = labelFailure({ stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n' });
  assert.match(auth.stderr, /refused as unauthenticated/);
  assert.doesNotMatch(auth.stderr, LABEL_ADVICE);
  const plain = labelFailure({ stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host\n' });
  assert.match(plain.stderr, /failed \(dial tcp: lookup api\.github\.com: no such host\)/);
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
    // Changed on purpose: the old text said "(Clear View's cap)", claiming the default is a limit of an outside consumer the mirror does not read. The exit 3, the count 200, the limit 200 and the skipped count are asserted exactly as before.
    assert.match(r.stderr, /CEILING github\.com\/acme\/widgets holds 200 issues \(pull requests excluded\) and the limit is 200 \(default mirror ceiling\): 1 board task\(s\) got NO issue\. Closing and labelling still ran\./);
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

test('ceilingOf: absent is the 200 default, a positive safe integer is that limit, 0 and null are unlimited', () => {
  assert.deepEqual(ceilingOf(undefined), { limit: 200, source: 'default' });
  assert.deepEqual(ceilingOf({}), { limit: 200, source: 'default' });
  assert.deepEqual(ceilingOf({ issue_mirror: {} }), { limit: 200, source: 'default' });
  assert.deepEqual(ceilingOf({ issue_mirror: { ceiling: 1500 } }), { limit: 1500, source: 'config' });
  assert.deepEqual(ceilingOf({ issue_mirror: { ceiling: 200 } }), { limit: 200, source: 'config' });
  assert.deepEqual(ceilingOf({ issue_mirror: { ceiling: 0 } }), { limit: null, source: 'config' });
  assert.deepEqual(ceilingOf({ issue_mirror: { ceiling: null } }), { limit: null, source: 'config' });
});

test('ceilingOf refuses every invalid value and never coerces or falls back', () => {
  for (const bad of ['1500', '', true, false, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, [], {}, [5]]) {
    assert.throws(() => ceilingOf({ issue_mirror: { ceiling: bad } }), CeilingSettingError, `ceiling ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, 5, 'x', [], true]) {
    assert.throws(() => ceilingOf({ issue_mirror: bad }), CeilingSettingError, `issue_mirror ${JSON.stringify(bad)}`);
  }
  assert.throws(() => ceilingOf(null), CeilingSettingError);
});

test('plan: a raised ceiling admits creates past 200, and null (unlimited) never skips', () => {
  const others = Array.from({ length: 300 }, (_, i) => ({ number: i + 1, state: i % 2 ? 'closed' : 'open', body: 'not ours', labels: [] }));
  const prs = Array.from({ length: 50 }, (_, i) => ({ number: 900 + i, state: 'open', body: 'pr', pull_request: {}, labels: [] }));
  const snapshot = snap({ items: [item(3), item(4), item(5)], journal: [jrow(1, 'done')] });
  const issues = [...others, ...prs, mirrored(700, 1)];
  const at200 = plan({ project: P, snapshot, issues });
  assert.equal(at200.ceiling.skipped, 3, 'the default 200 is already exceeded by 301 genuine issues');
  const raised = plan({ project: P, snapshot, issues, ceiling: 1500 });
  assert.deepEqual(raised.ceiling, { limit: 1500, count: 301, skipped: 0, skipped_items: [] });
  assert.equal(raised.actions.filter((a) => a.kind === 'create').length, 3);
  const tight = plan({ project: P, snapshot, issues, ceiling: 302 });
  assert.deepEqual(tight.ceiling.skipped_items.length, 2, 'a finite limit still caps and counts open and closed, not pull requests');
  assert.deepEqual(kinds(tight.actions), ['comment', 'close', 'create']);
  const unlimited = plan({ project: P, snapshot, issues, ceiling: null });
  assert.deepEqual(unlimited.ceiling, { limit: null, count: 301, skipped: 0, skipped_items: [] });
  assert.equal(unlimited.actions.filter((a) => a.kind === 'create').length, 3);
  assert.doesNotThrow(() => JSON.stringify(unlimited.ceiling));
});

function setMirrorConfig(h, issueMirror) {
  const path = join(h.root, '.sterling', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...cfg, issue_mirror: issueMirror }));
}

test('end to end: issue_mirror.ceiling raises the limit; the dry run names the limit and its source whether over or under it', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness({ preexisting: 200 });
  try {
    h.mk({ text: 'Past the default' });
    const dry = h.run('--dry-run');
    assert.equal(dry.status, 3, dry.stderr);
    assert.match(dry.stdout, /CEILING limit 200 \(default\); 200 genuine issue\(s\)/);
    setMirrorConfig(h, { ceiling: 1500 });
    const raisedDry = h.run('--dry-run');
    assert.equal(raisedDry.status, 0, raisedDry.stderr);
    assert.match(raisedDry.stdout, /CEILING limit 1500 \(config issue_mirror\.ceiling\); 200 genuine issue\(s\)/);
    assert.match(raisedDry.stdout, /would create issue "Past the default"/);
    const real = h.run();
    assert.equal(real.status, 0, real.stderr);
    assert.equal(h.gh().issues.filter((i) => !i.pull_request).length, 201);
    setMirrorConfig(h, { ceiling: 201 });
    h.mk({ text: 'Second past the limit' });
    const capped = h.run();
    assert.equal(capped.status, 3, capped.stderr);
    assert.match(capped.stderr, /holds 201 issues \(pull requests excluded\) and the limit is 201 \(config issue_mirror\.ceiling\): 1 board task/);
  } finally {
    h.cleanup();
  }
});

for (const unlimited of [0, null]) {
  test(`end to end: issue_mirror.ceiling ${unlimited} is unlimited and never exits 3`, { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
    const h = harness({ preexisting: 250 });
    try {
      h.mk({ text: 'One' });
      h.mk({ text: 'Two' });
      setMirrorConfig(h, { ceiling: unlimited });
      const dry = h.run('--dry-run');
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /CEILING limit unlimited \(config issue_mirror\.ceiling\)/);
      const real = h.run();
      assert.equal(real.status, 0, real.stderr);
      assert.equal(h.gh().issues.filter((i) => i.body?.includes('<!-- sterling-key: board:')).length, 2);
    } finally {
      h.cleanup();
    }
  });
}

test('end to end: an invalid issue_mirror.ceiling exits 2 before any gh call, dry run or not', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    h.mk({ text: 'Never mirrored' });
    for (const bad of [{ ceiling: '1500' }, { ceiling: true }, { ceiling: -5 }, { ceiling: 2.5 }, { ceiling: 1e300 }, 'many', null, []]) {
      setMirrorConfig(h, bad);
      for (const args of [['--dry-run'], []]) {
        const r = h.run(...args);
        assert.equal(r.status, 2, `${JSON.stringify(bad)} ${args}: ${r.stderr}`);
        assert.match(r.stderr, /issue_mirror.*Nothing was written/s);
        assert.equal(h.callsText(), '', 'gh was never called');
      }
    }
  } finally {
    h.cleanup();
  }
});

test('end to end: --project reads the target project\'s ceiling, not the caller\'s', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness({ preexisting: 200 });
  try {
    h.mk({ text: 'Target task' });
    setMirrorConfig(h, { ceiling: 0 });
    const elsewhere = mkdtempSync(join(tmpdir(), 'sterling-sync-issues-cwd-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--project', h.root], { cwd: elsewhere, env: h.env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /CEILING limit unlimited/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

// ---------- exclude_prefixes ----------

const EX = ['[CH] '];
const exItem = (n, prefix, record = {}, readiness = {}) => item(n, { text: `${prefix}Task ${n}\nmore detail`, ...record }, readiness);

test('excludePrefixesOf: absent is [], valid strings are kept as written, and every bad shape is refused', () => {
  assert.deepEqual(excludePrefixesOf(undefined), []);
  assert.deepEqual(excludePrefixesOf({}), []);
  assert.deepEqual(excludePrefixesOf({ issue_mirror: { ceiling: 5 } }), []);
  assert.deepEqual(excludePrefixesOf({ issue_mirror: { exclude_prefixes: [] } }), []);
  assert.deepEqual(excludePrefixesOf({ issue_mirror: { exclude_prefixes: [' [CH] ', 'x'] } }), [' [CH] ', 'x'], 'prefixes are neither trimmed nor case-folded');
  assert.deepEqual(mirrorSettingsOf({ issue_mirror: { ceiling: 0, exclude_prefixes: ['a'] } }), { ceiling: { limit: null, source: 'config' }, excludePrefixes: ['a'] });
  for (const bad of ['[CH]', null, 5, {}, true, [''], [1], [null], ['ok', ''], [['a']]]) {
    assert.throws(() => excludePrefixesOf({ issue_mirror: { exclude_prefixes: bad } }), CeilingSettingError, JSON.stringify(bad));
  }
  assert.throws(() => mirrorSettingsOf({ issue_mirror: [] }), CeilingSettingError);
  assert.throws(() => mirrorSettingsOf({ issue_mirror: { ceiling: 3, exclude_prefixes: 'x' } }), CeilingSettingError, 'a good ceiling does not excuse a bad prefix list');
});

test('exclude_prefixes: a matching task gets no issue, live or journal-only; a non-matching or differently cased one does', () => {
  const r = plan({
    project: P,
    snapshot: snap({ items: [exItem(1, '[CH] '), exItem(2, '[ch] '), exItem(3, 'x[CH] '), exItem(4, '')], journal: [jrow(5, 'done', { text: '[CH] done one' }), jrow(6, 'done', { text: 'plain done' })] }),
    issues: [],
    excludePrefixes: EX,
  });
  assert.deepEqual(r.actions.filter((a) => a.kind === 'create').map((a) => a.key).sort(), [uuid(2), uuid(3), uuid(4), uuid(6)].sort());
  assert.equal(r.ceiling.skipped, 0);
  const none = plan({ project: P, snapshot: snap({ items: [exItem(1, '[CH] ')] }), issues: [], excludePrefixes: [] });
  assert.equal(none.actions.length, 1, 'the default [] filters nothing');
});

test('exclude_prefixes: the prefix is matched after leading whitespace of the task text only', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { text: '  \n\t[CH] indented' }), item(2, { text: 'note: [CH] inside' }), item(3, { text: '[CH] ' + 'x'.repeat(5) })] }), issues: [], excludePrefixes: ['[CH]'] });
  assert.deepEqual(r.actions.map((a) => a.key), [uuid(2)]);
  const spaced = plan({ project: P, snapshot: snap({ items: [item(1, { text: ' [CH] a' })] }), issues: [], excludePrefixes: [' [CH]'] });
  assert.equal(spaced.actions.length, 1, 'a prefix with its own leading space is not trimmed, so it never matches trimmed text');
});

test('exclude_prefixes: an open issue of a now excluded task closes once as not planned, then a rerun does nothing and never reopens', () => {
  const gh = model([mirrored(10, 1, { labels: [{ name: 'blocked' }, { name: 'from:CH.Hub' }, { name: 'objective:x' }] }), mirrored(11, 2)], ['blocked', 'from:CH.Hub', 'objective:x']);
  const snapshot = snap({ items: [item(1, { text: '[CH] Task 1\nmore detail' }, { state: 'blocked' }), item(2)] });
  const first = gh.plan(snapshot, { excludePrefixes: EX });
  assert.deepEqual(kinds(first.actions), ['comment', 'remove_label', 'close']);
  assert.equal(first.actions[0].number, 10);
  assert.match(first.actions[0].body, /excluded from the mirror by config issue_mirror\.exclude_prefixes/);
  assert.ok(first.actions[0].body.includes(closeReceipt(uuid(1))));
  assert.equal(first.actions[1].label, 'blocked');
  assert.deepEqual(first.actions[2], { kind: 'close', number: 10, key: uuid(1), state_reason: 'not_planned', outcome: 'excluded' });
  assert.equal(describe(first.actions[2]), 'close #10 as not_planned (excluded)');
  assert.deepEqual(first.drift, []);
  gh.apply(first.actions);
  assert.ok(gh.issues.find((i) => i.number === 10).labels.some((l) => (l.name ?? l) === 'from:CH.Hub'), 'from: is kept');
  const second = gh.plan(snapshot, { excludePrefixes: EX });
  assert.deepEqual(second.actions, []);
  assert.deepEqual(second.warnings, [], 'a closed issue of an excluded task is neither reopened nor warned about');
});

test('exclude_prefixes: an interrupted close (receipt posted, issue open) closes without a second comment', () => {
  const gh = model([mirrored(10, 1)]);
  gh.comments.set(10, [excludedComment(uuid(1))]);
  const snapshot = snap({ items: [item(1, { text: '[CH] Task 1' })] });
  const r = gh.plan(snapshot, { excludePrefixes: EX });
  assert.deepEqual(kinds(r.actions), ['close']);
  assert.deepEqual(closeCandidates(snapshot, gh.issues, P, EX), [10]);
  assert.deepEqual(closeCandidates(snapshot, gh.issues, P), [], 'without the prefix the task is simply present');
});

test('exclude_prefixes: an earlier receipt with a different reason (a done comment) is reused: no second comment, the issue just closes as not planned', () => {
  const gh = model([mirrored(10, 1)]);
  gh.comments.set(10, [closeComment(uuid(1), { outcome: 'done', evidence: { commit: 'abc' } })]);
  const snapshot = snap({ items: [item(1, { text: '[CH] Task 1' })] });
  const r = gh.plan(snapshot, { excludePrefixes: EX });
  assert.deepEqual(r.actions, [{ kind: 'close', number: 10, key: uuid(1), state_reason: 'not_planned', outcome: 'excluded' }]);
  gh.apply(r.actions);
  assert.equal(gh.comments.get(10).length, 1, 'the earlier explanation stays the only comment (accepted exception)');
});

test('exclude_prefixes: an open issue of a JOURNAL-only (removed) excluded task closes as not planned excluded, never as done, with or without an earlier receipt', () => {
  const entry = jrow(1, 'done', { text: 'STATUS shipped', evidence: { commit: 'abc' } });
  const snapshot = snap({ journal: [entry] });
  const bare = model([mirrored(10, 1)]);
  const fresh = bare.plan(snapshot, { excludePrefixes: ['STATUS'] });
  assert.deepEqual(kinds(fresh.actions), ['comment', 'close']);
  assert.match(fresh.actions[0].body, /excluded from the mirror by config issue_mirror\.exclude_prefixes/);
  assert.doesNotMatch(fresh.actions[0].body, /Done on the Sterling board/);
  assert.deepEqual(fresh.actions[1], { kind: 'close', number: 10, key: uuid(1), state_reason: 'not_planned', outcome: 'excluded' });
  assert.deepEqual(fresh.actions.filter((a) => a.kind === 'create'), [], 'a journal-only excluded task never gets a new issue');
  const withReceipt = model([mirrored(10, 1, { labels: [{ name: 'blocked' }] })], ['blocked']);
  withReceipt.comments.set(10, [excludedComment(uuid(1))]);
  const reused = withReceipt.plan(snapshot, { excludePrefixes: ['STATUS'] });
  assert.deepEqual(kinds(reused.actions), ['remove_label', 'close']);
  assert.equal(reused.actions[1].state_reason, 'not_planned');
  assert.equal(reused.actions[1].outcome, 'excluded');
  const unexcluded = bare.plan(snapshot);
  assert.equal(unexcluded.actions[1].state_reason, 'completed', 'without the prefix the same row still closes as done');
  assert.deepEqual(model([mirrored(10, 1, { state: 'closed' })]).plan(snapshot, { excludePrefixes: ['STATUS'] }).actions, [], 'a closed issue is left alone');
});

test('exclude_prefixes: a whitespace-only prefix does not exclude every task, because the text is trimmed first and the prefix is literal', () => {
  const r = plan({ project: P, snapshot: snap({ items: [item(1, { text: 'Plain task' }), item(2, { text: '  Padded task' })] }), issues: [], excludePrefixes: [' '] });
  assert.equal(r.actions.length, 2);
  assert.deepEqual(excludePrefixesOf({ issue_mirror: { exclude_prefixes: [' '] } }), [' ']);
});

test('exclude_prefixes: a tracker keeps precedence, a foreign marker never closes, an unreadable item is left alone', () => {
  const foreign = { number: 20, state: 'open', title: 'f', body: bodyOf(uuid(2), '[CH] Task 2', 'other-project'), labels: [] };
  const r = plan({
    project: P,
    snapshot: snap({ items: [exItem(1, '[CH] ', { handoff: sent }, { state: 'delegated' }), exItem(2, '[CH] '), exItem(4, '[CH] ')], unreadable: [{ id: uuid(5), reason: 'bad' }] }),
    issues: [mirrored(10, 1), foreign, { number: 21, state: 'open', title: 'u', body: bodyOf(uuid(5), '[CH] u', 'alpha'), labels: [] }],
    excludePrefixes: EX,
  });
  assert.deepEqual(r.actions, []);
  assert.ok(r.warnings.some((w) => w.includes('#10') && w.includes('hand-off tracker')));
  assert.ok(r.warnings.some((w) => w.includes('#21') && w.includes('cannot read')));
});

test('a REMOVED hand-off tracker\'s open issue is left alone by every journal closure, excluded or ordinary, with or without a receipt', () => {
  const legacyText = "Handed to project 'Other': STATUS shipped";
  const rows = [
    ['typed', jrow(1, 'done', { handoff_role: 'sent', text: 'STATUS shipped', evidence: { commit: 'abc' } }), ['STATUS']],
    ['legacy text', jrow(1, 'done', { text: legacyText, evidence: { commit: 'abc' } }), ['Handed']],
  ];
  for (const [label, entry, prefixes] of rows) {
    const snapshot = snap({ journal: [entry] });
    for (const receipt of [false, true]) {
      for (const excludePrefixes of [prefixes, []]) {
        const gh = model([mirrored(10, 1, { labels: [{ name: 'in-progress' }, { name: 'blocked' }] })], ['in-progress', 'blocked']);
        if (receipt) gh.comments.set(10, [closeComment(uuid(1), entry)]);
        const before = structuredClone({ issue: gh.issues[0], comments: gh.comments.get(10) ?? [] });
        const r = gh.plan(snapshot, { excludePrefixes });
        const why = `${label}, receipt ${receipt}, prefixes [${excludePrefixes}]`;
        assert.deepEqual(r.actions, [], why);
        assert.ok(r.warnings.some((w) => w.includes('#10') && w.includes('hand-off tracker')), why);
        gh.apply(r.actions);
        assert.deepEqual({ issue: gh.issues[0], comments: gh.comments.get(10) ?? [] }, before, why);
      }
    }
  }
  const none = snap({ journal: [jrow(1, 'done', { handoff_role: 'none', text: legacyText, evidence: { commit: 'abc' } })] });
  const plain = model([mirrored(10, 1)]);
  assert.deepEqual(plain.plan(none).actions.filter((a) => a.kind === 'close').map((a) => a.state_reason), ['completed'], 'handoff_role none defeats the text fallback: an ordinary done close');
  assert.deepEqual(plain.plan(none, { excludePrefixes: ['Handed'] }).actions.filter((a) => a.kind === 'close').map((a) => a.outcome), ['excluded'], 'and an ordinary exclusion close');
});

test('exclude_prefixes: existing issues of excluded tasks still count toward a finite ceiling, closing them frees nothing, and a never-created excluded task costs 0', () => {
  const others = Array.from({ length: 197 }, (_, i) => ({ number: i + 1, state: 'closed', body: 'not ours', labels: [] }));
  const issues = [...others, mirrored(300, 1), mirrored(301, 2), mirrored(302, 3)];
  const snapshot = snap({ items: [item(1, { text: '[CH] Task 1' }), item(2, { text: '[CH] Task 2' }), item(3), exItem(4, '[CH] '), exItem(5, ''), exItem(6, '')] });
  const r = plan({ project: P, snapshot, issues, ceiling: 200, excludePrefixes: EX });
  assert.equal(r.ceiling.count, 200, 'the two issues about to be closed still count');
  assert.deepEqual(r.ceiling.skipped_items.map((s) => s.key), [uuid(5), uuid(6)], 'the excluded never-created task 4 is neither created nor skipped');
  assert.equal(r.ceiling.skipped, 2);
  assert.equal(r.actions.filter((a) => a.kind === 'create').length, 0);
  assert.equal(r.actions.filter((a) => a.kind === 'close').length, 2, 'closes still run at the ceiling');
  const room = plan({ project: P, snapshot, issues, ceiling: 201, excludePrefixes: EX });
  assert.deepEqual(room.actions.filter((a) => a.kind === 'create').map((a) => a.key), [uuid(5)], 'one slot of room: the excluded tasks never take it');
  assert.deepEqual(room.ceiling.skipped_items.map((s) => s.key), [uuid(6)]);
});

test('exclude_prefixes: excluded tasks cannot starve high or low priority work', () => {
  const items = [exItem(1, '[CH] ', { priority: 'high', created_at: '2026-01-01T00:00:00.000Z' }), exItem(2, '', { priority: 'low', created_at: '2026-01-02T00:00:00.000Z' }), exItem(3, '', { priority: 'high', created_at: '2026-01-03T00:00:00.000Z' })];
  const r = plan({ project: P, snapshot: snap({ items }), issues: [{ number: 1, state: 'closed', body: 'x', labels: [] }], ceiling: 3, excludePrefixes: EX });
  assert.deepEqual(r.actions.map((a) => a.key), [uuid(3), uuid(2)]);
  assert.equal(r.ceiling.skipped, 0);
});

test('end to end: exclude_prefixes keeps open and journal-only excluded tasks off GitHub; a later config closes the existing issue once', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness({ preexisting: 3 });
  try {
    const keep = h.mk({ text: 'Keep me' });
    const early = h.mk({ text: 'Mirror me first' });
    assert.equal(h.run().status, 0);
    const ours = (id) => h.gh().issues.find((i) => i.body?.includes(keyMarker(id)));
    assert.equal(ours(early.id).state, 'open');
    h.mk({ text: '[CH] Excluded open' });
    const gone = h.mk({ text: '[CH] Excluded journal' });
    h.store.remove(gone.id, NOW, { outcome: 'done' });
    setMirrorConfig(h, { exclude_prefixes: ['[CH] '] });
    h.store.remove(early.id, NOW, { outcome: 'dropped' });
    const before = h.gh().issues.length;
    h.resetCalls();
    const dry = h.run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.doesNotMatch(dry.stdout, /Excluded/);
    assert.deepEqual(h.writes(), []);
    const real = h.run();
    assert.equal(real.status, 0, real.stderr);
    assert.equal(h.gh().issues.length, before, 'no issue was created for either excluded task (and the removed one closed normally)');
    assert.ok(ours(keep.id));
    // Now exclude an already-mirrored live task.
    setMirrorConfig(h, { exclude_prefixes: ['Keep'] });
    h.resetCalls();
    const dry2 = h.run('--dry-run');
    assert.match(dry2.stdout, /would close #\d+ as not_planned \(excluded\)/);
    assert.match(dry2.stdout, /would comment on #\d+ with the close receipt/);
    assert.deepEqual(h.writes(), [], 'the dry run wrote nothing');
    const r1 = h.run();
    assert.equal(r1.status, 0, r1.stderr);
    const issue = ours(keep.id);
    assert.equal(issue.state, 'closed');
    assert.equal(issue.state_reason, 'not_planned');
    const comments = h.gh().comments[issue.number];
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /excluded from the mirror by config issue_mirror\.exclude_prefixes/);
    assert.match(r1.stdout, /\(excluded\)/);
    h.resetCalls();
    const r2 = h.run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(h.writes(), [], 'a second real run writes nothing');
    assert.match(r2.stdout, /nothing to do/);
  } finally {
    h.cleanup();
  }
});

test('end to end: invalid exclude_prefixes exit 2 before any gh call in both modes, even beside a valid ceiling', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    h.mk({ text: 'Never mirrored' });
    for (const bad of [{ exclude_prefixes: '[CH]' }, { exclude_prefixes: [''] }, { exclude_prefixes: [1] }, { exclude_prefixes: null }, { ceiling: 5, exclude_prefixes: {} }]) {
      setMirrorConfig(h, bad);
      for (const args of [['--dry-run'], []]) {
        const r = h.run(...args);
        assert.equal(r.status, 2, `${JSON.stringify(bad)} ${args}: ${r.stderr}`);
        assert.match(r.stderr, /exclude_prefixes.*Nothing was written/s);
        assert.equal(h.callsText(), '', 'gh was never called');
      }
    }
  } finally {
    h.cleanup();
  }
});

test('end to end: a close that fails after the exclusion comment leaves one comment; the rerun closes, the third run changes nothing', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    const t = h.mk({ text: 'Mirrored then excluded' });
    assert.equal(h.run().status, 0);
    const issue = () => h.gh().issues.find((i) => i.body?.includes(keyMarker(t.id)));
    setMirrorConfig(h, { exclude_prefixes: ['Mirrored'] });
    h.setGh({ patch_fail: true });
    const failed = h.run();
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(issue().state, 'open');
    assert.equal(h.gh().comments[issue().number].length, 1, 'the comment was posted before the close failed');
    h.setGh({ patch_fail: false });
    const rerun = h.run();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(issue().state, 'closed');
    assert.equal(issue().state_reason, 'not_planned');
    assert.equal(h.gh().comments[issue().number].length, 1, 'one comment in total');
    h.resetCalls();
    const third = h.run();
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(h.writes(), [], 'the third run writes nothing');
  } finally {
    h.cleanup();
  }
});

test('end to end: an exclusion comment posted, the close fails, the task is then removed from the board: the rerun still closes as not planned with one comment', { skip: process.platform === 'win32' && 'the fake gh is a POSIX shell shim' }, () => {
  const h = harness();
  try {
    const t = h.mk({ text: 'STATUS shipped' });
    assert.equal(h.run().status, 0);
    const issue = () => h.gh().issues.find((i) => i.body?.includes(keyMarker(t.id)));
    setMirrorConfig(h, { exclude_prefixes: ['STATUS'] });
    h.setGh({ patch_fail: true });
    assert.equal(h.run().status, 1);
    assert.equal(h.gh().comments[issue().number].length, 1);
    h.store.remove(t.id, NOW, { outcome: 'done', evidence: { commit: 'abc123' } });
    h.setGh({ patch_fail: false });
    const rerun = h.run();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(issue().state, 'closed');
    assert.equal(issue().state_reason, 'not_planned');
    assert.equal(h.gh().comments[issue().number].length, 1, 'one comment in total, the exclusion one');
    assert.match(h.gh().comments[issue().number][0].body, /excluded from the mirror/);
    h.resetCalls();
    assert.equal(h.run().status, 0);
    assert.deepEqual(h.writes(), []);
  } finally {
    h.cleanup();
  }
});
