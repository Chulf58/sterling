// Undeclared-source disclosure — the SHARED SCAN GLUE (fix round, roster
// review MED-1/MED-2/MED-3 on decision undeclared-source-disclosure-per-
// file-coverage-live-h1-scan, board 44ef6838). Sibling to the PURE module
// scripts/hooks/lib/undeclared-source.mjs (classification + rendering only,
// no git spawning — kept exactly as before, since scripts/tests/
// undeclared-source.test.mjs pins its API and nothing here touches it).
//
// WHY A SIBLING, NOT THE SAME FILE: the pure module's own header states "no
// git spawning, no hook/init wiring here" as a deliberate design property —
// this file is exactly that wiring, extracted ONCE so scripts/hooks/
// h1-session-start.mjs and scripts/init-impl.mjs both call the SAME ladder
// instead of maintaining two copies that can (and did — MED-3) diverge.
//
// MED-1 (contract violation, decision b128f79c: "malformed config is
// UNAVAILABLE, never zero-toolchains"): the config ladder now validates EACH
// toolchain ENTRY, not just the array shape. A non-object entry, or an entry
// whose path_globs is not an array of strings, refuses the whole section as
// UNAVAILABLE — it must never be silently absorbed as "this entry
// contributes zero globs", which would flood every source file as uncovered
// from a config problem rather than a real gap.
//
// MED-3 (the two ladders had already diverged): the ONE ladder here carries
// H1's adjudicated ABSENT vs WRONG-TYPE distinction throughout — an absent
// field (toolchains, or undeclared_source_exclude_globs) defaults per the
// schema (z.array(...).default([])), because loadConfig's raw JSON.parse
// never materializes schema defaults the way parseConfig does, so a project
// whose config.json simply predates a field must not be misread as
// malformed. Only a PRESENT-BUT-WRONG-SHAPE field refuses as UNAVAILABLE.
import { spawnSync } from 'node:child_process';
import { classifyCoverage, renderUndeclaredSourceReport, renderUnavailable } from './undeclared-source.mjs';

