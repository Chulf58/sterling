// sterling-update.bat ensure [S] — the per-project double-click updater entry.
//
// Shared by TWO producers: init's launcher manifest (item 5) and runUpdate's
// per-project fan-out. The fan-out matters because the updater is how a machine
// RECEIVES new artifacts: a project init'd before this launcher existed would
// otherwise never get one until someone remembered to re-run /sterling:init
// there (P4 — bind the delivery to the update event, not to memory).
//
// BOOTSTRAP INDEPENDENCE: imported by scripts/lib/update.mjs at load time, so
// this file must import node builtins ONLY — it has to load on a clone where
// nothing is built (see the consumer-update-path article).
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stampBody, verifyStamp } from './generated-marker.mjs';
import { isInstalledCopy } from './installed-copy.mjs';

export const UPDATE_LAUNCHER_NAME = 'sterling-update.bat';

// ONE TEMPLATE: wsl.exe + bash scripts/update-console.sh. The native-Windows
// arm (templates/update-win-native.bat, rendered on a win32 host) is RETIRED
// (decision gap-hunt-2026-09-28-rulings item 11b, extending
// native-windows-launcher-retired-wsl2-only): Sterling runs under WSL2 on every
// machine, so no host renders it. A launcher a win32 host generated earlier is
// refreshed to the WSL body by the ordinary marker rule below when it is
// unmodified, and reported as 'differs' when it was hand-edited.
export const UPDATE_TEMPLATE_WSL = 'update-win.bat';

// /mnt/c/Users/cuj/X -> C:\Users\cuj\X (WSL drvfs); else just backslash-ize.
// Mirrors init's toWindowsPath — duplicated (5 lines) rather than imported:
// init pulls in workspace packages at load time, which this file must not.
const toWindowsPath = (p) => {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
};
const crlf = (s) => s.replace(/\r?\n/g, '\r\n'); // cmd.exe misparses LF-only batch files
const normalize = (s) => s.replace(/\r\n/g, '\n');

export function renderUpdateLauncher(pluginRoot) {
  const template = readFileSync(join(pluginRoot, 'templates', UPDATE_TEMPLATE_WSL), 'utf8');
  // `wsl.exe --cd` accepts an absolute Windows path OR an absolute Linux path.
  // A drvfs clone (/mnt/<d>/...) bakes its Windows form; an ext4 clone has NO
  // Windows form (backslashifying yields a path valid nowhere — the window
  // would flash-and-close), so its POSIX path passes through unchanged.
  const posix = pluginRoot.replace(/\\/g, '/');
  const cdPath = /^\/mnt\/[a-z](\/|$)/.test(posix) || !posix.startsWith('/') ? toWindowsPath(posix) : posix;
  const body = template.replaceAll('{{WIN_PLUGIN_DIR}}', cdPath);
  return crlf(stampBody(body, 'rem'));
}

