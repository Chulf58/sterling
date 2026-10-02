// ACTIVE-PLUGIN-ROOT RESOLUTION — the ONE canonical module (decision
// r3-plugin-root-resolver-canonical-module-win32-forward-slash-drive-word-
// backslash-provisional, "R3", objective rebuild-2026-09 board cbe93c31).
//
// Extracted BYTE-FOR-BYTE from scripts/hooks/lib/sanctioned-provenance.mjs
// (PLUGIN_MARKERS, ABSENT_CODES, WALK_UP_LIMIT, probePluginLayout,
// pluginLayoutFailure, resolveActivePluginRoot — formerly ~:136-245 there),
// so every consumer imports resolveActivePluginRoot from HERE, directly, with
// NO compatibility re-export from sanctioned-provenance.mjs (Codex 01a07a9b:
// a re-export is needless dual ownership when only two imports move).
// Consumers: scripts/hooks/h15-store-guard.mjs (:115 pre-extraction) and
// scripts/tests/h15-active-root-provenance.test.mjs.
// sanctioned-provenance.mjs itself imports resolveActivePluginRoot from here
// for its own sanctionedProvenance() callers.
//
// The {root, reason, source} return shape, the throwing-statSync fail-closed
// semantics (ENOENT/ENOTDIR = absent, anything else = unreadable → root:null
// and the STERLING_PLUGIN_ROOT seam NOT consulted), and the seam-only-after-
// a-clean-walk-up-finds-nothing order (decision foreign_95c2c109 F2) are all
// UNCHANGED by this move.
//
// GOVERNING SPEC: decision foreign_5b82e94f (h15-realpath-binding-active-plugin-root-
// provenance), adopting decision foreign_1434cd54 Ruling 3's seven-step sequence.
//
// DEPENDENCY-FREE (node builtins only) so it costs the H15 bundle nothing —
// the same contract sanctioned-provenance.mjs carries.

import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The canonicalizer decision foreign_5b82e94f step 3 names. `.native` is the OS
// realpath(3) — physical resolution, which is the whole point; the JS fallback
// is only for a runtime that does not expose it.
const realNative = realpathSync.native ?? realpathSync;

// Forward-slash spelling for message text only — comparison and containment
// elsewhere in this module always operate on the OS-native canonical paths
// realpath returns.
const toPosix = (p) => String(p).split(sep).join('/');

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
