// Drop retired config.models keys from a project's .sterling/config.json, for
// sync-agents and init (board c45a4507). DROP ONLY, never a carry (user-ruled
// 2026-10-23): the keys have been ignored since the roster rename, so removing
// one changes no rendered model; each removed value is reported so the user can
// set the successor by hand. The rewrite is migrateRetiredModelKeys in
// packages/schemas; this wraps it in two steps so a caller can defer the write:
//   prepareConfigMigration  reads, parses and plans; writes nothing.
//   commitConfigMigration   replaces the file only if its bytes are still the ones
//                           the plan was made from (the compare-and-swap config_set
//                           in packages/mcp-server uses, mirrored here because a
//                           bundled bin cannot import the MCP server), keeping the
//                           file's mode. A concurrent change is refused, never lost.
// A config that does not parse is never touched, and a migrated config that would
// not parse is never written. The output stays the raw document minus the retired
// keys: parseConfig is a gate only, never serialized (it would materialize defaults).
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateRetiredModelKeys, parseConfig } from '@sterling/schemas';
import { writeFileAtomic } from './atomic-write.mjs';
import { containedPath, ContainmentError } from './contained-fs.mjs';

/** Prefix of every report line; sync-agents prints them and update/post-update relay them by it. */
export const CONFIG_MIGRATION_LINE_PREFIX = 'config migration: ';

const show = (value) => JSON.stringify(value);

/** One report line per dropped key. */
export function describeMigration(dropped) {
  return dropped.map((d) =>
    d.renamed_to
      ? `${CONFIG_MIGRATION_LINE_PREFIX}models.${d.key} dropped (ignored since the roster rename to models.${d.renamed_to}); value was ${show(d.value)}; set models.${d.renamed_to} in the System tab if you want it`
      : `${CONFIG_MIGRATION_LINE_PREFIX}models.${d.key} dropped (a retired key, ignored since the roster rename); value was ${show(d.value)}; set models.<role> in the System tab for the role you want it on`
  );
}

class ConcurrentChange extends Error {}

const oneLine = (err) => err.message.replace(/\s+/g, ' ');

/** Plan the migration of `<projectDir>/.sterling/config.json` and write nothing.
 *  status: absent (no file), unchanged (no retired key), ready (a plan to commit) or
 *  refused (the file stays as it is; `lines[0]` says why). */
export function prepareConfigMigration(projectDir) {
  const configPath = join(projectDir, '.sterling', 'config.json');
  if (!existsSync(configPath)) return { status: 'absent', lines: [] };
  const shown = configPath.replace(/\\/g, '/');
  const refuse = (why) => ({ status: 'refused', lines: [`config migration refused: ${shown} ${why}; left untouched`] });
  const originalBytes = readFileSync(configPath);
  let raw;
  try {
    raw = JSON.parse(originalBytes.toString('utf8'));
    parseConfig(raw);
  } catch (err) {
    return refuse(`does not parse or validate (${oneLine(err)})`);
  }
  const m = migrateRetiredModelKeys(raw);
  if (!m.changed) return { status: 'unchanged', lines: [] };
  // A linked .sterling would send the rewrite to a config outside the project.
  try {
    containedPath(projectDir, '.sterling', 'dir');
  } catch (err) {
    if (err instanceof ContainmentError) return refuse(`sits under a .sterling that is not a plain directory inside the project (${oneLine(err)}), so the rewrite could land outside it`);
    throw err;
  }
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink()) return refuse('is a symlink, which the rewrite would replace');
  try {
    parseConfig(m.config);
  } catch (err) {
    return refuse(`would not validate after the migration (${oneLine(err)})`);
  }
  const text = originalBytes.toString('utf8');
  return {
    status: 'ready',
    configPath,
    shown,
    originalBytes,
    mode: stat.mode & 0o777,
    next: JSON.stringify(m.config, null, 2) + (text.endsWith('\n') ? '\n' : ''),
    config: m.config,
    dropped: m.dropped,
    lines: describeMigration(m.dropped),
  };
}

/** Commit a plan from prepareConfigMigration. A plan that is not `ready` is returned as it is.
 *  Returns { ...plan, status: 'migrated' }, or { status: 'refused', lines } when the file changed
 *  since it was read or the write failed (nothing is written). `beforeRename` is a test seam that runs inside the
 *  window between the temp write and the final compare. Residual, as in config_set: the
 *  sliver between that compare and the rename needs a file lock this does not take. */
export function commitConfigMigration(plan, { beforeRename } = {}) {
  if (plan.status !== 'ready') return plan;
  const unchanged = () => {
    try {
      return readFileSync(plan.configPath).equals(plan.originalBytes);
    } catch {
      return false;
    }
  };
  const concurrent = () => ({
    status: 'refused',
    lines: [`config migration refused: ${plan.shown} changed on disk while the migration was in flight (a concurrent change); left untouched`],
  });
  if (!unchanged()) return concurrent();
  try {
    writeFileAtomic(plan.configPath, plan.next, {
      writeFile: (tmp, content) => {
        writeFileSync(tmp, content, { mode: plan.mode });
        chmodSync(tmp, plan.mode);
      },
      rename: (tmp, path) => {
        beforeRename?.();
        if (!unchanged()) throw new ConcurrentChange();
        renameSync(tmp, path);
      },
    });
  } catch (err) {
    if (err instanceof ConcurrentChange) return concurrent();
    // A failed temp write or rename (a read-only directory, a full disk): the file is untouched
    // and the caller stops, so it is a refusal with its cause, never an uncaught throw.
    return { status: 'refused', lines: [`config migration refused: ${plan.shown} could not be rewritten (${err.code ?? oneLine(err)}); left untouched`] };
  }
  return { ...plan, status: 'migrated' };
}

/** prepare and commit in one go (sync-agents). */
export function migrateProjectConfig(projectDir, opts) {
  return commitConfigMigration(prepareConfigMigration(projectDir), opts);
}
