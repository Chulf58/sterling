// The shell verdict of the store guard, shared by both hosts: H15 on Claude Code
// (scripts/hooks/h15-store-guard.mjs) and the OpenCode store guard
// (packages/opencode-plugin/src/store-guard.mjs) call storeShellWriteShape, so one parser decides
// what counts as a write shape aimed at the store database (decision
// opencode-store-guard-allows-read-only-shell-commands-like-h15). Pure: no I/O, no process state.
// The INVARIANT the parser holds is stated in the H15 source, above its shell channel.

export const DB_FILE_RE = /^sterling\.db(?:-wal|-shm|-journal|\..+)?$/i;

/** Index just past the quote run starting at s[i] (s[i] is `'` or `"`). */
function skipQuoted(s, i) {
  if (s[i] === "'") { const j = s.indexOf("'", i + 1); return j === -1 ? s.length : j + 1; }
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, s.length);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Excise heredoc BODIES (never fragmented/tokenized) from a command string. `bodies`, if given, collects
 *  each excised body's raw text — used only by the sqlite3 -readonly VACUUM INTO / ATTACH raw-text scan
 *  below, since a heredoc-fed sqlite3 script never appears in any fragment's tokens. */
function stripHeredocBodies(cmd, bodies, o) {
  let out = '', i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "'" || c === '"') { const end = skipQuoted(cmd, i); out += cmd.slice(i, end); i = end; continue; }
    if (c === '\\' && !o.ps) { out += cmd.slice(i, Math.min(i + 2, n)); i += 2; continue; }
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
        const rest = cmd.slice(lineEnd + 1);
        const m = new RegExp('^\\t*' + escapeRe(tag) + '$', 'm').exec(rest);
        if (bodies) bodies.push(m ? rest.slice(0, m.index) : rest);
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
function scanDoubleQuoted(str, i, o) {
  let j = i + 1;
  const n = str.length;
  const subs = [];
  while (j < n && str[j] !== '"') {
    if (str[j] === '\\' && j + 1 < n && !o.ps) { j += 2; continue; }
    if (str[j] === '$' && str[j + 1] === '(') {
      const { inner, end } = extractBalanced(str, j + 2, '(', ')');
      subs.push(...splitTopLevel(inner, o)); j = end; continue;
    }
    if (str[j] === '`') {
      let k = j + 1;
      while (k < n && str[k] !== '`') k += str[k] === '\\' ? 2 : 1;
      subs.push(...splitTopLevel(str.slice(j + 1, k), o)); j = k + 1; continue;
    }
    j++;
  }
  return { end: Math.min(j + 1, n), subs };
}

