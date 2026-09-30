// Consumer-machine update tests (decision foreign_e6240afe).
// Two halves, matching the two ways this can be wrong:
//   1. the REFUSAL matrix — read against real temp git repos (local file
//      remotes, no network), because "is this machine diverged?" is exactly the
//      question a hand-rolled answer got wrong;
//   2. the STEP ORDER — driven through an injected exec, so the ordering and the
//      conditional steps are asserted without an npm ci or a 90s battery.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readCurrency, refusalFor, isGeneratedTrackedPath, currencyLine, gitFrom, defaultExec, runUpdate, stampConsumerRoleIfAbsent, UPDATE_MARKER_RELATIVE_PATH, preScaleDownMarkers, reexecArgs, UPDATE_REEXEC_ENV, UPDATE_REEXEC_FROM_ENV } from '../lib/update.mjs';
import { BUNDLED_ARTIFACTS } from '../lib/bundled-artifacts.mjs';
import { ensureUpdateLauncher, renderUpdateLauncher, UPDATE_LAUNCHER_NAME } from '../lib/update-launcher.mjs';

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

function fakeExec({ behind = 0, ahead = 0, dirty = [], changed = [], failing = null, syncStatus = () => 0, syncStdout = null, contractStatus = 0, head = HEAD_A } = {}) {
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
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : head);
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
      return { status, stdout: syncStdout ?? (status === 0 ? 'up_to_date: coder\n' : 'coder: modified\n'), stderr: status ? 'REFUSED' : '' };
    }
    return ok('done');
  };
  return { exec, calls };
}

/** A cwd with no .sterling/config.json and no scripts/ — the optional steps skip loudly. */
function scratchCwd() {
  return mkdtempSync(join(tmpdir(), 'sterling-update-cwd-'));
}

/** Seed a completed-update marker as if a prior run finished IN FULL at `sha` —
 *  the only way "Already current" is a legitimate shortcut rather than a lie. */
function seedUpdateMarker(cwd, sha) {
  const p = join(cwd, UPDATE_MARKER_RELATIVE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ sha, completed_at: new Date().toISOString() }));
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

