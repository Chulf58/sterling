// H15 — store write-path guard (spec §6 H15). PreToolUse Bash|PowerShell,
// BLOCKING. The store is written through the §10 MCP tool surface ONLY; the
// deny message teaches the right path. Patterns grow incident-by-incident via
// config, never speculatively (adjudicated 2026-06-12 after a live conductor
// bypass). Deliberately store-free: the guard must run even when the store is
// exactly what is being protected.
//
// WRITE-PRECISION (decision 0b4d3c8c, 2026-08-20, superseding 7c0bf504's
// deny-any-mention breadth): the gate now judges each fragment of a compound
// command by what it actually DOES to the store, not by whether it merely
// NAMES a store path.
//   (1) a read-only command on a non-DB store file (config.json, transient/*)
//       is ALLOWED — git log/grep/ls/cat naming such a path is a read, not an
//       out-of-band write.
//   (2) .sterling/sterling.db is SEALED for EVERY verb, reads included — DB
//       access is the MCP surface's job, never raw shell (cat/sqlite3 SELECT
//       stay denied).
//   (3) writes, redirections, and moves/copies INTO .sterling/ stay denied
//       exactly as before.
//   (4) a compound command is denied only when a fragment writes; the denial
//       NAMES the offending fragment (refusal-quality rule d0b88e27).
//   (5) fail-closed on an unparseable config is unchanged — the gate cannot
//       safely evaluate the read/write split without it.
// When a verb's mutability is unclear, the gate errs CLOSED (deny) — the
// allow surface only grows for verbs this file explicitly recognizes as
// read-only, exactly the "grow incident-by-incident" posture above.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, loadConfig, environmentDefectDenial } from './lib/common.mjs';
import { parseConfig } from '@sterling/schemas';

const input = readStdin();
if (!input.cwd || !existsSync(join(input.cwd, '.sterling'))) allow(); // not a Sterling project — no ceremony (P1)

const command = String(input.tool_input?.command ?? '');

// Bare `.sterling` (rm -rf/mv/tar of the whole store dir) must trip this gate
// too; the lookahead keeps suffixed names (.sterling-backups, .sterling2) out
// of it.
const STORE_MENTION_RE = /\.sterling(?![\w.-])|sterling\.db/i;
const DB_MENTION_RE = /sterling\.db/i;

if (!STORE_MENTION_RE.test(command)) allow(); // no store path anywhere in the command — irrelevant

// a malformed config must fail CLOSED on the protected branch — an uncaught
// throw exits non-2, which the platform treats as non-blocking (a voided gate)
let allowScripts;
try {
  allowScripts = parseConfig(loadConfig(input.cwd) ?? {}).store_guard.allow_scripts;
} catch (e) {
  deny(
    environmentDefectDenial('H15', `Store access denied — .sterling/config.json is unreadable (${e.message}); fix the config, the gate fails closed.`, {
      agentId: input.agent_id,
    })
  );
}

