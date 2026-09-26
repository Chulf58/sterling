// pr-review-wait.mjs — the ONE bounded gh helper of the PR review loop
// (decision project-mode-hobby-work-toggle-decides-flow, slice S3; skill
// skills/pr-review-loop/SKILL.md). It resolves the repo from origin, fetches
// the PR head, its reviews and review comments (paginated), and waits until a
// Copilot review NEWER than --since-review exists for the CURRENT head, or
// until the timeout. Stdout is ONE JSON object; timeout and error are never
// 'review'. Also carries the deliberate settle act for the H10 duty
// (`--settle <clean|capped|escalated> --pr <n>`).
//
// Harness: a git repo whose origin is a GitHub-shaped URL (nothing is ever
// pushed or fetched), and a PATH-prepended fake `gh` answering `gh api` from
// canned JSON in a state dir. No real GitHub call is ever made. Child streams
// are flattened with oneLine() before landing in an assertion message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = join(root, 'scripts', 'pr-review-wait.mjs');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const COPILOT = 'copilot-pull-request-reviewer[bot]';

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// The fake gh. Every invocation is logged (one JSON argv array per line).
// `gh api [--paginate] [--hostname h] <path>` answers from the state dir:
//   <endpoint>.<k>.json   an array of PAGES (each page an array, or the PR
//                         object for the 'pull' endpoint); the file used is the
//                         one with the highest k <= the number of earlier
//                         calls to that endpoint, so a review can "land" on a
//                         later poll. endpoint: pull | reviews | comments.
//   With --paginate every page is printed back to back (gh's own output for
//   array endpoints); without it, only the first page.
//   A path whose repo is not acme/widget answers 404; a file named
//   fail_<endpoint> makes that endpoint exit 1.
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.FAKE_GH_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(state, 'log.jsonl'), JSON.stringify(argv) + '\\n');
if (argv[0] !== 'api') { console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3); }
const path = argv.filter((a, i) => i > 0 && !a.startsWith('--') && argv[i - 1] !== '--hostname').pop();
const m = path.match(/^repos\\/([^/]+)\\/([^/]+)\\/pulls\\/(\\d+)(?:\\/(reviews|comments))?(?:\\?.*)?$/);
if (!m) { console.error('fake gh: unexpected path ' + path); process.exit(3); }
if (m[1] + '/' + m[2] !== 'acme/widget') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
const endpoint = m[4] ?? 'pull';
if (existsSync(join(state, 'fail_' + endpoint))) { console.error('gh: Server Error (HTTP 502)'); process.exit(1); }
const countFile = join(state, 'count_' + endpoint);
const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(count + 1));
let pick = null;
for (let k = 0; k <= count; k++) if (existsSync(join(state, endpoint + '.' + k + '.json'))) pick = k;
const pages = pick === null ? [[]] : JSON.parse(readFileSync(join(state, endpoint + '.' + pick + '.json'), 'utf8'));
const out = argv.includes('--paginate') ? pages : pages.slice(0, 1);
process.stdout.write(out.map((p) => JSON.stringify(p)).join(''));
process.exit(0);
`;

function makeFixture({ originUrl = 'git@github.com:acme/widget.git' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-prwait-'));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  };
  g(['init', '-b', 'main']);
  g(['remote', 'add', 'origin', originUrl]);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const bin = join(base, 'fakebin');
  const state = join(base, 'ghstate');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const impl = join(base, 'fake-gh.mjs');
  writeFileSync(impl, FAKE_GH_IMPL);
  const shim = join(bin, 'gh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(shim, 0o755);
  const put = (endpoint, k, pages) => writeFileSync(join(state, `${endpoint}.${k}.json`), JSON.stringify(pages));
  put('pull', 0, [{ number: 7, head: { sha: HEAD } }]);
  return { base, dir, state, bin, put, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function run(f, args, { timeout = 30_000 } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: f.dir,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, PATH: `${f.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: f.state },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

