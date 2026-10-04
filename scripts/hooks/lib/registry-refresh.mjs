// THE PROJECT'S OWN REGISTRY ROW AT A SESSION START, shared by H1 (Claude Code) and the
// OpenCode server plugin's root-session context (packages/opencode-plugin/src/context.mjs):
// touch last-seen and bring the row's stack tags in line with the project's config, so a
// mount added by a config edit reaches other projects' sibling lists and maps by this
// project's next session start. init and /sterling:domains --apply write the row themselves.
//
// It never creates the registry and never creates a row: registration is init's, and the
// domain map's report run in the session after an update (domain-notice.mjs). Only tags and
// last-seen change; the row's init dates and version stay init's. The row is matched with
// sameLocationAnyHost, as scripts/domains.mjs matches it, so a row a Windows host spelled
// with backslashes or a drive letter is the same row.
import { existsSync } from 'node:fs';
import { parseConfig, sameLocationAnyHost } from '@sterling/schemas';
import { ProjectRegistry, registryPath } from '@sterling/store';

/**
 * `config` is the project's raw .sterling/config.json object (null when absent). Returns
 * { siblings } (every other row, as read before the refresh), or null when there is no
 * registry file. A store error throws: the caller owns how loud that is.
 */
export function refreshRegistryRow(cwd, { config, configUnreadable = false, at = new Date().toISOString() } = {}) {
  if (!existsSync(registryPath())) return null;
  const cwdPosix = cwd.replace(/\\/g, '/');
  const isThisProject = (p) => sameLocationAnyHost(p.repo_path, cwdPosix);
  let mounts = null;
  try {
    if (config && !configUnreadable) mounts = parseConfig(config).stack_tags;
  } catch {
    // a config that does not parse is reported by the mounted-domain lines; the row keeps its tags
  }
  let registry;
  try {
    registry = new ProjectRegistry(registryPath());
    const rows = registry.list();
    for (const row of rows.filter(isThisProject)) {
      registry.touchLastSeen(row.repo_path, at);
      if (mounts && JSON.stringify(row.stack_tags) !== JSON.stringify(mounts)) registry.updateStackTags(row.repo_path, mounts);
    }
    return { siblings: rows.filter((p) => !isThisProject(p)) };
  } finally {
    registry?.close();
  }
}
