#!/usr/bin/env node
// git-ro — the read-only git wrapper for Bash-holding subagents.
//
// SPEC: decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3). Four verbs
// {log, show, show-stat, diff-names}, each a FIXED INTERNAL RECIPE with ZERO
// caller-controlled git flags. New capabilities are added as reviewed verbs,
// never as flag-registry growth (round 1 killed the per-verb flag-allowlist
// shape as unmaintainable API design: value-taking flags, =-forms, aliases and
// short-option clustering make such a registry a standing drift+bypass
// surface).
//
// TRUST MODEL — WHY H14 TRUSTS THIS FILE'S CONTENTS. H14 enforces SCOPE
// DISCIPLINE, not code-execution containment (research_finding bc00be84, and
// H14's own header). It grants the single exact prefix `node scripts/git-ro.mjs`
// to the Bash-holding roster roles (coder, debugger); the wrapper is
// REPO-CONTROLLED source, reviewed and version-controlled like any other hook,
// so H14 trusts its contents exactly as it trusts the declared toolchain
// commands. What the wrapper adds on top of that grant is the guarantee that a
// git invocation reaching the outside world is one of four audited read-only
// recipes — which is why the four direct read-only git verb prefixes (board
// 4c7b84d3 lineage) were REMOVED from H14 in the same slice: keeping them
// beside the wrapper "preserves a bypass around every guarantee the wrapper
// adds".
//
// Standalone and dependency-light (hook-style): node builtins only, no
// workspace imports.
//
// STRUCTURE
//   1. repository-root cwd rule     — refuse unless standing at the repo root
//   2. hardcoded executable roster  — never PATH, never a config-stored path
//   3. argv structure + lexical     — mandatory `--`, per-verb arity, no flags
//   4. cardinality by RESOLUTION    — rev-parse --verify --end-of-options
//   5. fixed recipes + positive-set child env
//   6. bounded output, fail-closed  — 5MiB refuse, 30s cumulative -> code 124

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Exit codes. A refusal is ALWAYS nonzero with EMPTY stdout and a rule-naming
// stderr; 124 is reserved for the wrapper-owned timeout.
// ---------------------------------------------------------------------------
const EXIT_RULE = 2; // a wrapper rule refused the invocation
const EXIT_ENV = 3; // the wrapper cannot run here (cwd rule, no git binary)
const EXIT_OVERFLOW = 5; // output exceeded the stdout cap — discarded, never truncated
const EXIT_WRAPPER_FAILURE = 6; // spawn error / signal / EPIPE — never a git pass-through
const EXIT_TIMEOUT = 124; // reserved

const STDOUT_CAP = 5 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;
const TIMEOUT_MS = 30_000;
const FORCE_KILL_GRACE_MS = 2_000;
const REV_MAX = 256;
const PATH_MAX = 512;
const PATH_COUNT_CAP = 64;
const ARGV_BYTE_CAP = 8 * 1024;
const LOG_CAP = 200; // the fixed -n bound of the log recipe

// The control/ANSI class is built from char codes rather than raw bytes in a
// regex literal: an editor that strips the raw ESC/SOH byte would silently
// degrade the pattern and let control sequences through. Covers C0 (0x00-0x1f),
// DEL (0x7f) and C1 (0x80-0x9f).
const TERMINAL_CTRL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

