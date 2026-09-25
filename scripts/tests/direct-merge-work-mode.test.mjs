// DIRECT-MERGE WORK MODE (decision project-mode-hobby-work-toggle-decides-flow,
// slice S2). In a WORK project /sterling:merge runs the same pre-merge
// preflight, then pushes the feature branch and opens (or reuses) a GitHub PR.
// It never checks out, merges into or pushes the base, never sweeps branches
// and never runs post-merge repairs. Stdout is ONE JSON object
// {mode, pr_url, pr_number, branch, created}; progress goes to stderr.
// Hobby (or a missing key) is today's direct merge and never calls gh.
//
// Harness: a bare git repo as origin, and a PATH-prepended fake `gh` that
// records its argv (one JSON line per call) and answers from a state dir.
// No real GitHub call is ever made. Fixture idiom from
// direct-merge-board-nudge.test.mjs (duplicated; test files export nothing).
// Child streams are flattened with oneLine() before landing in an assertion
// message (anti-pattern foreign_ee89c3fd).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseOriginRepo } from '../lib/work-pr.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function gitMaybe(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The fake gh. It keeps PR state PER REPO and resolves the repo the way real gh
// does: --repo when given, otherwise its OWN default (github.com/other/default),
// which is never origin's repo — so a call that omits --repo lands on the wrong
// repo and the test sees it. State dir files:
//   log.jsonl         one JSON argv array per invocation (appended)
//   prs.json          [{repo, number, url, headRefName, baseRefName}] (open PRs)
//   create_fail       present => `gh pr create` exits 1 and creates nothing
//   create_fail_after present => `gh pr create` creates the PR, then exits 1
//   auth_fail         present => `gh auth status` exits 1
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.FAKE_GH_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(state, 'log.jsonl'), JSON.stringify(argv) + '\\n');
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const norm = (r) => (r && r.split('/').length === 2 ? 'github.com/' + r : r);
const repo = norm(flag('--repo')) ?? 'github.com/other/default';
const prsFile = join(state, 'prs.json');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const [a, b] = argv;
if (a === '--version') { console.log('gh version 9.9.9 (fake)'); process.exit(0); }
if (a === 'auth' && b === 'status') {
  if (existsSync(join(state, 'auth_fail'))) { console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1); }
  console.error('Logged in to github.com as fake'); process.exit(0);
}
if (a === 'repo' && b === 'view') { console.log(JSON.stringify({ nameWithOwner: 'other/default' })); process.exit(0); }
if (a === 'pr' && b === 'list') {
  const head = flag('--head');
  const base = flag('--base');
  const fields = (flag('--json') ?? 'url,number').split(',');
  const hits = prs.filter((p) => p.repo === repo && (!head || p.headRefName === head) && (!base || p.baseRefName === base));
  console.log(JSON.stringify(hits.map((p) => Object.fromEntries(fields.map((f) => [f, p[f]])))));
  process.exit(0);
}
if (a === 'pr' && b === 'create') {
  if (existsSync(join(state, 'create_fail'))) { console.error('GraphQL: something went wrong (createPullRequest)'); process.exit(1); }
  const number = 7 + prs.length;
  const url = 'https://' + repo + '/pull/' + number;
  prs.push({ repo, number, url, headRefName: flag('--head'), baseRefName: flag('--base') });
  writeFileSync(prsFile, JSON.stringify(prs));
  if (existsSync(join(state, 'create_fail_after'))) { console.error('HTTP 502: gateway timeout (the PR was created anyway)'); process.exit(1); }
  console.log(url); process.exit(0);
}
console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3);
`;

const ORIGIN_URL = 'https://github.com/acme/widget.git';
const ORIGIN_REPO = 'github.com/acme/widget';

function seedPr(p, { number, head = p.branchName, base = 'main', repo = ORIGIN_REPO }) {
  const f = join(p.gh.state, 'prs.json');
  const prs = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  prs.push({ repo, number, url: `https://${repo}/pull/${number}`, headRefName: head, baseRefName: base });
  writeFileSync(f, JSON.stringify(prs));
}

