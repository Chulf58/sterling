// Consumer-machine update tests (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89).
// Two halves, matching the two ways this can be wrong:
//   1. the REFUSAL matrix — read against real temp git repos (local file
//      remotes, no network), because "is this machine diverged?" is exactly the
//      question a hand-rolled answer got wrong;
//   2. the STEP ORDER — driven through an injected exec, so the ordering and the
//      conditional steps are asserted without an npm ci or a 90s battery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCurrency, refusalFor, currencyLine, gitFrom, defaultExec, runUpdate } from '../lib/update.mjs';

const GIT_ID = ['-c', 'user.email=t@sterling.test', '-c', 'user.name=sterling test'];

function git(cwd, args) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** origin (bare) + a clone of it, one commit deep — the consumer-machine shape. */
function makeClonePair() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-update-'));
  const origin = join(dir, 'origin.git');
  const author = join(dir, 'author');
  const consumer = join(dir, 'consumer');
  mkdirSync(author);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8' });
  git(author, ['init', '--initial-branch=main']);
  writeFileSync(join(author, 'file.txt'), 'v1\n');
  git(author, ['add', '-A']);
  git(author, ['commit', '-m', 'first']);
  git(author, ['remote', 'add', 'origin', origin]);
  git(author, ['push', '-u', 'origin', 'main']);
  spawnSync('git', ['clone', origin, consumer], { encoding: 'utf8', timeout: 60_000 });
  return { dir, origin, author, consumer };
}

function pushUpstream(author, text) {
  writeFileSync(join(author, 'file.txt'), text);
  git(author, ['add', '-A']);
  git(author, ['commit', '-m', `upstream ${text.trim()}`]);
  git(author, ['push', 'origin', 'main']);
}

function currencyOf(cwd) {
  return readCurrency({ git: gitFrom(defaultExec, cwd) });
}

// ── 1. currency + refusal matrix, against real git ──────────────────────────

