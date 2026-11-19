// The machine-level update coordinator for the Sterling OpenCode plugin (decision
// sterling-on-opencode-updates-itself-at-session-start-daily-c). OpenCode never installs a
// newer git-plugin revision by itself; only `opencode plugin update <spec>` does. This
// module runs that command at most once a day per machine, in the background, and
// reports whether a newer generation landed. It does not sync any project: the caller
// funnels the new root through postUpdateSync (scripts/lib/post-update-sync.mjs).
//
// THE RECEIPT is the machine's daily network-attempt record, <cache>/sterling/
// plugin-auto-update.json ({ at, outcome, reason?, from?, to? }), kept apart from each
// project's sync marker: an attempt that failed still stamps the day, so a failure is
// one notice a day and the retry is tomorrow's. The check is re-read inside the
// cross-process lock (<cache>/sterling/plugin-auto-update.lock), so two OpenCode
// processes produce one update.
//
// The update applies only to the configured spec whose cache directory holds the running
// plugin root: a clone-backed plugin root (isInstalledCopy false) or one that no
// configured spec installed is 'skipped', never updated.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LockTimeout, takeFileLock } from './file-lock.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { compareVersions } from './post-update-sync.mjs';
import { openCodeLoadedSterling } from './sterling-roots.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 120_000;

function cacheDir(env, home) {
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'sterling');
}

/** Paths of the machine receipt and lock. */
export function autoUpdatePaths(env = process.env, home = homedir()) {
  const dir = cacheDir(env, home);
  return { dir, receipt: join(dir, 'plugin-auto-update.json'), lock: join(dir, 'plugin-auto-update.lock') };
}

function readReceipt(path) {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(r?.at);
    return Number.isNaN(at) ? null : { ...r, atMs: at };
  } catch {
    return null; // absent or unreadable: no attempt on record
  }
}

/** Runs `opencode <args>` with a timeout: { status, stdout, stderr, timedOut, error }. Never rejects. */
export function runOpenCode(args, { timeoutMs = UPDATE_TIMEOUT_MS, command = 'opencode' } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, stderr, timedOut, ...r });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return done({ status: null, stdout, stderr, timedOut: false, error });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status) => finish({ status }));
  });
}

function failureReason(r, timeoutMs) {
  if (r.timedOut) return `\`opencode plugin update\` timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (r.error) return `\`opencode plugin update\` could not run (${r.error.code ?? r.error.message})`;
  const tail = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  return `\`opencode plugin update\` exited ${r.status}${tail ? `: ${tail}` : ''}`;
}

function under(dir, path) {
  return resolve(path).startsWith(resolve(dir) + sep);
}

/**
 * One daily update check. Returns { status, ... }:
 *  'not-due'   the receipt is under 24 h old (also: the lock holder did the day's attempt);
 *  'skipped'   { reason } no applicable configured spec: clone-backed root, no Sterling
 *              entry, or an unreadable config; nothing is stamped;
 *  'unchanged' the command succeeded and no newer generation landed;
 *  'updated'   { from, to, root } a newer generation is installed at `root`;
 *  'failed'    { reason } the command failed, timed out or could not run.
 * deps: pluginRoot (the running plugin root, required), env, home, nowMs() (ms), runCommand(args,
 * {timeoutMs}) (default: the real opencode), timeoutMs.
 */
export async function checkPluginUpdate({ pluginRoot, env = process.env, home = homedir(), nowMs = Date.now, runCommand = runOpenCode, timeoutMs = UPDATE_TIMEOUT_MS } = {}) {
  const paths = autoUpdatePaths(env, home);
  const due = () => {
    const r = readReceipt(paths.receipt);
    return !r || nowMs() - r.atMs >= DAY_MS || r.atMs - nowMs() > DAY_MS;
  };
  if (!due()) return { status: 'not-due' };
  if (!pluginRoot || !isInstalledCopy(pluginRoot, { env, home })) return { status: 'skipped', reason: 'the plugin root is a clone, not an installed copy' };
  const loaded = openCodeLoadedSterling(env, home);
  if (loaded.error) return { status: 'skipped', reason: `opencode.json is unreadable (${loaded.error})` };
  const copy = loaded.copies.find((c) => c.root && under(c.dir, pluginRoot));
  if (!copy) return { status: 'skipped', reason: 'no configured Sterling plugin spec installed this plugin root' };

  let release;
  try {
    release = await takeFileLock(paths.lock, { waitMs: timeoutMs + 10_000 });
  } catch (e) {
    if (e instanceof LockTimeout) return { status: 'not-due' };
    throw e;
  }
  try {
    if (!due()) return { status: 'not-due' };
    const before = openCodeLoadedSterling(env, home).copies.find((c) => c.spec === copy.spec);
    const result = await runCommand(['plugin', 'update', copy.spec], { timeoutMs });
    const stamp = (extra) => {
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.receipt, `${JSON.stringify({ at: new Date(nowMs()).toISOString(), spec: copy.spec, ...extra })}\n`);
    };
    if (result.timedOut || result.error || result.status !== 0) {
      const reason = failureReason(result, timeoutMs);
      stamp({ outcome: 'failed', reason });
      return { status: 'failed', reason };
    }
    const after = openCodeLoadedSterling(env, home).copies.find((c) => c.spec === copy.spec);
    const from = before?.version ?? copy.version ?? null;
    const to = after?.version ?? null;
    if (after?.root && to && (from === null || compareVersions(to, from) === 1 || (compareVersions(to, from) === null && to !== from))) {
      stamp({ outcome: 'updated', from, to });
      return { status: 'updated', from, to, root: after.root };
    }
    stamp({ outcome: 'unchanged', from, to });
    return { status: 'unchanged', from, to };
  } finally {
    release();
  }
}

/**
 * The per-process wrapper: `due()` is a cheap in-memory test (no file read until the next
 * check is due), `check(opts)` runs one check at a time and remembers when to look again.
 */
export function createAutoUpdater(deps = {}) {
  const nowMs = deps.nowMs ?? Date.now;
  let nextAt = 0;
  let flight = null;
  return {
    due: () => flight === null && nowMs() >= nextAt,
    check(opts = {}) {
      if (flight) return flight;
      flight = checkPluginUpdate({ ...deps, ...opts })
        .then((r) => {
          // Any outcome but a skip waits a day; a skip is cheap to re-evaluate, so it waits an hour.
          nextAt = nowMs() + (r.status === 'skipped' ? DAY_MS / 24 : DAY_MS);
          return r;
        })
        .catch((e) => {
          nextAt = nowMs() + DAY_MS / 24;
          throw e;
        })
        .finally(() => { flight = null; });
      return flight;
    },
  };
}
