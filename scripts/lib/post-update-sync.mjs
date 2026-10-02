// POST-UPDATE SYNC, shared by H1 (Claude Code) and the Sterling OpenCode server
// plugin (packages/opencode-plugin/src/sync.mjs). An installed Sterling copy
// that is NEWER than a project's sync marker (<project>/.sterling/synced-version)
// runs that project's post-update steps: sync-agents --target <project>, then a
// stamp-contract dry run scoped to it. An OLDER copy refuses with one loud line
// telling the user to update that host's Sterling; an equal one does nothing
// (decision dual-host-post-update-sync-newest-copy-wins). The marker is per
// project and both hosts write it, so an inequality trigger would downgrade and
// re-upgrade the project on alternate sessions; the version order makes it
// monotonic.
//
// INSTALLED COPIES ONLY (isInstalledCopy): on a git clone /sterling:update owns
// these steps. The marker is written only after both steps succeed, so a failure
// retries. Host 'claude' prints the bytes H1 printed before this extraction
// (scripts/tests/post-update-sync.test.mjs pins them).
//
// Builtins only: hooks and the OpenCode server bundle vendor this module.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';

// Each step is bounded well inside H1's hooks.json timeout (180s): two steps at
// 60s leave room for the rest of SessionStart.
export const POST_UPDATE_STEP_TIMEOUT_MS = 60_000;

export const SYNC_MARKER_REL = join('.sterling', 'synced-version');

const HOST_TEXT = {
  claude: {
    label: 'H1',
    restartShort: 'agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough)',
    restartLong: 'RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.',
    retry: 'retries at the next session start',
    rerun: 're-runs every session',
    update: 'update it through /plugin (Installed tab → Update)',
  },
  opencode: {
    label: 'OpenCode plugin',
    restartShort: 'agents synced — RESTART to load them (EXIT AND RELAUNCH OpenCode; a /new is NOT enough)',
    restartLong: 'RESTART REQUIRED — agents load when OpenCode starts: EXIT AND RELAUNCH OpenCode before dispatching any agent.',
    retry: 'retries the next time OpenCode starts',
    rerun: 're-runs at every OpenCode start',
    update: 'run /sterling:update in OpenCode',
  },
};

function hostText(host) {
  const text = HOST_TEXT[host];
  if (!text) throw new TypeError(`post-update sync: unknown host ${JSON.stringify(host)} (expected 'claude' or 'opencode')`);
  return text;
}

/** POSIX-ish path equality: strips a trailing slash and normalizes backslashes, no symlink resolution. */
export function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** The bundled bin/ entry when the plugin ships one, else the clone's scripts/ source. */
export function pluginScript(root, name) {
  const bundled = join(root, 'bin', name);
  return existsSync(bundled) ? bundled : join(root, 'scripts', name);
}

/** plugin.json's version, or null when it is absent or unreadable (the caller reports the SKIP). */
export function readPluginVersion(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v.length ? v : null;
  } catch {
    // absent, unreadable or malformed plugin.json: reported as an unreadable version
  }
  return null;
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** { core: [major, minor, patch], pre: [identifiers] } or null for a string that is not semver. */
export function parseVersion(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v.trim()) : null;
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * Semver precedence: -1, 0 or 1, or null when either side is not a version.
 * Build metadata is ignored; a prerelease sorts below its release.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function stepResult({ error, status, stdout, stderr }) {
  const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
  return { status: error ? null : status, error, out, tail: out.split('\n').slice(-8).join(' | ') };
}

/** Runs one plugin script synchronously (H1). */
export function runStepSync(root, name, args, { nodeBin = process.execPath } = {}) {
  const r = spawnSync(nodeBin, [pluginScript(root, name), ...args], { cwd: root, encoding: 'utf8', timeout: POST_UPDATE_STEP_TIMEOUT_MS });
  return stepResult({ error: r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : null, status: r.status, stdout: r.stdout, stderr: r.stderr });
}

/** Runs one plugin script without blocking the event loop (the OpenCode plugin). */
export function runStepAsync(root, name, args, { nodeBin = process.execPath } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(stepResult(r));
    };
    let child;
    try {
      child = spawn(nodeBin, [pluginScript(root, name), ...args], { cwd: root, timeout: POST_UPDATE_STEP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e.message });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      spawnError = e;
      // A child that never started emits no 'close' on every Node version.
      if (child.pid === undefined) finish({ error: e.message, stdout, stderr });
    });
    child.on('close', (status, signal) => finish({ error: spawnError ? spawnError.message : signal ? `killed by ${signal}` : null, status, stdout, stderr }));
  });
}

/**
 * The two steps and their verdicts: sync-agents exit 2 is a refusal and any other
 * non-zero a failure; stamp-contract exit 2 is tolerated drift, and a green
 * "0 project(s) processed" checked nothing, which is a failure (P5).
 * Returns { ok, detail } or { ok, restart, drift, driftOut }.
 */
