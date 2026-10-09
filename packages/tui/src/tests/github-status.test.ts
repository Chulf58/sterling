import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import {
  classifyGhFailure,
  createGithubPoller,
  deriveGithub,
  nextPollDelay,
  FAST_POLL_MS,
  IDLE_POLL_MS,
  MAX_BACKOFF_MS,
  POLL_MS,
  STALE_MS,
  type ExecFile,
  type ExecFileError,
  type GithubPr,
  type GithubSnapshot,
} from '../github-status.js';
import {
  buildDashboardState,
  githubStrip,
  githubStripRows,
  initialUi,
  reduce,
  visibleBodyLines,
  GITHUB_TAB,
  KNOWLEDGE_TAB,
  SYSTEM_TAB,
  TASKS_TAB,
  type UiState,
} from '../state.js';
import { draw, type AttrLike } from '../render.js';
import { openDashboard } from '../controller.js';

// Board 87bca3f8: the GitHub strip row and the GitHub tab. The poller runs gh
// through an injected execFile here, so no test touches the network or gh.

const here = dirname(fileURLToPath(import.meta.url));
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

// ---------------------------------------------------------------- fake execFile

type Call = { file: string; args: readonly string[]; done: (err: ExecFileError | null, stdout: string, stderr: string) => void };

/** A fake execFile that holds every call until the test answers it. */
function heldExec(): { exec: ExecFile; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFile = (file, args, _opts, callback) => {
    calls.push({ file, args, done: callback });
  };
  return { exec, calls };
}

/** A fake execFile that answers at once: origin, then gh's result. */
function answeringExec(origin: string, gh: () => { err?: ExecFileError; stdout?: string; stderr?: string }): { exec: ExecFile; files: string[] } {
  const files: string[] = [];
  const exec: ExecFile = (file, _args, _opts, callback) => {
    files.push(file);
    if (file === 'git') return callback(null, `${origin}\n`, '');
    const r = gh();
    callback(r.err ?? null, r.stdout ?? '', r.stderr ?? '');
  };
  return { exec, files };
}

const ghError = (message: string, extra: Partial<ExecFileError> = {}): ExecFileError => Object.assign(new Error(message), { code: 1 }, extra);

function prNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 41,
    title: 'Fix the review threads',
    headRefName: 'fix-42',
    isDraft: false,
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    commits: { nodes: [{ commit: { oid: 'head1', statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewThreads: { nodes: [] },
    latestReviews: { nodes: [] },
    reviewRequests: { nodes: [] },
    ...over,
  };
}

function response(open: Record<string, unknown>[], merged: Record<string, unknown>[] = []): string {
  return JSON.stringify({ data: { repository: { open: { nodes: open }, merged: { nodes: merged } } } });
}

const ORIGIN = 'git@github.com:Chulf58/sterling.git';

// ---------------------------------------------------------------- derivation

test('derivation: checks rollup → pass / fail / pending / none', () => {
  const rows: [unknown, GithubPr['checks']][] = [
    [{ state: 'SUCCESS' }, 'pass'],
    [{ state: 'FAILURE' }, 'fail'],
    [{ state: 'ERROR' }, 'fail'],
    [{ state: 'PENDING' }, 'pending'],
    [{ state: 'EXPECTED' }, 'pending'],
    [null, 'none'],
  ];
  for (const [rollup, want] of rows) {
    const { open } = deriveGithub(JSON.parse(response([prNode({ commits: { nodes: [{ commit: { oid: 'h', statusCheckRollup: rollup } }] } })])));
    assert.equal(open[0]!.checks, want, `rollup ${JSON.stringify(rollup)}`);
  }
});

test('derivation: Copilot state is requested, reviewed on the head, stale on an older commit, or none', () => {
  const bot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
  const rows: [Record<string, unknown>, GithubPr['copilot']][] = [
    [{ reviewRequests: { nodes: [{ requestedReviewer: bot }] }, latestReviews: { nodes: [{ author: bot, commit: { oid: 'old' } }] } }, 'requested'],
    [{ latestReviews: { nodes: [{ author: bot, commit: { oid: 'head1' } }] } }, 'reviewed'],
    [{ latestReviews: { nodes: [{ author: bot, commit: { oid: 'old' } }] } }, 'stale'],
    [{ latestReviews: { nodes: [{ author: { __typename: 'User', login: 'copilot-fan' }, commit: { oid: 'head1' } }] } }, 'none'],
    [{ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'copilotish' } }] } }, 'none'],
    [{}, 'none'],
  ];
  for (const [over, want] of rows) {
    assert.equal(deriveGithub(JSON.parse(response([prNode(over)]))).open[0]!.copilot, want, JSON.stringify(over));
  }
});

