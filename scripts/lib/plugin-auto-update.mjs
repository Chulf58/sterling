// The machine-level update coordinator for the Sterling OpenCode plugin (decision
// sterling-on-opencode-updates-itself-at-session-start-daily-c). OpenCode never installs a
// newer git-plugin revision by itself; only `opencode plugin update <spec>` does. This
// module runs that command at most once a day per machine, in the background, and
// reports whether a newer generation landed. It does not sync any project: the caller
// funnels the new root through postUpdateSync (scripts/lib/post-update-sync.mjs).
//
// THE RECEIPT is the machine's daily network-attempt record, <cache>/sterling/
// plugin-auto-update.json ({ at, spec, outcome?, reason?, from?, to?, problems? }), kept
// apart from each project's sync marker. The attempt is written BEFORE the command runs
// (`at` and `spec`, no `outcome`) and finalized with its outcome after, so a process that
// dies mid-update still stamps the day: a successor that finds an attempt with no outcome
// reports it as interrupted once (by finalizing that same receipt) and does not run again
// that day. A failed attempt also stamps the day, so a failure is one notice a day and the
// retry is tomorrow's. Every receipt write is a whole-file rename. The check is re-read
// inside the cross-process lock (<cache>/sterling/plugin-auto-update.lock), so two
// OpenCode processes produce one update.
//
// The update applies only to the configured spec whose cache directory holds the running
// plugin root: a clone-backed plugin root (isInstalledCopy false) or one that no
// configured spec installed is 'skipped' (an intended exclusion, nothing said). An
// operational failure is 'error' instead: an unreadable OpenCode config, or a lock that
// stayed taken. Its notice is deduplicated to once a day through the receipt's
// `problems` map, which never counts as an attempt.
// NOT guaranteed: the lock-timeout notice stamp is written without the lock (the lock is
// what timed out), so a holder that finalizes in the same instant can lose its outcome,
// which the next reader then reports as an interrupted attempt.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LockTimeout, takeFileLock } from './file-lock.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { compareVersions, readPluginVersion, samePath } from './post-update-sync.mjs';
import { openCodeLoadedSterling } from './sterling-roots.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = DAY_MS / 24;
export const UPDATE_TIMEOUT_MS = 120_000;

function cacheDir(env, home) {
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'sterling');
}

/** Paths of the machine receipt and lock. */
export function autoUpdatePaths(env = process.env, home = homedir()) {
  const dir = cacheDir(env, home);
  return { dir, receipt: join(dir, 'plugin-auto-update.json'), lock: join(dir, 'plugin-auto-update.lock') };
}

// The receipt's fields plus atMs (null when no attempt is on record). An absent or
// unreadable receipt is no attempt and no problems on record.
function readReceipt(path) {
  let r;
  try {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { atMs: null };
  }
  if (!r || typeof r !== 'object') return { atMs: null };
  const at = Date.parse(r.at);
  return { ...r, atMs: Number.isNaN(at) ? null : at };
}

function writeReceipt(paths, { atMs, ...fields }) {
  mkdirSync(paths.dir, { recursive: true });
  const tmp = `${paths.receipt}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(fields)}\n`);
  renameSync(tmp, paths.receipt);
}

// POSIX: the child was spawned as its own process-group leader, so the whole tree dies with it.
function killTree(child, group, note) {
  if (group && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (e) {
      // ESRCH: the group is already gone; anything else is said in the result.
      if (e?.code !== 'ESRCH') note(`killing process group ${child.pid} failed (${e?.code ?? e?.message})`);
    }
  }
  child.kill('SIGKILL');
}

/**
 * Runs `<command> <args>` with a timeout: { status, stdout, stderr, timedOut, error }. Never
 * rejects. At the deadline it kills the process tree (the process group on POSIX, the child
 * on Windows), destroys the pipes and settles at once: a descendant that keeps stdout or
 * stderr open cannot hold the result back.
 */