function calls(f) {
  const file = join(f.state, 'log.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const review = (id, { login = COPILOT, commit = HEAD, state = 'COMMENTED', body = `review ${id}` } = {}) => ({ id, user: { login }, commit_id: commit, state, body });
const comment = (id, reviewId, extra = {}) => ({ id, pull_request_review_id: reviewId, path: 'src/a.mjs', line: 3, body: `comment ${id}`, ...extra });
// Fast polling for tests: a 50ms first interval, a 2s bound.
const FAST = ['--interval', '0.05', '--timeout', '2'];

test('a NEW Copilot review on the CURRENT head is returned with its comments (paginated), the observed login and exit 0', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(100, { login: 'octocat' })], [review(101)]]);
    f.put('comments', 0, [
      [comment(1, 101), comment(2, 100)],
      [comment(3, 101, { line: null, original_line: 9, in_reply_to_id: 1 })],
    ]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.code, 0, `exit 0 on a review — ${oneLine(r.stdout)} ${oneLine(r.stderr)}`);
    assert.deepEqual(r.out, {
      status: 'review',
      head_sha: HEAD,
      review: { id: 101, commit_id: HEAD, author: COPILOT, state: 'COMMENTED', body: 'review 101' },
      comments: [
        { id: 1, path: 'src/a.mjs', line: 3, body: 'comment 1', in_reply_to: null },
        { id: 3, path: 'src/a.mjs', line: 9, body: 'comment 3', in_reply_to: 1 },
      ],
      observed_copilot_login: COPILOT,
      stale_review_ignored: false,
    });
  } finally {
    f.cleanup();
  }
});

test('pagination: reviews and comments are fetched with --paginate, and a review on the SECOND page is found', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(10, { login: 'octocat' })], [review(11, { login: 'octocat' })], [review(12)]]);
    f.put('comments', 0, [[], [comment(5, 12)]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out?.status, 'review', oneLine(r.stdout + r.stderr));
    assert.equal(r.out.review.id, 12);
    assert.deepEqual(r.out.comments.map((c) => c.id), [5]);
    const lists = calls(f).filter((c) => /\/(reviews|comments)$/.test(c[c.length - 1]));
    assert.ok(lists.length >= 2, 'reviews and comments were fetched');
    for (const c of lists) assert.ok(c.includes('--paginate'), `every list call paginates: ${JSON.stringify(c)}`);
  } finally {
    f.cleanup();
  }
});

test('an OLD-head Copilot review is ignored (stale_review_ignored), and without a current-head review the call ends in timeout, exit 2, never clean', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(200, { commit: OLD_HEAD })]]);
    f.put('comments', 0, [[comment(9, 200)]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.code, 2, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'timeout');
    assert.equal(r.out.review, null);
    assert.deepEqual(r.out.comments, []);
    assert.equal(r.out.stale_review_ignored, true);
    assert.equal(r.out.observed_copilot_login, COPILOT, 'the login is reported even from a stale review');
    assert.equal(r.out.head_sha, HEAD);
  } finally {
    f.cleanup();
  }
});

test('timeout: with no review at all the call is BOUNDED — it returns timeout within the window, polling more than once', () => {
  const f = makeFixture();
  try {
    const r = run(f, ['7', '--interval', '0.05', '--timeout', '1']);
    assert.equal(r.code, 2);
    assert.equal(r.out.status, 'timeout');
    assert.equal(r.out.observed_copilot_login, null);
    assert.ok(r.ms < 10_000, `bounded: took ${r.ms}ms`);
    const reviewCalls = calls(f).filter((c) => c[c.length - 1].endsWith('/reviews'));
    assert.ok(reviewCalls.length >= 2, `it polled (${reviewCalls.length} reviews fetches)`);
  } finally {
    f.cleanup();
  }
});

test('a review that LANDS on a later poll is picked up; a non-Copilot bot and a human are never taken for Copilot', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(300, { login: 'github-actions[bot]' }), review(301, { login: 'octocat' })]]);
    f.put('reviews', 2, [[review(300, { login: 'github-actions[bot]' }), review(301, { login: 'octocat' }), review(302)]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out?.status, 'review', oneLine(r.stdout + r.stderr));
    assert.equal(r.out.review.id, 302);
  } finally {
    f.cleanup();
  }
});

test('non-Copilot reviewers only: a bot and a human on the current head end in timeout', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(400, { login: 'github-actions[bot]' }), review(401, { login: 'octocat', state: 'CHANGES_REQUESTED' })]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out.status, 'timeout');
    assert.equal(r.out.observed_copilot_login, null);
  } finally {
    f.cleanup();
  }
});

test('--since-review: a Copilot review at or below the consumed id is not new; the newer one is returned', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(500), review(501, { state: 'PENDING' })]]);
    const consumed = run(f, ['7', '--since-review', '500', ...FAST]);
    assert.equal(consumed.out.status, 'timeout', 'the consumed review and a PENDING one are not a new completed review');
    f.put('reviews', 0, [[review(500), review(502)]]);
    rmSync(join(f.state, 'count_reviews'), { force: true });
    const r = run(f, ['7', '--since-review', '500', ...FAST]);
    assert.equal(r.out.status, 'review');
    assert.equal(r.out.review.id, 502);
  } finally {
    f.cleanup();
  }
});

