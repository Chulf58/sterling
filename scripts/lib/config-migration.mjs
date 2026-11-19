// Drop retired config.models keys from a project's .sterling/config.json, and add the
// model defaults a live config lacks, for sync-agents and init (board c45a4507). DROP ONLY, never a carry (user-ruled
// 2026-10-23): the keys have been ignored since the roster rename, so removing
// one changes no rendered model; each removed value is reported so the user can
// set the successor by hand. The add step (addModelDefaults in packages/schemas,
// user-ruled 2026-10-23, "Write it into each config") writes, once per file, the
// opencode_model of reviewer and sparring and the implementor's hard_task where they are
// absent, never overwriting a value, and reports each add. The move step
// (moveImplementorHardTask, decision hard-implementor-is-its-own-agent-sterling-implementor-hard)
// then moves models.implementor.hard_task into models.implementor-hard, once per file, and
// reports it. The last step (resetOverpassDefaults, decision overpass-per-role-default-tiers-implementor-
// premium-sparring-premium-max) removes config.overpass.roles and sets overpass.conductor_bypass true,
// once per file, touching those two keys only. The rewrites are migrateRetiredModelKeys, addModelDefaults,
// moveImplementorHardTask and resetOverpassDefaults in packages/schemas; this wraps them in two steps so a caller can defer the write:
//   prepareConfigMigration  reads, parses and plans; writes nothing.
//   commitConfigMigration   replaces the file only if its bytes are still the ones
//                           the plan was made from (the compare-and-swap config_set
//                           in packages/mcp-server uses, mirrored here because a
//                           bundled bin cannot import the MCP server), keeping the
//                           file's mode. A concurrent change is refused, never lost.
// A config that does not parse is never touched, and a migrated config that would
// not parse is never written.
// prepareCanonicalConfigMigration (below) is the settings-redesign rewrite into the canonical shape
// (toCanonicalConfig); it commits through the same commitConfigMigration. The output stays the raw document minus the retired
// keys plus the added defaults: parseConfig is a gate only, never serialized (it would materialize defaults).
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPLEMENTOR_HARD_MIGRATION_ID, MODEL_DEFAULTS_MIGRATION_ID, OVERPASS_DEFAULTS_MIGRATION_ID, addModelDefaults, canonicalConfigSchema, migrateRetiredModelKeys, migrateStaleAgyModels, moveImplementorHardTask, parseConfig, resetOverpassDefaults, toCanonicalConfig } from '@sterling/schemas';
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

/** One report line per added default (addModelDefaults). */
export function describeAdded(added) {
  return added.map((a) =>
    a.field === 'entry'
      ? `${CONFIG_MIGRATION_LINE_PREFIX}models.${a.role} added as the shipped default ${show(a.value)}, so the System tab shows the model each OpenCode dispatch of this role runs on; change it there`
      : `${CONFIG_MIGRATION_LINE_PREFIX}models.${a.role}.${a.field} added as ${show(a.value)} (the model the conductor named on these dispatches before); change it in the System tab, or clear it to run the role on its Claude model${a.field === 'hard_task' ? ' (cleared: no separate hard lane)' : ''}`
  );
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

/** Plan the migration of `<projectDir>/.sterling/config.json` and write nothing.
 *  status: absent (no file), unchanged (no retired key, defaults and the implementor-hard move already applied), ready (a plan to commit) or
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
  const a = migrateStaleAgyModels(m.config);
  const d = addModelDefaults(a.config);
  const h = moveImplementorHardTask(d.config);
  const o = resetOverpassDefaults(h.config);
  if (o.refusal) return refuse(o.refusal);
  if (!m.changed && !a.changed && !d.changed && !h.changed && !o.changed) return { status: 'unchanged', lines: [] };
  const placed = rewritable(projectDir, configPath, refuse);
  if (placed.refused) return placed.refused;
  const { stat } = placed;
  try {
    parseConfig(o.config);
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
    next: JSON.stringify(o.config, null, 2) + (text.endsWith('\n') ? '\n' : ''),
    config: o.config,
    dropped: m.dropped,
    staleAgy: a.dropped,
    added: d.added,
    hardMove: h.move,
    overpassReset: o.changed ? { rolesRemoved: o.rolesRemoved, bypassSet: o.bypassSet } : null,
    lines: [
      ...describeMigration(m.dropped),
      ...describeStaleAgy(a.dropped),
      ...describeAdded(d.added),
      ...(d.changed && !d.added.length ? [`${CONFIG_MIGRATION_LINE_PREFIX}model defaults already set; recorded ${MODEL_DEFAULTS_MIGRATION_ID} in applied_config_migrations so they are never added again`] : []),
      ...describeHardMove(h.move),
      ...(h.changed && !h.move ? [`${CONFIG_MIGRATION_LINE_PREFIX}models.implementor has no hard_task to move; recorded ${IMPLEMENTOR_HARD_MIGRATION_ID} in applied_config_migrations`] : []),
      ...describeOverpassReset(o),
    ],
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

// ── The canonical migration (decision settings-redesign-build-shape-one-legacy-to-canonical-config) ──
// Rewrites a legacy config into the canonical shape (toCanonicalConfig in packages/schemas) through the
// same compare-and-swap commit. Unlike prepareConfigMigration it does NOT validate the file against the
// legacy schema first: the transform is the tolerant reader, and a value it cannot carry is a refusal.
// The legacy one-time steps above run first, once per file, so a file that missed them gets them as a
// sync would have given them; a file that records CANONICAL_CONFIG_MIGRATION_ID skips them (they
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
  let legacy = raw;
  const legacyLines = [];
  if (!applied.includes(CANONICAL_CONFIG_MIGRATION_ID) && !isCanonicalAlready(raw)) {
    const m = migrateRetiredModelKeys(legacy);
    const a = migrateStaleAgyModels(m.config);
    const d = addModelDefaults(a.config);
    const h = moveImplementorHardTask(d.config);
    const o = resetOverpassDefaults(h.config);
    if (o.refusal) return refuse(o.refusal);
    legacy = o.config;
    legacyLines.push(...describeMigration(m.dropped), ...describeStaleAgy(a.dropped), ...describeAdded(d.added), ...describeHardMove(h.move), ...describeOverpassReset(o));
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

/** prepare and commit in one go (sync-agents). */
export function migrateProjectConfig(projectDir, opts) {
  return commitConfigMigration(prepareConfigMigration(projectDir), opts);
}
