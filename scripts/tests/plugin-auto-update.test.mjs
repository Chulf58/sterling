// The daily plugin auto-update (scripts/lib/plugin-auto-update.mjs and its trigger in
// packages/opencode-plugin/src/sync.mjs; decision
// sterling-on-opencode-updates-itself-at-session-start-daily-c). The `opencode` command and
// the clock are injected, and every fixture has its own temp HOME: nothing here runs the real
// `opencode plugin update` or touches the real ~/.cache.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { autoUpdatePaths, checkPluginUpdate, createAutoUpdater, DAY_MS } from '../lib/plugin-auto-update.mjs';
import { openCodeCacheKey, STERLING_GIT_SPEC } from '../lib/sterling-roots.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createSessionSync } = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'sync.mjs')).href);
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
function installGeneration(home, gen, version) {
  const key = openCodeCacheKey(STERLING_GIT_SPEC, 'git');
  const root = join(home, '.cache', 'opencode', 'npm', key, String(gen), 'node_modules', '@chulf58', 'sterling');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version }));
  writeFileSync(join(root, 'scripts', 'sync-agents.mjs'), 'process.stdout.write("refreshed: implementor\\n\\nRESTART REQUIRED — project subagents load at session start.\\n");\n');
  writeFileSync(join(root, 'scripts', 'stamp-contract.mjs'), 'process.stdout.write("stamp-contract: 1 already in sync — 1 project(s) processed\\n");\n');
  writeFileSync(join(root, 'scripts', 'domains.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify({ proposal: { add: [], sibling_steps: [] } }))});\n`);
  return root;
}

/** A temp HOME with the Sterling spec configured and generation 1 (version 1.0.0) installed. */
function makeMachine() {
  const home = tmp('sterling-pau-home-');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugins: [STERLING_GIT_SPEC] }));
  const root = installGeneration(home, 1, '1.0.0');
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
