// The config migration for sync-agents and init (settings redesign, decision
// settings-redesign-build-shape-one-legacy-to-canonical-config): prepareCanonicalConfigMigration plans the
// rewrite of `<project>/.sterling/config.json` into the canonical shape (toCanonicalConfig in packages/schemas)
// and writes nothing; commitConfigMigration replaces the file only if its bytes are still the ones the plan was
// made from (the compare-and-swap config_set in packages/mcp-server uses, mirrored here because a bundled bin
// cannot import the MCP server), keeping the file's mode. A concurrent change is refused, never lost.
// Before the transform, a file that has not been through it gets the steps below, once per file, DROP ONLY and
// reported: migrateRetiredModelKeys (retired models keys, never carried), migrateStaleAgyModels, then
// moveImplementorHardTask (models.implementor.hard_task into models.implementor-hard, decision
// hard-implementor-is-its-own-agent-sterling-implementor-hard) and resetOverpassDefaults (removes
// overpass.roles and sets conductor_bypass, decision overpass-per-role-default-tiers-implementor-premium-sparring-premium-max).
// addModelDefaults is retired with the per-host model fields it wrote. A config that cannot be carried is never
// touched, and a result that fails canonicalConfigSchema is never written.
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERPASS_DEFAULTS_MIGRATION_ID, canonicalConfigSchema, migrateRetiredModelKeys, migrateStaleAgyModels, moveImplementorHardTask, resetOverpassDefaults, toCanonicalConfig } from '@sterling/schemas';
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
      : d.key === 'classifiers'
        ? `${CONFIG_MIGRATION_LINE_PREFIX}models.classifiers dropped (a retired key: it belonged to the retired Haiku noise-gate and nothing read it); value was ${show(d.value)}`
        : `${CONFIG_MIGRATION_LINE_PREFIX}models.${d.key} dropped (a retired key, ignored since the roster rename); value was ${show(d.value)}; set models.<role> in the System tab for the role you want it on`
  );
}

/** One report line per agy_model dropped for not being one of agy's four values (GitHub #310). */
export function describeStaleAgy(dropped) {
  return dropped.map((d) => `${CONFIG_MIGRATION_LINE_PREFIX}models.${d.role}.agy_model dropped (agy accepts only inherit, flash_lite, flash or pro, and drops a subagent with any other model); value was ${show(d.value)}, so the ${d.role} agy agent now runs on model: inherit; pick one of the four in the System tab if you want one`);
}

/** The report line of the implementor-hard move (moveImplementorHardTask), or none. */
export function describeHardMove(move) {
  if (!move) return [];
  if (move.kind === 'moved') return [`${CONFIG_MIGRATION_LINE_PREFIX}models.implementor.hard_task ${show(move.hard_task)} moved to models.implementor-hard as ${show(move.entry)}, the sterling/implementor-hard agent's model; change it in the System tab`];
  if (move.kind === 'dropped') return [`${CONFIG_MIGRATION_LINE_PREFIX}models.implementor.hard_task dropped (value was ${show(move.hard_task)}); models.implementor-hard ${show(move.entry)} was already set and is kept`];
  return [`${CONFIG_MIGRATION_LINE_PREFIX}models.implementor-hard added as ${show(move.entry)}, a copy of models.implementor, because models.implementor had no hard_task (no separate hard lane); change it in the System tab`];
}

/** The report lines of the Overpass defaults reset (resetOverpassDefaults), or none. */
export function describeOverpassReset(reset) {
  if (!reset.changed) return [];
  const lines = [];
  if (reset.rolesRemoved) lines.push(`${CONFIG_MIGRATION_LINE_PREFIX}overpass.roles removed (value was ${show(reset.rolesRemoved.value)}); every role now runs on its default tier`);
  if (reset.bypassSet) lines.push(`${CONFIG_MIGRATION_LINE_PREFIX}overpass.conductor_bypass set to true (was ${reset.bypassSet.was === undefined ? 'unset' : show(reset.bypassSet.was)}); the conductor keeps its direct model pin`);
  if (!lines.length) lines.push(`${CONFIG_MIGRATION_LINE_PREFIX}overpass defaults already in place; recorded ${OVERPASS_DEFAULTS_MIGRATION_ID} in applied_config_migrations so they are never reset again`);
  return lines;
}

