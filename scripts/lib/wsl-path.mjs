// WSL/Windows path translation for conductor-invoked [S] scripts.
//
// The inverse of init's toWindowsPath (/mnt/<d>/X -> <D>:\X). A backup_path
// stored in Windows drive-letter form (C:\... or C:/...) is treated as a
// RELATIVE path by node:path.resolve under WSL/Linux (no leading '/'), so
// resolve(cwd, 'C:/...') lands snapshots in a junk 'C:/...' directory INSIDE
// the project instead of the real backup location (bug surfaced disposing run
// r-dd88; the config was recorded under native Windows pre-WSL-migration).
//
// Policy (decision: WSL-directional): translate Windows drive paths -> /mnt
// form ONLY when NOT on native Windows (i.e. under WSL/Linux, where dispose-run
// realistically runs). On native Windows a drive path is already correct and is
// left untouched. The reverse (/mnt -> drive under native Windows node) is a
// deliberately-unhandled known limitation — pipeline disposal is a WSL-primary
// flow and no native-Windows disposal flow is observed.

/**
 * Translate a Windows drive-letter path to its WSL /mnt form. Pure string
 * transform: 'C:\\Users\\cuj\\x' or 'C:/Users/cuj/x' -> '/mnt/c/Users/cuj/x'.
 * Anything that is not a drive path (already-POSIX, relative, non-string) is
 * returned unchanged.
 */
export function toWslPath(p) {
  if (typeof p !== 'string') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p; // already POSIX, relative, or not a drive path
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * Resolve a stored/declared backup_path for the CURRENT runtime: under WSL/Linux
 * a Windows drive path is rewritten to /mnt form so resolve() treats it as
 * absolute; on native Windows it is left as-is (a drive path is the correct
 * native form). The one place the WSL-directional policy lives, shared by
 * init.mjs (recording) and dispose-run.mjs (consumption).
 */
export function backupPathForRuntime(p) {
  return process.platform === 'win32' ? p : toWslPath(p);
}
