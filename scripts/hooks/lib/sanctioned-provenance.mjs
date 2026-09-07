// ACTIVE-PLUGIN-ROOT PROVENANCE for H15's sanctioned-script exemption.
//
// ── THE INVARIANT ───────────────────────────────────────────────────────────
// A command fragment is EXEMPT from H15's store classification if and only if
// its executable candidate — the fragment's own executable word, or, for an
// interpreter form (`node`/`bash`/…), the word IMMEDIATELY after the
// interpreter, which must not begin with `-` (PLAIN INVOCATION below) —
// CANONICALIZES (fs.realpathSync.native) to a REGULAR FILE that sits
// INSIDE the canonicalized ACTIVE PLUGIN ROOT, at a clone-relative forward-slash
// POSIX path that EXACTLY EQUALS a sanctioned entry. Every clause is load-
// bearing:
//
//   PLAIN        A sanctioned script is run as `<interpreter> <script> <args>`
//   INVOCATION.  with NOTHING between interpreter and script: the candidate is
//                words[1], and a words[1] beginning with `-` is an interpreter
//                option that voids the exemption whatever it is. "The first
//                non-flag word is the script" is NOT the interpreter's grammar
//                once an option is present — node's -r/--import/--loader take a
//                separate value word, -e/--eval carry code, bash -s and
//                python - read the program from stdin, glued forms (`-c'code'`)
//                and underscore spellings (`--experimental_loader=`) defeat any
//                list — so `node --import <clone>/x.mjs -e "<code>"` puts a
//                GENUINE clone file in candidate position while executing
//                arbitrary code (decision 95c2c109 F1; the flag-list first cut
//                fell to review the same day). Options AFTER the script are the
//                script's own arguments — every listed interpreter stops parsing
//                at the script path — and are never inspected, which is what
//                keeps `commit-reviewed.mjs -m "<msg>"` exempt. Enforced by the
//                candidate extractor in h15-store-guard.mjs, which owns the word
//                grammar; it removes reach (a deny), adding no per-flag case.
//                WHAT THIS CLAUSE DOES NOT BUY (distinct from the file-level
//                "what this does not buy" section below, which quotes Ruling 4):
//                the plain-invocation clause and the
//                unsafe-predecessor rule beside it are both PER COMMAND — they
//                see one Bash tool call's text and nothing before it, so they
//                cannot say anything about state set by an EARLIER call. The
//                cross-call vector (`export NODE_OPTIONS=…` in call 1, a plain
//                sanctioned invocation in call 2) is closed by the HARNESS, not
//                by this module: each Bash tool call runs in a FRESH SHELL, so
//                an export in one call is not visible in the next — MEASURED on
//                this platform 2026-09-05. That is a platform fact, not a
//                guarantee of the design: a harness that PERSISTED shell state
//                between calls would reopen the vector, and no static per-call
//                hook could see it, because the mutation would never appear in
//                any command text a hook is handed. Re-probe it when the
//                platform moves (verify-at-build register, decision 19678617).
//   ROOT.        Derived from the RUNNING BUNDLE's own `import.meta.url` by a
//                bounded walk-up to the nearest ancestor carrying the full
//                plugin layout (`hooks/`, `hooks/hooks.json`,
//                `.claude-plugin/plugin.json`). NEVER from CLAUDE_PLUGIN_ROOT
//                (agent-settable) and NEVER from config (agent-writable (B)
//                surface) — a root the gated party can move is not provenance.
//                `STERLING_PLUGIN_ROOT` is a TEST SEAM consulted ONLY WHEN THE
//                WALK-UP FINDS NO PLUGIN TREE (decision 95c2c109 F2, user-
//                ruled 2026-09-05): wherever a real plugin tree sits above the
//                running hook — everywhere in production — the variable is
//                INERT, so an agent that can reach hook env gains nothing by
//                setting it. When it IS consulted it is MARKER-VALIDATED and
//                FAIL-CLOSED (a206a529): set-but-invalid grants nothing.
//                Corollary for tests: a seam-based pin must spawn the hook
//                from a marker-free location (scripts/tests/lib/seam-hook.mjs),
//                or its seam is ignored and it tests the ambient clone. The
//                walk-up takes the NEAREST marker-carrying ancestor, not "the
//                clone": a planted layout inside the clone tree moves the root,
//                which needs write access to the active plugin tree — the
//                same-UID actor Ruling 4 below disclaims as a boundary. And an
//                UNREADABLE marker (a probe that THROWS, e.g. EACCES) is not
//                "absent": the walk-up stops fail-closed there and the seam is
//                NOT consulted, because a permission fault at the real root
//                must never hand the decision to an env variable.
//   IDENTITY.    realpath of BOTH sides, then a regular-file stat. `resolve()`
//                normalizes `..` LEXICALLY while bash/execve resolve it
//                PHYSICALLY after following symlinks — the EXECUTED bypass in
//                research_finding cc35e43c. So the raw word is handed to
//                realpath UNNORMALIZED; nothing on this path may call
//                path.resolve/path.join on it first.
//   CWD.         A RELATIVE word resolves against the hook input's PROJECT CWD —
//                the one cwd the platform reports for the WHOLE command.
//                Validating a file other than the one bash would actually run
//                is the same false-ALLOW under a new name. Fragments are judged
//                statically and no fragment's `cd` is simulated, so the cwd
//                assumption holds ONLY for a fragment with no unsafe
//                predecessor: h15-store-guard.mjs withholds the exemption from
//                every fragment that follows anything but echo/printf/true/:/
//                pwd or a sanctioned invocation, `cd` included (Codex rounds
//                2-3, 2026-09-05). That closed the compound-`cd` mis-resolution
//                decision 95c2c109 MEDIUM b had disclosed: `cd /x && node
//                scripts/y.mjs …` now falls through to ordinary classification
//                instead of being validated against the wrong directory.
//   CONTAINMENT. path.relative over the two CANONICAL paths, rejecting a `..`
//                segment, an absolute result, and the empty result (the root
//                itself). A `startsWith` prefix test is not containment:
//                `<clone>-evil` starts with `<clone>`.
//   EQUALITY.    EXACT, case-SENSITIVE, on forward-slash clone-relative paths.
//                A case-only variation is a false DENY (accepted, recoverable);
//                case-folding would be a false ALLOW (never).
//   FAIL-CLOSED. Every abnormal shape — unresolvable root, layout mismatch,
//                syntax-fenced word, unresolvable candidate, non-regular file,
//                escape, no match — DENIES and NAMES why. There is NO bare-name
//                or basename COMPATIBILITY FALLBACK: the fallback IS the bypass
//                (anti_pattern caecf8a6, severity BLOCK).
//
// ── WHAT THIS DOES NOT BUY, quoted verbatim from decision 1434cd54 Ruling 4 ──
// "Active-plugin-root provenance prevents a project-local filename from
// inheriting a shipped script capability; it binds trust to ORIGIN PATH, not to
// immutable bytes or caller identity, and IS NOT A SECURITY BOUNDARY against a
// same-UID actor able to modify the active plugin tree."
// It does not attest contents, does not prove the caller is the conductor, does
// not stop replacement of an allowed clone file, does not close the
// realpath-to-execution TOCTOU, and buys little on the AUTHORING machine where
// the active clone and the writable project are the same tree.
//
// GOVERNING SPEC: decision 5b82e94f (h15-realpath-binding-active-plugin-root-
// provenance), adopting decision 1434cd54 Ruling 3's seven-step sequence as the
// binding. Predecessor a206a529 — read its two ⚠ amendments, not its original
// rationale, which the record itself marks factually false.
//
// DEPENDENCY-FREE (node builtins only) so it costs the H15 bundle nothing.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
// R3 (decision r3-plugin-root-resolver-canonical-module-win32-forward-slash-
// drive-word-backslash-provisional): resolveActivePluginRoot and its
// PLUGIN_MARKERS/ABSENT_CODES/WALK_UP_LIMIT/probePluginLayout/
// pluginLayoutFailure support moved BYTE-FOR-BYTE to plugin-root.mjs as the
// ONE canonical module — this file imports it, and does NOT re-export it
// (Codex 01a07a9b: a re-export is needless dual ownership).
import { resolveActivePluginRoot } from './plugin-root.mjs';

