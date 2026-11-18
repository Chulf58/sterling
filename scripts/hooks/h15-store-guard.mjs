// H15 — store DATABASE seal. PreToolUse on Bash|PowerShell and on Edit|Write|MultiEdit|NotebookEdit; BLOCKING (exit 2 = deny).
//
// ONE RULE (decision sterling-claude-code-scale-down-boundary, user-ruled 2026-09-19): nothing but the Sterling MCP server
// touches the store DATABASE (in work mode also its Postgres schemas; see the Postgres arm below) — `.sterling/sterling.db` and its siblings (`sterling.db-wal`, `-shm`, `-journal`,
// `sterling.db.*` backups). Every other file under `.sterling/` (config.json, transient/*, ...) is
// ordinary project state any tool may read or write.
//
// Channels: structured (Edit/Write/MultiEdit/NotebookEdit) resolves the destination against cwd, denies when it carries a
// `.sterling` directory component AND a database basename. shell (Bash/PowerShell) is OPEN-WORLD — a small fragmenter +
// quote-aware tokenizer, not a whole-string regex; see the INVARIANT below. NOT GUARANTEED: a process writing the file
// directly (script/TUI/editor) is outside the tool channel; a symlink/hardlink into the store is not followed; check and
// write are separate resolutions of one string (TOCTOU). A guard against accidents, not an adversary. The 1,500-line
// predecessor (closed-world verb classifier, sanctioned-script provenance, symlink walks, per-file allowlists) was cut as
// friction (decision scale-down-enforcement-rules-and-locks-are-friction). The shell arm was rebuilt from blank a second
// time on 2026-09-19 (rebuild-over-patch: three same-day regex fix rounds were each found wrong by an outside reviewer) —
// three whole-string regexes replaced by the fragmenter/tokenizer below.
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { readStdin, deny, allow } from './lib/common.mjs';
import { DB_FILE_RE, storeShellWriteShape } from './lib/store-shell-verdict.mjs';

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

