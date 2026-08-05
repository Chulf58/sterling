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
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_LAUNCHER_NAME = 'sterling-update.bat';

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
  const template = readFileSync(join(pluginRoot, 'templates', 'update-win.bat'), 'utf8');
  // `wsl.exe --cd` accepts an absolute Windows path OR an absolute Linux path.
  // A drvfs clone (/mnt/<d>/...) bakes its Windows form; an ext4 clone has NO
  // Windows form (backslashifying yields a path valid nowhere — the window
  // would flash-and-close), so its POSIX path passes through unchanged.
  const posix = pluginRoot.replace(/\\/g, '/');
  const cdPath = /^\/mnt\/[a-z](\/|$)/.test(posix) || !posix.startsWith('/') ? toWindowsPath(posix) : posix;
  return crlf(template.replaceAll('{{WIN_PLUGIN_DIR}}', cdPath));
}

/**
 * Ensure semantics (§12): created / matches / differs / skipped — never
 * overwrites content it cannot prove it generated. Also ensures the target's
 * .gitignore carries the entry (per-entry append, non-destructive): the
 * fan-out reaches projects whose init predates this launcher, and a generated
 * machine artifact must never surface as untracked noise in a sibling repo.
 */
export function ensureUpdateLauncher(target, pluginRoot) {
  if (!existsSync(target)) {
    return { status: 'skipped', detail: `target missing: ${target}` };
  }
  if (!existsSync(join(pluginRoot, 'templates', 'update-win.bat'))) {
    return { status: 'skipped', detail: 'templates/update-win.bat missing in the clone' };
  }
  const expected = renderUpdateLauncher(pluginRoot);
  const launcherPath = join(target, UPDATE_LAUNCHER_NAME);

  let result;
  if (!existsSync(launcherPath)) {
    writeFileSync(launcherPath, expected);
    result = { status: 'created', detail: 'double-click -> update the Sterling clone (no session in the loop)' };
  } else if (normalize(readFileSync(launcherPath, 'utf8')) === normalize(expected)) {
    result = { status: 'matches', detail: 'unchanged' };
  } else {
    result = { status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' };
  }

  const gitignorePath = join(target, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(UPDATE_LAUNCHER_NAME)) {
    appendFileSync(gitignorePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${UPDATE_LAUNCHER_NAME}\n`);
  }
  return result;
}