/** Split a (heredoc-stripped) command into fragments, recursing into subshells/substitutions. */
function splitTopLevel(str, o) {
  const fragments = [];
  let buf = '', i = 0;
  const n = str.length;
  const flush = () => { const t = buf.trim(); if (t) fragments.push(t); buf = ''; };
  while (i < n) {
    const c = str[i];
    if (c === "'") { const end = skipQuoted(str, i); buf += str.slice(i, end); i = end; continue; }
    if (c === '"') {
      const { end, subs } = scanDoubleQuoted(str, i, o);
      buf += str.slice(i, end); fragments.push(...subs); i = end; continue;
    }
    if (c === '\\' && !o.ps) { buf += str.slice(i, Math.min(i + 2, n)); i += 2; continue; }
    if (c === '$' && str[i + 1] === '(') {
      const { inner, end } = extractBalanced(str, i + 2, '(', ')');
      fragments.push(...splitTopLevel(inner, o)); buf += ' '; i = end; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && str[j] !== '`') j += str[j] === '\\' ? 2 : 1;
      fragments.push(...splitTopLevel(str.slice(i + 1, j), o)); buf += ' '; i = j + 1; continue;
    }
    if (c === '(') {
      const { inner, end } = extractBalanced(str, i + 1, '(', ')');
      fragments.push(...splitTopLevel(inner, o)); buf += ' '; i = end; continue;
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
function tokenizeFragment(fragment, o) {
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
        if (fragment[j] === '\\' && j + 1 < n && !o.ps) { word += fragment[j + 1]; j += 2; }
        else { word += fragment[j]; j++; }
      }
      i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < n && !o.ps) { word += fragment[i + 1]; i += 2; continue; }
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

const DB_NAME_SAMPLES = ['sterling.db', 'sterling.db-wal', 'sterling.db-shm', 'sterling.db-journal', 'sterling.db.bak'];

/** True when `base` is a glob or brace pattern (`*`, `?`, `[..]`, `{a,b}`) that can expand to a database file
 *  name, tested against DB_NAME_SAMPLES. A run of `*` is read as one. A pattern with more than six wildcards,
 *  or one that cannot be turned into a regex, counts as a match, so the regex built here stays small. */
function globMatchesDbName(pattern) {
  if (!/[*?[{]/.test(pattern)) return false;
  const base = pattern.replace(/\*+/g, '*');
  if (base.match(/[*?[]/g)?.length > 6) return true;
  let src = '', depth = 0;
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    if (c === '*') src += '.*';
    else if (c === '?') src += '.';
    else if (c === '[') {
      const j = base.indexOf(']', i + 1);
      if (j === -1) src += '\\[';
      else { src += '.'; i = j; }
    } else if (c === '{') { src += '(?:'; depth++; }
    else if (c === '}' && depth > 0) { src += ')'; depth--; }
    else if (c === ',' && depth > 0) src += '|';
    else src += escapeRe(c);
  }
  let re;
  try { re = new RegExp('^' + src + '$', 'i'); } catch { return true; }
  return DB_NAME_SAMPLES.some((name) => re.test(name));
}

/** True when a token names a store database: its path components include `.sterling` and its basename is a
 *  database file, or a glob or brace pattern that can expand to one. A pattern that begins with `sterling`
 *  counts wherever the plain name would; any other pattern (`*`, `*.db`) counts only directly inside
 *  `.sterling/` or `.sterling/domains/<tag>/`, so `rm .sterling/transient/*` stays allowed. With `bare`, the
 *  plain name and a `sterling`-prefixed pattern count whatever directory the token names or omits. The value
 *  is read after a `name=` prefix (`of=`) or a PowerShell `-Name:` prefix. */
function isDbPath(token, bare) {
  let value = token.includes('=') ? token.slice(token.lastIndexOf('=') + 1) : token;
  const param = /^-\w+:(.+)$/.exec(value);
  if (param) value = param[1];
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  const named = bare || dirs.includes('.sterling');
  if (DB_FILE_RE.test(base)) return named;
  // The directory decides first, so a token that cannot be the store never reaches the glob test.
  const direct = dirs.at(-1) === '.sterling' || (dirs.at(-3) === '.sterling' && dirs.at(-2) === 'domains');
  if (!(base.toLowerCase().startsWith('sterling') ? named : direct)) return false;
  return globMatchesDbName(base);
}

/** Source of the pattern for raw text (SQL, a dot-command target) that names the store: a `.sterling/` path,
 *  and with `bare` a sterling.db file name too. */
const storeTextSource = (bare) => (bare ? '(?:\\.sterling[\\\\/]|sterling\\.db)' : '\\.sterling[\\\\/]');

/** True when a token's LAST path component is exactly the `.sterling` directory (case-insensitive — Windows). */
function isDotSterlingDir(token) {
  const parts = token.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 && parts[parts.length - 1].toLowerCase() === '.sterling';
}

const WRAPPERS_PLAIN = new Set(['command', 'time', 'exec', 'xargs', 'builtin', 'nohup']); // none of these take an option argument
// Shell grammar words that can stand before a command in a fragment (`then rm x`, `{ rm x`, `! rm x`).
const GRAMMAR_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!']);
const TIMEOUT_ARG_OPTS = new Set(['-k', '-s']);
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

/** Index of the destructive-verb candidate, skipping leading `VAR=val` assignments, shell grammar words and
 *  wrapper words (sudo, env, nice, timeout and its duration, ...). */
function skipWrappers(tokens) {
  let i = 0;
  if (tokens[i] && tokens[i].type === 'op' && tokens[i].value === '&') i++; // PowerShell call operator
  while (i < tokens.length && tokens[i].type === 'word') {
    const lv = tokens[i].value.toLowerCase();
    if (/^[A-Za-z_]\w*=/.test(tokens[i].value) || GRAMMAR_WORDS.has(lv)) { i++; continue; }
    if (lv === 'timeout') {
      i = skipOptsWithArgs(tokens, i + 1, TIMEOUT_ARG_OPTS);
      if (i < tokens.length && tokens[i].type === 'word') i++; // the duration
      continue;
    }
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
  'sc', 'ac', 'clc', 'ni', 'mi', 'cpi', 'rni', 'ren', // PowerShell aliases of the cmdlets above
]);
// Shells that run their `-c` (PowerShell: `-Command`) argument as a command line of its own.
const INNER_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell']);

// sqlite3 CLI options that consume N following tokens as their OWN value (checked against the CLI's
// documented flag list, not invented — no sqlite3 binary is installed on this machine to verify against).
// A `-readonly` token consumed as one of these values is not the read-only flag; the db still opens
// writable. Single-value: -cmd, -init, -maxsize, -mmap, -newline, -nullvalue, -separator, -vfs.
// Two-value: -lookaside, -pagecache.
const SQLITE3_VALUE_OPTS = new Map([
  ['-cmd', 1], ['-init', 1], ['-maxsize', 1], ['-mmap', 1], ['-newline', 1], ['-nullvalue', 1], ['-separator', 1], ['-vfs', 1],
  ['-lookaside', 2], ['-pagecache', 2],
]);

/** True when a bare `-readonly` token appears among `tokens[0, end)`, skipping the values consumed by any
 *  preceding sqlite3 option that takes its own argument(s) (SQLITE3_VALUE_OPTS) — so `-separator -readonly`
 *  does NOT count (the reader is `-readonly` used as -separator's value), but `-separator , -readonly` does. */
function sqlite3ReadonlyBefore(tokens, end) {
  let i = 0;
  while (i < end) {
    const t = tokens[i];
    if (t.type === 'word' && t.value === '-readonly') return true;
    if (t.type === 'word' && SQLITE3_VALUE_OPTS.has(t.value)) { i += 1 + SQLITE3_VALUE_OPTS.get(t.value); continue; }
    i++;
  }
  return false;
}

/** True when a `.output`/`.once`/`.backup`/`.save` dot-command's TARGET (not its mere presence, and not
 *  an earlier optional argument) names a `.sterling/` path — these CLI dot-commands write files at the
 *  client level regardless of -readonly, and independently of which db sqlite3 opened as its positional
 *  argument (`.backup`/`.save` can copy FROM an unprotected opened db INTO the store). `.backup`/`.save`
 *  take an optional DB-schema name BEFORE the file (`.backup main .sterling/sterling.db`), so the TARGET
 *  is the LAST whitespace/quote-separated argument on the dot-command's line, not the first — a schema
 *  name like `main` is never mistaken for the target. A target elsewhere (e.g. `.output /tmp/report`) is
 *  not a match. Scans the fragment's own SQL words and any heredoc bodies feeding this command. */
function sqlite3DotCommandTargetsStore(words, heredocBodies, bare) {
  const store = new RegExp(storeTextSource(bare), 'i');
  const text = words.join('\n') + '\n' + heredocBodies.join('\n');
  const re = /\.(?:output|once|backup|save)\b([^\n;]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    const args = m[1].trim().match(/'[^']*'|"[^"]*"|\S+/g);
    if (!args || args.length === 0) continue;
    const target = args[args.length - 1].replace(/^['"]|['"]$/g, '');
    if (store.test(target)) return true;
  }
  return false;
}

/** True when the fragment's SQL text (its own quoted words, plus any heredoc bodies feeding this command)
 *  contains VACUUM [SCHEMA] INTO or ATTACH naming a `.sterling/` path — raw text, scoped to the statement
 *  (up to the next `;`) it appears in, checked for EVERY sqlite3 invocation regardless of its positional
 *  db (ATTACH opens a SECOND db, unrelated to whichever db sqlite3 was invoked against). VACUUM INTO
 *  creates a NEW file rather than writing the opened db, so -readonly's OS-level read-only open does not
 *  stop it; ATTACH opens that second db read-write by default regardless of -readonly on the primary
 *  connection. A plain VACUUM (no INTO) is not matched — -readonly already blocks it at the OS level,
 *  since it writes the opened db in place. */
function sqlite3VacuumOrAttachTargetsStore(words, heredocBodies, bare) {
  const text = words.join(' ') + ' ' + heredocBodies.join(' ');
  const store = storeTextSource(bare);
  return new RegExp('vacuum\\s+(?:\\w+\\s+)?into\\b[^;]*' + store, 'i').test(text) || new RegExp('\\battach\\b[^;]*' + store, 'i').test(text);
}

/** True when a fragment's tokens show a destructive shape aimed at the store database. `heredocBodies` are
 *  this COMMAND's excised heredoc bodies (see stripHeredocBodies) — scanned only for the sqlite3 VACUUM
 *  INTO / ATTACH check above, since a heredoc-fed script never appears in any fragment's own tokens. */
function isDestructiveFragment(tokens, heredocBodies, o) {
  const dbPath = (token) => isDbPath(token, o.bare);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'op' && /^\d*(>>|>\||&>|>)$/.test(t.value)) {
      const next = tokens[i + 1];
      if (next && next.type === 'word' && dbPath(next.value)) return true;
    }
  }
  const idx0 = skipWrappers(tokens);
  const verb = tokens[idx0];
  if (!verb || verb.type !== 'word') return false;
  // bare only: a resource that IS a database path (a redirect target delivered apart from its command).
  if (o.bare && !verb.value.includes('=') && dbPath(verb.value)) return true;
  // The verb by its file name, so `/bin/rm` and `rm.exe` are `rm`.
  const lv = verb.value.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
  const rest = tokens.slice(idx0 + 1);
  const restWords = rest.filter((t) => t.type === 'word').map((t) => t.value);

  // A command line handed to an inner shell or to eval is read by this same parser.
  if (INNER_SHELLS.has(lv)) {
    const at = rest.findIndex((t) => t.type === 'word' && (/^-[a-z]*c$/.test(t.value) || /^-command$/i.test(t.value)));
    const inner = at === -1 ? undefined : rest[at + 1];
    if (inner && inner.type === 'word' && writeShape(inner.value, o)) return true;
  }
  if (lv === 'eval' && writeShape(restWords.join(' '), o)) return true;

  if (lv === 'sqlite3') {
    // user-ruled 2026-09-22 ("Yes, allow reads"): `sqlite3 -readonly <db> ...` is allowed — the
    // flag decides, H15 does not parse SQL. `-readonly` must appear before the db-path argument
    // (sqlite3 reads flags left of its positional args) and survive SQLITE3_VALUE_OPTS arity
    // (skipWrappers-style); `--readonly` is not recognized because this rebuild does not invent
    // CLI support that hasn't been checked against a real binary. Checked for EVERY sqlite3
    // invocation, whatever its positional db (an ATTACH or a dot-command target names ITS OWN
    // path, unrelated to the db sqlite3 opened): a dot-command TARGETING a `.sterling/` path
    // (sqlite3DotCommandTargetsStore) and a SQL/heredoc VACUUM INTO or ATTACH naming a `.sterling/`
    // path (sqlite3VacuumOrAttachTargetsStore) — -readonly's OS-level protection does not cover
    // either. Only past both of those does the -readonly-before-the-db-path check decide.
    if (sqlite3DotCommandTargetsStore(restWords, heredocBodies, o.bare)) return true;
    if (sqlite3VacuumOrAttachTargetsStore(restWords, heredocBodies, o.bare)) return true;
    const dbIdx = rest.findIndex((t) => t.type === 'word' && dbPath(t.value));
    if (dbIdx !== -1) {
      const readonly = sqlite3ReadonlyBefore(rest, dbIdx);
      if (!readonly) return true;
      // bare only: a heredoc operator whose body this text does not carry cannot be scanned for ATTACH / VACUUM INTO.
      if (o.bare && heredocBodies.length === 0 && rest.some((t) => t.type === 'op' && /^\d*<<$/.test(t.value))) return true;
    }
  } else if (DESTRUCTIVE_VERBS.has(lv) && restWords.some(dbPath)) return true;
  if ((lv === 'sed' || lv === 'perl') && restWords.some((w) => /^-\S*i\S*$/.test(w)) && restWords.some(dbPath)) return true;
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


/** True when `command` holds one of the destructive shapes aimed at the store database (the H15 INVARIANT).
 *  `powershell`: backslash is a path separator, not an escape character. `bareDbName`: a database file name
 *  counts as the store without a `.sterling` component — for a host that hands over commands with the working
 *  directory already stripped (OpenCode drops a leading `cd`); it also denies a resource that is itself a
 *  database path and a `sqlite3 -readonly` heredoc whose body is absent. Throws (RangeError) on input nested
 *  too deep to parse; a caller treats a throw as a deny. */
export function storeShellWriteShape(command, { powershell = false, bareDbName = false } = {}) {
  return writeShape(command, { ps: powershell, bare: bareDbName });
}

function writeShape(command, o) {
  const heredocBodies = [];
  const fragments = splitTopLevel(stripHeredocBodies(command, heredocBodies, o), o);
  return fragments.some((fragment) => isDestructiveFragment(tokenizeFragment(fragment, o), heredocBodies, o));
}
