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
import { evaluatePrLoop } from '../hooks/lib/pr-loop-duty.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function git(cwd, args, env = process.env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env });
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
//   create_fail       present => the create call exits 1 and creates nothing
//   create_fail_after present => the create call creates the PR, then exits 1
//   create_nonpr      present => the create call exits 0 printing JSON that is not a PR, and creates nothing
//   create_nonpr_after present => the same answer, but the PR was created
// The PR is created through the REST call `gh api --hostname <host> --method
// POST repos/<owner>/<repo>/pulls -f head=… -f base=… -f title=… -f body=…`
// (real `gh pr create` needs a local git binary gh can run, which Windows gh.exe
// on WSL lacks). `gh pr create` is never legitimate: the fake exits 4 on it and
// the tests assert it was never called.
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
if (a === 'pr' && b === 'create') { console.error('fake gh: gh pr create must never be called (work mode creates the PR through gh api)'); process.exit(4); }
if (a === 'api') {
  const m = (argv.find((x) => /^repos\\//.test(x)) ?? '').match(/^repos\\/([^/]+)\\/([^/]+)\\/pulls$/);
  const host = flag('--hostname');
  if (!m || !host || flag('--method') !== 'POST') { console.error('fake gh: unhandled api call ' + JSON.stringify(argv)); process.exit(3); }
  const fields = {};
  argv.forEach((x, i) => { if (x === '-f' || x === '-F') { const kv = argv[i + 1]; const k = kv.indexOf('='); fields[kv.slice(0, k)] = kv.slice(k + 1); } });
  if (existsSync(join(state, 'create_fail'))) { console.error('gh: Validation Failed (HTTP 422)'); console.log(JSON.stringify({ message: 'Validation Failed' })); process.exit(1); }
  const apiRepo = host + '/' + m[1] + '/' + m[2];
  if (existsSync(join(state, 'create_nonpr'))) { console.log(JSON.stringify({ message: 'accepted' })); process.exit(0); }
  const number = 7 + prs.length;
  const url = 'https://' + apiRepo + '/pull/' + number;
  prs.push({ repo: apiRepo, number, url, headRefName: fields.head, baseRefName: fields.base });
  writeFileSync(prsFile, JSON.stringify(prs));
  if (existsSync(join(state, 'create_nonpr_after'))) { console.log(JSON.stringify({ message: 'accepted' })); process.exit(0); }
  if (existsSync(join(state, 'create_fail_after'))) { console.error('gh: HTTP 502: gateway timeout (the PR was created anyway)'); process.exit(1); }
  console.log(JSON.stringify({ number, html_url: url, url: 'https://api.' + host + '/repos/' + m[1] + '/' + m[2] + '/pulls/' + number, head: { ref: fields.head }, base: { ref: fields.base } })); process.exit(0);
}
console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3);
`;

// ORIGIN is a real GitHub-shaped ssh URL, used unchanged for fetch AND push
// (no pushurl, no insteadOf/pushInsteadOf), so `git remote get-url origin` and
// `git remote get-url --push --all origin` both normalize to ORIGIN_REPO — the
// exact setup the push-destination rule accepts. The bytes still land locally:
// GIT_SSH_COMMAND points at a fake ssh that ignores the host and serves the
// repo path from FAKE_SSH_ROOT (<root>/<owner>/<repo>.git), so no network is
// touched and a push to ANOTHER GitHub repo lands in another local bare repo.
// (A pushInsteadOf or insteadOf rewrite to a local path cannot be used any
// more: git applies it to the push URLs the rule reads, which then no longer
// name a GitHub repo.)
const ORIGIN_URL = 'ssh://git@github.com/acme/widget.git';
const FAKE_SSH_IMPL = `
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '-G') process.exit(0);
const m = args[args.length - 1].match(/^git-(upload-pack|receive-pack|upload-archive) '(.+)'$/);
if (!m) { console.error('fake ssh: unexpected command ' + JSON.stringify(args)); process.exit(128); }
const repoPath = join(process.env.FAKE_SSH_ROOT, m[2].replace(/^\\/+/, ''));
const r = spawnSync('git', [m[1], repoPath], { stdio: 'inherit' });
process.exit(r.status ?? 128);
`;

function sshEnv(base) {
  const impl = join(base, 'fake-ssh.mjs');
  writeFileSync(impl, FAKE_SSH_IMPL);
  return { GIT_SSH_COMMAND: `"${process.execPath}" "${impl}"`, GIT_SSH_VARIANT: 'ssh', FAKE_SSH_ROOT: join(base, 'remotes') };
}
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

/** The PR-create calls: `gh api … repos/<owner>/<repo>/pulls` with method POST,
 * each as { argv, host, path, method, fields } (fields from the -f/-F pairs). */
function createCalls(state) {
  return ghCalls(state)
    .filter((c) => c[0] === 'api' && c.some((x) => /^repos\/[^/]+\/[^/]+\/pulls$/.test(x)))
    .map((argv) => {
      const fields = {};
      argv.forEach((x, i) => {
        if (x === '-f' || x === '-F') {
          const kv = argv[i + 1];
          fields[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
        }
      });
      return { argv, host: argv[argv.indexOf('--hostname') + 1], path: argv.find((x) => /^repos\//.test(x)), method: argv[argv.indexOf('--method') + 1], fields };
    });
}

const noPrCreateEver = (state) => assert.equal(ghCalls(state).filter((c) => c[0] === 'pr' && c[1] === 'create').length, 0, '`gh pr create` is never called');

/** A project with a bare origin holding main, a feature branch checked out
 * with `commits` commits, and (unless mode is undefined) .sterling/config.json. */
function makeProject({ mode, handoff, commits = [{ subject: 'feat: widget sprockets', body: 'Adds sprockets to the widget.' }], branchName = 'feat/sprockets', checkScript } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-dm-work-'));
  const dir = join(base, 'repo');
  const ssh = sshEnv(base);
  const origin = join(ssh.FAKE_SSH_ROOT, 'acme', 'widget.git');
  const env = { ...process.env, ...ssh };
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
  git(dir, ['remote', 'add', 'origin', ORIGIN_URL]);
  git(dir, ['push', 'origin', 'main'], env);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (mode !== undefined) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode, ...(handoff === undefined ? {} : { handoff: { enabled: handoff } }) }));
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
    ssh,
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
    env: { ...process.env, ...p.ssh, PATH: path ?? `${p.gh.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.gh.state, GIT_TERMINAL_PROMPT: '0' },
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

    noPrCreateEver(p.gh.state);
    const creates = createCalls(p.gh.state);
    assert.equal(creates.length, 1, 'exactly one PR-create call (gh api POST .../pulls)');
    const c = creates[0];
    assert.equal(c.host, 'github.com', 'the create names origin\'s host');
    assert.equal(c.path, 'repos/acme/widget/pulls', 'the create names origin\'s owner/repo');
    assert.equal(c.method, 'POST');
    assert.ok(!c.argv.includes('-F'), 'fields are sent with -f (raw strings), never -F (which reads @file values)');
    assert.equal(c.argv.filter((x) => x === '-f').length, 4, 'head, base, title and body are each a -f field');
    assert.equal(c.fields.head, p.branchName);
    assert.equal(c.fields.base, 'main');
    assert.equal(c.fields.title, p.branchName, 'several commits: the title is the branch name (gh --fill semantics)');
    const body = c.fields.body;
    for (const piece of ['test: pin sprocket count', 'Red first.', 'feat: widget sprockets', 'Adds sprockets to the widget.']) {
      assert.ok(body.includes(piece), `the body carries every commit subject and body — missing ${piece}`);
    }
    assert.ok(body.indexOf('test: pin sprocket count') < body.indexOf('feat: widget sprockets'), 'commits listed oldest first');
    assert.ok(body.trimEnd().endsWith(ATTRIBUTION), 'the body ends with the PR attribution line');
  } finally {
    p.cleanup();
  }
});

