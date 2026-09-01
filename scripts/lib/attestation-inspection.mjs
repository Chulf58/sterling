// scripts/lib/attestation-inspection.mjs — the ONE read-only attestation
// inspector behind decision attestation-staleness-disclosure-only-never-a-
// refusing-gate (1f069af4 v2; board attestation-gate 9868a0dd), shared by
// commit-reviewed.mjs (staged diff / --target-sha amend), direct-merge.mjs
// (branch vs merge base) and merge-gate.mjs (run branch vs merge base).
//
// WHAT THIS IS FOR, and what it deliberately is NOT. The consumer's ask was a
// hook REFUSING a commit that touches render/asset paths without a fresh
// attestation. That refusing form was DECLINED: a gate the conductor must pass
// converts the conductor into the de-facto attestation trigger, reversing
// decision a7dbac2f (an attestation records a HUMAN inspection) in practice.
// What ships instead is DISCLOSURE — the same facts, at the same moments, with
// no verdict and no refusal anywhere. Nothing in this module or its callers may
// ever fail an operation, and every caller wraps it fail-open.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each because doing them would be a
// lie rather than a feature:
//   1. NO FRESHNESS PREDICATE. An attestation carries no commit sha, no blob
//      sha and no render binding, so whether one is CURRENT against the bytes
//      being committed is UNPROVABLE from the store alone. No is_fresh/is_stale/
//      currency field is computed and none is claimed (the instrument-staleness
//      re-test that could make such a claim honest stays deferred, board
//      1d02b6b4).
//   2. NO GLOB WIDENING OF file_keys. An attestation covers a touched path iff
//      that path occurs EXACTLY in its file_keys. The config globs only select
//      WHICH touched paths are worth comparing; a file_keys entry that happens
//      to look like a glob is a literal string and widens nothing.
//   3. NO APPROVAL FILTER. 'rejected' and 'needs_rework' are COVERAGE — the
//      question this answers is "does a comparable human inspection record
//      exist", never "was it approved". The verdict distribution is disclosed
//      so the reader draws their own conclusion.
//
// STORE ACCESS is raw node:sqlite in READ-ONLY mode, OPENED IN PLACE against the
// live database (precedent: scripts/migration-preflight.mjs's DatabaseSync open)
// — never SterlingStore, whose constructor performs DDL and would WRITE to a
// store this module only reads. It issues no journal-mode pragma and manages no
// WAL sidecar in either direction: it creates none deliberately, copies none,
// and above all DELETES none. See readOnlyProbe for why the two alternatives
// that avoid sidecars entirely were both rejected as silent under-reporters.
// `lifecycle` is the authoritative liveness column (`status` is derived), and
// every row body is parsed defensively: one malformed row is disclosed-skipped,
// never total unavailability. Any other failure returns { available:false,
// reason } and each caller degrades to ONE loud line per invocation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matchesGlob } from '@sterling/schemas';

/** Examples cap per declaration. The rollup replaced an uncapped per-path dump
 *  (adjudicated fatal at branch scale — a 300-file branch prints 300 lines
 *  nobody reads); the cap is what keeps the block one block. */
const EXAMPLE_CAP = 5;

/** Example priority: the categories a reader must act on first, then the ones
 *  that merely reassure. 'uncovered' outranks 'approved' deliberately — an
 *  absent record is a stronger signal than a present positive one. */
const EXAMPLE_PRIORITY = ['rejected', 'needs_rework', 'uncovered', 'approved'];

const VERDICTS = ['approved', 'rejected', 'needs_rework'];

/** Repo-relative POSIX normalization, matched on both sides of every
 *  comparison so a cosmetic spelling difference can never read as a
 *  non-match. Mirrors the identical helper in commit-reviewed.mjs. */
const normalizePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Splits a git `-z` (NUL-separated) --name-only payload into normalized
 * repo-relative paths, de-duplicated with insertion order preserved. -z rather
 * than the newline form because core.quotePath octal-escapes non-ASCII and
 * space-bearing paths, which the plain form mangles.
 */
export function parseNulPathList(stdout) {
  return [
    ...new Set(
      String(stdout ?? '')
        .split('\0')
        .filter(Boolean)
        .map(normalizePath)
    ),
  ];
}

