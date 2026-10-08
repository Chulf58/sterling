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
//   `gh api graphql ...` answers graphql.json (default: a success payload) or
//   exits 1 when fail_graphql exists; `--jq .node_id` prints the pull's node_id.
//   A graphql query mentioning reviewThreads (the merge-state query) answers
//   {data:{repository:{pullRequest:<page>}}} from merge_pages.json (an array of
//   pullRequest pages, one per call; default: CLEAN, no threads) and exits 1 when
//   fail_merge exists. A resolveReviewThread mutation records the thread id on
//   resolved.log and answers isResolved true, exits 1 when fail_resolve exists,
//   or answers a GraphQL errors payload when resolve_errors exists; a file
//   fail_resolve_after holding N exits 1 once resolved.log has N lines. A
//   merge-state query answers a GraphQL errors payload when merge_errors exists.
//   A path whose repo is not acme/widget answers 404; a file named
//   fail_<endpoint> makes that endpoint exit 1; delay_ms delays every answer.
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.FAKE_GH_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(state, 'log.jsonl'), JSON.stringify(argv) + '\\n');
if (argv[0] !== 'api') { console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3); }
const VALUED = new Set(['--hostname', '--jq', '-f', '-F']);
const path = argv.filter((a, i) => i > 0 && !a.startsWith('-') && !VALUED.has(argv[i - 1])).pop();
if (path === 'graphql') {
  const q = (argv.find((a) => a.startsWith('query=')) ?? '');
  if (q.includes('resolveReviewThread')) {
    if (existsSync(join(state, 'fail_resolve'))) { console.error('gh: GraphQL: Resource not accessible by integration (resolveReviewThread)'); process.exit(1); }
    if (existsSync(join(state, 'resolve_errors'))) { process.stdout.write('{"errors":[{"message":"thread cannot be resolved"}],"data":null}'); process.exit(0); }
    const after = join(state, 'fail_resolve_after');
    const logged = existsSync(join(state, 'resolved.log')) ? readFileSync(join(state, 'resolved.log'), 'utf8').split('\\n').filter(Boolean).length : 0;
    if (existsSync(after) && logged >= Number(readFileSync(after, 'utf8'))) { console.error('gh: GraphQL: Resource not accessible by integration (resolveReviewThread, later thread)'); process.exit(1); }
    const id = q.match(/threadId:"([^"]*)"/)[1];
    appendFileSync(join(state, 'resolved.log'), id + '\\n');
    process.stdout.write(JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } }));
    process.exit(0);
  }
  if (q.includes('reviewThreads')) {
    if (existsSync(join(state, 'fail_merge'))) { console.error('gh: Server Error (HTTP 502) (merge state)'); process.exit(1); }
    if (existsSync(join(state, 'merge_errors'))) { process.stdout.write('{"errors":[{"message":"Could not resolve to a Repository"}],"data":null}'); process.exit(0); }
    const countFile = join(state, 'count_merge');
    const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
    writeFileSync(countFile, String(n + 1));
    const file = join(state, 'merge_pages.json');
    const pages = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [{ mergeStateStatus: 'CLEAN', reviewDecision: null, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }];
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: pages[Math.min(n, pages.length - 1)] } } }));
    process.exit(0);
  }
  if (existsSync(join(state, 'fail_graphql'))) { console.error('gh: GraphQL: Could not resolve to a Bot (requestReviewsByLogin)'); process.exit(1); }
  const gql = join(state, 'graphql.json');
  process.stdout.write(existsSync(gql) ? readFileSync(gql, 'utf8') : '{"data":{"requestReviewsByLogin":{"pullRequest":{"id":"PR_node_7"}}}}');
  process.exit(0);
}
const m = path.match(/^repos\\/([^/]+)\\/([^/]+)\\/pulls\\/(\\d+)(?:\\/(reviews|comments))?(?:\\?.*)?$/);
if (!m) { console.error('fake gh: unexpected path ' + path); process.exit(3); }
if (m[1] + '/' + m[2] !== 'acme/widget') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
const endpoint = m[4] ?? 'pull';
if (existsSync(join(state, 'delay_ms'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(readFileSync(join(state, 'delay_ms'), 'utf8')));
if (existsSync(join(state, 'fail_' + endpoint))) { console.error('gh: Server Error (HTTP 502)'); process.exit(1); }
const countFile = join(state, 'count_' + endpoint);
const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(count + 1));
let pick = null;
for (let k = 0; k <= count; k++) if (existsSync(join(state, endpoint + '.' + k + '.json'))) pick = k;
const pages = pick === null ? [[]] : JSON.parse(readFileSync(join(state, endpoint + '.' + pick + '.json'), 'utf8'));
const out = argv.includes('--paginate') ? pages : pages.slice(0, 1);
if (argv[argv.indexOf('--jq') + 1] === '.node_id') { process.stdout.write(String(pages[0]?.node_id ?? null) + '\\n'); process.exit(0); }
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

// user.type follows GitHub: '[bot]' logins are Bots, everything else a User
// unless the test says otherwise (identity needs type 'Bot', Sol review).
const review = (id, { login = COPILOT, type = login.endsWith('[bot]') ? 'Bot' : 'User', commit = HEAD, state = 'COMMENTED', body = `review ${id}` } = {}) => ({ id, user: { login, type }, commit_id: commit, state, body });
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
      identity_confirmed: false,
      previously_missed: [],
      body_findings_without_comments: false,
      copilot_request: null,
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

test('HIGH (Sol): two fresh reviews — 101 with actionable comments, then an empty 102 — return 101 FIRST; 102 only once 101 is consumed', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(101), review(102, { body: '' })]]);
    f.put('comments', 0, [[comment(1, 101), comment(2, 101)]]);
    const first = run(f, ['7', ...FAST]);
    assert.equal(first.out?.status, 'review', oneLine(first.stdout + first.stderr));
    assert.equal(first.out.review.id, 101, 'the LOWEST fresh review id comes first, never skipped');
    assert.deepEqual(first.out.comments.map((c) => c.id), [1, 2]);
    const next = run(f, ['7', '--since-review', '101', ...FAST]);
    assert.equal(next.out.review.id, 102);
    assert.deepEqual(next.out.comments, []);
  } finally {
    f.cleanup();
  }
});