// A refusal message can quote a CALLER-CONTROLLED token (an unknown verb, or a
// flag-shaped / dash-leading positional echoed before the control-char check
// fires). Scrubbing raw control/ANSI bytes HERE — the single seam every refusal
// funnels through — guarantees no refusal can carry terminal-control sequences
// into the transcript, while keeping the message informative by showing an
// escaped, human-readable form (\xHH) of each stripped byte.
function sanitizeForTerminal(s) {
  return String(s).replace(TERMINAL_CTRL, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function fail(code, message) {
  try {
    process.stderr.write(`git-ro: ${sanitizeForTerminal(message)}\n`);
  } catch {
    // stderr itself is broken — nothing more can be disclosed
  }
  process.exit(code);
}

const refuse = (message) => fail(EXIT_RULE, message);

// ---------------------------------------------------------------------------
// 1. REPOSITORY-ROOT CWD RULE. The root is the root of the repository the
//    wrapper was INVOKED IN — never derived from this file's own location. The
//    old import.meta.url derivation meant a plugin-owned wrapper could only
//    ever read the clone it lives in, so a consuming project could not use it
//    at all (measured 2026-09-01). The rule now: canonicalize process.cwd(),
//    ask git for `rev-parse --show-toplevel` through the SAME hardened spawn
//    path as every other call (roster executable, positive-set env, cumulative
//    deadline), canonicalize the answer, and REFUSE unless it equals the cwd.
//    A subdirectory, a non-repo, a bare repo and a gitdir therefore all refuse
//    with a message telling the agent to stand at the repository root. Every
//    later child cwd is then pinned to that discovered root. There is NO
//    special case for the Sterling clone: the wrapper is the same code
//    everywhere, and what it may read is decided by where the caller stands.
//
//    ACCEPTED RESIDUAL — "one repository" is bounded by REPO METADATA, not by
//    this check (Codex review round 2). With toplevel == cwd satisfied, the
//    repository's own on-disk metadata can still aim the recipes at another
//    repository's objects: a `.git` GITDIR POINTER file, `objects/info/
//    alternates`, or a local config `include`. Rejecting those was ruled out —
//    it would break linked worktrees and submodules, which are legitimate and
//    common. The residual is accepted under H14's scope-discipline model
//    because reaching it requires WRITING INSIDE .git/, which is already full
//    repository control. What IS closed is the env-side half: the positive-set
//    child env below means no inherited GIT_DIR / GIT_WORK_TREE /
//    GIT_OBJECT_DIRECTORY / GIT_CONFIG_* can redirect the child from outside.
// ---------------------------------------------------------------------------
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

let INVOKED_FROM;
try {
  INVOKED_FROM = realpathSync(process.cwd());
} catch (e) {
  fail(EXIT_ENV, `the current working directory cannot be canonicalized (${(e && e.message) || e}) — refusing.`);
}

// The discovery call runs at the cwd (there is no root yet); every call after
// establishRoot() runs at the discovered root. One mutable binding rather than
// a per-call option keeps the pin in ONE place, so no recipe can forget it.
let ROOT = null;
let CHILD_CWD = INVOKED_FROM;

// ---------------------------------------------------------------------------
// 2. EXECUTABLE ROSTER. A runtime probe of a HARDCODED per-platform
//    absolute-path roster. NEVER PATH resolution (that canonicalizes whichever
//    attacker-influenced binary PATH selected) and NEVER a config-stored path
//    (a writable-surface executable turns this wrapper into an
//    arbitrary-binary launcher).
// ---------------------------------------------------------------------------
const GIT_ROSTER =
  process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\bin\\git.exe',
      ]
    : ['/usr/bin/git', '/usr/local/bin/git'];

function resolveGit() {
  for (const candidate of GIT_ROSTER) {
    try {
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isFile()) return canonical;
    } catch {
      // not present on this machine — try the next roster entry
    }
  }
  return null;
}

const GIT = resolveGit();
if (!GIT) {
  fail(
    EXIT_ENV,
    `no git executable found on the hardcoded roster (${GIT_ROSTER.join(', ')}). ` +
      `The roster is deliberately NOT PATH-derived and NOT configurable; install git at one of those locations or extend the roster in a reviewed change.`
  );
}