/**
 * THE ONE PLACE THIS FIELD IS INTERPRETED. Every surface gets its globs here,
 * read LIVE from .sterling/config.json (Codex review HIGH-1 + roster MEDIUM-1,
 * 2026-09-01). No caller may take them from openProject()'s parsed config object
 * instead: that object is produced by parseConfig long before any disclosure
 * code runs, so any validation of this field there can terminate a merge command
 * outright, and an ADVISORY declaration that can refuse a merge contradicts the
 * whole ruling this feature implements. The schema is therefore `z.unknown()`
 * (packages/schemas/src/config.ts) — it cannot refuse and it cannot narrow — and
 * ALL judgment happens here, where the answer is a disclosure, never a refusal.
 *
 * WHAT IT DROPS, AND WHY DROPPING BEATS REFUSING:
 *   - a NON-ARRAY container → `"attestation_path_globs": "renders/**"`, the
 *                           bracket-less hand-edit, is the shape a human
 *                           actually writes by mistake. It declares nothing
 *                           usable, and it must not cost anyone a merge.
 *   - non-string members  → unusable as a glob at all.
 *   - empty strings       → match nothing; a declaration that declares nothing.
 *   - EXACT duplicates    → the inspector reports one rollup PER DECLARATION and
 *                           deliberately does not de-dup (that is its pinned
 *                           contract), so an undeduped duplicate would print the
 *                           same block twice.
 * Every drop is RETURNED, not swallowed, and rendered as its own disclosure line
 * — the author still learns their declaration is defective, at the same moment
 * they would have, without a merge dying for it (P5 without a new gate).
 *
 * LOCALLY GUARDED (precedent: settlement.mjs's loadGeneratedProjections): a
 * missing file, unreadable bytes, malformed JSON or a non-array value all
 * degrade to "no declarations", i.e. fully dormant.
 *
 * EMPTY IS THE SHIPPED DEFAULT AND MEANS DORMANT: no store is read, no git diff
 * is taken and nothing is printed. Sterling's own config declares none — the
 * feature exists for consuming projects.
 *
 * Returns { globs, dropped: { invalid_container, non_string, empty, duplicates[] } }.
 */
export function readAttestationGlobs(projectRoot) {
  const dropped = { invalid_container: false, non_string: 0, empty: 0, duplicates: [] };
  try {
    const configPath = join(projectRoot, '.sterling', 'config.json');
    if (!existsSync(configPath)) return { globs: [], dropped };
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const declared = raw && typeof raw === 'object' ? raw.attestation_path_globs : undefined;
    if (declared !== undefined && !Array.isArray(declared)) {
      // DECLARED, BUT NOT AS A LIST. Distinguished from "absent" on purpose: the
      // author believes they declared something, so silence here would leave a
      // dormant feature looking configured. Disclosed, never refused.
      dropped.invalid_container = true;
      return { globs: [], dropped };
    }
    if (!Array.isArray(declared)) return { globs: [], dropped };
    const globs = [];
    const seen = new Set();
    for (const g of declared) {
      if (typeof g !== 'string') {
        dropped.non_string++;
        continue;
      }
      if (g === '') {
        dropped.empty++;
        continue;
      }
      if (seen.has(g)) {
        dropped.duplicates.push(g);
        continue;
      }
      seen.add(g);
      globs.push(g);
    }
    return { globs, dropped };
  } catch {
    return { globs: [], dropped };
  }
}

