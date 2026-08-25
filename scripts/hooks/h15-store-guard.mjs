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
//
// PRECISION HARDENING (board 6051f202-fafd-4ef8-8360-74fa0cd8153d): two
// false-positive classes fixed without moving the allow surface.
//   (A) `git` global flags (-C <path>, -c <k=v>, --git-dir/--work-tree/
//       --namespace, --no-pager, -p/-P/--paginate, --no-optional-locks) are
//       skipped before extracting the sub-verb, so `git -C <path> log ...`
//       reads sub-verb "log" instead of falling through to the substring
//       fallback on an unrelated store mention.
//   (B) a redirection is a store write only when its TARGET names a store
//       path — (3) above means "INTO .sterling/", not "any '>' on a line
//       that also names a store path"; an outward redirect on a store READ
//       (`grep foo .sterling/x.json > /tmp/out`, `cat ... 2>/dev/null`) is
//       still a read.
//
// ADVERSARIAL REVIEW ROUND 1 (scripts/tests/h15-precision-adversarial.test.mjs
// ADV-1/2/3): a skipped git global-flag VALUE naming the store now denies
// regardless of the subverb (config-injection / redirected-git-dir gadgets);
// a redirect target must be ONE statically-parseable plain word
// ([A-Za-z0-9_./~+-]) or the gate fails closed (command substitution,
// ${VAR} expansion, backticks); a quote-concatenated redirect target
// (`.st''erling/x`) is checked against the quote-stripped text so splicing
// two unquoted runs across an empty quote cannot dodge the store pattern.
//
// ADVERSARIAL REVIEW ROUND 2 (ADV-4/5/6, same file): a LONE `&` is now a
// fragment separator like `;`/`&&` (was previously swallowed into the
// current fragment, letting a read-only first word launder a later
// `&`-backgrounded write — CLOSED); `sed`'s in-place detector now also
// matches the GNU long form `--in-place`/`--in-place=SUFFIX`, not just `-i`
// clusters (CLOSED); `awk` was REMOVED from the unconditional-read-only verb
// set because its own `print > "path"` redirection and `system(...)` call
// are invisible to the shell-level redirect scan — a store-mentioning awk
// fragment now fails closed by default, including a legitimate awk READ of
// a store file (ACCEPTED COST, not a bug — grep/cat are the sanctioned shell
// read path for store files; see ADV-6c).
//
// DISCLOSED, ACCEPTED GAP (not closed — scope-discipline posture, decision
// d53fc7ba: state a known limitation honestly rather than chase it past the
// point of diminishing return): the whitespace-token flag/value tokenizer
// used for git global flags (skipGitGlobalFlags) splits on bare `\s+` and
// does not understand shell quoting WITHIN a flag's value — a value crafted
// as `git -c key="a value"` or `-c key='.sterling/x'` is not re-parsed as a
// single quoted token before the STORE_MENTION_RE check, so a quoted,
// space-containing -c/-C/--git-dir/--work-tree value is a residual blind
// spot the fixes above do not cover. Named here rather than silently
// carried, per the same "disclose limitations, don't bury them" rule that
// produced d53fc7ba for H14.
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

// DB_MENTION_RE seals sterling.db to shell for every verb (AC5). Kept
// DELIBERATELY UNANCHORED. An anchored variant (board 3edfb9fd, to stop the
// `notsterling.db`/`mysterling.db` false-POSITIVE) was built and REVERTED
// 2026-08-25: two independent reviewers (roster-security + Codex outside-
// family) showed a boundary-char whitelist opens a false-ALLOW read-exfil —
// `cat *sterling.db`, `grep --file=sterling.db`, `${unused:-sterling.db}` —
// because the char preceding the mention in raw text need not be its runtime
// path delimiter (shell expansion). No raw-text regex closes that; it is the
// shell-tokenizer wall the store guard has parked twice (decision
// h15-shell-tokenizer-attempt-parked-again). Over-sealing an unrelated
// `notsterling.db` is accepted friction until the tokenizer question is
// solved; a read-exfil hole is not. See board 3edfb9fd.
const DB_MENTION_RE = /sterling\.db/i;

