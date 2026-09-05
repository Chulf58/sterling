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
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The canonicalizer decision 5b82e94f step 3 names. `.native` is the OS
// realpath(3) — physical resolution, which is the whole point; the JS fallback
// is only for a runtime that does not expose it.
const realNative = realpathSync.native ?? realpathSync;

// Forward-slash spelling for COMPARISON only. It never widens what spellings
// are sanctionable — WORD_SYNTAX below still refuses a backslash.
const toPosix = (p) => String(p).split(sep).join('/');

// The word-syntax fence (decision a206a529), with a leading `/` admitted so an
// ABSOLUTE in-clone path is sanctionable — the amendment that reversed that
// record's original rejection, because `node <clone>/scripts/…` is the form
// H10 and CLAUDE.md actually print in a consuming project.
//
// DISCLOSED LIMITATION, deliberately not solved here: `:` is excluded, so a
// native-Windows `C:\clone\scripts\init.mjs` word can never be sanctioned. The
// backslash exclusion has the same effect. Windows parity is a standing
// requirement and this is its own item, not a widening to smuggle in beside a
// security fix.
const WORD_SYNTAX = /^[A-Za-z0-9_./+-]+$/;

// The three markers that make a directory a plugin root (5b82e94f step 2).
// Each is checked SEPARATELY so a root failing only one is named precisely.
// Every probe uses a THROWING call (statSync), never existsSync: existsSync
// reports EACCES/EIO as plain `false`, which would launder "unreadable" into
// "absent" and let the walk-up carry on to the seam past a permission fault
// (Codex round 2, 2026-09-05). ENOENT/ENOTDIR are the only DEFINITIVE absences;
// anything else is unreadable and is surfaced as such by probePluginLayout.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const PLUGIN_MARKERS = [
  ['.claude-plugin/plugin.json', (dir) => statSync(join(dir, '.claude-plugin', 'plugin.json')).isFile()],
  ['hooks/', (dir) => statSync(join(dir, 'hooks')).isDirectory()],
  ['hooks/hooks.json', (dir) => statSync(join(dir, 'hooks', 'hooks.json')).isFile()],
];

/**
 * Probe the three markers. `{ok:true}` when `dir` carries the full plugin
 * layout; otherwise `{ok:false, missing, unreadable}` naming the first failing
 * marker, with `unreadable` true when the probe THREW (a permission fault or
 * I/O error) rather than simply finding nothing. The distinction is load-
 * bearing for the walk-up: absent means keep climbing, unreadable means stop.
 */
function probePluginLayout(dir) {
  for (const [name, probe] of PLUGIN_MARKERS) {
    let ok = false;
    let threw = null;
    try {
      ok = probe(dir);
    } catch (e) {
      ok = false;
      threw = ABSENT_CODES.has(e && e.code) ? null : e; // ENOENT/ENOTDIR = absent; anything else = unreadable
    }
    if (!ok) return { ok: false, missing: name, unreadable: threw !== null, error: threw };
  }
  return { ok: true, missing: null, unreadable: false, error: null };
}

/** null when `dir` carries the full plugin layout; otherwise the missing (or unreadable) marker. */
export function pluginLayoutFailure(dir) {
  const r = probePluginLayout(dir);
  return r.ok ? null : r.missing;
}

// The walk-up is BOUNDED: `scripts/hooks/` (source, tests) is three levels
// below the root and `hooks/` (the production bundle) is one, so six ancestors
// covers both with slack and terminates on a filesystem root regardless.
const WALK_UP_LIMIT = 6;

/**
 * The ACTIVE PLUGIN ROOT.
 *
 * `moduleUrl` MUST be the RUNNING hook's own `import.meta.url` — passed in
 * rather than read from this module's, so the derivation is identical whether
 * H15 runs as `scripts/hooks/h15-store-guard.mjs` (source, what the pins spawn)
 * or as the esbuild-bundled `hooks/h15-store-guard.mjs` (what production runs).
 *
 * ORDER (95c2c109 F2): walk-up first; the STERLING_PLUGIN_ROOT seam is read
 * only after the walk-up has found no plugin tree, so in production — where a
 * tree always sits above the bundle — the variable is inert.
 *
 * @returns {{root: string|null, reason: string, source: 'seam'|'walk-up'}}
 *   `root` is the CANONICAL (realpath'd) root, or null — in which case `reason`
 *   names the failure and NO exemption may be granted.
 */
