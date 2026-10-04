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
// It does NOT run on an ordinary session start, and it does not cover OpenCode, whose
// server plugin runs its own post-update sync.
//
// Builtins only: H1's bundle vendors this module.
import { spawnSync } from 'node:child_process';
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

/** Runs the map for one project. Returns { add: [{domain, reason}], registered } or { error }. */
export function runDomainMap(root, project, { nodeBin = process.execPath } = {}) {
  if (!root) return { error: 'the Sterling plugin root is unresolved' };
  const script = pluginScript(root, 'domains.mjs');
  if (!existsSync(script)) return { error: `${script} is missing` };
  const r = spawnSync(nodeBin, [script, '--target', project, '--json'], { cwd: project, encoding: 'utf8', timeout: DOMAIN_MAP_TIMEOUT_MS });
  if (r.error) return { error: r.error.message };
  if (r.signal) return { error: `killed by ${r.signal}` };
  if (r.status !== 0) return { error: `exit ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ')}` };
  try {
    return parseDomainProposal(r.stdout);
  } catch (err) {
    return { error: `its output could not be read (${err?.message ?? err})` };
  }
}

const HEAD = 'DOMAIN MAP (H1, once after the Sterling update):';

/**
 * The banner segment and the conductor line for a map result, or null when there is
 * nothing to say (no proposal and no new registration). Both carry H1's spacing.
 */
export function domainNotice(result) {
  if (result.error) {
    return {
      warning: '⚠ Domain map check after the update could not run — run /sterling:domains. ',
      context: `\n\n${HEAD} the map could not be computed (${result.error}), so whether this project is missing a domain is unknown. Run /sterling:domains to see it.`,
    };
  }
  const registered = result.registered ? " This project was not in the project registry and is now registered, so other projects' maps list it." : '';
  if (!result.add.length) return registered ? { warning: '', context: `\n\n${HEAD}${registered}` } : null;
  const names = result.add.map((a) => `'${a.domain}'`).join(', ');
  return {
    warning: `⚠ Domain map: this project does not mount ${names} — run /sterling:domains to see why and add ${result.add.length === 1 ? 'it' : 'them'} (nothing was changed). `,
    context: `\n\n${HEAD} the map proposes adding ${names} to this project's mounts. Nothing was applied. Run /sterling:domains to show the map; it adds a domain only after the user agrees.${registered}`,
  };
}
