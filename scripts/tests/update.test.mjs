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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readCurrency, refusalFor, currencyLine, gitFrom, defaultExec, runUpdate, stampConsumerRoleIfAbsent, stampSanctionedScriptsIfMissing } from '../lib/update.mjs';
import { ensureUpdateLauncher, renderUpdateLauncher, updateTemplateName, UPDATE_LAUNCHER_NAME } from '../lib/update-launcher.mjs';

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

// -----------------------------------------------------------------------------
// rulings.md joins GENERATED_TRACKED; the dirty-refusal justification splits by
// FAMILY (hooks bundles keep the byte-compare rationale, architecture.md/
// rulings.md get a store-projection rationale); a staged build-output change
// gets an index-aware `git restore --staged --worktree --` remedy beside the
// existing worktree-only `git checkout --`. SPEC-ONLY: authored from the fix's
// own description (H4 read-wall denies scripts/lib/update.mjs), verified only
// against this file's existing cleanCurrency()/refusalFor conventions and
// decision a9b98b7d (the original hooks/architecture.md split this extends).
// -----------------------------------------------------------------------------

test('CONTROL, placed first: a genuine SOURCE change (hooks/hooks.json) reads as SOURCE CHANGES, never a build output', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [' M hooks/hooks.json'] });
  assert.match(c, /SOURCE CHANGES/);
  assert.doesNotMatch(c, /COMMITTED BUILD OUTPUTS/, 'hooks/hooks.json is a source file, never classified as a generated build output');
});
// SABOTAGE: broaden the GENERATED_TRACKED match from an exact-path form to a
// prefix form (e.g. /^hooks\//) so it also matches hooks/hooks.json — this
// control flips to COMMITTED BUILD OUTPUTS and the doesNotMatch assertion goes
// red. (This control is what rules out "the classifier denies/flags
// everything" as the explanation for the three arms below going green.)

test('rulings.md is classified as a COMMITTED BUILD OUTPUT, never SOURCE CHANGES', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [' M rulings.md'] });
  assert.match(c, /COMMITTED BUILD OUTPUTS/);
  assert.doesNotMatch(c, /SOURCE CHANGES/, 'rulings.md is a generated projection, never real source');
});
// SABOTAGE: drop the /^rulings\.md$/ entry from GENERATED_TRACKED — this test
// goes red because the refusal reclassifies rulings.md as SOURCE CHANGES
// instead of a build output.

test('a STAGED build-output change (architecture.md) names the index-aware restore remedy', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: ['M  architecture.md'] });
  assert.match(c, /git restore --staged --worktree -- architecture\.md/);
});
// SABOTAGE: delete the staged-restore remedy line, leaving only the
// worktree-only `git checkout --` remedy for the unstaged case — this test
// goes red because the staged case would no longer name --staged --worktree.

test('an unstaged architecture.md carries the store-projection justification, while a hooks bundle in the SAME refusal still carries the byte-compare justification', () => {
  const bundle = ' M hooks/h19-knowledge-delivery.mjs';
  const projection = ' M architecture.md';
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [bundle, projection] });
  assert.match(c, /read-only PROJECTIONS of the knowledge store/);
  assert.match(c, /byte-compares/, 'the hooks bundle entry keeps its own byte-compare justification in the same refusal');
});
// SABOTAGE: restore the old single-sentence justification (the one
// byte-compares sentence that used to cover both hooks bundles AND
// architecture.md/rulings.md alike) — the "read-only PROJECTIONS of the
// knowledge store" match goes red, since that wording no longer appears.

// -----------------------------------------------------------------------------
// shellQuote() PINS (spec-only — H4 read-wall denies scripts/lib/update.mjs;
// authored from the dispatch spec: shellQuote() prints a path BARE only when
// it matches ^[A-Za-z0-9._/-]+$, otherwise POSIX single-quotes it, embedded
// single quotes escaped via the standard '\'' technique). Existing tests above
// only ever exercise plain names (architecture.md, hooks/h19-*.mjs,
// scripts/prep.mjs — all bare-safe), so the quoting branch itself is
// unpinned. These three arms exercise it directly, reusing cleanCurrency()/
// refusalFor() exactly as the tests above do. The CONTROL is placed first: it
// must pass for the OPPOSITE reason (nothing needed quoting) from the two
// arms that follow (quoting was required and applied).
// -----------------------------------------------------------------------------

test('shellQuote CONTROL: a plain, bare-safe path (architecture.md) still prints UNQUOTED — byte-identical to the frozen remedy line, since frozen remedy strings depend on it', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: ['M  architecture.md'] });
  assert.match(c, /git restore --staged --worktree -- architecture\.md/, 'the bare-safe path renders exactly as before shellQuote existed');
  assert.doesNotMatch(c, /'architecture\.md'/, 'a path needing no quoting must never be wrapped in single quotes');
});
// SABOTAGE: none needed for this control to distinguish it from the two arms
// below — it must stay GREEN under the very sabotage that reddens them (see
// below), because "return path unconditionally" is only a NO-OP difference
// for a path that was never going to be quoted in the first place. That is
// exactly what proves the two arms below are pinning the quoting branch and
// not something else: if this control also went red under the same
// sabotage, the failure could not be attributed to the quoting branch alone.

test('shellQuote: a dirty path containing a SPACE is single-quoted as ONE pathspec, never split into two bare words', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [' M hooks/a b.mjs'] });
  assert.match(c, /'hooks\/a b\.mjs'/, `a path containing a space must be wrapped in single quotes as one token — remedy=${c}`);
});
// SABOTAGE: in shellQuote(), replace the whole body with `return path;`
// (i.e. always return the bare, unquoted path, unconditionally) — the
// wrapping quotes vanish, the path prints as the bare, space-containing
// (and therefore two-word-looking) `hooks/a b.mjs`, and the match above goes
// red. Confirm the sabotage landed by grepping for the literal replaced
// function body in scripts/lib/update.mjs before trusting a red/green read.

test('shellQuote: an embedded single quote in a dirty path is escaped via the POSIX \'\\\'\' technique, not left bare or broken', () => {
  const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [" M hooks/a'b.mjs"] });
  // Target literal: 'hooks/a'\''b.mjs' — outer quotes, close-quote before the
  // embedded ', an escaped literal quote (\'), then reopen-quote and the rest.
  assert.ok(
    c.includes("'hooks/a'\\''b.mjs'"),
    `an embedded single quote must be escaped via '\\'' (close, escaped-quote, reopen), not left bare or malformed — remedy=${c}`
  );
});
// SABOTAGE: same as above — `return path;` unconditionally in shellQuote()
// leaves the embedded quote completely unescaped (`hooks/a'b.mjs` printed
// raw), so the exact escaped literal above never appears and this assertion
// goes red alongside the space-arm.

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