test('identity (Sol): a NON-bot login containing copilot is never taken for Copilot', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(800, { login: 'copilot-fan' }), review(801, { login: 'Copilot', type: 'User' })]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out.status, 'timeout', oneLine(r.stdout));
    assert.equal(r.out.observed_copilot_login, null);
    assert.equal(r.out.identity_confirmed, false);
  } finally {
    f.cleanup();
  }
});

test('identity (Sol): unpinned, any Bot matching /copilot/i is accepted with identity_confirmed false; pinned in pr_review.copilot_logins, only the EXACT login counts and identity_confirmed is true', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(900, { login: 'copilot-helper[bot]' }), review(901)]]);
    const unpinned = run(f, ['7', ...FAST]);
    assert.equal(unpinned.out.review.id, 900);
    assert.equal(unpinned.out.identity_confirmed, false);
    writeFileSync(join(f.dir, '.sterling', 'config.json'), JSON.stringify({ pr_review: { copilot_logins: [COPILOT] } }));
    const pinned = run(f, ['7', ...FAST]);
    assert.equal(pinned.out.review.id, 901, oneLine(pinned.stdout));
    assert.equal(pinned.out.review.author, COPILOT);
    assert.equal(pinned.out.identity_confirmed, true);
    assert.equal(pinned.out.observed_copilot_login, COPILOT);
  } finally {
    f.cleanup();
  }
});

test('identity: a malformed pr_review.copilot_logins is an error, never silently unpinned', () => {
  const f = makeFixture();
  try {
    for (const bad of [{ copilot_logins: 'copilot' }, { copilot_logins: [''] }, 'x']) {
      writeFileSync(join(f.dir, '.sterling', 'config.json'), JSON.stringify({ pr_review: bad }));
      const r = run(f, ['7', ...FAST]);
      assert.equal(r.code, 1, JSON.stringify(bad));
      assert.equal(r.out.status, 'error');
      assert.match(r.out.error, /copilot_logins|pr_review/);
    }
  } finally {
    f.cleanup();
  }
});

const NEW_HEAD = 'c'.repeat(40);

test('head race (Sol): the head moves while the review is fetched — the review is NOT returned; it polls again and the old-head review is stale', () => {
  const f = makeFixture();
  try {
    f.put('pull', 1, [{ number: 7, head: { sha: NEW_HEAD } }]);
    f.put('reviews', 0, [[review(1000)]]);
    f.put('comments', 0, [[comment(1, 1000)]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out.status, 'timeout', `a review of a head that moved is never returned: ${oneLine(r.stdout)}`);
    assert.equal(r.out.head_sha, NEW_HEAD);
    assert.equal(r.out.stale_review_ignored, true);
  } finally {
    f.cleanup();
  }
});

test('deadline (Sol): a gh call that hangs is cut at the --timeout budget; the whole call returns timeout within the bound', () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.state, 'delay_ms'), '8000');
    const r = run(f, ['7', '--interval', '0.05', '--timeout', '1']);
    assert.equal(r.code, 2, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'timeout');
    assert.ok(r.ms < 4000, `bounded by --timeout, took ${r.ms}ms`);
  } finally {
    f.cleanup();
  }
});