test('work: a title and body starting with @ reach the create call literally (-f raw fields, never -F @file)', () => {
  const p = makeProject({ mode: 'work', commits: [{ subject: '@team fix sprockets', body: '@reviewer please look at the sprockets.' }] });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const creates = createCalls(p.gh.state);
    assert.equal(creates.length, 1);
    const [c] = creates;
    assert.ok(!c.argv.includes('-F'), 'no -F field in the create call');
    assert.equal(c.argv.filter((x) => x === '-f').length, 4, 'head, base, title and body are each a -f field');
    assert.equal(c.fields.title, '@team fix sprockets', 'a title starting with @ is sent literally');
    assert.ok(c.fields.body.startsWith('@reviewer please look at the sprockets.'), 'a body starting with @ is sent literally');
    noPrCreateEver(p.gh.state);
  } finally {
    p.cleanup();
  }
});

test('work: an existing open PR for the head is REUSED — the branch is pushed, no second create', () => {
  const p = makeProject({ mode: 'work' });
  try {
    seedPr(p, { number: 41 });
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `reuse must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = parseSingleJson(r.stdout, 'work reuse');
    assert.deepEqual(out, { mode: 'work', ok: true, stage: 'done', error: null, exit: 0, pushed: true, pr_url: 'https://github.com/acme/widget/pull/41', pr_number: 41, branch: p.branchName, created: false });
    assert.equal(createCalls(p.gh.state).length, 0, 'no create call when a PR is open');
    noPrCreateEver(p.gh.state);
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

test('work: pushed but the PR create FAILED exits 1 naming what succeeded; the rerun detects the pushed branch and creates the PR', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_fail'), '');
    const r1 = runDirectMerge(p);
    assert.equal(r1.status, 1, `a failed PR create exits 1 — stdout=${oneLine(r1.stdout)} stderr=${oneLine(r1.stderr)}`);
    assert.match(r1.stderr, /PUSHED/, 'stderr names that the push succeeded');
    assert.match(r1.stderr, /rerun/i, 'stderr says a rerun is the remedy');
    assert.match(r1.stderr, /UNKNOWN/, 'after a failed create with no PR found, the PR state is reported UNKNOWN — never asserted absent');
    assert.doesNotMatch(r1.stderr, /no PR exists/i, 'the gate never claims no PR exists');
    assert.match(r1.stderr, /Validation Failed/, 'gh\'s own stderr is printed, not swallowed');
    assert.match(r1.stderr, /by hand.*reuses it and arms the review loop/s, 'the message says a hand-opened PR is reused by the rerun, which arms the review loop');
    assert.ok(r1.stderr.includes(`https://${ORIGIN_REPO}/compare/main...${p.branchName}?expand=1`), `the message names the exact by-hand create URL — ${oneLine(r1.stderr)}`);
    assert.ok(r1.stderr.includes(`rerun /sterling:merge on ${p.branchName}`), 'the message names the exact rerun');
    assert.ok(r1.stderr.includes(p.gh.bin), 'a non-zero gh exit prints the path of the gh that ran');
    assert.match(r1.stderr, /WSL.*Windows gh\.exe/s, 'a non-zero gh exit says a Windows gh.exe on WSL is a known cause');
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
    noPrCreateEver(p.gh.state);
    const creates = createCalls(p.gh.state);
    assert.equal(creates.length, 2, 'one failed create, one successful create on the rerun');
    const c = creates[1];
    assert.equal(c.fields.title, 'feat: widget sprockets', 'one commit: the title is its subject');
    assert.ok(c.fields.body.includes('Adds sprockets to the widget.'), 'one commit: the body carries its body');
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
    const creates = createCalls(p.gh.state);
    assert.ok(repoCalls.length + creates.length >= 2, 'at least a lookup and a create');
    for (const c of repoCalls) {
      assert.equal(c[c.indexOf('--repo') + 1], ORIGIN_REPO, `every repo-scoped gh call passes --repo ${ORIGIN_REPO}: ${JSON.stringify(c)}`);
    }
    for (const c of creates) {
      assert.equal(`${c.host}/${c.path.replace(/^repos\//, '').replace(/\/pulls$/, '')}`, ORIGIN_REPO, `the create names origin's host and owner/repo: ${JSON.stringify(c.argv)}`);
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
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, 'no pr or api call');
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
    const creates = createCalls(p.gh.state);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].fields.base, 'main');
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
    assert.equal(createCalls(p.gh.state).length, 0, 'no create');
    noPrCreateEver(p.gh.state);
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
    const create = createCalls(p.gh.state)[0];
    assert.ok(create, 'the PR was created');
    assert.ok(!create.argv.join(' ').includes('sneaky'), 'the PR text comes from the pinned range too');
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
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, 'no pr or api call');
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', 'refs/heads/v1']), null, 'nothing pushed');
  } finally {
    p.cleanup();
  }
});

