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

// THE INPUT BOUNDARY IS ITSELF A GATE — same F5 class as the preprocessing
// wrap below (board 01afa03e; the fix H17 already carries for its own
// readStdin). readStdin() reads fd 0 and JSON.parses it, both unguarded:
// called bare at the top level, a truncated or non-JSON stdin threw OUT of the
// hook, Node exited 1, and exit 1 is the platform's NON-BLOCKING code — the
// runner reads it as ALLOW and the command runs unexamined. A gate that cannot
// read its own input has verified NOTHING and must fail CLOSED (P5).
//
// EXPLICITLY ACCEPTED AVAILABILITY TRADEOFF (outside-family review 2026-08-26,
// conductor-accepted): H15 is GLOBALLY registered, so this denial reaches the
// conductor's own Bash too. A persistent runner/input fault therefore blocks
// the repair commands as well, and the session can wedge until restart. That
// is accepted deliberately — under broken infrastructure the alternative is a
// store guard that silently passes every command it never read — but it is an
// availability cost, not a free win, and it is recorded here rather than
// discovered later.
//
// AND THE COST IS WIDER THAN "THIS PROJECT" (roster review 2026-08-27): this
// catch sits ABOVE the `if (!inSterlingProject) allow()` branch below, because
// the project is unknowable before the input parses. So a broken runner denies
// Bash in EVERY project on the machine, not only Sterling ones. That ordering
// is forced — the probe needs `input.cwd` — but the blast radius is the whole
// machine, and stating it as "the conductor's own Bash" would understate it.
//
// AUDIENCE IS UNKNOWABLE ON THIS PATH, which is why the wording carries BOTH
// resolutions: the field that names the audience (`agent_id`) rides in the very
// input that failed to parse. `agentId: undefined` selects the repair-facing
// instruction (correct for the conductor, who has no one above to escalate to)
// and the detail states the agent-facing half explicitly, so a spawned agent is
// never told to "let the conductor fix it" when it may BE the conductor reading.
let input;
try {
  input = readStdin();
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `[stdin] hook input could not be read or parsed (${(e && e.message) || e}) — a gate that cannot read its own input has verified nothing, so it fails CLOSED (P5). ` +
        `An uncaught throw here would exit non-2, which the hook runner treats as NON-BLOCKING (the command would be ALLOWED unexamined). ` +
        `IF YOU ARE A SPAWNED AGENT: do not diagnose, repair, or retry H15 yourself — exit \`blocked\`, citing this message VERBATIM. Otherwise:`,
      { agentId: undefined }
    )
  );
}

// The project probe is INSIDE the boundary too (outside-family review finding,
// same F5 class as the wraps above and below). `join()` throws a TypeError on a
// non-string cwd — parsed JSON carrying `cwd: ["/x"]` survives readStdin's
// normalization unchanged and reaches here — and that throw would exit non-2,
// allowing the command unexamined. Ordinary platform input always carries a
// string cwd, so this is an invariant repair rather than a demonstrated
// command-controlled bypass: the rule this file's own roster sweep established
// is that EVERY statement before the deny decision sits inside the boundary,
// and the hook that established it must not be the one violating it.
let inSterlingProject;
try {
  inSterlingProject = Boolean(input.cwd) && existsSync(join(input.cwd, '.sterling'));
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `[cwd] the hook input's cwd could not be resolved to a project path (${(e && e.message) || e}); the gate fails closed rather than risk a silent void.`,
      // OPTIONAL CHAIN, not decoration: a fail-closed HANDLER that can itself
      // throw exits non-2 and voids the gate (the F5 class this file exists to
      // avoid). MEASURED 2026-08-27: no reachable input lands here with a
      // non-object `input` — stdin `null` throws inside readStdin's own
      // `projectRoot(input.cwd)` and is caught above, and a primitive/array
      // input yields `undefined` cwd, which takes the not-a-Sterling-project
      // allow branch without ever throwing. So this is belt-and-braces on an
      // unreachable path, kept because the cost is one character and the
      // failure mode it forecloses is a silently voided blocking gate.
      { agentId: input?.agent_id }
    )
  );
}
if (!inSterlingProject) allow(); // not a Sterling project — no ceremony (P1)

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
//
// PREPROCESSING IS INSIDE THE FAIL-CLOSED BOUNDARY (board 01afa03e, the F5
// class anti_pattern e13f0fb5). unquotedText compiles a RegExp built from the
// command's own heredoc DELIMITER, and a throw there exits non-2 — which the
// hook runner reads as ALLOW, voiding this blocking gate entirely. REPRODUCED
// 2026-08-26 against HEAD: `rm -rf .st''erling <<AAA…(70k A's)…` threw
// "Regular expression too large" out of the hook (exit 1, command ALLOWED) —
// the metachar escaping upstream makes the pattern VALID but not SMALL, and
// V8 raises the size error when the pattern is COMPILED by .match(), not when
// it is constructed. The wrap is deliberately around the whole mention test,
// not just the call: the boundary must cover every statement between process
// start and the deny decision, never only the config/store read.
let mentionsStore;
try {
  mentionsStore = STORE_MENTION_RE.test(command) || STORE_MENTION_RE.test(unquotedText(command));
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `Internal error while preprocessing the command text for the store-mention check (${(e && e.message) || e}); the gate fails closed rather than risk a silent void.`,
      { agentId: input?.agent_id } // same handler-cannot-throw rule as the [cwd] catch above
    )
  );
}
if (!mentionsStore) allow(); // no store path anywhere in the command — irrelevant