/**
 * READ THE LIVE STORE IN PLACE, READ-ONLY, AND MANAGE NOTHING AROUND IT.
 * The connection is opened `{ readOnly: true }`; no journal-mode pragma is
 * issued, and this module NEVER creates, copies or deletes a `-wal`/`-shm`
 * sidecar. SQLite may materialize its own sidecars for the read — those are
 * SQLite's, they are left exactly where they are, and their presence afterwards
 * is not litter this module is entitled to clean up.
 *
 * THREE DESIGNS WERE TRIED HERE; THE OTHER TWO BOTH LIE (adjudicated with Codex
 * thread 01a05c7b, 2026-09-01, after two review rounds — the intermediate
 * snapshot design was REVERSED, so this comment is the record of why):
 *
 *   1. READ-ONLY IN PLACE + DELETE THE SIDECARS WE CREATED — the original, and
 *      genuinely unsafe. Ownership was decided from two existsSync snapshots and
 *      then acted on: a connection opening in that window has its LIVE sidecars
 *      unlinked, and on Unix unlinking a live WAL can split later connections
 *      and lose committed rows. THE DELETION WAS THE DEFECT, NOT THE OPEN.
 *
 *   2. COPY main + `-wal` TO A TEMP DIR AND READ THE COPY — this creates no
 *      sidecar in the store directory, which is why it looked better, and it is
 *      WRONG for a subtler reason: a raw two-file copy IS NOT AN ATOMIC
 *      SNAPSHOT. A checkpoint landing between copying the main file and copying
 *      the WAL yields a pair that never coexisted, and the rows that moved are
 *      silently absent. For THIS feature that is the worst available failure:
 *      it reports "no comparable human record" for an attestation that exists.
 *
 *   3. `file:<path>?immutable=1` — measured to create zero sidecars, and it
 *      fails the same way for a simpler reason: it ignores the WAL entirely, so
 *      with a live writer holding an uncheckpointed WAL it returns only the
 *      checkpointed rows. Measured on this machine, isolated fixture per shape.
 *
 * SQLite's own read transaction is the coherent snapshot designs 2 and 3 were
 * reaching for and could not construct: a read-only connection sees the main
 * file AND the WAL as one consistent view, which is exactly the guarantee this
 * disclosure needs — an attestation committed but not yet checkpointed must be
 * FOUND, not silently missed. Creating a sidecar is harmless; deleting one is
 * not; under-reporting is worse than both.
 */