// Decision merge-keeps-battery-and-version-refusals (audit finding A2): the
// battery runs in the CHECKED-OUT tree, so a --branch naming any other branch
// would validate one tree and merge or push another. Refused in both modes,
// before the battery and before anything moves.
for (const mode of ['hobby', 'work']) {
  test(`${mode}: --branch naming a branch other than the checked-out one is refused with exit 2 before the battery; nothing merged or pushed`, () => {
    const p = makeProject({ mode, checkScript: 'echo BATTERY-RAN >&2; exit 0' });
    try {
      git(p.dir, ['branch', 'feat/other', 'main']);
      const r = runDirectMerge(p, ['--branch', 'feat/other']);
      assert.equal(r.status, 2, `a foreign --branch exits 2 — stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, /feat\/other/, 'the refusal names the requested branch');
      assert.match(r.stderr, /feat\/sprockets/, 'the refusal names the checked-out branch');
      assert.match(r.stderr, /checked-out tree/, 'the refusal says why: the battery validates the checked-out tree');
      assert.doesNotMatch(r.stderr, /BATTERY-RAN/, 'refused before the battery');
      assertBaseUntouched(p, `${mode} foreign --branch`);
      assert.ok(gitMaybe(p.dir, ['rev-parse', '--verify', 'refs/heads/feat/other']), 'the named branch is not deleted');
      assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, 'no pr or api call');
      assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', 'refs/heads/feat/other']), null, 'nothing pushed');
    } finally {
      p.cleanup();
    }
  });
}

// Sol review (MEDIUM): on a detached HEAD, `git rev-parse --abbrev-ref HEAD`
// prints the literal 'HEAD', which equalled the defaulted --branch and let the
// gate merge main into itself. No branch checked out is refused with exit 2.
for (const mode of ['hobby', 'work']) {
  test(`${mode}: a detached HEAD (no branch checked out) is refused with exit 2 before the battery; nothing merged or pushed`, () => {
    const p = makeProject({ mode, checkScript: 'echo BATTERY-RAN >&2; exit 0' });
    try {
      git(p.dir, ['checkout', '-q', '--detach', 'HEAD']);
      const r = runDirectMerge(p);
      assert.equal(r.status, 2, `a detached HEAD exits 2 — stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, /no branch is checked out/i, 'the refusal says why');
      assert.doesNotMatch(r.stderr, /BATTERY-RAN/, 'refused before the battery');
      assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'local main does not move');
      assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, 'origin main does not move');
      assert.ok(gitMaybe(p.dir, ['rev-parse', '--verify', `refs/heads/${p.branchName}`]), 'the feature branch survives');
      assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, 'no pr or api call');
    } finally {
      p.cleanup();
    }
  });
}

