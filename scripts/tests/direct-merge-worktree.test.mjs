// DIRECT-MERGE FROM A LINKED GIT WORKTREE (board ks-dashboards-gap-1). .sterling/
// is gitignored, so a linked worktree never has it, and the gate used to die with
// "no Sterling store ... not an initialized project". The store and the project
// mode now come from the MAIN checkout (the parent of `git rev-parse
// --git-common-dir`):
//   HOBBY — the merge must check the base out, and the base is normally checked
//     out in the main tree, so a worktree run cannot finish it. It refuses with
//     exit 2 BEFORE the battery, naming the worktree case and the exact commands.
//   WORK  — it only pushes the branch and opens a PR, so it proceeds, resolving
//     the store, the config and the PR-loop marker from the main checkout.
// Harness idiom (bare origin behind a fake ssh, PATH-prepended fake gh) is
// duplicated from direct-merge-work-mode.test.mjs; test files export nothing.
// Child streams are flattened with oneLine() before landing in an assertion
// message (anti-pattern foreign_ee89c3fd).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveLinkedWorktree } from '../lib/project.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function git(cwd, args, env = process.env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

// A trimmed fake gh: version, auth, pr list, and the REST PR create. State is
// one prs.json plus a log of argv, in FAKE_GH_STATE.
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.FAKE_GH_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(state, 'log.jsonl'), JSON.stringify(argv) + '\\n');
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const prsFile = join(state, 'prs.json');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const [a, b] = argv;
if (a === '--version') { console.log('gh version 9.9.9 (fake)'); process.exit(0); }
if (a === 'auth' && b === 'status') { console.error('Logged in to github.com as fake'); process.exit(0); }
if (a === 'repo' && b === 'view') { console.log(JSON.stringify({ nameWithOwner: 'other/default' })); process.exit(0); }
if (a === 'pr' && b === 'list') {
  const fields = (flag('--json') ?? 'url,number').split(',');
  const hits = prs.filter((p) => p.headRefName === flag('--head'));
  console.log(JSON.stringify(hits.map((p) => Object.fromEntries(fields.map((f) => [f, p[f]])))));
  process.exit(0);
}
if (a === 'api') {
  const m = (argv.find((x) => /^repos\\//.test(x)) ?? '').match(/^repos\\/([^/]+)\\/([^/]+)\\/pulls$/);
  const host = flag('--hostname');
  if (!m || !host || flag('--method') !== 'POST') { console.error('fake gh: unhandled api call ' + JSON.stringify(argv)); process.exit(3); }
  const fields = {};
  argv.forEach((x, i) => { if (x === '-f') { const kv = argv[i + 1]; fields[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1); } });
  const number = 7 + prs.length;
  const url = 'https://' + host + '/' + m[1] + '/' + m[2] + '/pull/' + number;
  prs.push({ number, url, headRefName: fields.head, baseRefName: fields.base });
  writeFileSync(prsFile, JSON.stringify(prs));
  console.log(JSON.stringify({ number, html_url: url, url, head: { ref: fields.head }, base: { ref: fields.base } }));
  process.exit(0);
}
console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3);
`;

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

/** A main checkout on `main` (bare origin, .sterling/ with the given mode and an
 * initialised store, a `check` script that drops a marker file when it runs), and
 * a LINKED worktree of it on a feature branch with one commit. */
function makeProject({ mode, config = {}, writeConfig = true }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-dm-wt-')));
  const dir = join(base, 'repo');
  const wt = join(base, 'wt');
  const implSsh = join(base, 'fake-ssh.mjs');
  writeFileSync(implSsh, FAKE_SSH_IMPL);
  const ssh = { GIT_SSH_COMMAND: `"${process.execPath}" "${implSsh}"`, GIT_SSH_VARIANT: 'ssh', FAKE_SSH_ROOT: join(base, 'remotes') };
  const origin = join(ssh.FAKE_SSH_ROOT, 'acme', 'widget.git');
  const env = { ...process.env, ...ssh };
  mkdirSync(dir);
  git(base, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nbattery-ran\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, scripts: { check: `node -e "require('fs').writeFileSync('battery-ran','1')"` } })
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  git(dir, ['remote', 'add', 'origin', ORIGIN_URL]);
  git(dir, ['push', 'origin', 'main'], env);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (writeConfig) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode, ...config }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  git(dir, ['worktree', 'add', '-b', 'feat/sprockets', wt]);
  writeFileSync(join(wt, 'src', 'f0.mjs'), 'export const f0 = 0;\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-m', 'feat: widget sprockets']);

  const bin = join(base, 'fakebin');
  const ghState = join(base, 'ghstate');
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghState, { recursive: true });
  const implGh = join(base, 'fake-gh.mjs');
  writeFileSync(implGh, FAKE_GH_IMPL);
  const shim = join(bin, 'gh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${implGh}" "$@"\n`);
  chmodSync(shim, 0o755);
  return {
    base,
    dir,
    wt,
    origin,
    ssh,
    bin,
    ghState,
    mainSha: git(dir, ['rev-parse', 'main']),
    originMainSha: git(origin, ['rev-parse', 'main']),
    branchSha: git(wt, ['rev-parse', 'HEAD']),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function runFromWorktree(p, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', p.wt, ...extra], {
    encoding: 'utf8',
    cwd: p.wt,
    timeout: 60_000,
    env: { ...process.env, ...p.ssh, PATH: `${p.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.ghState, GIT_TERMINAL_PROMPT: '0' },
  });
}

test('resolveLinkedWorktree: the main checkout and a non-git directory are null; a linked worktree names its main checkout', () => {
  const p = makeProject({ mode: 'hobby' });
  try {
    assert.equal(resolveLinkedWorktree(p.dir), null, 'the main checkout is not a linked worktree');
    assert.deepEqual(resolveLinkedWorktree(p.wt), { worktree: p.wt, mainRoot: p.dir });
    assert.equal(resolveLinkedWorktree(p.base), null, 'a directory outside any repository is null');
  } finally {
    p.cleanup();
  }
});

test('hobby from a linked worktree: refuses with exit 2 BEFORE the battery, names the worktree case and the exact commands; nothing moves', () => {
  const p = makeProject({ mode: 'hobby' });
  try {
    const r = runFromWorktree(p);
    assert.equal(r.status, 2, `exit 2 — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(!/no Sterling store|not an initialized project/.test(r.stderr), `must not be the misleading store error: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /linked git worktree/);
    assert.ok(r.stderr.includes(`git -C ${p.dir} worktree remove ${p.wt}`), `names the remove command: ${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(`git -C ${p.dir} checkout feat/sprockets`), `names the checkout command: ${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(`--target ${p.dir}`), `names the rerun from the main checkout: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(join(p.wt, 'battery-ran')), false, 'the battery never ran in the worktree');
    assert.equal(existsSync(join(p.dir, 'battery-ran')), false, 'the battery never ran in the main checkout');
    assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main did not move');
    assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, 'origin main did not move');
    assert.equal(git(p.wt, ['branch', '--show-current']), 'feat/sprockets');
  } finally {
    p.cleanup();
  }
});