function makeFakeGh(base) {
  const bin = join(base, 'fakebin');
  const state = join(base, 'ghstate');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const impl = join(base, 'fake-gh.mjs');
  writeFileSync(impl, FAKE_GH_IMPL);
  const shim = join(bin, 'gh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { bin, state };
}

function ghCalls(state) {
  const f = join(state, 'log.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A project with a bare origin holding main, a feature branch checked out
 * with `commits` commits, and (unless mode is undefined) .sterling/config.json. */
function makeProject({ mode, commits = [{ subject: 'feat: widget sprockets', body: 'Adds sprockets to the widget.' }], branchName = 'feat/sprockets', checkScript } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-dm-work-'));
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  mkdirSync(dir);
  git(base, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  // A package.json `check` script is the gate's battery (npm run check); a
  // test uses it as the hook point that runs AFTER the preflight snapshot.
  if (checkScript) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { check: checkScript } }));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  // origin's identity is a GitHub URL; pushes are redirected to the local bare
  // repo with pushInsteadOf, so no network is touched.
  git(dir, ['remote', 'add', 'origin', ORIGIN_URL]);
  git(dir, ['config', `url.${origin}.pushInsteadOf`, ORIGIN_URL]);
  git(dir, ['push', 'origin', 'main']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (mode !== undefined) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  git(dir, ['checkout', '-b', branchName]);
  commits.forEach((c, i) => {
    writeFileSync(join(dir, 'src', `f${i}.mjs`), `export const f${i} = ${i};\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', c.subject, ...(c.body ? ['-m', c.body] : [])]);
  });
  const gh = makeFakeGh(base);
  return {
    base,
    dir,
    origin,
    branchName,
    gh,
    mainSha: git(dir, ['rev-parse', 'main']),
    originMainSha: git(origin, ['rev-parse', 'main']),
    branchSha: git(dir, ['rev-parse', 'HEAD']),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function runDirectMerge(p, extra = [], { path } = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', p.dir, ...extra], {
    encoding: 'utf8',
    cwd: p.dir,
    timeout: 60_000,
    env: { ...process.env, PATH: path ?? `${p.gh.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.gh.state, GIT_TERMINAL_PROMPT: '0' },
  });
}

function assertBaseUntouched(p, label) {
  assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, `${label}: local main must not move`);
  assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, `${label}: origin main must not move`);
  assert.equal(git(p.dir, ['branch', '--show-current']), p.branchName, `${label}: the feature branch stays checked out (no checkout of main)`);
  assert.ok(gitMaybe(p.dir, ['rev-parse', '--verify', `refs/heads/${p.branchName}`]), `${label}: the feature branch is never deleted or swept`);
}

function parseSingleJson(stdout, label) {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(stdout);
  }, `${label}: stdout must be exactly one JSON object, got: ${oneLine(stdout)}`);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed && !Array.isArray(parsed));
  return parsed;
}

test('work: a merge pushes the branch and CREATES the PR with an explicit repo/head/base; title and body come from the branch commits; local AND origin main are unchanged; stdout is one JSON object', () => {
  const p = makeProject({
    mode: 'work',
    commits: [
      { subject: 'test: pin sprocket count', body: 'Red first.' },
      { subject: 'feat: widget sprockets', body: 'Adds sprockets to the widget.' },
    ],
  });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = parseSingleJson(r.stdout, 'work create');
    assert.deepEqual(out, { mode: 'work', ok: true, stage: 'done', error: null, exit: 0, pushed: true, pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, branch: p.branchName, created: true });

    assertBaseUntouched(p, 'work create');
    assert.equal(git(p.origin, ['rev-parse', p.branchName]), p.branchSha, 'the feature branch is pushed to origin at its tip');
    assert.equal(git(p.dir, ['rev-parse', '--abbrev-ref', `${p.branchName}@{upstream}`]), `origin/${p.branchName}`, 'push sets the upstream (-u)');

    const creates = ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'create');
    assert.equal(creates.length, 1, 'exactly one gh pr create');
    const c = creates[0];
    const flag = (name) => c[c.indexOf(name) + 1];
    assert.equal(flag('--repo'), ORIGIN_REPO);
    assert.equal(flag('--head'), p.branchName);
    assert.equal(flag('--base'), 'main');
    assert.equal(flag('--title'), p.branchName, 'several commits: the title is the branch name (gh --fill semantics)');
    const body = flag('--body');
    for (const piece of ['test: pin sprocket count', 'Red first.', 'feat: widget sprockets', 'Adds sprockets to the widget.']) {
      assert.ok(body.includes(piece), `the body carries every commit subject and body — missing ${piece}`);
    }
    assert.ok(body.indexOf('test: pin sprocket count') < body.indexOf('feat: widget sprockets'), 'commits listed oldest first');
    assert.ok(body.trimEnd().endsWith(ATTRIBUTION), 'the body ends with the PR attribution line');
  } finally {
    p.cleanup();
  }
});

