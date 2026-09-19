// H15 — store DATABASE seal. PreToolUse on Bash|PowerShell and on
// Edit|Write|MultiEdit|NotebookEdit; BLOCKING (exit 2 = deny).
//
// ONE RULE (decision sterling-claude-code-scale-down-boundary, user-ruled
// 2026-09-19): nothing but the Sterling MCP server touches the store DATABASE —
// `.sterling/sterling.db` and its siblings (`sterling.db-wal`, `-shm`,
// `-journal`, and `sterling.db.*` backup/migration files). Every other file
// under `.sterling/` (config.json, transient/*, delivery-audit/*, ...) is
// ordinary project state that any tool may read or write.
//
// Channels:
//   structured (Edit/Write/MultiEdit/NotebookEdit): the destination path is
//     resolved against cwd; denied when it carries a `.sterling` directory
//     component AND its basename is a database file.
//   shell (Bash/PowerShell): OPEN-WORLD. Denied only when a shell fragment has
//     a DESTRUCTIVE shape aimed at the database: a redirection whose target
//     names it, or a destructive verb (rm, mv, cp, dd, truncate, shred,
//     sqlite3, tee, in-place sed/perl, Remove-Item/Set-Content/... on
//     PowerShell) whose fragment names it. Reads and mere mentions — cat, ls,
//     grep, echo, a heredoc that contains the path, a Sterling script taking
//     `--store <db>` — all pass. Unknown verbs pass: this is the opposite of
//     the deleted closed-world classifier (user-ruled 2026-09-19: "we dont
//     want an agent to do something destructive" — and nothing more).
//
// What this does NOT guarantee: a process writing the file directly (a script,
// the TUI, an editor) is outside the tool channel; a symlink or hard link into
// the store is not followed; the check and the write are separate resolutions
// of one string (TOCTOU). This is a guard against accidents, not an adversary.
// Its 1,500-line predecessor (closed-world verb classifier, sanctioned-script
// provenance, symlink walks, per-file allowlists) was cut as friction
// (decision scale-down-enforcement-rules-and-locks-are-friction).
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { readStdin, deny, allow } from './lib/common.mjs';

const DB_FILE_RE = /^sterling\.db(?:-wal|-shm|-journal|\..+)?$/i;
// A redirection (> or >>, with an optional fd) whose target names the database.
const DB_REDIRECT_RE = /\d?>{1,2}\s*["']?[^\s"'|;&<>]*sterling\.db/i;
// A destructive verb in the INVOCATION position of a fragment (start of command, or after
// ; & | or an opening paren, optionally under sudo) whose fragment names the database.
const DB_DESTRUCTIVE_VERB_RE =
  /(?:^|[;&|(]\s*)(?:sudo\s+)?(?:rm|rmdir|unlink|mv|cp|dd|truncate|shred|sqlite3|tee|del|erase|move|copy|ri|rd|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File|Clear-Content|New-Item)\b[^;&|]*sterling\.db/i;
// In-place edits: sed -i / perl -i (any flag cluster containing i) naming the database.
const DB_INPLACE_RE = /(?:^|[;&|(]\s*)(?:sudo\s+)?(?:sed|perl)\s+(?:-\S*\s+)*-\S*i\S*\s+[^;&|]*sterling\.db/i;

let input;
try {
  input = readStdin();
} catch (e) {
  deny(`H15: hook input could not be read (${(e && e.message) || e}) — a gate that cannot read its input fails closed (P5).`);
}

/** True when any directory component of an absolute path is `.sterling` (host name rules). */
function namesStoreComponent(absPath) {
  const win32 = sep === '\\';
  return absPath
    .split(win32 ? /[\\/]+/ : /\/+/)
    .some((c) => (win32 ? c.replace(/[. ]+$/, '') : c).toLowerCase() === '.sterling');
}

const tool = input.tool_name;

// ── shell channel ────────────────────────────────────────────────────────────
if (tool === 'Bash' || tool === 'PowerShell') {
  const command = String(input.tool_input?.command ?? '');
  if (DB_REDIRECT_RE.test(command) || DB_DESTRUCTIVE_VERB_RE.test(command) || DB_INPLACE_RE.test(command)) {
    deny(
      'H15: this command would overwrite, delete, move or rewrite the Sterling store database (sterling.db), which only the Sterling MCP server writes — ' +
        'write it with knowledge_create / knowledge_update / board_add and the other MCP tools. ' +
        'Reading or merely naming the path is fine, and every other file under .sterling/ (config.json, transient/*) may be read and written freely.'
    );
  }
  allow();
}

// ── structured-write channel ─────────────────────────────────────────────────
const field =
  tool === 'NotebookEdit' ? 'notebook_path' : tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? 'file_path' : null;
if (field === null) allow(); // a tool this hook was not registered for — nothing to seal

const submitted = input.tool_input?.[field];
if (typeof submitted !== 'string' || submitted.trim() === '') {
  deny(`H15: this ${tool} call carries no usable tool_input.${field}, so the store database cannot be shown untouched — re-issue with an explicit path.`);
}
const base = typeof input.cwd === 'string' ? input.cwd : '';
if (!isAbsolute(submitted) && base === '') {
  deny(`H15: '${submitted}' is a relative path and this call carries no cwd to resolve it against, so the store database cannot be shown untouched.`);
}
const destination = isAbsolute(submitted) ? resolve(submitted) : resolve(base, submitted);
if (namesStoreComponent(destination) && DB_FILE_RE.test(basename(destination))) {
  deny(
    `H15: this ${tool} call targets the Sterling store database (${destination}), which only the Sterling MCP server writes — use the knowledge_* / board_* tools. ` +
      'Every other file under .sterling/ (config.json, transient/*) may be edited directly.'
  );
}
allow();