test('work from a linked worktree: the store and mode come from the main checkout; the branch is pushed and a PR opened; the PR-loop marker lands in the main checkout', () => {
  // attestation_path_globs is declared ONLY in the main checkout's config: a
  // linked worktree has no .sterling/, so a glob read against the worktree
  // comes back empty and the attestation stage goes silent.
  const p = makeProject({ mode: 'work', config: { attestation_path_globs: ['src/**'] } });
  try {
    const r = runFromWorktree(p);
    assert.equal(r.status, 0, `work merge from a worktree must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, { mode: 'work', ok: true, stage: 'done', error: null, exit: 0, pushed: true, pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, branch: 'feat/sprockets', created: true });
    assert.equal(git(p.origin, ['rev-parse', 'feat/sprockets']), p.branchSha, 'the feature branch is pushed to origin at its tip');
    assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, 'origin main did not move');
    assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main did not move');
    assert.equal(git(p.wt, ['branch', '--show-current']), 'feat/sprockets', 'the worktree keeps its branch');
    const marker = join(p.dir, '.sterling', 'transient', 'pr-loop.json');
    assert.ok(existsSync(marker), 'the PR review loop duty is armed in the MAIN checkout, where the hooks read it');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).pr_number, 7);
    assert.equal(existsSync(join(p.wt, '.sterling')), false, 'nothing is written under the worktree');
    assert.match(
      r.stderr,
      /direct-merge: ATTESTATION DISCLOSURE — declaration 'src\/\*\*': 1 touched path\(s\); 0 have a comparable human record/,
      `the main checkout's attestation globs are read and disclosed against its store — stderr=${oneLine(r.stderr)}`
    );
    assert.ok(!/ATTESTATION DISCLOSURE UNAVAILABLE/.test(r.stderr), `the attestation store is the main checkout's, not the worktree's — stderr=${oneLine(r.stderr)}`);
  } finally {
    p.cleanup();
  }
});