// The canonicalizer decision 5b82e94f step 3 names. `.native` is the OS
// realpath(3) — physical resolution, which is the whole point; the JS fallback
// is only for a runtime that does not expose it.
const realNative = realpathSync.native ?? realpathSync;

// Forward-slash spelling for COMPARISON only. It never widens what spellings
// are sanctionable — wordSyntaxAdmits below still refuses a backslash.
const toPosix = (p) => String(p).split(sep).join('/');

// The word-syntax fence (decision a206a529), with a leading `/` admitted so an
// ABSOLUTE in-clone path is sanctionable — the amendment that reversed that
// record's original rejection, because `node <clone>/scripts/…` is the form
// H10 and CLAUDE.md actually print in a consuming project.
//
// DISCLOSED LIMITATION (R3, decision r3-plugin-root-resolver-canonical-module-
// win32-forward-slash-drive-word-backslash-provisional (C)): a native-Windows
// BACKSLASH word (`C:\clone\scripts\init.mjs`) stays refused on EVERY platform,
// PROVISIONALLY — which shell string the gate actually sees on native Windows
// is UNMEASURED (sterling.bat enters WSL; the native launcher is
// templates/launcher-win-native.bat, and Claude Code's Bash tool on Windows may
// or may not be Git Bash, where `\c` is escape-processed before argv reaches
// this module). Recorded conflict: scripts/tests/h14-git-ro-grant.test.mjs:
// 241-257 already treats backslash as a valid separator on win32 for H14, so
// the two gates disagree until measured — the native measurement must capture
// BOTH the raw tool_input.command and the executed argv, then rule once for
// both gates (board cbe93c31). No backslash-to-slash substitution happens
// anywhere in this module: a word is judged exactly as typed. Spaces inside a
// drive-absolute word are refused SYMMETRICALLY with the POSIX form — its own
// item if ever needed, not widened here (R3 (E)).
const WORD_SYNTAX = /^[A-Za-z0-9_./+-]+$/;

