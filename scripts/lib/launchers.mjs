// Project launchers (§11, decision launchers-consolidated-to-claude-code-and-opencode-
// pair): one engine, sterling-launch.sh claude|opencode|tui (templates/launcher-tmux.sh),
// and two thin openers per platform that call it:
//
//   windows (WSL2, or node on native Windows): claude-code.bat, opencode.bat
//     (templates/opener-win.bat: Windows Terminal -> wsl.exe --cd <project> -> the engine)
//   linux (a native Linux desktop):             claude-code.sh, opencode.sh
//     (templates/opener-linux.sh: runs the engine in place from a terminal, else opens a
//     terminal window it finds at launch; nothing about the terminal is written at init,
//     decision bb5e25cd)
//
// sterling.bat and tui.bat are no longer generated: re-opening an opener re-attaches and
// re-adds a closed TUI pane, and `./sterling-launch.sh tui` does the rest. A copy an
// earlier init wrote is reported as stale and left on disk, like sterling-windows.bat.
//
// REFRESH: the engine keeps the template-history rule (scripts/lib/launcher-history.mjs):
// a pristine render of an earlier template version is rewritten, anything else is left
// alone. The openers carry the generated-marker stamp (scripts/lib/generated-marker.mjs):
// an unmodified stamped file is rewritten, a touched one is left alone.
//
// BOOTSTRAP INDEPENDENCE: builtins and builtins-only modules at load time, like
// update-launcher.mjs, so /sterling:update can load this on a clone where nothing is
// built. What needs a workspace package (init's dead-term check, the S6 clone-launcher
// recogniser) is passed in by the caller.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { stampBody, verifyStamp } from './generated-marker.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { renderTmuxLauncher } from './launcher-tmux.mjs';
import { historicalLauncherTemplates, olderGeneratedLauncher, replayFailureLine } from './launcher-history.mjs';

export const ENGINE_NAME = 'sterling-launch.sh';
export const OPENER_TEMPLATES = { windows: 'opener-win.bat', linux: 'opener-linux.sh' };
export const OPENERS = {
  windows: [
    { file: 'claude-code.bat', mode: 'claude', app: 'Claude Code' },
    { file: 'opencode.bat', mode: 'opencode', app: 'OpenCode' },
  ],
  linux: [
    { file: 'claude-code.sh', mode: 'claude', app: 'Claude Code' },
    { file: 'opencode.sh', mode: 'opencode', app: 'OpenCode' },
  ],
};
/** Launchers init wrote before and writes no more; reported, never deleted here. */
export const RETIRED_LAUNCHERS = {
  'sterling.bat': 'init no longer generates it (decision launchers-consolidated-to-claude-code-and-opencode-pair); claude-code.bat and opencode.bat replace it',
  'tui.bat': 'init no longer generates it (decision launchers-consolidated-to-claude-code-and-opencode-pair); re-opening claude-code.bat or opencode.bat re-adds a closed TUI pane',
  'sterling-windows.bat': 'retired (decision native-windows-launcher-retired-wsl2-only) — init no longer generates or maintains it; Sterling runs under WSL2 via claude-code.bat and opencode.bat',
};
/** Every launcher name a project's .gitignore carries, retired ones included (a stale copy stays ignored). */
export const LAUNCHER_GITIGNORE_ENTRIES = [
  'sterling.bat', 'sterling-windows.bat', 'tui.bat', ENGINE_NAME,
  ...OPENERS.windows.map((o) => o.file), ...OPENERS.linux.map((o) => o.file),
];
/** Test seam and manual override for launcherHost: 'windows' or 'linux'. */
export const LAUNCHER_HOST_ENV = 'STERLING_LAUNCHER_HOST';

const lf = (s) => s.replace(/\r\n/g, '\n');
// A generated bash launcher must be executable: the .bat openers run ./sterling-launch.sh,
// which a project on the WSL filesystem (ext4) refuses without the bit (GitHub issue #52),
// and a Linux opener is double-clicked. The mode given to writeFileSync applies only to a
// new file, so a file written earlier without the bit gets it here. A hand-edited file
// (status differs) is left as it is.
const ensureExecutable = (path) => {
  if ((statSync(path).mode & 0o755) !== 0o755) chmodSync(path, statSync(path).mode | 0o755);
};
const crlf = (s) => s.replace(/\r?\n/g, '\r\n'); // cmd.exe misparses LF-only batch files
const fwd = (p) => p.replace(/\\/g, '/');
const readOsRelease = () => {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
};

/**
 * Which openers this machine gets. 'windows' when the user starts from Windows Explorer
 * (node under WSL, whose kernel release names Microsoft, or node on native Windows);
 * 'linux' on any other host. STERLING_LAUNCHER_HOST overrides; any other value throws.
 */
