// DOMAIN MAP NOTICE (board item the-domain-map-runs-by-itself-the-first-time-after-an-update;
// decision consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command). The
// first session start in a project after a Sterling update runs the domain map
// (`domains.mjs --target <project> --json`) and prints one line when the map proposes a
// mount, pointing at /sterling:domains. It never applies a mount. That report run also
// registers a project the registry lacks, which is the only registration a session start does.
//
// WHEN IT IS DUE, and what makes it once-only:
//   - 'marker': /sterling:update left <project>/.sterling/domain-map-pending (a clone
//     machine). H1 deletes the file in the session start that reads it, whatever the map
//     says, so the line shows once.
//   - 'sync': this installed copy is newer than the project's sync marker, so the post-update
//     sync is about to run. The map runs BEFORE it, because the sync's contract check fails
//     for a project the registry lacks. The line is printed only in the session whose sync
//     succeeds; that sync writes .sterling/synced-version, after which nothing is due.
// ACCEPTED COST: while a due sync keeps failing, the map is spawned again at every session
// start (it has to run before the sync, and nothing is recorded until a sync succeeds). The
// line is still printed once, in the session whose sync succeeds.
// It does NOT run on an ordinary session start. The OpenCode server plugin applies the same
// rule from its own post-update sync (packages/opencode-plugin/src/sync.mjs), through
// runDomainMapAsync, so its event loop is never blocked.
//
// Builtins only: H1's bundle and the OpenCode server bundle vendor this module.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMAIN_MAP_PENDING_REL, parseDomainProposal } from '../../lib/update.mjs';
import { SYNC_MARKER_REL, compareVersions, parseVersion, pluginScript, postUpdateApplies, readPluginVersion } from '../../lib/post-update-sync.mjs';
import { WORKER_ENV_FLAG } from './maintenance-worker.mjs';

// One spawn, bounded well inside H1's hooks.json timeout beside the two sync steps.
export const DOMAIN_MAP_TIMEOUT_MS = 30_000;

/**
 * 'marker', 'sync' or null. The background maintenance worker's headless session is
 * never due: it would spend the line where no person reads it.
 */
export function domainMapDue(root, project, env = process.env) {
  if (env[WORKER_ENV_FLAG] === '1') return null;
  if (existsSync(join(project, DOMAIN_MAP_PENDING_REL))) return 'marker';
  if (!postUpdateApplies(root, project)) return null;
  const current = readPluginVersion(root);
  if (!current || !parseVersion(current)) return null;
  let previous = null;
  try {
    previous = readFileSync(join(project, SYNC_MARKER_REL), 'utf8').trim() || null;
  } catch {
    // absent or unreadable: never synced, as the post-update sync reads it
  }
  return previous === null || (compareVersions(current, previous) ?? 1) > 0 ? 'sync' : null;
}

// The map CLI of this Sterling copy, or the reason it cannot be run.
function mapScript(root) {
  if (!root) return { error: 'the Sterling plugin root is unresolved' };
  const script = pluginScript(root, 'domains.mjs');
  return existsSync(script) ? { script } : { error: `${script} is missing` };
}
const mapArgs = (script, project) => [script, '--target', project, '--json'];

// A finished map run as { add, registered } or { error }.
function mapResult({ error, signal, status, stdout, stderr }) {
  if (error) return { error };
  if (signal) return { error: `killed by ${signal}` };
  if (status !== 0) return { error: `exit ${status}: ${`${stdout ?? ''}${stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ')}` };
  try {
    return parseDomainProposal(stdout);
  } catch (err) {
    return { error: `its output could not be read (${err?.message ?? err})` };
  }
}

/** Runs the map for one project (H1). Returns { add: [{domain, reason}], registered } or { error }. */
export function runDomainMap(root, project, { nodeBin = process.execPath } = {}) {
  const { script, error } = mapScript(root);
  if (error) return { error };
  const r = spawnSync(nodeBin, mapArgs(script, project), { cwd: project, encoding: 'utf8', timeout: DOMAIN_MAP_TIMEOUT_MS });
  return mapResult({ error: r.error?.message, signal: r.signal, status: r.status, stdout: r.stdout, stderr: r.stderr });
}

/** The same run without blocking the event loop (the OpenCode plugin). Resolves, never rejects. */
export function runDomainMapAsync(root, project, { nodeBin = process.execPath } = {}) {
  const { script, error } = mapScript(root);
  if (error) return Promise.resolve({ error });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(mapResult(r));
    };
    let child;
    try {
      child = spawn(nodeBin, mapArgs(script, project), { cwd: project, timeout: DOMAIN_MAP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e.message });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      spawnError = e;
      // A child that never started emits no 'close' on every Node version.
      if (child.pid === undefined) finish({ error: e.message });
    });
    child.on('close', (status, signal) => finish({ error: spawnError?.message, signal, status, stdout, stderr }));
  });
}

/** What to say when the update's pending file could not be removed after it was read. */
export function pendingFileNote(path, err) {
  return ` The pending file ${path} could not be removed (${err?.code ?? err?.message ?? err}), so this check runs again at the next session start; delete it by hand.`;
}

/**
 * The banner segment and the conductor line for a map result, or null when there is
 * nothing to say (no proposal, no new registration and no note). Both carry H1's spacing.
 * `label` names the host that prints it ('H1' or 'OpenCode plugin'); `note` is appended to
 * the line (pendingFileNote) and is printed even when the map proposes nothing.
 */
export function domainNotice(result, { label = 'H1', note = '' } = {}) {
  const HEAD = `DOMAIN MAP (${label}, once after the Sterling update):`;
  if (result.error) {
    return {
      warning: '⚠ Domain map check after the update could not run — run /sterling:domains. ',
      context: `\n\n${HEAD} the map could not be computed (${result.error}), so whether this project is missing a domain is unknown. Run /sterling:domains to see it.${note}`,
    };
  }
  const registered = (result.registered ? " This project was not in the project registry and is now registered, so other projects' maps list it." : '') + note;
  if (!result.add.length) return registered ? { warning: '', context: `\n\n${HEAD}${registered}` } : null;
  const names = result.add.map((a) => `'${a.domain}'`).join(', ');
  return {
    warning: `⚠ Domain map: this project does not mount ${names} — run /sterling:domains to see why and add ${result.add.length === 1 ? 'it' : 'them'} (nothing was changed). `,
    context: `\n\n${HEAD} the map proposes adding ${names} to this project's mounts. Nothing was applied. Run /sterling:domains to show the map; it adds a domain only after the user agrees.${registered}`,
  };
}
