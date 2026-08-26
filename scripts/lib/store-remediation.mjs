// Config-space remediation-script reach (decision bc0f81e3, board 1b3c7bf3).
//
// TRAP THIS CLOSES: an explicit config.store_guard.allow_scripts array REPLACES
// the zod schema default (config.ts's `.default(...)` applies only when the
// field is absent) — so a consumer config frozen before the schema default
// grew to include the mandated migration-remediation scripts never gains them,
// even after a later /sterling:update ships a bigger default list. The store's
// refuse-until-migrated posture then makes those two scripts the ONE thing an
// H15-denied consumer can never run to escape it (see bc0f81e3's "why the trap
// exists"). An H15 command-parsing floor for this was tried and reverted after
// three review rounds each found a distinct bypass — this is the CONFIG-SPACE
// fix instead: additively merge the two sanctioned scripts into an existing
// config's allow_scripts wherever init/update touch it.
//
// DEPENDENCY-FREE (node builtins only, no @sterling/schemas import): this
// module is imported by BOTH scripts/init.mjs (which may import @sterling/schemas
// freely) and scripts/lib/update.mjs, which must stay loadable on a clone where
// the workspace packages are NOT yet built (bootstrap independence — see the
// consumer-update-path article). ESM evaluates the whole module graph at
// import time, so even a leaf import from @sterling/schemas here would break
// that guarantee for update.mjs.
//
// This is the single source of truth for the two remediation scripts — the
// schema default (config.ts) and both call sites (init.mjs, update.mjs) all
// derive from REMEDIATION_SCRIPTS rather than repeating the literal list.

export const REMEDIATION_SCRIPTS = Object.freeze(['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);

/**
 * Pure: given an existing allow_scripts ARRAY, returns { next, added } where
 * `next` appends any MISSING remediation entries, in REMEDIATION_SCRIPTS order,
 * at the end — every existing entry is left untouched: no dedupe, no reorder,
 * additive-only (anti_pattern 94f16632 — a silent config rewrite reverts
 * recorded policy; this merge is additive and the caller discloses it, never
 * silent).
 *
 * THROWS on non-array input (P5 — fail loud). Every caller already narrows the
 * value to an array before calling (init.mjs / update.mjs both guard the
 * store_guard.allow_scripts shape), so this only catches FUTURE misuse: the
 * old behaviour silently fabricated a fresh two-script array from a bad input,
 * which would have written the remediation list onto a config whose
 * allow_scripts was some non-array shape the mechanism was told not to touch.
 */
export function appendMissingRemediation(allowScripts) {
  if (!Array.isArray(allowScripts)) {
    throw new Error(
      `appendMissingRemediation: allow_scripts must be an array, got ${allowScripts === null ? 'null' : typeof allowScripts}`
    );
  }
  const existing = allowScripts;
  const added = REMEDIATION_SCRIPTS.filter((s) => !existing.includes(s));
  return { next: added.length ? [...existing, ...added] : existing, added };
}
