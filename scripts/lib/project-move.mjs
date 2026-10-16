// list-projects --move <name|old-path> <new-path> [--apply] (GitHub issue #119, decision
// moving-a-project-folder-repoints-the-registry-and-keeps-old-paths-as-aliases). After a
// project folder was moved by hand, this repoints its registry row at the new folder. The
// row keeps its project key and the registry records when the project left the old path,
// so hand-off trackers in other projects that still name the old folder resolve to the
// moved project, and a project that registers at the old path later does not inherit them. It repairs the registration only: it moves
// no files and rewrites nothing in any project (anti_pattern 50e2e423 covers the generated
// agent files). The CLI is the only caller.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sameLocationAnyHost } from '@sterling/schemas';

/**
 * Preview (apply false) or perform (apply true) the move of the project named by <from>
 * (a registered path or a registry name) to <toInput>. Returns the exit code: 0 done or
 * nothing to change, 1 refused or failed. `registry` is an open ProjectRegistry; `log`
 * receives every output line; `now` gives the moved_at timestamp.
 */
export function moveProject(registry, from, toInput, { apply = false, log = console.log, now = () => new Date().toISOString() } = {}) {
  const refusals = [];
  const rows = registry.list();
  const fromAbs = resolve(from);
  const fromReal = existsSync(fromAbs) ? realpathSync(fromAbs) : undefined;
  let mine = rows.filter((r) => sameLocationAnyHost(r.repo_path, fromAbs) || (fromReal !== undefined && sameLocationAnyHost(r.repo_path, fromReal)));
  if (mine.length === 0) mine = rows.filter((r) => r.name === from);
  let row;
  if (mine.length === 0) refusals.push(`no registered project is at ${fromAbs} or is named '${from}'; run list-projects.mjs to see the registered projects`);
  else if (mine.length > 1) refusals.push(`${mine.length} registry rows match '${from}' (${mine.map((r) => `${r.name} at ${r.repo_path}`).join('; ')}); give the registered path instead`);
  else row = mine[0];

  const toAbs = resolve(toInput);
  let to;
  if (!existsSync(toAbs) || !statSync(toAbs).isDirectory()) refusals.push(`the new path ${toAbs} is not a directory; move the folder first, then run this`);
  else {
    to = realpathSync(toAbs);
    if (!existsSync(join(to, '.sterling', 'config.json'))) refusals.push(`${to} has no .sterling/config.json, so it is not an initialized Sterling project`);
    const taken = rows.find((r) => r !== row && sameLocationAnyHost(r.repo_path, to));
    if (taken) refusals.push(`${to} is already registered as the project '${taken.name}'; two rows cannot share a path`);
  }

  log(apply ? 'Move\n' : 'Move preview (dry run; nothing is changed)\n');
  if (row) {
    log(`Project: ${row.name}`);
    log(`Registry path: ${row.repo_path} -> ${to ?? toAbs}`);
    log(`The registry keeps the record that the project was at ${row.repo_path}, so hand-off trackers created before this move still find it.`);
  }
  if (refusals.length) {
    log(`\n--move ${apply ? 'REFUSED' : '--apply would REFUSE'}:`);
    for (const r of refusals) log(`  - ${r}`);
    return 1;
  }
  if (row.repo_path === to) {
    log(`\nNothing to change: the registry already has '${row.name}' at ${to}.`);
    return 0;
  }
  const scope = 'This repairs the registry only. It moves no files and changes nothing inside any project; regenerate Sterling\'s generated agent files in the moved project with sync-agents rather than rewriting their paths.';
  if (!apply) {
    log(`\n--apply would repoint the registry row and record the move. ${scope}`);
    return 0;
  }
  try {
    const moved = registry.moveProject(row.repo_path, to, now());
    if (moved.status === 'conflict') {
      log(`\n--move REFUSED:\n  - ${to} is already registered (${moved.conflict_path}); two rows cannot share a path. Nothing was written.`);
      return 1;
    }
    if (moved.status === 'missing') {
      log(`\n--move REFUSED:\n  - the registry row at ${row.repo_path} is gone since it was read. Nothing was written.`);
      return 1;
    }
  } catch (e) {
    log(`\nMove FAILED: ${e.message}. The registry transaction was rolled back; nothing was written.`);
    return 1;
  }
  log(`\nMoved ${row.name}: ${row.repo_path} -> ${to}. ${scope}`);
  return 0;
}
