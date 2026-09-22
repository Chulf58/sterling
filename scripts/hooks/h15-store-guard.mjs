// H15 — store DATABASE seal. PreToolUse on Bash|PowerShell and on Edit|Write|MultiEdit|NotebookEdit; BLOCKING (exit 2 = deny).
//
// ONE RULE (decision sterling-claude-code-scale-down-boundary, user-ruled 2026-09-19): nothing but the Sterling MCP server
// touches the store DATABASE — `.sterling/sterling.db` and its siblings (`sterling.db-wal`, `-shm`, `-journal`,
// `sterling.db.*` backups). Every other file under `.sterling/` (config.json, transient/*, delivery-audit/*, ...) is
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

const DB_FILE_RE = /^sterling\.db(?:-wal|-shm|-journal|\..+)?$/i;

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
// 2026-09-22): a fragment is allowed when a bare `-readonly` token precedes the PROTECTED DB PATH argument — the flag
// decides, not the SQL text; `--readonly` is not recognized (unverified on this machine, not invented); a dot-command
// that writes at the client level (`.output`/`.once`/`.backup`) naming the db path still denies even with `-readonly`.
// A non-string `command` is DENIED outright (it cannot be inspected); a missing/empty one allows. Everything else
// allows: reads, mentions, unknown verbs, `node -e`/`python -c` one-liners (accident guard, not a sandbox), Sterling
// scripts taking `--store <db>`.