test('deadline (Sol): slow calls that each fit but together exceed the budget stop at the deadline, not after another full poll', () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.state, 'delay_ms'), '400');
    const r = run(f, ['7', '--interval', '0.05', '--timeout', '1']);
    assert.equal(r.out.status, 'timeout', oneLine(r.stdout + r.stderr));
    assert.ok(r.ms < 2500, `bounded by --timeout, took ${r.ms}ms`);
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
  test(`--settle ${outcome} --pr 7 writes status ${outcome} on the armed loop (exit 0; ${outcome === 'clean' ? 'one merge-state query' : 'no gh call'})`, () => {
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
      if (outcome === 'clean') {
        assert.equal(calls(f).length, 1, 'clean asks GitHub for the merge state once');
        assert.ok(calls(f)[0].some((a) => a.startsWith('query=') && a.includes('mergeStateStatus')));
      } else assert.equal(calls(f).length, 0);
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

// Sol review (MEDIUM): settle is bound to the CURRENT origin, the armed state
// must be coherent (pr_url, repo and number agree), and only an OWED loop can
// be settled. --pr accepts the full PR URL too.
test('--settle accepts the full PR URL as --pr', () => {
  const f = makeFixture();
  try {
    arm(f);
    const r = run(f, ['--settle', 'clean', '--pr', 'https://github.com/acme/widget/pull/7']);
    assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
    assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'clean');
  } finally {
    f.cleanup();
  }
});

test('--settle refusal for a PR number that differs from the armed one prints the armed PR, its head, the re-arm command and the discard command', () => {
  const f = makeFixture();
  try {
    arm(f);
    const r = run(f, ['--settle', 'clean', '--pr', '8']);
    assert.equal(r.code, 1);
    for (const text of [r.stderr, r.out.error]) {
      assert.match(text, /armed.*PR #7/s, 'names the armed PR number');
      assert.ok(text.includes(HEAD), 'names the armed head');
      assert.match(text, /rerun \/sterling:merge on the branch this PR was opened from/, 'names the re-arm command');
      assert.ok(text.includes(`rm ${loopPath(f)}`), 'names the exact discard command');
    }
  } finally {
    f.cleanup();
  }
});

test('--settle refuses a loop armed for ANOTHER repo than origin, even with a matching PR number', () => {
  const f = makeFixture();
  try {
    arm(f, { repo: 'github.com/other/thing', pr_url: 'https://github.com/other/thing/pull/7' });
    const before = readFileSync(loopPath(f), 'utf8');
    for (const pr of ['7', 'https://github.com/other/thing/pull/7']) {
      const r = run(f, ['--settle', 'clean', '--pr', pr]);
      assert.equal(r.code, 1, `${pr}: ${oneLine(r.stdout + r.stderr)}`);
      assert.match(r.out.error, /origin/);
    }
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('--settle refuses an incoherent state and a --pr URL for another repo', () => {
  const f = makeFixture();
  try {
    arm(f, { pr_url: 'https://github.com/acme/widget/pull/8' });
    assert.equal(run(f, ['--settle', 'clean', '--pr', '7']).code, 1, 'pr_url and pr_number disagree');
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    assert.equal(run(f, ['--settle', 'clean', '--pr', 'https://github.com/other/thing/pull/7']).code, 1);
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('--settle refuses to RE-settle: only an owed loop can be settled', () => {
  const f = makeFixture();
  try {
    arm(f);
    assert.equal(run(f, ['--settle', 'escalated', '--pr', '7']).code, 0);
    const settled = readFileSync(loopPath(f), 'utf8');
    const again = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(again.code, 1, oneLine(again.stdout + again.stderr));
    assert.match(again.out.error, /owed/);
    assert.equal(readFileSync(loopPath(f), 'utf8'), settled);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------- --head accepts a short sha
test('--head: a 7-char prefix of the PR head matches (upper case too); a short sha that is not a prefix does not', () => {
  for (const [head, status] of [[HEAD.slice(0, 7), 'review'], [HEAD.slice(0, 12).toUpperCase(), 'review'], [HEAD, 'review'], ['aaaaaab', 'timeout']]) {
    const f = makeFixture();
    try {
      f.put('reviews', 0, [[review(600)]]);
      f.put('comments', 0, [[comment(1, 600)]]);
      const r = run(f, ['7', '--head', head, ...FAST]);
      assert.equal(r.out.status, status, `${head}: ${oneLine(r.stdout)}`);
    } finally {
      f.cleanup();
    }
  }
});

test('--head: a value that is not 7-40 hex characters is an error naming the value, with no gh call', () => {
  const f = makeFixture();
  try {
    for (const bad of ['abc123', 'a'.repeat(41), 'main', 'zzzzzzz', '']) {
      const r = run(f, ['7', '--head', bad, ...FAST]);
      assert.equal(r.code, 1, `'${bad}'`);
      assert.equal(r.out?.status, 'error', oneLine(r.stdout));
      assert.ok(r.out.error.includes('--head'), r.out.error);
      assert.ok(r.out.error.includes(`'${bad}'`), `names the value: ${r.out.error}`);
    }
    assert.equal(calls(f).length, 0);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------- previously missed
const MISSED_BODY = [
  '## Pull request overview',
  'Copilot reviewed 3 out of 3 changed files and generated no comments.',
  '',
  '## Previously missed',
  '- `src/a.mjs:10` unchecked null on the parse path',
  '* second finding, wrapped',
  '  onto a continuation line',
  '1. numbered third finding',
  '',
  '## Tips',
  '- not a finding',
].join('\n');

test('previously_missed: list items under the "Previously missed" heading are parsed; a review with no inline comments flags body_findings_without_comments', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(700, { body: MISSED_BODY })]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out.status, 'review', oneLine(r.stdout));
    assert.deepEqual(r.out.comments, []);
    assert.deepEqual(r.out.previously_missed, ['`src/a.mjs:10` unchecked null on the parse path', 'second finding, wrapped onto a continuation line', 'numbered third finding']);
    assert.equal(r.out.body_findings_without_comments, true);
    assert.equal(r.out.review.body, MISSED_BODY, 'the raw body is still returned');
  } finally {
    f.cleanup();
  }
});

test('previously_missed: a bold or <summary> heading form is found, and the section ends at </details>', () => {
  const f = makeFixture();
  try {
    const body = ['Overview', '<details><summary>Previously missed (2)</summary>', '', '- one', '- two', '</details>', '- outside'].join('\n');
    f.put('reviews', 0, [[review(701, { body })]]);
    const r = run(f, ['7', ...FAST]);
    assert.deepEqual(r.out.previously_missed, ['one', 'two']);
    f.put('reviews', 0, [[review(701, { body: '**Previously missed**\n- bold one' })]]);
    assert.deepEqual(run(f, ['7', ...FAST]).out.previously_missed, ['bold one']);
  } finally {
    f.cleanup();
  }
});

test('previously_missed is [] when the section is absent; body_findings_without_comments is true for any non-empty body without comments, false with comments or an empty body', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(702, { body: 'Looks fine, a free-form note.' })]]);
    let r = run(f, ['7', ...FAST]);
    assert.deepEqual(r.out.previously_missed, []);
    assert.equal(r.out.body_findings_without_comments, true, 'format is Copilot\'s and may change: any non-empty body with no comments is flagged');
    f.put('reviews', 0, [[review(702, { body: '   ' })]]);
    r = run(f, ['7', ...FAST]);
    assert.equal(r.out.body_findings_without_comments, false, 'a blank body is not a finding');
    f.put('reviews', 0, [[review(702, { body: 'Looks fine' })]]);
    f.put('comments', 0, [[comment(1, 702)]]);
    r = run(f, ['7', ...FAST]);
    assert.equal(r.out.body_findings_without_comments, false, 'inline comments present');
  } finally {
    f.cleanup();
  }
});

// ----------------------------------------------------------- --request-copilot
const mutationCalls = (f) => calls(f).filter((a) => a.includes('graphql'));

test('--request-copilot: fires requestReviewsByLogin ONCE before polling, using the PR node id, and records success', () => {
  const f = makeFixture();
  try {
    f.put('pull', 0, [{ number: 7, node_id: 'PR_node_7', head: { sha: HEAD } }]);
    f.put('reviews', 0, [[]]);
    f.put('reviews', 1, [[review(800)]]);
    f.put('comments', 0, [[comment(1, 800)]]);
    const r = run(f, ['7', '--request-copilot', ...FAST]);
    assert.equal(r.out.status, 'review', oneLine(r.stdout));
    assert.deepEqual(r.out.copilot_request, { requested: true });
    const all = calls(f);
    const idCall = all.find((a) => a.includes('--jq'));
    assert.ok(idCall && idCall.includes('.node_id') && idCall.includes('repos/acme/widget/pulls/7'), JSON.stringify(idCall));
    assert.equal(mutationCalls(f).length, 1, 'fired exactly once');
    const q = mutationCalls(f)[0].find((a) => a.startsWith('query='));
    assert.match(q, /requestReviewsByLogin/);
    assert.ok(q.includes('pullRequestId:"PR_node_7"'), q);
    assert.ok(q.includes('botLogins:["copilot-pull-request-reviewer[bot]"]'), q);
    assert.match(q, /union:\s*true/);
    assert.ok(all.indexOf(mutationCalls(f)[0]) < all.findIndex((a) => a.some((x) => x.endsWith('/reviews'))), 'before the first reviews poll');
    assert.ok(mutationCalls(f)[0].includes('github.com'), 'names the host');
  } finally {
    f.cleanup();
  }
});

test('--request-copilot: without the flag no mutation is fired and copilot_request is null', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(801)]]);
    const r = run(f, ['7', ...FAST]);
    assert.equal(r.out.copilot_request, null);
    assert.equal(mutationCalls(f).length, 0);
    assert.equal(calls(f).filter((a) => a.includes('--jq')).length, 0);
  } finally {
    f.cleanup();
  }
});

