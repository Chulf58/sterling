// The daily plugin auto-update (scripts/lib/plugin-auto-update.mjs and its trigger in
// packages/opencode-plugin/src/sync.mjs; decision
// sterling-on-opencode-updates-itself-at-session-start-daily-c). The `opencode` command and
// the clock are injected, and every fixture has its own temp HOME: nothing here runs the real
// `opencode plugin update` or touches the real ~/.cache.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { autoUpdatePaths, checkPluginUpdate, createAutoUpdater, DAY_MS, runOpenCode } from '../lib/plugin-auto-update.mjs';
import { pidIsAlive, takeFileLock } from '../lib/file-lock.mjs';
import { openCodeCacheKey, STERLING_GIT_SPEC } from '../lib/sterling-roots.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createSessionSync, createSyncShared } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'sync.mjs')).href);
const { NOTICES_REL } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'notices.mjs')).href);

const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const DAY0 = Date.parse('2026-11-19T08:00:00.000Z');

/** One generation of the installed plugin: <cache>/<key>/<gen>/node_modules/@chulf58/sterling. */
function installGeneration(home, gen, version, { syncDelayMs = 0 } = {}) {
  const key = openCodeCacheKey(STERLING_GIT_SPEC, 'git');
  const root = join(home, '.cache', 'opencode', 'npm', key, String(gen), 'node_modules', '@chulf58', 'sterling');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version }));
  writeFileSync(join(root, 'scripts', 'sync-agents.mjs'), `setTimeout(() => process.stdout.write("refreshed: implementor\\n\\nRESTART REQUIRED — project subagents load at session start.\\n"), ${syncDelayMs});\n`);
  writeFileSync(join(root, 'scripts', 'stamp-contract.mjs'), 'process.stdout.write("stamp-contract: 1 already in sync — 1 project(s) processed\\n");\n');
  // The sync's last step (GitHub #329); this one removes nothing.
  writeFileSync(join(root, 'scripts', 'retire-host-files.mjs'), 'process.exit(0);\n');
  writeFileSync(join(root, 'scripts', 'domains.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify({ proposal: { add: [], sibling_steps: [] } }))});\n`);
  return root;
}

/** A temp HOME with the Sterling spec configured and generation 1 (version 1.0.0) installed. */
function makeMachine(gen1 = {}) {
  const home = tmp('sterling-pau-home-');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugins: [STERLING_GIT_SPEC] }));
  const root = installGeneration(home, 1, '1.0.0', gen1);
  const env = { XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: process.env.PATH };
  return { home, root, env };
}

/** A git clone of the plugin outside every install root (what the authoring machine runs). */
function cloneRoot() {
  const root = tmp('sterling-pau-clone-');
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '1.0.0' }));
  return root;
}

/** An injected `opencode`: each call may install a newer generation or fail; calls are recorded. */
function fakeOpenCode(home, steps) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    await new Promise((r) => setImmediate(r));
    if (step.install) installGeneration(home, step.install.gen, step.install.version);
    return { status: step.status ?? 0, stdout: '', stderr: step.stderr ?? '', timedOut: step.timedOut ?? false };
  };
  return { calls, run };
}

test('first call runs `opencode plugin update <spec>`; a second within 24 h does not; after 24 h it runs again', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{}]);
  let t = DAY0;
  const opts = { pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => t, runCommand: oc.run };
  const first = await checkPluginUpdate(opts);
  assert.equal(first.status, 'unchanged');
  assert.deepEqual(oc.calls, [['plugin', 'update', STERLING_GIT_SPEC]]);
  assert.ok(existsSync(autoUpdatePaths(m.env, m.home).receipt), 'the receipt lives under the machine cache');
  t += DAY_MS - 1000;
  assert.equal((await checkPluginUpdate(opts)).status, 'not-due');
  assert.equal(oc.calls.length, 1);
  t += 2000;
  assert.equal((await checkPluginUpdate(opts)).status, 'unchanged');
  assert.equal(oc.calls.length, 2);
});