function readOnlyProbe(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Inspect the project store's LIVE attestations against a touched path set.
 *
 *   inspectAttestations({ projectRoot, touchedPaths, declaredGlobs }) -> {
 *     available: boolean,
 *     reason?: string,                     // available:false only
 *     reports?: [{ glob, touched_count, comparable_count,
 *                  verdicts: { approved, rejected, needs_rework },
 *                  uncovered_count, examples: [{path, verdict}], omitted_count }],
 *     pathless_attestation_count?: number, // live attestations with no file_keys
 *     skipped_malformed_count?: number,    // rows that could not be read as attestations
 *   }
 *
 * SYNCHRONOUS by design (node:sqlite is a sync API) — callers `await` it
 * harmlessly, and the --target-sha amend flow, which is a plain sync function,
 * can call it without becoming async.
 *
 * One report PER DECLARATION, in declaration order, with NO de-duplication:
 * two identical globs produce two identical reports. Overlapping declarations
 * therefore report the same path more than once and there is no summed global
 * total — a declaration is what the project declared, and rolling them together
 * would report a number nobody wrote down. De-duplicating here would also hide
 * a duplicate declaration from the human; duplicates are dropped and DISCLOSED
 * by readAttestationGlobs — nothing anywhere refuses them (the schema is
 * deliberately untyped so this advisory field can never refuse an operation).
 *
 * A declaration matching NOTHING in the touched set produces NO report — the
 * disclosure is about what this operation actually touches, and a zero row per
 * dormant declaration is noise on every invocation.
 */
export function inspectAttestations({ projectRoot, touchedPaths, declaredGlobs } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return { available: false, reason: 'no project root given to the attestation inspector' };
  }
  const touched = Array.isArray(touchedPaths)
    ? [...new Set(touchedPaths.filter((p) => typeof p === 'string' && p).map(normalizePath))]
    : [];
  const globs = Array.isArray(declaredGlobs) ? declaredGlobs.filter((g) => typeof g === 'string' && g) : [];

  const dbPath = join(projectRoot, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) {
    return { available: false, reason: `no Sterling store at ${dbPath} — nothing to compare against` };
  }

  let rows;
  try {
    rows = readOnlyProbe(dbPath, (db) =>
      // lifecycle IS the liveness authority (status is derived from it), and a
      // retired attestation provides no coverage: it was superseded precisely
      // because someone judged it no longer the ruling. The type predicate is
      // equally load-bearing — a decision or article carrying the same
      // file_keys is not a human inspection record.
      db.prepare("SELECT id, body FROM records WHERE type = 'attestation' AND lifecycle = 'live'").all()
    );
  } catch (e) {
    // Covers every whole-read failure in one honest sentence: an unopenable
    // file, a store predating the lifecycle column, a hot -wal a reader cannot
    // recover. The caller prints ONE loud line and proceeds.
    return { available: false, reason: `could not read attestations from ${dbPath}: ${e?.message ?? e}` };
  }

  // ── coverage index: touched path -> the WINNING covering attestation ───────
  // Freshest inspected_at wins; on an exact tie the GREATEST id wins, so two
  // records inspected the same day never resolve by whatever order SQLite
  // happened to return.
  const winner = new Map(); // normalized path -> { verdict, inspectedAt, id }
  let pathlessAttestationCount = 0;
  let skippedMalformedCount = 0;

  for (const row of rows) {
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      // ONE bad row is skipped and DISCLOSED, never escalated into total
      // unavailability — the other rows are real evidence and withholding them
      // over an unrelated defect would be the wrong direction on an advisory.
      skippedMalformedCount++;
      continue;
    }
    if (!body || typeof body !== 'object' || !VERDICTS.includes(body.verdict)) {
      // Parsed, but not readable AS an attestation (not an object, or a verdict
      // outside the closed enum the schema enforces). Counted with the
      // malformed rows rather than dropped silently: it contributed nothing,
      // and a reader is entitled to know a row went unread.
      skippedMalformedCount++;
      continue;
    }
    const fileKeys = Array.isArray(body.file_keys) ? body.file_keys.filter((f) => typeof f === 'string' && f) : [];
    if (fileKeys.length === 0) {
      // A pathless attestation covers NOTHING — an empty file_keys is not a
      // vacuous match on every path, it is an attestation whose repo
      // correspondence was never recorded (artifact_key is the identity axis,
      // and it need not be a path). Disclosed in its own store-health count so
      // "the store has attestations but none of them name files" is legible.
      pathlessAttestationCount++;
      continue;
    }
    const inspectedAt = typeof body.inspected_at === 'string' ? body.inspected_at : '';
    const id = typeof body.id === 'string' ? body.id : String(row.id ?? '');
    for (const key of fileKeys) {
      const path = normalizePath(key);
      const held = winner.get(path);
      if (!held || inspectedAt > held.inspectedAt || (inspectedAt === held.inspectedAt && id > held.id)) {
        winner.set(path, { verdict: body.verdict, inspectedAt, id });
      }
    }
  }

  const reports = [];
  for (const glob of globs) {
    const matched = touched.filter((p) => matchesGlob(p, glob));
    if (matched.length === 0) continue;
    const entries = matched.map((path) => ({ path, verdict: winner.get(path)?.verdict ?? 'uncovered' }));
    const verdicts = { approved: 0, rejected: 0, needs_rework: 0 };
    let comparable = 0;
    for (const e of entries) {
      if (e.verdict === 'uncovered') continue;
      verdicts[e.verdict]++;
      comparable++;
    }
    const examples = EXAMPLE_PRIORITY.flatMap((cat) => entries.filter((e) => e.verdict === cat)).slice(0, EXAMPLE_CAP);
    reports.push({
      glob,
      touched_count: entries.length,
      comparable_count: comparable,
      verdicts,
      uncovered_count: entries.length - comparable,
      examples,
      omitted_count: entries.length - examples.length,
    });
  }

  return {
    available: true,
    reports,
    pathless_attestation_count: pathlessAttestationCount,
    skipped_malformed_count: skippedMalformedCount,
  };
}

/** Control characters (C0, DEL, C1) stripped from any path before it is
 *  printed: these paths come from a git diff and from store records, and a
 *  newline or a CSI lead-in in either could forge a line on the surfaces this
 *  disclosure prints to. Same sanitization the board-payment nudge uses. */
