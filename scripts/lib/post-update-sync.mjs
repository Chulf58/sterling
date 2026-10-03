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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';
import { compareSterlingVersions, installHostOf, parseSterlingVersion, sterlingUpdateRemedy } from './sterling-roots.mjs';

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
  },
  opencode: {
    label: 'OpenCode plugin',
    restartShort: 'agents synced — RESTART to load them (EXIT AND RELAUNCH OpenCode; a /new is NOT enough)',
    restartLong: 'RESTART REQUIRED — agents load when OpenCode starts: EXIT AND RELAUNCH OpenCode before dispatching any agent.',
    retry: 'retries the next time OpenCode starts',
    rerun: 're-runs at every OpenCode start',
  },
};

// How to update an installed copy, by the host that INSTALLED it (installHostOf), not the
// host asking: on a dual-host machine OpenCode can run a Claude-cache copy and H1 an npm
// copy. The OpenCode copy updates through `opencode plugin update` (decision
// sterling-on-opencode-installs-from-a-git-release-branch-v2).
const UPDATE_ROUTE = {
  'claude-code': 'update it through /plugin (Installed tab → Update)',
  opencode: `update it with ${sterlingUpdateRemedy('opencode')}`,
};
// A copy under neither install root (installed, so not a git clone, but somewhere the
// resolver does not scan) takes the asking host's own install route.
const ASKING_HOST_INSTALL = { claude: 'claude-code', opencode: 'opencode' };

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

/** { core: [major, minor, patch], pre: [identifiers] } or null for a string that is not semver. */
export const parseVersion = parseSterlingVersion;

/**
 * Semver precedence: -1, 0 or 1, or null when either side is not a version. The order is
 * the resolver's compareSterlingVersions (sterling-roots.mjs), the one comparator both hosts
 * use; this wrapper only turns its throw on a non-version into null.
 */
export function compareVersions(a, b) {
  if (!parseVersion(a) || !parseVersion(b)) return null;
  return compareSterlingVersions(a, b);
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
 * non-zero a failure; stamp-contract exit 2 is tolerated drift, but any
 * "0 project(s) processed" (exit 0 or a refusal-only exit 2) checked nothing, which is a failure (P5).
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
  if (/—\s*0 project\(s\) processed/.test(contract.out)) {
    // Exit 0 or 2: either way nothing was checked. A refusal that processed nothing
    // (e.g. not_migrated, no AGENTS.md) is not drift in a synced project; its reason is named.
    const refusals = contract.out.split('\n').filter((l) => l.startsWith('✗')).map((l) => l.trim());
    if (refusals.length) return { ok: false, restart, detail: `stamp-contract checked NOTHING for ${project} (0 project(s) processed, refused: ${refusals.join('; ')})` };
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
export async function postUpdateSync({ root, project, host = 'claude', runStep = runStepSync, env = process.env, home = homedir() }) {
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
    const update = UPDATE_ROUTE[installHostOf(root, { env, home }) ?? ASKING_HOST_INSTALL[host]];
    return {
      outcome: 'refused-older',
      warning: `✗ Sterling ${current} is OLDER than this project's sync marker ${previous}: post-update sync REFUSED, nothing downgraded — ${update}. `,
      context: `\n\nPOST-UPDATE SYNC REFUSED (${t.label}): this Sterling copy is ${current}, older than this project's sync marker ${previous} (${markerPath}), which a newer Sterling on another host wrote. Nothing was synced, so agents and templates are not downgraded. Tell the user to update this host's Sterling: ${update}.`,
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