export function launcherHost({ env = process.env, platform = process.platform, osrelease = readOsRelease } = {}) {
  const forced = env[LAUNCHER_HOST_ENV];
  if (forced) {
    if (forced === 'windows' || forced === 'linux') return forced;
    throw new Error(`${LAUNCHER_HOST_ENV} must be 'windows' or 'linux' (got '${forced}')`);
  }
  if (platform === 'win32') return 'windows';
  if (platform === 'linux' && (env.WSL_DISTRO_NAME || /microsoft/i.test(osrelease()))) return 'windows';
  return 'linux';
}

/** /mnt/c/Users/cuj/X -> C:\Users\cuj\X (WSL drvfs); else just backslash-ize. */
export const toWindowsPath = (p) => {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
};

// `wsl.exe --cd` takes a Windows path or an absolute Linux path. A drvfs project
// (/mnt/<d>/...) gets its Windows form; a project on the WSL filesystem has none, so its
// POSIX path is used as is (the same rule as scripts/lib/update-launcher.mjs).
const wslCdPath = (target) => {
  const posix = fwd(target);
  return /^\/mnt\/[a-z](\/|$)/.test(posix) || !posix.startsWith('/') ? toWindowsPath(posix) : posix;
};

/** tmux session names forbid '.'/':' and choke on spaces: sterling-<sanitized basename>.
 *  The name launchers used before per-checkout names; the engine still attaches to it. */
export const legacySessionName = (target) =>
  `sterling-${basename(target).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}`;

/** The session base name baked into the engine: the readable legacy name plus 4 hex of a
 *  hash of the absolute project path, so two checkouts with the same directory name get
 *  different sessions (GitHub issue #52). The engine adds -claude or -opencode. */
export const sessionName = (target) =>
  `${legacySessionName(target)}-${createHash('sha256').update(fwd(resolve(target))).digest('hex').slice(0, 4)}`;

/** The stamped opener text for `opener` (one of OPENERS[host]) in `target`. */
export function renderOpener(pluginRoot, target, host, opener) {
  const template = readFileSync(join(pluginRoot, 'templates', OPENER_TEMPLATES[host]), 'utf8');
  const body = lf(template)
    .replaceAll('{{APP}}', () => opener.app)
    .replaceAll('{{MODE}}', () => opener.mode)
    .replaceAll('{{WIN_PROJECT_DIR}}', () => wslCdPath(target));
  return host === 'windows' ? crlf(stampBody(body, 'rem')) : stampBody(body, '#');
}

/**
 * Ensure the engine and this host's openers in `target` (§12 ensure semantics: created,
 * matches, refreshed, replaced or differs; never overwrites what it cannot prove it
 * generated).
 * @param {string} target project root
 * @param {string} pluginRoot
 * @param {object} o
 * @param {number} o.splitPercent TUI pane width
 * @param {'windows'|'linux'} o.host from launcherHost()
 * @param {boolean} [o.installedCopy]
 * @param {(label: string, text: string) => string} [o.checkText] throws on a bad render (init's dead-term check)
 * @param {(text: string) => {clonePath: string|null}|null} [o.cloneLauncherTarget] S6: is an engine a clone launcher
 * @returns {{items: {item: string, status: string, detail: string}[], warns: string[], oldClonePaths: string[]}}
 */