// win32-ONLY: a forward-slash drive-absolute word, e.g. `C:/clone/init.mjs`.
// Never admits a backslash — see the DISCLOSED LIMITATION above.
const WIN32_DRIVE_WORD_SYNTAX = /^[A-Za-z]:\/[A-Za-z0-9_./+-]+$/;

/**
 * Does `word` satisfy the sanctionable WORD SYNTAX? The POSIX form applies on
 * every platform; on win32 ONLY, a forward-slash drive-absolute form is ALSO
 * admitted. `platform` is a FUNCTION-PARAMETER seam (default `process.platform`
 * in production) — never an env var or config value, so it cannot become a
 * production bypass surface (R3, alternatives_rejected: an env/config seam is
 * the same shape decision 95c2c109 F2 already rejected for the plugin-root
 * seam). An admitted word flows on, UNCHANGED, into realpath + active-
 * plugin-root containment — admission here decides nothing about sanctioning
 * by itself.
 *
 * @param {string} word
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function wordSyntaxAdmits(word, platform = process.platform) {
  if (typeof word !== 'string') return false;
  if (WORD_SYNTAX.test(word)) return true;
  if (platform === 'win32' && WIN32_DRIVE_WORD_SYNTAX.test(word)) return true;
  return false;
}

/**
 * Does `word` name a sanctioned script BY FILE IDENTITY?
 *
 * PURE with respect to its inputs (it reads the filesystem, which is the point
 * — spelling is exactly what must not decide this) and NEVER throws: every
 * abnormal shape returns `{allow: false}` with a reason.
 *
 * @param {string} word     the fragment's executable candidate, EXACTLY as typed
 * @param {string[]} entries clone-relative sanctioned entries (config ∪ shipped)
 * @param {{pluginRoot: {root: string|null, reason: string}, cwd: string}} opts
 * @returns {{allow: boolean, candidate: string|null, reason: string}}
 *   `candidate` is the CANONICAL resolved path when resolution got that far.
 */