// Sol re-check: only `git symbolic-ref --quiet` exiting 1 with no output is the
// normal detached-HEAD answer. A HEAD naming an invalid ref makes it exit 128 with
// "fatal: No such ref: HEAD" while `git rev-parse --git-dir` still succeeds — that
// must fail loudly with git's own stderr, never read as "detached".
test('hobby: a HEAD git cannot resolve fails loudly with git\'s stderr (not the detached-HEAD refusal), before the battery', () => {
  const p = makeProject({ mode: 'hobby', checkScript: 'echo BATTERY-RAN >&2; exit 0' });
  try {
    writeFileSync(join(p.dir, '.git', 'HEAD'), 'ref: refs/heads/bad..name\n');
    const r = runDirectMerge(p);
    assert.equal(r.status, 1, `an unresolvable HEAD is a loud failure (exit 1) — stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /could not determine the checked-out branch/, 'the failure names what could not be determined');
    assert.match(r.stderr, /No such ref/, "git's own stderr is carried through");
    assert.doesNotMatch(r.stderr, /no branch is checked out/i, 'never mistaken for a detached HEAD');
    assert.doesNotMatch(r.stderr, /BATTERY-RAN/, 'refused before the battery');
  } finally {
    p.cleanup();
  }
});

test('work: --branch naming the checked-out branch itself is accepted (the rule refuses only a DIFFERENT branch)', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const r = runDirectMerge(p, ['--branch', p.branchName]);
    assert.equal(r.status, 0, `--branch equal to the checkout proceeds — stderr=${oneLine(r.stderr)}`);
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

test('work: the PR create FAILS but the PR exists afterwards (a create race or a timeout) — the strict follow-up lookup finds it and reports it REUSED with exit 0', () => {
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

test('work: the create exits 0 but its answer is NOT a PR, and the PR exists — the strict read-back finds it and reports it REUSED (exit 0, created false)', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_nonpr_after'), '');
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `exit 0 when the read-back finds the PR — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = parseSingleJson(r.stdout, 'non-PR answer, PR present');
    assert.equal(out.ok, true);
    assert.equal(out.created, false, 'not asserted as created by this run when the answer was not a PR');
    assert.equal(out.pr_url, 'https://github.com/acme/widget/pull/7');
    assert.equal(out.pr_number, 7);
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' && c[1] === 'list').length, 2, 'one lookup before the create, one read-back after the unreadable answer');
    noPrCreateEver(p.gh.state);
    assertArmed(p, { number: 7 });
  } finally {
    p.cleanup();
  }
});

test('work: the create exits 0 but its answer is NOT a PR, and no PR is found — exit 1, state UNKNOWN, nothing armed', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_nonpr'), '');
    const r = runDirectMerge(p);
    assert.equal(r.status, 1, `an unreadable create with no PR found exits 1 — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /UNKNOWN/, 'the PR state is reported UNKNOWN, never asserted absent');
    assert.match(r.stderr, /PUSHED/);
    assert.doesNotMatch(r.stderr, /no PR exists/i);
    assert.match(r.stderr, /by hand.*reuses it and arms the review loop/s);
    assert.ok(r.stderr.includes(`https://${ORIGIN_REPO}/compare/main...${p.branchName}?expand=1`), 'the by-hand create URL is named on this arm too');
    assert.doesNotMatch(r.stderr, /Windows gh\.exe/, 'gh exited 0 here, so the WSL gh.exe note does not apply');
    const out = parseSingleJson(r.stdout, 'non-PR answer, no PR');
    assert.equal(out.ok, false);
    assert.equal(out.pushed, true);
    assert.equal(out.pr_url, null);
    assert.equal(out.pr_number, null);
    assert.equal(out.created, false);
    assert.equal(existsSync(prLoopFile(p)), false, 'a ship that ends UNKNOWN arms nothing');
  } finally {
    p.cleanup();
  }
});