// Split on shell control operators so each fragment is judged independently
// (AC3). Quote-aware so an operator character inside a quoted argument (a SQL
// string, a commit message) never fractures the command wrongly.
function splitFragments(cmd) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      current += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += c;
      if (c === '"' && cmd[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      current += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      current += c;
      continue;
    }
    // A heredoc body is DATA, not commands: on an unquoted '<<DELIM', consume
    // everything through the terminator line into the SAME fragment, so a body
    // line mentioning the store is judged as part of its command (a git commit
    // message), never as a fragment whose first word is prose.
    if (c === '<' && cmd[i + 1] === '<') {
      const m = cmd.slice(i + 2).match(/^[-~]?\s*(?:"([^"]+)"|'([^']+)'|(\w+))/);
      const delim = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (delim) {
        // The delimiter is untrusted command text: escape regex metachars
        // before interpolating it into `new RegExp` (a delimiter like "A(B"
        // otherwise throws, which — uncaught — exits non-2 and silently
        // VOIDS this blocking gate; see the outer try/catch below).
        const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = cmd.slice(i);
        const end = rest.match(new RegExp(`\\n\\s*${escapedDelim}(?=\\n|$)`));
        const span = end ? end.index + end[0].length : rest.length;
        current += rest.slice(0, span);
        i += span - 1;
        continue;
      }
    }
    // Unquoted newlines separate commands exactly like ';' — caught live
    // 2026-08-20 minutes after this gate shipped: a multiline commit batch was
    // judged as ONE fragment whose first word was 'set', denying the whole
    // batch over a store mention inside a later fragment's quoted message.
    if (c === '\n' || c === '\r') {
      parts.push(current);
      current = '';
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|' && cmd[i + 1] === '|') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Blanket "mutating verbs" set is DEAD CODE: every verb it named (rm, mv, cp,
// tee, truncate, dd, chmod, chown, rsync, ln, unlink, patch, shred, install,
// mkfifo, …) is already absent from READONLY_VERBS below, so the default-deny
// "unknown verb mentioning the store: err CLOSED" branch already denies every
// one of them without a separate list to maintain in sync. Intent preserved
// here rather than in a set: those verbs mutate their target and must never
// be added to READONLY_VERBS.

// Verbs known to be read-only against whatever path they are given,
// UNCONDITIONALLY. `git` and `find` are deliberately NOT here — both are only
// CONDITIONALLY read-only (see classifyGit/classifyFind below); folding them
// into this blanket set is exactly the hole an independent review found (a
// git checkout/clean/restore or a find -delete previously passed as "git"/
// "find" being on this list, with no sub-verb/flag check at all).
const READONLY_VERBS = new Set([
  'grep', 'egrep', 'fgrep', 'zgrep', 'rgrep',
  'ls', 'cat', 'head', 'tail', 'wc', 'awk',
  'diff', 'file', 'stat', 'less', 'more', 'tree', 'du', 'od', 'xxd', 'hexdump',
]);

// git sub-verbs that only inspect state.
const GIT_READONLY_SUBVERBS = new Set([
  'log', 'show', 'diff', 'grep', 'ls-files', 'branch', 'cat-file', 'status', 'rev-parse',
]);

// git sub-verbs that rewrite/delete working-tree files — always a write when
// the fragment names a store path, regardless of quoting.
const GIT_WRITE_SUBVERBS = new Set(['checkout', 'restore', 'clean', 'rm', 'stash']);

function classifyGit(trimmed) {
  const m = trimmed.match(/^git\s+(\S+)/i);
  const subverb = m ? m[1].toLowerCase() : '';
  if (GIT_READONLY_SUBVERBS.has(subverb)) return false;
  if (GIT_WRITE_SUBVERBS.has(subverb)) return true;
  // An unrecognized sub-verb (commit, add, push, merge, …) is a write ONLY
  // when it carries the store path as a genuine (unquoted) argument — a
  // store mention inside quoted prose (e.g. a commit message body) is not an
  // out-of-band write against the store; err CLOSED only on a real argument.
  return STORE_MENTION_RE.test(unquotedText(trimmed));
}

// find is only read-only WITHOUT a flag that lets it act on matches directly;
// -delete/-exec/-execdir/-ok/-fdelete all mutate the store in place.
const FIND_MUTATING_FLAGS_RE = /(^|\s)-(delete|fdelete|execdir|exec|ok)\b/;

function classifyFind(trimmed) {
  return FIND_MUTATING_FLAGS_RE.test(trimmed); // write only when a mutating flag is present
}

function firstWord(fragment) {
  const m = fragment.match(/^\s*(\S+)/);
  return m ? m[1].toLowerCase() : '';
}

// Concatenation of a fragment's UNQUOTED, NON-HEREDOC-BODY characters only —
// a single- or double-quoted span (a commit message, a SQL string) AND a
// heredoc body (`git commit -F - <<EOF` … `EOF`) are DATA, not shell syntax
// or a genuine path argument, and must never be read as either.
function unquotedText(str) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && str[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '<' && str[i + 1] === '<') {
      const m = str.slice(i + 2).match(/^[-~]?\s*(?:"([^"]+)"|'([^']+)'|(\w+))/);
      const delim = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (delim) {
        const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = str.slice(i);
        const end = rest.match(new RegExp(`\\n\\s*${escapedDelim}(?=\\n|$)`));
        const span = end ? end.index + end[0].length : rest.length;
        i += span - 1; // skip the whole heredoc (marker + body + terminator) — DATA
        continue;
      }
    }
    out += c;
  }
  return out;
}