test('work: an existing open PR for the head is REUSED — the branch is pushed, no second gh pr create', () => {
  const p = makeProject({ mode: 'work' });
  try {
    seedPr(p, { number: 41 });
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `reuse must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = parseSingleJson(r.stdout, 'work reuse');
    assert.deepEqual(out, { mode: 'work', ok: true, stage: 'done', error: null, exit: 0, pushed: true, pr_url: 'https://github.com/acme/widget/pull/41', pr_number: 41, branch: p.branchName, created: false });
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'create').length, 0, 'no gh pr create when a PR is open');
    const list = ghCalls(p.gh.state).find((c) => c[0] === 'pr' && c[1] === 'list');
    assert.ok(list, 'the open PR is looked up with gh pr list');
    assert.equal(list[list.indexOf('--head') + 1], p.branchName);
    assert.equal(list[list.indexOf('--state') + 1], 'open');
    assert.equal(git(p.origin, ['rev-parse', p.branchName]), p.branchSha, 'the branch is still pushed');
    assertBaseUntouched(p, 'work reuse');
  } finally {
    p.cleanup();
  }
});

test('work: pushed but gh pr create FAILED exits 1 naming what succeeded; the rerun detects the pushed branch and creates the PR', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_fail'), '');
    const r1 = runDirectMerge(p);
    assert.equal(r1.status, 1, `a failed PR create exits 1 — stdout=${oneLine(r1.stdout)} stderr=${oneLine(r1.stderr)}`);
    assert.match(r1.stderr, /PUSHED/, 'stderr names that the push succeeded');
    assert.match(r1.stderr, /rerun/i, 'stderr says a rerun is the remedy');
    assert.match(r1.stderr, /UNKNOWN/, 'after a failed create with no PR found, the PR state is reported UNKNOWN — never asserted absent');
    assert.doesNotMatch(r1.stderr, /no PR exists/i, 'the gate never claims no PR exists');
    assert.equal(git(p.origin, ['rev-parse', p.branchName]), p.branchSha, 'the branch reached origin before the create failed');
    const out1 = parseSingleJson(r1.stdout, 'partial');
    assert.equal(out1.mode, 'work');
    assert.equal(out1.created, false);
    assert.equal(out1.pr_url, null);
    assert.equal(out1.pr_number, null);
    assert.equal(out1.pushed, true);
    assertBaseUntouched(p, 'partial');

    rmSync(join(p.gh.state, 'create_fail'));
    const r2 = runDirectMerge(p);
    assert.equal(r2.status, 0, `the rerun must succeed — stdout=${oneLine(r2.stdout)} stderr=${oneLine(r2.stderr)}`);
    const out2 = parseSingleJson(r2.stdout, 'rerun');
    assert.deepEqual(out2, { mode: 'work', ok: true, stage: 'done', error: null, exit: 0, pushed: true, pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, branch: p.branchName, created: true });
    const creates = ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'create');
    assert.equal(creates.length, 2, 'one failed create, one successful create on the rerun');
    const c = creates[1];
    assert.equal(c[c.indexOf('--title') + 1], 'feat: widget sprockets', 'one commit: the title is its subject');
    assert.ok(c[c.indexOf('--body') + 1].includes('Adds sprockets to the widget.'), 'one commit: the body carries its body');
    assertBaseUntouched(p, 'rerun');
  } finally {
    p.cleanup();
  }
});

test('work: with several remotes and a conflicting gh default repo, EVERY gh call names origin\'s repo (host/owner/repo from the origin URL) and the PR lands there', () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['remote', 'add', 'upstream', 'git@github.com:other/fork.git']);
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pr_url, 'https://github.com/acme/widget/pull/7', 'the PR is opened in origin\'s repo, never gh\'s default');
    const calls = ghCalls(p.gh.state);
    const repoCalls = calls.filter((c) => c[0] === 'pr' || c[0] === 'repo');
    assert.ok(repoCalls.length >= 2, 'at least a lookup and a create');
    for (const c of repoCalls) {
      assert.equal(c[c.indexOf('--repo') + 1], ORIGIN_REPO, `every repo-scoped gh call passes --repo ${ORIGIN_REPO}: ${JSON.stringify(c)}`);
    }
    const auth = calls.find((c) => c[0] === 'auth');
    assert.ok(auth && auth[auth.indexOf('--hostname') + 1] === 'github.com', 'auth is checked for origin\'s host');
  } finally {
    p.cleanup();
  }
});

test('work: an origin that is not a GitHub-shaped URL (a local path) is refused with exit 2, nothing pushed', () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['remote', 'set-url', 'origin', p.origin]);
    const r = runDirectMerge(p);
    assert.equal(r.status, 2, `a non-GitHub origin exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /origin/);
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr').length, 0, 'no pr call');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
  } finally {
    p.cleanup();
  }
});