test('derivation: unresolved threads, draft, merge state, review decision and the merged list', () => {
  const r = deriveGithub(
    JSON.parse(
      response(
        [prNode({ isDraft: true, mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED', reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } })],
        [{ number: 40, title: 'Earlier', mergedAt: '2026-10-08T10:00:00Z' }]
      )
    )
  );
  assert.deepEqual(r.open[0], { number: 41, title: 'Fix the review threads', branch: 'fix-42', draft: true, merge: 'DIRTY', review: 'CHANGES_REQUESTED', checks: 'pass', unresolved: 2, copilot: 'none' });
  assert.deepEqual(r.merged, [{ number: 40, title: 'Earlier', mergedAt: '2026-10-08T10:00:00Z' }]);
});

test('derivation: a response without a repository throws GitHub\'s own error', () => {
  assert.throws(() => deriveGithub({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository with the name 'x/y'." }] }), /Could not resolve to a Repository/);
  assert.throws(() => deriveGithub({}), /no repository/);
});

test('failure classes: not logged in, offline, no access, anything else', () => {
  assert.deepEqual(classifyGhFailure(ghError('exit 4'), 'To get started with GitHub CLI, please run:  gh auth login', 'o/r'), { failure: 'not-logged-in', reason: 'gh not logged in' });
  assert.deepEqual(classifyGhFailure(ghError('killed', { killed: true, signal: 'SIGTERM' }), '', 'o/r'), { failure: 'offline', reason: 'gh offline' });
  assert.equal(classifyGhFailure(ghError('exit 1'), 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host', 'o/r').failure, 'offline');
  assert.deepEqual(classifyGhFailure(ghError('exit 1'), 'gh: Could not resolve to a Repository with the name', 'o/r'), { failure: 'no-access', reason: 'gh: no access to o/r' });
  assert.deepEqual(classifyGhFailure(ghError('exit 1'), 'something odd\nmore', 'o/r'), { failure: 'error', reason: 'gh failed: something odd' });
});

// ---------------------------------------------------------------- the poller

test('poller: one poll in flight; tick and refresh never wait on it and never start a second', () => {
  const { exec, calls } = heldExec();
  const poller = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => null, clock: () => 0 });
  assert.equal(poller.tick(0), true, 'the first tick starts a poll');
  assert.equal(poller.snapshot().state, 'loading', 'tick returned before any process answered');
  assert.equal(poller.inFlight(), true);
  assert.equal(poller.tick(1_000_000), false, 'a due tick does not start a second poll');
  assert.equal(poller.refresh(), false, 'r while a poll runs starts nothing');
  assert.equal(calls.length, 1, 'only the origin read so far');
  assert.equal(calls[0]!.file, 'git');
  calls[0]!.done(null, `${ORIGIN}\n`, '');
  assert.equal(calls.length, 2, 'gh runs after git answered, still the same poll');
  assert.equal(calls[1]!.file, 'gh');
  assert.deepEqual(calls[1]!.args.slice(0, 2), ['api', 'graphql']);
  assert.ok(calls[1]!.args.includes('owner=Chulf58') && calls[1]!.args.includes('name=sterling'), 'the repo comes from origin');
  assert.equal(poller.tick(1_000_000), false);
  calls[1]!.done(null, response([]), '');
  assert.equal(poller.inFlight(), false);
  assert.equal(poller.snapshot().state, 'ok');
  assert.equal(poller.refresh(), true, 'r polls at once when nothing is in flight');
  assert.equal(calls.length, 3);
});

test('poller: never spawnSync — the module runs processes only through the async execFile', () => {
  const src = readFileSync(join(here, '..', 'github-status.js'), 'utf8');
  assert.doesNotMatch(src, /\b(spawnSync|execFileSync|execSync)\s*\(/, 'no synchronous child_process call in github-status');
  assert.doesNotMatch(src, /import\s*\{[^}]*\b(spawnSync|execFileSync|execSync)\b/, 'nor an import of one');
  assert.match(src, /import \{ execFile as nodeExecFile \} from 'node:child_process'/);
});

test('no state build reads gh: state.js has no runtime import of the poller and never names gh', () => {
  const src = readFileSync(join(here, '..', 'state.js'), 'utf8');
  assert.doesNotMatch(src, /from\s*['"]\.\/github-status\.js['"]|import\(\s*['"]\.\/github-status/, 'state.ts imports only types from github-status');
  assert.doesNotMatch(src, /(execFile|spawn|exec)\w*\(\s*['"]gh['"]/, 'state.ts never runs gh');
});

test('poller: cadence 60 s, 20 s while checks are pending or Copilot is requested, 5 min with no open PR', () => {
  let t = 1_000_000;
  let body = response([prNode()]);
  const { exec } = answeringExec(ORIGIN, () => ({ stdout: body }));
  const poller = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => null, clock: () => t });
  const expectNext = (delay: number, why: string): void => {
    assert.equal(poller.tick(t + delay - 1), false, `${why}: not due before ${delay} ms`);
    t += delay;
    assert.equal(poller.tick(t), true, `${why}: due at ${delay} ms`);
  };
  poller.tick(t);
  body = response([prNode({ commits: { nodes: [{ commit: { oid: 'h', statusCheckRollup: { state: 'PENDING' } } }] } })]);
  expectNext(POLL_MS, 'one open PR, checks green');
  body = response([prNode({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } }] } })]);
  expectNext(FAST_POLL_MS, 'checks pending');
  body = response([]);
  expectNext(FAST_POLL_MS, 'Copilot requested');
  expectNext(IDLE_POLL_MS, 'no open PR');
});

test('poller: failures back off by doubling up to 15 min; not logged in waits 15 min at once', () => {
  let t = 0;
  let fail: { err: ExecFileError; stderr: string } = { err: ghError('exit 1'), stderr: 'error connecting to api.github.com: dial tcp' };
  const { exec } = answeringExec(ORIGIN, () => fail);
  const poller = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => null, clock: () => t });
  poller.tick(t);
  for (const delay of [120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]) {
    assert.equal(poller.tick(t + delay - 1), false, `not before ${delay}`);
    t += delay;
    assert.equal(poller.tick(t), true, `due at ${delay}`);
  }
  assert.equal(poller.snapshot().failure, 'offline');
  fail = { err: ghError('exit 4'), stderr: 'To get started with GitHub CLI, please run:  gh auth login' };
  const fresh = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => null, clock: () => t });
  fresh.tick(t);
  assert.equal(fresh.snapshot().reason, 'gh not logged in');
  assert.equal(fresh.tick(t + MAX_BACKOFF_MS - 1), false);
  assert.equal(fresh.tick(t + MAX_BACKOFF_MS), true);
  assert.equal(nextPollDelay({ version: 1, state: 'failed', failure: 'not-logged-in' }, 1), MAX_BACKOFF_MS);
});