test('two concurrent callers produce exactly one update (the lock, with the stamp re-checked inside it)', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const opts = { pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run };
  const [a, b] = await Promise.all([checkPluginUpdate(opts), checkPluginUpdate(opts)]);
  assert.equal(oc.calls.length, 1);
  assert.deepEqual([a.status, b.status].sort(), ['not-due', 'updated']);
});

test('a newer generation reports updated with the new installed root; the same version reports unchanged', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const r = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run });
  assert.equal(r.status, 'updated');
  assert.equal(r.from, '1.0.0');
  assert.equal(r.to, '1.1.0');
  assert.match(r.root, /[\\/]2[\\/]node_modules/);
  const same = makeMachine();
  const oc2 = fakeOpenCode(same.home, [{ install: { gen: 2, version: '1.0.0' } }]);
  const u = await checkPluginUpdate({ pluginRoot: same.root, env: same.env, home: same.home, nowMs: () => DAY0, runCommand: oc2.run });
  assert.equal(u.status, 'unchanged');
});

test('a clone-backed plugin root is skipped: no command, no receipt', async () => {
  const m = makeMachine();
  const clone = cloneRoot();
  const oc = fakeOpenCode(m.home, [{}]);
  const r = await checkPluginUpdate({ pluginRoot: clone, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run });
  assert.equal(r.status, 'skipped');
  assert.equal(oc.calls.length, 0);
  assert.equal(existsSync(autoUpdatePaths(m.env, m.home).receipt), false);
  const elsewhere = tmp('sterling-pau-elsewhere-');
  const s = await checkPluginUpdate({ pluginRoot: elsewhere, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run });
  assert.equal(s.status, 'skipped', 'a root no configured spec installed is not updated');
  assert.equal(oc.calls.length, 0);
});

test('a failed or timed-out command stamps the day and reports the reason; the receipt keeps it apart from sync state', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ status: 1, stderr: 'getaddrinfo ENOTFOUND github.com' }, { timedOut: true, status: null }]);
  let t = DAY0;
  const opts = { pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => t, runCommand: oc.run, timeoutMs: 5000 };
  const f = await checkPluginUpdate(opts);
  assert.equal(f.status, 'failed');
  assert.match(f.reason, /exited 1.*ENOTFOUND/);
  assert.equal(JSON.parse(readFileSync(autoUpdatePaths(m.env, m.home).receipt, 'utf8')).outcome, 'failed');
  assert.equal((await checkPluginUpdate(opts)).status, 'not-due', 'the retry is the next day');
  t += DAY_MS;
  const g = await checkPluginUpdate(opts);
  assert.equal(g.status, 'failed');
  assert.match(g.reason, /timed out after 5 s/);
});

test('createAutoUpdater: due() is false while a check runs and until the next day', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{}]);
  let t = DAY0;
  const u = createAutoUpdater({ env: m.env, home: m.home, nowMs: () => t, runCommand: oc.run });
  assert.equal(u.due(), true);
  const p = u.check({ pluginRoot: m.root });
  assert.equal(u.due(), false);
  await p;
  assert.equal(u.due(), false);
  t += DAY_MS;
  assert.equal(u.due(), true);
});

// ---- the plugin's trigger: packages/opencode-plugin/src/sync.mjs ----

function makeProject(marker) {
  const dir = tmp('sterling-pau-project-');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  if (marker) writeFileSync(join(dir, '.sterling', 'synced-version'), `${marker}\n`);
  return dir;
}
const markerOf = (p) => readFileSync(join(p, '.sterling', 'synced-version'), 'utf8').trim();
const noticeTexts = (p) => (existsSync(join(p, NOTICES_REL)) ? JSON.parse(readFileSync(join(p, NOTICES_REL), 'utf8')).map((n) => n.text) : []);
const rootSession = { get: async ({ sessionID }) => ({ id: sessionID }) };

function pluginSync(m, oc, clock, extra = {}) {
  return createSessionSync({
    sterlingRoot: m.root,
    getSession: () => rootSession,
    now: () => new Date(clock.t).toISOString(),
    nowMs: () => clock.t,
    nodeBin: process.execPath,
    env: m.env,
    home: m.home,
    updater: createAutoUpdater({ env: m.env, home: m.home, nowMs: () => clock.t, runCommand: oc.run }),
    ...extra,
  });
}