// ── shell channel ──────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT: split the command into FRAGMENTS on newline, `;`, `&&`, `||`, `|`, `&`, and subshell/command-substitution
// boundaries (`(...)`, `$(...)`, backticks, INCLUDING when they occur inside double-quoted text — their contents recurse
// as fragments too; single-quoted text stays fully literal). Heredoc BODIES (`<<TAG` / `<<'TAG'` / `<<-TAG` through the
// terminator line) are opaque: never fragments, never tokens. Tokenize each fragment quote-aware, joining
// quote-concatenated parts (`>"$PWD"/.sterling/sterling.db` is one target token). DENY only on one of four destructive
// shapes aimed at the store: (a) a redirection (`>`,`>>`,`>|`,`N>`,`N>>`,`&>`) targeting a PROTECTED DB PATH; (b) a
// destructive verb in invocation position — after skipping wrapper words `sudo`/`nice`/`env`/`command`/`time`/`exec`/
// `xargs`/`builtin`/PowerShell `&`, each of whose OWN option arguments are parsed (sudo's -u/-g/-C/-D/-h/-p/-r/-t/-U/-T,
// nice's -n, and env's -u/-C/-S each consume a following token; env's `VAR=val` tokens are skipped too; a `--`
// terminator ends any wrapper's own options) — whose arguments include a PROTECTED DB PATH (also `dd of=<path>`); (c)
// in-place `sed`/`perl` (`-i`,`-pi`,`-0pi`,`-i.bak`) naming a PROTECTED DB PATH; (d) RECURSIVE deletion of the store
// DIRECTORY: `rm` with a `r`/`R`/`--recursive` flag whose argument's last path component is `.sterling`
// (case-insensitive); `rmdir <..>/.sterling`; `find <..>.sterling ... -delete`/`-exec rm`; `git clean` with `x`/`X`
// together with `d`/`f`; PowerShell Remove-Item/ri/rd with `-Recurse`/`-r`/`/s` on a `.sterling` path. A PROTECTED DB
// PATH is a token whose path components include `.sterling` (case-insensitive) AND whose basename matches DB_FILE_RE —
// a same-named file elsewhere (`fixtures/sterling.db`) is NOT protected. EXCEPTION to (b) for `sqlite3` only (user-ruled
// 2026-09-22, review-hardened same day, twice): a fragment is allowed when a bare `-readonly` token precedes the
// PROTECTED DB PATH argument and survives SQLITE3_VALUE_OPTS arity (e.g. `-separator -readonly` does NOT count — that
// `-readonly` is `-separator`'s value); `--readonly` is not recognized (unverified on this machine, not invented).
// DENIED for EVERY sqlite3 invocation regardless of `-readonly` or of which db is positionally opened — ATTACH and a
// dot-command target a path of THEIR OWN, unrelated to the opened db: a `.output`/`.once`/`.backup`/`.save`
// dot-command whose TARGET (the LAST argument on its line — `.backup`/`.save` accept an optional leading DB-schema
// name that is not the target) names a `.sterling/` path; a VACUUM [SCHEMA] INTO or ATTACH (raw text, its own
// SQL/heredoc body) naming a `.sterling/` path — VACUUM INTO creates a new file rather than writing the opened db,
// and ATTACH opens a second db read-write by default, so neither is stopped by -readonly's OS-level read-only open
// on the primary connection. A non-string `command` is DENIED outright (it cannot be inspected); a missing/empty one
// allows. Everything else allows: reads, mentions, unknown verbs, `node -e`/`python -c` one-liners (accident guard,
// not a sandbox), Sterling scripts taking `--store <db>`.
// ADDED 2026-10-03 (task-end review of the shared parser): a PROTECTED DB PATH is also a glob or brace pattern that can
// expand to a database file — one beginning `sterling` (`sterling.db*`, `sterling.db{,-wal}`) under any `.sterling`
// component, any other (`*`, `*.db`) only directly inside `.sterling/` or `.sterling/domains/<tag>/`; a pattern with
// more than six wildcards counts as able to expand to it — and the value of a PowerShell `-Name:` parameter. The verb is found past leading `VAR=val` assignments, the grammar words
// `if`/`then`/`else`/`elif`/`do`/`while`/`until`/`{`/`!`, and `timeout` (its -k/-s values and duration) and `nohup`,
// and is read by its file name (`/bin/rm`). The `-c`/`-Command` argument of bash/sh/zsh/dash/ksh/pwsh/powershell and
// the arguments of `eval` are parsed as command lines of their own. PowerShell aliases sc/ac/clc/ni/mi/cpi/rni/ren are
// destructive verbs. A command the parser cannot read (it throws) is DENIED. NOT denied (user-ruled 2026-10-03, "Keep
// deletes, drop git and find": they block commands that do not touch the store, and the scale-down removed friction on
// purpose): `git rm`/`mv`/`checkout`/`restore` on the database path, and `find` selecting it by `-name`.
// The parser lives in lib/store-shell-verdict.mjs (storeShellWriteShape), shared with the OpenCode store guard.