export function ensureLaunchers(target, pluginRoot, {
  splitPercent,
  host,
  installedCopy = isInstalledCopy(pluginRoot),
  checkText = (_label, text) => text,
  cloneLauncherTarget = () => null,
}) {
  const items = [];
  const warns = [];
  const oldClonePaths = [];
  const session = sessionName(target);
  const legacySession = legacySessionName(target);

  // Older generated engines (decision init-and-update-refresh-an-older-generated-
  // launcher): a pristine render of an EARLIER template version is rewritten and
  // reported `refreshed`; one matching no version is a hand edit, left untouched with a
  // loud line. The versions are read only once the engine differs.
  let history = null;
  const olderGenerated = (text) => {
    if (!history) {
      history = historicalLauncherTemplates({ repoRoot: pluginRoot });
      if (history.replayFailures.length) {
        warns.push(`\n⚠ ${replayFailureLine(history.replayFailures, 'a launcher rendered by one of them is left untouched as if hand-edited. Fix or report the renderer commit named above.')}`);
      }
    }
    return olderGeneratedLauncher(text, 'launcher-tmux.sh', history);
  };
  const leftUntouched = (file) => {
    if (history.degraded) {
      warns.push(`\n⚠ ${file} differs from the current render and could not be checked against earlier versions (no template history: ${history.degraded}), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
      return { item: file, status: 'differs', detail: 'left untouched — could not be checked (no template history); delete it and re-run /sterling:init to regenerate' };
    }
    warns.push(`\n⚠ ${file} differs from the current render and matches no earlier version of its template (hand-edited, or rendered for another path), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
    return { item: file, status: 'differs', detail: 'left untouched (matches no generated version: hand-edited or another path) — delete it and re-run /sterling:init to regenerate' };
  };

  // (1) the engine (an installed plugin copy gets NO --plugin-dir and resolves the TUI at
  // run time; the authoring clone keeps both — see scripts/lib/launcher-tmux.mjs). bash:
  // ALWAYS LF (a CRLF shebang breaks bash), and executable when this run creates it.
  const expected = checkText(ENGINE_NAME, lf(renderTmuxLauncher(pluginRoot, { session, legacySession, splitPercent, installed: installedCopy })));
  const enginePath = join(target, ENGINE_NAME);
  const existing = existsSync(enginePath) ? readFileSync(enginePath, 'utf8') : null;
  const cloneLauncher = installedCopy && existing !== null ? cloneLauncherTarget(existing) : null;
  if (existing === null) {
    writeFileSync(enginePath, expected, { mode: 0o755 });
    items.push({ item: ENGINE_NAME, status: 'created', detail: `tmux sessions ${session}-claude and ${session}-opencode, ${splitPercent}% TUI pane` });
  } else if (lf(existing) === lf(expected)) {
    items.push({ item: ENGINE_NAME, status: 'matches', detail: 'generated content unchanged' });
  } else if (cloneLauncher) {
    writeFileSync(enginePath, expected);
    if (cloneLauncher.clonePath) oldClonePaths.push(cloneLauncher.clonePath);
    const from = cloneLauncher.clonePath ? `the clone ${cloneLauncher.clonePath}` : 'a clone (the old launcher does not record its path)';
    items.push({ item: ENGINE_NAME, status: 'replaced', detail: `the old launcher started claude with --plugin-dir pointing at ${from}, which overrides the installed plugin; regenerated in the installed-copy shape` });
  } else {
    const old = olderGenerated(existing);
    if (old) {
      writeFileSync(enginePath, expected);
      const oldPluginDir = old.PLUGIN_DIR ?? /^PLUGIN_DIR="([^"]+)"/.exec(old.PLUGIN_PATHS ?? '')?.[1];
      const newPluginDir = installedCopy ? 'the installed copy, resolved at run time' : fwd(pluginRoot);
      items.push({
        item: ENGINE_NAME,
        status: 'refreshed',
        detail: 'an earlier generated version of the template; rewritten from the current one' +
          (oldPluginDir && oldPluginDir !== newPluginDir ? ` (it was rendered for ${oldPluginDir}, now ${newPluginDir})` : ''),
      });
    } else {
      items.push(leftUntouched(ENGINE_NAME));
    }
  }
  if (items.at(-1).status !== 'differs') ensureExecutable(enginePath);

  // (2) this host's two openers, stamped with the generated-marker hash
  const prefix = host === 'windows' ? 'rem' : '#';
  for (const opener of OPENERS[host]) {
    const text = checkText(opener.file, renderOpener(pluginRoot, target, host, opener));
    const path = join(target, opener.file);
    const created = host === 'windows'
      ? `double-click -> wsl ${wslCdPath(target)} -> ./${ENGINE_NAME} ${opener.mode}`
      : `run or double-click -> ./${ENGINE_NAME} ${opener.mode} in a terminal`;
    if (!existsSync(path)) {
      writeFileSync(path, text, host === 'linux' ? { mode: 0o755 } : undefined);
      if (host === 'linux') ensureExecutable(path);
      items.push({ item: opener.file, status: 'created', detail: created });
      continue;
    }
    const disk = lf(readFileSync(path, 'utf8'));
    if (disk === lf(text)) {
      items.push({ item: opener.file, status: 'matches', detail: 'unchanged' });
    } else if (verifyStamp(disk, prefix)?.unmodified) {
      writeFileSync(path, text);
      items.push({ item: opener.file, status: 'refreshed', detail: 'regenerated: unmodified since it was generated, but this machine now renders it differently' });
    } else {
      warns.push(`\n⚠ ${opener.file} was changed after it was generated (or was not generated by Sterling), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
      items.push({ item: opener.file, status: 'differs', detail: 'left untouched (edited after generation, or not generated by Sterling) — delete it and re-run /sterling:init to regenerate' });
      continue;
    }
    if (host === 'linux') ensureExecutable(path);
  }
  return { items, warns, oldClonePaths };
}

/** A `stale` row for every retired launcher present in `target`; the files are not touched. */
export function retiredLauncherRows(target) {
  return Object.entries(RETIRED_LAUNCHERS)
    .filter(([file]) => existsSync(join(target, file)))
    .map(([file, why]) => ({ item: file, status: 'stale', detail: `${why}. Left on disk untouched: delete it yourself when you no longer want it` }));
}