// A '>' inside quotes is prose/data, not a shell redirection.
function hasUnquotedRedirect(str) {
  return unquotedText(str).includes('>');
}

// Classify a single fragment: { write: boolean, fragment }. A fragment that
// never mentions the store is irrelevant (write: false) regardless of verb.
function classifyFragment(fragment) {
  const trimmed = fragment.trim();
  if (!trimmed || !STORE_MENTION_RE.test(trimmed)) return { write: false, fragment: trimmed };

  // AC5: sterling.db is sealed to shell for EVERY verb, reads included.
  if (DB_MENTION_RE.test(trimmed)) return { write: true, fragment: trimmed };

  // (a) output redirection alongside a store mention in the same fragment —
  // treat as targeting the store; redirection is a write regardless of verb.
  // Only an UNQUOTED '>' counts — one inside quotes is prose/data, not a
  // shell redirect.
  if (hasUnquotedRedirect(trimmed)) return { write: true, fragment: trimmed };

  const verb = firstWord(trimmed);

  // sed is only mutating in-place (-i); otherwise it is a read filter.
  if (verb === 'sed') {
    if (/(^|\s)-\w*i\w*(\s|=|$)/.test(trimmed)) return { write: true, fragment: trimmed };
    return { write: false, fragment: trimmed };
  }

  if (verb === 'git') return { write: classifyGit(trimmed), fragment: trimmed };
  if (verb === 'find') return { write: classifyFind(trimmed), fragment: trimmed };

  if (READONLY_VERBS.has(verb)) return { write: false, fragment: trimmed };

  // Unknown verb mentioning the store: err CLOSED (in doubt, deny).
  return { write: true, fragment: trimmed };
}

let offending = null;
try {
  for (const frag of splitFragments(command)) {
    // The sanctioned-script escape is judged PER FRAGMENT (AC-E): a sanctioned
    // script elsewhere in a compound command must never launder a writing
    // fragment alongside it (`node scripts/x.mjs && rm .sterling/…` still
    // denies, naming the rm fragment).
    if (allowScripts.some((s) => frag.includes(s))) continue;
    const result = classifyFragment(frag);
    if (result.write) {
      offending = result.fragment;
      break;
    }
  }
} catch (e) {
  // This gate BLOCKS by exit code; an uncaught throw here would exit non-2,
  // which the platform treats as non-blocking — a silently VOIDED gate (the
  // F5 fail-open class, anti_pattern e13f0fb5). Any unexpected internal error
  // during evaluation must deny, not disappear.
  deny(
    environmentDefectDenial(
      'H15',
      `Internal error while evaluating shell command safety (${e.message}); the gate fails closed rather than risk a silent void.`,
      { agentId: input.agent_id }
    )
  );
}
if (!offending) allow();

deny(
  'H15: shell write access to the Sterling store is denied — the store is read and written through the §10 MCP tool surface ONLY.\n' +
    `Denied fragment: ${offending}\n` +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
    `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts).\n` +
    ".sterling/sterling.db is sealed to shell access for EVERY verb, reads included — DB access is the MCP tool surface's job, never raw shell.\n" +
    'Non-DB store files (config.json, transient/*) ARE shell-readable (decision 0b4d3c8c) — only writes, redirections, and moves/copies INTO .sterling/ are denied.\n' +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
);