// board bb3aa162 — generated-marker refresh: the pre-fix behavior above
// ('differs' + left untouched, byte-identical) is EXACTLY case 3 (no marker /
// legacy) and, when the template hasn't changed between calls, case 4 (already
// current). What the old bare content-equality could NOT do is tell apart "the
// file changed because a human touched it" from "the file changed because the
// TEMPLATE changed and this on-disk copy is still exactly what generation
// produced" — both used to read identically as 'differs'. These pins isolate
// that distinction at the ensureUpdateLauncher seam. Spec-only: authored BLIND
// to scripts/lib/generated-marker.mjs, update-launcher.mjs and consumer-checks.mjs.
const BAT_TEMPLATE_V2 = '@echo off\r\nrem updater v2\r\n"wt.exe" wsl.exe --cd "{{WIN_PLUGIN_DIR}}" -- bash scripts/update-console.sh"\r\n';

test('ensureUpdateLauncher (case 1): an unmodified-since-generation file is REWRITTEN (status refreshed) when the render changes, and the new body validates its own fresh marker', () => {
  const clone = cloneWithTemplate();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    assert.equal(ensureUpdateLauncher(target, clone).status, 'created');
    const original = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');

    // the template changes (a clone move / template edit) — NOT a hand edit of
    // the target file — so the fresh render now differs from what's on disk
    writeFileSync(join(clone, 'templates', 'update-win.bat'), BAT_TEMPLATE_V2);

    const refreshed = ensureUpdateLauncher(target, clone);
    assert.equal(refreshed.status, 'refreshed', 'an untouched generated file refreshes instead of reporting differs');
    const afterRefresh = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.notEqual(afterRefresh, original, 'the on-disk CONTENT actually changed to the fresh render, not merely the status string');
    assert.match(afterRefresh, /rem updater v2/, 'the rewritten file reflects the NEW template body');

    // case 4 control, folded in: a further call against the now-current render
    // must report matches and rewrite nothing — proving the marker stamped by
    // the refresh above is itself valid for the body it describes
    const stable = ensureUpdateLauncher(target, clone);
    assert.equal(stable.status, 'matches', 'the freshly-stamped marker validates the freshly-written body — no refresh loop');
    assert.equal(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), afterRefresh, 'content untouched on the matching re-run');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: revert the marker-refresh mechanism to bare content-equality (in
// the "on-disk differs from fresh render" branch, always report 'differs' and
// skip the rewrite, regardless of marker match) — 'refreshed' assertion and the
// notEqual(afterRefresh, original) assertion both go red; the file would still
// read as 'hand edited' original bytes, exactly the board bb3aa162 defect.

test('ensureUpdateLauncher (case 2): a body hand-edited after generation stays "differs" even when the template ALSO changed — left byte-identical, never auto-refreshed', () => {
  const clone = cloneWithTemplate();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    assert.equal(ensureUpdateLauncher(target, clone).status, 'created');
    const launcherPath = join(target, UPDATE_LAUNCHER_NAME);
    // hand-edit the generated body — this is what must invalidate its marker
    const handEdited = readFileSync(launcherPath, 'utf8') + 'rem a human added this line\r\n';
    writeFileSync(launcherPath, handEdited);

    // the template ALSO changes, so a bare content-equality check and a
    // marker-aware check would disagree here — this is the discriminating case
    writeFileSync(join(clone, 'templates', 'update-win.bat'), BAT_TEMPLATE_V2);

    const result = ensureUpdateLauncher(target, clone);
    assert.equal(result.status, 'differs', 'a marker/body mismatch (hand-edited) is never auto-refreshed, even when the render moved on');
    assert.equal(readFileSync(launcherPath, 'utf8'), handEdited, 'the hand-edited file is left byte-identical — never overwritten');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: drop the marker-mismatch check and treat every on-disk/fresh-render
// mismatch as refreshable (always rewrite when they differ) — result.status
// flips to 'refreshed' and the hand-edited content is overwritten by the fresh
// render, both assertions go red. (Together with case 1 above this is a control
// pair: an "always refresh" implementation passes case 1 but fails this one; an
// "always differs" implementation — the pre-fix behavior — fails case 1 but
// passes this one. Only a real marker check passes both.)

test('ensureUpdateLauncher (case 3): a legacy file with no marker at all still differs and is left in place — the pre-marker fallback behavior is preserved', () => {
  const clone = cloneWithTemplate();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    // never generated by ensureUpdateLauncher — no marker line present at all
    writeFileSync(join(target, UPDATE_LAUNCHER_NAME), '@echo off\r\nrem hand-authored, predates the marker\r\n');
    const before = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');

    const result = ensureUpdateLauncher(target, clone);
    assert.equal(result.status, 'differs', 'no marker present → bare content-equality fallback → differs');
    assert.equal(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), before, 'legacy/hand-authored file left byte-identical');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: treat an absent marker as though it were a valid match for an
// "unmodified" body (default to refreshed instead of falling back to
// content-equality) — result.status flips to 'refreshed' and the legacy file's
// content changes, both assertions go red.

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

// board d055b150 — migrate-stores.mjs's journal previously recorded no caller
// identity at all, so an unattributed store mutation on this machine (11
// stores touched in one session) cost a real investigation plus one retracted
// public attribution. migrate-stores.mjs itself now stamps invoked_by:'direct'
// when the flag is absent; this pins the OTHER half — the update sweep must
// name itself so the journal can tell the two apart.
/** A minimal, genuinely pre-v2 SQLite file at <cwd>/.sterling/sterling.db —
 *  enough for probeSchemaVersion's raw header read (user_version=1) and
 *  machineStores' existsSync check, deterministic regardless of what this
 *  machine's real ~/.sterling/domains happens to hold. exec is fully faked in
 *  these tests, so the "migration" is never actually run — only the args
 *  step() was called with are inspected. */
function legacyStoreAt(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER); PRAGMA user_version = 1;');
  } finally {
    db.close();
  }
}

test('the migration sweep attributes itself: migrate-stores.mjs is invoked with --invoked-by update-sweep', async () => {
  const cwd = scratchCwd();
  try {
    const storePath = join(cwd, '.sterling', 'sterling.db');
    legacyStoreAt(storePath);
    const { exec, calls } = fakeExec({ behind: 1 });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [], opts: {} });

    assert.equal(report.exit, 0, `the update must succeed through the migration step: ${JSON.stringify(report)}`);
    const migrateCall = calls.find((c) => c.includes('migrate-stores.mjs') && c.includes(storePath));
    assert.ok(migrateCall, `expected a migrate-stores.mjs call naming '${storePath}' among:\n${calls.join('\n')}`);
    assert.match(
      migrateCall,
      /--invoked-by update-sweep\b/,
      'the update sweep must attribute itself in the migration journal via --invoked-by'
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 4. sanctioned-script stamp (board 52c1d504) ─────────────────────────────
//
// SPEC-ONLY (update.mjs's implementation was NOT read to author these): mirrors
// stampConsumerRoleIfAbsent's shape exactly (same read-modify-write, same
// loud-but-nonfatal posture, same log-driven assertions), applied instead to
// store_guard.allow_scripts via appendMissingSanctioned from
// scripts/lib/store-remediation.mjs. Called in runUpdate BEFORE the
// store-migration loop.
//
// The merge carries the SHIPPED SANCTIONED LIST (config.ts's allow_scripts
// default), not a curated migration sublist — board 52c1d504. Expected arrays
// below are spelled out literally, never derived from the module under test.

test('stampSanctionedScriptsIfMissing: adds exactly the missing scripts, preserving existing allow_scripts entries/order and other config fields', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ backup_path: '/tmp/backups', store_guard: { allow_scripts: ['scripts/some-other-script.mjs', 'scripts/migrate-stores.mjs'] } }, null, 2)
    );

    const lines = [];
    stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l));

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      written.store_guard.allow_scripts,
      [
        'scripts/some-other-script.mjs',
        'scripts/migrate-stores.mjs',
        'scripts/dispose-run.mjs',
        'scripts/init.mjs',
        'scripts/consume-exit.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/migration-preflight.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
      ],
      'only the MISSING shipped sanctioned scripts are appended; the existing entries and their order survive (migrate-stores.mjs stays at index 1, it is not moved to canonical position)'
    );
    assert.equal(written.backup_path, '/tmp/backups', 'other fields survive the read-modify-write');
    assert.ok(lines.some((l) => l.includes('scripts/migration-preflight.mjs')), 'the added script is disclosed via log');
    assert.ok(lines.some((l) => l.includes('packages/tui/bundle/sterling-tui.mjs')), 'the TUI launcher — the false-deny board 52c1d504 was raised for — is disclosed by name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: regenerate store_guard.allow_scripts from SANCTIONED_SCRIPTS
// instead of appending onto the recorded array — 'scripts/some-other-script.mjs'
// vanishes from `written`, the first deepEqual goes red.
// SABOTAGE (silent): perform the append but never call log() with the added
// script's name — the `lines.some(...)` disclosure assertion goes red.

test('stampSanctionedScriptsIfMissing: idempotent no-op (distinct log line, byte-unchanged) when EVERY shipped sanctioned script is already present', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    // fully covered, deliberately in NON-canonical order: presence is checked
    // by membership, never by position (board 52c1d504 re-cut).
    writeFileSync(configPath, JSON.stringify({ store_guard: { allow_scripts: [
      'scripts/migrate-stores.mjs',
      'packages/tui/bundle/sterling-tui.mjs',
      'scripts/migration-preflight.mjs',
      'scripts/commit-reviewed.mjs',
      'scripts/domain-doctor.mjs',
      'scripts/architecture-projection.mjs',
      'scripts/consume-exit.mjs',
      'scripts/init.mjs',
      'scripts/dispose-run.mjs',
    ] } }, null, 2));
    const before = readFileSync(configPath, 'utf8');

    const lines = [];
    stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l));

    assert.equal(readFileSync(configPath, 'utf8'), before, 'no rewrite when nothing is missing');
    assert.ok(lines.length > 0, 'a distinct no-op log line is still emitted (loud, not silent)');
    assert.ok(!lines.some((l) => /\badded\b/i.test(l)), 'the no-op log line is distinguishable from the added-something case — it never claims an addition');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: always emit the same "added: migration-preflight.mjs,