/** Push-destination rule: every effective push URL of origin must name the
 * same GitHub repo gh is bound to, or the run refuses in work-preflight. */
function assertPushDestinationRefusal(p, r, label, destinations) {
  assert.equal(r.status, 2, `${label}: exit 2 — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stage, 'work-preflight', label);
  assert.equal(out.pushed, false, label);
  for (const d of destinations) assert.ok(r.stderr.includes(d), `${label}: the refusal names destination ${d}`);
  assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, `${label}: no pr or api call`);
  assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, `${label}: nothing pushed to origin`);
  const other = join(p.ssh.FAKE_SSH_ROOT, 'other', 'fork.git');
  if (existsSync(other)) assert.equal(gitMaybe(other, ['rev-parse', '--verify', p.branchName]), null, `${label}: nothing pushed to the other repo`);
}

function makeOtherRepo(p) {
  git(p.base, ['init', '--bare', '-q', '-b', 'main', join(p.ssh.FAKE_SSH_ROOT, 'other', 'fork.git')]);
}

test('work push destinations: a remote.origin.pushurl naming ANOTHER repo is refused with exit 2 before pushing, naming every destination', () => {
  const p = makeProject({ mode: 'work' });
  try {
    makeOtherRepo(p);
    git(p.dir, ['config', 'remote.origin.pushurl', 'ssh://git@github.com/other/fork.git']);
    assertPushDestinationRefusal(p, runDirectMerge(p), 'pushurl elsewhere', ['ssh://git@github.com/other/fork.git', ORIGIN_REPO]);
  } finally {
    p.cleanup();
  }
});

test('work push destinations: TWO push URLs, one of them another repo, are refused with exit 2 before pushing', () => {
  const p = makeProject({ mode: 'work' });
  try {
    makeOtherRepo(p);
    git(p.dir, ['remote', 'set-url', '--add', '--push', 'origin', 'git@github.com:acme/widget.git']);
    git(p.dir, ['remote', 'set-url', '--add', '--push', 'origin', 'git@github.com:other/fork.git']);
    assertPushDestinationRefusal(p, runDirectMerge(p), 'two push URLs', ['git@github.com:acme/widget.git', 'git@github.com:other/fork.git']);
  } finally {
    p.cleanup();
  }
});

test('work push destinations: a pushInsteadOf rewrite sending pushes to ANOTHER repo is refused with exit 2 before pushing', () => {
  const p = makeProject({ mode: 'work' });
  try {
    makeOtherRepo(p);
    git(p.dir, ['config', 'url.ssh://git@github.com/other/fork.git.pushInsteadOf', ORIGIN_URL]);
    assertPushDestinationRefusal(p, runDirectMerge(p), 'pushInsteadOf elsewhere', ['ssh://git@github.com/other/fork.git']);
  } finally {
    p.cleanup();
  }
});

test('work push destinations: an explicit pushurl naming the SAME repo in another URL form still ships', () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['config', 'remote.origin.pushurl', 'git@github.com:acme/widget.git']);
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `a matching pushurl ships — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).created, true);
    assert.equal(git(p.origin, ['rev-parse', p.branchName]), p.branchSha, 'the branch landed in origin\'s repo');
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
    'https://github.com/acme/.github.git': 'github.com/acme/.github',
    'git@github.com:acme/.dotfiles': 'github.com/acme/.dotfiles',
  };
  for (const [url, repo] of Object.entries(ok)) assert.equal(parseOriginRepo(url)?.repo, repo, url);
  for (const bad of ['/tmp/origin.git', 'file:///tmp/origin.git', 'https://github.com/acme', 'https://github.com/a/b/c', 'git@github.com:acme/..', 'git@github.com:acme/.', 'https://github.com/../widget.git', '', 'C:\\repos\\x.git']) {
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
    assert.equal(ghCalls(p.gh.state).filter((c) => c[0] === 'pr' || c[0] === 'api').length, 0, 'no pr or api call');
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
      assert.equal(existsSync(prLoopFile(p)), false, 'hobby never arms the PR review loop duty');
    } finally {
      p.cleanup();
    }
  });
}