/** Index just past the quote run starting at s[i] (s[i] is `'` or `"`). */
function skipQuoted(s, i) {
  if (s[i] === "'") { const j = s.indexOf("'", i + 1); return j === -1 ? s.length : j + 1; }
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, s.length);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Excise heredoc BODIES (never fragmented/tokenized) from a command string. */
function stripHeredocBodies(cmd) {
  let out = '', i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "'" || c === '"') { const end = skipQuoted(cmd, i); out += cmd.slice(i, end); i = end; continue; }
    if (c === '\\' && !PS) { out += cmd.slice(i, Math.min(i + 2, n)); i += 2; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      let j = i + 2;
      if (cmd[j] === '-') j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      let tag = '', k = j;
      if (cmd[j] === "'" || cmd[j] === '"') {
        const q = cmd[j]; k = j + 1;
        while (k < n && cmd[k] !== q) k++;
        tag = cmd.slice(j + 1, k); k++;
      } else {
        while (k < n && /[A-Za-z0-9_]/.test(cmd[k])) k++;
        tag = cmd.slice(j, k);
      }
      j = k;
      if (tag) {
        const lineEnd = cmd.indexOf('\n', j);
        if (lineEnd === -1) { out += cmd.slice(i, j); i = n; continue; }
        out += cmd.slice(i, j) + '\n';
        const m = new RegExp('^\\t*' + escapeRe(tag) + '$', 'm').exec(cmd.slice(lineEnd + 1));
        i = m ? lineEnd + 1 + m.index + m[0].length : n;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/** Matching close delimiter for text starting at `start`, depth 1 already open. */
function extractBalanced(str, start, openCh, closeCh) {
  let depth = 1, i = start;
  const n = str.length;
  while (i < n && depth > 0) {
    const c = str[i];
    if (c === "'" || c === '"') { i = skipQuoted(str, i); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) depth--;
    i++;
  }
  return { inner: str.slice(start, i - 1), end: i };
}

/** Double-quoted text still expands `$(...)`/backticks in real shells: scan for them and
 *  recurse into their contents as fragments (single-quoted text stays fully literal). */
function scanDoubleQuoted(str, i) {
  let j = i + 1;
  const n = str.length;
  const subs = [];
  while (j < n && str[j] !== '"') {
    if (str[j] === '\\' && j + 1 < n && !PS) { j += 2; continue; }
    if (str[j] === '$' && str[j + 1] === '(') {
      const { inner, end } = extractBalanced(str, j + 2, '(', ')');
      subs.push(...splitTopLevel(inner)); j = end; continue;
    }
    if (str[j] === '`') {
      let k = j + 1;
      while (k < n && str[k] !== '`') k += str[k] === '\\' ? 2 : 1;
      subs.push(...splitTopLevel(str.slice(j + 1, k))); j = k + 1; continue;
    }
    j++;
  }
  return { end: Math.min(j + 1, n), subs };
}

/** Split a (heredoc-stripped) command into fragments, recursing into subshells/substitutions. */
function splitTopLevel(str) {
  const fragments = [];
  let buf = '', i = 0;
  const n = str.length;
  const flush = () => { const t = buf.trim(); if (t) fragments.push(t); buf = ''; };
  while (i < n) {
    const c = str[i];
    if (c === "'") { const end = skipQuoted(str, i); buf += str.slice(i, end); i = end; continue; }
    if (c === '"') {
      const { end, subs } = scanDoubleQuoted(str, i);
      buf += str.slice(i, end); fragments.push(...subs); i = end; continue;
    }
    if (c === '\\' && !PS) { buf += str.slice(i, Math.min(i + 2, n)); i += 2; continue; }
    if (c === '$' && str[i + 1] === '(') {
      const { inner, end } = extractBalanced(str, i + 2, '(', ')');
      fragments.push(...splitTopLevel(inner)); buf += ' '; i = end; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && str[j] !== '`') j += str[j] === '\\' ? 2 : 1;
      fragments.push(...splitTopLevel(str.slice(i + 1, j))); buf += ' '; i = j + 1; continue;
    }
    if (c === '(') {
      const { inner, end } = extractBalanced(str, i + 1, '(', ')');
      fragments.push(...splitTopLevel(inner)); buf += ' '; i = end; continue;
    }
    if (c === '\n' || c === ';') { flush(); i++; continue; }
    if (c === '&' && str[i + 1] === '&') { flush(); i += 2; continue; }
    if (c === '|' && str[i + 1] === '|') { flush(); i += 2; continue; }
    if (c === '|') {
      if (str[i - 1] === '>') { buf += c; i++; continue; } // part of a >| clobber operator, not a pipe
      flush(); i++; continue;
    }
    if (c === '&') {
      if (str[i + 1] === '>') { buf += c; i++; continue; } // part of &>, not the background separator
      flush(); i++; continue;
    }
    buf += c; i++;
  }
  flush();
  return fragments;
}

/** Quote-aware tokenizer: words join quote-concatenated parts; redirects/`|`/`&` are op tokens. */
function tokenizeFragment(fragment) {
  const tokens = [];
  let word = '', i = 0;
  const n = fragment.length;
  const flushWord = () => { if (word !== '') { tokens.push({ type: 'word', value: word }); word = ''; } };
  const takeFd = () => {
    if (/^\d+$/.test(word)) { const fd = word; word = ''; return fd; }
    flushWord(); return '';
  };
  while (i < n) {
    const c = fragment[i];
    if (c === ' ' || c === '\t') { flushWord(); i++; continue; }
    if (c === "'") {
      const j = fragment.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      word += fragment.slice(i + 1, end); i = j === -1 ? n : j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && fragment[j] !== '"') {
        if (fragment[j] === '\\' && j + 1 < n && !PS) { word += fragment[j + 1]; j += 2; }
        else { word += fragment[j]; j++; }
      }
      i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < n && !PS) { word += fragment[i + 1]; i += 2; continue; }
    if (c === '>' || c === '<') {
      const fd = takeFd();
      let op = fd + c; i++;
      if (fragment[i] === c) { op += c; i++; }
      else if (c === '>' && fragment[i] === '|') { op += '|'; i++; }
      tokens.push({ type: 'op', value: op }); continue;
    }
    if (c === '&' && fragment[i + 1] === '>') {
      const fd = takeFd();
      tokens.push({ type: 'op', value: fd + '&>' }); i += 2; continue;
    }
    if (c === '&' || c === '|') { flushWord(); tokens.push({ type: 'op', value: c }); i++; continue; }
    word += c; i++;
  }
  flushWord();
  return tokens;
}