test('poller: hidden when gh is missing, origin is missing, or origin is not on github.com', () => {
  const missing = answeringExec(ORIGIN, () => ({ err: ghError('spawn gh ENOENT', { code: 'ENOENT' }) }));
  const p1 = createGithubPoller({ root: '/proj', execFile: missing.exec, readLoop: () => null, clock: () => 0 });
  p1.tick(0);
  assert.deepEqual([p1.snapshot().state, p1.snapshot().reason], ['hidden', 'gh not installed']);
  const noOrigin: ExecFile = (_f, _a, _o, cb) => cb(ghError("error: No such remote 'origin'"), '', '');
  const p2 = createGithubPoller({ root: '/proj', execFile: noOrigin, readLoop: () => null, clock: () => 0 });
  p2.tick(0);
  assert.deepEqual([p2.snapshot().state, p2.snapshot().reason], ['hidden', 'no origin remote']);
  const gitlab = answeringExec('git@gitlab.com:a/b.git', () => ({ stdout: response([]) }));
  const p3 = createGithubPoller({ root: '/proj', execFile: gitlab.exec, readLoop: () => null, clock: () => 0 });
  p3.tick(0);
  assert.equal(p3.snapshot().state, 'hidden');
  assert.deepEqual(gitlab.files, ['git'], 'gh never runs for a non-GitHub origin');
  for (const p of [p1, p2, p3]) assert.equal(githubStrip(p.snapshot(), 80), undefined, 'no strip row');
});