test('--request-copilot: a failing mutation is reported loudly in the output and on stderr, and the wait still completes', () => {
  const f = makeFixture();
  try {
    f.put('pull', 0, [{ number: 7, node_id: 'PR_node_7', head: { sha: HEAD } }]);
    writeFileSync(join(f.state, 'fail_graphql'), '');
    f.put('reviews', 0, [[review(802)]]);
    const r = run(f, ['7', '--request-copilot', ...FAST]);
    assert.equal(r.out.status, 'review', 'the wait is not aborted');
    assert.equal(r.code, 0);
    assert.equal(r.out.copilot_request.requested, false);
    assert.match(r.out.copilot_request.error, /requestReviewsByLogin|Could not resolve/);
    assert.match(r.stderr, /request-copilot/);
  } finally {
    f.cleanup();
  }
});

test('--request-copilot: a missing node id (jq prints null) is a recorded failure, no mutation, wait continues; a GraphQL errors payload is a failure too', () => {
  const f = makeFixture();
  try {
    f.put('reviews', 0, [[review(803)]]);
    let r = run(f, ['7', '--request-copilot', ...FAST]);
    assert.equal(r.out.status, 'review');
    assert.equal(r.out.copilot_request.requested, false);
    assert.match(r.out.copilot_request.error, /node_id/);
    assert.equal(mutationCalls(f).length, 0);
    f.put('pull', 0, [{ number: 7, node_id: 'PR_node_7', head: { sha: HEAD } }]);
    writeFileSync(join(f.state, 'graphql.json'), JSON.stringify({ errors: [{ message: 'nope' }] }));
    r = run(f, ['7', '--request-copilot', ...FAST]);
    assert.equal(r.out.status, 'review');
    assert.equal(r.out.copilot_request.requested, false);
    assert.match(r.out.copilot_request.error, /nope/);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------- settle clean vs GitHub's merge state

const thread = (id, over = {}) => ({ id, isResolved: false, isOutdated: false, path: 'src/a.mjs', comments: { nodes: [{ databaseId: 900, url: `https://github.com/acme/widget/pull/7#discussion_r${id}` }] }, ...over });
const mergePage = (status, nodes = [], over = {}) => ({ mergeStateStatus: status, reviewDecision: null, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, ...over });
const putMerge = (f, pages) => writeFileSync(join(f.state, 'merge_pages.json'), JSON.stringify(pages));
const mergeCalls = (f) => calls(f).filter((a) => a.some((x) => x.startsWith('query=') && x.includes('reviewThreads')));

test('--settle clean with an unresolved review thread is NOT clean: status blocked, exit 1, the thread named, nothing written', () => {
  const f = makeFixture();
  try {
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    putMerge(f, [mergePage('BLOCKED', [thread('PRRT_open1'), thread('PRRT_done', { isResolved: true })])]);
    const r = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'blocked');
    assert.equal(r.out.merge_state_status, 'BLOCKED');
    assert.equal(r.out.mergeable_now, false);
    assert.deepEqual(r.out.unresolved_threads.map((t) => t.id), ['PRRT_open1']);
    assert.match(r.out.error, /NOT clean/);
    assert.match(r.out.error, /PRRT_open1/);
    assert.match(r.stderr, /PRRT_open1/, 'loud on stderr too');
    assert.equal(readFileSync(loopPath(f), 'utf8'), before, 'the loop stays owed');
  } finally {
    f.cleanup();
  }
});

test('--settle clean: CLEAN with every thread resolved settles clean and reports that a human can merge now', () => {
  const f = makeFixture();
  try {
    arm(f);
    putMerge(f, [mergePage('CLEAN', [thread('PRRT_done', { isResolved: true })], { reviewDecision: 'APPROVED' })]);
    const r = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'clean');
    assert.equal(r.out.mergeable_now, true);
    assert.equal(r.out.merge_state_status, 'CLEAN');
    assert.equal(r.out.review_decision, 'APPROVED');
    assert.equal(r.out.awaiting_human_review, false);
    assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'clean');
  } finally {
    f.cleanup();
  }
});