export function sanctionedProvenance(word, entries, opts) {
  const pluginRoot = opts?.pluginRoot ?? { root: null, reason: 'no plugin root was supplied to the provenance check' };
  const cwd = opts?.cwd;
  const entrySet = Array.isArray(entries) ? entries : [];
  const named = `compared against the sanctioned entry set [${entrySet.join(', ')}]`;

  if (typeof word !== 'string' || word === '') {
    return { allow: false, candidate: null, reason: 'no executable candidate could be read from the fragment; no exemption.' };
  }

  // The root is checked FIRST: with no trusted root there is nothing to be
  // inside of, and the operator's real problem is the root, not their word.
  if (!pluginRoot.root) {
    return { allow: false, candidate: null, reason: pluginRoot.reason };
  }

  if (!wordSyntaxAdmits(word)) {
    return {
      allow: false,
      candidate: null,
      reason:
        `the executable candidate ${JSON.stringify(word)} is outside the sanctionable word syntax ` +
        `(letters, digits and _ . / + - only, plus a win32 forward-slash drive-absolute form on win32 — ` +
        `no backslash, ~, $, backtick or glob; a colon only in the win32 forward-slash drive form). Not sanctioned.`,
    };
  }

  if (typeof cwd !== 'string' || cwd === '') {
    return { allow: false, candidate: null, reason: 'the project cwd is unknown, so a relative candidate cannot be resolved the way the shell would resolve it; no exemption.' };
  }

  // RAW CONCATENATION, NEVER path.resolve/path.join. Both of those normalize
  // `..` LEXICALLY, which erases the very segment cc35e43c exploited — the
  // string handed to realpath must still contain it so the OS resolves it
  // PHYSICALLY, after following symlinks, exactly as execve does.
  const rawCandidate = isAbsolute(word) ? word : `${String(cwd).replace(/[\\/]+$/, '')}${sep}${word}`;

  let canonicalCandidate;
  try {
    canonicalCandidate = realNative(rawCandidate);
  } catch (e) {
    return {
      allow: false,
      candidate: null,
      reason:
        `the executable candidate ${JSON.stringify(word)} (resolved from the project cwd as ${toPosix(rawCandidate)}) could not be canonicalized ` +
        `(${(e && e.code) || (e && e.message) || e}) — it does not exist, or it is a dangling symlink. A candidate that cannot be resolved to a ` +
        `regular file inside the active plugin root is DENIED; there is no bare-name fallback.`,
    };
  }

  let stat;
  try {
    stat = statSync(canonicalCandidate);
  } catch (e) {
    return {
      allow: false,
      candidate: canonicalCandidate,
      reason: `the executable candidate resolved to ${toPosix(canonicalCandidate)}, which could not be stat'd (${(e && e.code) || (e && e.message) || e}). Not sanctioned.`,
    };
  }
  if (!stat.isFile()) {
    return {
      allow: false,
      candidate: canonicalCandidate,
      reason:
        `the executable candidate resolved to ${toPosix(canonicalCandidate)}, which is NOT A REGULAR FILE ` +
        `(${stat.isDirectory() ? 'directory' : 'special file'}). A sanctioned entry names a shipped script; not sanctioned.`,
    };
  }

  const rel = relative(pluginRoot.root, canonicalCandidate);
  const escapes = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);
  if (escapes) {
    return {
      allow: false,
      candidate: canonicalCandidate,
      reason:
        `the executable candidate resolved to ${toPosix(canonicalCandidate)}, which is OUTSIDE the active plugin root ` +
        `${toPosix(pluginRoot.root)}. Provenance binds the FILE, not the spelling: a project-local file matching a sanctioned ` +
        `NAME is a different file from the shipped one. Not sanctioned.`,
    };
  }

  const relPosix = toPosix(rel);
  const matched = entrySet.some((entry) => {
    const e = typeof entry === 'string' ? (entry.startsWith('./') ? entry.slice(2) : entry) : null;
    return e !== null && relPosix === e; // EXACT, case-sensitive. No fallback.
  });

  if (!matched) {
    return {
      allow: false,
      candidate: canonicalCandidate,
      reason:
        `the executable candidate resolved to ${toPosix(canonicalCandidate)} — a real file inside the active plugin root ` +
        `${toPosix(pluginRoot.root)}, at clone-relative path ${relPosix}, which is not ${named}. Not sanctioned.`,
    };
  }

  return {
    allow: true,
    candidate: canonicalCandidate,
    reason: `sanctioned: ${toPosix(canonicalCandidate)} is the shipped ${relPosix} inside the active plugin root ${toPosix(pluginRoot.root)}.`,
  };
}