// REWRITTEN (scheduling rebuild, decision project-mode-hobby-work-toggle-decides-flow,
// Astra design review item 2): this pinned ZERO agent syncs on the already-current
// path — the dropped provisioning cache. The core is still not rebuilt; every
// registered target is now visited once (the generators preserve unchanged bytes).
test('already current: fetches, reports, runs no build, and visits each registered project once (exit 0)', async () => {
  const cwd = scratchCwd();
  try {
    // A legitimate shortcut requires proof the LAST run completed in full at
    // this exact head — without it, behind===0 alone must resume instead
    // (board 2b37272a claim A; see the halted-run/rerun tests below).
    seedUpdateMarker(cwd, HEAD_A);
    const { exec, calls } = fakeExec({ behind: 0 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(report.exit, 0);
    assert.ok(calls.some((c) => c.startsWith('git fetch')));
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0);
    assert.equal(calls.filter((c) => c.includes('merge --ff-only')).length, 0);
    assert.deepEqual(calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/p'], 'the one registered project is visited once');
    assert.equal(calls.filter((c) => c.includes('handoff-projection')).length, 0, 'a project with no config is hobby: no projection');
    assert.ok(lines.some((l) => l.includes('Already current — nothing to do for the core update')));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The per-project pass is part of every explicit update, so an unreadable registry
// on the already-current path is a visible failure, not a silent "Already current".
test('already current: an unreadable project registry is a visible non-zero failure, never "nothing to do"', async () => {
  const cwd = scratchCwd();
  try {
    seedUpdateMarker(cwd, HEAD_A);
    const { exec, calls } = fakeExec({ behind: 0 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: async () => { throw new Error('registry db locked'); }, opts: {} });
    assert.equal(report.exit, 2);
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0);
    const out = lines.join('\n');
    assert.match(out, /project registry .*unavailable.*registry db locked/);
    assert.ok(!lines.some((l) => l.includes('Already current — nothing to do')));
    // Residual (1): a failed registry must never leave reportCoverage([]) to run
    // — that would falsely call registered siblings unregistered, or print an
    // affirmative "ok" while the registry it depends on is unknown.
    assert.doesNotMatch(out, /ok — under these known roots/);
    assert.doesNotMatch(out, /NOT in the shared project registry/);
    assert.match(out, /registry coverage — SKIPPED.*coverage is UNKNOWN/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Residual (2): the refusal used to only say "see above" — name the registry
// path (resolved the same way loadProjects does) and the remedy, so the reader
// does not have to guess which file to fix.
test('an unreadable registry (not a module-load failure) names the registry path and remedy', async () => {
  const cwd = scratchCwd();
  try {
    seedUpdateMarker(cwd, HEAD_A);
    const { exec } = fakeExec({ behind: 0 });
    const lines = [];
    await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: async () => { throw new Error('EACCES: permission denied'); }, opts: {} });
    const out = lines.join('\n');
    assert.match(out, /registry\.db/, `expected the registry file path in the refusal:\n${out}`);
    assert.match(out, /Make it readable or unlocked, or restore it, then rerun \/sterling:update/);
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

// build:tui dropped from the sequence (lane S1: tui/sterling-tui.mjs is now a COMMITTED
// bundle, so a consumer rebuild would dirty the tracked file; check verifies its freshness).
test('behind: fast-forward then build → check → test, then the project fan-out; the committed TUI bundle is never rebuilt', async () => {
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
    assert.deepEqual(order.slice(0, 4), [
      'git merge --ff-only origin/main',
      'npm run build',
      'npm run check',
      'npm test',
    ]);
    assert.equal(calls.filter((c) => c.includes('build:tui') || c.includes('build:bundles')).length, 0, 'a consumer never rebuilds a committed bundle');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 2);
    assert.deepEqual(report.projects.map((p) => p.name), ['Deepdots', 'comsoft']);
    // no dependency change → npm ci must NOT run (it is the one networked step)
    assert.equal(calls.filter((c) => c === 'npm ci').length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// config_drift in the fan-out (decision 256d1059): a report, not a gate and not a
// change — the project stays exit 0, the drift line reaches the log verbatim
// (it carries the fix command), and it is not counted as a changed agent.
test('fan-out: a config_drift line is logged loudly, never counted as a change, never a failure', async () => {
  const cwd = scratchCwd();
  try {
    const driftLine = 'config_drift: implementor — installed model=a effort=low, config.models resolves model=b effort=high; NOT rewritten by sync — realize it with node scripts/install-agents.mjs (--target <dir> for a sibling), then restart the session';
    const { exec } = fakeExec({ behind: 1, changed: ['packages/store/src/index.ts'], syncStdout: `up_to_date: scout\n${driftLine}\n` });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'Dome', repo_path: '/tmp/dome' }], opts: {} });
    assert.equal(report.exit, 0, 'config_drift never fails the update');
    assert.equal(report.projects[0].changed, 0, 'config_drift wrote nothing, so it is not a changed agent');
    assert.equal(report.projects[0].config_drift, 1);
    const log = lines.join('\n');
    assert.ok(log.includes(driftLine), `the drift line is relayed verbatim:\n${log}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The auto-memory NOTICE (explicit non-false autoMemoryEnabled, kept, exit 0) must reach
// the /sterling:update log: its stdout status line is hyphenated, so the agent-status
// filter never saw it and the project printed "up to date". Relayed from stdout only
// (never also from stderr's NOTICE line), so it prints once.
test('fan-out: an auto-memory kept/wrong_type notice is relayed verbatim once, exit 0, not a change', async () => {
  const cwd = scratchCwd();
  try {
    const kept = 'auto-memory off: kept (autoMemoryEnabled is true in /tmp/dome/.claude/settings.json: left as a deliberate choice; Sterling projects run with auto-memory off (set it to false to comply))';
    const wrong = 'auto-memory off: wrong_type (autoMemoryEnabled is "false" in /tmp/rome/.claude/settings.json, not a boolean: left untouched; Sterling projects run with auto-memory off (set it to boolean false to comply))';
    for (const line of [kept, wrong]) {
      const { exec } = fakeExec({ behind: 1, changed: ['packages/store/src/index.ts'], syncStdout: `up_to_date: scout\nconductor activation: already\n${line}\n` });
      const lines = [];
      const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'Dome', repo_path: '/tmp/dome' }], opts: {} });
      assert.equal(report.exit, 0, 'a notice never fails the update');
      assert.equal(report.projects[0].changed, 0);
      const log = lines.join('\n');
      assert.equal(log.split(line).length - 1, 1, `the notice is relayed verbatim exactly once:\n${log}`);
      assert.ok(log.includes(`⚠ ${line}`), `relayed with the warning mark:\n${log}`);
    }
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

test('a failing check step still stops before the test battery and before sync (exit 1)', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1, failing: 'npm run check' });
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(report.exit, 1);
    assert.ok(calls.includes('npm run check'), 'the check step ran and failed');
    assert.equal(calls.filter((c) => c === 'npm test').length, 0, 'a red check must never even start the test battery');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0, 'a red check must still stop before sync — unlike a red test battery');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── decision update-red-test-battery-still-syncs-agents-skips-store-migration:
//    a RED test battery is the one failure that does NOT stop the sequence — it
//    skips store migration (the one irreversible step) but still syncs agents,
//    still exits non-zero, and never writes the completion marker ─────────────

test('a red test battery skips store migration (machine + per-project), still syncs agents, exits non-zero, writes no completion marker, and says so loudly', async () => {
  const cwd = scratchCwd();
  const projA = mkdtempSync(join(tmpdir(), 'sterling-update-proj-'));
  try {
    // A legacy (pre-v2) store at BOTH the machine level and a registered
    // project, so a passing run would migrate both.
    const machineStore = join(cwd, '.sterling', 'sterling.db');
    legacyStoreAt(machineStore);
    const projStore = join(projA, '.sterling', 'sterling.db');
    legacyStoreAt(projStore);

    const { exec, calls } = fakeExec({ behind: 1, failing: 'npm test' });
    const lines = [];
    const report = await runUpdate({
      cwd,
      exec,
      log: (m) => lines.push(m),
      projects: [{ name: 'ProjA', repo_path: projA }],
      opts: {},
    });
    const out = lines.join('\n');

    assert.equal(report.exit, 1, 'a red battery must exit 1 — the same code `step()` already sets on any step failure, never left at some other nonzero value');
    assert.ok(calls.includes('npm test'), 'the battery actually ran');
    assert.equal(
      calls.filter((c) => c.includes('migrate-stores.mjs')).length,
      0,
      'store migration (machine AND per-project) must be skipped on a red battery'
    );
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 1, 'agent sync must still run on a red battery');
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false, 'no completion marker on a red battery');
    assert.match(out, /test battery|TEST BATTERY/i, 'the failure names the red battery');
    assert.match(out, /migration.*skip|skip.*migration/i, 'the loud line names the skipped migration');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
  }
});

test('a green test battery run is unchanged: migration still runs (machine + per-project), sync runs, marker is written', async () => {
  const cwd = scratchCwd();
  const projA = mkdtempSync(join(tmpdir(), 'sterling-update-proj-'));
  try {
    const machineStore = join(cwd, '.sterling', 'sterling.db');
    legacyStoreAt(machineStore);
    const projStore = join(projA, '.sterling', 'sterling.db');
    legacyStoreAt(projStore);

    const { exec, calls } = fakeExec({ behind: 1 });
    const report = await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: [{ name: 'ProjA', repo_path: projA }],
      opts: {},
    });

    assert.equal(report.exit, 0);
    assert.ok(calls.includes('npm test'));
    assert.ok(calls.some((c) => c.includes('migrate-stores.mjs') && c.includes(machineStore)), 'machine store migration still runs');
    assert.ok(calls.some((c) => c.includes('migrate-stores.mjs') && c.includes(projStore)), 'project store migration still runs');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 1);
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), true, 'a green run still writes the completion marker');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
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

// AUTHORING MACHINE (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// point 5, user-ruled 2026-09-30 'Sync only'): work lands in this clone, so there is nothing to pull,
// and the check battery compares a committed projection against a store that is legitimately newer
// (the Dome Farmer incident). A ROLE branch, not a flag — the flag was rejected by
// already-current-requires-a-completion-marker-not-git-currency.
const REG_P = [{ name: 'p', repo_path: '/tmp/p' }];

function authoringCwd(role = 'authoring') {
  const cwd = mkdtempSync(join(tmpdir(), 'sterling-update-authoring-'));
  mkdirSync(join(cwd, '.sterling'), { recursive: true });
  if (role !== null) writeFileSync(join(cwd, '.sterling', 'config.json'), JSON.stringify({ machine_role: role }));
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'stamp-contract.mjs'), '// fixture\n');
  return cwd;
}

test('authoring role: no fetch/merge/build/check/test/migrate, syncs ONLY the invoking project, prints the loud line', async () => {
  const cwd = authoringCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 4 });
    const lines = [];
    const fanOut = [{ name: 'other', repo_path: '/tmp/other' }, { name: 'dome', repo_path: '/tmp/dome-farmer' }];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: fanOut, invokingProject: '/tmp/dome-farmer', opts: {} });

    assert.equal(report.exit, 0);
    for (const forbidden of ['git', 'npm', 'migrate-stores', 'init.mjs', 'handoff-projection']) {
      assert.deepEqual(calls.filter((c) => c.startsWith(forbidden) || c.includes(forbidden)), [], `no ${forbidden} call on the authoring machine`);
    }
    assert.deepEqual(calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/dome-farmer'], 'sync-agents gets the invoking project only — no fan-out');
    const contract = calls.filter((c) => c.includes('stamp-contract.mjs'));
    assert.equal(contract.length, 1);
    assert.match(contract[0], /--project \/tmp\/dome-farmer$/, 'stamp-contract is scoped to the invoking project');
    assert.doesNotMatch(contract[0], /--apply/, 'the existing dry-run posture is kept');
    assert.ok(lines.some((l) => l.includes('AUTHORING clone — nothing to pull; syncing /tmp/dome-farmer only')), 'the loud line names the project');
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false, 'the marker attests the full sequence, which did not run — never written');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: a stale marker does not matter, and a refused sync is exit 2 while contract drift stays tolerated', async () => {
  const cwd = authoringCwd();
  try {
    seedUpdateMarker(cwd, 'c'.repeat(40));
    const refused = fakeExec({ syncStatus: () => 2, contractStatus: 2 });
    const lines = [];
    const report = await runUpdate({ cwd, exec: refused.exec, log: (l) => lines.push(l), projects: REG_P, invokingProject: '/tmp/p', opts: {} });
    assert.equal(report.exit, 2, 'a locally modified agent is relayed as a refusal');
    assert.equal(report.contract_drift, true);
    assert.equal(refused.calls.filter((c) => c.startsWith('npm')).length, 0);
    assert.match(lines.join('\n'), /agent sync REFUSED/);

    const drift = fakeExec({ contractStatus: 2 });
    const r2 = await runUpdate({ cwd, exec: drift.exec, log: () => {}, projects: REG_P, invokingProject: '/tmp/p', opts: {} });
    assert.equal(r2.exit, 0, "a sibling's contract drift never fails the authoring sync");
    assert.equal(r2.contract_drift, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: --check changes nothing (no sync); a missing invoking project is a loud failure', async () => {
  const cwd = authoringCwd();
  try {
    const checked = fakeExec();
    const lines = [];
    const report = await runUpdate({ cwd, exec: checked.exec, log: (l) => lines.push(l), projects: [], invokingProject: '/tmp/p', opts: { check: true } });
    assert.equal(report.exit, 0);
    assert.deepEqual(checked.calls, [], '--check on the authoring machine runs nothing at all');
    assert.ok(lines.some((l) => l.includes('AUTHORING clone — nothing to pull')));

    const none = fakeExec();
    const r2 = await runUpdate({ cwd, exec: none.exec, log: () => {}, projects: [], opts: {} });
    assert.equal(r2.exit, 1);
    assert.deepEqual(none.calls, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: the invoking project must be REGISTERED — an unregistered cwd is a loud exit 2 with no sync', async () => {
  const cwd = authoringCwd();
  try {
    const { exec, calls } = fakeExec();
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: REG_P, invokingProject: '/tmp/not-a-project', opts: {} });
    assert.equal(report.exit, 2);
    assert.deepEqual(calls, [], 'nothing runs: no sync-agents, no stamp-contract');
    assert.match(lines.join('\n'), /\/tmp\/not-a-project/, 'the refusal names the directory it refused');
    assert.match(lines.join('\n'), /not (inside )?a registered project/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: a subdirectory of a registered project resolves to that project (longest match wins); CLAUDE_PROJECT_DIR beats cwd', async () => {
  const cwd = authoringCwd();
  try {
    const reg = [
      { name: 'outer', repo_path: '/tmp/work' },
      { name: 'inner', repo_path: '/tmp/work/inner' },
      { name: 'sibling', repo_path: '/tmp/work-other' },
    ];
    const sub = fakeExec();
    await runUpdate({ cwd, exec: sub.exec, log: () => {}, projects: reg, invokingProject: '/tmp/work/inner/src/deep', opts: {} });
    assert.deepEqual(sub.calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/work/inner'], 'the nearest registered ancestor, not the prefix sibling');

    const env = fakeExec();
    const report = await runUpdate({ cwd, exec: env.exec, log: () => {}, projects: reg, invokingProject: '/tmp/work-other', projectDir: '/tmp/work', opts: {} });
    assert.equal(report.exit, 0);
    assert.deepEqual(env.calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/work'], 'CLAUDE_PROJECT_DIR wins over cwd');

    const bad = fakeExec();
    const refused = await runUpdate({ cwd, exec: bad.exec, log: () => {}, projects: reg, invokingProject: '/tmp/work', projectDir: '/tmp/elsewhere', opts: {} });
    assert.equal(refused.exit, 2, 'a set-but-unregistered CLAUDE_PROJECT_DIR is refused, never silently replaced by cwd');
    assert.deepEqual(bad.calls, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: the clone itself (when registered) is synced but its contract files are not checked', async () => {
  const cwd = authoringCwd();
  try {
    const { exec, calls } = fakeExec();
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'sterling', repo_path: cwd }], invokingProject: cwd, opts: {} });
    assert.equal(report.exit, 0);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 1);
    assert.equal(calls.filter((c) => c.includes('stamp-contract')).length, 0, 'stamp-contract skips the clone silently, so it is not called');
    assert.match(lines.join('\n'), /the clone's contract files are hand-maintained — not checked/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: stamp-contract reporting "0 project(s) processed" for a registered non-clone project is a loud step failure', async () => {
  const cwd = authoringCwd();
  try {
    const inner = fakeExec();
    const exec = (cmd, args) =>
      args[0]?.endsWith('stamp-contract.mjs')
        ? { status: 0, stdout: 'DRY-RUN (no writes; pass --apply) — 0 project(s) processed, 0 already in sync, 0 refusal(s).\n', stderr: '' }
        : inner.exec(cmd, args);
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: REG_P, invokingProject: '/tmp/p', opts: {} });
    assert.equal(report.exit, 1);
    assert.match(lines.join('\n'), /stamp-contract checked NOTHING/);
    assert.equal(report.contract_unchecked, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('authoring role: --no-projects is a stated no-op; --force is stated as meaningless and the sync still runs', async () => {
  const cwd = authoringCwd();
  try {
    const off = fakeExec();
    const lines = [];
    const report = await runUpdate({ cwd, exec: off.exec, log: (l) => lines.push(l), projects: REG_P, invokingProject: '/tmp/p', opts: { projects: false } });
    assert.equal(report.exit, 0);
    assert.deepEqual(off.calls, [], '--no-projects syncs nothing on the authoring machine');
    assert.match(lines.join('\n'), /--no-projects: nothing synced/);

    const forced = fakeExec();
    const forcedLines = [];
    const r2 = await runUpdate({ cwd, exec: forced.exec, log: (l) => forcedLines.push(l), projects: REG_P, invokingProject: '/tmp/p', opts: { force: true } });
    assert.equal(r2.exit, 0);
    assert.match(forcedLines.join('\n'), /--force has no meaning on the authoring machine/);
    assert.equal(forced.calls.filter((c) => c.includes('sync-agents')).length, 1);
    assert.equal(forced.calls.filter((c) => c.startsWith('npm')).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('consumer and undeclared roles keep the full sequence unchanged (fetch, merge, build, check, test, fan-out)', async () => {
  for (const role of ['consumer', null]) {
    const cwd = authoringCwd(role);
    try {
      const { exec, calls } = fakeExec({ behind: 1 });
      const report = await runUpdate({ cwd, exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], invokingProject: '/tmp/dome-farmer', opts: {} });
      assert.equal(report.exit, 0);
      assert.ok(calls.some((c) => c.startsWith('git fetch')));
      assert.ok(calls.some((c) => c.includes('merge --ff-only')));
      for (const npm of ['npm run build', 'npm run check', 'npm test']) assert.ok(calls.includes(npm), `${role}: ${npm} runs`);
      assert.deepEqual(calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/p'], 'the registry fan-out, not the invoking project');
      assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), true);
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
    // REWRITTEN (scheduling rebuild): this pinned that a per-project sync refusal
    // WITHHELD the core marker, so the next behind-0 run could not report "Already
    // current" over an unresolved failure (board 2b37272a claim A). The marker now
    // attests the core only; claim A is kept by the per-project pass, which runs on
    // every update — the next run refuses the project again, loudly, without
    // rebuilding the core and without claiming "nothing to do".
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), true, 'the core update completed, so the core marker is stamped');
    const { exec: again, calls: againCalls } = fakeExec({ behind: 0, head: HEAD_B, syncStatus: (target) => (target === '/tmp/salesforce' ? 2 : 0) });
    const lines = [];
    const rerun = await runUpdate({ cwd, exec: again, log: (l) => lines.push(l), projects: [{ name: 'Salesforce', repo_path: '/tmp/salesforce' }, { name: 'comsoft', repo_path: '/tmp/comsoft' }], opts: {} });
    assert.equal(rerun.exit, 2, 'the unresolved refusal keeps the next run loud');
    assert.equal(againCalls.filter((c) => c.startsWith('npm')).length, 0, 'the core is not rebuilt');
    assert.equal(againCalls.filter((c) => c.includes('sync-agents')).length, 2, 'both projects are visited again');
    assert.ok(!lines.some((l) => l.includes('Already current — nothing to do')), 'never "nothing to do" over an unresolved refusal');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── board 2b37272a claim B: one sibling's store migration must not abort the
//    rest of the fan-out ────────────────────────────────────────────────────

test('a sibling project whose store migration fails: later projects still processed, agent sync still reached, exit non-zero with that project named', async () => {
  const cwd = scratchCwd();
  const projA = mkdtempSync(join(tmpdir(), 'sterling-update-proj-'));
  const projB = mkdtempSync(join(tmpdir(), 'sterling-update-proj-'));
  try {
    const storeA = join(projA, '.sterling', 'sterling.db');
    const storeB = join(projB, '.sterling', 'sterling.db');
    legacyStoreAt(storeA);
    legacyStoreAt(storeB);
    // `failing` matches on substring, and mkdtemp gives each project a unique
    // absolute path, so this fails ONLY ProjA's migration call.
    const { exec, calls } = fakeExec({ behind: 1, failing: storeA });
    const report = await runUpdate({
      cwd,
      exec,
      log: () => {},
      projects: [
        { name: 'ProjA', repo_path: projA },
        { name: 'ProjB', repo_path: projB },
      ],
      opts: {},
    });

    assert.notEqual(report.exit, 0, 'a migration failure must surface as a non-zero exit, never be swallowed');
    assert.ok(calls.some((c) => c.includes('migrate-stores.mjs') && c.includes(storeA)), 'ProjA migration was attempted');
    assert.ok(calls.some((c) => c.includes('migrate-stores.mjs') && c.includes(storeB)), 'ProjB migration was attempted too — the failure did not abort the loop');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 2, 'agent sync still reached for BOTH projects');
    const failed = report.migrations.find((m) => m.name === 'ProjA');
    const okOne = report.migrations.find((m) => m.name === 'ProjB');
    assert.ok(failed && failed.ok === false, 'the failing project is named in the report');
    assert.ok(okOne && okOne.ok === true, 'the succeeding project is named too');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projA, { recursive: true, force: true });
    rmSync(projB, { recursive: true, force: true });
  }
});

// ── board 2b37272a claim A: "Already current" must prove the LAST run
//    completed the post-merge sequence, not merely that git is current ──────

test('a halted post-merge run leaves no completion marker, so a rerun at behind=0 resumes into the full sequence instead of reporting Already current', async () => {
  const cwd = scratchCwd();
  try {
    const first = fakeExec({ behind: 1, failing: 'npm run build' });
    const firstReport = await runUpdate({ cwd, exec: first.exec, log: () => {}, projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });
    assert.equal(firstReport.exit, 1, 'the halted run reports failure');
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false, 'a halted run must not leave a completion marker');

    const lines = [];
    // The halted run already fast-forwarded HEAD to HEAD_B before failing
    // (board 2b37272a claim A) — the rerun sees that as its current head.
    const second = fakeExec({ behind: 0, head: HEAD_B });
    const secondReport = await runUpdate({ cwd, exec: second.exec, log: (m) => lines.push(m), projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {} });

    assert.equal(secondReport.exit, 0);
    assert.ok(!lines.some((l) => l.includes('Already current — nothing to do')), 'a resumed run must never report Already current');
    assert.ok(lines.some((l) => /resuming/i.test(l)), 'the resume must announce itself loudly (P5)');
    assert.ok(second.calls.includes('npm run build'), 'the rerun reaches the build step');
    assert.ok(second.calls.includes('npm run check'));
    assert.ok(second.calls.includes('npm test'));
    assert.equal(second.calls.filter((c) => c.includes('sync-agents')).length, 1, 'and reaches agent sync');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a completed run followed by a rerun with no new commits still reports Already current — the happy path is unaffected', async () => {
  const cwd = scratchCwd();
  try {
    const first = fakeExec({ behind: 1 });
    const firstReport = await runUpdate({ cwd, exec: first.exec, log: () => {}, projects: [], opts: {} });
    assert.equal(firstReport.exit, 0, 'the first run completes cleanly');
    assert.equal(
      JSON.parse(readFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), 'utf8')).sha,
      HEAD_B,
      'a clean run stamps the sha it finished at'
    );

    const lines = [];
    const second = fakeExec({ behind: 0, head: HEAD_B });
    const secondReport = await runUpdate({ cwd, exec: second.exec, log: (m) => lines.push(m), projects: [], opts: {} });

    assert.equal(secondReport.exit, 0);
    assert.ok(lines.some((l) => l.includes('Already current — nothing to do')), 'the marker matches HEAD, so the shortcut is legitimate');
    assert.equal(second.calls.filter((c) => c.startsWith('npm')).length, 0, 'no rebuild when the marker matches HEAD');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a corrupt/unreadable completion marker degrades to a full resume, never to Already current, and announces the degradation', async () => {
  const cwd = scratchCwd();
  try {
    mkdirSync(join(cwd, '.sterling'), { recursive: true });
    writeFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), '{ not valid json');

    const lines = [];
    const { exec, calls } = fakeExec({ behind: 0, head: HEAD_B });
    const report = await runUpdate({ cwd, exec, log: (m) => lines.push(m), projects: [], opts: {} });

    assert.equal(report.exit, 0);
    assert.ok(!lines.some((l) => l.includes('Already current — nothing to do')), 'a corrupt marker must never be trusted as proof of completion');
    assert.ok(lines.some((l) => /corrupt\/unreadable/i.test(l)), 'the degradation is announced loudly, never silent');
    assert.ok(calls.includes('npm run build'), 'a corrupt marker degrades to a full resume, not a skip');
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

// ── 3. machine-role stamp (todo cabbc10f, decision foreign_a9b98b7d) ────────────────

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
    // Same reason as the "already current" test above: the shortcut is only
    // legitimate with a marker proving the last run finished at this head.
    seedUpdateMarker(dir, HEAD_A);

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
// decision foreign_a9b98b7d (the original hooks/architecture.md split this extends).
// -----------------------------------------------------------------------------

test('every tracked file under every registered bundle family (hooks, bin, mcp, tui) gets the discard remedy, never SOURCE CHANGES', () => {
  // The plugin ships bin/, mcp/ and tui/ bundles committed beside hooks/; a dirty
  // one on a consumer clone must draw "discard", exactly like a hook bundle.
  // Iterates the REGISTRY and git's own file list, so a new family fails here
  // until GENERATED_TRACKED covers it.
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.deepEqual(BUNDLED_ARTIFACTS.map((a) => a.name).sort(), ['bin', 'hooks', 'mcp', 'tui']);
  for (const a of BUNDLED_ARTIFACTS) {
    const r = spawnSync('git', ['ls-files', '--', a.shipped], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const files = r.stdout.split('\n').filter(Boolean)
      // hooks/ also holds AUTHORED files (hooks.json, the registry; README.md) — only its .mjs are bundles
      .filter((f) => !(a.name === 'hooks' && !f.endsWith('.mjs')));
    assert.ok(files.length > 0, `${a.name}: tracked files under ${a.shipped}`);
    for (const f of files) {
      assert.ok(isGeneratedTrackedPath(f), `${a.name}: ${f} is classified as a generated build output`);
      const c = refusalFor({ ...cleanCurrency(), dirty_tracked: [` M ${f}`] });
      assert.match(c, /COMMITTED BUILD OUTPUTS — discard these, always/, f);
      assert.doesNotMatch(c, /SOURCE CHANGES/, f);
    }
  }
  assert.equal(isGeneratedTrackedPath('hooks/hooks.json'), false, 'the hand-maintained hook registry stays source');
  assert.equal(isGeneratedTrackedPath('hooks/README.md'), false, 'authored hooks/ prose stays source');
  assert.equal(isGeneratedTrackedPath('.claude-plugin/sterling-mcp.json'), false, 'the committed MCP config is authored, not generated');
});

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
  // a .git marks an AUTHORING clone; without one the root reads as an installed plugin
  // copy and ensureUpdateLauncher skips (scripts/lib/installed-copy.mjs)
  mkdirSync(join(clone, '.git'));
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

// ── 6. the WSL updater launcher is the ONLY arm ─────────────────────────────
//
// The native-Windows update arm (templates/update-win-native.bat, rendered on a
// win32 host) is RETIRED by decision gap-hunt-2026-09-28-rulings item (11b),
// extending native-windows-launcher-retired-wsl2-only: Sterling runs under WSL2
// everywhere. Its dedicated pins were deleted with it; the assertions that
// pinned SURVIVING behaviour (the shipped template renders clean and CRLF, the
// delivered file stays CRLF with the marker line appended) are ported below
// onto the one remaining arm. The WSL-arm ensure semantics (created / matches /
// differs / skipped, the gitignore entry exactly once, an ext4 path passed
// through unchanged) are pinned in section 5 above.

/** repo root — these pins render the REAL shipped template, not a fixture,
 *  because a fixture cannot catch a placeholder the SHIPPED template forgot. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('the native-Windows update arm is gone: no update-win-native.bat ships and the launcher module exports no platform switch', async () => {
  assert.equal(existsSync(join(REPO_ROOT, 'templates', 'update-win-native.bat')), false, 'the retired native template is not shipped');
  const mod = await import('../lib/update-launcher.mjs');
  assert.equal(mod.updateTemplateName, undefined, 'no platform-based template selection survives');
  assert.equal(mod.UPDATE_TEMPLATE_NATIVE, undefined, 'no native template name survives');
});

test('the SHIPPED WSL template renders clean: no placeholder survives, it routes through wsl.exe + bash scripts/update-console.sh, CRLF throughout', () => {
  const rendered = renderUpdateLauncher(REPO_ROOT);
  assert.doesNotMatch(rendered, /\{\{/, 'NO placeholder survives the render — a .bat containing `{{...}}` runs a program with that literal name');
  assert.match(rendered, /wsl\.exe/i);
  assert.match(rendered, /\bbash\b/i);
  assert.match(rendered, /scripts\/update-console\.sh/);
  assert.ok(rendered.includes('\r\n'), 'the render is CRLF, as a .bat must be');
  assert.doesNotMatch(rendered, /(^|[^\r])\n/, 'every line is CRLF — a lone LF in a .bat is a cmd.exe parsing hazard');
});
// PORTED from the retired native-arm render pin: the placeholder and CRLF
// assertions pinned the shared render path, not the native template.

test('the created launcher is CRLF on disk end to end — the appended generated-marker line included', () => {
  const clone = cloneWithTemplate();
  const target = mkdtempSync(join(tmpdir(), 'sterling-launcher-target-'));
  try {
    assert.equal(ensureUpdateLauncher(target, clone).status, 'created');
    const content = readFileSync(join(target, UPDATE_LAUNCHER_NAME), 'utf8');
    assert.ok(content.includes('\r\n'), 'the delivered .bat has CRLF line endings');
    assert.doesNotMatch(content, /(^|[^\r])\n/, 'no lone LF anywhere in the written .bat — including the generated-marker line ensureUpdateLauncher appends');
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
// PORTED from the retired native-arm CRLF-on-disk pin, which ran the shared
// crlf(stampBody(...)) path through the native template only.
// SABOTAGE: append the generated-marker line with '\n' instead of '\r\n' — the
// lone-LF assertion goes red.

// Handoff projection in the fan-out (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections): it runs once
// per project after the agent sync. A REFUSED run (exit 2 — a secondary store) is a
// standing state of that project: loud, never fatal. A run that failed part-way
// (exit 1) may have left an incomplete export: the update exits non-zero, and the
// next run — which refreshes every registered project — projects it again.
// The projection is WORK-ONLY (decision project-mode-hobby-work-toggle-decides-flow):
// the fan-out reads each project's own config.mode before running it, so the
// projects below are real temp dirs declaring mode 'work' (the hobby skip is pinned
// in project-mode-gating.test.mjs). `provisioned` seeds the portable agent set and
// the handoff indexes a completed run would have left.
const workProjects = [];
function workProject(name, { provisioned = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work' }));
  if (provisioned) {
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    for (const name of ['implementor', 'researcher', 'scout']) writeFileSync(join(dir, '.opencode', 'agents', `${name}.md`), 'x\n');
    for (const f of ['architecture.md', 'rulings.md']) writeFileSync(join(dir, f), 'x\n');
  }
  workProjects.push(dir);
  return dir;
}
after(() => { for (const d of workProjects) rmSync(d, { recursive: true, force: true }); });

test('fan-out: the handoff projection runs per project; a refusal is loud but not fatal, a failure is non-zero and re-projected on the next run', async () => {
  const run = async (statuses, { rerun = false } = {}) => {
    const cwd = scratchCwd();
    try {
      const { exec: base, calls } = fakeExec({ behind: 2, changed: ['packages/store/src/index.ts'] });
      const exec = (cmd, args, o) => {
        if (!args[0]?.endsWith('handoff-projection.mjs')) return base(cmd, args, o);
        calls.push(`${cmd} ${args.join(' ')}`);
        const status = statuses[args[1]];
        const stdout = { 0: 'handoff projection: unchanged — 3 record(s)\n', 1: 'handoff projection: FAILED — the export is INCOMPLETE\n', 2: "handoff projection: REFUSED — store_authority is 'secondary'\n" }[status];
        return { status, stdout, stderr: '' };
      };
      const lines = [];
      const projects = Object.keys(statuses).map((repo_path) => ({ name: repo_path.split('/').pop(), repo_path }));
      const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects, opts: {} });
      const markerPresent = existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH));
      let next = null;
      if (rerun) {
        const { exec: nextBase, calls: nextCalls } = fakeExec({ behind: 0, head: HEAD_B });
        const nextExec = (cmd, args, o) => {
          if (!args[0]?.endsWith('handoff-projection.mjs')) return nextBase(cmd, args, o);
          nextCalls.push(`${cmd} ${args.join(' ')}`);
          return { status: statuses[args[1]], stdout: 'handoff projection: FAILED — the export is INCOMPLETE\n', stderr: '' };
        };
        const nextLines = [];
        const nextReport = await runUpdate({ cwd, exec: nextExec, log: (l) => nextLines.push(l), projects, opts: {} });
        next = { report: nextReport, calls: nextCalls, log: nextLines.join('\n') };
      }
      return { report, calls, log: lines.join('\n'), markerPresent, next };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  const refusedOnly = await run({ [workProject('handoff-ok')]: 0, [workProject('handoff-secondary')]: 2 });
  assert.equal(refusedOnly.calls.filter((c) => c.includes('handoff-projection.mjs')).length, 2);
  assert.deepEqual(refusedOnly.report.projects.map((p) => p.handoff), [0, 2]);
  assert.equal(refusedOnly.report.exit, 0, 'a refused projection does not fail the update');
  assert.match(refusedOnly.log, /⚠ handoff projection: REFUSED — store_authority is 'secondary'/);
  assert.doesNotMatch(refusedOnly.log, /handoff projection: unchanged/, 'an unchanged projection stays quiet');

  const failed = await run({ [workProject('handoff-broken')]: 1 }, { rerun: true });
  assert.equal(failed.report.exit, 1, 'an incomplete export fails the update');
  assert.match(failed.log, /✗ handoff projection FAILED \(exit 1\) — the export may be INCOMPLETE/);
  // REWRITTEN (scheduling rebuild): this pinned that the part-way failure WITHHELD
  // the core marker, which was how the failed export got retried. The marker now
  // attests the core only (the core did complete); the retry is the per-project
  // pass that every update runs. The property Sol's LOW re-check protected —
  // the incomplete export is never left unretried and never reported as done — is
  // pinned directly on the next run instead.
  assert.equal(failed.markerPresent, true, 'the core completed, so the core marker is stamped');
  assert.equal(failed.next.calls.filter((c) => c.startsWith('npm')).length, 0, 'the next run does not rebuild the core');
  assert.equal(failed.next.calls.filter((c) => c.includes('handoff-projection.mjs')).length, 1, 'the next run projects the broken export again');
  assert.equal(failed.next.report.exit, 1, 'and stays non-zero while it still fails');
  assert.doesNotMatch(failed.next.log, /Already current — nothing to do/);
  assert.equal(refusedOnly.markerPresent, true, 'control: a standing refusal alone still completes the update');
});

// Sol re-check MEDIUM (update wedge): an ACTIONABLE handoff conflict (exit 3) is a
// per-project failure, not a failure of the clone update — the core marker is
// stamped regardless, so the core is never rebuilt on its account.
// REWRITTEN (scheduling rebuild, decision project-mode-hobby-work-toggle-decides-flow,
// Astra design review item 2): this pinned the retry-set mechanics — handoff_retry
// in the marker, "A retried first", "only B re-synced", and ZERO calls once the
// set emptied. The retry set is gone: every run visits every registered target
// once, so the behaviours are pinned directly — no wedge, the stuck project stays
// loud without blocking the other, and it clears when fixed.
test('fan-out: an actionable handoff conflict does not wedge the update or block another project, and clears once fixed', async () => {
  const cwd = scratchCwd();
  const A = workProject('handoff-stuck');
  const B = workProject('handoff-fine');
  try {
    const runOnce = async ({ behind, statuses, registered = [A, B] }) => {
      // after run 1 fast-forwarded to HEAD_B, an already-current run sits at HEAD_B
      const { exec: base, calls } = fakeExec({ behind, changed: ['packages/store/src/index.ts'], head: behind ? HEAD_A : HEAD_B });
      const exec = (cmd, args, o) => {
        if (!args[0]?.endsWith('handoff-projection.mjs')) return base(cmd, args, o);
        calls.push(`${cmd} ${args.join(' ')}`);
        const status = statuses[args[1]] ?? 0;
        const stdout = status === 3
          ? 'handoff projection: REFUSED — architecture.md exists and was not generated by Sterling — move or rename it, then rerun.\n'
          : 'handoff projection: written — 3 record(s)\n';
        return { status, stdout, stderr: '' };
      };
      const lines = [];
      const projects = registered.map((repo_path) => ({ name: repo_path.split('/').pop(), repo_path }));
      const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects, opts: {} });
      return { report, calls, log: lines.join('\n'), handoffCalls: calls.filter((c) => c.includes('handoff-projection.mjs')), syncCalls: calls.filter((c) => c.includes('sync-agents')) };
    };
    const targets = (cs) => cs.map((c) => c.split(' ').pop());

    // 1) a full update: B is fine, A has an actionable conflict
    const first = await runOnce({ behind: 2, statuses: { [A]: 3 } });
    assert.equal(first.report.exit, 2, 'loud: the update reports the unresolved project');
    assert.ok(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), 'the core update is stamped complete regardless');
    assert.match(first.log, /cannot be repaired.*--prune-missing.*store_authority/s, 'names the unregister / retire remedy');
    assert.deepEqual(targets(first.handoffCalls), [A, B]);

    // 2) already current, A still stuck: both are visited once, B is not blocked,
    // and the core sequence is not repeated.
    const second = await runOnce({ behind: 0, statuses: { [A]: 3 } });
    assert.deepEqual(targets(second.handoffCalls), [A, B], 'each target projected once, in registry order');
    assert.deepEqual(targets(second.syncCalls), [A, B], 'each target synced once');
    assert.equal(second.calls.filter((c) => c.startsWith('npm ')).length, 0, 'the core sequence is not repeated');
    assert.equal(second.report.exit, 2);
    assert.match(second.log, /cannot be repaired/);
    assert.doesNotMatch(second.log, /Already current — nothing to do/);

    // 3) A is fixed: the run is clean and says the core is already current
    const third = await runOnce({ behind: 0, statuses: {} });
    assert.deepEqual(targets(third.handoffCalls), [A, B]);
    assert.equal(third.report.exit, 0);
    assert.match(third.log, /Already current — nothing to do for the core update/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// REWRITTEN (scheduling rebuild): this pinned that a retry-set entry for a project
// that left the registry was dropped from the marker's handoff_retry. There is no
// retry set now; the behaviour it protected — an unregistered project is never
// touched — is pinned directly, including through an OLD marker that still names it.
test('fan-out: a project that left the registry is not visited, even when an old marker still names it', async () => {
  const cwd = scratchCwd();
  const A = workProject('handoff-retired');
  try {
    mkdirSync(join(cwd, '.sterling'), { recursive: true });
    writeFileSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH), JSON.stringify({ sha: HEAD_B, completed_at: new Date().toISOString(), handoff_retry: [A], project_retry: [A], projects: { [A]: { mode: 'work', head: HEAD_B, outcome: 'ok', config: 'x' } } }));
    const { exec: current, calls } = fakeExec({ behind: 0, head: HEAD_B });
    const lines = [];
    const report = await runUpdate({ cwd, exec: current, log: (l) => lines.push(l), projects: [], opts: {} });
    assert.equal(calls.filter((c) => c.includes(A)).length, 0, 'nothing runs against the unregistered project');
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0, 'the old marker still proves the core is complete');
    assert.equal(report.exit, 0);
    assert.match(lines.join('\n'), /Already current — nothing to do for the core update/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


// Sol review of the scheduling rebuild, HIGH: the CLI's registry loader used to
// swallow an unloadable @sterling/store and hand runUpdate an EMPTY project list,
// so an already-current update printed "Already current" and exited 0 while no
// registered project was refreshed. Pinned at the CLI seam: the REAL
// scripts/update.mjs runs against a temp clone that is current with a matching
// core marker, with @sterling/store made unresolvable by a module hook.
test('CLI: an unloadable @sterling/store is a visible exit 2 on the already-current path, never a false empty registry', () => {
  const work = mkdtempSync(join(tmpdir(), 'sterling-update-cli-'));
  try {
    const git = (cwd, ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const seed = join(work, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q');
    writeFileSync(join(seed, '.gitignore'), '.sterling/\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(work, 'clone', '-q', '--bare', seed, 'origin.git');
    git(work, 'clone', '-q', join(work, 'origin.git'), 'clone');
    const clone = join(work, 'clone');
    mkdirSync(join(clone, '.sterling'), { recursive: true });
    writeFileSync(join(clone, UPDATE_MARKER_RELATIVE_PATH), JSON.stringify({ sha: git(clone, 'rev-parse', 'HEAD'), completed_at: new Date().toISOString() }));
    const hook = join(work, 'block-store.mjs');
    const resolver = `export async function resolve(s, c, n) { if (s === '@sterling/store') { const e = new Error("Cannot find package '@sterling/store' (test: made unloadable)"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; } return n(s, c); }`;
    writeFileSync(hook, `import { register } from 'node:module';\nregister('data:text/javascript,' + encodeURIComponent(${JSON.stringify(resolver)}));\n`);

    const r = spawnSync(process.execPath, ['--import', hook, join(dirname(fileURLToPath(import.meta.url)), '..', 'update.mjs'), '--target', clone, '--no-fetch', '--no-test'], { encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 2, out);
    assert.doesNotMatch(out, /Already current/, 'no registered project was refreshed, so the run must not read as current');
    assert.match(out, /project registry unavailable.*@sterling\/store/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// Both paths treat project-list resolution the same way: the full path used to
// let a registry throw reject runUpdate outright. On the full path the marker is
// WITHHELD: the per-project store migrations (schema changes) could not run, so
// they must not be lost behind a stamped marker — the next update resumes the
// full sequence, migrations included.
test('full path: a project registry that cannot be read is exit 2 and withholds the completion marker', async () => {
  const cwd = scratchCwd();
  try {
    const { exec, calls } = fakeExec({ behind: 1 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: async () => { throw new Error('registry db locked'); }, opts: {} });
    assert.equal(report.exit, 2);
    const out = lines.join('\n');
    assert.match(out, /project registry .*unavailable.*registry db locked/);
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0);
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false, 'the per-project migrations never ran, so the marker is withheld');
    assert.ok(!lines.some((l) => l.includes('Already current')));
    // Residual (1) — same guarantee on the full path's reportCoverage call.
    assert.doesNotMatch(out, /ok — under these known roots/);
    assert.doesNotMatch(out, /NOT in the shared project registry/);
    assert.match(out, /registry coverage — SKIPPED.*coverage is UNKNOWN/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// PORTED from init-ensure's F3a when the native launcher was retired (decision
// native-windows-launcher-retired-wsl2-only): the stamp must sit on LINE 2,
// after `@echo off`, or every double-click echoes the marker; and it must carry
// the content hash that lets a later ensure tell stale-but-unmodified from
// hand-edited. sterling-update.bat is the stamp's surviving .bat consumer.
test('sterling-update.bat keeps `@echo off` on line 1 and the rem-commented content_hash stamp on line 2', () => {
  const lines = renderUpdateLauncher(REPO_ROOT).split(/\r?\n/);
  assert.match(lines[0], /^@echo off/i, 'line 1 still turns echo off — the stamp must sit AFTER it');
  assert.match(lines[1], /^rem sterling-generated\b.*\bcontent_hash=[0-9a-f]{64}\s*$/, 'line 2 is the rem-commented stamp carrying a sha256 content hash');
});

// ── 7. re-exec of the NEW updater after the fast-forward (decision
//        gap-hunt-2026-09-28-rulings item 9) ────────────────────────────────
// The post-merge steps used to run in the OLD code already loaded into this
// process, so an upgrading machine needed a second run before the new update
// logic applied. After a successful fast-forward the updater now hands off to
// the NEW scripts/update.mjs exactly once (guarded by an env flag) and that
// child's exit is the update's exit. A re-exec that cannot run is loud (P5).

/** A scratch clone carrying a scripts/update.mjs, so the re-exec target exists. */
function scratchCloneWithUpdater() {
  const cwd = scratchCwd();
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'update.mjs'), '// placeholder updater\n');
  return cwd;
}

test('re-exec: after a fast-forward the NEW updater runs once and its exit is the update exit; the old process runs no build', async () => {
  const cwd = scratchCloneWithUpdater();
  try {
    const { exec, calls } = fakeExec({ behind: 2, changed: ['scripts/lib/update.mjs'] });
    const reexecCalls = [];
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'p', repo_path: '/tmp/p' }], opts: {}, reexec: (script) => { reexecCalls.push(script); return { status: 3, signal: null }; } });
    assert.deepEqual(reexecCalls, [join(cwd, 'scripts', 'update.mjs')], 'the NEW updater in the fast-forwarded clone is re-executed exactly once');
    assert.equal(report.exit, 3, "the child's exit is the update's exit");
    assert.equal(calls.filter((c) => c.includes('merge --ff-only')).length, 1, 'the fast-forward itself ran in the old process');
    assert.equal(calls.filter((c) => c.startsWith('npm')).length, 0, 'no build, check or test runs in the OLD code');
    assert.equal(calls.filter((c) => c.includes('sync-agents')).length, 0, 'no agent sync runs in the OLD code');
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false, 'the old process never writes the completion marker');
    assert.match(lines.join('\n'), /re-running the UPDATED updater/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('re-exec: a spawn error, a signal or a missing updater is a LOUD exit-1 failure, never a silent success', async () => {
  const cases = [
    { name: 'spawn error', result: { status: null, error: new Error('spawn ENOENT') }, pattern: /spawn ENOENT/ },
    { name: 'signal', result: { status: null, signal: 'SIGKILL' }, pattern: /SIGKILL/ },
  ];
  for (const c of cases) {
    const cwd = scratchCloneWithUpdater();
    try {
      const { exec } = fakeExec({ behind: 1 });
      const lines = [];
      const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [], opts: {}, reexec: () => c.result });
      assert.equal(report.exit, 1, `${c.name}: exit 1`);
      const out = lines.join('\n');
      assert.match(out, /✗ RE-EXEC of the updated updater FAILED/, `${c.name}: loud`);
      assert.match(out, c.pattern, `${c.name}: names the cause`);
      assert.match(out, /rerun \/sterling:update/, `${c.name}: names the remedy`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  const bare = scratchCwd(); // no scripts/update.mjs after the fast-forward
  try {
    const { exec } = fakeExec({ behind: 1 });
    const lines = [];
    let called = false;
    const report = await runUpdate({ cwd: bare, exec, log: (l) => lines.push(l), projects: [], opts: {}, reexec: () => { called = true; return { status: 0 }; } });
    assert.equal(called, false, 'a missing updater is never spawned');
    assert.equal(report.exit, 1);
    assert.match(lines.join('\n'), /✗ RE-EXEC of the updated updater FAILED.*not found/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('re-exec: no fast-forward (already current, or resuming a halted run) never re-executes; no reexec hook (the guarded child) runs the full sequence itself', async () => {
  const cwd = scratchCloneWithUpdater();
  try {
    const { exec, calls } = fakeExec({ behind: 0 });
    let called = 0;
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: [], opts: {}, reexec: () => { called++; return { status: 0 }; } });
    assert.equal(called, 0, 'behind 0 resumes in-process: the code on disk IS the code running');
    assert.equal(report.exit, 0);
    assert.ok(calls.includes('npm run build'), 'the resumed sequence ran in this process');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const child = scratchCloneWithUpdater();
  try {
    const { exec, calls } = fakeExec({ behind: 1 });
    const report = await runUpdate({ cwd: child, exec, log: () => {}, projects: [], opts: {} });
    assert.equal(report.exit, 0);
    assert.ok(calls.includes('npm run build'), 'with no reexec hook the sequence runs in-process, exactly as before');
  } finally {
    rmSync(child, { recursive: true, force: true });
  }
});

// END TO END through the real CLI and real git: the fast-forward brings in a
// scripts/update.mjs that reports how it was started. The CLI must hand off to
// THAT file (the new code), with the guard flag set and --no-fetch appended,
// and exit with its status.
test('re-exec through the real CLI: the fast-forwarded scripts/update.mjs runs once, guarded, and its exit is the CLI exit', () => {
  const { dir, author, consumer } = makeClonePair();
  try {
    mkdirSync(join(author, 'scripts'), { recursive: true });
    writeFileSync(
      join(author, 'scripts', 'update.mjs'),
      "console.log(`NEW UPDATER guard=${process.env.STERLING_UPDATE_REEXEC} from=${process.env.STERLING_UPDATE_REEXEC_FROM} args=${process.argv.slice(2).join(' ')}`);\nprocess.exit(7);\n"
    );
    const preMergeHead = git(consumer, ['rev-parse', 'HEAD']);
    git(author, ['add', '-A']);
    git(author, ['commit', '-m', 'ship a new updater']);
    git(author, ['push', 'origin', 'main']);
    // A RELATIVE --target (review LOW-1): the child runs with cwd = the target, so
    // a relative path would resolve against the wrong directory there. The CLI is
    // started from the pair's parent dir, where 'consumer' is relative.
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'update.mjs'), '--target', 'consumer', '--no-projects'], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, STERLING_UPDATE_REEXEC: '', STERLING_UPDATE_REEXEC_FROM: '' } });
    assert.equal(r.status, 7, `the child's exit is the CLI exit:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /re-running the UPDATED updater/);
    assert.ok(
      r.stdout.includes(`NEW UPDATER guard=1 from=${preMergeHead} args=--target ${consumer} --no-projects --no-fetch`),
      `the child gets the guard, the PRE-merge head (review HIGH-1) and an ABSOLUTE --target (LOW-1):\n${r.stdout}`
    );
    assert.equal((r.stdout.match(/NEW UPDATER/g) ?? []).length, 1, 'handed off exactly once');
    assert.doesNotMatch(r.stdout, /npm run build/, 'the old process ran no build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reexecArgs: the child skips the fetch the parent already did and keeps every other flag; the env guard names one variable', () => {
  assert.deepEqual(reexecArgs(['--force', '--no-test'], { target: '/abs/clone' }), ['--force', '--no-test', '--no-fetch']);
  assert.deepEqual(reexecArgs(['--no-fetch', '--target', '/x'], { target: '/x' }), ['--no-fetch', '--target', '/x'], 'never doubled');
  // review LOW-1: the child's cwd is the target, so a relative --target is rewritten to the resolved absolute path
  assert.deepEqual(reexecArgs(['--target', 'rel/clone', '--no-test'], { target: '/home/u/rel/clone' }), ['--target', '/home/u/rel/clone', '--no-test', '--no-fetch']);
  assert.equal(UPDATE_REEXEC_ENV, 'STERLING_UPDATE_REEXEC');
  assert.equal(UPDATE_REEXEC_FROM_ENV, 'STERLING_UPDATE_REEXEC_FROM');
});

// Review HIGH-1: the child starts AFTER the fast-forward, so its own before.head
// already equals after.head — without the parent's pre-merge head it computes
// an empty changed set, skips npm ci even when package-lock.json moved, and loses
// the "N file(s) changed" line. Driven through the exec seam: the parent's reexec
// hook runs the child's runUpdate the way the CLI would, handing over `from`.
test('re-exec: the child diffs from the PARENT\'s pre-merge head, so a pull that moves package-lock.json still runs npm ci', async () => {
  const cwd = scratchCloneWithUpdater();
  try {
    const { exec: parentExec } = fakeExec({ behind: 1, changed: ['package-lock.json'] });
    const { exec: childExec, calls: childCalls } = fakeExec({ behind: 0, head: HEAD_B, changed: ['package-lock.json'] });
    const childLines = [];
    let childReport = null;
    const report = await runUpdate({
      cwd,
      exec: parentExec,
      log: () => {},
      projects: [],
      opts: {},
      reexec: async (_script, handoff) => {
        childReport = await runUpdate({ cwd, exec: childExec, log: (l) => childLines.push(l), projects: [], opts: { fetch: false, from: handoff?.from } });
        return { status: childReport.exit, signal: null };
      },
    });
    assert.equal(report.exit, 0, childLines.join('\n'));
    assert.ok(childCalls.includes(`git diff --name-only ${HEAD_A} ${HEAD_B}`), `the child diffs the parent's pre-merge head to the new head:\n${childCalls.join('\n')}`);
    assert.ok(childCalls.includes('npm ci'), 'the moved lockfile triggers npm ci in the child');
    assert.match(childLines.join('\n'), /1 file\(s\) changed aaaaaaa\.\.bbbbbbb/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('re-exec child: a malformed handed-over head is loud, and npm ci runs because the dependency change is unknown', async () => {
  const cwd = scratchCloneWithUpdater();
  try {
    const { exec, calls } = fakeExec({ behind: 0, head: HEAD_B });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [], opts: { fetch: false, from: 'not-a-sha' } });
    assert.equal(report.exit, 0);
    assert.match(lines.join('\n'), /⚠ the pre-merge head handed over by the parent update \('not-a-sha'\) is not a commit sha/);
    assert.ok(calls.includes('npm ci'), 'unknown dependency change → npm ci runs rather than being skipped');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 8. disclosures: pre-scale-down CLAUDE.md and config keys Sterling no longer
//        reads (decision gap-hunt-2026-09-28-rulings items 7 and 12) ─────────
// Both are REPORTS: nothing is rewritten or deleted, and neither changes the exit.

test('preScaleDownMarkers: names the retired-pipeline identifiers only the pre-scale-down template carried; the current templates carry none', () => {
  assert.deepEqual(preScaleDownMarkers('ABNORMAL exits go to `run_signal` immediately; the review-ledger records it'), ['run_signal', 'review-ledger']);
  assert.deepEqual(preScaleDownMarkers('# CLAUDE.md\nplain project prose about signals and ledgers\n'), []);
  for (const t of ['target-claude-md.md', 'target-agents-md.md']) {
    assert.deepEqual(preScaleDownMarkers(readFileSync(join(REPO_ROOT, 'templates', t), 'utf8')), [], `${t} must never trip its own disclosure`);
  }
});

function hygieneProject(name, { claude = null, config = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  if (claude !== null) writeFileSync(join(dir, 'CLAUDE.md'), claude);
  if (config !== null) {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  workProjects.push(dir);
  return dir;
}

for (const path of ['already-current', 'full']) {
  test(`disclosures (${path} path): a pre-scale-down CLAUDE.md is named with "run /sterling:init there", unread config keys are listed, nothing is rewritten, exit unchanged`, async () => {
    const cwd = scratchCwd();
    try {
      const stale = hygieneProject('stale', { claude: '# CLAUDE.md\nABNORMAL exits go to `run_signal`.\n', config: { mode: 'hobby', caps: { inner_loop_n: 3 }, context_watch: { warn_pct: 40 } } });
      const clean = hygieneProject('clean', { claude: '@AGENTS.md\n# CLAUDE.md\n', config: { mode: 'hobby' } });
      const staleClaude = readFileSync(join(stale, 'CLAUDE.md'), 'utf8');
      const staleConfig = readFileSync(join(stale, '.sterling', 'config.json'), 'utf8');
      if (path === 'already-current') seedUpdateMarker(cwd, HEAD_A);
      const { exec } = fakeExec({ behind: path === 'full' ? 1 : 0 });
      const lines = [];
      const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'stale', repo_path: stale }, { name: 'clean', repo_path: clean }], opts: {} });
      const out = lines.join('\n');
      assert.equal(report.exit, 0, 'a disclosure never fails the update');
      assert.match(out, /stale: CLAUDE\.md predates the scale-down \(mentions run_signal\) — run \/sterling:init there/);
      assert.match(out, /stale: \.sterling\/config\.json carries 2 key\(s\) Sterling no longer reads: caps, context_watch\.warn_pct/);
      assert.doesNotMatch(out, /clean: CLAUDE\.md predates/);
      assert.doesNotMatch(out, /clean: \.sterling\/config\.json carries/);
      assert.equal(readFileSync(join(stale, 'CLAUDE.md'), 'utf8'), staleClaude, 'CLAUDE.md is never rewritten by update');
      assert.equal(readFileSync(join(stale, '.sterling', 'config.json'), 'utf8'), staleConfig, 'unread keys are never deleted');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('disclosures: an unparseable project config is a visible skip line, never a crash', async () => {
  const cwd = scratchCwd();
  try {
    seedUpdateMarker(cwd, HEAD_A);
    const broken = hygieneProject('broken', { config: '{ not json' });
    const { exec } = fakeExec({ behind: 0 });
    const lines = [];
    // The refresh reads the mode first and refuses this project (exit 2); the
    // disclosure itself adds nothing worse than a skip line.
    await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'broken', repo_path: broken }], opts: {} });
    assert.match(lines.join('\n'), /broken: unread-config-key check skipped — \.sterling\/config\.json could not be parsed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// The measured sibling case (Dome Farmer): config.models still held every
// pre-rename roster key, and config_set wrote to the dead `coder` key with no
// warning. Each dead nested key is named by its path; a known rename says where
// the value now lives.
test('disclosures: the Dome Farmer pre-rename models keys are each named by path, with the known renames', async () => {
  const cwd = scratchCwd();
  try {
    seedUpdateMarker(cwd, HEAD_A);
    const me = { model: 'm', effort: 'low' };
    const dome = hygieneProject('dome', {
      config: { mode: 'hobby', models: { implementor: me, scout: me, coder: me, coder_hard: me, explorer: me, test_writer: me, reviewers: me, implementation_architect: me, debugger: me } },
    });
    const { exec } = fakeExec({ behind: 0 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: [{ name: 'dome', repo_path: dome }], opts: {} });
    const out = lines.join('\n');
    assert.equal(report.exit, 0);
    assert.match(
      out,
      /dome: \.sterling\/config\.json carries 7 key\(s\) Sterling no longer reads: models\.coder \(renamed to models\.implementor\), models\.coder_hard, models\.explorer \(renamed to models\.scout\), models\.test_writer, models\.reviewers, models\.implementation_architect, models\.debugger — /,
      'exactly the seven dead keys, in config order; the live implementor and scout keys are not listed'
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// INSTALLED COPY (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D): a /plugin-installed Sterling has no .git at its plugin root, and /plugin owns its
// updates. /sterling:update refuses before anything else — no git, no npm, no sync, exit 2.
test('installed copy (no .git at the plugin root): /sterling:update refuses before anything else, exit 2', async () => {
  const cwd = authoringCwd();
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sterling-update-installed-'));
  try {
    const { exec, calls } = fakeExec({ behind: 2 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (l) => lines.push(l), projects: REG_P, invokingProject: '/tmp/p', opts: {}, pluginRoot });
    assert.equal(report.exit, 2);
    assert.deepEqual(calls, [], 'nothing runs on an installed copy');
    assert.match(lines.join('\n'), /Sterling is installed as a plugin — update it with \/plugin \(Installed tab → Update\) or `claude plugin update sterling@/);
    assert.equal(existsSync(join(cwd, UPDATE_MARKER_RELATIVE_PATH)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test('a clone plugin root (.git present) is not refused: the authoring path runs unchanged', async () => {
  const cwd = authoringCwd();
  const pluginRoot = mkdtempSync(join(tmpdir(), 'sterling-update-clone-root-'));
  try {
    mkdirSync(join(pluginRoot, '.git'));
    const { exec, calls } = fakeExec();
    const report = await runUpdate({ cwd, exec, log: () => {}, projects: REG_P, invokingProject: '/tmp/p', opts: {}, pluginRoot });
    assert.equal(report.exit, 0);
    assert.deepEqual(calls.filter((c) => c.includes('sync-agents')).map((c) => c.split(' ').pop()), ['/tmp/p']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});