test('--settle clean: BLOCKED with no unresolved thread blocks unless the only thing missing is a required human review', () => {
  const f = makeFixture();
  try {
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    putMerge(f, [mergePage('BLOCKED', [], { reviewDecision: 'CHANGES_REQUESTED' })]);
    const blocked = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(blocked.code, 1, oneLine(blocked.stdout + blocked.stderr));
    assert.equal(blocked.out.status, 'blocked');
    assert.match(blocked.out.error, /BLOCKED.*CHANGES_REQUESTED/);
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);

    putMerge(f, [mergePage('BLOCKED', [], { reviewDecision: 'REVIEW_REQUIRED' })]);
    const waiting = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(waiting.code, 0, oneLine(waiting.stdout + waiting.stderr));
    assert.equal(waiting.out.status, 'clean');
    assert.equal(waiting.out.mergeable_now, false);
    assert.equal(waiting.out.awaiting_human_review, true);
  } finally {
    f.cleanup();
  }
});

for (const status of ['DIRTY', 'BEHIND', 'DRAFT', 'UNKNOWN', 'SOMETHING_NEW']) {
  test(`--settle clean refuses mergeStateStatus ${status}, naming it`, () => {
    const f = makeFixture();
    try {
      arm(f);
      putMerge(f, [mergePage(status)]);
      const r = run(f, ['--settle', 'clean', '--pr', '7']);
      assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
      assert.equal(r.out.status, 'blocked');
      assert.ok(r.out.error.includes(`mergeStateStatus is ${status}`), r.out.error);
      assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'owed');
    } finally {
      f.cleanup();
    }
  });
}