test('a newer generation re-syncs the triggering project from the new root and says so; other projects converge at their next request; the same version syncs nothing', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const clock = { t: DAY0 };
  const a = makeProject('1.0.0');
  const b = makeProject('1.0.0');
  const syncOnce = pluginSync(m, oc, clock);
  await syncOnce(a, 'ses_a');
  await syncOnce.idle();
  assert.equal(oc.calls.length, 1);
  assert.equal(markerOf(a), '1.1.0', 'postUpdateSync ran from the installed new root');
  const texts = noticeTexts(a);
  assert.ok(texts.some((x) => /^Sterling updated 1\.0\.0→1\.1\.0; agents re-synced\. Run \/reload when no project on this shared service has in-flight tools or background work\.$/.test(x)), texts.join('\n'));
  assert.equal(markerOf(b), '1.0.0', 'the other project has not been looked at yet');
  await syncOnce(b, 'ses_b');
  await syncOnce.idle();
  assert.equal(markerOf(b), '1.1.0', 'a project that did not trigger the update converges later');
  assert.equal(oc.calls.length, 1, 'one update for the machine, not one per project');

  const same = makeMachine();
  const oc2 = fakeOpenCode(same.home, [{}]);
  const p = makeProject('1.0.0');
  const syncSame = pluginSync(same, oc2, { t: DAY0 });
  await syncSame(p, 'ses_p');
  await syncSame.idle();
  assert.equal(oc2.calls.length, 1);
  assert.equal(markerOf(p), '1.0.0', 'the same version: nothing synced');
  assert.deepEqual(noticeTexts(p).filter((x) => /updated|FAILED/.test(x)), []);
});

test('a failed update gives one loud notice per day with the reason, and retries the next day; the long-lived process checks again', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ status: 1, stderr: 'offline day one' }, { status: 1, stderr: 'offline day two' }]);
  const clock = { t: DAY0 };
  const project = makeProject('1.0.0');
  const syncOnce = pluginSync(m, oc, clock);
  await syncOnce(project, 'ses_1');
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.equal(oc.calls.length, 1);
  let failed = noticeTexts(project).filter((x) => /daily plugin update FAILED/.test(x));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /offline day one/);
  assert.match(failed[0], /tries again tomorrow/);
  clock.t += DAY_MS + 1000;
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.equal(oc.calls.length, 2, 'the started latch does not stop the next day\'s check');
  failed = noticeTexts(project).filter((x) => /daily plugin update FAILED/.test(x));
  assert.equal(failed.length, 2);
  assert.match(failed[1], /offline day two/);
});

test('a clone-backed plugin root never runs the update from the plugin', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const project = makeProject('1.0.0');
  const syncOnce = pluginSync(m, oc, { t: DAY0 }, { sterlingRoot: cloneRoot() });
  await syncOnce(project, 'ses_c');
  await syncOnce.idle();
  assert.equal(oc.calls.length, 0);
});

// ---- review round 1: the real runner, the receipt, operational errors, shared state ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const receiptOf = (m) => JSON.parse(readFileSync(autoUpdatePaths(m.env, m.home).receipt, 'utf8'));

/** Polls until `pid` is gone (a killed orphan is reaped by init shortly after). */
async function goneSoon(pid, polls = 40) {
  for (let i = 0; pidIsAlive(pid) && i < polls; i += 1) await sleep(50);
  return !pidIsAlive(pid);
}

// A harmless Node launcher: it starts a descendant that inherits stdout/stderr and sleeps 10 s,
// writes the descendant's pid to argv[1], then either stays alive (argv[2] 'stay') or exits at once.
const LAUNCHER = [
  "const { spawn } = require('node:child_process');",
  "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
  "require('node:fs').writeFileSync(process.argv[1], String(c.pid));",
  "process.stdout.write('launched\\n');",
  "if (process.argv[2] === 'stay') setTimeout(() => {}, 10000);",
  "else c.unref();",
].join('\n');