// GitHub issue #39 (user-ruled 2026-10-08, 'Fall back to local merge'): a WORK
// project whose repository has no 'origin' remote has no PR path, so the gate
// merges locally like hobby mode and says loudly that no PR and no Copilot
// review happened. A work project WITH origin keeps the PR flow (every `work:`
// test above); a directory that is not a git repo is not "no origin".
test("work + no 'origin' remote: merges LOCALLY like hobby, says loudly that no PR and no Copilot review happened, calls no gh, arms no PR loop", () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['remote', 'remove', 'origin']);
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `the no-origin work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const notice = /WORK mode, but this repository has no 'origin' remote — merging LOCALLY like hobby mode\. NO pull request was opened and NO Copilot review happened/;
    assert.match(r.stderr, notice, 'the fallback is announced');
    assert.equal(r.stderr.match(new RegExp(notice.source, 'g')).length, 2, 'announced at the start and again after the merge output');
    const out = parseSingleJson(r.stdout, 'no-origin work merge');
    // CONTRACT FIX (Sol review): the configured mode stays 'work', so the work
    // envelope keeps its shape on every exit and carries the fallback marker,
    // with the local merge's own report inside it. This used to read as the bare
    // hobby report (mode undefined).
    assert.equal(out.mode, 'work', 'the work envelope is kept');
    assert.equal(out.ok, true);
    assert.equal(out.stage, 'done');
    assert.equal(out.exit, 0);
    assert.equal(out.work_mode_local_fallback, true, 'the report says the fallback applied');
    assert.equal(out.pr_url, null, 'no PR');
    assert.equal(out.pr_number, null, 'no PR');
    assert.equal(out.merged_into, 'main', "the local merge's own report rides the envelope");
    assert.equal(out.branch_merged, p.branchName);
    assert.equal(out.pushed, false, 'nothing is pushed: there is no origin');
    assert.deepEqual(ghCalls(p.gh.state), [], 'the fallback never calls gh');
    assert.notEqual(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main received the merge');
    assert.equal(gitMaybe(p.dir, ['rev-parse', '--verify', `refs/heads/${p.branchName}`]), null, 'the merged branch is deleted like hobby');
    // The state the PR flow would have written: no file, and the duty rule H10
    // and the OpenCode plugin share reads nothing owed and nothing degraded.
    assert.equal(existsSync(prLoopFile(p)), false, 'no pr-loop.json is armed');
    assert.deepEqual(evaluatePrLoop(p.dir), { state: null, degraded: null }, 'the shared PR-loop duty rule owes nothing');
  } finally {
    p.cleanup();
  }
});

test("work + no 'origin' at start, but origin appears DURING the battery: the fallback holds, nothing is pushed, origin's base is unchanged", () => {
  const p = makeProject({ mode: 'work', checkScript: `git remote add origin ${ORIGIN_URL}` });
  try {
    git(p.dir, ['remote', 'remove', 'origin']);
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(gitMaybe(p.dir, ['remote', 'get-url', 'origin']), 'the battery did add origin');
    const out = parseSingleJson(r.stdout, 'origin appears mid-run');
    assert.equal(out.mode, 'work');
    assert.equal(out.work_mode_local_fallback, true);
    assert.equal(out.pushed, false, 'the fallback never pushes');
    assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, "origin's base did not move");
    assert.equal(gitMaybe(p.origin, ['rev-parse', '--verify', p.branchName]), null, 'the branch was not pushed either');
    assert.notEqual(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main received the merge locally');
    assert.deepEqual(ghCalls(p.gh.state), []);
  } finally {
    p.cleanup();
  }
});

test("work + no 'origin' remote: a refusal exit keeps the work envelope and carries the fallback marker", () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['remote', 'remove', 'origin']);
    writeFileSync(join(p.dir, 'src', 'f0.mjs'), 'export const f0 = 99;\n');
    const r = runDirectMerge(p);
    assert.equal(r.status, 1, `a dirty tree refuses — stderr=${oneLine(r.stderr)}`);
    const out = parseSingleJson(r.stdout, 'fallback refusal');
    assert.equal(out.mode, 'work');
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'dirty-tree');
    assert.equal(out.exit, 1);
    assert.equal(out.work_mode_local_fallback, true);
  } finally {
    p.cleanup();
  }
});

test("work + a GitHub origin: unchanged — no local-fallback notice, no work_mode_local_fallback, the PR flow runs", () => {
  const p = makeProject({ mode: 'work' });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, oneLine(r.stderr));
    assert.doesNotMatch(r.stderr, /merging LOCALLY like hobby mode/);
    const out = parseSingleJson(r.stdout, 'work with origin');
    assert.equal(out.mode, 'work');
    assert.equal(out.work_mode_local_fallback, undefined);
    assert.equal(out.pr_number !== null, true, 'a PR was opened');
    assertBaseUntouched(p, 'work with origin');
  } finally {
    p.cleanup();
  }
});

test("work + no 'origin' remote but another remote: still the local fallback (only a missing 'origin' triggers it)", () => {
  const p = makeProject({ mode: 'work' });
  try {
    git(p.dir, ['remote', 'rename', 'origin', 'upstream']);
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /has no 'origin' remote — merging LOCALLY/);
    assert.deepEqual(ghCalls(p.gh.state), []);
  } finally {
    p.cleanup();
  }
});

// The shipping flow follows the mode and nothing else (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// the handoff setting, on or off, changes neither flow, and /sterling:merge
// writes no handoff files in any of the four combinations.
const HANDOFF_PATHS = ['.opencode', 'architecture.md', 'rulings.md', 'docs'];
for (const handoff of [true, false]) {
  test(`work, handoff ${handoff ? 'on' : 'off'}: /sterling:merge opens the PR and never merges`, () => {
    const p = makeProject({ mode: 'work', handoff });
    try {
      const r = runDirectMerge(p);
      assert.equal(r.status, 0, `work merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      const out = parseSingleJson(r.stdout, 'work + handoff');
      assert.deepEqual([out.mode, out.ok, out.created, out.pr_number], ['work', true, true, 7]);
      assertBaseUntouched(p, 'work + handoff');
      assert.equal(existsSync(prLoopFile(p)), true, 'the PR review loop duty is armed');
      for (const f of HANDOFF_PATHS) assert.equal(existsSync(join(p.dir, f)), false, `${f} is not written by a merge`);
    } finally {
      p.cleanup();
    }
  });

  test(`hobby, handoff ${handoff ? 'on' : 'off'}: /sterling:merge merges directly and never calls gh`, () => {
    const p = makeProject({ mode: 'hobby', handoff });
    try {
      const r = runDirectMerge(p);
      assert.equal(r.status, 0, `hobby merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      assert.equal(parseSingleJson(r.stdout, 'hobby + handoff').mode, undefined, 'the hobby report shape is unchanged');
      assert.deepEqual(ghCalls(p.gh.state), [], 'hobby never calls gh');
      assert.notEqual(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'hobby merges into main');
      assert.equal(existsSync(prLoopFile(p)), false, 'hobby never arms the PR review loop duty');
      for (const f of HANDOFF_PATHS) assert.equal(existsSync(join(p.dir, f)), false, `${f} is not written by a merge`);
    } finally {
      p.cleanup();
    }
  });
}

// ---------------------------------------------------------------- S3 arming
// A work-mode merge that CREATES or REUSES a PR arms the H10 'PR review loop
// owed' duty (slice S3): .sterling/transient/pr-loop.json with the PR, origin's
// repo, the pushed (pinned) head SHA and status 'owed'. A failed ship arms
// nothing.

const prLoopFile = (p) => join(p.dir, '.sterling', 'transient', 'pr-loop.json');

function assertArmed(p, { number }) {
  assert.ok(existsSync(prLoopFile(p)), 'pr-loop.json is written');
  const s = JSON.parse(readFileSync(prLoopFile(p), 'utf8'));
  assert.deepEqual(Object.keys(s).sort(), ['armed_at', 'head_sha', 'pr_number', 'pr_url', 'repo', 'status']);
  assert.equal(s.pr_url, `https://${ORIGIN_REPO}/pull/${number}`);
  assert.equal(s.pr_number, number);
  assert.equal(s.repo, ORIGIN_REPO);
  assert.equal(s.head_sha, p.branchSha);
  assert.equal(s.status, 'owed');
  assert.ok(!Number.isNaN(Date.parse(s.armed_at)), 'armed_at is an ISO time');
}

test('work S3: CREATING the PR arms the PR review loop duty (pr-loop.json, status owed, the pushed head)', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, oneLine(r.stdout + r.stderr));
    assertArmed(p, { number: 7 });
  } finally {
    p.cleanup();
  }
});