// migrate-stores.mjs" log line regardless of whether anything was actually
// appended — the `!lines.some(/\badded\b/i...)` assertion goes red because the
// no-op case would read identically to the real-addition case.
// SABOTAGE (rewrite): write the file back even when appendMissingSanctioned
// reports nothing added (e.g. an unconditional writeFileSync) — the
// byte-unchanged assertion goes red (JSON.stringify re-serialization changes
// key order/whitespace even when the logical content is the same).

test('stampSanctionedScriptsIfMissing: an unwritable config warns loudly but does not throw', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ store_guard: { allow_scripts: [] } }));
    chmodSync(configPath, 0o444);
    chmodSync(join(dir, '.sterling'), 0o555);

    const lines = [];
    assert.doesNotThrow(() => stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => l.includes('FAILED') && l.includes('nonfatal')), 'the failure is loud, non-fatal (matches stampConsumerRoleIfAbsent\'s convention)');
  } finally {
    chmodSync(join(dir, '.sterling'), 0o755);
    chmodSync(join(dir, '.sterling', 'config.json'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: let the write's thrown error propagate uncaught instead of
// catching and logging it — assert.doesNotThrow goes red.

test('stampSanctionedScriptsIfMissing: no .sterling/config.json prints a skip note, does not throw', () => {
  const dir = scratchCwd();
  try {
    const lines = [];
    assert.doesNotThrow(() => stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => l.includes('SKIPPED')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: attempt readFileSync unconditionally without checking existsSync
// first — this throws ENOENT uncaught (if uncaught) rather than logging a
// SKIPPED note, going red on doesNotThrow or on the SKIPPED assertion.

test('stampSanctionedScriptsIfMissing: scoped to its own cwd parameter — a call targeting dirA never writes dirB (the primitive itself takes no ambient sibling reach; that is layered on top by runUpdate, pinned below)', () => {
  const dirA = scratchCwd();
  const dirB = scratchCwd();
  try {
    for (const d of [dirA, dirB]) {
      mkdirSync(join(d, '.sterling'), { recursive: true });
      writeFileSync(join(d, '.sterling', 'config.json'), JSON.stringify({ store_guard: { allow_scripts: [] } }));
    }
    const beforeB = readFileSync(join(dirB, '.sterling', 'config.json'), 'utf8');

    stampSanctionedScriptsIfMissing(dirA, () => {});

    assert.equal(readFileSync(join(dirB, '.sterling', 'config.json'), 'utf8'), beforeB, 'a call scoped to dirA never writes a different directory\'s config');
    const writtenA = JSON.parse(readFileSync(join(dirA, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(writtenA.store_guard.allow_scripts, [
      'scripts/dispose-run.mjs',
      'scripts/init.mjs',
      'scripts/consume-exit.mjs',
      'scripts/architecture-projection.mjs',
      'scripts/domain-doctor.mjs',
      'scripts/commit-reviewed.mjs',
      'scripts/migration-preflight.mjs',
      'scripts/migrate-stores.mjs',
      'packages/tui/bundle/sterling-tui.mjs',
    ]);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
// SABOTAGE: resolve the config path from some ambient/global location instead
// of the passed-in cwd parameter — dirB's untouched assertion goes red (or
// dirA's own write silently fails because it wrote somewhere else).

// ── 5. sibling-project reach (board 1b3c7bf3 round 2) ───────────────────────
//
// SPEC-ONLY (update.mjs's implementation was NOT read to author these): the
// PRIMITIVE above stays scoped to one cwd — the new behavior is a per-project
// SWEEP inside runUpdate's existing registered-projects loop that calls it (or
// an equivalent stampSiblingRemediation wrapper) once per registered sibling,
// disclosing each with a `sanctioned-script reach [<name>]` log line,
// loud-but-nonfatal. This supersedes the old assumption (the test above, prior
// to this round) that a sibling's config was categorically untouched by
// /sterling:update — it never was untouched at the runUpdate level; no test
// had exercised that level at all until now.

test('runUpdate: the project fan-out additively merges remediation scripts into EACH registered sibling\'s config, disclosed per-project; existing entries/order preserved; an already-current sibling is a no-op', async () => {
  const cwd = scratchCwd();
  const projA = scratchCwd(); // frozen: missing migrate-stores.mjs only
  const projB = scratchCwd(); // already fully covered, non-canonical order — must be a no-op
  try {
    mkdirSync(join(projA, '.sterling'), { recursive: true });
    writeFileSync(
      join(projA, '.sterling', 'config.json'),
      JSON.stringify({ store_guard: { allow_scripts: ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs'] } }, null, 2)
    );
    mkdirSync(join(projB, '.sterling'), { recursive: true });
    writeFileSync(
      join(projB, '.sterling', 'config.json'),
      JSON.stringify({ store_guard: { allow_scripts: [
        'scripts/migrate-stores.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
        'scripts/migration-preflight.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/consume-exit.mjs',
        'scripts/init.mjs',
        'scripts/dispose-run.mjs',
      ] } }, null, 2)
    );
    const beforeB = readFileSync(join(projB, '.sterling', 'config.json'), 'utf8');

    const { exec } = fakeExec({ behind: 1 });
    const lines = [];
    const report = await runUpdate({
      cwd,
      exec,
      log: (l) => lines.push(l),
      projects: [{ name: 'Alpha', repo_path: projA }, { name: 'Beta', repo_path: projB }],
      opts: {},
    });

    assert.equal(report.exit, 0, JSON.stringify(report));

    const afterA = JSON.parse(readFileSync(join(projA, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(
      afterA.store_guard.allow_scripts,
      [
        'scripts/some-admin-script.mjs',
        'scripts/migration-preflight.mjs',
        'scripts/dispose-run.mjs',
        'scripts/init.mjs',
        'scripts/consume-exit.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/migrate-stores.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
      ],
      'the sibling gains exactly the missing shipped sanctioned scripts; existing entries and their order survive'
    );

    assert.equal(readFileSync(join(projB, '.sterling', 'config.json'), 'utf8'), beforeB, 'a sibling that already lists every shipped sanctioned script is a no-op — byte-unchanged');

    assert.ok(lines.some((l) => l.includes('sanctioned-script reach [Alpha]')), 'the sweep discloses itself per-project by name (Alpha)');
    assert.ok(lines.some((l) => l.includes('sanctioned-script reach [Beta]')), 'the sweep discloses itself per-project by name even for a no-op (Beta)');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  }
});
// SABOTAGE: drop the stampSiblingSanctioned call (or the loop that invokes it
// per registered project) from runUpdate's project fan-out — projA's config
// stays exactly as recorded, the first deepEqual (afterA.store_guard.allow_scripts)
// goes red, and neither 'sanctioned-script reach [...]' log line appears.

test('runUpdate: an already-current update (no --force) still sweeps remediation scripts for the clone AND its registered siblings before the early "already current" return', async () => {
  const dir = scratchCwd();
  const sibling = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ store_guard: { allow_scripts: ['scripts/some-admin-script.mjs'] } }));
    mkdirSync(join(sibling, '.sterling'), { recursive: true });
    writeFileSync(join(sibling, '.sterling', 'config.json'), JSON.stringify({ store_guard: { allow_scripts: [] } }));

    const { exec, calls } = fakeExec({ behind: 0 });
    const report = await runUpdate({
      cwd: dir,
      exec,
      log: () => {},
      projects: [{ name: 'Sib', repo_path: sibling }],
      opts: {},
    });

    assert.equal(report.exit, 0, JSON.stringify(report));
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0, 'still a true no-op — no build/test ran even though the config was mutated');
    assert.equal(calls.filter((c) => c.includes('merge')).length, 0, 'no fast-forward — genuinely already current');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0, 'the ordinary per-project sync-agents fan-out still does not run on a no-op — only the remediation sweep is special-cased onto this path');

    const cloneAfter = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(
      cloneAfter.store_guard.allow_scripts,
      [
        'scripts/some-admin-script.mjs',
        'scripts/dispose-run.mjs',
        'scripts/init.mjs',
        'scripts/consume-exit.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/migration-preflight.mjs',
        'scripts/migrate-stores.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
      ],
      'the clone still gains the missing shipped sanctioned scripts even though the update itself is a no-op'
    );

    const sibAfter = JSON.parse(readFileSync(join(sibling, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(
      sibAfter.store_guard.allow_scripts,
      [
        'scripts/dispose-run.mjs',
        'scripts/init.mjs',
        'scripts/consume-exit.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/migration-preflight.mjs',
        'scripts/migrate-stores.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
      ],
      'the registered sibling also gains the whole shipped list on a no-op update'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});
// SABOTAGE: move the stampSanctionedScriptsIfMissing/stampSiblingSanctioned
// sweep to AFTER the early 'already current' return — that code becomes
// unreachable on this path, so both config files stay exactly as recorded and
// both deepEqual assertions (cloneAfter / sibAfter) go red.

// Round 2 follow-up fix — a throwing project-registry resolver on the no-op
// path must be caught, not left to reject runUpdate or half-apply the sweep.
// Injection mirrors the established lazy-loader convention in this suite
// ('the project list is resolved lazily AFTER the build' above uses
// `projects: async () => {...}`); here the same slot is given a resolver that
// throws instead of resolving, on the already-current (behind:0) path.
test('runUpdate: on the already-current no-op path, a throwing project-registry resolver is caught — remediation still succeeds, sibling sweep is skipped, no unhandled throw', async () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ store_guard: { allow_scripts: ['scripts/some-admin-script.mjs'] } }));

    const { exec } = fakeExec({ behind: 0 });
    const lines = [];
    const throwingProjects = async () => {
      throw new Error('registry unavailable: ENOENT');
    };

    let report;
    await assert.doesNotReject(async () => {
      report = await runUpdate({ cwd: dir, exec, log: (l) => lines.push(l), projects: throwingProjects, opts: {} });
    }, 'runUpdate must not reject even when the project-registry resolver throws on the already-current no-op path');

    assert.equal(report.exit, 0, JSON.stringify(report));
    assert.ok(
      lines.some((l) => /registry unavailable/i.test(l) || /sibling sanctioned-script reach skipped/i.test(l)),
      'a nonfatal warning names the registry failure and/or that the sibling sweep was skipped'
    );

    const cloneAfter = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.deepEqual(
      cloneAfter.store_guard.allow_scripts,
      [
        'scripts/some-admin-script.mjs',
        'scripts/dispose-run.mjs',
        'scripts/init.mjs',
        'scripts/consume-exit.mjs',
        'scripts/architecture-projection.mjs',
        'scripts/domain-doctor.mjs',
        'scripts/commit-reviewed.mjs',
        'scripts/migration-preflight.mjs',
        'scripts/migrate-stores.mjs',
        'packages/tui/bundle/sterling-tui.mjs',
      ],
      'the clone config is still remediated even though the sibling registry resolution failed — no half-applied state'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: remove the try/catch around the no-op-path registry resolution
// (let a throw from resolving `projects` propagate uncaught) — runUpdate's
// returned promise rejects instead of resolving, so assert.doesNotReject goes
// red; if instead the throw were swallowed WITHOUT the clone remediation
// having already run, the final deepEqual on cloneAfter would go red too
// (whichever ran first, the try/catch must not skip the clone's own sweep).

// The two wrong-shape cases below moved here from init-ensure.test.mjs: init
// gates on parseConfig at load (init.mjs:88) and REFUSES a schema-invalid
// config outright, so the wrong-shape merge branch is unreachable through
// init. update.mjs:268-279 reads the RAW json with no schema validation, so
// the guard is actually live on THIS path — this is where it is pinned.
test('stampSanctionedScriptsIfMissing: a WRONG-SHAPED store_guard (not an object) logs a warning naming store_guard, is nonfatal, and is left byte-identical — never replaced', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ store_guard: 'x' }, null, 2)); // wrong shape entirely
    const before = readFileSync(configPath, 'utf8');

    const lines = [];
    assert.doesNotThrow(() => stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => /store_guard/i.test(l)), 'a warning names store_guard');
    assert.equal(readFileSync(configPath, 'utf8'), before, 'the malformed field is left exactly as recorded — never replaced, never coerced into an array/object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: skip the typeof/shape guard and attempt the merge unconditionally
// (e.g. `store_guard.allow_scripts = store_guard.allow_scripts || []`) against
// a non-object store_guard — this throws uncaught (assert.doesNotThrow goes
// red) instead of the loud-skip-and-continue the spec requires.

test('stampSanctionedScriptsIfMissing: a WRONG-SHAPED allow_scripts (a string, not an array) logs a warning naming allow_scripts, is nonfatal, and is left exactly as recorded — never character-spread into an array', () => {
  const dir = scratchCwd();
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const configPath = join(dir, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ store_guard: { allow_scripts: 'scripts/some-admin-script.mjs' } }, null, 2)); // string, not array
    const before = readFileSync(configPath, 'utf8');

    const lines = [];
    assert.doesNotThrow(() => stampSanctionedScriptsIfMissing(dir, (l) => lines.push(l)));
    assert.ok(lines.some((l) => /allow_scripts/i.test(l)), 'a warning names allow_scripts');
    assert.equal(readFileSync(configPath, 'utf8'), before, 'the malformed field is left exactly as recorded — never coerced into an array, never replaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: treat a string allow_scripts as a single-element array (e.g.
// `[...allowScripts]` on a string spreads its CHARACTERS) and append the
// missing scripts onto that — the byte-identical assertion goes red (the file
// would be rewritten with a corrupted allow_scripts).

test('runUpdate stamps the sanctioned scripts BEFORE the first store-migration step (ordering)', async () => {
  const cwd = scratchCwd();
  try {
    mkdirSync(join(cwd, '.sterling'), { recursive: true });
    const configPath = join(cwd, '.sterling', 'config.json');
    writeFileSync(configPath, JSON.stringify({ store_guard: { allow_scripts: ['scripts/some-admin-script.mjs'] } }));
    const storePath = join(cwd, '.sterling', 'sterling.db');
    legacyStoreAt(storePath);

    const events = [];
    const { exec: rawExec } = fakeExec({ behind: 1 });
    const exec = (cmd, args) => {
      events.push({ t: 'exec', line: `${cmd} ${args.join(' ')}` });
      return rawExec(cmd, args);
    };
    const log = (l) => events.push({ t: 'log', line: l });

    const report = await runUpdate({ cwd, exec, log, projects: [], opts: {} });
    assert.equal(report.exit, 0, JSON.stringify(report));

    const firstRemediationLog = events.findIndex((e) => e.t === 'log' && (e.line.includes('scripts/migration-preflight.mjs') || e.line.includes('scripts/migrate-stores.mjs')));
    const firstMigrationStep = events.findIndex((e) => e.t === 'exec' && e.line.includes('migrate-stores.mjs') && e.line.includes(storePath));
    assert.ok(firstRemediationLog !== -1, 'the remediation stamp discloses the added scripts by name via log');
    assert.ok(firstMigrationStep !== -1, 'a store-migration step ran against the legacy store');
    assert.ok(firstRemediationLog < firstMigrationStep, 'the remediation stamp log line precedes the first migration step call');

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written.store_guard.allow_scripts, [
      'scripts/some-admin-script.mjs',
      'scripts/dispose-run.mjs',
      'scripts/init.mjs',
      'scripts/consume-exit.mjs',
      'scripts/architecture-projection.mjs',
      'scripts/domain-doctor.mjs',
      'scripts/commit-reviewed.mjs',
      'scripts/migration-preflight.mjs',
      'scripts/migrate-stores.mjs',
      'packages/tui/bundle/sterling-tui.mjs',
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
// SABOTAGE: move the stampSanctionedScriptsIfMissing call to AFTER the
// store-migration loop inside runUpdate — firstRemediationLog would land
// after firstMigrationStep (or the config would still be missing the
// sanctioned scripts by the time migrate-stores.mjs runs), and the ordering
// assertion (or the final deepEqual) goes red.

// ── 6. the NATIVE-WINDOWS update arm (decision ffe7c416 ─────────────────────
//        `host-native-init-with-dev-machine-escape-hatch`; parity 1fe2a5e3;
//        consumer update UX 558895a9; article consumer-update-path AC9)
//
// WHY THIS SECTION EXISTS: templates/update-win.bat:13 shells UNCONDITIONALLY
// to wsl.exe, so before ffe7c416 a 100%-Windows user with no WSL could not
// update Sterling by ANY shipped route — a whole capability missing, not
// merely degraded. The native arm restores it, and it shipped with ZERO test
// coverage: everything above renders synthetic BAT_TEMPLATE fixtures through
// the WSL template, so an unrendered {{WIN_NODE_EXE}} — a .bat that on the real
// host tries to run a program literally named `{{WIN_NODE_EXE}}` — would ship
// GREEN. That is the defect class these pins close.
//
// SPEC-ONLY: authored BLIND to scripts/lib/update-launcher.mjs and
// templates/update-win-native.bat (H4 read wall; both were also being edited
// concurrently). Every expectation below comes from ffe7c416 and the declared
// interface, never from the implementation.
//
// DELIBERATELY NOT PINNED: the batch file's RUNTIME behaviour. cmd.exe cannot
// be executed from this repo's test seat, so a runtime pin would be a
// permanently-skipped test that reads like coverage. The control flow was read
// by an outside review; a read is not a run, and the gap stays documented here
// rather than faked.

/** repo root — these pins render the REAL shipped templates, not a fixture,
 *  because a fixture cannot catch a placeholder the SHIPPED template forgot. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A native-arm template fixture: no wsl, no bash, no wt — both placeholders. */
const NATIVE_BAT_TEMPLATE = [
  '@echo off',
  'rem native updater fixture',
  'set "STERLING_NODE={{WIN_NODE_EXE}}"',
  'cd /d "{{WIN_PLUGIN_DIR}}"',
  '"%STERLING_NODE%" scripts\\update.mjs %*',
  '',
].join('\r\n');

/** A clone carrying BOTH templates, so template SELECTION is a genuine choice
 *  rather than "whichever file happened to exist". */
function cloneWithBothTemplates() {
  const clone = mkdtempSync(join(tmpdir(), 'sterling-launcher-clone-'));
  mkdirSync(join(clone, 'templates'));
  writeFileSync(join(clone, 'templates', 'update-win.bat'), BAT_TEMPLATE);
  writeFileSync(join(clone, 'templates', 'update-win-native.bat'), NATIVE_BAT_TEMPLATE);
  return clone;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A quoted span somewhere in the render containing `value` — satisfied by a
 *  bare `"C:\...\node.exe"` AND by `set "VAR=C:\...\node.exe"`, both of which
 *  keep a Program Files path from splitting into two arguments. Deliberately
 *  not stricter: the quoting FORM is the template author's choice, the
 *  space-safety is the requirement. */
const quotedSpanContaining = (value) => new RegExp(`"[^"\\r\\n]*${escapeRe(value)}[^"\\r\\n]*"`);

/** rem/:: comment lines stripped. ffe7c416 says the native arm INVOKES no
 *  wsl.exe/bash/wt.exe; an inert `rem` mentioning WSL is not an invocation, so
 *  the negatives run against executable lines only. */
const execLines = (content) =>
  content
    .split(/\r?\n/)
    .filter((l) => !/^\s*(rem\b|::)/i.test(l))
    .join('\n');

test('CONTROL ARM — a non-win32 host still renders the WSL chain from a clone that ALSO carries the native template, POSIX clone path passed through unchanged', () => {
  // Placed FIRST and deliberately: every win32 pin below is a NEGATIVE ("no
  // wsl", "no bash"), and negatives have more than one possible cause — an
  // implementation that rewrote the launcher unconditionally, or one whose
  // render simply produced nothing useful, would satisfy them identically.
  // This arm must pass for the OPPOSITE reason, so a green win32 pin carries
  // its own evidence that the platform switch is what did the work.
  const clone = cloneWithBothTemplates();
  try {
    for (const platform of ['linux', 'darwin']) {
      const wsl = renderUpdateLauncher(clone, { platform });
      assert.match(wsl, /wsl\.exe/i, `${platform} must still route through wsl.exe — the native arm is win32-only`);
      assert.match(wsl, /\bbash\b/i, `${platform} still invokes bash inside the distro`);
      assert.match(wsl, /scripts\/update-console\.sh/, `${platform} still runs the console updater script`);
      assert.ok(
        wsl.includes(`--cd "${clone}"`),
        'an ext4 clone still bakes its POSIX path unchanged — backslashifying it yields a path valid nowhere'
      );
      assert.doesNotMatch(wsl, /\{\{/, 'no placeholder survives on the WSL arm either');
    }

    // and the two arms genuinely differ from the SAME clone — the selection is
    // driven by platform, not by which template happens to be present
    assert.notEqual(
      renderUpdateLauncher(clone, { platform: 'win32', nodeExe: 'C:\\Tools\\node.exe' }),
      renderUpdateLauncher(clone, { platform: 'linux' }),
      'one clone, two platforms, two different renders'
    );
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
// SABOTAGE: make updateTemplateName return 'update-win-native.bat'
// unconditionally (drop the platform test) — the linux/darwin iterations lose
// the wsl.exe/bash/update-console.sh matches and go red. This is the pin that
// proves the win32 negatives below are not satisfied by an unconditional
// rewrite; it is the CONTROL for all of them, so it carries no defense in
// depth of its own by design.

test('updateTemplateName: win32 selects the native template; EVERY other platform keeps the WSL one', () => {
  assert.equal(updateTemplateName('win32'), 'update-win-native.bat');
  // freebsd/aix are deliberate: they prove the rule is "win32 vs everything
  // else", not an allowlist of {linux, darwin} that silently mis-selects on a
  // platform nobody enumerated.
  for (const platform of ['linux', 'darwin', 'freebsd', 'aix', 'sunos']) {
    assert.equal(updateTemplateName(platform), 'update-win.bat', `${platform} is not win32 and must keep the WSL launcher`);
  }
});
// SABOTAGE: invert the comparison (`platform !== 'win32' ? native : wsl`) —
// the win32 equality goes red and all five non-win32 iterations go red.
// SABOTAGE (allowlist form): implement as `['linux','darwin'].includes(p) ?
// 'update-win.bat' : 'update-win-native.bat'` — win32/linux/darwin still pass,
// and ONLY the freebsd/aix/sunos iterations go red. That mutation is exactly
// why those three are here.

test('the SHIPPED native template renders clean on a win32 host: no placeholder survives, nothing invokes WSL/bash/wt, the quoted absolute node runs scripts\\update.mjs, CRLF throughout', () => {
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';

  // CONTROL FIRST, against the same real clone: the shipped WSL template must
  // still render its wsl.exe chain. Without this, "no wsl in the win32 render"
  // is equally satisfied by a render that produced an empty or broken string.
  const wsl = renderUpdateLauncher(REPO_ROOT, { platform: 'linux' });
  assert.match(wsl, /wsl\.exe/i, 'control: the shipped WSL template still renders its wsl.exe chain');

  const native = renderUpdateLauncher(REPO_ROOT, { platform: 'win32', nodeExe });
  assert.notEqual(native, wsl, 'the shipped native template is a different artifact, not the WSL one relabelled');

  // THE SHIP GATE: any unrendered placeholder at all, not just WIN_NODE_EXE —
  // a .bat containing `{{...}}` tries to run a program with that literal name.
  assert.doesNotMatch(native, /\{\{/, 'NO placeholder survives the win32 render');

  const executable = execLines(native);
  assert.doesNotMatch(executable, /wsl/i, 'ffe7c416: zero wsl.exe in a Windows installation — the user may not have WSL at all');
  assert.doesNotMatch(executable, /\bbash\b/i, 'no bash on the native arm');
  assert.doesNotMatch(executable, /wt\.exe/i, 'no Windows Terminal shim on the native arm');
  assert.doesNotMatch(executable, /update-console\.sh/i, 'the shell updater is the WSL arm’s entry point, never the native one');

  assert.match(
    native,
    quotedSpanContaining(nodeExe),
    'the baked interpreter sits inside a quoted span — an unquoted "C:\\Program Files\\..." splits into two arguments and the updater never starts'
  );
  assert.match(native, /scripts[\\/]update\.mjs/i, 'the native arm runs the updater directly');

  assert.ok(native.includes('\r\n'), 'the render is CRLF, as a .bat must be');
  assert.doesNotMatch(native, /(^|[^\r])\n/, 'every line is CRLF — a lone LF in a .bat is a cmd.exe parsing hazard');
});
// SABOTAGE: delete the `{{WIN_NODE_EXE}}` substitution from renderUpdateLauncher
// (leave `{{WIN_PLUGIN_DIR}}` working) — the doesNotMatch(/\{\{/) assertion and
// the quotedSpanContaining(nodeExe) assertion both go red. THIS IS THE PIN FOR
// THE REPORTED GAP: today that mutation ships green.
// SABOTAGE (arm-selection): have renderUpdateLauncher read update-win.bat for
// every platform — the /wsl/i, /\bbash\b/i and /update-console\.sh/i negatives
// go red together, and notEqual(native, wsl) goes red.
// SABOTAGE (CRLF): join the rendered lines with '\n' — the lone-LF assertion
// goes red while every other assertion in this test still passes.
// WHICH GUARD CARRIES THE VERDICT: these are independent, not layered — each
// mutation reddens a DIFFERENT assertion here, so no single guard is doing all
// the work and none of the assertions is decorative.

test('the baked interpreter is the INJECTED absolute exe, and defaults to an ABSOLUTE process.execPath — never the bare literal `node`', () => {
  // ffe7c416 measured `where.exe node` finding NOTHING on the real native host
  // (research_finding 0c712d94), which is why the exe is baked from
  // process.execPath — already known-runnable, needs no PATH membership.
  const clone = cloneWithBothTemplates();
  try {
    const injected = 'C:\\Program Files\\nodejs\\node.exe';
    const withInjection = renderUpdateLauncher(clone, { platform: 'win32', nodeExe: injected });
    assert.ok(withInjection.includes(injected), 'the injected path is baked VERBATIM — spaces intact, not escaped or truncated at the space');
    assert.match(withInjection, quotedSpanContaining(injected), 'and inside a quoted span');
    assert.doesNotMatch(withInjection, /\{\{WIN_NODE_EXE\}\}/, 'the placeholder is substituted, never shipped raw');

    const asLiteralNode = renderUpdateLauncher(clone, { platform: 'win32', nodeExe: 'node' });
    const byDefault = renderUpdateLauncher(clone, { platform: 'win32' });

    assert.notEqual(byDefault, asLiteralNode, 'the DEFAULT bake is NOT the bare literal `node` — a PATH lookup finds nothing on the real native host');
    assert.notEqual(byDefault, withInjection, 'and the default is not the injected fixture either — the option is genuinely read, not ignored');
    assert.match(
      byDefault,
      /"[^"\r\n]*(?:[A-Za-z]:\\|\/)[^"\r\n]*node[^"\r\n]*"/i,
      'the default bakes an ABSOLUTE interpreter path (process.execPath) — drive-letter or POSIX-rooted, but rooted'
    );
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
// SABOTAGE: default `nodeExe` to the string 'node' instead of process.execPath
// — notEqual(byDefault, asLiteralNode) goes red AND the absolute-path regex
// goes red (two assertions, one mutation: this is the ruling's core claim).
// SABOTAGE (option ignored): hardcode process.execPath and ignore the nodeExe
// option — includes(injected), quotedSpanContaining(injected) and
// notEqual(byDefault, withInjection) all go red.
// SABOTAGE (quoting): render the exe with its quotes stripped — the verbatim
// includes() still passes, only quotedSpanContaining goes red; that assertion
// is therefore load-bearing on its own, not defense in depth.

test('ensureUpdateLauncher on the native arm: the SAME sterling-update.bat filename, created → matches → differs, gitignore entry exactly once, hand-edit left byte-identical', () => {
  const clone = cloneWithBothTemplates();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  const opts = { platform: 'win32', nodeExe: 'C:\\Program Files\\nodejs\\node.exe' };
  try {
    assert.equal(
      UPDATE_LAUNCHER_NAME,
      'sterling-update.bat',
      'both arms generate the SAME filename — the generated marker, the .gitignore entry and init’s manifest item all key on it'
    );

    const created = ensureUpdateLauncher(target, clone, opts);
    assert.equal(created.status, 'created');
    assert.deepEqual(
      readdirSync(target).filter((f) => f.toLowerCase().endsWith('.bat')),
      [UPDATE_LAUNCHER_NAME],
      'the native arm adds no SECOND launcher under a different name — one file, two possible bodies'
    );

    const content = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.doesNotMatch(content, /\{\{/, 'nothing unrendered reaches disk');
    assert.match(content, quotedSpanContaining(opts.nodeExe), 'the baked exe reached disk quoted');
    const executable = execLines(content);
    assert.doesNotMatch(executable, /wsl/i, 'the delivered native launcher invokes no wsl.exe');
    assert.doesNotMatch(executable, /\bbash\b/i);
    assert.doesNotMatch(executable, /wt\.exe/i);

    assert.match(readFileSync(join(target, '.gitignore'), 'utf8'), /^sterling-update\.bat$/m, 'a machine artifact never surfaces as untracked noise');

    assert.equal(ensureUpdateLauncher(target, clone, opts).status, 'matches', 'idempotent on the native arm too');
    const entries = readFileSync(join(target, '.gitignore'), 'utf8').split(/\r?\n/).filter((l) => l === UPDATE_LAUNCHER_NAME);
    assert.equal(entries.length, 1, 'the gitignore entry is ensured exactly ONCE across both calls');

    writeFileSync(join(target, UPDATE_LAUNCHER_NAME), 'hand edited');
    assert.equal(ensureUpdateLauncher(target, clone, opts).status, 'differs');
    assert.equal(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), 'hand edited', 'a hand-edited native launcher is left byte-identical, never overwritten');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: give the native arm its own output filename (e.g. write
// `sterling-update-native.bat`) — the readdirSync deepEqual goes red, and the
// /^sterling-update\.bat$/m gitignore assertion goes red.
// SABOTAGE (ensure semantics): make the native arm always rewrite — the
// 'differs' assertion flips to 'refreshed'/'created' and the byte-identical
// hand-edit assertion goes red.
// SABOTAGE (gitignore): append the entry on every call instead of ensuring it —
// entries.length becomes 2 and that assertion goes red on its own.

test('a machine that SWITCHES ARMS is not stranded: an untouched WSL-generated launcher refreshes to the native body under win32, then settles at matches', () => {
  // The real migration this protects: a machine that installed under the WSL
  // arm and is re-initialised host-native. If the arm switch reported 'differs'
  // it would leave a wsl.exe launcher in place on a host with no WSL — the
  // exact capability loss ffe7c416 exists to end. Composed from the marker
  // semantics already pinned above (case 1: unmodified-since-generation +
  // changed render → refreshed); a red here is a genuine spec question for the
  // conductor, not a typo.
  const clone = cloneWithBothTemplates();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  try {
    assert.equal(ensureUpdateLauncher(target, clone, { platform: 'linux' }).status, 'created');
    assert.match(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), /wsl\.exe/i, 'control: the WSL arm really did land a wsl.exe launcher first');

    const switched = ensureUpdateLauncher(target, clone, { platform: 'win32', nodeExe });
    assert.equal(switched.status, 'refreshed', 'an untouched generated launcher follows the arm switch instead of reporting differs and stranding the host');

    const after = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.doesNotMatch(execLines(after), /wsl/i, 'the on-disk CONTENT actually became the native body, not merely the status string');
    assert.match(after, quotedSpanContaining(nodeExe));
    assert.doesNotMatch(after, /\{\{/);

    assert.equal(ensureUpdateLauncher(target, clone, { platform: 'win32', nodeExe }).status, 'matches', 'the marker stamped by the arm switch validates the body it wrote — no refresh loop');
    assert.equal(readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8'), after, 'content untouched on the matching re-run');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: compare the on-disk file against the render of the ORIGINALLY-USED
// template rather than the currently-selected one (i.e. ignore opts.platform in
// the ensure comparison) — the switch reports 'matches' immediately, so the
// 'refreshed' assertion goes red and the on-disk body keeps its wsl.exe.
// SABOTAGE (no marker re-stamp): refresh the body but leave the OLD marker —
// the final 'matches' assertion goes red (perpetual refresh loop).

test('a clone carrying ONLY the WSL template SKIPS on a win32 host, naming update-win-native.bat — never a thrown ENOENT, and never a silent WSL fallback', () => {
  const wslOnly = cloneWithTemplate(); // update-win.bat only — no native template
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    // CONTROL FIRST: the same clone and the same target CREATE on a non-win32
    // host. Without this, the skip below is equally explained by an unwritable
    // target, a broken clone, or an implementation that skips everything.
    assert.equal(ensureUpdateLauncher(target, wslOnly, { platform: 'linux' }).status, 'created', 'control: this clone and this target are perfectly usable on the WSL arm');
    rmSync(join(target, UPDATE_LAUNCHER_NAME));

    let result;
    assert.doesNotThrow(() => {
      result = ensureUpdateLauncher(target, wslOnly, { platform: 'win32' });
    }, 'a missing native template SKIPS — an unhandled ENOENT would abort the whole update fan-out');
    assert.equal(result.status, 'skipped');
    assert.match(
      JSON.stringify(result),
      /update-win-native\.bat/,
      'the skip detail names the template that was actually missing — naming update-win.bat (the one it happened to find) sends the reader to the wrong file'
    );
    assert.equal(
      existsSync(join(target, UPDATE_LAUNCHER_NAME)),
      false,
      'and nothing was written — a win32 host never silently falls back to the wsl.exe launcher it cannot run'
    );
  } finally {
    rmSync(wslOnly, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: fall back to update-win.bat when the native template is absent —
// status becomes 'created', the existsSync(...)===false assertion goes red, and
// the skip-detail assertion goes red. That fallback is the plausible "helpful"
// implementation and it reinstates the exact defect ffe7c416 closed.
// SABOTAGE (unguarded read): readFileSync the selected template without an
// existence check — assert.doesNotThrow goes red with ENOENT.
// SABOTAGE (wrong name in the detail): report the skip naming update-win.bat —
// only the JSON.stringify match goes red; that assertion is load-bearing alone.

test('the created native launcher is CRLF on disk end to end — the appended generated-marker line included', () => {
  // Isolated deliberately: a red here means the render or the marker append
  // used LF, and it must not mask the ensure-semantics pins above.
  const clone = cloneWithBothTemplates();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    assert.equal(ensureUpdateLauncher(target, clone, { platform: 'win32', nodeExe: 'C:\\Tools\\node.exe' }).status, 'created');
    const content = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.ok(content.includes('\r\n'), 'the delivered .bat has CRLF line endings');
    assert.doesNotMatch(
      content,
      /(^|[^\r])\n/,
      'no lone LF anywhere in the written .bat — including the generated-marker line ensureUpdateLauncher appends'
    );
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// SABOTAGE: append the generated-marker line with '\n' instead of '\r\n' — the
// lone-LF assertion goes red while every other native-arm test stays green.
// That is precisely the hole a render-only CRLF pin cannot see.