test('runOpenCode: a launcher still running at the deadline is killed with its whole process group, and the result settles at once', async () => {
  const pidFile = join(tmp('sterling-pau-runner-'), 'descendant.pid');
  const t0 = Date.now();
  const r = await runOpenCode(['-e', LAUNCHER, pidFile, 'stay'], { command: process.execPath, timeoutMs: 400 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.ok(elapsed < 3000, `settled ${elapsed} ms after a 400 ms deadline (the descendant sleeps 10 s)`);
  assert.match(r.stdout, /launched/);
  if (process.platform !== 'win32') assert.equal(await goneSoon(Number(readFileSync(pidFile, 'utf8'))), true, 'the descendant was killed with the group');
});

test('runOpenCode: after the launcher has exited, a descendant holding the pipes cannot hold the result back, and no process group is signalled', async () => {
  const pidFile = join(tmp('sterling-pau-runner-'), 'descendant.pid');
  const kills = [];
  const t0 = Date.now();
  const r = await runOpenCode(['-e', LAUNCHER, pidFile], { command: process.execPath, timeoutMs: 600, kill: (pid, signal) => void kills.push([pid, signal]) });
  const elapsed = Date.now() - t0;
  const descendant = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 3000, `settled ${elapsed} ms after a 600 ms deadline (the descendant sleeps 10 s)`);
    assert.match(r.stdout, /launched/);
    assert.deepEqual(kills, [], 'the launcher\'s group id may be reused once it has exited, so no group signal is sent');
    assert.equal(await goneSoon(descendant, 8), false, 'nothing else signalled the group either: the descendant is left running, with its pipes closed');
  } finally {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
});

test('a lock-timeout problem stamp that lands after another process finished today\'s attempt never touches the receipt: no second update that day', async () => {
  const m = makeMachine();
  const paths = autoUpdatePaths(m.env, m.home);
  mkdirSync(paths.dir, { recursive: true });
  const old = { at: new Date(DAY0 - 2 * DAY_MS).toISOString(), spec: STERLING_GIT_SPEC, outcome: 'unchanged' };
  writeFileSync(paths.receipt, JSON.stringify(old));
  const fresh = { at: new Date(DAY0).toISOString(), spec: STERLING_GIT_SPEC, outcome: 'updated', from: '1.0.0', to: '1.1.0' };
  const oc = fakeOpenCode(m.home, [{}]);
  const release = await takeFileLock(paths.lock);
  // The holder finishes today's update and releases the lock in the instant before the
  // waiter's (delayed) problem stamp is written.
  const fs = {
    writeFile: (path, content) => {
      writeFileSync(paths.receipt, JSON.stringify(fresh));
      release();
      writeFileSync(path, content);
    },
  };
  const r = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run, lockWaitMs: 100, fs });
  assert.equal(r.status, 'error');
  assert.equal(r.kind, 'lock');
  assert.deepEqual(receiptOf(m), fresh, 'the waiter that never held the lock wrote nothing to the receipt');
  assert.ok(existsSync(paths.problems), 'the stamp went to the problems file');
  const again = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0 + 1000, runCommand: oc.run });
  assert.equal(again.status, 'not-due');
  assert.equal(oc.calls.length, 0, 'no second update the same day');
});

test('a receipt write whose replacement fails leaves no .tmp-* file and runs no command', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{}]);
  const fs = { rename: () => { throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' }); } };
  await assert.rejects(checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run, fs }), /injected/);
  const dir = autoUpdatePaths(m.env, m.home).dir;
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
  assert.equal(oc.calls.length, 0, 'no command runs before the attempt is on record');
});

test('the attempt is on record before the command runs, then finalized with its outcome', async () => {
  const m = makeMachine();
  let during = null;
  const run = async () => {
    during = receiptOf(m);
    return { status: 0, stdout: '', stderr: '', timedOut: false };
  };
  const r = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: run });
  assert.equal(r.status, 'unchanged');
  assert.equal(during.at, new Date(DAY0).toISOString());
  assert.equal(during.spec, STERLING_GIT_SPEC);
  assert.equal('outcome' in during, false, 'while the command runs the attempt has no outcome');
  assert.equal(receiptOf(m).outcome, 'unchanged');
  assert.equal(receiptOf(m).at, during.at, 'the same receipt is finalized');
});