test('poller: the version moves only when the content changes; stale data is kept for 10 min, then dropped', () => {
  let t = 5_000_000;
  let reply: { stdout?: string; err?: ExecFileError; stderr?: string } = { stdout: response([prNode()]) };
  const { exec } = answeringExec(ORIGIN, () => reply);
  const poller = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => null, clock: () => t });
  poller.tick(t);
  const first = poller.snapshot();
  assert.equal(first.state, 'ok');
  // the same answer a minute later: fetchedAt moves, so the version does too;
  // a refresh inside the same millisecond with the same answer does not
  poller.refresh();
  assert.equal(poller.snapshot(), first, 'an identical poll keeps the same snapshot object');
  t += 60_000;
  reply = { err: ghError('exit 1'), stderr: 'dial tcp: i/o timeout' };
  poller.refresh();
  const failed = poller.snapshot();
  assert.equal(failed.state, 'failed');
  assert.ok(failed.version > first.version);
  assert.equal(failed.data, first.data, 'the last good data is kept while it is fresh');
  const strip = githubStrip(failed, 200)!;
  assert.equal(strip.dim, true);
  assert.match(strip.text, new RegExp(`^PR as of ${hhmm(first.data!.fetchedAt)} · #41`));
  t = first.data!.fetchedAt + STALE_MS + 1;
  poller.tick(t);
  assert.equal(poller.snapshot().data, undefined, 'dropped after STALE_MS');
  assert.deepEqual(githubStrip(poller.snapshot(), 80), { text: 'gh offline', dim: true });
});

test('poller: the PR loop comes from readLoop; an unreadable pr-loop.json is shown, never read as none', () => {
  const { exec } = answeringExec(ORIGIN, () => ({ stdout: response([]) }));
  const owed = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => ({ pr_number: 7, status: 'owed' }), clock: () => 0 });
  owed.tick(0);
  assert.deepEqual(owed.snapshot().loop, { status: 'owed', pr: 7 });
  const broken = createGithubPoller({ root: '/proj', execFile: exec, readLoop: () => { throw new Error('pr-loop.json is not valid JSON'); }, clock: () => 0 });
  broken.tick(0);
  assert.equal(broken.snapshot().loopError, 'pr-loop.json is not valid JSON');
  assert.match(githubStrip(broken.snapshot(), 80)!.text, /^⚠ pr-loop.json unreadable/);
});

// ---------------------------------------------------------------- the strip

const pr = (over: Partial<GithubPr> = {}): GithubPr => ({ number: 41, title: 'Fix', branch: 'fix-42', draft: false, merge: 'CLEAN', review: '', checks: 'pass', unresolved: 0, copilot: 'none', ...over });
const ok = (open: GithubPr[], extra: Partial<GithubSnapshot> = {}): GithubSnapshot => ({ version: 1, state: 'ok', repo: 'o/r', data: { open, merged: [], fetchedAt: 0 }, ...extra });

test('strip: hidden states — no poller, loading, hidden, and a hobby project with no open PR and no owed loop', () => {
  assert.equal(githubStrip(undefined), undefined);
  assert.equal(githubStrip({ version: 0, state: 'loading' }), undefined);
  assert.equal(githubStrip({ version: 1, state: 'hidden', reason: 'gh not installed' }), undefined);
  assert.equal(githubStrip(ok([])), undefined, 'no open PR, no loop');
  assert.equal(githubStrip(ok([], { loop: { status: 'clean', pr: 40 } })), undefined, 'a settled loop for a merged PR does not hold the strip open');
  assert.equal(githubStripRows(ok([])), 0);
  assert.equal(githubStripRows(ok([pr()])), 1);
});

test('strip: the derivation table', () => {
  const rows: [GithubSnapshot, string][] = [
    [ok([pr()]), 'PR #41 checks ✓ mergeable'],
    [ok([pr({ checks: 'fail', merge: 'BLOCKED', copilot: 'stale', unresolved: 2 })]), 'PR #41 checks ✗ blocked copilot stale 2 unresolved'],
    [ok([pr({ draft: true, checks: 'pending', merge: 'DRAFT' })]), 'PR #41 draft checks …'],
    [ok([pr({ merge: 'DIRTY', copilot: 'reviewed' })], { loop: { status: 'owed', pr: 41 } }), 'PR #41 checks ✓ conflicts copilot reviewed · loop owed'],
    [ok([pr({ number: 50 }), pr({ copilot: 'requested' })], { loop: { status: 'capped', pr: 41 } }), 'PR #41 checks ✓ mergeable copilot requested · loop capped · +1 open'],
    [ok([pr({ checks: 'none', merge: 'UNKNOWN' })]), 'PR #41'],
    [ok([], { loop: { status: 'owed', pr: 7 } }), 'PR loop owed #7 (not open)'],
  ];
  for (const [snap, want] of rows) assert.deepEqual(githubStrip(snap), { text: want, dim: false }, want);
  assert.deepEqual(githubStrip({ version: 2, state: 'failed', failure: 'not-logged-in', reason: 'gh not logged in' }, 48), { text: 'gh not logged in', dim: true });
  assert.equal(githubStrip(ok([pr({ checks: 'fail', merge: 'BLOCKED', copilot: 'stale', unresolved: 2 })]), 20)!.text, 'PR #41 checks ✗ blo…', 'clipped to the pane');
});

