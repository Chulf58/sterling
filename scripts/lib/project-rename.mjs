// list-projects --rename <path> <new-name> [--apply] (decision
// config-project-name-decides-the-registry-name, GitHub #113). The project's config.json
// project_name and its registry row are written together, because the session-start refresh
// (scripts/hooks/lib/registry-refresh.mjs) makes the config the authority: a registry-only
// rename would be undone at the project's next session. config.json is editable by any tool;
// only sterling.db is MCP-only, and this never touches it. The CLI is the only caller.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sameLocationAnyHost } from '@sterling/schemas';

/** Rewrite one key of a JSON object file, keeping its indent and trailing newline. */
function writeProjectName(cfgPath, raw, obj, name) {
  const indent = raw.match(/^([ \t]+)\S/m)?.[1] ?? '  ';
  const text = `${JSON.stringify({ ...obj, project_name: name }, null, indent)}${raw.endsWith('\n') ? '\n' : ''}`;
  const tmp = `${cfgPath}.rename-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, cfgPath);
}

/**
 * Preview (apply false) or perform (apply true) the rename of the project at <input>.
 * Returns the exit code: 0 done or nothing to change, 1 refused or failed. `registry` is an
 * open ProjectRegistry; `log` receives every output line.
 */
export function renameProject(registry, input, newNameInput, { apply = false, log = console.log } = {}) {
  const abs = resolve(input);
  const name = typeof newNameInput === 'string' ? newNameInput.trim() : '';
  const refusals = [];
  if (!name) refusals.push('the new name is empty');

  const real = existsSync(abs) ? realpathSync(abs) : undefined;
  const rows = registry.list();
  const mine = rows.filter((r) => sameLocationAnyHost(r.repo_path, abs) || (real !== undefined && sameLocationAnyHost(r.repo_path, real)));
  let row;
  if (mine.length === 0) refusals.push(`no registered project is at ${abs}; run list-projects.mjs to see the registered paths`);
  else if (mine.length > 1) refusals.push(`${mine.length} registry rows match ${abs} (${mine.map((r) => `${r.name} at ${r.repo_path}`).join('; ')}); the target is ambiguous`);
  else row = mine[0];

  const taken = name ? rows.find((r) => r !== row && r.name === name) : undefined;
  if (taken) refusals.push(`the name '${name}' is already used by the project at ${taken.repo_path}; two projects cannot share a name`);

  const cfgPath = join(abs, '.sterling', 'config.json');
  let raw;
  let cfg;
  if (row) {
    try {
      raw = readFileSync(cfgPath, 'utf8');
      cfg = JSON.parse(raw);
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        refusals.push(`${cfgPath} is not a JSON object`);
        cfg = undefined;
      }
    } catch (e) {
      refusals.push(e?.code === 'ENOENT' ? `no ${cfgPath}; this is not an initialized Sterling project` : `${cfgPath} is unreadable: ${e.message}`);
    }
  }

  log(apply ? 'Rename\n' : 'Rename preview (dry run; nothing is changed)\n');
  if (row) {
    log(`Project: ${row.name} (${row.repo_path})`);
    log(`New name: ${name || '(empty)'}`);
    if (cfg) log(`config.json project_name: ${typeof cfg.project_name === 'string' ? cfg.project_name : '(not set)'} -> ${name}`);
    log(`Registry row name: ${row.name} -> ${name}`);
  }
  if (refusals.length) {
    log(`\n--rename ${apply ? 'REFUSED' : '--apply would REFUSE'}:`);
    for (const r of refusals) log(`  - ${r}`);
    return 1;
  }
  if (cfg.project_name === name && row.name === name) {
    log(`\nNothing to change: the config and the registry already say '${name}'.`);
    return 0;
  }
  if (!apply) {
    log(`\n--apply would write ${cfgPath} and rename the registry row. Other projects' trackers that mention '${row.name}' are not rewritten.`);
    return 0;
  }
  // The row goes first: its check-and-write is one transaction, so a name taken since the
  // preview refuses here with nothing written. A config write that then fails leaves the
  // row renamed; re-running the same command finishes it.
  try {
    const renamed = registry.renameIfUnique(row.repo_path, name, mine.map((r) => r.repo_path));
    if (renamed.status === 'conflict') {
      log(`\n--rename REFUSED:\n  - the name '${name}' is already used by the project at ${renamed.conflict_path}; two projects cannot share a name. Nothing was written.`);
      return 1;
    }
    if (renamed.status === 'missing') throw new Error(`no registry row for ${row.repo_path} was found to rename`);
    if (cfg.project_name !== name) writeProjectName(cfgPath, raw, cfg, name);
  } catch (e) {
    log(`\nRename FAILED: ${e.message}. config.json and the registry row may disagree now; re-run the same command to finish it.`);
    return 1;
  }
  log(`\nRenamed ${row.name} -> ${name}: config.json project_name and the registry row are both updated.`);
  return 0;
}