class ConcurrentChange extends Error {}

/** The file's lstat when the rewrite would stay inside the project, else `{refused}`.
 *  A linked .sterling would send the rewrite to a config outside the project. */
function rewritable(projectDir, configPath, refuse) {
  try {
    containedPath(projectDir, '.sterling', 'dir');
  } catch (err) {
    if (err instanceof ContainmentError) return { refused: refuse(`sits under a .sterling that is not a plain directory inside the project (${oneLine(err)}), so the rewrite could land outside it`) };
    throw err;
  }
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink()) return { refused: refuse('is a symlink, which the rewrite would replace') };
  return { stat };
}

const oneLine = (err) => err.message.replace(/\s+/g, ' ');

/** Commit a plan from prepareCanonicalConfigMigration. A plan that is not `ready` is returned as it is.
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

// ── The canonical migration (decision settings-redesign-build-shape-one-legacy-to-canonical-config) ──
// Rewrites a legacy config into the canonical shape (toCanonicalConfig in packages/schemas) through the
// same compare-and-swap commit. Unlike prepareConfigMigration it does NOT validate the file against the
// legacy schema first: the transform is the tolerant reader, and a value it cannot carry is a refusal.
// The legacy one-time steps above run first, once per file, so a file that missed them gets them as a
// sync would have given them (except the model-defaults add, which one model per agent retires); a file that records CANONICAL_CONFIG_MIGRATION_ID skips them (they
// would put legacy fields back). The result must pass canonicalConfigSchema, the strict write check.
// A role with two models (a Claude model and a different OpenCode model) is never decided here: the
// plan's status is 'conflicts' and it cannot be committed until the caller passes a resolution for
// every conflicting role (the update asks the user, OpenCode preselected).
export const CANONICAL_CONFIG_MIGRATION_ID = 'canonical-config-2026-11-19';

/** True when the transform would change nothing: a canonical document that does not yet record the id. */
function isCanonicalAlready(raw) {
  try {
    const r = toCanonicalConfig(raw);
    return r.changes.length === 0 && r.conflicts.length === 0;
  } catch {
    return false; // not canonical; the transform below throws again and the plan is refused with the cause
  }
}

const describeValue = (v) => (v === undefined ? 'unset' : show(v));

/** One report line per transform change. */
export function describeCanonicalChanges(changes) {
  return changes.map((c) =>
    Object.prototype.hasOwnProperty.call(c, 'now')
      ? `${CONFIG_MIGRATION_LINE_PREFIX}${c.path} set to ${show(c.now)} (was ${describeValue(c.was)})`
      : `${CONFIG_MIGRATION_LINE_PREFIX}${c.path} removed (value was ${show(c.was)})`
  );
}

/** One line per unresolved conflict. */
export function describeConflicts(conflicts) {
  return conflicts.map((c) => `${CONFIG_MIGRATION_LINE_PREFIX}models.${c.role} has two models: Claude Code runs ${show(c.claude.model)}, OpenCode runs ${show(c.opencode.model)}; an agent has one model, so choose one (OpenCode preselected)`);
}

/** Plan the canonical rewrite of `<projectDir>/.sterling/config.json`; writes nothing.
 *  status: absent, unchanged, ready, conflicts (`conflicts` lists the roles to ask about) or refused. */