test('an attempt a crashed process left without an outcome: the same day it is reported once as interrupted and nothing runs; the next day it is named and the update runs', async () => {
  const m = makeMachine();
  const paths = autoUpdatePaths(m.env, m.home);
  mkdirSync(paths.dir, { recursive: true });
  const crashedAt = new Date(DAY0 - 1000).toISOString();
  writeFileSync(paths.receipt, JSON.stringify({ at: crashedAt, spec: STERLING_GIT_SPEC }));
  const oc = fakeOpenCode(m.home, [{}]);
  let t = DAY0;
  const opts = { pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => t, runCommand: oc.run };
  const first = await checkPluginUpdate(opts);
  assert.deepEqual(first, { status: 'interrupted', at: crashedAt });
  assert.equal(oc.calls.length, 0, 'the crashed attempt counts as the day\'s attempt');
  assert.equal(receiptOf(m).outcome, 'interrupted');
  assert.equal(receiptOf(m).at, crashedAt, 'no second attempt marker was added');
  assert.equal((await checkPluginUpdate(opts)).status, 'not-due', 'said once');
  assert.equal(oc.calls.length, 0);

  writeFileSync(paths.receipt, JSON.stringify({ at: crashedAt, spec: STERLING_GIT_SPEC }));
  t = DAY0 + DAY_MS;
  const next = await checkPluginUpdate(opts);
  assert.equal(next.status, 'unchanged');
  assert.equal(next.interrupted, crashedAt);
  assert.equal(oc.calls.length, 1);
  assert.equal(receiptOf(m).outcome, 'unchanged');
});

test('an unreadable OpenCode config is an error, not a skip: notify once a day, no attempt recorded, no command', async () => {
  const m = makeMachine();
  writeFileSync(join(m.home, '.config', 'opencode', 'opencode.json'), '{ not json');
  const oc = fakeOpenCode(m.home, [{}]);
  let t = DAY0;
  const opts = { pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => t, runCommand: oc.run };
  const a = await checkPluginUpdate(opts);
  assert.equal(a.status, 'error');
  assert.equal(a.kind, 'config');
  assert.match(a.reason, /opencode\.json is unreadable/);
  assert.equal(a.notify, true);
  assert.equal(existsSync(autoUpdatePaths(m.env, m.home).receipt), false, 'a config failure is no attempt, and the receipt is untouched');
  t += DAY_MS / 24 + 1000;
  const b = await checkPluginUpdate(opts);
  assert.equal(b.status, 'error');
  assert.equal(b.notify, false, 'the notice is deduplicated to once a day through the receipt');
  t += DAY_MS;
  assert.equal((await checkPluginUpdate(opts)).notify, true);
  assert.equal(oc.calls.length, 0);
});

test('a lock that stays taken is an error naming the lock, never not-due, and records no attempt', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{}]);
  const release = await takeFileLock(autoUpdatePaths(m.env, m.home).lock);
  try {
    const r = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0, runCommand: oc.run, lockWaitMs: 100 });
    assert.equal(r.status, 'error');
    assert.equal(r.kind, 'lock');
    assert.match(r.reason, /stayed taken.*no attempt was recorded/);
    assert.equal(r.notify, true);
    assert.equal(existsSync(autoUpdatePaths(m.env, m.home).receipt), false, 'no attempt receipt exists');
    const again = await checkPluginUpdate({ pluginRoot: m.root, env: m.env, home: m.home, nowMs: () => DAY0 + 1000, runCommand: oc.run, lockWaitMs: 100 });
    assert.equal(again.notify, false);
  } finally {
    release();
  }
  assert.equal(oc.calls.length, 0);
});