test('clean clone that is behind: currency counts the gap and the pre-flight allows it', () => {
  const { dir, author, consumer } = makeClonePair();
  try {
    pushUpstream(author, 'v2\n');
    pushUpstream(author, 'v3\n');
    git(consumer, ['fetch', 'origin']);

    const c = currencyOf(consumer);
    assert.equal(c.is_repo, true);
    assert.equal(c.branch, 'main');
    assert.equal(c.detached, false);
    assert.equal(c.has_origin, true);
    assert.equal(c.default_branch, 'main');
    assert.equal(c.upstream, 'origin/main');
    assert.equal(c.upstream_exists, true);
    assert.equal(c.behind, 2);
    assert.equal(c.ahead, 0);
    assert.deepEqual(c.dirty_tracked, []);
    assert.equal(refusalFor(c), null, 'a clean, behind consumer must be fast-forwardable');
    assert.match(currencyLine(c), /on main · origin\/main · 2 behind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('up-to-date clone reports up to date and refuses nothing', () => {
  const { dir, consumer } = makeClonePair();
  try {
    const c = currencyOf(consumer);
    assert.equal(c.behind, 0);
    assert.equal(c.ahead, 0);
    assert.equal(refusalFor(c), null);
    assert.match(currencyLine(c), /up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modified TRACKED file refuses and names the file; untracked files never block', () => {
  const { dir, consumer } = makeClonePair();
  try {
    writeFileSync(join(consumer, 'file.txt'), 'local edit\n');
    writeFileSync(join(consumer, 'scratch.txt'), 'untracked\n');

    const c = currencyOf(consumer);
    assert.equal(c.dirty_tracked.length, 1);
    assert.match(c.dirty_tracked[0], /file\.txt/);
    assert.equal(c.untracked.length, 1);
    const refusal = refusalFor(c);
    assert.match(refusal, /uncommitted changes to tracked files/);
    assert.match(refusal, /file\.txt/);

    // untracked alone: reported, never a refusal — the machine-specific
    // launchers/MCP config live beside the repo and must survive an update.
    git(consumer, ['checkout', '--', 'file.txt']);
    const clean = currencyOf(consumer);
    assert.equal(clean.dirty_tracked.length, 0);
    assert.equal(clean.untracked.length, 1);
    assert.equal(refusalFor(clean), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local commits refuse as ahead; upstream too refuses as DIVERGED — a consumer never authors', () => {
  const { dir, author, consumer } = makeClonePair();
  try {
    writeFileSync(join(consumer, 'file.txt'), 'authored here\n');
    git(consumer, ['add', '-A']);
    git(consumer, ['commit', '-m', 'local work']);

    const ahead = currencyOf(consumer);
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.behind, 0);
    assert.match(refusalFor(ahead), /1 local commit\(s\) ahead of origin\/main/);

    pushUpstream(author, 'v2\n');
    git(consumer, ['fetch', 'origin']);
    const diverged = currencyOf(consumer);
    assert.equal(diverged.ahead, 1);
    assert.equal(diverged.behind, 1);
    assert.match(refusalFor(diverged), /DIVERGED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detached HEAD and a non-default branch each refuse with the checkout that fixes them', () => {
  const { dir, consumer } = makeClonePair();
  try {
    git(consumer, ['checkout', '-b', 'sterling/local-experiment']);
    const onBranch = currencyOf(consumer);
    assert.match(refusalFor(onBranch), /not 'main'/);
    assert.match(refusalFor(onBranch), /git checkout main/);

    git(consumer, ['checkout', 'main']);
    git(consumer, ['checkout', '--detach', 'HEAD']);
    const detached = currencyOf(consumer);
    assert.equal(detached.detached, true);
    assert.match(refusalFor(detached), /HEAD is detached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that is not a repo, and a repo with no origin, both refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-update-bare-'));
  try {
    assert.match(refusalFor(currencyOf(dir)), /not a git repository/);

    const solo = join(dir, 'solo');
    mkdirSync(solo);
    git(solo, ['init', '--initial-branch=main']);
    writeFileSync(join(solo, 'a.txt'), 'x');
    git(solo, ['add', '-A']);
    git(solo, ['commit', '-m', 'only']);
    assert.match(refusalFor(currencyOf(solo)), /no 'origin' remote/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describe surfaces an annotated tag as the human-legible version; no tags still identifies by sha', () => {
  const { dir, consumer } = makeClonePair();
  try {
    const untagged = currencyOf(consumer);
    assert.equal(untagged.describe, untagged.head_short, 'no tags → describe --always falls back to the sha');
    assert.match(currencyLine(untagged), new RegExp(untagged.head_short));

    git(consumer, ['tag', '-a', 'v0.2.0', '-m', 'release']);
    const tagged = currencyOf(consumer);
    assert.equal(tagged.describe, 'v0.2.0');
    assert.match(currencyLine(tagged), /v0\.2\.0 \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. step order + conditional steps, through an injected exec ─────────────

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function fakeExec({ behind = 0, ahead = 0, dirty = [], changed = [], failing = null, syncStatus = () => 0 } = {}) {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const exec = (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (failing && line.includes(failing)) return { status: 1, stdout: '', stderr: 'step blew up' };
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged ? '0\t0' : `${behind}\t${ahead}`);
      if (a === 'status --porcelain') return ok(dirty.join('\n'));
      if (a.startsWith('merge --ff-only')) {
        merged = true;
        return ok('Fast-forward');
      }
      if (a.startsWith('diff --name-only')) return ok(changed.join('\n'));
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    // node <script> --target <dir>
    if (args[0]?.endsWith('sync-agents.mjs')) {
      const status = syncStatus(args[2]);
      return { status, stdout: status === 0 ? 'up_to_date: coder\n' : 'coder: modified\n', stderr: status ? 'REFUSED' : '' };
    }
    return ok('done');
  };
  return { exec, calls };
}

/** A cwd with no .sterling/config.json and no scripts/ — the optional steps skip loudly. */
function scratchCwd() {
  return mkdtempSync(join(tmpdir(), 'sterling-update-cwd-'));
}

test('refusal path mutates nothing: no merge, no npm, exit 2', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 3, dirty: [' M packages/store/src/index.ts'] });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(report.exit, 2);
    assert.match(report.refusal, /uncommitted changes to tracked files/);
    assert.equal(calls.filter((c) => c.includes('merge')).length, 0);
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('already current: fetches, reports, and runs no build or sync (exit 0)', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 0 });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(report.exit, 0);
    assert.ok(calls.some((c) => c.startsWith('git fetch')));
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--check never mutates even when behind', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 5 });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [], opts: { check: true } });

    assert.equal(report.exit, 0);
    assert.equal(report.currency.behind, 5);
    assert.equal(calls.filter((c) => c.includes('merge')).length, 0);
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('behind: fast-forward then build → build:tui → check → test, then the project fan-out', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 2, changed: ['packages/store/src/index.ts'] });
    const report = await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: [{ name: 'Deepdots', repo_path: '/tmp/deepdots' }, { name: 'comsoft', repo_path: '/tmp/comsoft' }],
      opts: {},
    });

    assert.equal(report.exit, 0);
    const order = calls.filter((c) => c.includes('merge --ff-only') || c.startsWith('npm ') || c.includes('sync-agents'));
    assert.deepEqual(order.slice(0, 5), [
      'git merge --ff-only origin/main',
      'npm run build',
      'npm run build:tui',
      'npm run check',
      'npm test',
    ]);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 2);
    assert.deepEqual(report.projects.map((p) => p.name), ['Deepdots', 'comsoft']);
    // no dependency change → npm ci must NOT run (it is the one networked step)
    assert.equal(calls.filter((c) => c === 'npm ci').length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// THE BOOTSTRAP DEFECT, found by running the real CLI against a fresh clone:
// the workspace packages are gitignored, so on a first update NOTHING is built —
// and the CLI needs @sterling/store to read the project registry. Reading it at
// startup crashed with ERR_MODULE_NOT_FOUND before the build that would have
// fixed it. The list is therefore resolved LAZILY, at the fan-out step, which is
// after the build; this pins that ordering.
test('the project list is resolved lazily AFTER the build, never at startup', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1 });
    let callsWhenResolved = null;
    const report = await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: async () => {
        callsWhenResolved = [...calls];
        return [{ name: 'Deepdots', repo_path: '/tmp/deepdots' }];
      },
      opts: {},
    });

    assert.equal(report.exit, 0);
    assert.ok(callsWhenResolved, 'the loader must be called');
    assert.ok(callsWhenResolved.includes('npm run build'), 'the build must already have run when the registry is read');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 1);
    assert.deepEqual(report.projects.map((p) => p.name), ['Deepdots']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a lazy project loader is never called when the fan-out is skipped', async () => {
  const cwd = scratchCwd();
  try {
    const { exec } = fakeExec({ behind: 1 });
    let called = false;
    await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: async () => {
        called = true;
        return [];
      },
      opts: { projects: false },
    });
    assert.equal(called, false, '--no-projects must not even load the registry');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('npm ci runs only when the lockfile moved', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1, changed: ['package-lock.json', 'packages/store/src/index.ts'] });
    await runUpdate({ cwd, exec, log: () => {}, projects: [], opts: {} });
    const ciIdx = calls.indexOf('npm ci');
    assert.ok(ciIdx !== -1, 'npm ci must run when package-lock.json changed');
    assert.ok(ciIdx < calls.indexOf('npm run build'), 'npm ci must precede the build');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--no-test skips the battery; --no-projects skips the fan-out', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1 });
    await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: [{ name: 'p', repo_path: '/tmp/p' }],
      opts: { test: false, projects: false },
    });
    assert.equal(calls.filter((c) => c === 'npm test').length, 0);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0);
    assert.ok(calls.includes('npm run check'), 'the consistency battery still runs');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a failing step stops the sequence loudly (exit 1) — no half-update in silence', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1, failing: 'npm run build' });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(report.exit, 1);
    assert.ok(calls.includes('git merge --ff-only origin/main'), 'the fast-forward already happened and is reported as standing');
    assert.equal(calls.filter((c) => c === 'npm run check').length, 0);
    assert.equal(calls.filter((c) => c === 'npm test').length, 0);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a per-project sync refusal surfaces as exit 2 without stopping the other projects', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({
      behind: 1,
      syncStatus: (target) => (target === '/tmp/salesforce' ? 2 : 0),
    });
    const report = await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: [
        { name: 'Salesforce', repo_path: '/tmp/salesforce' },
        { name: 'comsoft', repo_path: '/tmp/comsoft' },
      ],
      opts: {},
    });

    assert.equal(report.exit, 2);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 2, 'the refusal must not abort the fan-out');
    assert.deepEqual(report.projects.map((p) => p.status), [2, 0]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the init ensure pass runs only when the clone is itself initialized', async () => {
  const withConfig = scratchCwd();
  const without = scratchCwd();
  try {
    mkdirSync(join(withConfig, '.sterling'), { recursive: true });
    writeFileSync(join(withConfig, '.sterling', 'config.json'), '{}');

    const a = fakeExec({ behind: 1 });
    await runUpdate({ cwd: withConfig, exec: a.exec, log: () => {}, projects: [], opts: {} });
    assert.ok(a.calls.some((c) => c.includes('init.mjs')), 'an initialized clone re-bakes its machine artifacts');

    const b = fakeExec({ behind: 1 });
    await runUpdate({ cwd: without, exec: b.exec, log: () => {}, projects: [], opts: {} });
    assert.equal(b.calls.filter((c) => c.includes('init.mjs')).length, 0);
  } finally {
    rmSync(withConfig, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});