test('--settle clean reads EVERY page of review threads: an unresolved thread on page 2 still blocks', () => {
  const f = makeFixture();
  try {
    arm(f);
    putMerge(f, [
      { mergeStateStatus: 'CLEAN', reviewDecision: null, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'CUR1' }, nodes: [thread('PRRT_p1', { isResolved: true })] } },
      mergePage('CLEAN', [thread('PRRT_p2')]),
    ]);
    const r = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.deepEqual(r.out.unresolved_threads.map((t) => t.id), ['PRRT_p2']);
    assert.equal(mergeCalls(f).length, 2);
    assert.ok(mergeCalls(f)[1].some((a) => a.includes('after:"CUR1"')), 'the second page asks after the first cursor');
  } finally {
    f.cleanup();
  }
});

test('--settle clean fails loud when gh fails or GitHub returns no pull request: exit 1, loop untouched, never clean', () => {
  const f = makeFixture();
  try {
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    writeFileSync(join(f.state, 'fail_merge'), '');
    const r = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'error');
    assert.match(r.out.error, /gh api graphql failed/);
    assert.match(r.stderr, /gh api graphql failed/);
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);
    rmSync(join(f.state, 'fail_merge'));
    putMerge(f, [null]);
    const empty = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(empty.code, 1, oneLine(empty.stdout + empty.stderr));
    assert.match(empty.out.error, /no mergeStateStatus/);
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('--settle capped and escalated never ask GitHub, even when the PR is blocked', () => {
  for (const outcome of ['capped', 'escalated']) {
    const f = makeFixture();
    try {
      arm(f);
      putMerge(f, [mergePage('BLOCKED', [thread('PRRT_open1')])]);
      const r = run(f, ['--settle', outcome, '--pr', '7']);
      assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
      assert.equal(calls(f).length, 0);
    } finally {
      f.cleanup();
    }
  }
});

// ----------------------------------------------------------- --resolve-threads

const resolvedLog = (f) => (existsSync(join(f.state, 'resolved.log')) ? readFileSync(join(f.state, 'resolved.log'), 'utf8').split('\n').filter(Boolean) : []);
const resolveMutations = (f) => calls(f).filter((a) => a.some((x) => x.startsWith('query=') && x.includes('resolveReviewThread')));

test('--resolve-threads resolves the thread holding each comment id through resolveReviewThread, once per thread, skipping resolved ones', () => {
  const f = makeFixture();
  try {
    putMerge(f, [mergePage('BLOCKED', [
      thread('PRRT_a', { comments: { nodes: [{ databaseId: 101, url: 'u1' }, { databaseId: 111, url: 'u1b' }] } }),
      thread('PRRT_b', { comments: { nodes: [{ databaseId: 102, url: 'u2' }] } }),
      thread('PRRT_c', { isResolved: true, comments: { nodes: [{ databaseId: 103, url: 'u3' }] } }),
    ])]);
    const r = run(f, ['--resolve-threads', '101,111,102,103', '--pr', '7']);
    assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'resolved');
    assert.equal(r.out.pr_number, 7);
    assert.deepEqual(r.out.resolved, [{ comment_id: 101, thread_id: 'PRRT_a' }, { comment_id: 102, thread_id: 'PRRT_b' }]);
    assert.deepEqual(r.out.already_resolved, [103]);
    assert.deepEqual(r.out.same_thread_as_resolved, [{ comment_id: 111, thread_id: 'PRRT_a' }], 'a second id in a thread resolved this call is reported, not dropped');
    assert.deepEqual(resolvedLog(f), ['PRRT_a', 'PRRT_b']);
    assert.equal(resolveMutations(f).length, 2);
    assert.ok(resolveMutations(f)[0].includes('github.com'), 'names the host');
  } finally {
    f.cleanup();
  }
});