export const UNDECLARED_SOURCE_TIMEOUT_MS = 3_000;
export const UNDECLARED_SOURCE_OUTPUT_CAP = 5_000_000; // bytes — a runaway ls-files output degrades loud, never hangs/OOMs the caller

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isArrayOfStrings(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate the RAW (non-schema-parsed) config shape for the undeclared-source
 * section only, deriving {pathGlobs, excludeGlobs} on success. `config` is
 * whatever the caller's own guarded read produced — pass `null` for
 * missing/unparseable (the caller's own JSON.parse already failed or found
 * nothing), never a fabricated default, so that case is indistinguishable
 * from any other "config could not be read" state.
 *
 * Returns { ok: true, pathGlobs, excludeGlobs } or { ok: false, reason }.
 *
 * SCOPE, DELIBERATELY NARROW (Codex outside-family review 2026-08-31, thread
 * 01a05861 — adapter/run_commands/test_globs/capabilities field validation
 * REJECTED as config-linting scope creep): this ladder validates ONLY the
 * fields the undeclared-source section itself CONSUMES — path_globs (and,
 * top-level, undeclared_source_exclude_globs). It is not a general toolchain-
 * shape linter and never will be; a malformed adapter name or run_commands
 * entry is a different section's problem to validate, if any owns that duty.
 */
export function validateUndeclaredSourceConfig(config) {
  if (config === null || config === undefined) {
    return { ok: false, reason: 'project config is missing or failed to parse — coverage cannot be computed against unknown toolchains' };
  }
  // FINAL-PASS REVIEW MED: a NON-OBJECT root (a bare array, string, number, or
  // boolean all parse as valid JSON, and none of them is `null`) must refuse
  // just as loudly as a missing/unparseable config — `config.toolchains` on a
  // string or array silently reads `undefined` and would otherwise fall
  // through to the "zero toolchains" default, flooding every source file as
  // uncovered from a config problem rather than a real gap (decision
  // b128f79c: "malformed config is UNAVAILABLE, never zero-toolchains").
  if (!isPlainObject(config)) {
    return { ok: false, reason: 'project config is not an object' };
  }
  if (config.toolchains !== undefined && !Array.isArray(config.toolchains)) {
    return { ok: false, reason: 'config.toolchains is present but not an array' };
  }
  const toolchains = config.toolchains ?? [];
  for (let i = 0; i < toolchains.length; i++) {
    const entry = toolchains[i];
    // MED-1: a malformed ENTRY refuses the whole ladder — it must never be
    // silently treated as "zero globs from this entry" (flatMap's old
    // `Array.isArray(t?.path_globs) ? t.path_globs : []` absorbed exactly
    // this shape instead of refusing it).
    if (!isPlainObject(entry)) {
      return { ok: false, reason: `config.toolchains[${i}] is not an object` };
    }
    if (!isArrayOfStrings(entry.path_globs)) {
      return { ok: false, reason: `config.toolchains[${i}].path_globs is not an array of strings` };
    }
  }
  // Fix-round minor: elements validated as STRINGS (isArrayOfStrings), same
  // as path_globs above — a non-string element (e.g. [42]) must name itself
  // in the UNAVAILABLE reason rather than arriving by accident later via a
  // matchesGlob/toLowerCase() throw on a non-string glob.
  if (config.undeclared_source_exclude_globs !== undefined && !isArrayOfStrings(config.undeclared_source_exclude_globs)) {
    return { ok: false, reason: 'config.undeclared_source_exclude_globs is present but not an array of strings' };
  }
  return {
    ok: true,
    pathGlobs: toolchains.flatMap((t) => t.path_globs),
    excludeGlobs: config.undeclared_source_exclude_globs ?? [],
  };
}

/** Classify a git spawnSync() result into a disclosed-unavailable reason, or
 *  null when the spawn succeeded cleanly. */
function gitSpawnFailureReason(result, label) {
  if (!result) return `git ${label} produced no result`;
  if (result.error) {
    if (result.error.code === 'ENOENT') return 'git is not available on PATH';
    if (result.error.code === 'ETIMEDOUT') return `git ${label} timed out after ${UNDECLARED_SOURCE_TIMEOUT_MS}ms`;
    if (String(result.error.message ?? '').toLowerCase().includes('maxbuffer')) {
      return `git ${label} output exceeded the ${UNDECLARED_SOURCE_OUTPUT_CAP}-byte cap`;
    }
    return `git ${label} failed: ${result.error.code ?? result.error.message ?? result.error}`;
  }
  if (result.signal) return `git ${label} was killed (signal ${result.signal} — likely a timeout or the output cap)`;
  if (result.status !== 0) return `git ${label} exited ${result.status}`;
  if (Buffer.isBuffer(result.stdout) && result.stdout.length >= UNDECLARED_SOURCE_OUTPUT_CAP) {
    return `git ${label} output reached the ${UNDECLARED_SOURCE_OUTPUT_CAP}-byte cap`;
  }
  return null;
}

/**
 * Live git ls-files scan (NUL-delimited), honoring the deleted-paths
 * subtraction: --cached includes DELETED index entries, so a second probe
 * names them and a deleted-but-not-yet-committed file is never reported as
 * live source. Returns { ok: true, filePaths } or { ok: false, reason }.
 *
 * BYTE-EXACT SUBTRACTION (Codex review 2026-08-31): the NUL split and the
 * deleted-paths SUBTRACTION both happen on a LOSSLESS latin1 decoding of the
 * raw stdout Buffer, never on a UTF-8 decoding — UTF-8 decoding is LOSSY for
 * invalid byte sequences (every invalid sequence collapses to the same U+FFFD
 * replacement character), so two DISTINCT non-UTF8 paths could decode equal
 * and a live file would silently subtract as though it were the deleted one.
 * latin1 maps each byte 0x00-0xFF to the SAME-NUMBERED code point, 1:1 and
 * reversibly, so the Set-based subtraction below compares exact bytes. Only
 * the SURVIVORS are decoded to UTF-8 (Buffer.from(p, 'latin1').toString(
 * 'utf8')) — that conversion is for the classification/render layer's
 * benefit and never feeds back into the subtraction itself.
 *
 * UNMERGED-INDEX DEDUPE (Codex review 2026-08-31): a conflicted (unmerged)
 * file can emit ONE PATH PER MERGE STAGE in `git ls-files`, so the listing
 * itself may repeat a path — deduped here with a Set, in code, rather than
 * relying on git's own `--deduplicate` flag (version-safe: works identically
 * whether or not the installed git supports that flag).
 */
export function scanFilePaths(cwd) {
  const gitAll = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    timeout: UNDECLARED_SOURCE_TIMEOUT_MS,
    maxBuffer: UNDECLARED_SOURCE_OUTPUT_CAP,
  });
  let reason = gitSpawnFailureReason(gitAll, 'ls-files');
  if (reason) return { ok: false, reason };
  const gitDeleted = spawnSync('git', ['ls-files', '-z', '-d'], {
    cwd,
    timeout: UNDECLARED_SOURCE_TIMEOUT_MS,
    maxBuffer: UNDECLARED_SOURCE_OUTPUT_CAP,
  });
  reason = gitSpawnFailureReason(gitDeleted, 'ls-files -d (deleted-paths probe)');
  if (reason) return { ok: false, reason };
  const allLatin1 = gitAll.stdout.toString('latin1').split('\0').filter(Boolean);
  const deletedLatin1 = new Set(gitDeleted.stdout.toString('latin1').split('\0').filter(Boolean));
  const seenLatin1 = new Set();
  const filePaths = [];
  for (const p of allLatin1) {
    if (deletedLatin1.has(p)) continue; // byte-exact subtraction
    if (seenLatin1.has(p)) continue; // unmerged-index dedupe (one path per merge stage)
    seenLatin1.add(p);
    filePaths.push(Buffer.from(p, 'latin1').toString('utf8'));
  }
  return { ok: true, filePaths };
}

/**
 * THE shared entry point both H1 (SessionStart) and init call — ONE ladder,
 * ONE semantics (MED-2/MED-3), so the "same module, same semantics" header
 * comments at both call sites are actually true. `config` is the RAW
 * (unvalidated) parsed config object, or null when it could not be read/
 * parsed at all (the caller's own guarded read). Returns the rendered string
 * to append (the bucket report, or the bounded UNAVAILABLE line), or '' when
 * there is nothing to disclose. Never throws — an unexpected internal error
 * is itself rendered as an UNAVAILABLE line (P5: disclose, never vanish).
 */
export function computeUndeclaredSourceDisclosure({ cwd, config }) {
  try {
    const validated = validateUndeclaredSourceConfig(config);
    if (!validated.ok) return renderUnavailable(validated.reason);
    const scanned = scanFilePaths(cwd);
    if (!scanned.ok) return renderUnavailable(scanned.reason);
    return renderUndeclaredSourceReport(classifyCoverage(scanned.filePaths, validated.pathGlobs, validated.excludeGlobs));
  } catch (err) {
    return renderUnavailable(`unexpected error: ${err?.message ?? err}`);
  }
}