// A quote-concatenated store path (`.st''erling/config.json`) never contains
// the bare substring ".sterling" in the raw text, so it must also be checked
// against the quote-stripped (unquotedText) form before bailing early — a
// false "no mention anywhere" here would silently void every check below
// (adversarial regression 3 / FIX C). unquotedText is a hoisted function
// declaration, safe to call ahead of its textual definition.
if (!STORE_MENTION_RE.test(command) && !STORE_MENTION_RE.test(unquotedText(command))) allow(); // no store path anywhere in the command — irrelevant

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
    // FIX D: a LONE `&` backgrounds the preceding command and is a fragment
    // separator exactly like `;` — `ls /tmp/x & rm -rf .sterling` must not
    // ride the whole line through as one fragment keyed off `ls`. Two
    // redirect shapes use `&` without separating anything and must NOT
    // split: `&>`/`&>>` (combined stdout+stderr redirect) and `>&N`/`N>&N`
    // (fd duplication, e.g. `2>&1`) — recognized by looking at the next
    // char and the last char already appended to `current`, respectively.
    if (c === '&') {
      const prevChar = current.length ? current[current.length - 1] : '';
      if (cmd[i + 1] === '>' || prevChar === '>') {
        current += c;
        continue;
      }
      parts.push(current);
      current = '';
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
//
// FIX F: `awk` REMOVED (was here) — it is only CONDITIONALLY read-only, same
// class of hole as git/find above, but the redirect scan cannot see inside
// it: `awk '{print > ".sterling/x"}'` writes via the awk program's OWN `>`,
// entirely inside a quoted argument the shell-level redirect check never
// evaluates, and `awk 'BEGIN{system("rm ...")}'` shells out directly. A
// store-mentioning awk fragment now falls to the default "unknown verb: err
// CLOSED" branch below — see the accepted-cost note at ADV-6c in
// scripts/tests/h15-precision-adversarial.test.mjs: this also fail-closes a
// legitimate awk READ of a store file, deliberately; grep/cat remain the
// sanctioned shell read path for store files.
const READONLY_VERBS = new Set([
  'grep', 'egrep', 'fgrep', 'zgrep', 'rgrep',
  'ls', 'cat', 'head', 'tail', 'wc',
  'diff', 'file', 'stat', 'less', 'more', 'tree', 'du', 'od', 'xxd', 'hexdump',
]);

// git sub-verbs that only inspect state.
const GIT_READONLY_SUBVERBS = new Set([
  'log', 'show', 'diff', 'grep', 'ls-files', 'branch', 'cat-file', 'status', 'rev-parse',
]);

// git sub-verbs that rewrite/delete working-tree files — always a write when
// the fragment names a store path, regardless of quoting.
// `mv` renames/moves a tracked file (board 682ce7fc): `git mv .sterling/x
// elsewhere` (or the reverse) moves a store path exactly like a raw shell
// `mv`, and without it here the fragment fell through to the "unrecognized
// git sub-verb" branch, which only denies when the store path is a genuine
// UNQUOTED argument to the git invocation itself — the escape a git-mv gap
// would otherwise open.
const GIT_WRITE_SUBVERBS = new Set(['checkout', 'restore', 'clean', 'rm', 'stash', 'mv']);

// git GLOBAL flags precede the sub-verb and must be skipped before extracting
// it — `git -C <path> log ...` reads sub-verb "log", not "-C". Without this,
// a global flag hides the real sub-verb from classifyGit, which falls to the
// substring fallback below and can deny a read-only invocation over an
// unrelated store mention elsewhere in the command (e.g. a `sterling/*`
// branch name in a log/diff range: "main..sterling/foo" contains the literal
// substring ".sterling/" purely from the ".." before the branch name).
// Value-taking: -C <path>, -c <k=v>, --git-dir/--work-tree/--namespace
// (space form or "=value"). Bare (no value): --no-pager, -p/-P/--paginate,
// --no-optional-locks.
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_GLOBAL_BARE_FLAGS = new Set(['--no-pager', '-p', '-P', '--paginate', '--no-optional-locks']);

// FIX A (adversarial regressions 1-2): skipping past a global flag's VALUE
// to find the real sub-verb must not also skip past what that VALUE names.
// `git -c core.fsmonitor=.sterling/writer status` and `git -C <path>/.sterling
// status` both use a read-only-looking subverb to smuggle a store path
// through in a flag VALUE (a git-config-injection / redirected-git-dir
// gadget) — every skipped value is tested against STORE_MENTION_RE, and the
// first one that matches is returned so the caller can deny regardless of
// the subverb behind it. Benign values (an ordinary git config key, a
// project-root path) still fall through to normal subverb classification.
function skipGitGlobalFlags(argsText) {
  let s = argsText;
  let flaggedStoreValue = null;
  for (;;) {
    const m = s.match(/^\s*(\S+)/);
    if (!m) break;
    const token = m[1];
    const eq = token.indexOf('=');
    const flagName = eq >= 0 ? token.slice(0, eq) : token;
    if (GIT_GLOBAL_VALUE_FLAGS.has(flagName)) {
      s = s.slice(m[0].length);
      let value;
      if (eq >= 0) {
        // "=value" form: --git-dir=.sterling/repo, --work-tree=.sterling/x
        value = token.slice(eq + 1);
      } else {
        // space form: the value is the NEXT token (-C <path>, -c k=v).
        const v = s.match(/^\s*(\S+)/);
        value = v ? v[1] : '';
        if (v) s = s.slice(v[0].length);
      }
      if (!flaggedStoreValue && STORE_MENTION_RE.test(value)) flaggedStoreValue = value;
      continue;
    }
    if (GIT_GLOBAL_BARE_FLAGS.has(flagName)) {
      s = s.slice(m[0].length);
      continue;
    }
    break; // first non-global-flag token is the sub-verb
  }
  return { rest: s, flaggedStoreValue };
}

function classifyGit(trimmed) {
  const m = trimmed.match(/^git\s+(.*)$/i);
  const { rest, flaggedStoreValue } = m ? skipGitGlobalFlags(m[1]) : { rest: '', flaggedStoreValue: null };
  // A skipped global-flag VALUE naming the store is a write regardless of
  // how read-only the subverb behind it looks (FIX A).
  if (flaggedStoreValue) return true;
  const sm = rest.match(/^\s*(\S+)/);
  const subverb = sm ? sm[1].toLowerCase() : '';
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

// Decision 0b4d3c8c denies redirections INTO the store, not every redirection
// that merely appears on a line naming a store path — a store READ with an
// outward redirect (`grep foo .sterling/x.json > /tmp/out`, `cat
// .sterling/config.json 2>/dev/null`) is a read, not a write. So this checks
// each UNQUOTED output-redirect operator's TARGET, not just whether a '>'
// exists. A '>' inside quotes or a heredoc body is prose/data, never a shell
// redirect (unquotedText already strips both).
//
// Operator forms recognized: >, >>, and fd-prefixed/combined forms (2>,
// 2>>, &>, &>>). A target of the form `&<digits>` (>&2, 2>&1) is an fd
// DUPLICATION, not a filesystem path, and is never a store write. Any other
// target is checked against STORE_MENTION_RE.
//
// Conservative on ambiguity (fail-closed, per this file's own posture): a
// trailing redirect operator with no following token cannot be tokenized as
// a target, so it is treated as a write.
//
// FIX B (adversarial regression 3): the target must be ONE statically-
// parseable plain word — [A-Za-z0-9_./~+-], after quote-stripping (which
// unquotedText already applied to `str` above, so a quote-concatenated
// target has already been reassembled here; see FIX C). Anything else — a
// command substitution ($(...) or `...`), an unresolved shell variable
// expansion (${VAR}), or any other shell metacharacter in the token — is a
// target the gate cannot evaluate without actually running the shell, so it
// FAILS CLOSED (deny) rather than default-allowing just because the literal
// text lacks a recognizable ".sterling/" plain-word substring.
const PLAIN_WORD_RE = /^[A-Za-z0-9_./~+-]+$/;

function redirectsIntoStore(str) {
  const text = unquotedText(str);
  const RE = /(?:[0-9]+|&)?(>>|>)(\s*)(\S+)?/g;
  let m;
  while ((m = RE.exec(text))) {
    const target = m[3];
    if (target === undefined) return true; // unparseable target — fail closed
    if (/^&[0-9]+$/.test(target)) continue; // fd duplication, not a path
    if (!PLAIN_WORD_RE.test(target)) return true; // unparseable target — fail closed
    if (STORE_MENTION_RE.test(target)) return true;
  }
  return false;
}

// Classify a single fragment: { write: boolean, fragment }. A fragment that
// never mentions the store is irrelevant (write: false) regardless of verb.
function classifyFragment(fragment) {
  const trimmed = fragment.trim();
  // Same quote-concatenation hazard as the top-level early-allow (FIX C): a
  // fragment retains its quotes, so ".st''erling/config.json" never contains
  // the bare substring ".sterling" in the raw text — check the quote-stripped
  // form too before declaring the fragment irrelevant.
  if (!trimmed || (!STORE_MENTION_RE.test(trimmed) && !STORE_MENTION_RE.test(unquotedText(trimmed)))) {
    return { write: false, fragment: trimmed };
  }

  // AC5: sterling.db is sealed to shell for EVERY verb, reads included.
  if (DB_MENTION_RE.test(trimmed)) return { write: true, fragment: trimmed };

  // (a) an unquoted output-redirect operator whose TARGET names a store path
  // — a redirect INTO the store — is a write regardless of verb. A redirect
  // present but targeting elsewhere (/dev/null, /tmp/out.txt, an fd
  // duplication) is not; the fragment falls through to verb classification.
  if (redirectsIntoStore(trimmed)) return { write: true, fragment: trimmed };

  const verb = firstWord(trimmed);

  // sed is only mutating in-place (-i / GNU long-form --in-place[=SUFFIX]);
  // otherwise it is a read filter that prints to stdout (FIX E).
  if (verb === 'sed') {
    if (/(^|\s)-\w*i\w*(\s|=|$)/.test(trimmed) || /(^|\s)--in-place(=\S*)?(\s|$)/.test(trimmed)) {
      return { write: true, fragment: trimmed };
    }
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