export function prepareCanonicalConfigMigration(projectDir, { resolutions } = {}) {
  const configPath = join(projectDir, '.sterling', 'config.json');
  if (!existsSync(configPath)) return { status: 'absent', lines: [] };
  const shown = configPath.replace(/\\/g, '/');
  const refuse = (why) => ({ status: 'refused', lines: [`config migration refused: ${shown} ${why}; left untouched`] });
  const originalBytes = readFileSync(configPath);
  let raw;
  try {
    raw = JSON.parse(originalBytes.toString('utf8'));
  } catch (err) {
    return refuse(`is not valid JSON (${oneLine(err)})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('is not a JSON object');
  const applied = Array.isArray(raw.applied_config_migrations) ? raw.applied_config_migrations : [];
  // Retired models keys and stale agy values are dropped (and reported) from EVERY file, canonical or not: the transform
  // ignores them in memory, but only this step removes them from disk. The hard_task move and the Overpass reset are
  // legacy-only and run once, for a file that has not been through the transform.
  const m = migrateRetiredModelKeys(raw);
  const a = migrateStaleAgyModels(m.config);
  let legacy = a.config;
  const legacyLines = [...describeMigration(m.dropped), ...describeStaleAgy(a.dropped)];
  if (!applied.includes(CANONICAL_CONFIG_MIGRATION_ID) && !isCanonicalAlready(raw)) {
    // addModelDefaults is NOT run here: it wrote the per-host opencode_model defaults (reviewer, sparring)
    // that one model per agent removes, and would make every file that never set one a model conflict.
    const h = moveImplementorHardTask(legacy);
    const o = resetOverpassDefaults(h.config);
    if (o.refusal) return refuse(o.refusal);
    legacy = o.config;
    legacyLines.push(...describeHardMove(h.move), ...describeOverpassReset(o));
  }
  let result;
  try {
    result = toCanonicalConfig(legacy, { resolutions });
  } catch (err) {
    return refuse(`cannot be carried to the canonical shape (${oneLine(err)})`);
  }
  const config = result.config;
  if (!applied.includes(CANONICAL_CONFIG_MIGRATION_ID)) config.applied_config_migrations = [...(Array.isArray(config.applied_config_migrations) ? config.applied_config_migrations : []), CANONICAL_CONFIG_MIGRATION_ID];
  if (result.conflicts.length) return { status: 'conflicts', conflicts: result.conflicts, lines: describeConflicts(result.conflicts) };
  if (JSON.stringify(config) === JSON.stringify(raw)) return { status: 'unchanged', lines: [] };
  const placed = rewritable(projectDir, configPath, refuse);
  if (placed.refused) return placed.refused;
  const checked = canonicalConfigSchema.safeParse(config);
  if (!checked.success) return refuse(`would not validate after the migration (${oneLine(checked.error)})`);
  const text = originalBytes.toString('utf8');
  return {
    status: 'ready',
    configPath,
    shown,
    originalBytes,
    mode: placed.stat.mode & 0o777,
    next: JSON.stringify(config, null, 2) + (text.endsWith('\n') ? '\n' : ''),
    config,
    changes: result.changes,
    lines: [...legacyLines, ...describeCanonicalChanges(result.changes)],
  };
}

/** Plan and commit the canonical rewrite (prepareCanonicalConfigMigration, then commitConfigMigration).
 *  Returns the plan unchanged when it is not `ready` (absent, unchanged, conflicts or refused), else the
 *  commit's result (migrated, or refused when the file changed under the write). */
export function migrateProjectConfigCanonical(projectDir, { resolutions, ...opts } = {}) {
  return commitConfigMigration(prepareCanonicalConfigMigration(projectDir, { resolutions }), opts);
}

/** Read the repeatable `--model-choice <role>=claude|opencode` flag from an argument list. Throws an
 *  Error naming the bad value; callers print it and exit 2. Returns { <role>: 'claude' | 'opencode' }. */
export function modelChoicesFromArgs(args) {
  const resolutions = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--model-choice') continue;
    const value = args[i + 1] ?? '';
    const m = /^([^=\s]+)=(claude|opencode)$/.exec(value);
    if (!m) throw new Error(`--model-choice needs <role>=claude|opencode, got ${JSON.stringify(value)}`);
    resolutions[m[1]] = m[2];
    i += 1;
  }
  return resolutions;
}

/** The exit-2 line for unresolved model conflicts: each role, and the flag that answers it. */
export function describeConflictRefusal(conflicts) {
  const roles = conflicts.map((c) => c.role);
  return `refused_model_conflicts: ${roles.join(', ')} each name two models (a Claude model and an OpenCode model) and an agent has one; ` +
    `ask which to keep for each, then rerun with ${roles.map((r) => `--model-choice ${r}=claude|opencode`).join(' ')}; nothing synced`;
}