// ---------------------------------------------------------------- state + render

function fixture(): { store: SterlingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-github-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let clock = Date.parse('2026-06-10T12:00:00.000Z');
function addTodos(store: SterlingStore, n: number): void {
  for (let i = 0; i < n; i++) {
    const at = new Date((clock -= 1000)).toISOString();
    store.create({ id: randomUUID(), type: 'todo', created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], text: `task ${i}`, source: 'user' });
  }
}

type Put = { x: number; y: number; attr: AttrLike; str: string };
function capture(width: number, height: number) {
  const puts: Put[] = [];
  return { puts, screen: { width, height, fill() {}, put(o: { x: number; y: number; attr: AttrLike }, str: string) { puts.push({ ...o, str }); }, draw() {} } };
}

test('render: the strip sits just above the footer, the notice above it, and the body stops one row higher', () => {
  const { store, cleanup } = fixture();
  try {
    addTodos(store, 30);
    const height = 20;
    const github = ok([pr()]);
    const max = visibleBodyLines(height, 0, githubStripRows(github));
    assert.equal(max, visibleBodyLines(height) - 1, 'the strip takes one body line');
    const s = buildDashboardState(store, st({ notice: 'busy' }), 60, max, 'proj', false, undefined, undefined, undefined, height, github);
    const { screen, puts } = capture(60, height);
    draw(screen, s);
    const at = (y: number): string[] => puts.filter((p) => p.y === y).map((p) => p.str);
    assert.deepEqual(at(height - 1), [s.footer]);
    assert.deepEqual(at(height - 2), ['PR #41 checks ✓ mergeable']);
    assert.deepEqual(at(height - 3), ['⚠ busy']);
    const bodyRows = puts.filter((p) => p.y >= s.bodyTop && p.y < height - 3).map((p) => p.y);
    assert.equal(Math.max(...bodyRows), height - 4, 'the last body line is above the notice row');
    assert.equal(bodyRows.length, max, 'the drawn body matches visibleBodyLines');
  } finally {
    cleanup();
  }
});

test('render: no strip row is reserved when there is nothing to show; a failure is one dim row', () => {
  const { store, cleanup } = fixture();
  try {
    addTodos(store, 30);
    const height = 20;
    const hobby = buildDashboardState(store, st(), 60, visibleBodyLines(height), 'p', false, undefined, undefined, undefined, height, ok([]));
    assert.equal(hobby.strip, undefined);
    const a = capture(60, height);
    draw(a.screen, hobby);
    assert.ok(a.puts.some((p) => p.y === height - 3 && p.str.startsWith('  ')), 'a body line reaches the row above the notice row');
    assert.ok(!a.puts.some((p) => p.y === height - 2), 'the notice row is empty: no strip moved into it');
    const failed: GithubSnapshot = { version: 3, state: 'failed', failure: 'not-logged-in', reason: 'gh not logged in' };
    const s = buildDashboardState(store, st(), 60, visibleBodyLines(height, 0, 1), 'p', false, undefined, undefined, undefined, height, failed);
    const b = capture(60, height);
    draw(b.screen, s);
    const row = b.puts.find((p) => p.y === height - 2)!;
    assert.equal(row.str, 'gh not logged in');
    assert.equal(row.attr.dim, true, 'the failure row is dim');
  } finally {
    cleanup();
  }
});

