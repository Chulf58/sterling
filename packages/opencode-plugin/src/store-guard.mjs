// The store guard on OpenCode (decision
// opencode-store-guard-uses-the-plugin-permission-evaluate-hook): an evaluate hook
// that denies an edit, write or patch request touching .sterling/sterling.db, and a
// shell request with a write shape aimed at it, whatever the running agent's own rules
// say. A shell command that only reads or names the store passes, as it does through
// H15 on Claude Code (decision opencode-store-guard-allows-read-only-shell-commands-like-h15). OpenCode 2.0.22 calls every plugin's
// evaluate hook after the agent's rule list has reached a verdict, so it holds where
// the config guard in .opencode/opencode.json cannot: a PROJECT agent file's rules
// load after that config, and a plugin's agent transform runs before agent files load
// (both measured live). The config guard stays as a second layer for edit, write and
// patch only; it carries no shell rule, so this hook is the one shell guard.
// Request shapes, measured live on 2.0.22 with a probe plugin:
//   - shell: resources holds one entry per simple command, with a leading `cd`
//     dropped (`cd .sterling && cat sterling.db` arrives as ['cat sterling.db'];
//     `cat x; rm .sterling/sterling.db` as ['cat x', 'rm .sterling/sterling.db']),
//     so the working directory of a command is unknown and a bare sterling.db may be
//     the store;
//   - the patch tool arrives as action 'edit' with project-relative paths in
//     resources and metadata.filepath.
// Only store databases are guarded, as H15 guards them on Claude Code: a path with a
// `.sterling` component whose file name is sterling.db, sterling.db-wal, -shm, -journal
// or sterling.db.<anything>, so the project store and the domain stores under
// ~/.sterling/domains/<tag>/ alike. Every other file under .sterling/ stays editable
// (CLAUDE.md, H15). The match ignores case, because the file systems of Windows and
// macOS do.
// Shell verdicts come from the parser H15 uses (storeShellWriteShape in
// scripts/hooks/lib/store-shell-verdict.mjs), run per resource with bareDbName on, so
// three things are stricter here than in H15: a database file name counts without a
// `.sterling` component (`rm sterling.db`), a resource that is itself a database path
// is denied (a redirect target delivered apart from its command), and so is a
// `sqlite3 -readonly` heredoc whose body the resource does not carry. Each resource is
// read both as bash and as PowerShell text (backslash as escape, then as path
// separator), and either reading can deny.
// Not measured: how a redirect (`echo x > .sterling/sterling.db`) reaches the hook. If
// the target is part of the command's resource or a resource of its own it is denied;
// if OpenCode drops it, this hook cannot see it.
// A resource the parser cannot read (it throws) is denied with the unreadable message.
// Not guaranteed: a shell command that reaches the store without naming it (a glob
// with no `sterling` in it outside `.sterling/`, such as `rm *` after a dropped `cd
// .sterling`; a variable; a symlink; a script file); and an evaluate hook registered
// after this one (another plugin) can set the effect back, measured live.
import { posix } from 'node:path';
import { storeShellWriteShape } from '../../../scripts/hooks/lib/store-shell-verdict.mjs';

export const STORE_GUARD_MESSAGE =
  'Sterling store guard: .sterling/sterling.db is written only by the Sterling MCP server. Use the sterling knowledge_* and board_* tools instead. Reading it from the shell is allowed (cat, ls, sqlite3 -readonly). Every other file under .sterling/ can be edited.';
export const STORE_GUARD_UNREADABLE_MESSAGE =
  'Sterling store guard: could not read which files or commands this request touches (the OpenCode permission request has an unknown shape), so it is denied rather than risk the store.';

// OpenCode 2.0.22 sends 'shell' and 'edit'; the aliases are listed in case a request carries one.
const SHELL_ACTIONS = new Set(['shell', 'bash']);
const EDIT_ACTIONS = new Set(['edit', 'write', 'patch']);

const STORE_FILE = /^sterling\.db(-wal|-shm|-journal|\..+)?$/i;

/** True when `path`, in any spelling (./, .., \, absolute), names a store database: a `.sterling` component and a sterling.db file name. */
export function isStorePath(path) {
  const parts = posix.normalize(path.replaceAll('\\', '/')).split('/');
  return STORE_FILE.test(parts.at(-1)) && parts.slice(0, -1).some((c) => c.toLowerCase() === '.sterling');
}

/** True when one shell resource holds a write shape aimed at a store database, read as bash or as PowerShell text. */
const shellWrites = (resource) =>
  storeShellWriteShape(resource, { bareDbName: true }) || storeShellWriteShape(resource, { bareDbName: true, powershell: true });

/** The message to deny an evaluate request with, or null when the guard leaves its verdict alone. */
export function storeGuardVerdict(request) {
  const shell = SHELL_ACTIONS.has(request.action);
  if (!shell && !EDIT_ACTIONS.has(request.action)) return null;
  const { resources } = request;
  if (!Array.isArray(resources) || !resources.every((r) => typeof r === 'string')) return STORE_GUARD_UNREADABLE_MESSAGE;
  if (shell) {
    try {
      return resources.some(shellWrites) ? STORE_GUARD_MESSAGE : null;
    } catch {
      return STORE_GUARD_UNREADABLE_MESSAGE; // the parser threw (input nested too deep): denied, never passed
    }
  }
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
