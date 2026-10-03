// The store guard on OpenCode (decision
// opencode-store-guard-uses-the-plugin-permission-evaluate-hook): an evaluate hook
// that denies any shell, edit, write or patch request touching .sterling/sterling.db,
// whatever the running agent's own rules say. OpenCode 2.0.22 calls every plugin's
// evaluate hook after the agent's rule list has reached a verdict, so it holds where
// the config guard in .opencode/opencode.json cannot: a PROJECT agent file's rules
// load after that config, and a plugin's agent transform runs before agent files load
// (both measured live). The config guard stays as a second layer.
// Request shapes, measured live on 2.0.22 with a probe plugin:
//   - shell: resources holds one entry per simple command, with a leading `cd`
//     dropped (`cd .sterling && cat sterling.db` arrives as ['cat sterling.db'];
//     `cat x; rm .sterling/sterling.db` as ['cat x', 'rm .sterling/sterling.db']),
//     so the file name alone decides, as the config guard's *sterling.db* does;
//   - the patch tool arrives as action 'edit' with project-relative paths in
//     resources and metadata.filepath.
// Only store databases are guarded, as H15 guards them on Claude Code: a path with a
// `.sterling` component whose file name is sterling.db, sterling.db-wal, -shm, -journal
// or sterling.db.<anything>, so the project store and the domain stores under
// ~/.sterling/domains/<tag>/ alike. Every other file under .sterling/ stays editable
// (CLAUDE.md, H15). The match ignores case, because the file systems of Windows and
// macOS do. A shell command is matched with its quotes and backslashes removed, as the
// shell removes them (`rm .sterling/sterling''.db`).
// Not guaranteed: a shell command that reaches the store without naming it (a glob
// such as .sterling/*.db, a variable, a symlink); and an evaluate hook registered
// after this one (another plugin) can set the effect back, measured live.
import { posix } from 'node:path';

export const STORE_GUARD_MESSAGE =
  'Sterling store guard: .sterling/sterling.db is written only by the Sterling MCP server. Use the sterling knowledge_* and board_* tools instead. Every other file under .sterling/ can be edited.';
export const STORE_GUARD_UNREADABLE_MESSAGE =
  'Sterling store guard: could not read which files or commands this request touches (the OpenCode permission request has an unknown shape), so it is denied rather than risk the store.';

// OpenCode 2.0.22 sends 'shell' and 'edit'; the aliases are listed in case a request carries one.
const SHELL_ACTIONS = new Set(['shell', 'bash']);
const EDIT_ACTIONS = new Set(['edit', 'write', 'patch']);

const SHELL_STORE = /sterling\.db/i;
const STORE_FILE = /^sterling\.db(-wal|-shm|-journal|\..+)?$/i;

/** True when `path`, in any spelling (./, .., \, absolute), names a store database: a `.sterling` component and a sterling.db file name. */
export function isStorePath(path) {
  const parts = posix.normalize(path.replaceAll('\\', '/')).split('/');
  return STORE_FILE.test(parts.at(-1)) && parts.slice(0, -1).some((c) => c.toLowerCase() === '.sterling');
}

/** A shell command as the shell reads its words: quote characters and backslashes removed. */
const unquoted = (command) => command.replace(/['"\\]/g, '');

/** The message to deny an evaluate request with, or null when the guard leaves its verdict alone. */
export function storeGuardVerdict(request) {
  const shell = SHELL_ACTIONS.has(request.action);
  if (!shell && !EDIT_ACTIONS.has(request.action)) return null;
  const { resources } = request;
  if (!Array.isArray(resources) || !resources.every((r) => typeof r === 'string')) return STORE_GUARD_UNREADABLE_MESSAGE;
  if (shell) return resources.some((r) => SHELL_STORE.test(unquoted(r))) ? STORE_GUARD_MESSAGE : null;
  const filepath = request.metadata?.filepath;
  const paths = typeof filepath === 'string' ? [...resources, filepath] : resources;
  return paths.some(isStorePath) ? STORE_GUARD_MESSAGE : null;
}

/** The evaluate hook: sets effect 'deny' and the message on a request that touches the store. */
export function onEvaluate(request) {
  const message = storeGuardVerdict(request);
  if (message === null) return;
  request.effect = 'deny';
  request.message = message;
}