test('GitHub tab: shown only with a poller; lists open PRs, the loop and recent merges; arrows scroll; footer names r', () => {
  const { store, cleanup } = fixture();
  try {
    const github: GithubSnapshot = {
      version: 4,
      state: 'ok',
      repo: 'Chulf58/sterling',
      data: { open: [pr({ review: 'CHANGES_REQUESTED', unresolved: 3, copilot: 'reviewed' })], merged: [{ number: 40, title: 'Earlier', mergedAt: '2026-10-08T10:00:00Z' }], fetchedAt: Date.parse('2026-10-09T08:00:00Z') },
      loop: { status: 'owed', pr: 41 },
    };
    assert.ok(!buildDashboardState(store, st()).tabs.some((t) => t.index === GITHUB_TAB), 'no poller, no tab');
    const s = buildDashboardState(store, st({ tab: GITHUB_TAB }), 120, Infinity, 'p', false, undefined, undefined, undefined, Infinity, github);
    assert.equal(s.tabs.at(-1)!.label, 'GitHub');
    assert.equal(s.tabs.at(-1)!.active, true);
    const text = s.rows.flatMap((r) => r.lines.map((l) => l.text));
    assert.deepEqual(text, [
      `Chulf58/sterling · as of ${hhmm(github.data!.fetchedAt)}`,
      '',
      'open pull requests (1)',
      '  #41 Fix',
      '    fix-42 · checks pass · merge clean · review changes requested · copilot reviewed · 3 unresolved',
      '',
      'PR review loop: owed for #41',
      '',
      'recently merged',
      '  #40 Earlier · 2026-10-08',
    ]);
    assert.ok(s.rows.every((r) => !r.selected), 'nothing on the tab is selectable');
    assert.match(s.footer, /r refresh/);
    // ↓ scrolls a line at a time inside a short viewport, and stops at the end
    const vp = { width: 120, maxBodyLines: 4, github };
    let ui = st({ tab: GITHUB_TAB });
    for (let i = 0; i < 10; i++) ui = reduce(store, ui, { kind: 'key', name: 'DOWN' }, vp).ui;
    assert.equal(ui.scroll, text.length - 4);
    ui = reduce(store, ui, { kind: 'key', name: 'UP' }, vp).ui;
    assert.equal(ui.scroll, text.length - 5);
    // the digit after System reaches it, on a host without the Agents tab
    assert.equal(reduce(store, st(), { kind: 'char', ch: '5' }, { github }).ui.tab, GITHUB_TAB);
    assert.equal(reduce(store, st(), { kind: 'char', ch: '4' }, { github }).ui.tab, SYSTEM_TAB);
    const loading = buildDashboardState(store, st({ tab: GITHUB_TAB }), 80, Infinity, 'p', false, undefined, undefined, undefined, Infinity, { version: 0, state: 'loading' });
    assert.deepEqual(loading.rows[0]!.lines.map((l) => l.text), ['checking GitHub…']);
  } finally {
    cleanup();
  }
});

test('the r key: a github_refresh effect on a host with a poller, text in the search field and the board editor', () => {
  const { store, cleanup } = fixture();
  try {
    const github = ok([]);
    assert.deepEqual(reduce(store, st(), { kind: 'char', ch: 'r' }, { github }).effects, [{ type: 'github_refresh' }]);
    assert.deepEqual(reduce(store, st({ tab: SYSTEM_TAB }), { kind: 'char', ch: 'r' }, { github }).effects, [{ type: 'github_refresh' }]);
    assert.deepEqual(reduce(store, st(), { kind: 'char', ch: 'r' }).effects, [], 'no poller, no effect');
    const search = reduce(store, st({ tab: KNOWLEDGE_TAB }), { kind: 'char', ch: 'r' }, { github });
    assert.deepEqual(search.effects, []);
    assert.equal(search.ui.searchQuery, 'r');
    const edit = reduce(store, st({ tab: TASKS_TAB, boardEdit: { id: 'x', text: 'ab', version: 1 } }), { kind: 'char', ch: 'r' }, { github });
    assert.deepEqual(edit.effects, []);
    assert.equal(edit.ui.boardEdit!.text, 'abr');
  } finally {
    cleanup();
  }
});

test('controller: r calls the host refresh; a new snapshot version rebuilds the frame, the same one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-github-ctl-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  let refreshed = 0;
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), { deferWrites: true, onGithubRefresh: () => { refreshed += 1; } });
  try {
    const vp = { width: 80, maxBodyLines: 10, showBanner: false, github: ok([]) };
    await ctl.handle({ kind: 'char', ch: 'r' }, vp);
    assert.equal(refreshed, 1);
    const a = ctl.state(vp);
    assert.equal(a.strip, undefined);
    assert.equal(ctl.state({ ...vp, github: { ...ok([]) } }), a, 'same version: the cached frame');
    const b = ctl.state({ ...vp, github: ok([pr()], { version: 2 }) });
    assert.notEqual(b, a);
    assert.equal(b.strip!.text, 'PR #41 checks ✓ mergeable');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
