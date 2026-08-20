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
import { readStdin, deny, allow, loadConfig } from './lib/common.mjs';
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
  deny(`H15: store access denied — .sterling/config.json is unreadable (${e.message}); fix the config, the gate fails closed.`);
}
if (allowScripts.some((s) => command.includes(s))) allow();

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

// Verbs known to mutate their target arguments (rm/mv/cp/tee/truncate/… —
// "sed -i" is handled separately since sed is only mutating with -i).
const MUTATING_VERBS = new Set([
  'rm', 'mv', 'cp', 'tee', 'truncate', 'dd', 'chmod', 'chown',
  'rsync', 'ln', 'unlink', 'patch', 'shred', 'install', 'mkfifo',
]);

// Verbs known to be read-only against whatever path they are given.
const READONLY_VERBS = new Set([
  'git', 'grep', 'egrep', 'fgrep', 'zgrep', 'rgrep',
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'awk',
  'diff', 'file', 'stat', 'less', 'more', 'tree', 'du', 'od', 'xxd', 'hexdump',
]);

function firstWord(fragment) {
  const m = fragment.match(/^\s*(\S+)/);
  return m ? m[1].toLowerCase() : '';
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
  if (/>/.test(trimmed)) return { write: true, fragment: trimmed };

  const verb = firstWord(trimmed);

  // sed is only mutating in-place (-i); otherwise it is a read filter.
  if (verb === 'sed') {
    if (/(^|\s)-\w*i\w*(\s|=|$)/.test(trimmed)) return { write: true, fragment: trimmed };
    return { write: false, fragment: trimmed };
  }

  if (MUTATING_VERBS.has(verb)) return { write: true, fragment: trimmed };
  if (READONLY_VERBS.has(verb)) return { write: false, fragment: trimmed };

  // Unknown verb mentioning the store: err CLOSED (in doubt, deny).
  return { write: true, fragment: trimmed };
}

let offending = null;
for (const frag of splitFragments(command)) {
  const result = classifyFragment(frag);
  if (result.write) {
    offending = result.fragment;
    break;
  }
}
if (!offending) allow();

deny(
  'H15: shell write access to the Sterling store is denied — the store is read and written through the §10 MCP tool surface ONLY.\n' +
    `Denied fragment: ${offending}\n` +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / maintenance_enqueue / run_signal / agent_exit.\n' +
    `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts).\n` +
    ".sterling/sterling.db is sealed to shell access for EVERY verb, reads included — DB access is the MCP tool surface's job, never raw shell.\n" +
    'Non-DB store files (config.json, transient/*) ARE shell-readable (decision 0b4d3c8c) — only writes, redirections, and moves/copies INTO .sterling/ are denied.\n' +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
);