/** True when a token's path components include `.sterling` and its basename is a database file. */
function isDbPath(token) {
  const value = token.includes('=') ? token.slice(token.lastIndexOf('=') + 1) : token;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return false;
  const base = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => p.toLowerCase() === '.sterling') && DB_FILE_RE.test(base);
}

/** True when a token's LAST path component is exactly the `.sterling` directory (case-insensitive — Windows). */
function isDotSterlingDir(token) {
  const parts = token.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 && parts[parts.length - 1].toLowerCase() === '.sterling';
}

const WRAPPERS_PLAIN = new Set(['command', 'time', 'exec', 'xargs', 'builtin']); // none of these take an option argument
const SUDO_ARG_OPTS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']);
const NICE_ARG_OPTS = new Set(['-n']);
const ENV_ARG_OPTS = new Set(['-u', '-C', '-S']);

/** Skip `-x`/`-xVALUE` flags (consuming a following token only for a bare `-x` in `argOpts`), then a `--` terminator. */
function skipOptsWithArgs(tokens, i, argOpts) {
  while (i < tokens.length && tokens[i].type === 'word' && tokens[i].value.startsWith('-') && tokens[i].value !== '--') {
    const opt = tokens[i].value; i++;
    if (opt.length === 2 && argOpts.has(opt) && i < tokens.length && tokens[i].type === 'word') i++;
  }
  if (i < tokens.length && tokens[i].type === 'word' && tokens[i].value === '--') i++;
  return i;
}

/** Like skipOptsWithArgs, but also skips interleaved `VAR=val` tokens (env's own argument shape). */
function skipEnvOptions(tokens, i) {
  while (i < tokens.length && tokens[i].type === 'word') {
    const v = tokens[i].value;
    if (v === '--') { i++; break; }
    if (/^[A-Za-z_]\w*=/.test(v)) { i++; continue; }
    if (v.startsWith('-')) {
      i++;
      if (v.length === 2 && ENV_ARG_OPTS.has(v) && i < tokens.length && tokens[i].type === 'word') i++;
      continue;
    }
    break;
  }
  return i;
}

/** Index of the destructive-verb candidate, skipping wrapper words (sudo, env, nice, ...). */
function skipWrappers(tokens) {
  let i = 0;
  if (tokens[i] && tokens[i].type === 'op' && tokens[i].value === '&') i++; // PowerShell call operator
  while (i < tokens.length && tokens[i].type === 'word') {
    const lv = tokens[i].value.toLowerCase();
    if (lv === 'sudo') { i = skipOptsWithArgs(tokens, i + 1, SUDO_ARG_OPTS); continue; }
    if (lv === 'nice') { i = skipOptsWithArgs(tokens, i + 1, NICE_ARG_OPTS); continue; }
    if (lv === 'env') { i = skipEnvOptions(tokens, i + 1); continue; }
    if (WRAPPERS_PLAIN.has(lv)) { i++; continue; }
    break;
  }
  return i;
}

const DESTRUCTIVE_VERBS = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'dd', 'truncate', 'shred', 'sqlite3', 'tee', 'del', 'erase', 'move', 'copy',
  'remove-item', 'ri', 'rd', 'move-item', 'copy-item', 'rename-item', 'set-content', 'add-content', 'out-file', 'clear-content', 'new-item',
]);