test('--resolve-threads with a comment id that is in no thread fails loud and resolves nothing', () => {
  const f = makeFixture();
  try {
    putMerge(f, [mergePage('BLOCKED', [thread('PRRT_a', { comments: { nodes: [{ databaseId: 101, url: 'u1' }] } })])]);
    const r = run(f, ['--resolve-threads', '101,777', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'error');
    assert.match(r.out.error, /777/);
    assert.match(r.stderr, /777/);
    assert.deepEqual(resolvedLog(f), []);
  } finally {
    f.cleanup();
  }
});

test('--resolve-threads fails loud when the mutation fails (gh exit) or GraphQL answers errors, naming what was already resolved', () => {
  const f = makeFixture();
  try {
    putMerge(f, [mergePage('BLOCKED', [thread('PRRT_a', { comments: { nodes: [{ databaseId: 101, url: 'u1' }] } })])]);
    writeFileSync(join(f.state, 'fail_resolve'), '');
    const failed = run(f, ['--resolve-threads', '101', '--pr', '7']);
    assert.equal(failed.code, 1, oneLine(failed.stdout + failed.stderr));
    assert.match(failed.out.error, /gh api graphql failed/);
    assert.match(failed.out.error, /already resolved this call: none/);
    rmSync(join(f.state, 'fail_resolve'));
    writeFileSync(join(f.state, 'resolve_errors'), '');
    const errs = run(f, ['--resolve-threads', '101', '--pr', '7']);
    assert.equal(errs.code, 1, oneLine(errs.stdout + errs.stderr));
    assert.match(errs.out.error, /thread cannot be resolved/);
    assert.deepEqual(resolvedLog(f), []);
  } finally {
    f.cleanup();
  }
});

test('--resolve-threads refuses malformed input before any gh call: no ids, a non-numeric id, no --pr, a PR URL of another repo', () => {
  const f = makeFixture();
  try {
    for (const args of [['--resolve-threads', '', '--pr', '7'], ['--resolve-threads', '12,abc', '--pr', '7'], ['--resolve-threads', '12'], ['--resolve-threads', '12', '--pr', 'https://github.com/other/thing/pull/7']]) {
      const r = run(f, args);
      assert.equal(r.code, 1, `${JSON.stringify(args)}: ${oneLine(r.stdout + r.stderr)}`);
      assert.equal(r.out.status, 'error');
    }
    assert.equal(calls(f).length, 0);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------ check rollup, UNKNOWN retry, partial failures

const withRollup = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] } });

