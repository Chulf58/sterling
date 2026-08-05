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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCurrency, refusalFor, currencyLine, gitFrom, defaultExec, runUpdate, stampConsumerRoleIfAbsent } from '../lib/update.mjs';
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from '../lib/update-launcher.mjs';

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

function fakeExec({ behind = 0, ahead = 0, dirty = [], changed = [], failing = null, syncStatus = () => 0, contractStatus = 0 } = {}) {
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
    // stamp-contract exits 2 on a refusal it will not auto-resolve
    if (args[0]?.endsWith('stamp-contract.mjs')) {
      return { status: contractStatus, stdout: contractStatus ? '✗ comsoft: HAND_TUNED_REFUSED\n' : '7 already in sync, 0 refusal(s).\n', stderr: '' };
    }
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

// The stamp-contract step is deliberately TOLERATED (a sibling's CLAUDE.md must
// never abort this clone's update) — but tolerated used to mean its verdict lived
// only in a block sandwiched between build/test/check output. The closing summary
// now repeats it, so a refusal cannot scroll past (P1/P5).
test('sibling contract drift is tolerated but repeated in the closing summary, never only in the scrolled-past block', async () => {
  for (const [contractStatus, expectDrift] of [
    [2, true],
    [0, false],
  ]) {
    const cwd = mkdtempSync(join(tmpdir(), 'sterling-update-contract-'));
    try {
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      writeFileSync(join(cwd, 'scripts', 'stamp-contract.mjs'), '// fixture\n');
      const { exec, calls } = fakeExec({ behind: 1, contractStatus });
      const lines = [];
      const report = await runUpdate({ cwd, exec, log: (m) => lines.push(m), projects: [], opts: {} });
      const out = lines.join('\n');

      assert.ok(calls.some((c) => c.includes('stamp-contract.mjs')), 'the dry run runs either way');
      assert.equal(report.contract_drift, expectDrift, 'the report carries the verdict for callers');
      assert.equal(report.exit, 0, "a sibling's CLAUDE.md never blocks this clone's update");
      assert.equal(/CONTRACT DRIFT/.test(out), expectDrift, 'the summary names drift only when there is drift');
      if (expectDrift) assert.match(out, /stamp-contract\.mjs --apply/, 'and names the command that fixes it');
      assert.match(out, /RESTART THE SESSION/, 'the restart instruction survives either way');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

// ── 3. machine-role stamp (todo cabbc10f, decision a9b98b7d) ────────────────

test('stampConsumerRoleIfAbsent: stamps consumer when machine_role is absent, preserving other fields', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ backup_path: '/tmp/backups', stack_tags: ['node'] }, null, 2));

    const lines = [];
    stampConsumerRoleIfAbsent(dir, (l) => lines.push(l));

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.machine_role, 'consumer');
    assert.equal(written.backup_path, '/tmp/backups', 'other fields survive the read-modify-write');
    assert.deepEqual(written.stack_tags, ['node']);
    assert.ok(lines.some((l) => l.includes("stamped 'consumer'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stampConsumerRoleIfAbsent: never overwrites a declared role, either value', () => {
  for (const role of ['authoring', 'consumer']) {
    const dir = scratchCwd();
    try {
      mkdirSync(join(dir, '.sterling'), { recursive: true });
      const configPath = join(dir, '.sterling', 'config.json');
      writeFileSync(configPath, JSON.stringify({ machine_role: role }));

      const lines = [];
      stampConsumerRoleIfAbsent(dir, (l) => lines.push(l));

      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(written.machine_role, role, 'a declared role is never flipped, in either direction');
      assert.ok(lines.some((l) => l.includes('not overwritten')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('stampConsumerRoleIfAbsent: an unwritable config warns loudly but does not throw', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({}));
    chmodSync(configPath, 0o444); // read-only — the write must fail, not the read
    chmodSync(join(dir, '.sterling'), 0o555); // and block a same-name replace too

    const lines = [];
    assert.doesNotThrow(() => stampConsumerRoleIfAbsent(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => l.includes('FAILED') && l.includes('nonfatal')), 'the failure is loud');
  } finally {
    chmodSync(join(dir, '.sterling'), 0o755);
    chmodSync(join(dir, '.sterling', 'config.json'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stampConsumerRoleIfAbsent: no .sterling/config.json prints a skip note, does not throw', () => {
  const dir = scratchCwd();
  try {
    const lines = [];
    assert.doesNotThrow(() => stampConsumerRoleIfAbsent(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => l.includes('SKIPPED')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runUpdate stamps the consumer role after a successful update, once build+check+test complete', async () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({}));

    const { exec } = fakeExec({ behind: 1 });
    const report = await runUpdate({ cwd: dir, exec, log: () => {}, projects: [], opts: {} });

    assert.equal(report.exit, 0);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.machine_role, 'consumer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runUpdate never overwrites a declared machine_role, even after a real rebuild', async () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ machine_role: 'authoring' }));

    const { exec } = fakeExec({ behind: 1 });
    await runUpdate({ cwd: dir, exec, log: () => {}, projects: [], opts: {} });

    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).machine_role, 'authoring');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runUpdate does not stamp when the update is a no-op (already current) — the stamp step never runs', async () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({}));

    const { exec } = fakeExec({ behind: 0 });
    const report = await runUpdate({ cwd: dir, exec, log: () => {}, projects: [], opts: {} });

    assert.equal(report.exit, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(readFileSync(configPath, 'utf8')), 'machine_role'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A currency object clearing every EARLIER refusal, so a test isolates one branch
 *  of the matrix. Built literally rather than from a temp repo: the partitioning is
 *  pure string logic over porcelain lines, and driving it through real git would
 *  only obscure which input produced which remedy. */
function cleanCurrency() {
  return {
    is_repo: true,
    has_origin: true,
    detached: false,
    head_short: 'abc1234',
    describe: 'abc1234',
    branch: 'main',
    default_branch: 'main',
    upstream: 'origin/main',
    upstream_exists: true,
    behind: 1,
    ahead: 0,
    dirty_tracked: [],
    untracked: [],
  };
}

test('the dirty refusal splits committed BUILD OUTPUTS from source and gives each its own remedy', () => {
  // Reported from a consumer 2026-07-30: a dirty hooks/ bundle drew "commit and
  // push from the authoring machine", which is never right for a build output the
  // consumer is explicitly told not to rebuild. Both remedies must be correct AND
  // distinguishable, so the refusal is exercised in all three shapes.
  const bundle = ' M hooks/h19-knowledge-delivery.mjs';
  const projection = ' M architecture.md';
  const src = ' M scripts/prep.mjs';

  const generatedOnly = refusalFor({ ...cleanCurrency(), dirty_tracked: [bundle, projection] });
  assert.match(generatedOnly, /COMMITTED BUILD OUTPUTS — discard these, always/);
  assert.match(generatedOnly, /git checkout -- hooks\/h19-knowledge-delivery\.mjs architecture\.md/, 'the exact discard command is spelled out');
  assert.match(generatedOnly, /byte-compares/, 'and states why discarding cannot hide a defect');
  assert.doesNotMatch(generatedOnly, /belongs on the authoring machine/, 'the push-it advice must NOT reach a build output');

  const sourceOnly = refusalFor({ ...cleanCurrency(), dirty_tracked: [src] });
  assert.match(sourceOnly, /SOURCE CHANGES/);
  assert.match(sourceOnly, /belongs on the authoring machine/, 'real source keeps the original remedy');
  assert.doesNotMatch(sourceOnly, /COMMITTED BUILD OUTPUTS/, 'no build-output block when none are dirty');

  const both = refusalFor({ ...cleanCurrency(), dirty_tracked: [bundle, src] });
  assert.match(both, /COMMITTED BUILD OUTPUTS/);
  assert.match(both, /SOURCE CHANGES/);
  assert.match(both, /hooks\/h19-knowledge-delivery\.mjs/);
  assert.match(both, /scripts\/prep\.mjs/);

  // A rename resolves to its DESTINATION, and a hooks/ SOURCE is not a bundle.
  assert.match(
    refusalFor({ ...cleanCurrency(), dirty_tracked: ['R  hooks/old.mjs -> hooks/h7-file-touch.mjs'] }),
    /git checkout -- hooks\/h7-file-touch\.mjs/
  );
  assert.match(
    refusalFor({ ...cleanCurrency(), dirty_tracked: [' M scripts/hooks/h19-knowledge-delivery.mjs'] }),
    /SOURCE CHANGES/,
    'the authored hook SOURCE under scripts/ is source, not a build output'
  );
});

// --------------------------- sterling-update.bat delivery ---------------------------

const BAT_TEMPLATE = '@echo off\r\nrem updater\r\n"wt.exe" wsl.exe --cd "{{WIN_PLUGIN_DIR}}" -- bash -lic "bash scripts/update-console.sh"\r\n';

function cloneWithTemplate() {
  const clone = mkdtempSync(join(tmpdir(), 'sterling-launcher-clone-'));
  mkdirSync(join(clone, 'templates'));
  writeFileSync(join(clone, 'templates', 'update-win.bat'), BAT_TEMPLATE);
  return clone;
}

test('ensureUpdateLauncher: created / matches / differs / skipped — never overwrites, and the gitignore entry is ensured', () => {
  const clone = cloneWithTemplate();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    const created = ensureUpdateLauncher(target, clone);
    assert.equal(created.status, 'created');
    const content = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.doesNotMatch(content, /\{\{WIN_PLUGIN_DIR\}\}/, 'the plugin dir placeholder is substituted');
    // this clone lives under /tmp (ext4, no /mnt/<d> form): the POSIX path must
    // pass through unchanged — backslashifying it yields a path valid nowhere,
    // and wsl.exe --cd accepts absolute Linux paths
    assert.ok(content.includes(`--cd "${clone}"`), 'an ext4 clone bakes its POSIX path, never a backslashified non-path');
    assert.match(readFileSync(join(target, '.gitignore'), 'utf8'), /^sterling-update\.bat$/m, 'a machine artifact never surfaces as untracked noise');

    assert.equal(ensureUpdateLauncher(target, clone).status, 'matches', 'idempotent on a second run');
    const ignoreEntries = readFileSync(join(target, '.gitignore'), 'utf8').split(/\r?\n/).filter((l) => l === UPDATE_LAUNCHER_NAME);
    assert.equal(ignoreEntries.length, 1, 'the gitignore entry is not duplicated');

    writeFileSync(join(target, UPDATE_LAUNCHER_NAME), 'hand edited');
    assert.equal(ensureUpdateLauncher(target, clone).status, 'differs');
    assert.equal(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), 'hand edited', 'a differing launcher is left untouched');

    assert.equal(ensureUpdateLauncher(join(target, 'does-not-exist'), clone).status, 'skipped', 'a missing target skips, never throws');
    const bare = mkdtempSync(join(tmpdir(), 'sterling-launcher-bare-'));
    try {
      assert.equal(ensureUpdateLauncher(target, bare).status, 'skipped', 'a clone without the template skips, never throws');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('the fan-out delivers sterling-update.bat to each registered project (a project init\'d before the launcher existed still receives one)', async () => {
  const cwd = cloneWithTemplate();
  const proj = mkdtempSync(join(tmpdir(), 'sterling-launcher-proj-'));
  try {
    const { exec } = fakeExec({ behind: 1 });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: proj }], opts: {} });
    assert.equal(report.exit, 0);
    assert.ok(existsSync(join(proj, UPDATE_LAUNCHER_NAME)), 'the launcher landed in the consuming project');
    assert.match(readFileSync(join(proj, '.gitignore'), 'utf8'), /^sterling-update\.bat$/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
