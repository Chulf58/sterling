// THE PROJECT'S OWN REGISTRY ROW AT A SESSION START, shared by H1 (Claude Code) and the
// OpenCode server plugin's root-session context (packages/opencode-plugin/src/context.mjs):
// touch last-seen and bring the row's stack tags and name in line with the project's config,
// so a mount added by a config edit reaches other projects' sibling lists and maps by this
// project's next session start, and a project is known by its config.json project_name
// (decision config-project-name-decides-the-registry-name, GitHub #113). init and
// /sterling:domains --apply write the row themselves.
//
// It never creates the registry and never creates a row: registration is init's, and the
// domain map's report run in the session after an update (domain-notice.mjs). Only tags,
// name and last-seen change; the row's init dates and version stay init's. A config with no
// project_name leaves the row's name alone. When another project's row already carries the
// configured name the rename is skipped and a notice line is returned for the caller to
// show, because target_project resolves by name and two projects must not share one; the
// check and the write are one registry transaction (renameIfUnique). A config that could
// not be read writes nothing at all: only the sibling read runs. The row is matched with
// sameLocationAnyHost, as scripts/domains.mjs matches it, so a row a Windows host spelled
// with backslashes or a drive letter is the same row.
import { existsSync } from 'node:fs';
import { parseConfig, sameLocationAnyHost } from '@sterling/schemas';
import { ProjectRegistry, registryPath } from '@sterling/store';

/**
 * `config` is the project's raw .sterling/config.json object (null when absent). Returns
 * { siblings, notice } (siblings: every other row, as read before the refresh; notice: a line
 * to show when the configured project_name could not be applied, else null), or null when
 * there is no registry file. A store error throws: the caller owns how loud that is.
 */
export function refreshRegistryRow(cwd, { config, configUnreadable = false, at = new Date().toISOString() } = {}) {
  if (!existsSync(registryPath())) return null;
  const cwdPosix = cwd.replace(/\\/g, '/');
  const isThisProject = (p) => sameLocationAnyHost(p.repo_path, cwdPosix);
  let mounts = null;
  let projectName = null;
  try {
    if (config && !configUnreadable) {
      const parsed = parseConfig(config);
      mounts = parsed.stack_tags;
      if (typeof parsed.project_name === 'string' && parsed.project_name.trim()) projectName = parsed.project_name;
    }
  } catch {
    // a config that does not parse is reported by the mounted-domain lines; the row keeps its tags and name
  }
  let registry;
  try {
    registry = new ProjectRegistry(registryPath());
    const rows = registry.list();
    const siblings = rows.filter((p) => !isThisProject(p));
    let notice = null;
    // A config that could not be read says nothing about this project, so nothing is written.
    if (configUnreadable) return { siblings, notice };
    const own = rows.filter(isThisProject);
    const ownPaths = own.map((p) => p.repo_path);
    for (const row of own) {
      registry.touchLastSeen(row.repo_path, at);
      if (mounts && JSON.stringify(row.stack_tags) !== JSON.stringify(mounts)) registry.updateStackTags(row.repo_path, mounts);
      if (projectName !== null) {
        const renamed = registry.renameIfUnique(row.repo_path, projectName, ownPaths);
        if (renamed.status === 'conflict') {
          notice = `STERLING PROJECT NAME NOT APPLIED: config.json project_name '${projectName}' is already registered for ${renamed.conflict_path}, so this project stays registered as '${row.name}'. Two projects cannot share a name; pick another with node "<Sterling root>/bin/list-projects.mjs" --rename <this project's path> <new-name> --apply.`;
        }
      }
    }
    return { siblings, notice };
  } finally {
    registry?.close();
  }
}