// ── shell channel, Postgres arm (decision postgres-store-backend-design-sync-bridge-schema-per-store, point 11) ──────────
// In work mode the store lives in Postgres schemas named sterling_* (sterling_meta, sterling_p_<uuid>, sterling_d_<name>,
// sterling_test_<random>; decision postgres-schema-names-sterling-p-uuid-sterling-d-domain), which only the MCP server and
// the store write. DENY when BOTH hold: (1) the command runs an ad-hoc client: `psql`, or `node`/`nodejs`/`bun` with
// `-e`/`--eval`/`-p`/`--print`, or one of them reading its program from stdin (a heredoc, `-`, or a pipe into a bare
// `node`); and (2) the command text, heredoc bodies included, holds a write statement aimed at a sterling_ schema:
// INSERT INTO, UPDATE [ONLY], DELETE FROM [ONLY], or COPY <table> ... FROM whose target is schema-qualified with a
// sterling_ name (unquoted, any case, or "quoted"); TRUNCATE/DROP/ALTER/CREATE with a sterling_ name later in the same
// statement (up to the next `;`); or any of those verbs after a `search_path` set to a sterling_ schema. Allowed:
// SELECTs, COPY ... TO and COPY (query) TO, schemas outside the prefix (opensterling, opensterling_live, public), and
// every command without an ad-hoc client — Sterling's scripts and bundles and the `node --test` store suites run as
// script files, and the MCP server and the store are processes, not tool calls. NOT CAUGHT: SQL in a file the client
// reads (`psql -f`, `psql < file`, `node script.mjs`), a schema name built at run time (`${schema}.records`), SQL
// comments between keywords (`INSERT/**/INTO`), other clients (python -c, pgcli, a GUI), MERGE/GRANT/REVOKE/COMMENT ON
// and functions with side effects, and an unqualified write after a search_path that is not set in the command itself.
// Over-catches, accepted: a command that runs an ad-hoc client AND carries such text anywhere else (a commit message).
const PG_CLIENT_RES = [
  /(?:^|[\s;&|(`'"])(?:[^\s;&|(`'"]*[\\/])?psql(?:\.exe)?(?=[\s;&|)`'"]|$)/i,
  /(?:^|[\s;&|(`'"])(?:[^\s;&|(`'"]*[\\/])?(?:node|nodejs|bun)(?:\.exe)?\s(?:[^;&|\n]*?\s)?(?:-e|--eval|-p|--print|-pe)(?=[\s='"]|$)/i,
  /(?:^|[\s;&|(`'"])(?:[^\s;&|(`'"]*[\\/])?(?:node|nodejs|bun)(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s*(?:-\s*)?(?:<<|<\s|$|[;&|\n)])/i,
];
const SCHEMA = String.raw`(?:"sterling_[^"]*"|\bsterling_[a-z0-9_$]*)`;
const PG_WRITE_RES = [
  new RegExp(String.raw`\bINSERT\s+INTO\s+${SCHEMA}`, 'i'),
  new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${SCHEMA}`, 'i'),
  new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${SCHEMA}`, 'i'),
  new RegExp(String.raw`\b(?:TRUNCATE|DROP|ALTER|CREATE)\b[^;]*?${SCHEMA}`, 'i'),
  new RegExp(String.raw`\bCOPY\s+${SCHEMA}[^;]*?\bFROM\b`, 'i'),
];
const PG_SEARCH_PATH_RE = new RegExp(String.raw`search_path\s*(?:=|\bTO\b)\s*[^;]{0,80}?${SCHEMA}`, 'i');
const PG_UNQUALIFIED_WRITE_RE = /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[\w"]+\s+SET|DELETE\s+FROM|TRUNCATE|DROP|ALTER|CREATE|COPY\s+[\w"]+[^;]*?\bFROM)\b/i;

function postgresSchemaWrite(command) {
  if (!PG_CLIENT_RES.some((re) => re.test(command))) return false;
  if (PG_WRITE_RES.some((re) => re.test(command))) return true;
  return PG_SEARCH_PATH_RE.test(command) && PG_UNQUALIFIED_WRITE_RE.test(command);
}

const tool = input.tool_name;
const PS = tool === 'PowerShell'; // backslash is a path separator, not an escape char, in PowerShell

if (tool === 'Bash' || tool === 'PowerShell') {
  const rawCommand = input.tool_input?.command;
  let command;
  if (rawCommand === undefined || rawCommand === null) command = '';
  else if (typeof rawCommand === 'string') command = rawCommand;
  else deny(`H15: this ${tool} call carries a non-string command (${typeof rawCommand}), which cannot be safely inspected for a destructive shape — re-issue with a string command.`);
  let writes;
  try {
    writes = storeShellWriteShape(command, { powershell: PS });
  } catch (e) {
    deny(`H15: this ${tool} command could not be parsed (${(e && e.message) || e}), so the store database cannot be shown untouched — a gate that cannot read its input fails closed (P5). Re-issue it in a simpler form.`);
  }
  if (writes) {
    deny(
      'H15: this command would overwrite, delete, move or rewrite the Sterling store database (sterling.db) or the .sterling directory that holds it, which only the Sterling MCP server writes — ' +
        'write it with knowledge_create / knowledge_update / board_add and the other MCP tools. ' +
        'Reading or merely naming the path is fine, and every other file under .sterling/ (config.json, transient/*) may be read and written freely.'
    );
  }
  if (postgresSchemaWrite(command)) {
    deny(
      'H15: this command writes to a Sterling Postgres schema (sterling_meta, sterling_p_*, sterling_d_*, sterling_test_*) through an ad-hoc client (psql, or node/bun given a program inline or on stdin), and only the Sterling MCP server and store write those schemas — ' +
        'write with knowledge_create / knowledge_update / board_add and the other MCP tools. ' +
        'Read-only SELECTs, Sterling scripts, the node --test store suites and schemas outside the sterling_ prefix are fine.'
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