test('work S3: REUSING an open PR re-arms the duty — a settled loop goes back to owed for the new head', () => {
  const p = makeProject({ mode: 'work' });
  try {
    seedPr(p, { number: 41 });
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(prLoopFile(p), JSON.stringify({ pr_url: `https://${ORIGIN_REPO}/pull/41`, pr_number: 41, repo: ORIGIN_REPO, head_sha: 'f'.repeat(40), armed_at: '2026-01-01T00:00:00.000Z', status: 'clean', settled_at: '2026-01-01T01:00:00.000Z' }));
    const r = runDirectMerge(p);
    assert.equal(r.status, 0, oneLine(r.stdout + r.stderr));
    assertArmed(p, { number: 41 });
  } finally {
    p.cleanup();
  }
});

test('work S3: a ship that FAILS (the PR create fails, no PR found) arms nothing', () => {
  const p = makeProject({ mode: 'work' });
  try {
    writeFileSync(join(p.gh.state, 'create_fail'), '');
    const r = runDirectMerge(p);
    assert.equal(r.status, 1, oneLine(r.stdout + r.stderr));
    assert.equal(existsSync(prLoopFile(p)), false);
  } finally {
    p.cleanup();
  }
});

test('work S3: a failed create, then a PR opened by hand, then a rerun — the rerun REUSES that PR and re-arms the loop (owed, its number) over a settled loop for another PR', () => {
  const p = makeProject({ mode: 'work' });
  try {
    const settled = { pr_url: `https://${ORIGIN_REPO}/pull/33`, pr_number: 33, repo: ORIGIN_REPO, head_sha: 'e'.repeat(40), armed_at: '2026-01-01T00:00:00.000Z', status: 'clean', settled_at: '2026-01-01T01:00:00.000Z' };
    mkdirSync(join(p.dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(prLoopFile(p), JSON.stringify(settled));
    writeFileSync(join(p.gh.state, 'create_fail'), '');
    const r1 = runDirectMerge(p);
    assert.equal(r1.status, 1, oneLine(r1.stdout + r1.stderr));
    assert.deepEqual(JSON.parse(readFileSync(prLoopFile(p), 'utf8')), settled, 'the failed ship leaves the earlier loop state untouched');

    rmSync(join(p.gh.state, 'create_fail'));
    seedPr(p, { number: 52 });
    const r2 = runDirectMerge(p);
    assert.equal(r2.status, 0, oneLine(r2.stdout + r2.stderr));
    const out = parseSingleJson(r2.stdout, 'rerun after a hand-opened PR');
    assert.equal(out.pr_number, 52);
    assert.equal(out.created, false, 'the hand-opened PR is reused, not created');
    assert.equal(createCalls(p.gh.state).length, 1, 'the rerun makes no second create call (only the failed one)');
    noPrCreateEver(p.gh.state);
    assertArmed(p, { number: 52 });
  } finally {
    p.cleanup();
  }
});