export function runOpenCode(args, { timeoutMs = UPDATE_TIMEOUT_MS, command = 'opencode' } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, stderr, timedOut, ...r });
    };
    const group = process.platform !== 'win32';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: group });
    } catch (error) {
      return finish({ status: null, error });
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, group, (text) => { stderr += `\n[${text}]`; });
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ status: null });
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
 *  'not-due'     the receipt holds a finished attempt under 24 h old (also: the lock holder
 *                did the day's attempt);
 *  'skipped'     { reason } an intended exclusion: a clone-backed root, or no configured
 *                Sterling spec installed this root; nothing is stamped;
 *  'error'       { kind: 'config' | 'lock', reason, notify } an operational failure: the
 *                OpenCode config is unreadable, or the lock stayed taken. No attempt is
 *                recorded; notify is true for the first report of that kind in 24 h;
 *  'interrupted' { at } today's attempt never recorded an outcome (its process ended first);
 *                the receipt is finalized as interrupted, so this is said once;
 *  'unchanged'   the command succeeded and no newer generation landed;
 *  'updated'     { from, to, root } a newer generation is installed at `root`;
 *  'failed'      { reason } the command failed, timed out or could not run.
 * 'unchanged', 'updated' and 'failed' carry `interrupted` (the earlier attempt's `at`) when the
 * attempt before them never recorded an outcome.
 * deps: pluginRoot (the running plugin root, required), env, home, nowMs() (ms), runCommand(args,
 * {timeoutMs}) (default: the real opencode), timeoutMs, lockWaitMs (default timeoutMs + 10 s).
 */
export async function checkPluginUpdate({ pluginRoot, env = process.env, home = homedir(), nowMs = Date.now, runCommand = runOpenCode, timeoutMs = UPDATE_TIMEOUT_MS, lockWaitMs = timeoutMs + 10_000 } = {}) {
  const paths = autoUpdatePaths(env, home);
  const iso = () => new Date(nowMs()).toISOString();
  const fresh = (r) => r.atMs !== null && nowMs() - r.atMs < DAY_MS && r.atMs - nowMs() <= DAY_MS;
  // True when this kind of problem was not reported in the last 24 h; the report is stamped.
  const firstReport = (kind) => {
    const r = readReceipt(paths.receipt);
    const last = Date.parse(r.problems?.[kind]);
    if (!Number.isNaN(last) && nowMs() - last < DAY_MS && last - nowMs() <= DAY_MS) return false;
    writeReceipt(paths, { ...r, problems: { ...r.problems, [kind]: iso() } });
    return true;
  };

  const pre = readReceipt(paths.receipt);
  if (fresh(pre) && pre.outcome) return { status: 'not-due' };
  if (!pluginRoot || !isInstalledCopy(pluginRoot, { env, home })) return { status: 'skipped', reason: 'the plugin root is a clone, not an installed copy' };

  let release;
  try {
    release = await takeFileLock(paths.lock, { waitMs: lockWaitMs });
  } catch (e) {
    if (!(e instanceof LockTimeout)) throw e;
    const reason = `the update lock ${paths.lock} stayed taken for ${Math.round(lockWaitMs / 1000)} s, so no update ran and no attempt was recorded`;
    return { status: 'error', kind: 'lock', reason, notify: firstReport('lock') };
  }
  try {
    const r = readReceipt(paths.receipt);
    if (fresh(r) && r.outcome) return { status: 'not-due' };
    if (fresh(r)) {
      // The lock is ours, so no live process is running this attempt: it was interrupted.
      writeReceipt(paths, { ...r, outcome: 'interrupted', reason: 'the attempt recorded no outcome; the process running it ended first' });
      return { status: 'interrupted', at: r.at };
    }
    const interrupted = r.atMs !== null && !r.outcome ? r.at : undefined;
    const loaded = openCodeLoadedSterling(env, home);
    if (loaded.error) {
      return { status: 'error', kind: 'config', reason: `${loaded.configPath} is unreadable (${loaded.error})`, notify: firstReport('config') };
    }
    const copy = loaded.copies.find((c) => c.root && under(c.dir, pluginRoot));
    if (!copy) return { status: 'skipped', reason: 'no configured Sterling plugin spec installed this plugin root' };

    const attempt = { at: iso(), spec: copy.spec, ...(r.problems ? { problems: r.problems } : {}) };
    writeReceipt(paths, attempt);
    const before = copy;
    const result = await runCommand(['plugin', 'update', copy.spec], { timeoutMs });
    const extra = interrupted ? { interrupted } : {};
    if (result.timedOut || result.error || result.status !== 0) {
      const reason = failureReason(result, timeoutMs);
      writeReceipt(paths, { ...attempt, outcome: 'failed', reason });
      return { status: 'failed', reason, ...extra };
    }
    const after = openCodeLoadedSterling(env, home).copies?.find((c) => c.spec === copy.spec);
    const from = before.version ?? null;
    const to = after?.version ?? null;
    if (after?.root && to && (from === null || compareVersions(to, from) === 1 || (compareVersions(to, from) === null && to !== from))) {
      writeReceipt(paths, { ...attempt, outcome: 'updated', from, to });
      return { status: 'updated', from, to, root: after.root, ...extra };
    }
    writeReceipt(paths, { ...attempt, outcome: 'unchanged', from, to });
    return { status: 'unchanged', from, to, ...extra };
  } finally {
    release();
  }
}

/**
 * The installed generation newer than `pluginRoot` for the configured spec that installed it,
 * as { from, to, root }, or null. Another OpenCode process on the machine may have run the
 * day's update; this process adopts what it installed. Versions are plugin.json's, as
 * postUpdateSync reads them. An unreadable config is null (checkPluginUpdate reports it).
 */
export function newerInstalledRoot({ pluginRoot, env = process.env, home = homedir() }) {
  if (!pluginRoot) return null;
  const loaded = openCodeLoadedSterling(env, home);
  if (loaded.error) return null;
  const copy = loaded.copies.find((c) => c.root && under(c.dir, pluginRoot));
  if (!copy || samePath(copy.root, pluginRoot)) return null;
  const from = readPluginVersion(pluginRoot);
  const to = readPluginVersion(copy.root);
  return from && to && compareVersions(to, from) === 1 ? { from, to, root: copy.root } : null;
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
          // A skip or an operational error is cheap to re-evaluate, so it waits an hour; any
          // recorded attempt waits a day.
          nextAt = nowMs() + (r.status === 'skipped' || r.status === 'error' ? HOUR_MS : DAY_MS);
          return r;
        })
        .catch((e) => {
          nextAt = nowMs() + HOUR_MS;
          throw e;
        })
        .finally(() => { flight = null; });
      return flight;
    },
  };
}