test('work-mode config only in the main checkout, none in the worktree: the gate resolves WORK from the main checkout, never hobby', () => {
  const p = makeProject({ mode: 'work' });
  try {
    assert.equal(existsSync(join(p.wt, '.sterling', 'config.json')), false, 'fixture: the worktree has no config of its own');
    const r = runFromWorktree(p, ['--no-push']);
    // --no-push is refused in WORK mode only, so seeing that refusal proves the mode resolved to work.
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, 'work');
    assert.match(out.error, /--no-push is refused in WORK mode/);
    assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main did not move');
    assert.equal(existsSync(join(p.dir, 'battery-ran')), false, 'no hobby merge battery ran');
  } finally {
    p.cleanup();
  }
});

test('linked worktree whose mode cannot be read anywhere: refuses with exit 2 naming both config paths, never defaults to hobby; nothing moves', () => {
  const p = makeProject({ mode: 'work', writeConfig: false });
  try {
    const r = runFromWorktree(p);
    assert.equal(r.status, 2, `exit 2 — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(join(p.wt, '.sterling', 'config.json')), `names the worktree config path: ${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(join(p.dir, '.sterling', 'config.json')), `names the main checkout config path: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /never defaulted to hobby/);
    assert.ok(!/worktree remove/.test(r.stderr), `not the hobby refusal: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(join(p.dir, 'battery-ran')), false, 'no battery ran');
    assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main did not move');
    assert.equal(git(p.origin, ['rev-parse', 'main']), p.originMainSha, 'origin main did not move');
  } finally {
    p.cleanup();
  }
});

test('work-mode config only in the WORKTREE (none in the main checkout): it is read, not refused; the worktree becomes the store root', () => {
  const p = makeProject({ mode: 'work', writeConfig: false });
  try {
    mkdirSync(join(p.wt, '.sterling'), { recursive: true });
    writeFileSync(join(p.wt, '.sterling', 'config.json'), JSON.stringify({ mode: 'work' }));
    new SterlingStore(join(p.wt, '.sterling', 'sterling.db')).close();
    const r = runFromWorktree(p, ['--no-push']);
    // The work-only --no-push refusal proves the mode resolved to work from the worktree's own config.
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, 'work');
    assert.match(out.error, /--no-push is refused in WORK mode/);
    assert.ok(!/cannot be read|never defaulted to hobby/.test(r.stderr), `not the unreadable-mode refusal: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(join(p.dir, 'battery-ran')), false, 'no hobby merge battery ran');
    assert.equal(git(p.dir, ['rev-parse', 'main']), p.mainSha, 'main did not move');
  } finally {
    p.cleanup();
  }
});

test('linked worktree of a BARE main (no main checkout to read the mode from): refuses with exit 2 naming the worktree and the common git dir, never hobby', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-dm-bare-')));
  try {
    const bare = join(base, 'bare.git');
    const wt = join(base, 'wt');
    git(base, ['init', '--bare', '-b', 'main', bare]);
    git(bare, ['config', 'user.email', 'test@sterling.local']);
    git(bare, ['config', 'user.name', 'Sterling Test']);
    git(bare, ['worktree', 'add', '--orphan', '-b', 'feat/x', wt]);
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-m', 'feat: a']);
    assert.equal(resolveLinkedWorktree(wt), null, 'fixture: no main checkout can be named');
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', wt], { encoding: 'utf8', cwd: wt, timeout: 60_000 });
    assert.equal(r.status, 2, `exit 2 — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(wt), `names the worktree: ${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(bare), `names the common git dir: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /never defaulted to hobby/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