test('work: an open PR from the same head into ANOTHER base is not reused — a new PR is created against the requested base', () => {
  const p = makeProject({ mode: 'work' });
  try {
    seedPr(p, { number: 30, base: 'release' });
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.created, true, 'the release PR is not reused for a merge into main');
    assert.notEqual(out.pr_number, 30);
    const creates = ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0][creates[0].indexOf('--base') + 1], 'main');
    for (const l of ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'list')) {
      assert.equal(l[l.indexOf('--base') + 1], 'main', 'the lookup filters by base');
      assert.match(l[l.indexOf('--json') + 1], /headRefName/);
      assert.match(l[l.indexOf('--json') + 1], /baseRefName/);
    }
  } finally {
    p.cleanup();
  }
});

test('work: MORE THAN ONE open PR for the same repo/head/base fails closed with exit 1 — nothing pushed, nothing created', () => {
  const p = makeProject({ mode: 'work' });
  try {
    seedPr(p, { number: 31 });
    seedPr(p, { number: 32 });
    const r = runDirectMerge(p);
    assert.equal(r.status, 1, `ambiguous PRs exit 1 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /#31/);
    assert.match(r.stderr, /#32/);
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'create').length, 0, 'no create');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
    assertBaseUntouched(p, 'ambiguous');
  } finally {
    p.cleanup();
  }
});

test('work: the push is PINNED to the preflight SHA — a commit that lands on the branch during the battery never ships', () => {
  const p = makeProject({ mode: 'work', checkScript: "git commit --allow-empty -q -m 'sneaky: never gated'" });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.notEqual(git(p.dir, ['rev-parse', p.branchName]), p.branchSha, 'the battery really did move the branch (the hook point fired)');
    assert.equal(git(p.origin, ['rev-parse', p.branchName]), p.branchSha, 'origin holds the pinned, gated SHA — not the moved branch tip');
    assert.equal(git(p.dir, ['config', `branch.${p.branchName}.remote`]), 'origin', 'the upstream remote is set');
    assert.equal(git(p.dir, ['config', `branch.${p.branchName}.merge`]), `refs/heads/${p.branchName}`, 'the upstream branch is set');
    const create = ghCalls(p.gh.state).find((c) => c[0] === 'pr' && c[1] === 'create');
    assert.ok(!create.join(' ').includes('sneaky'), 'the PR text comes from the pinned range too');
  } finally {
    p.cleanup();
  }
});

test('work: --branch naming something that is not a local branch (a tag) is refused with exit 2 before the battery; nothing pushed', () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['tag', 'v1']);
    const r = runDirectMerge(p, ['--branch', 'v1']);
    assert.equal(r.status, 2, `a non-branch --branch exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /v1/);
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr').length, 0, 'no pr call');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', 'refs/heads/v1']), null, 'nothing pushed');
  } finally {
    p.cleanup();
  }
});

/** Every work-mode exit prints ONE JSON object: {mode:'work', ok:false,
 * stage, error, exit, pushed, pr_url, …}, with exit equal to the process's. */
function assertWorkFailureJson(r, label) {
  let out;
  assert.doesNotThrow(() => {
    out = JSON.parse(r.stdout);
  }, `${label}: stdout must be exactly one JSON object, got: ${oneLine(r.stdout)} (stderr=${oneLine(r.stderr)})`);
  assert.equal(out.mode, 'work', label);
  assert.equal(out.ok, false, label);
  assert.equal(typeof out.stage, 'string', `${label}: stage`);
  assert.ok(out.stage.length > 0, `${label}: stage`);
  assert.equal(typeof out.error, 'string', `${label}: error`);
  assert.ok(out.error.length > 0, `${label}: error`);
  assert.equal(out.exit, r.status, `${label}: exit mirrors the process exit code`);
  assert.equal(typeof out.pushed, 'boolean', `${label}: pushed`);
  assert.ok('pr_url' in out, `${label}: pr_url`);
  return out;
}