// The one command line every WSL-chain render has carried (templates/update-win.bat,
// unchanged across its history): cd into the clone, run its update console.
const UPDATE_COMMAND = /^"%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt\.exe" wsl\.exe --cd "([^"]+)" -- bash -lic "bash scripts\/update-console\.sh"$/;
// C:\Users\x -> /mnt/c/Users/x (the inverse of toWindowsPath); an absolute POSIX path
// passes through; anything else is not a path this template ever rendered.
const toWslPath = (p) => {
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}${m[2] ? '/' + m[2].replace(/\\/g, '/').replace(/\/+$/, '') : ''}`;
  return p.startsWith('/') ? p : null;
};

/**
 * S6 (decision s6-consumer-cutover-init-on-installed-copy-fixes-launchers): the clone a
 * sterling-update.bat updates, or null. Recognised NARROWLY by content: every non-blank
 * line is `@echo off`, a `rem` comment, or the ONE generated command line above, and
 * its --cd target is a drive path or an absolute POSIX path. Anything else (an extra
 * command, the retired native-Windows body, a hand-written updater) is null.
 */
export function cloneUpdateLauncherTarget(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  let cdTarget = null;
  for (const line of lines) {
    if (line === '@echo off' || /^rem( |$)/.test(line)) continue;
    const m = UPDATE_COMMAND.exec(line);
    if (!m || cdTarget !== null) return null;
    cdTarget = m[1];
  }
  return cdTarget === null ? null : toWslPath(cdTarget);
}

/**
 * Ensure semantics (§12): created / matches / refreshed / differs / skipped —
 * never overwrites content it cannot prove it generated. Also ensures the
 * target's .gitignore carries the entry (per-entry append, non-destructive):
 * the fan-out reaches projects whose init predates this launcher, and a
 * generated machine artifact must never surface as untracked noise in a
 * sibling repo.
 *
 * REFRESH (board bb3aa162): a mismatch against the freshly rendered expected
 * no longer means "leave it, might be hand-edited" — the on-disk file's own
 * embedded content-hash marker (generated-marker.mjs) proves whether it was
 * touched since ITS generation. Unmodified-but-stale (a clone move, a
 * template edit) refreshes freely; a marker mismatch (or no marker at all —
 * a legacy or foreign file) still leaves it untouched as 'differs'.
 */
export function ensureUpdateLauncher(target, pluginRoot) {
  if (!existsSync(target)) {
    return { status: 'skipped', detail: `target missing: ${target}` };
  }
  // An INSTALLED plugin copy has no clone to update: the plugin manager delivers new
  // versions (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-
  // its-clone, ruling point 3), and the launcher's `cd` into a versioned cache
  // directory would break at the next update. Nothing is written, not even the
  // .gitignore entry. S6 (decision s6-consumer-cutover-init-on-installed-copy-fixes-
  // launchers): an updater that an earlier clone-run init wrote only leads into a clone
  // that is going away, so the generated shape is deleted and its clone returned for
  // init's manual clone-deletion step; any other content is left alone with a notice.
  if (isInstalledCopy(pluginRoot)) {
    const launcherPath = join(target, UPDATE_LAUNCHER_NAME);
    if (!existsSync(launcherPath)) {
      return { status: 'skipped', detail: 'installed plugin copy — updates come from the plugin manager, there is no clone to update' };
    }
    const clonePath = cloneUpdateLauncherTarget(readFileSync(launcherPath, 'utf8'));
    if (clonePath === null) {
      return { status: 'differs', detail: 'left untouched — not the generated clone-updater shape; on an installed plugin copy /sterling:update refuses and updates come from the plugin manager, so delete it yourself if it only updated a Sterling clone' };
    }
    unlinkSync(launcherPath);
    return { status: 'removed', detail: `deleted — it ran /sterling:update in the clone ${clonePath}; on an installed plugin copy updates come from the plugin manager`, clonePath };
  }
  // A clone missing the template skips loudly instead of throwing.
  if (!existsSync(join(pluginRoot, 'templates', UPDATE_TEMPLATE_WSL))) {
    return { status: 'skipped', detail: `templates/${UPDATE_TEMPLATE_WSL} missing in the clone` };
  }
  const expected = renderUpdateLauncher(pluginRoot);
  const launcherPath = join(target, UPDATE_LAUNCHER_NAME);

  let result;
  if (!existsSync(launcherPath)) {
    writeFileSync(launcherPath, expected);
    result = { status: 'created', detail: 'double-click -> update the Sterling clone (no session in the loop)' };
  } else {
    const diskNorm = normalize(readFileSync(launcherPath, 'utf8'));
    if (diskNorm === normalize(expected)) {
      result = { status: 'matches', detail: 'unchanged' };
    } else {
      const stamp = verifyStamp(diskNorm, 'rem');
      if (stamp && stamp.unmodified) {
        writeFileSync(launcherPath, expected);
        result = { status: 'refreshed', detail: 'regenerated: unmodified since last generation, but this machine now renders it differently (clone moved or template changed)' };
      } else {
        result = { status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' };
      }
    }
  }

  const gitignorePath = join(target, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(UPDATE_LAUNCHER_NAME)) {
    appendFileSync(gitignorePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${UPDATE_LAUNCHER_NAME}\n`);
  }
  return result;
}