/** True when a fragment's tokens show a destructive shape aimed at the store database. */
function isDestructiveFragment(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'op' && /^\d*(>>|>\||&>|>)$/.test(t.value)) {
      const next = tokens[i + 1];
      if (next && next.type === 'word' && isDbPath(next.value)) return true;
    }
  }
  const idx0 = skipWrappers(tokens);
  const verb = tokens[idx0];
  if (!verb || verb.type !== 'word') return false;
  const lv = verb.value.toLowerCase();
  const rest = tokens.slice(idx0 + 1);
  const restWords = rest.filter((t) => t.type === 'word').map((t) => t.value);

  if (lv === 'sqlite3') {
    // user-ruled 2026-09-22 ("Yes, allow reads"): `sqlite3 -readonly <db> ...` is allowed — the
    // flag decides, H15 does not parse SQL. `-readonly` must appear before the db-path argument
    // (sqlite3 reads flags left of its positional args); `--readonly` is not recognized because
    // this rebuild does not invent CLI support that hasn't been checked against a real binary.
    // The CLI's dot-commands (.output/.once/.backup) write files at the client level regardless
    // of -readonly, so naming the db path alongside one still denies.
    const dbIdx = rest.findIndex((t) => t.type === 'word' && isDbPath(t.value));
    if (dbIdx !== -1) {
      const readonly = rest.slice(0, dbIdx).some((t) => t.type === 'word' && t.value === '-readonly');
      const dotCommandWrite = restWords.some((w) => /\.(output|once|backup)\b/i.test(w));
      if (!readonly || dotCommandWrite) return true;
    }
  } else if (DESTRUCTIVE_VERBS.has(lv) && restWords.some(isDbPath)) return true;
  if ((lv === 'sed' || lv === 'perl') && restWords.some((w) => /^-\S*i\S*$/.test(w)) && restWords.some(isDbPath)) return true;
  if (lv === 'rm') {
    const recursive = restWords.some((w) => w === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(w));
    if (recursive && restWords.some(isDotSterlingDir)) return true;
  }
  if (lv === 'rmdir' && restWords.some(isDotSterlingDir)) return true;
  if (lv === 'find') {
    const namesStore = restWords.some((w) => isDotSterlingDir(w) || /(^|[\\/])\.sterling([\\/]|$)/i.test(w));
    const deletes = restWords.includes('-delete') || (restWords.includes('-exec') && restWords.some((w) => /^rm$/i.test(w)));
    if (namesStore && deletes) return true;
  }
  if (lv === 'git' && restWords[0] && restWords[0].toLowerCase() === 'clean') {
    const flagChars = rest.filter((t) => t.type === 'word' && /^-[^-]/.test(t.value)).map((t) => t.value.slice(1)).join('') +
      (restWords.includes('--force') ? 'f' : '');
    if (/[xX]/.test(flagChars) && /[df]/.test(flagChars)) return true;
  }
  if (lv === 'remove-item' || lv === 'ri' || lv === 'rd') {
    const recursive = restWords.some((w) => /^-r(ecurse)?$/i.test(w) || w.toLowerCase() === '/s');
    if (recursive && restWords.some(isDotSterlingDir)) return true;
  }
  return false;
}

const tool = input.tool_name;
const PS = tool === 'PowerShell'; // backslash is a path separator, not an escape char, in PowerShell

if (tool === 'Bash' || tool === 'PowerShell') {
  const rawCommand = input.tool_input?.command;
  let command;
  if (rawCommand === undefined || rawCommand === null) command = '';
  else if (typeof rawCommand === 'string') command = rawCommand;
  else deny(`H15: this ${tool} call carries a non-string command (${typeof rawCommand}), which cannot be safely inspected for a destructive shape — re-issue with a string command.`);
  const fragments = splitTopLevel(stripHeredocBodies(command));
  for (const fragment of fragments) {
    if (isDestructiveFragment(tokenizeFragment(fragment))) {
      deny(
        'H15: this command would overwrite, delete, move or rewrite the Sterling store database (sterling.db) or the .sterling directory that holds it, which only the Sterling MCP server writes — ' +
          'write it with knowledge_create / knowledge_update / board_add and the other MCP tools. ' +
          'Reading or merely naming the path is fine, and every other file under .sterling/ (config.json, transient/*) may be read and written freely.'
      );
    }
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