export function resolveActivePluginRoot(moduleUrl, env = process.env) {
  // PRODUCTION DERIVATION FIRST: the running bundle's own location. Never
  // CLAUDE_PLUGIN_ROOT, never config. A walk-up that resolves is FINAL — the
  // seam below is never consulted then (95c2c109 F2).
  let dir;
  try {
    dir = fileURLToPath(new URL('.', moduleUrl));
  } catch (e) {
    // FAIL CLOSED, never onward to the seam: an error is not evidence that the
    // walk-up found no plugin tree (review finding, 2026-09-05).
    return {
      root: null,
      source: 'walk-up',
      reason: `the running hook's own module URL could not be resolved to a path (${(e && e.message) || e}); no sanctioned-script exemption is available and the test seam is not consulted.`,
    };
  }

  let walkUpFailure;
  {
    let lastFailure = null;
    for (let i = 0; i < WALK_UP_LIMIT; i++) {
      const probe = probePluginLayout(dir);
      if (probe.unreadable) {
        // FAIL CLOSED HERE, never onward to the seam: an unreadable marker
        // beside the running hook is a fault at (or on the way to) the real
        // root, and "unreadable" must not be laundered into "absent" — that is
        // the one exit that could let STERLING_PLUGIN_ROOT decide beside a
        // live tree (review finding, 2026-09-05).
        return {
          root: null,
          source: 'walk-up',
          reason:
            `the plugin-layout marker ${probe.missing} at ${toPosix(dir)} could not be READ (${(probe.error && probe.error.code) || (probe.error && probe.error.message) || probe.error}); ` +
            `an unreadable marker on the running hook's own walk-up is a fault, not an absence, so no sanctioned-script exemption is available and the test seam is not consulted.`,
        };
      }
      const missing = probe.missing;
      if (!missing) {
        let canonical;
        try {
          canonical = realNative(dir);
        } catch (e) {
          return {
            root: null,
            source: 'walk-up',
            reason: `the active plugin root ${toPosix(dir)} could not be canonicalized (${(e && e.code) || (e && e.message) || e}); no sanctioned-script exemption is available.`,
          };
        }
        return { root: canonical, source: 'walk-up', reason: `active plugin root ${toPosix(canonical)} (derived from the running hook's own location)` };
      }
      lastFailure = { dir, missing };
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    walkUpFailure =
      `no ancestor within ${WALK_UP_LIMIT} levels of the running hook's own location carries the plugin layout ` +
      `(nearest candidate ${toPosix(lastFailure?.dir ?? '')} is missing ${lastFailure?.missing ?? '.claude-plugin/plugin.json'})`;
  }

  // THE TEST SEAM — reached ONLY when the walk-up found no plugin tree.
  const seam = typeof env?.STERLING_PLUGIN_ROOT === 'string' ? env.STERLING_PLUGIN_ROOT.trim() : '';
  if (seam !== '') {
    // MARKER-VALIDATED AND FAIL-CLOSED (a206a529): "a bogus override must fail
    // closed rather than silently re-finding the real clone."
    const missing = pluginLayoutFailure(seam);
    if (missing) {
      return {
        root: null,
        source: 'seam',
        reason:
          `the active plugin root named by STERLING_PLUGIN_ROOT (${toPosix(seam)}) FAILED PLUGIN LAYOUT VALIDATION — ` +
          `the marker ${missing} is absent. A root whose layout cannot be validated is not trusted (the seam was consulted because ${walkUpFailure}), ` +
          `so no sanctioned-script exemption is available.`,
      };
    }
    let canonical;
    try {
      canonical = realNative(seam);
    } catch (e) {
      return {
        root: null,
        source: 'seam',
        reason:
          `the active plugin root named by STERLING_PLUGIN_ROOT (${toPosix(seam)}) could not be canonicalized ` +
          `(${(e && e.code) || (e && e.message) || e}); no sanctioned-script exemption is available.`,
      };
    }
    return {
      root: canonical,
      source: 'seam',
      reason: `active plugin root ${toPosix(canonical)} (STERLING_PLUGIN_ROOT test seam, layout-validated; consulted because ${walkUpFailure})`,
    };
  }

  return {
    root: null,
    source: 'walk-up',
    reason:
      `no ACTIVE PLUGIN ROOT could be derived from the running hook's own location — ${walkUpFailure}. ` +
      `An unresolvable plugin root WITHHOLDS every sanctioned-script exemption rather than granting one.`,
  };
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

  if (!WORD_SYNTAX.test(word)) {
    return {
      allow: false,
      candidate: null,
      reason:
        `the executable candidate ${JSON.stringify(word)} is outside the sanctionable word syntax ` +
        `(letters, digits and _ . / + - only — no backslash, ~, $, backtick, colon or glob). Not sanctioned.`,
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