// ---------------------------------------------------------------------------
// 5a. CHILD ENVIRONMENT IS A POSITIVE SET, built from a minimal allowlist.
//     The copy-except-GIT_* shape is REJECTED: it retains LD_PRELOAD /
//     LD_LIBRARY_PATH, which is arbitrary code execution before git even
//     starts. Nothing is inherited on POSIX; win32 keeps only the keys process
//     creation itself needs.
// ---------------------------------------------------------------------------
const WIN32_INHERIT = ['SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];

const CHILD_ENV = {
  PATH: dirname(GIT),
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  // GIT_CONFIG_NOSYSTEM disarms /etc/gitconfig but NOT the per-user global
  // config, which carries the same exec-capable knobs (gpg.program, pager.*,
  // alias.*). Point it at the null device so the child reads no global config
  // at all. WIN32: 'NUL' is the documented null device and git-for-Windows
  // accepts it here, but that is NOT VERIFIABLE FROM WSL — VERIFY AT BUILD ON
  // WINDOWS (decision 19678617's verify-at-build register). If the win32 form
  // is wrong the failure is loud (git refuses to read the config path), never a
  // silent re-enabling of the global config.
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
if (process.platform === 'win32') {
  for (const key of WIN32_INHERIT) {
    const value = process.env[key];
    if (typeof value === 'string') CHILD_ENV[key] = value;
  }
}

// Fixed, caller-invisible config baked into every invocation. Each entry is a
// repo-config→exec knob neutralized as defense-in-depth: core.fsmonitor spawns
// a configured process, and core.pager can hand git's output to a configured
// command — so it is pinned to `cat` (a no-op passthrough) beside --no-ext-diff
// / --no-textconv in the recipes. --no-pager is belt to that brace: core.pager
// does NOT dominate the per-command pager.log / pager.show settings, so pinning
// core.pager alone leaves a configured pager reachable for exactly the two
// verbs that page. log.showSignature=false closes the sibling hole: a repo
// config turning signature display on makes `log`/`show` exec gpg.program, so
// the config knob is disarmed here and the recipes ALSO pass
// --no-show-signature (defense in depth — the flag alone would be a single
// point of failure, the config alone can be re-enabled per command).
const GIT_BASE_ARGS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'log.showSignature=false'];

// ---------------------------------------------------------------------------
// 6. BOUNDED, FAIL-CLOSED EXECUTION. stdout is buffered to a 5MiB cap and
//    OVERFLOW REFUSES (discard + kill child + wrapper-owned code): a truncated
//    patch beside git's zero exit reports a complete result that is
//    incomplete, which is actively misleading. The 30s timeout is a CUMULATIVE
//    per-INVOCATION deadline (armed at the first git call), not per-call: a
//    verb makes several git calls — diff-names resolves two endpoints then
//    diffs — and a per-call budget would let one wrapper run consume N×30s.
//    Breach terminates then force-kills and owns code 124. Signals, spawn
//    errors and EPIPE are WRAPPER failures, never git pass-through.
// ---------------------------------------------------------------------------
let deadline = null; // epoch-ms; armed lazily at the first git call of this run

function runGit(args) {
  return new Promise((resolvePromise) => {
    if (deadline === null) deadline = Date.now() + TIMEOUT_MS;
    const remaining = Math.max(0, deadline - Date.now());
    let child;
    try {
      child = spawn(GIT, [...GIT_BASE_ARGS, ...args], {
        cwd: CHILD_CWD,
        env: CHILD_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolvePromise({ spawnError: (e && e.message) || String(e) });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const forceKillLater = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // the child is already gone
        }
      }, FORCE_KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      forceKillLater();
    }, remaining);
    timer.unref?.();

    child.stdout.on('data', (buf) => {
      if (overflow) return;
      outBytes += buf.length;
      if (outBytes > STDOUT_CAP) {
        overflow = true;
        outChunks.length = 0;
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        forceKillLater();
        return;
      }
      outChunks.push(buf);
    });

    child.stderr.on('data', (buf) => {
      if (errBytes >= STDERR_CAP) {
        stderrTruncated = true;
        return;
      }
      const room = STDERR_CAP - errBytes;
      if (buf.length > room) {
        errChunks.push(buf.subarray(0, room));
        errBytes = STDERR_CAP;
        stderrTruncated = true;
        return;
      }
      errChunks.push(buf);
      errBytes += buf.length;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8') + (stderrTruncated ? '\n[git-ro: stderr truncated at 256KiB]' : ''),
        overflow,
        timedOut,
        ...result,
      });
    };

    child.on('error', (e) => finish({ spawnError: (e && e.message) || String(e) }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

// Every git call funnels through here so the fail-closed classification lives
// in exactly one place. Returns { stdout: Buffer } on success; refuses (exits)
// on a wrapper failure; returns { failed: true, code, stderr } when git itself
// exited nonzero, so the caller can pass code+stderr through.
async function git(args) {
  const r = await runGit(args);
  if (r.spawnError) {
    fail(EXIT_WRAPPER_FAILURE, `could not start the git executable '${GIT}' (${r.spawnError}) — this is a wrapper failure, not a git result.`);
  }
  if (r.timedOut) {
    fail(
      EXIT_TIMEOUT,
      `this invocation exceeded the ${TIMEOUT_MS / 1000}s CUMULATIVE deadline across all its git calls and was terminated; ` +
        `no output is emitted (wrapper-owned exit ${EXIT_TIMEOUT}).`
    );
  }
  if (r.overflow) {
    fail(
      EXIT_OVERFLOW,
      `output exceeded the ${STDOUT_CAP / (1024 * 1024)}MiB stdout cap — the result is DISCARDED and the child was killed. ` +
        `Truncating and succeeding would report a complete result that is incomplete; narrow the request (a path filter, a single commit) instead.`
    );
  }
  if (r.signal) {
    fail(EXIT_WRAPPER_FAILURE, `the git child was terminated by signal ${r.signal} — a wrapper failure, never a git pass-through.`);
  }
  if (r.code !== 0) return { failed: true, code: r.code === 0 ? 1 : r.code, stderr: r.stderr };
  return { failed: false, stdout: r.stdout, stderr: r.stderr };
}

// A git nonzero exit passes through as code + stderr, with NOTHING on stdout.
function passThrough(result) {
  // git's own stderr is UNTRUSTED terminal output: a path token carrying C1
  // bytes (0x80-0x9f, which the path lexical check does not refuse) can reach
  // git and be echoed back here, defeating the very transcript-injection
  // property sanitizeForTerminal exists for (review LOW, 2026-08-31). Scrub it
  // through the same seam every other disclosure uses — internal newlines
  // become \x0a, which is the correct fail-safe for a passed-through error.
  const raw = result.stderr && result.stderr.trim().length > 0 ? result.stderr.trimEnd() : `git exited ${result.code} without a message.`;
  const text = sanitizeForTerminal(raw);
  try {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // stderr is broken; the exit code still carries the failure
  }
  process.exit(result.code);
}

function writeStdout(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  try {
    process.stdout.write(buf);
  } catch (e) {
    fail(EXIT_WRAPPER_FAILURE, `writing the result to stdout failed (${(e && e.message) || e}).`);
  }
}

// ---------------------------------------------------------------------------
// 1b. ROOT DISCOVERY (the second half of the cwd rule above). Deliberately
//     routed through git()/runGit() rather than a bare spawn, so the discovery
//     call gets the SAME guarantees as every recipe call: the hardcoded
//     executable roster, the positive-set child env, the bounded output and the
//     one cumulative 30s deadline. It is the only call that runs at the
//     caller's cwd; afterwards CHILD_CWD is the discovered root.
// ---------------------------------------------------------------------------
const STAND_AT_ROOT = `Stand at the REPOSITORY ROOT and re-run: this wrapper reads exactly one repository — the one whose root is your working directory.`;

async function establishRoot() {
  const r = await git(['rev-parse', '--show-toplevel']);
  if (r.failed) {
    // NOT a git pass-through: "not a git repository" is an environment refusal
    // of this wrapper, and it must not be reported as a failed recipe.
    const detail = r.stderr && r.stderr.trim().length > 0 ? r.stderr.trim() : `git exited ${r.code} without a message`;
    fail(EXIT_ENV, `'${INVOKED_FROM}' is not the working tree of a git repository (git said: ${detail}). ${STAND_AT_ROOT}`);
  }
  const answer = r.stdout.toString('utf8').trim();
  if (answer === '') {
    // A BARE repository (and a cwd inside a gitdir) has no working tree, so
    // --show-toplevel answers empty rather than failing.
    fail(EXIT_ENV, `'${INVOKED_FROM}' has no working tree (a bare repository or a git directory). ${STAND_AT_ROOT}`);
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(answer);
  } catch (e) {
    fail(EXIT_ENV, `the repository root reported by git ('${answer}') cannot be canonicalized (${(e && e.message) || e}) — refusing.`);
  }
  if (!samePath(canonicalRoot, INVOKED_FROM)) {
    fail(
      EXIT_ENV,
      `refusing: this wrapper runs ONLY from the repository ROOT, and '${INVOKED_FROM}' is a SUBDIRECTORY of the repository rooted at '${canonicalRoot}'. ` +
        `${STAND_AT_ROOT}`
    );
  }
  ROOT = canonicalRoot;
  CHILD_CWD = ROOT;
}

// ---------------------------------------------------------------------------
// 3. ARGV STRUCTURE + LEXICAL PRE-CHECKS.
//    The lexical layer is the EARLY filter; cardinality is settled by
//    resolution further down. Flag-shaped positionals are refused on every
//    verb — the rule is ZERO caller flags, not a deny-list of dangerous ones,
//    because git's short-option-with-attached-value form (`-O/etc/passwd`) is
//    exactly how a flagless surface becomes an arbitrary-file writer.
// ---------------------------------------------------------------------------
const VERBS = ['log', 'show', 'show-stat', 'diff-names'];
// The usage line echoes the ABSOLUTE two-token spelling the caller actually
// used, never the old cwd-relative literal: that literal is exactly what H14
// now denies (S1.2), so printing it would teach a refused invocation.
const USAGE =
  `usage: ${process.execPath} "${process.argv[1]}" <verb> [rev ...] [-- path ...]  |  verbs: ${VERBS.join(', ')} ` +
  `(log [rev] [-- paths], show <object>, show-stat <object>, diff-names <commit> <commit> [-- paths]).`;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const REV_GRAMMAR = /^[A-Za-z0-9._/~^:@{}-]+$/;

function checkRevToken(tok) {
  if (tok === '') refuse(`an empty rev token is invalid — every rev must be a non-empty token. ${USAGE}`);
  if (tok.startsWith('-')) {
    refuse(
      `flag-shaped argument '${tok}' refused: this wrapper takes ZERO caller-controlled git flags (a leading dash is never a rev). ` +
        `Each verb is a fixed internal recipe; a new capability is added as a reviewed verb, not as a caller option.`
    );
  }
  if (CONTROL_CHARS.test(tok)) {
    refuse(`the rev token contains a control character, which the lexical pre-check refuses (charset: rev grammar only).`);
  }
  if (/\s/.test(tok)) {
    refuse(`the rev token contains whitespace, which the lexical pre-check refuses — one rev per argument.`);
  }
  if (tok.length > REV_MAX) {
    refuse(`the rev token exceeds the ${REV_MAX}-char length cap (got ${tok.length} chars) — refused before resolution because it is too long to be a rev.`);
  }
  if (!REV_GRAMMAR.test(tok)) {
    refuse(`the rev token '${tok}' is outside the permitted rev grammar charset (letters, digits, and . _ / ~ ^ : @ { } -).`);
  }
}

function checkPathToken(tok) {
  if (tok === '') refuse(`an empty path after '--' is refused — every path argument must be a non-empty token.`);
  if (tok.startsWith('-')) {
    refuse(`flag-shaped path argument '${tok}' refused: this wrapper takes ZERO caller-controlled git flags, and a path may not begin with a dash.`);
  }
  if (CONTROL_CHARS.test(tok)) refuse(`a path argument contains a control character, which the lexical pre-check refuses.`);
  if (tok.length > PATH_MAX) refuse(`a path argument exceeds the ${PATH_MAX}-char length cap (got ${tok.length} chars).`);
}

const argv = process.argv.slice(2);

const argvBytes = argv.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0);
if (argvBytes > ARGV_BYTE_CAP) {
  refuse(`the total argument size (${argvBytes} bytes) exceeds the ${ARGV_BYTE_CAP}-byte argv cap.`);
}

if (argv.length === 0) refuse(`no verb was given. ${USAGE}`);

const verb = argv[0];
if (!VERBS.includes(verb)) {
  refuse(`unknown verb '${verb}': the surface is exactly four verbs — ${VERBS.join(', ')}. ${USAGE}`);
}

const rest = argv.slice(1);
const sepIdx = rest.indexOf('--');
let revTokens;
let pathTokens = null;
if (sepIdx === -1) {
  revTokens = rest;
} else {
  revTokens = rest.slice(0, sepIdx);
  pathTokens = rest.slice(sepIdx + 1);
  if (pathTokens.includes('--')) {
    refuse(`a duplicate '--' separator is refused: exactly one '--' may appear, and everything after it is a path.`);
  }
  if (pathTokens.length === 0) {
    refuse(`a trailing '--' separator with no path arguments is refused — drop the separator or name at least one path.`);
  }
  if (pathTokens.length > PATH_COUNT_CAP) {
    refuse(`too many path arguments (${pathTokens.length}); the cap is ${PATH_COUNT_CAP} paths per invocation.`);
  }
}

for (const tok of revTokens) checkRevToken(tok);
if (pathTokens) for (const tok of pathTokens) checkPathToken(tok);

if (pathTokens && (verb === 'show' || verb === 'show-stat')) {
  refuse(`the '${verb}' recipe takes no path arguments after '--' — use 'show <REV>:<path>' to read one path at a revision.`);
}

// Per-verb arity. A path is only ever a path: the '--' separator is MANDATORY,
// so a trailing positional is never silently reinterpreted as a pathspec.
if (verb === 'log' && revTokens.length > 1) {
  refuse(
    `the log recipe takes at most ONE revision (got ${revTokens.length}); a path must follow the mandatory '--' separator ` +
      `(e.g. 'log HEAD -- scripts'), and is never inferred from a trailing positional.`
  );
}
if ((verb === 'show' || verb === 'show-stat') && revTokens.length !== 1) {
  refuse(`the '${verb}' recipe takes exactly one object (got ${revTokens.length}). ${USAGE}`);
}
if (verb === 'diff-names' && revTokens.length !== 2) {
  refuse(
    `the diff-names recipe takes exactly two commit endpoints (got ${revTokens.length}): a one-endpoint diff compares the WORKING TREE, ` +
      `which this wrapper never does — comparisons here are always commit-to-commit.`
  );
}

// ---------------------------------------------------------------------------
// 4. CARDINALITY IS RESOLVED, NOT REGEXED. Every rev token is resolved with
//    rev-parse --verify --end-of-options TOKEN^{object|commit} through the
//    hardened executable, and only the resulting full object id reaches the
//    recipe — so a range or set expression (A..B, HEAD^@) can never expand one
//    token into many objects.
// ---------------------------------------------------------------------------
async function verifySingle(spec, token, peel) {
  const r = await git(['rev-parse', '--verify', '--end-of-options', spec]);
  if (r.failed) passThrough(r);
  const id = r.stdout.toString('utf8').trim();
  // --verify already refuses anything that is not exactly one revision; the id
  // shape is checked here too, so a multi-line answer can never be spliced into
  // a recipe as a single argument.
  if (!/^[0-9a-f]{40,64}$/.test(id)) {
    refuse(`'${token}' did not resolve to exactly one ${peel} id — refusing rather than passing an unresolved token to a recipe.`);
  }
  return id;
}

async function resolveRev(token, peel) {
  // A REV:path token (the measured restore-a-deleted-file case) cannot carry a
  // `^{...}` peel: everything after the ':' is a PATH to git, so
  // 'HEAD:CLAUDE.md^{object}' asks for a file literally named
  // 'CLAUDE.md^{object}'. This is a RECORDED DEVIATION from the decision's
  // uniform `TOKEN^{object|commit}` resolution, made for that reason. Such a
  // token is verified as-is — --verify still guarantees exactly one object —
  // and the required TYPE is then enforced by a second resolution of the
  // resulting id.
  if (token.includes(':')) {
    const id = await verifySingle(token, token, peel);
    if (peel === 'commit') return verifySingle(`${id}^{commit}`, token, peel);
    return id;
  }
  return verifySingle(`${token}^{${peel}}`, token, peel);
}

// ---------------------------------------------------------------------------
// 5b. THE FIXED RECIPES.
// ---------------------------------------------------------------------------
const LOG_RECORD_SEP = '\u001e';
const LOG_FIELD_SEP = '\u001f';

async function runLog() {
  const commit = revTokens.length === 1 ? await resolveRev(revTokens[0], 'commit') : null;
  // Request ONE MORE than the cap so an exactly-full result can be told apart
  // from an overflowing one: if an (LOG_CAP+1)th record comes back, the history
  // matched by this query is longer than we emit, and the envelope must SAY SO.
  // Emitting exactly -n 200 with no marker reports a complete result that is
  // silently incomplete — the same misleading-completeness the decision refuses
  // for the stdout cap, applied to the log's own bound.
  const args = [
    'log',
    '--no-decorate',
    '--no-color',
    '--no-show-signature',
    // parity with show / diff-names (reviewer L2): even a --pretty-only log
    // must never reach an external diff driver or a textconv filter, both of
    // which are repo-config→exec knobs.
    '--no-ext-diff',
    '--no-textconv',
    '-n',
    String(LOG_CAP + 1),
    '-z',
    `--pretty=format:${LOG_RECORD_SEP}%H${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s`,
  ];
  if (commit) args.push(commit);
  if (pathTokens) args.push('--', ...pathTokens);

  const r = await git(args);
  if (r.failed) passThrough(r);

  // The -z stream is parsed HERE and re-emitted as JSON: NUL-delimited
  // passthrough is not an interface a caller can consume safely.
  const parsed = r.stdout
    .toString('utf8')
    .split(LOG_RECORD_SEP)
    .map((rec) => rec.replace(/[\0\r\n]+$/, ''))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [sha, author_date, ...subjectParts] = rec.split(LOG_FIELD_SEP);
      return { sha, author_date, subject: subjectParts.join(LOG_FIELD_SEP) };
    });

  const truncated = parsed.length > LOG_CAP;
  const entries = truncated ? parsed.slice(0, LOG_CAP) : parsed;
  // Envelope, not a bare array: the tolerant `{entries:[...]}` shape carries the
  // array the callers already read AND the truncation disclosure beside it, so
  // a full-history read can never masquerade as complete.
  writeStdout(
    `${JSON.stringify({
      entries,
      truncated,
      shown: entries.length,
      total_note: truncated
        ? `history matching this query is longer than the ${LOG_CAP}-commit cap; showing the ${LOG_CAP} most recent — narrow with a rev or a '-- path' filter to reach older commits.`
        : `all ${entries.length} matching commit(s) are shown; nothing was truncated.`,
    })}\n`
  );
}

async function runShow({ stat }) {
  const object = await resolveRev(revTokens[0], 'object');
  // ORDER IS LOAD-BEARING in show-stat: git's diff option parser lets the LAST
  // output-format option win, so '--stat --no-patch' suppresses the diffstat as
  // well as the patch (measured — it emits the commit header and nothing else).
  // This is a RECORDED DEVIATION from the decision's listed token order
  // (--stat --no-patch): the set is kept intact but ORDERED '--no-patch --stat'
  // so --stat carries the verdict and --no-patch remains the defense-in-depth
  // guard the decision asked for.
  // --no-show-signature rides both forms: a repo config can turn signature
  // display on, and a signature check execs gpg.program.
  const args = stat
    ? ['show', '--no-color', '--no-show-signature', '--no-patch', '--stat', '--no-ext-diff', '--no-textconv', object]
    : ['show', '--no-color', '--no-show-signature', '--no-ext-diff', '--no-textconv', object];
  const r = await git(args);
  if (r.failed) passThrough(r);
  writeStdout(r.stdout);
}

async function runDiffNames() {
  const a = await resolveRev(revTokens[0], 'commit');
  const b = await resolveRev(revTokens[1], 'commit');
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-z', a, b];
  if (pathTokens) args.push('--', ...pathTokens);

  const r = await git(args);
  if (r.failed) passThrough(r);

  const fields = r.stdout.toString('utf8').split('\0').filter((f) => f.length > 0);
  const entries = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    // A rename/copy record carries TWO paths (source then destination); the
    // reported path is the destination, with the source kept as `from`.
    if (/^[RC]/.test(status) && i + 2 < fields.length) {
      entries.push({ status, path: fields[i + 2], from: fields[i + 1] });
      i += 3;
      continue;
    }
    if (i + 1 >= fields.length) break;
    entries.push({ status, path: fields[i + 1] });
    i += 2;
  }

  writeStdout(`${JSON.stringify(entries)}\n`);
}

try {
  // The cwd rule is settled BEFORE any recipe runs, so no recipe can execute
  // against a repository the caller is not standing in.
  await establishRoot();
  if (verb === 'log') await runLog();
  else if (verb === 'show') await runShow({ stat: false });
  else if (verb === 'show-stat') await runShow({ stat: true });
  else await runDiffNames();
} catch (e) {
  // Never an uncaught exception with a stack: a failure here is a wrapper
  // failure, reported as one line naming what broke.
  fail(EXIT_WRAPPER_FAILURE, `internal failure while running the '${verb}' recipe (${(e && e.message) || e}).`);
}
