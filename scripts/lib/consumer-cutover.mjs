// Consumer cutover [S6] (decision s6-consumer-cutover-init-on-installed-copy-fixes-
// launchers): what /sterling:init, run from an INSTALLED plugin copy, needs to move a
// consumer project off its old clone. init owns the writes; this module only reads and
// renders text:
//   - cloneLauncherTarget: is a sterling-launch.sh a clone launcher (one that starts
//     claude with --plugin-dir, which overrides the installed plugin — finding 9bce09a9)?
//   - marketplaceAutoUpdate / autoUpdateWarning: is "autoUpdate": true set on
//     extraKnownMarketplaces.sterling in the user-level settings.json? Never written.
//   - cloneCleanupLines: the manual step naming each old clone. Nothing deletes a clone.
// The sterling-update.bat recogniser lives beside its renderer in update-launcher.mjs.
//
// Builtins only, like the other scripts/lib launcher helpers.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fwd = (p) => p.replace(/\\/g, '/');

/**
 * The marker is a NON-COMMENT line containing `--plugin-dir`: every launcher an
 * authoring-shape render produced has `"$CLAUDE_BIN" --plugin-dir "$PLUGIN_DIR"`, and
 * the installed shape has none (scripts/lib/launcher-tmux.mjs). The clone path is the
 * generated `PLUGIN_DIR="<path>"` assignment, else a literal `--plugin-dir <path>`;
 * a variable that no PLUGIN_DIR line resolves leaves it null (still a clone launcher).
 * @returns {{clonePath: string|null} | null} null when the text is not a clone launcher
 */
export function cloneLauncherTarget(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const flagLine = lines.find((l) => !/^\s*#/.test(l) && /(^|\s)--plugin-dir(\s|=|$)/.test(l));
  if (!flagLine) return null;
  const assigned = lines.map((l) => /^\s*PLUGIN_DIR="([^"$]+)"\s*$/.exec(l)).find(Boolean);
  if (assigned) return { clonePath: fwd(assigned[1]) };
  const literal = /--plugin-dir[ =](?:"([^"$]+)"|([^\s"'$][^\s"']*))/.exec(flagLine);
  return { clonePath: literal ? fwd(literal[1] ?? literal[2]) : null };
}

/** <CLAUDE_CONFIG_DIR or <home>/.claude>/settings.json — the same root as pluginCacheDir. */
export function userSettingsPath({ env = process.env, home = homedir() } = {}) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
}

/**
 * Reads the user-level settings.json and reports whether
 * extraKnownMarketplaces.sterling.autoUpdate is true. Only reads; a missing file is
 * `missing`, an unreadable or unparseable one is `unreadable` (never guessed at).
 * @returns {{path: string, enabled: boolean, entry?: object, missing?: true, unreadable?: string}}
 */
export function marketplaceAutoUpdate({ env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  const path = userSettingsPath({ env, home });
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { path, enabled: false, missing: true };
    return { path, enabled: false, unreadable: err?.code ?? err?.message ?? String(err) };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    return { path, enabled: false, unreadable: `not valid JSON (${err?.message ?? err})` };
  }
  const entry = settings?.extraKnownMarketplaces?.sterling;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { path, enabled: false };
  return { path, enabled: entry.autoUpdate === true, entry };
}

const TOGGLE_NOTE = 'Turning it on in /plugin -> Marketplaces also works, but a settings file wins over the toggle.';

/** The ONE loud line init prints when auto-update is not on, or null when it is. */
export function autoUpdateWarning(check) {
  if (check.enabled) return null;
  const where = fwd(check.path);
  const head = 'plugin auto-update: the sterling marketplace does not update itself';
  if (check.missing) {
    return `${head} — ${where} does not exist, so auto-update could not be checked. To turn it on, add "autoUpdate": true to extraKnownMarketplaces.sterling there. ${TOGGLE_NOTE}`;
  }
  if (check.unreadable) {
    return `${head} — ${where} could not be read: ${check.unreadable}. To turn it on, add "autoUpdate": true to extraKnownMarketplaces.sterling there. ${TOGGLE_NOTE}`;
  }
  if (!check.entry) {
    return `${head} — ${where} has no extraKnownMarketplaces.sterling entry. Add "autoUpdate": true to that entry. ${TOGGLE_NOTE}`;
  }
  const fixed = JSON.stringify({ sterling: { ...check.entry, autoUpdate: true } });
  return `${head} — extraKnownMarketplaces.sterling in ${where} has no "autoUpdate": true. Replace that entry with: "extraKnownMarketplaces": ${fixed} (init never writes this file). ${TOGGLE_NOTE}`;
}

// A Sterling clone: git metadata plus Sterling's own plugin manifest.
function isSterlingCloneDir(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    return JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))?.name === 'sterling';
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return false;
    throw err;
  }
}

// The clone's own machine_role (H1's MACHINE ROLE line): an authoring clone is never
// offered for deletion. Unreadable or absent config is "not declared authoring".
function declaresAuthoring(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'))?.machine_role === 'authoring';
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return false;
    throw err;
  }
}

/** The manual clone-deletion step, one line per distinct named path; [] when none. */
export function cloneCleanupLines(paths) {
  const unique = [...new Set(paths.filter(Boolean).map(fwd))];
  if (unique.length === 0) return [];
  const lines = ['old Sterling clone — this project used to run Sterling from a clone. Init never deletes a clone:'];
  for (const p of unique) {
    if (!isSterlingCloneDir(p)) {
      lines.push(`  ${p} — not a Sterling clone on this machine (already removed or moved); nothing to delete`);
    } else if (declaresAuthoring(p)) {
      lines.push(`  ${p} — this machine's authoring clone (machine_role authoring in its .sterling/config.json); keep it`);
    } else {
      lines.push(`  ${p} — delete it by hand once no project on this machine launches from it (rm -rf "${p}")`);
    }
  }
  return lines;
}