for (const [rollup, grants] of [['SUCCESS', true], [null, true], ['FAILURE', false], ['PENDING', false]]) {
  test(`--settle clean: BLOCKED + REVIEW_REQUIRED + check rollup ${rollup} ${grants ? 'awaits the human review and settles clean' : 'is refused, naming the check state'}`, () => {
    const f = makeFixture();
    try {
      arm(f);
      putMerge(f, [mergePage('BLOCKED', [], { reviewDecision: 'REVIEW_REQUIRED', ...withRollup(rollup) })]);
      const r = run(f, ['--settle', 'clean', '--pr', '7']);
      if (grants) {
        assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
        assert.equal(r.out.status, 'clean');
        assert.equal(r.out.awaiting_human_review, true);
        assert.equal(r.out.mergeable_now, false);
        assert.equal(r.out.check_rollup, rollup);
        assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'clean');
      } else {
        assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
        assert.equal(r.out.status, 'blocked');
        assert.equal(r.out.awaiting_human_review, false);
        assert.equal(r.out.check_rollup, rollup);
        assert.ok(r.out.error.includes(`checks are ${rollup}`), r.out.error);
        assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'owed');
      }
    } finally {
      f.cleanup();
    }
  });
}

test('--settle clean: the merge-state query asks for the head commit statusCheckRollup', () => {
  const f = makeFixture();
  try {
    arm(f);
    run(f, ['--settle', 'clean', '--pr', '7']);
    assert.ok(mergeCalls(f)[0].some((a) => a.includes('commits(last:1)') && a.includes('statusCheckRollup { state }')));
  } finally {
    f.cleanup();
  }
});

test('--settle clean: an UNKNOWN merge state is read once more after the retry delay; CLEAN the second time settles clean', () => {
  const f = makeFixture();
  try {
    arm(f);
    putMerge(f, [mergePage('UNKNOWN'), mergePage('CLEAN')]);
    const r = run(f, ['--settle', 'clean', '--pr', '7', '--unknown-retry-delay', '0']);
    assert.equal(r.code, 0, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'clean');
    assert.equal(r.out.merge_state_status, 'CLEAN');
    assert.equal(r.out.mergeable_now, true);
    assert.equal(mergeCalls(f).length, 2, 'exactly one re-read');
  } finally {
    f.cleanup();
  }
});

test('--settle clean: still UNKNOWN after the one re-read blocks with a retry-shortly note; a bad delay is refused', () => {
  const f = makeFixture();
  try {
    arm(f);
    putMerge(f, [mergePage('UNKNOWN')]);
    const r = run(f, ['--settle', 'clean', '--pr', '7', '--unknown-retry-delay', '0']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'blocked');
    assert.match(r.out.error, /UNKNOWN.*retry shortly/);
    assert.equal(mergeCalls(f).length, 2, 'read twice, never more');
    assert.equal(JSON.parse(readFileSync(loopPath(f), 'utf8')).status, 'owed');
    const bad = run(f, ['--settle', 'clean', '--pr', '7', '--unknown-retry-delay', '-1']);
    assert.equal(bad.code, 1);
    assert.match(bad.out.error, /unknown-retry-delay/);
  } finally {
    f.cleanup();
  }
});

test('--settle clean: a GraphQL errors payload on the merge-state query fails loud, exit 1, loop untouched', () => {
  const f = makeFixture();
  try {
    arm(f);
    const before = readFileSync(loopPath(f), 'utf8');
    writeFileSync(join(f.state, 'merge_errors'), '');
    const r = run(f, ['--settle', 'clean', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'error');
    assert.match(r.out.error, /GraphQL returned errors: Could not resolve to a Repository/);
    assert.match(r.stderr, /Could not resolve to a Repository/);
    assert.equal(readFileSync(loopPath(f), 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('--resolve-threads: a failure on the second thread exits 1 naming the thread already resolved, and the first stays resolved', () => {
  const f = makeFixture();
  try {
    putMerge(f, [mergePage('BLOCKED', [
      thread('PRRT_a', { comments: { nodes: [{ databaseId: 101, url: 'u1' }] } }),
      thread('PRRT_b', { comments: { nodes: [{ databaseId: 102, url: 'u2' }] } }),
    ])]);
    writeFileSync(join(f.state, 'fail_resolve_after'), '1');
    const r = run(f, ['--resolve-threads', '101,102', '--pr', '7']);
    assert.equal(r.code, 1, oneLine(r.stdout + r.stderr));
    assert.equal(r.out.status, 'error');
    assert.match(r.out.error, /gh api graphql failed/);
    assert.match(r.out.error, /already resolved this call: PRRT_a\)/);
    assert.match(r.stderr, /already resolved this call: PRRT_a/);
    assert.deepEqual(resolvedLog(f), ['PRRT_a']);
  } finally {
    f.cleanup();
  }
});