const WORK_REFUSALS = [
  ['--no-push', 2, (p) => ({ extra: ['--no-push'] })],
  ['gh unauthenticated', 2, (p) => (writeFileSync(join(p.gh.state, 'auth_fail'), ''), {})],
  ['non-GitHub origin', 2, (p) => (git(p.dir, ['remote', 'set-url', 'origin', p.origin]), {})],
  ['--branch is a tag', 2, (p) => (git(p.dir, ['tag', 'v1']), { extra: ['--branch', 'v1'] })],
  ['not a git repository', 1, (p) => (rmSync(join(p.dir, '.git'), { recursive: true, force: true }), {})],
  ['no Sterling store (openProject refuses)', 1, (p) => (rmSync(join(p.dir, '.sterling', 'sterling.db')), {})],
  ['on the base branch', 1, (p) => (git(p.dir, ['checkout', '-q', 'main']), {})],
  ['dirty tree', 1, (p) => (writeFileSync(join(p.dir, 'src', 'f0.mjs'), 'dirty\n'), {})],
  ['battery fails', 1, null],
  ['ambiguous open PRs', 1, (p) => (seedPr(p, { number: 31 }), seedPr(p, { number: 32 }), {})],
  ['pushed but PR create failed', 1, (p) => (writeFileSync(join(p.gh.state, 'create_fail'), ''), {})],
];

const EXPECTED_STAGE = {
  '--no-push': 'work-preflight',
  'gh unauthenticated': 'work-preflight',
  'non-GitHub origin': 'work-preflight',
  '--branch is a tag': 'branch',
  'not a git repository': 'git-repo',
  'no Sterling store (openProject refuses)': 'open-project',
  'on the base branch': 'branch',
  'dirty tree': 'dirty-tree',
  'battery fails': 'battery',
  'ambiguous open PRs': 'pr-lookup',
  'pushed but PR create failed': 'pr-create',
};

for (const [label, code, arrange] of WORK_REFUSALS) {
  test(`work stdout contract: '${label}' exits ${code} with ONE JSON object {mode, ok:false, stage, error, exit, pushed, pr_url} on stdout`, () => {
    const p = arrange ? makeProject({ mode: 'work' }) : makeProject({ mode: 'work', checkScript: 'echo battery-broke >&2; exit 3' });
    try {
      const { extra = [] } = arrange ? arrange(p) : {};
      const r = runDirectMerge(p, extra);
      assert.equal(r.status, code, `${label}: exit — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      const out = assertWorkFailureJson(r, label);
      assert.equal(out.stage, EXPECTED_STAGE[label], `${label}: the stage names where it stopped`);
    } finally {
      p.cleanup();
    }
  });
}

test('work stdout contract: gh ABSENT also prints one JSON object', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const onlyGit = join(p.base, 'onlygit');
    mkdirSync(onlyGit);
    for (const tool of ['git', 'sh']) symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), join(onlyGit, tool));
    const r = runDirectMerge(p, [], { path: onlyGit });
    assert.equal(r.status, 2);
    assert.equal(assertWorkFailureJson(r, 'gh absent').stage, 'work-preflight');
  } finally {
    p.cleanup();
  }
});

test('work stdout contract: success carries ok:true, stage done, error null, exit 0', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, oneLine(r.stderr));
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.stage, 'done');
    assert.equal(out.error, null);
    assert.equal(out.exit, 0);
    assert.equal(out.pushed, true);
  } finally {
    p.cleanup();
  }
});

test('work: gh pr create FAILS but the PR exists afterwards (a create race or a timeout) — the strict follow-up lookup finds it and reports it REUSED with exit 0', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_fail_after'), '');
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `exit 0 when the PR turns out to exist — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.created, false, 'reported as reused, not as created by this run');
    assert.equal(out.pr_url, 'https://github.com/acme/widget/pull/7');
    assert.equal(out.pr_number, 7);
    const lists = ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'list');
    assert.equal(lists.length, 2, 'one lookup before the create, one strict lookup after it failed');
    const after = lists[1];
    assert.equal(after[after.indexOf('--repo') + 1], ORIGIN_REPO);
    assert.equal(after[after.indexOf('--head') + 1], p.branchName);
    assert.equal(after[after.indexOf('--base') + 1], 'main');
  } finally {
    p.cleanup();
  }
});