test('plugin: an operational error gives one loud notice a day; a lock or config failure is never silent', async () => {
  const m = makeMachine();
  writeFileSync(join(m.home, '.config', 'opencode', 'opencode.json'), '{ not json');
  const oc = fakeOpenCode(m.home, [{}]);
  const clock = { t: DAY0 };
  const project = makeProject('1.0.0');
  const syncOnce = pluginSync(m, oc, clock);
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  const said = () => noticeTexts(project).filter((x) => /daily plugin update did not run/.test(x));
  assert.equal(said().length, 1);
  assert.match(said()[0], /opencode\.json is unreadable/);
  // The notice was delivered (an unshown notice with the same text is never queued twice).
  const delivered = () => rmSync(join(project, NOTICES_REL), { force: true });
  delivered();
  clock.t += DAY_MS / 24 + 1000;
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.equal(said().length, 0, 'the hourly retry does not repeat the notice');
  clock.t += DAY_MS;
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.equal(said().length, 1, 'the next day says it again');
  assert.equal(oc.calls.length, 0);
});

/** Two locations of one plugin process, built as server.mjs builds them: one shared state, one sync per location. */
function twoLocations(m, oc, clock) {
  const shared = createSyncShared({ env: m.env, home: m.home, nowMs: () => clock.t, updater: createAutoUpdater({ env: m.env, home: m.home, nowMs: () => clock.t, runCommand: oc.run }) });
  return [pluginSync(m, oc, clock, { shared }), pluginSync(m, oc, clock, { shared })];
}

test('two locations: an update in location A unlatches a project location B already synced, and B converges from the new root', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{}, { install: { gen: 2, version: '1.1.0' } }]);
  const clock = { t: DAY0 };
  const [syncA, syncB] = twoLocations(m, oc, clock);
  const pa = makeProject('1.0.0');
  const pb = makeProject('1.0.0');
  await syncB(pb, 'ses_b1');
  await syncB.idle();
  assert.equal(oc.calls.length, 1);
  assert.equal(markerOf(pb), '1.0.0');
  clock.t += DAY_MS + 1000;
  await syncA(pa, 'ses_a1');
  await syncA.idle();
  assert.equal(oc.calls.length, 2);
  assert.equal(markerOf(pa), '1.1.0');
  await syncB(pb, 'ses_b2');
  await syncB.idle();
  assert.equal(markerOf(pb), '1.1.0', 'location B synced pb from the root location A installed');
  assert.equal(oc.calls.length, 2, 'one update per process, not one per location');
});

test('two locations, one project: the sync from the older root and the one from the newer root never overlap, so the newer marker wins', async () => {
  const m = makeMachine({ syncDelayMs: 600 });
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const clock = { t: DAY0 };
  const [syncA, syncB] = twoLocations(m, oc, clock);
  const project = makeProject('0.9.0');
  await syncB(project, 'ses_b');
  await syncA(project, 'ses_a');
  await Promise.all([syncA.idle(), syncB.idle()]);
  assert.equal(oc.calls.length, 1);
  assert.equal(markerOf(project), '1.1.0');
  assert.ok(noticeTexts(project).some((x) => /^Sterling updated 1\.0\.0→1\.1\.0; agents re-synced\./.test(x)), noticeTexts(project).join('\n'));
});

test('a newer generation another OpenCode process installed today is adopted: this process re-syncs from it without running the update', async () => {
  const m = makeMachine();
  const oc = fakeOpenCode(m.home, [{ install: { gen: 2, version: '1.1.0' } }]);
  const clock = { t: DAY0 };
  const px = makeProject('1.0.0');
  const syncX = pluginSync(m, oc, clock);
  await syncX(px, 'ses_x');
  await syncX.idle();
  assert.equal(markerOf(px), '1.1.0');
  const py = makeProject('1.0.0');
  const syncY = pluginSync(m, oc, clock);
  await syncY(py, 'ses_y');
  await syncY.idle();
  assert.equal(oc.calls.length, 1, 'the second process found the day\'s attempt done');
  assert.equal(markerOf(py), '1.1.0', 'and adopted the root the first process installed');
  assert.ok(noticeTexts(py).some((x) => /^Sterling updated 1\.0\.0→1\.1\.0 \(another OpenCode process on this machine installed it\); agents re-synced\./.test(x)), noticeTexts(py).join('\n'));
});