test('--head: a review of the PR head is not taken while the PR head is not yet the expected pushed SHA', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(600)]]);
    const r = run(f, ['7', '--head', OLD_HEAD, ...FAST]);
    assert.equal(r.out.status, 'timeout');
    assert.equal(r.out.head_sha, HEAD, 'head_sha reports what GitHub says the head is');
  } finally {
    f.cleanup();
  }
});

test('the repo is BOUND to origin: every gh call names repos/acme/widget and --hostname github.com; a PR URL or --repo naming another repo is an error with no gh call', () => {
  const f = makeFixture({ originUrl: 'https://github.com/acme/widget.git' });
  try {
    f.put('reviews', 0, [[review(700)]]);
    const ok = run(f, ['https://github.com/acme/widget/pull/7', '--repo', 'github.com/acme/widget', ...FAST]);
    assert.equal(ok.out?.status, 'review', oneLine(ok.stdout + ok.stderr));
    const all = calls(f);
    assert.ok(all.length >= 3);
    for (const c of all) {
      assert.equal(c[0], 'api');
      assert.equal(c[c.indexOf('--hostname') + 1], 'github.com', `--hostname on every call: ${JSON.stringify(c)}`);
      assert.match(c[c.length - 1], /^repos\/acme\/widget\/pulls\/7(\/|$)/);
    }
    rmSync(join(f.state, 'log.jsonl'));
    for (const args of [['https://github.com/other/thing/pull/7'], ['7', '--repo', 'github.com/other/thing']]) {
      const bad = run(f, [...args, ...FAST]);
      assert.equal(bad.code, 1, oneLine(bad.stdout + bad.stderr));
      assert.equal(bad.out.status, 'error');
      assert.match(bad.out.error, /origin/);
      assert.equal(calls(f).length, 0, 'no gh call for a repo that is not origin');
    }
  } finally {
    f.cleanup();
  }
});

test('error: a failing gh call ends in status error, exit 1 — never review, never clean', () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.state, 'fail_reviews'), '');
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.code, 1);
    assert.equal(r.out.status, 'error');
    assert.match(r.out.error, /502/);
    assert.equal(r.out.review, null);
  } finally {
    f.cleanup();
  }
});

test('usage errors (no PR, a bad --timeout) are status error with exit 1 and one JSON object', () => {
  const f = makeFixture();
  try {
    for (const args of [[], ['7', '--timeout', 'soon'], ['7', '--timeout', '0']]) {
      const r = run(f, args);
      assert.equal(r.code, 1, JSON.stringify(args));
      assert.equal(r.out?.status, 'error', oneLine(r.stdout));
    }
    assert.equal(calls(f).length, 0);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------------------ settle

const loopPath = (f) => join(f.dir, '.sterling', 'transient', 'pr-loop.json');
function arm(f, over = {}) {
  mkdirSync(dirname(loopPath(f)), { recursive: true });
  const state = { pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, repo: 'github.com/acme/widget', head_sha: HEAD, armed_at: '2026-09-26T10:00:00.000Z', status: 'owed', ...over };
  writeFileSync(loopPath(f), JSON.stringify(state));
  return state;
}

for (const outcome of ['clean', 'capped', 'escalated']) {
  test(`--settle ${outcome} --pr 7 writes status ${outcome} on the armed loop (exit 0, no gh call)`, () => {
    const f = makeFixture();
    try {
      const armed = arm(f);
      const r = run(f, ['--settle', outcome, '--pr', '7']);
      assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
      const after = JSON.parse(readFileSync(loopPath(f), 'utf8'));
      assert.equal(after.status, outcome);
      assert.equal(typeof after.settled_at, 'string');
      for (const k of ['pr_url', 'pr_number', 'repo', 'head_sha', 'armed_at']) assert.equal(after[k], armed[k]);
      assert.equal(r.out.status, outcome);
      assert.equal(calls(f).length, 0);
    } finally {
      f.cleanup();
    }
  });
}

test('--settle refuses (exit 1, file unchanged): another PR number, an unknown outcome, no armed loop', () => {
  const f = makeFixture();
  try {
    assert.equal(run(f, ['--settle', 'clean', '--pr', '7']).code, 1, 'no pr-loop.json: nothing to settle');
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    for (const args of [['--settle', 'clean', '--pr', '8'], ['--settle', 'done', '--pr', '7'], ['--settle', 'clean']]) {
      const r = run(f, args);
      assert.equal(r.code, 1, `${JSON.stringify(args)}: ${oneLine(r.stdout + r.stderr)}`);
      assert.equal(readFileSync(loopPath(f), 'utf8'), before);
    }
  } finally {
    f.cleanup();
  }
});