test('parseOriginRepo: https, ssh:// and scp-style origin URLs give host/owner/repo; anything else is null', () => {
  const ok = {
    'https://github.com/acme/widget.git': 'github.com/acme/widget',
    'https://github.com/acme/widget': 'github.com/acme/widget',
    'https://user@ghe.corp.example/acme/widget.git/': 'ghe.corp.example/acme/widget',
    'ssh://git@github.com/acme/widget.git': 'github.com/acme/widget',
    'ssh://git@github.com:22/acme/widget.git': 'github.com/acme/widget',
    'git@github.com:acme/widget.git': 'github.com/acme/widget',
    'github.com:acme/my.repo': 'github.com/acme/my.repo',
  };
  for (const [url, repo] of Object.entries(ok)) assert.equal(parseOriginRepo(url)?.repo, repo, url);
  for (const bad of ['/tmp/origin.git', 'file:///tmp/origin.git', 'https://github.com/acme', 'https://github.com/a/b/c', 'git@github.com:acme/..', '', 'C:\\repos\\x.git']) {
    assert.equal(parseOriginRepo(bad), null, bad);
  }
});

test('an INVALID mode is refused with exit 2 before anything runs: no gh call, no push, nothing merged', () => {
  const p = makeProject({ mode: 'office' });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 2, `invalid mode exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /office/, 'the refusal names the bad value');
    // BOUNDARY: an invalid mode means the mode is unknown, so this exit keeps
    // today's behaviour (stderr only) — no work-mode JSON is promised.
    assert.equal(r.stdout, '', 'nothing on stdout');
    assert.deepEqual(ghCalls(p.gh.state), [], 'gh is never called');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
    assertBaseUntouched(p, 'invalid mode');
  } finally {
    p.cleanup();
  }
});

test('work: --no-push is refused with exit 2 and an explanation (a PR needs a pushed branch)', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const r = runDirectMerge(p, ['--no-push']);
    assert.equal(r.status, 2, `--no-push in work mode exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /--no-push/);
    assert.match(r.stderr, /pushed branch/i);
    assert.deepEqual(ghCalls(p.gh.state), [], 'gh is never called');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
    assertBaseUntouched(p, 'no-push');
  } finally {
    p.cleanup();
  }
});

test('work: gh ABSENT from PATH is refused with exit 2 naming gh auth login; nothing pushed', () => {
  const p = makeProject({ mode: 'work' });
  try {
    // A PATH holding only git and sh, so a gh installed on the machine cannot leak in.
    const onlyGit = join(p.base, 'onlygit');
    mkdirSync(onlyGit);
    for (const tool of ['git', 'sh']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      assert.ok(real, `${tool} must be resolvable to build the restricted PATH`);
      symlinkSync(real, join(onlyGit, tool));
    }
    const r = runDirectMerge(p, [], { path: onlyGit });
    assert.equal(r.status, 2, `gh absent exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /gh auth login/);
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
    assertBaseUntouched(p, 'gh absent');
  } finally {
    p.cleanup();
  }
});

test('work: gh present but UNAUTHENTICATED is refused with exit 2 naming gh auth login; no PR call, nothing pushed', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'auth_fail'), '');
    const r = runDirectMerge(p);
    assert.equal(r.status, 2, `unauthenticated gh exits 2 — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /gh auth login/);
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr').length, 0, 'no pr call');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch is not pushed');
    assertBaseUntouched(p, 'gh unauthenticated');
  } finally {
    p.cleanup();
  }
});

for (const mode of [undefined, 'hobby']) {
  const label = mode === undefined ? 'a MISSING mode key' : "mode 'hobby'";
  test(`hobby (${label}): today's direct merge — merges into main, pushes main, sweeps the branch — and NEVER calls gh even with gh on PATH`, () => {
    const p = makeProject({ mode });
    try {
      const r = runDirectMerge(p);
      assert.equal(r.status, 0, `hobby merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      const out = parseSingleJson(r.stdout, 'hobby');
      assert.equal(out.mode, undefined, 'the hobby report shape is unchanged (no mode key)');
      assert.equal(out.pushed, true, 'hobby pushes the base as today');
      assert.deepEqual(ghCalls(p.gh.state), [], 'hobby never calls gh');
      assert.notEqual(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'hobby merges into main');
      assert.equal(git(p.origin, ['rev-parse', 'main']), git(p.dir, ['rev-parse', 'main']), 'hobby pushes main to origin');
      assert.equal(gitMaybe(p.dir, ['rev-parse', '--verify', `refs/heads/${p.branchName}`]), null, 'hobby deletes the merged branch');
    } finally {
      p.cleanup();
    }
  });
}
