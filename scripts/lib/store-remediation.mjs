// Config-space SANCTIONED-SCRIPT reach (board 52c1d504 — the generalization of
// the narrower "remediation reach" this module shipped as; original trap and
// provenance: decision bc0f81e3, board 1b3c7bf3).
//
// TRAP THIS CLOSES: an explicit config.store_guard.allow_scripts array REPLACES
// the zod schema default (config.ts's `.default(...)` applies only when the
// field is absent) — so a consumer config frozen before the schema default grew
// never gains the entries that were added to it later, even after a
// /sterling:update ships the bigger default. Measured twice now:
//   (1) the migration scripts (the Salesforce incident, bc0f81e3): the store's
//       refuse-until-migrated posture made those two scripts the ONE thing an
//       H15-denied consumer could never run to escape a read-only store;
//   (2) packages/tui/bundle/sterling-tui.mjs (2026-08-27): the schema default
//       carried it as a BARE BASENAME, which sanctioned nothing once H15's
//       isSanctionedScript was anchored to whole-word equality (anti_pattern
//       caecf8a6). The default was corrected — and reached fresh installs only.
// An H15 command-parsing floor for (1) was tried and reverted after three review
// rounds each found a distinct bypass — this is the CONFIG-SPACE fix instead.
//
// WHY IT IS THE WHOLE SHIPPED LIST, NOT A CURATED SUBSET (board 52c1d504,
// user-ruled): naming a two-script "remediation" sublist mislabels every future
// entry that is not a migration script — the TUI launcher is a launcher, not a
// remediation — and a deliberately-sealed list quietly widened is how the next
// reader stops trusting the seal. So the reach carries exactly what Sterling
// SHIPS as sanctioned, under a name that says so.
//
// THE REACH IS ABOUT *WHICH PROJECTS* THE SHIPPED LIST GETS TO, NEVER ABOUT
// WHAT IS ON IT. This module adds nothing to the allow surface that
// config.ts's shipped default does not already grant a fresh install; a script
// absent from SANCTIONED_SCRIPTS is never merged into any config and stays
// H15-denied. Widening the ALLOW SURFACE means editing the shipped default (and
// this list with it) — a policy change, reviewed as one.
//
// BUT SAY THE PER-PROJECT EFFECT PLAINLY, because the sentence above is true of
// FRESH INSTALLS and easy to misread as "nothing changes anywhere" (two
// independent reviewers read it that way, 2026-08-27). For an ALREADY-FROZEN
// consumer config, this merge DOES expand what that project's H15 sanctions:
// entries the project never carried are written into it on the next update. That
// is the intended fix — it is what unblocks the falsely-denied TUI launcher — but
// it is an expansion of that project's allow surface, not a no-op, and a reader
// deciding whether to add an entry should weigh it as one.
//
// AND NAME THE POLICY DEPENDENCY THIS CREATES. scripts/commit-reviewed.mjs is on
// the list, so a Bash-bearing agent in a consuming project gains H15-sanctioned
// invocation of the script that CREATES COMMITS. That is not a hole, but the
// reason it is not is NOT H15: commit-reviewed only CONSUMES review-ledger
// entries written by the reviewer-class SubagentStop, and refuses outright with
// zero valid entries. H15 sanctions the invocation; the review-receipt ledger is
// what stops it being abused. If that refusal is ever relaxed, this entry becomes
// a real hole — so the two must be reviewed together, not independently.
//
// KNOWN, BOARDED, DELIBERATELY NOT SOLVED HERE: H15's isSanctionedScript compares
// a BARE REPO-RELATIVE STRING with no identity, existence or provenance check. In
// a consuming project Sterling's own scripts live in the plugin clone, not in
// <project>/scripts/, so these names are usually free there — a file planted at
// <consuming-project>/scripts/init.mjs would match a sanctioned entry. The
// name-only matching is PRE-EXISTING; what this module does is make it reachable
// in configs that previously carried none of these names. User-ruled 2026-08-27:
// ship this, board the hardening (resolve the matched path inside the plugin
// clone) as its own slice rather than touching H15's matching path here.
//
// DEPENDENCY-FREE (node builtins only, no @sterling/schemas import): this
// module is imported by BOTH scripts/init-impl.mjs (which may import @sterling/schemas
// freely) and scripts/lib/update.mjs, which must stay loadable on a clone where
// the workspace packages are NOT yet built (bootstrap independence — see the
// consumer-update-path article). ESM evaluates the whole module graph at
// import time, so even a leaf import from @sterling/schemas here would break
// that guarantee for update.mjs.
//
// THE ONE PLACE THE LIST IS DUPLICATED, AND WHY: packages/schemas' tsconfig
// pins rootDir to `src`, so config.ts CANNOT import this file and this file
// cannot import config.ts (bootstrap independence, above). The two literals are
// therefore kept identical by a DRIFT PIN in scripts/tests/store-remediation.test.mjs
// which fails the moment they diverge — that pin is the single-source guarantee.
// Keep this list basename-free: every entry is a repo-relative path from the
// project root, because that is exactly what H15's isSanctionedScript compares
// against (whole-word equality, normalizing only a leading './').

export const SANCTIONED_SCRIPTS = Object.freeze([
  'scripts/dispose-run.mjs',
  'scripts/init.mjs',
  'scripts/consume-exit.mjs',
  'scripts/architecture-projection.mjs',
  'scripts/domain-doctor.mjs',
  'scripts/commit-reviewed.mjs',
  'scripts/migration-preflight.mjs',
  'scripts/migrate-stores.mjs',
  'packages/tui/bundle/sterling-tui.mjs',
]);

/**
 * Pure: given an existing allow_scripts ARRAY, returns { next, added } where
 * `next` appends any MISSING shipped sanctioned entries, in SANCTIONED_SCRIPTS
 * order, at the end — every existing entry is left untouched: no dedupe, no
 * reorder, additive-only (anti_pattern 94f16632 — a silent config rewrite
 * reverts recorded policy; this merge is additive and the caller discloses it,
 * never silent).
 *
 * THROWS on non-array input (P5 — fail loud). Every caller already narrows the
 * value to an array before calling (init.mjs / update.mjs both guard the
 * store_guard.allow_scripts shape), so this only catches FUTURE misuse: the
 * old behaviour silently fabricated a fresh list from a bad input, which would
 * have written the sanctioned list onto a config whose allow_scripts was some
 * non-array shape the mechanism was told not to touch.
 */
export function appendMissingSanctioned(allowScripts) {
  if (!Array.isArray(allowScripts)) {
    throw new Error(
      `appendMissingSanctioned: allow_scripts must be an array, got ${allowScripts === null ? 'null' : typeof allowScripts}`
    );
  }
  const existing = allowScripts;
  const added = SANCTIONED_SCRIPTS.filter((s) => !existing.includes(s));
  return { next: added.length ? [...existing, ...added] : existing, added };
}
