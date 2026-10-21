// /sterling:pane: reopen the tmux side-pane dashboard (decision
// reopen-the-sterling-side-pane-on-opencode-with-sterling-pane). The decision
// is a pure function over its inputs so it runs without OpenCode: the caller
// passes the environment, a file-existence check and an exec, and shows the
// returned toast.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';
export interface PaneToast {
  title: string;
  message: string;
  variant: ToastVariant;
}
/** What execFile gives back; a failed run rejects with stdout and stderr on the error. */
export interface ExecResult {
  stdout: string;
  stderr: string;
}
export type ExecFn = (file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;
export interface PaneDeps {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  exec: ExecFn;
}

export const PANE_TITLE = 'Sterling side pane';
const EXEC_TIMEOUT_MS = 15_000;

/** True when `dir` is `root` or lies under it, compared by path segment. */
function isWithin(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The directory whose launcher to run: the OpenCode window's own project
 *  (`dir`, api.location.directory). The root above the store is a second
 *  choice only when the window sits at or under it (a window opened in a
 *  subdirectory); a foreign STERLING_STORE must not send the command to another
 *  project's launcher. Otherwise `dir` is returned, so the missing-script
 *  warning names the window's project. */
export function launcherRoot(dir: string, storePath: string | undefined, exists: (path: string) => boolean): string {
  if (exists(join(dir, 'sterling-launch.sh'))) return dir;
  const storeRoot = storePath && basename(dirname(storePath)) === '.sterling' ? dirname(dirname(storePath)) : undefined;
  return storeRoot && isWithin(dir, storeRoot) && exists(join(storeRoot, 'sterling-launch.sh')) ? storeRoot : dir;
}

/** Runs `bash <root>/sterling-launch.sh tui` (argument array, no shell) and says what to show. */
export async function reopenPane(root: string, deps: PaneDeps): Promise<PaneToast> {
  if (!deps.env.TMUX) {
    return { title: PANE_TITLE, variant: 'warning', message: 'Not inside tmux; start OpenCode with the Sterling launcher to get a side pane.' };
  }
  const script = join(root, 'sterling-launch.sh');
  if (!deps.exists(script)) {
    return { title: PANE_TITLE, variant: 'warning', message: `No sterling-launch.sh in ${root}; run /sterling:init.` };
  }
  try {
    const { stdout, stderr } = await deps.exec('bash', [script, 'tui'], { cwd: root, timeout: EXEC_TIMEOUT_MS });
    // the launcher warns on stderr and still exits 0 (take_tui, when the old TUI could not be stopped)
    if (stderr.trim()) return { title: PANE_TITLE, variant: 'warning', message: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
    return { title: PANE_TITLE, variant: 'success', message: stdout.trim() || 'Side pane opened.' };
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    const text = [e.stderr, e.stdout].map((s) => (typeof s === 'string' ? s.trim() : '')).find(Boolean);
    return { title: PANE_TITLE, variant: 'error', message: text ?? e.message ?? String(err) };
  }
}

/** The real dependencies: process.env, the filesystem and child_process.execFile. */
export const realPaneDeps: PaneDeps = {
  env: process.env,
  exists: existsSync,
  exec: (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    }),
};