const printable = (s) =>
  String(s ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .trim();

/**
 * Renders the human-facing disclosure: ONE compact rollup line per declaration
 * that has touched paths, or — when the store could not be read — exactly ONE
 * loud unavailable line per invocation.
 *
 * THE ROLLUP, NOT A PATH DUMP: an uncapped per-path listing was adjudicated
 * fatal at branch scale, so each declaration reports counts plus at most five
 * prioritized examples and a "+N more" tail.
 *
 * THE WORDING IS PART OF THE DESIGN, not decoration:
 *   - "comparable human record", never "covered". Coverage language implies a
 *     verified relationship between the record and these bytes; what actually
 *     exists is a human inspection record naming the same path.
 *   - the verdict DISTRIBUTION, so a wall of 'rejected' cannot hide inside a
 *     coverage count.
 *   - "currency … is UNPROVABLE: attestations carry no commit/blob/render
 *     binding" — stated every time, because a count printed at commit time
 *     otherwise reads as a freshness claim.
 *   - "Advisory only — never a refusal", so nobody mistakes this block for a
 *     gate that can be argued with.
 *
 * `subject` names what currency would be measured against on this surface
 * ('the staged bytes', 'the branch tree'); `tool` is the caller's own CLI
 * prefix so the line matches the surrounding output.
 */
export function attestationDisclosureLines({ tool, result, declaredGlobs, subject, dropped }) {
  const globCount = Array.isArray(declaredGlobs) ? declaredGlobs.length : 0;
  // A DEFECTIVE DECLARATION IS DISCLOSED, NEVER REFUSED (Codex review HIGH-1):
  // readAttestationGlobs drops unusable entries instead of letting the config
  // schema kill a merge, so this line is what keeps the author informed. Emitted
  // in BOTH the available and unavailable branches — a declaration defect is a
  // fact about the config, independent of whether the store could be read.
  const declarationNote = [];
  if (dropped && (dropped.invalid_container || dropped.non_string > 0 || dropped.empty > 0 || (dropped.duplicates?.length ?? 0) > 0)) {
    const parts = [];
    if (dropped.invalid_container) parts.push('the whole value is not a LIST of globs (a bracket-less hand-edit declares nothing usable)');
    if (dropped.non_string > 0) parts.push(`${dropped.non_string} non-string entr(y/ies)`);
    if (dropped.empty > 0) parts.push(`${dropped.empty} empty string(s)`);
    if (dropped.duplicates?.length > 0) parts.push(`${dropped.duplicates.length} exact duplicate(s) (${dropped.duplicates.map(printable).join(', ')})`);
    declarationNote.push(
      `${tool}: ATTESTATION DECLARATION DEFECT — config attestation_path_globs: ${parts.join('; ')} ignored. ` +
        `DROPPED, NOT REFUSED: this declaration is advisory, so a defect in it must never be able to stop a commit or a merge — ` +
        `fix .sterling/config.json when convenient. Advisory only — never a refusal.`
    );
  }
  // POSITION IS FIXED ACROSS EVERY PATH (roster review LOW): the declaration
  // note comes FIRST, then whatever the store had to say. A note that moves
  // between the top and the bottom depending on which branch produced the output
  // is a note readers learn to skip.
  if (!result || result.available !== true) {
    return [
      ...declarationNote,
      `${tool}: ATTESTATION DISCLOSURE UNAVAILABLE — the attestation store could not be read ` +
        `(${printable(result?.reason ?? 'no reason reported')}), so the ${globCount} usable declared attestation path glob(s) get no ` +
        `comparable-human-record disclosure on this invocation. Advisory only — never a refusal.`,
    ];
  }
  const lines = [...declarationNote];
  for (const r of result.reports) {
    const shown = r.examples
      .map((e) => `${printable(e.path)} [${e.verdict === 'uncovered' ? 'no comparable record' : e.verdict}]`)
      .join(', ');
    const more = r.omitted_count > 0 ? ` (+${r.omitted_count} more)` : '';
    lines.push(
      `${tool}: ATTESTATION DISCLOSURE — declaration '${printable(r.glob)}': ${r.touched_count} touched path(s); ` +
        `${r.comparable_count} have a comparable human record ` +
        `(approved ${r.verdicts.approved}, rejected ${r.verdicts.rejected}, needs_rework ${r.verdicts.needs_rework}); ` +
        `${r.uncovered_count} have NO comparable human record. Examples: ${shown}${more}. ` +
        `Each record is read as covering ONLY its own file_keys, and currency against ${subject} is UNPROVABLE: ` +
        `attestations carry no commit/blob/render binding. Advisory only — never a refusal.`
    );
  }
  // Gated on ROLLUPS specifically (not lines.length, which can now carry only a
  // declaration-defect note): store health is context for a rollup, and printing
  // it beside nothing else is noise on an invocation that disclosed nothing.
  if (result.reports.length > 0 && (result.pathless_attestation_count > 0 || result.skipped_malformed_count > 0)) {
    lines.push(
      `${tool}: ATTESTATION STORE HEALTH — ${result.pathless_attestation_count} live attestation(s) record no file_keys (they cover ` +
        `nothing here, whatever they inspected) and ${result.skipped_malformed_count} row(s) could not be read as attestations and were ` +
        `skipped. Advisory only — never a refusal.`
    );
  }
  return lines;
}
