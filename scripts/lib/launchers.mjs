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
// The engine is written when Claude Code or OpenCode is installed, and an opener pair
// only for a tool that is (user-ruled 2026-10-08, "Yes, per tool found").
//
// sterling.bat, tui.bat and sterling-windows.bat are no longer generated: re-opening an
// opener re-attaches and re-adds a closed TUI pane, and `./sterling-launch.sh tui` does
// the rest. A copy that is still a pristine render of one of their templates (the
// current one, or an earlier version from launcher-history) is deleted; a copy that is
// not is left in place and reported. init and /sterling:update both do this.
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
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { stampBody, verifyStamp } from './generated-marker.mjs';
import { isInstalledCopy } from './installed-copy.mjs';
import { renderTmuxLauncher } from './launcher-tmux.mjs';
import { historicalLauncherTemplates, matchTemplateRender, olderGeneratedLauncher, replayFailureLine } from './launcher-history.mjs';

export const ENGINE_NAME = 'sterling-launch.sh';
export const OPENER_TEMPLATES = { windows: 'opener-win.bat', linux: 'opener-linux.sh' };
export const OPENERS = {
  windows: [
    { file: 'claude-code.bat', mode: 'claude', tool: 'claude', app: 'Claude Code' },
    { file: 'opencode.bat', mode: 'opencode', tool: 'opencode', app: 'OpenCode' },
  ],
  linux: [
    { file: 'claude-code.sh', mode: 'claude', tool: 'claude', app: 'Claude Code' },
    { file: 'opencode.sh', mode: 'opencode', tool: 'opencode', app: 'OpenCode' },
  ],
};
/** Launchers init wrote before and writes no more: the template each was rendered from,
 *  and why it is gone. A pristine render is deleted; anything else is kept and reported. */
export const RETIRED_LAUNCHERS = {
  'sterling.bat': { template: 'launcher-win.bat', why: 'no longer generated (decision launchers-consolidated-to-claude-code-and-opencode-pair); claude-code.bat and opencode.bat replace it' },
  'tui.bat': { template: 'tui-win.bat', why: 'no longer generated (decision launchers-consolidated-to-claude-code-and-opencode-pair); re-opening claude-code.bat or opencode.bat re-adds a closed TUI pane' },
  'sterling-windows.bat': { template: 'launcher-win-native.bat', why: 'retired (decision native-windows-launcher-retired-wsl2-only); Sterling runs under WSL2 via claude-code.bat and opencode.bat' },
};
/** Every launcher name a project's .gitignore carries, retired ones included (a stale copy stays ignored). */
export const LAUNCHER_GITIGNORE_ENTRIES = [
  'sterling.bat', 'sterling-windows.bat', 'tui.bat', ENGINE_NAME,
  ...OPENERS.windows.map((o) => o.file), ...OPENERS.linux.map((o) => o.file),
];
/** Test seam and manual override for launcherHost: 'windows' or 'linux'. */
export const LAUNCHER_HOST_ENV = 'STERLING_LAUNCHER_HOST';
/** Test seam and manual override for the OpenCode lookup: 'found' or 'absent'. */
export const LAUNCHER_OPENCODE_ENV = 'STERLING_LAUNCHER_OPENCODE';

const lf = (s) => s.replace(/\r\n/g, '\n');
// A generated bash launcher must be executable: the .bat openers run ./sterling-launch.sh,
// which a project on the WSL filesystem (ext4) refuses without the bit (GitHub issue #52),
// and a Linux opener is double-clicked. The mode given to writeFileSync applies only to a
// new file, so a file written earlier without the bit gets it here. A hand-edited file
// (status differs) is left as it is. A mount that refuses chmod (drvfs without the metadata
// option) is a warning, not an abort: the file is written and the user is told what to run.
export const ensureExecutable = (path, warns) => {
  try {
    if ((statSync(path).mode & 0o755) !== 0o755) chmodSync(path, statSync(path).mode | 0o755);
  } catch (err) {
    warns.push(`\n⚠ ${path} could not be made executable (${err.code ?? err.message}); run: chmod +x ${path}`);
  }
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

const executableFile = (path) => {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  }
};
/** `command -v <name>` over env.PATH, without a shell. */
export const onPath = (name, env = process.env) =>
  (env.PATH ?? '').split(delimiter).some((dir) => dir && executableFile(join(dir, name)));

/**
 * Which tools get an opener, found the way the engine finds them at run time: claude on
 * PATH; opencode on PATH or at ~/.opencode/bin/opencode. `claude` overrides the claude
 * lookup (init passes its own Claude Code probe). STERLING_LAUNCHER_OPENCODE ('found' or
 * 'absent') overrides the opencode lookup; any other value throws.
 */
export function launcherTools({ env = process.env, home = homedir(), claude } = {}) {
  const forced = env[LAUNCHER_OPENCODE_ENV];
  if (forced && forced !== 'found' && forced !== 'absent') {
    throw new Error(`${LAUNCHER_OPENCODE_ENV} must be 'found' or 'absent' (got '${forced}')`);
  }
  return {
    claude: claude ?? onPath('claude', env),
    opencode: forced ? forced === 'found' : onPath('opencode', env) || executableFile(join(home, '.opencode', 'bin', 'opencode')),
  };
}