// a malformed config must fail CLOSED on the protected branch — an uncaught
// throw exits non-2, which the platform treats as non-blocking (a voided gate)
let allowScripts;
try {
  allowScripts = parseConfig(loadConfig(input.cwd) ?? {}).store_guard.allow_scripts;
} catch (e) {
  deny(
    environmentDefectDenial('H15', `Store access denied — .sterling/config.json is unreadable (${e.message}); fix the config, the gate fails closed.`, {
      agentId: input?.agent_id, // same handler-cannot-throw rule as the [cwd] catch above
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

// ── ANCHORED allow_scripts EXEMPTION ─────────────────────────────────────
// A sanctioned name exempts a fragment ONLY when it is that fragment's
// EXECUTABLE argument (anti_pattern `unanchored-substring-allowlist-in-
// command-guard`, severity BLOCK). The previous test — `frag.includes(entry)`
// over the RAW fragment text, evaluated BEFORE classification — was a
// CONFIRMED, REPRODUCED bypass: splitFragments is quote/heredoc-aware but has
// no `#` handling, so a comment tail stays inside its fragment and appending
// `# scripts/init.mjs` exempted ANY command. Measured 2026-08-26 as ALLOW:
// `rm -f .sterling/sterling.db # scripts/init.mjs`, `rm -rf .sterling # …`,
// a quoted flag value (`--label "scripts/init.mjs"`) and an unrelated path
// token (`/tmp/scripts/init.mjs`). The agent-reachable one is
// `grep -c . .sterling/sterling.db # scripts/init.mjs` — store
// read-exfiltration straight through the seal decision fd9e96e0 keeps broad.
//
// SCOPE, DELIBERATELY: this narrows an over-broad EXEMPTION and nothing else,
// so it does not reopen decision ccc44a8e (the broad command-TEXT classifier
// is the accepted terminal design) — it closes a false-ALLOW, which is the
// class ccc44a8e keeps closed. Comment stripping happens HERE and NOWHERE
// ELSE: classifyFragment still sees the whole fragment INCLUDING its comment
// text, because stripping comments before classification would silently
// narrow the deny surface decisions ccc44a8e/a8bec43f keep broad on purpose
// (`ls /tmp # .sterling/sterling.db` must keep denying).

// Shell WORDS of a fragment, for the exemption test only. Quotes DELIMIT but
// never SPLIT — `"rm" -f x` is still the word `rm`, so a quoted verb can
// never be dissolved to promote a later sanctioned token into executable
// position (which is what tokenizing over unquotedText would do). A heredoc
// marker + body + terminator is DATA and yields no words (same span logic as
// unquotedText). An unquoted `#` that STARTS a word ends the line as a
// comment, exactly as bash reads it (`foo#bar` keeps its literal `#`).
function executableWords(str) {
  const words = [];
  let current = '';
  let started = false; // a word is in progress (possibly empty, via `''`)
  let inSingle = false;
  let inDouble = false;
  const push = () => {
    if (started) {
      words.push(current);
      current = '';
      started = false;
    }
  };
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else current += c;
      continue;
    }
    if (inDouble) {
      if (c === '"' && str[i - 1] !== '\\') inDouble = false;
      else current += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      started = true;
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
        i += span - 1;
        push();
        continue;
      }
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '#' && !started) break; // unquoted `#` at word start — comment tail
    started = true;
    current += c;
  }
  push();
  return words;
}

// Interpreters whose FIRST non-flag argument is the script they execute.
// Matched by EXACT word, not basename: `/tmp/evil/node scripts/init.mjs`
// must not inherit the exemption (fail-closed, this file's standing posture —
// a missed exemption only ever costs a deny).
const INTERPRETER_WORDS = new Set(['node', 'nodejs', 'bash', 'sh', 'zsh', 'python', 'python3']);

// Whole-word EQUALITY, never endsWith/includes: `/tmp/scripts/init.mjs` is a
// DIFFERENT, attacker-choosable file that merely ends with the sanctioned
// name, and any writable directory with that suffix would otherwise unlock
// the store. Only a leading `./` is normalized away — `./scripts/init.mjs`
// and `scripts/init.mjs` name the same file.
function isSanctionedScript(word, entries) {
  const w = word.startsWith('./') ? word.slice(2) : word;
  return entries.some((entry) => w === entry);
}

function fragmentRunsSanctionedScript(fragment, entries) {
  const words = executableWords(fragment);
  if (!words.length) return false;
  if (isSanctionedScript(words[0], entries)) return true; // directly executed
  if (!INTERPRETER_WORDS.has(words[0])) return false;
  for (let i = 1; i < words.length; i++) {
    if (words[i].startsWith('-')) continue; // an interpreter flag, not the script
    return isSanctionedScript(words[i], entries); // the first non-flag arg IS the script
  }
  return false;
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

// EXEMPTION ELIGIBILITY (board 98889ecd). Anchoring the allowlist to the
// fragment's EXECUTABLE argument fixed WHICH fragments are exempted; this
// fixes HOW MUCH of an exempted fragment is granted. A sanctioned executable
// used to grant the WHOLE fragment, so its command substitutions and
// redirections were never classified — and the attacker never needs control of
// the sanctioned script: `$(...)`, backticks and `<(...)`/`>(...)` execute in
// the SHELL before, or independently of, the sanctioned program, and a
// redirect can damage the store using the launcher's own output.
//
// So the exemption is retained ONLY for a RIDER-FREE sanctioned invocation.
// Deliberately CONSERVATIVE and deliberately COARSE: any command/process
// substitution syntax at all disqualifies the fragment, even a read-only one
// the plain classifier would allow, because `classifyFragment` returns a
// fragment-wide verdict with NO provenance saying which text produced a
// finding — per-finding provenance is the mini-shell-parser that decision
// 2c3e3136 parked twice. This only ever NARROWS an exemption (it removes allow
// surface, never adds deny surface), so it does not reopen ccc44a8e's terminal
// classify-by-static-text ruling.
//
// FALSE-DENY note: no checked-in invocation in scripts/ or skills/ combines an
// allowlisted launcher with substitution syntax or a store-directed redirect;
// every configured launcher shape (including the direct
// `--db .sterling/sterling.db` forms of the migration-preflight /
// migrate-stores remediation floor, decision bc0f81e3) stays allowed. Refine
// this ONLY from a real incident — the workaround for a newly-denied shape is
// to compute the substitution in a SEPARATE fragment.
//
// ACCEPTED NEW DENIAL, NAMED (outside review 2026-08-27, MEASURED not assumed):
// the test reads the RAW fragment, so a backtick or `$(` inside QUOTED DATA
// counts as a rider. The shape that bites is the repo's own commit path,
// `node scripts/commit-reviewed.mjs -m "…"` (commands/merge.md:13), when the
// message contains BOTH a backtick/`$(` AND a store mention — e.g.
// -m "fix(h15): narrow `allow_scripts` for .sterling/config.json" now denies.
// Measured scope, which is narrower than it first looks: a backtick message
// with NO store mention still ALLOWS (the mentionsStore early-out above never
// reaches this code), a store mention with NO backtick still ALLOWS, and bare
// parentheses are not riders. Single-quoting the message does NOT help — the
// test is on raw text. Workaround: drop the backticks, or omit the store path.
//
// THE OBVIOUS REMEDY IS UNSOUND AND WAS REJECTED ON MEASUREMENT: testing
// `unquotedText(fragment)` instead of the raw fragment. unquotedText DROPS the
// CONTENTS of quoted spans (see its definition below), but bash EXPANDS `$(…)`
// and backticks inside DOUBLE quotes — so that swap re-ALLOWS the exfiltration
// this check exists to stop. Measured against the frozen rider pins: RID-2
// (`"$(cat .sterling/sterling.db)"`), RID-3 and RID-4 all flipped deny -> ALLOW.
// A sound refinement would have to distinguish single-quoted and backslash-
// escaped (inert) from double-quoted (expanding) text, which is the shell-
// tokenizer decision 2c3e3136 parked twice. Left as accepted friction.
function sanctionedFragmentHasShellRider(fragment) {
  return redirectsIntoStore(fragment) || /(?:\$\(|`|[<>]\()/.test(fragment);
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
  if (DB_MENTION_RE.test(trimmed)) return { write: true, fragment: trimmed, dbSeal: true };

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
let offendingIsDbSeal = false;
try {
  for (const frag of splitFragments(command)) {
    // The sanctioned-script escape is judged PER FRAGMENT (AC-E): a sanctioned
    // script elsewhere in a compound command must never launder a writing
    // fragment alongside it (`node scripts/x.mjs && rm .sterling/…` still
    // denies, naming the rm fragment). And ANCHORED to the fragment's
    // EXECUTABLE argument — mere presence of the name in the fragment's text
    // is never sufficient; see fragmentRunsSanctionedScript above.
    // And granted only when the sanctioned invocation is RIDER-FREE: a
    // substitution or store-directed redirect riding along is shell work the
    // sanctioned executable never sanctions (see
    // sanctionedFragmentHasShellRider above) — such a fragment falls through
    // to ordinary classification instead of being waved past.
    const sanctioned = fragmentRunsSanctionedScript(frag, allowScripts);
    if (sanctioned && !sanctionedFragmentHasShellRider(frag)) continue;
    const result = classifyFragment(frag);
    if (result.write) {
      offending = result.fragment;
      offendingIsDbSeal = Boolean(result.dbSeal);
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
      { agentId: input?.agent_id } // same handler-cannot-throw rule as the [cwd] catch above
    )
  );
}
if (!offending) allow();

// DISCLOSURE-ONLY message for the raw command-text DB seal (decisions
// h15-broad-command-text-guard-is-terminal-accepted and
// h15-db-seal-residual-discharged-by-disclosure): the allow surface here is
// UNCHANGED from the generic deny below — only the wording differs, naming
// the exact matched substring, its offset, and the seal's discriminator, and
// dropping the generic message's false "only redirections INTO .sterling/"
// claim (a redirect whose target merely CONTAINS the literal while pointing
// OUTSIDE .sterling/ is denied too).
if (offendingIsDbSeal) {
  const match = DB_MENTION_RE.exec(command);
  const matchedText = match ? match[0] : 'sterling.db';
  const offset = match ? match.index : command.search(DB_MENTION_RE);
  deny(
    "H15: shell access to the Sterling store's database file is denied — DB access is the MCP tool surface's job, never raw shell.\n" +
      `Denied fragment: ${offending}\n` +
      `Matched substring: "${matchedText}" at offset ${offset} in the command text.\n` +
      'This is a raw command-text DB seal: it matches the literal text of the command, not a resolved path or write target, so syntactic role and verb are intentionally ignored — it fires the same whether the literal sits in a path, inside a quoted search pattern, or in a redirect target, and regardless of whether the verb is a write or a normally read-only one like grep.\n' +
      'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
      `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts) — a sanctioned name exempts a fragment ONLY when it is that fragment's EXECUTABLE argument; the same name in a comment, a quoted flag value, or an unrelated path exempts nothing.\n` +
      'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
  );
}

deny(
  'H15: shell write access to the Sterling store is denied — the store is read and written through the §10 MCP tool surface ONLY.\n' +
    `Denied fragment: ${offending}\n` +
    'This is the closed-world store-write classifier: verbs not explicitly recognized as read-only are deliberately denied as potentially mutating (decision 0b4d3c8c) — the denial does not assert the command was proven to write.\n' +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
    `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts).\n` +
    ".sterling/sterling.db is sealed to shell access for EVERY verb, reads included — DB access is the MCP tool surface's job, never raw shell.\n" +
    'Non-DB store files (config.json, transient/*) ARE shell-readable (decision 0b4d3c8c) — only writes, redirections, and moves/copies INTO .sterling/ are denied.\n' +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
);