export async function runPostUpdateSteps(root, project, runStep) {
  const sync = await runStep(root, 'sync-agents.mjs', ['--target', project]);
  if (sync.error) return { ok: false, detail: `sync-agents did not run (${sync.error})` };
  if (sync.status === 2) return { ok: false, detail: `sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, or a foreign or malformed .claude/settings.json): ${sync.tail}` };
  if (sync.status !== 0) return { ok: false, detail: `sync-agents exited ${sync.status}: ${sync.tail}` };
  const restart = /RESTART REQUIRED|EXIT AND RELAUNCH/.test(sync.out);
  // From here sync-agents has already run: a later failure still carries `restart`,
  // so the user is told agents changed even though the step as a whole failed.
  const contract = await runStep(root, 'stamp-contract.mjs', ['--project', project]);
  if (contract.error) return { ok: false, restart, detail: `stamp-contract did not run (${contract.error})` };
  if (contract.status !== 0 && contract.status !== 2) return { ok: false, restart, detail: `stamp-contract exited ${contract.status}: ${contract.tail}` };
  if (contract.status === 0 && /—\s*0 project\(s\) processed/.test(contract.out)) {
    return { ok: false, restart, detail: `stamp-contract checked NOTHING for ${project} (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it` };
  }
  return { ok: true, restart, drift: contract.status === 2, driftOut: contract.tail };
}

/**
 * True when the post-update sync applies at all: an installed plugin copy, a project
 * that is not the plugin root itself (a session there is working in Sterling), and a
 * project with .sterling/config.json. Cheap, so callers can test it before any
 * session lookup.
 */
export function postUpdateApplies(root, project) {
  return Boolean(root) && !samePath(project, root) && isInstalledCopy(root) && existsSync(join(project, '.sterling', 'config.json'));
}

/**
 * The post-update sync for one project under the newest-copy-wins rule. Returns
 * null when it does not apply or the versions are equal, else
 * { outcome, warning, context }: outcome is 'skipped', 'refused-older', 'failed' or
 * 'synced'; `warning` is the one-line banner text and `context` the model-facing
 * paragraph (both carry H1's exact spacing). A throw is the caller's to report.
 */
export async function postUpdateSync({ root, project, host = 'claude', runStep = runStepSync }) {
  const t = hostText(host);
  if (!postUpdateApplies(root, project)) return null;
  const current = readPluginVersion(root);
  const markerPath = join(project, SYNC_MARKER_REL);
  let previous = null;
  try {
    previous = readFileSync(markerPath, 'utf8').trim() || null;
  } catch {
    // absent or unreadable — treated as never synced; the sync is idempotent
  }
  const manifest = join(root, '.claude-plugin', 'plugin.json');
  if (!current) {
    return {
      outcome: 'skipped',
      warning: `⚠ Sterling post-update sync SKIPPED — the installed plugin's version is unreadable (${manifest}). `,
      context: `\n\nPOST-UPDATE SYNC (${t.label}): SKIPPED — ${manifest} carries no readable version, so this project's agents cannot be known current.`,
    };
  }
  if (!parseVersion(current)) {
    return {
      outcome: 'skipped',
      warning: `⚠ Sterling post-update sync SKIPPED — the installed plugin's version '${current}' is not a semver version (${manifest}). `,
      context: `\n\nPOST-UPDATE SYNC (${t.label}): SKIPPED — ${manifest} carries version '${current}', which is not a semver version, so it cannot be ordered against this project's sync marker.`,
    };
  }
  // An absent or non-version marker reads as never synced, as before the version order.
  const order = previous === null ? 1 : compareVersions(current, previous) ?? 1;
  if (order === 0) return null;
  if (order < 0) {
    return {
      outcome: 'refused-older',
      warning: `✗ Sterling ${current} is OLDER than this project's sync marker ${previous}: post-update sync REFUSED, nothing downgraded — ${t.update}. `,
      context: `\n\nPOST-UPDATE SYNC REFUSED (${t.label}): this Sterling copy is ${current}, older than this project's sync marker ${previous} (${markerPath}), which a newer Sterling on another host wrote. Nothing was synced, so agents and templates are not downgraded. Tell the user to update this host's Sterling: ${t.update}.`,
    };
  }
  const hop = `Sterling ${previous ?? '(never synced)'}→${current}`;
  const result = await runPostUpdateSteps(root, project, runStep);
  if (!result.ok) {
    // sync-agents may have refreshed agents before a later step failed: the
    // restart is owed regardless, so it is never hidden behind the failure.
    const restartOwed = result.restart ? ` ${t.restartShort}.` : '';
    return {
      outcome: 'failed',
      warning: `✗ ${hop}: post-update sync FAILED — ${result.detail}.${restartOwed} `,
      context:
        `\n\nPOST-UPDATE SYNC FAILED (${t.label}): ${hop} — ${result.detail}. No marker was written, so it ${t.retry}; tell the user and fix the cause.` +
        (result.restart ? ` sync-agents DID refresh agents before the failure: ${t.restartLong}` : ''),
    };
  }
  let warning = '';
  try {
    writeFileSync(markerPath, `${current}\n`);
  } catch (err) {
    warning = `✗ ${hop}: agents synced, but ${markerPath} could not be written (${err?.code ?? err?.message ?? err}) — the sync ${t.rerun} until it can. `;
  }
  const restartLine = result.restart ? t.restartShort : 'agents synced, none changed';
  warning ||= `⚠ ${hop}: ${restartLine}. `;
  return {
    outcome: 'synced',
    warning,
    context:
      `\n\nPOST-UPDATE SYNC (${t.label}): ${hop} — ${restartLine}.` +
      (result.restart ? ` ${t.restartLong}` : '') +
      (result.drift ? ` Contract drift in this project (stamp-contract dry run, tolerated): ${result.driftOut}` : ''),
  };
}