/**
 * The launcher template history, read once and only when first needed (a git walk and
 * one child node on a clone). `warns` collects the replay-failure line.
 */
export function launcherHistoryLoader(pluginRoot) {
  let history = null;
  const warns = [];
  return {
    warns,
    get() {
      if (!history) {
        history = historicalLauncherTemplates({ repoRoot: pluginRoot });
        if (history.replayFailures.length) {
          warns.push(`\n⚠ ${replayFailureLine(history.replayFailures, 'a launcher rendered by one of them is left untouched as if hand-edited. Fix or report the renderer commit named above.')}`);
        }
      }
      return history;
    },
  };
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
 * @param {{claude: boolean, opencode: boolean}} [o.tools] from launcherTools(): an opener only for a tool found
 * @param {ReturnType<typeof launcherHistoryLoader>} [o.history] share one history read with removeRetiredLaunchers
 * @param {boolean} [o.installedCopy]
 * @param {(label: string, text: string) => string} [o.checkText] throws on a bad render (init's dead-term check)
 * @param {(text: string) => {clonePath: string|null}|null} [o.cloneLauncherTarget] S6: is an engine a clone launcher
 * @returns {{items: {item: string, status: string, detail: string}[], warns: string[], oldClonePaths: string[]}}
 */
export function ensureLaunchers(target, pluginRoot, {
  splitPercent,
  host,
  tools = { claude: true, opencode: true },
  history = launcherHistoryLoader(pluginRoot),
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
  const olderGenerated = (text) => olderGeneratedLauncher(text, 'launcher-tmux.sh', history.get());
  const leftUntouched = (file) => {
    if (history.get().degraded) {
      warns.push(`\n⚠ ${file} differs from the current render and could not be checked against earlier versions (no template history: ${history.get().degraded}), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
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
  if (items.at(-1).status !== 'differs') ensureExecutable(enginePath, warns);

  // (2) this host's two openers, stamped with the generated-marker hash
  const prefix = host === 'windows' ? 'rem' : '#';
  for (const opener of OPENERS[host].filter((o) => tools[o.tool])) {
    const text = checkText(opener.file, renderOpener(pluginRoot, target, host, opener));
    const path = join(target, opener.file);
    const created = host === 'windows'
      ? `double-click -> wsl ${wslCdPath(target)} -> ./${ENGINE_NAME} ${opener.mode}`
      : `run or double-click -> ./${ENGINE_NAME} ${opener.mode} in a terminal`;
    if (!existsSync(path)) {
      writeFileSync(path, text, host === 'linux' ? { mode: 0o755 } : undefined);
      if (host === 'linux') ensureExecutable(path, warns);
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
    if (host === 'linux') ensureExecutable(path, warns);
  }
  warns.unshift(...history.warns.splice(0));
  return { items, warns, oldClonePaths };
}

/**
 * Delete each retired launcher in `target` that is still a pristine render of its template:
 * the current text, or an earlier version from launcher-history, with any placeholder
 * values (the refresh rule init applies to the engine). A launcher an earlier init
 * stamped (generated-marker) counts only while its stamp still verifies, and is matched
 * without its stamp line. Anything else is kept and reported as `differs`.
 * @returns {{items: {item: string, status: string, detail: string}[], warns: string[]}}
 */
export function removeRetiredLaunchers(target, pluginRoot, { history = launcherHistoryLoader(pluginRoot) } = {}) {
  const items = [];
  const warns = [];
  for (const [file, { template, why }] of Object.entries(RETIRED_LAUNCHERS)) {
    const path = join(target, file);
    if (!existsSync(path)) continue;
    let body = lf(readFileSync(path, 'utf8'));
    const stamp = verifyStamp(body, 'rem');
    if (stamp?.unmodified) {
      const lines = body.split('\n');
      body = [lines[0], ...lines.slice(2)].join('\n');
    }
    const known = history.get();
    const currentPath = join(pluginRoot, 'templates', template);
    const generated = stamp?.unmodified !== false && (
      (existsSync(currentPath) && matchTemplateRender(body, readFileSync(currentPath, 'utf8'), { installedBlocks: known.installedBlocks }) !== null)
      || olderGeneratedLauncher(body, template, known) !== null);
    if (generated) {
      unlinkSync(path);
      items.push({ item: file, status: 'removed', detail: `deleted — an unedited generated copy; ${why}` });
      continue;
    }
    const unchecked = known.degraded && stamp === null ? ` It could not be checked against earlier versions (no template history: ${known.degraded}).` : '';
    warns.push(`\n⚠ ${file} is ${why.replace(/ \(decision [^)]*\)/, '')}, but it was edited or not generated by Sterling, so it was kept.${unchecked} Delete it yourself when you no longer want it.`);
    items.push({ item: file, status: 'differs', detail: `kept — ${why}; it matches no generated version (edited, or not generated by Sterling): delete it yourself when you no longer want it` });
  }
  warns.unshift(...history.warns.splice(0));
  return { items, warns };
}

/** Append the launcher names missing from `target`/.gitignore (per entry, never rewriting a
 *  line) and return them. init has its own .gitignore pass; /sterling:update uses this so a
 *  project init'd before the openers existed does not show them as untracked. */
export function ensureLauncherIgnores(target) {
  const path = join(target, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const missing = LAUNCHER_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length) appendFileSync(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  return missing;
}
