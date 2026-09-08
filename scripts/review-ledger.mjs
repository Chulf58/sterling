#!/usr/bin/env node
// scripts/review-ledger.mjs — the review-ledger lifecycle CLI (R1 REBUILD,
// FROM BLANK, against decision review-receipt-rebuild-invariant-three-owner-
// modules-tri-state-liveness-receipt-bound-supersession and the contract sheet
// §3.1 + §6 A5/A7/A9/A11/A12/A13/A15/A18/A19).
//
// VERBS: discharge | record-external | digest | reconcile. Every verb answers
// `--json` with EXACTLY ONE object on stdout ({ok:true,...} at exit 0,
// {ok:false,code,facts,message} at exit 1); human mode renders the same code
// as a `[code]` token. Usage errors are `argument_invalid` with facts.flag
// naming the offending flag. There is NO undischarge/restore verb, and NO
// --force-lock / break-lock escape hatch anywhere — the closed CODES set
// (scripts/lib/review-errors.mjs) is the only vocabulary this file emits, and
// every parser/lock/shape decision below is delegated to an owner module
// (scripts/lib/dispatch-register.mjs, scripts/hooks/lib/review-ledger-entry.mjs,
// scripts/lib/review-trailers.mjs) rather than re-derived here.
//
// AGENT-WRITABLE INPUT (A19): identity.base_sha and every territory path come
// from a file any agent in the session can write. base_sha is validated
// sha40-or-null BEFORE any git use (an option-shaped or traversal-shaped value
// makes the entry [ledger_entry_malformed], never a positional); a territory
// path is routed through normalizeReceiptPath and a null result (traversal,
// absolute, drive-prefix) is NO EVIDENCE — never read from disk, never
// resolved against git. STERLING_SESSION_ID (an env override of identity) is
// disclosed whenever consulted: NOTE [session_identity_override], both human
// and --json — never silently authoritative.
//
// DISCHARGE is the explicit, accountable lifecycle exit: selector
// (--entry-id <uuid> XOR --legacy-handle receipt-<32hex>), a --digest
// concurrency token (sha256 of the exact ledger bytes — a stale token writes
// nothing), a --class proved from the record itself (never merely asserted),
// and a --reason recorded verbatim. Classes: foreign-session, foreign-branch,
// no-live-territory, unattributable, superseded (entry or commit form),
// legacy. Reserved/consumed entries refuse (entry_not_active); a discharged
// entry never flips twice.
//
// RECORD-EXTERNAL mints a conductor-attested `external_review` entry — never
// spendable, never stamped, never counted by roster eligibility — idempotent
// on (thread_id, round).
//
// DIGEST prints the sha256 of the ledger's exact bytes (nothing else); it is
// the token `discharge --digest` demands, obtainable from this same script.
//
// RECONCILE is crash recovery for a two-phase spend ONLY (reserved entries):
// finalizes a uniquely-matching commit, releases an unmatched reservation, or
// refuses [reconcile_ambiguous] on more than one match — atomically, nothing
// written on a refusal.
//
// DOES NOT GUARANTEE: that a class's preconditions, once verified, remain true
// after the discharge (the verdict is a snapshot at discharge time); that a
// hand-edited ledger entry is trustworthy evidence (this file classifies and
// enforces shape, it does not authenticate authorship).

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { arg, hasFlag, argAll } from './lib/project.mjs';
import { classifyLedgerEntry, writeLedger, withLedgerLock, receiptCoveredPaths, receiptAssignedPaths, normalizeReceiptPath, readLedger, ledgerDigest } from './hooks/lib/review-ledger-entry.mjs';
import { resolveSessionIdentity } from './lib/dispatch-register.mjs';
import { refusal, disclosure, render, toJson } from './lib/review-errors.mjs';
import { readCommitTrailers, isRosterTrailerValue, verifyCommitReceiptBinding, isSha40 } from './lib/review-trailers.mjs';

const root = process.cwd();
const MAX_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Argument plumbing — every usage error is [argument_invalid] with facts.flag.
// ---------------------------------------------------------------------------

function safeArg(name, argv) {
  try {
    return arg(name, argv);
  } catch (e) {
    throw refusal('argument_invalid', { flag: name }, e.message);
  }
}
function safeHasFlag(name, argv) {
  try {
    return hasFlag(name, argv);
  } catch (e) {
    throw refusal('argument_invalid', { flag: name }, e.message);
  }
}

// checkUnknownFlags — only tokens shaped like a LONG option (`--letter…`) are
// judged; a value that happens to start with a single dash (a negative
// --round) is never mistaken for a flag (project.mjs's own FLAG_SHAPED_VALUE
// carries the same distinction for value-position tokens).
function checkUnknownFlags(argv, allowedNames) {
  for (const tok of argv) {
    if (!/^--[A-Za-z]/.test(tok)) continue;
    const name = tok.replace(/^--/, '').split('=')[0];
    if (!allowedNames.has(name)) {
      throw refusal('argument_invalid', { flag: name }, `unrecognized flag '--${name}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Git helpers. A19 SHA HYGIENE: every sha reaching these is isSha40-validated
// by the CALLER before it arrives here — these functions never validate their
// own input, so a caller that skips validation is the defect, not this file.
// `--end-of-options` is added where MEASURED to be honoured (cat-file,
// merge-base); `rev-parse <sha>:<path>` deliberately omits it — measured (this
// host's git, and scripts/lib/review-trailers.mjs's own commitTreeBlob): that
// form echoes the literal flag as extra output instead of consuming it. Every
// declared path is compared LITERALLY (never as a pathspec) and against the
// FILESYSTEM directly (never `git status`/`diff`, which are blind to ignored
// and ignored-but-present files).
// ---------------------------------------------------------------------------

function currentHeadSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function currentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function gitObjectExists(ref) {
  return spawnSync('git', ['cat-file', '-e', '--end-of-options', ref], { cwd: root }).status === 0;
}
function isAncestor(ancestorSha, descendantSha) {
  return spawnSync('git', ['merge-base', '--is-ancestor', '--end-of-options', ancestorSha, descendantSha], { cwd: root }).status === 0;
}
function gitBlobAt(sha, path) {
  const r = spawnSync('git', ['rev-parse', `${sha}:${path}`], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function currentBlobFor(path) {
  const abs = join(root, path);
  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch {
    return null; // absent on disk (never present is never present, whatever git ignores)
  }
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}
function reachableCommits() {
  const r = spawnSync('git', ['rev-list', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0
    ? r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

// ---------------------------------------------------------------------------
// Ledger IO — M1: every read goes through the owner's readLedger(); this file
// never JSON.parses ledger content itself. `rawEntries` (verbatim, index-
// aligned with `entries`) is what a locked read-modify-write splices back, so
// an unrelated field — or a whole legacy shape — survives a discharge
// byte-for-byte. classifyLedgerEntry (via readLedger) is the ONE shape
// authority; this file never re-derives what a receipt/legacy/external entry
// looks like.
// ---------------------------------------------------------------------------

function requireDigestMatch(raw, provided) {
  const actual = ledgerDigest(raw);
  if (provided !== actual) {
    throw refusal('ledger_digest_mismatch', { expected: actual }, 'the ledger changed since this digest was computed — re-run `review-ledger.mjs digest` and retry');
  }
}

function findClassifiedById(classified, id) {
  return (
    classified.find(
      (c) => (c.kind === 'receipt' && c.receipt.entry_id === id) || (c.kind === 'external_review' && c.entry.entry_id === id)
    ) ?? null
  );
}

function observedReadsOf(entry) {
  return new Set((Array.isArray(entry?.observed_reads) ? entry.observed_reads : []).map(normalizeReceiptPath).filter((p) => p !== null));
}

// coveredPathsForSupersession — A9: an UNATTRIBUTABLE receipt's coverage can
// never come from its declaration (it could not be bound to any one dispatch
// in the first place); its OWN positive observed_reads are the only territory
// supersession may account for. Every other receipt uses the ordinary
// blob-backed covered-paths rule.
function coveredPathsForSupersession(receipt) {
  if (receipt?.territory?.source === 'unattributable') {
    return Array.isArray(receipt.observed_reads) ? receipt.observed_reads.map(normalizeReceiptPath).filter((p) => p !== null) : [];
  }
  return receiptCoveredPaths(receipt);
}

// A19/(c): identity.base_sha (receipt) / base_sha (legacy) is validated
// sha40-or-null BEFORE any class verifier runs — a value that is present but
// not a valid sha never reaches git as a positional, whatever class was asked
// for. Returns a refusal object or null.
function baseSha40OrMalformed(kind, target) {
  const baseSha = kind === 'receipt' ? target.identity?.base_sha : target.base_sha;
  if (baseSha === null || baseSha === undefined) return null;
  if (isSha40(baseSha)) return null;
  return refusal('ledger_entry_malformed', { field: 'base_sha' }, 'base_sha is not a valid 40-hex sha — refusing before any git use');
}

// ---------------------------------------------------------------------------
// STERLING_SESSION_ID (A19/A20) — resolveSessionIdentity (the ONE resolver
// shared with commit-reviewed.mjs) decides both the effective session_id AND
// whether this is a genuine, laundering-shaped OVERRIDE (env set AND a
// session marker exists AND the two disagree) — env-only identity with no
// marker file is the ordinary no-hook shape and is never disclosed. Module-
// scoped: only `discharge` reads session identity, so only it sets this;
// emitSuccess/emitFailure fold it into --json, and it is printed to stderr
// immediately (human mode) the moment it is resolved, regardless of the
// eventual outcome.
// ---------------------------------------------------------------------------

let sessionOverrideNote = null;
function resolveAndNoteSessionIdentity() {
  const identity = resolveSessionIdentity(root);
  if (identity.override) {
    sessionOverrideNote = disclosure(
      'session_identity_override',
      { var: 'STERLING_SESSION_ID' },
      'STERLING_SESSION_ID disagrees with the session marker and won'
    );
    process.stderr.write(render(sessionOverrideNote) + '\n');
  }
  return identity.session_id;
}

// ---------------------------------------------------------------------------
// Discharge class verifiers — ONE table, ONE function per class, each
// returning {ok:true, facts} or {refusal:true, code, facts?}. A class's
// preconditions not holding is [class_not_applicable]; "the class holds but
// the territory is not actually clear/covered" is the class's own code.
// ---------------------------------------------------------------------------

function verifyForeignSession(ctx) {
  const recorded = ctx.target?.identity?.session_id;
  if (typeof recorded !== 'string' || recorded === '') return { refusal: true, code: 'class_not_applicable' };
  if (recorded === ctx.sessionId) return { refusal: true, code: 'class_not_applicable' };
  return { ok: true, facts: {} };
}

function verifyForeignBranch(ctx) {
  const recorded = ctx.target?.identity?.branch;
  if (typeof recorded !== 'string' || recorded === '') return { refusal: true, code: 'class_not_applicable' };
  if (recorded === ctx.branch) return { refusal: true, code: 'class_not_applicable' };
  return { ok: true, facts: {} };
}

function verifyUnattributable(ctx) {
  if (ctx.target?.territory?.source !== 'unattributable') return { refusal: true, code: 'class_not_applicable' };
  return { ok: true, facts: {} };
}

function verifyLegacy(ctx) {
  if (ctx.kind !== 'legacy') return { refusal: true, code: 'class_not_applicable' };
  return { ok: true, facts: {} };
}

// no-live-territory: DECLARED paths compared LITERALLY against their base_sha
// bytes — never a pathspec, never `git status`/`diff` (blind to ignored
// files). A receipt whose base_sha IS the current HEAD (a post-hoc review) is
// FRESH EVIDENCE, not residue — class_not_applicable, never discharged here.
// A19/R1-C29b-traversal: a declared path that normalizeReceiptPath refuses
// (traversal/absolute/drive-prefix) is NO EVIDENCE — it is never resolved
// against git or read from disk, and counts as unverifiable-therefore-live, so
// it can never manufacture a spurious no-live success.
function verifyNoLiveTerritory(ctx) {
  const target = ctx.target;
  if (target?.territory?.source !== 'review-territory') return { refusal: true, code: 'class_not_applicable' };
  const baseSha = target.identity?.base_sha;
  if (!baseSha) return { refusal: true, code: 'class_not_applicable' };
  // isSha40(baseSha) is already guaranteed by the caller's upfront guard.
  const head = currentHeadSha();
  if (!head || baseSha === head) return { refusal: true, code: 'class_not_applicable' };
  if (!gitObjectExists(`${baseSha}^{commit}`)) return { refusal: true, code: 'class_not_applicable' };
  if (!isAncestor(baseSha, head)) return { refusal: true, code: 'class_not_applicable' };

  const files = Array.isArray(target.territory.files) ? target.territory.files : [];
  const live = [];
  for (const f of files) {
    const n = normalizeReceiptPath(f);
    if (n === null) {
      live.push(f); // escaping path: never read, never resolved — treated as live
      continue;
    }
    const baseBlob = gitBlobAt(baseSha, n);
    const curBlob = currentBlobFor(n);
    if (baseBlob !== curBlob) live.push(f);
  }
  if (live.length > 0) return { refusal: true, code: 'no_live_territory_disproved', facts: { live_paths: live } };
  return { ok: true, facts: {} };
}

const ACCEPTABLE_SURVIVOR_LIFECYCLE = new Set(['active', 'reserved', 'consumed']);

// R1-C56: branch identity is RECORD-TO-RECORD — the survivor's recorded
// identity.branch is compared to the DISCHARGED receipt's recorded
// identity.branch, never to wherever the operator currently stands. A receipt
// is evidence about the branch it was earned on; the checked-out branch is
// not part of that evidence.
function verifySupersededEntry(ctx) {
  const { target, classified, supersededBy, covering } = ctx;
  const targetBranch = target.identity?.branch ?? null;
  const survivorC = findClassifiedById(classified, supersededBy);
  if (!survivorC) return { refusal: true, code: 'superseder_not_found' };
  if (survivorC.kind !== 'receipt') return { refusal: true, code: 'superseder_not_reviewer_class' };
  const survivor = survivorC.receipt;

  if (survivor.identity?.branch !== targetBranch) return { refusal: true, code: 'superseder_branch_mismatch' };
  if (!ACCEPTABLE_SURVIVOR_LIFECYCLE.has(survivor.status)) return { refusal: true, code: 'superseder_lifecycle_unacceptable' };

  const tFinished = Date.parse(target.finished_at);
  const sFinished = Date.parse(survivor.finished_at);
  if (!Number.isFinite(tFinished) || !Number.isFinite(sFinished) || !(sFinished > tFinished)) {
    return { refusal: true, code: 'superseder_not_newer' };
  }

  const coveringReceipts = [];
  for (const cid of covering) {
    const cc = findClassifiedById(classified, cid);
    if (!cc || cc.kind !== 'receipt') {
      return { refusal: true, code: 'covering_receipt_invalid', facts: { entry_id: cid, why: 'not-found-or-not-reviewer-class' } };
    }
    const cr = cc.receipt;
    if (cr.identity?.branch !== targetBranch) return { refusal: true, code: 'covering_receipt_invalid', facts: { entry_id: cid, why: 'branch-mismatch' } };
    if (!ACCEPTABLE_SURVIVOR_LIFECYCLE.has(cr.status)) return { refusal: true, code: 'covering_receipt_invalid', facts: { entry_id: cid, why: 'lifecycle-unacceptable' } };
    const crFinished = Date.parse(cr.finished_at);
    if (!Number.isFinite(crFinished) || !(crFinished > tFinished)) return { refusal: true, code: 'covering_receipt_invalid', facts: { entry_id: cid, why: 'not-newer' } };
    coveringReceipts.push({ id: cid, receipt: cr });
  }

  const coveredPaths = coveredPathsForSupersession(target);
  const survivorReads = observedReadsOf(survivor);
  const covered = {};
  const uncovered = [];
  for (const p of coveredPaths) {
    const n = normalizeReceiptPath(p);
    if (n !== null && survivorReads.has(n)) {
      covered[p] = { by: supersededBy, observed_read: true };
      continue;
    }
    const member = n !== null ? coveringReceipts.find((cr) => observedReadsOf(cr.receipt).has(n)) : null;
    if (member) covered[p] = { by: member.id, observed_read: true };
    else uncovered.push(p);
  }
  if (uncovered.length > 0) return { refusal: true, code: 'superseder_coverage_incomplete', facts: { uncovered } };

  const facts = { form: 'entry', covered };
  if (target.territory?.source !== 'unattributable') {
    const declared = (target.territory?.files ?? []).map(normalizeReceiptPath).filter((p) => p !== null);
    const normalCovered = new Set(receiptCoveredPaths(target));
    const uncoveredDeclared = declared.filter((p) => !normalCovered.has(p));
    if (uncoveredDeclared.length > 0) facts.uncovered_declared = uncoveredDeclared;
  }
  return { ok: true, facts };
}

// R1-C55: a commit may name SEVERAL receipts (one Reviewed-By-Agent /
// Review-Receipt trailer pair per stamped receipt). EVERY Review-Receipt
// trailer on the survivor commit is judged — a single unbindable attestation
// makes the whole commit unusable as a survivor, whatever else it also
// carries. Coverage is the UNION of every BOUND receipt's covered paths,
// attributed per path (facts.covered[path].by names which receipt covered
// it), and recency is satisfied when at least one bound receipt is strictly
// newer than the discharged one (committer/author instants are never read).
function verifySupersededCommit(ctx) {
  const { target, classified, supersededBy: sha } = ctx;
  if (!isSha40(sha)) return { refusal: true, code: 'superseder_not_found' };
  if (!gitObjectExists(`${sha}^{commit}`)) return { refusal: true, code: 'superseder_not_found' };
  if (!isAncestor(sha, 'HEAD')) return { refusal: true, code: 'superseder_commit_not_ancestor' };

  const trailers = readCommitTrailers(root, sha);
  if (!trailers.roster.some((v) => isRosterTrailerValue(v))) {
    return { refusal: true, code: 'superseder_commit_trailer_not_roster', facts: { values: trailers.roster } };
  }

  const binding = verifyCommitReceiptBinding({ cwd: root, sha, ledgerEntries: classified });
  if (binding.results.length === 0) return { refusal: true, code: 'superseder_commit_receipt_unbound' };
  for (const r of binding.results) {
    if (!r.ok) return { refusal: true, code: r.code, facts: r.facts };
  }

  const tFinished = Date.parse(target.finished_at);
  const anyNewer = binding.results.some((r) => {
    const rf = Date.parse(r.receipt.finished_at);
    return Number.isFinite(tFinished) && Number.isFinite(rf) && rf > tFinished;
  });
  if (!anyNewer) return { refusal: true, code: 'superseder_commit_receipt_unbound' };

  // R1 fix 8590a004: a bound receipt credits coverage only for the paths it is
  // ASSIGNED (receiptAssignedPaths — consumption.paths when the spend was
  // scoped narrower than its full covered territory, every covered path for a
  // legacy consumption) — never every path it merely declared, or a receipt
  // spent for path A while stale on path B would wrongly cover B here too.
  const targetCovered = coveredPathsForSupersession(target);
  const covered = {};
  for (const r of binding.results) {
    for (const p of receiptAssignedPaths(r.receipt)) {
      if (!(p in covered)) covered[p] = { by: r.entry_id };
    }
  }
  const uncovered = targetCovered.filter((p) => !(p in covered));
  if (uncovered.length > 0) return { refusal: true, code: 'superseder_coverage_incomplete', facts: { uncovered } };

  return { ok: true, facts: { form: 'commit', receipt_entry_id: binding.results[0].receipt.entry_id, compared: 'commit-tree-blobs', covered } };
}

function verifySuperseded(ctx) {
  return isSha40(ctx.supersededBy) ? verifySupersededCommit(ctx) : verifySupersededEntry(ctx);
}

const VERIFIERS = {
  'foreign-session': verifyForeignSession,
  'foreign-branch': verifyForeignBranch,
  'no-live-territory': verifyNoLiveTerritory,
  unattributable: verifyUnattributable,
  superseded: verifySuperseded,
  legacy: verifyLegacy,
};

// ---------------------------------------------------------------------------
// discharge
// ---------------------------------------------------------------------------

const DISCHARGE_FLAGS = new Set(['entry-id', 'legacy-handle', 'digest', 'class', 'reason', 'superseded-by', 'covering', 'json']);

async function runDischarge(rest) {
  checkUnknownFlags(rest, DISCHARGE_FLAGS);
  const sessionId = resolveAndNoteSessionIdentity();
  const entryId = safeArg('entry-id', rest);
  const legacyHandle = safeArg('legacy-handle', rest);
  const digestArg = safeArg('digest', rest);
  const cls = safeArg('class', rest);
  const reason = safeArg('reason', rest);
  const supersededBy = safeArg('superseded-by', rest);
  const coveringRaw = safeArg('covering', rest);

  if ((entryId ? 1 : 0) + (legacyHandle ? 1 : 0) !== 1) {
    throw refusal('argument_invalid', { flag: 'entry-id/legacy-handle' }, 'exactly one of --entry-id or --legacy-handle is required');
  }
  if (!digestArg) throw refusal('argument_invalid', { flag: 'digest' }, '--digest is required');
  if (!cls) throw refusal('argument_invalid', { flag: 'class' }, '--class is required');
  if (!reason || !reason.trim()) throw refusal('argument_invalid', { flag: 'reason' }, '--reason is required and must not be empty');
  if (coveringRaw !== undefined && cls !== 'superseded') {
    throw refusal('covering_not_allowed', { class: cls }, '--covering is only meaningful for --class superseded');
  }
  if (cls === 'superseded' && !supersededBy) {
    throw refusal('argument_invalid', { flag: 'superseded-by' }, '--class superseded requires --superseded-by');
  }
  const covering = coveringRaw
    ? coveringRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return withLedgerLock(root, async () => {
    const ledger = readLedger(root);
    if (ledger.availability === 'absent') throw refusal('ledger_absent', {}, 'no ledger at .sterling/review-ledger.json');
    if (ledger.availability === 'corrupt') throw refusal('ledger_corrupt', {}, 'the ledger is not valid JSON — left untouched for inspection');

    requireDigestMatch(ledger.raw, digestArg);

    const classified = ledger.entries;

    const candidates = entryId
      ? classified.filter((c) => c.kind === 'receipt' && c.receipt.entry_id === entryId)
      : classified.filter((c) => c.kind === 'legacy' && c.legacy.handle === legacyHandle);

    if (candidates.length === 0) {
      const legacyHandles = classified.filter((c) => c.kind === 'legacy').map((c) => c.legacy.handle);
      throw refusal(
        'entry_not_found',
        { selector: entryId ? 'entry-id' : 'legacy-handle', value: entryId ?? legacyHandle, legacy_handles: legacyHandles },
        'no ledger entry matches the given selector'
      );
    }
    if (candidates.length > 1) {
      throw refusal('entry_selector_ambiguous', { indices: candidates.map((c) => c.index) }, 'more than one ledger entry matches this selector');
    }

    const found = candidates[0];
    const idx = found.index;
    const target = found.kind === 'receipt' ? found.receipt : found.legacy;
    const status = target.status;
    if (status !== 'active') {
      throw refusal('entry_not_active', { status }, `the entry is ${status}, not active`);
    }

    // A19/(c): an agent-writable base_sha that is present but not a valid sha
    // never reaches git, whatever class was requested.
    const baseShaProblem = baseSha40OrMalformed(found.kind, target);
    if (baseShaProblem) throw baseShaProblem;

    const verifier = VERIFIERS[cls];
    if (!verifier) throw refusal('class_unknown', { class: cls }, `unknown discharge class '${cls}'`);

    const verdict = verifier({
      root,
      kind: found.kind,
      target,
      classified,
      sessionId,
      branch: currentBranch(),
      supersededBy,
      covering,
    });

    if (verdict.refusal) throw refusal(verdict.code, verdict.facts ?? {}, verdict.message ?? verdict.code);

    const disposition = {
      class: cls,
      reason,
      at: new Date().toISOString(),
      head_sha: currentHeadSha() ?? '',
      classifier_version: 2,
      facts: verdict.facts ?? {},
    };
    const rawEntries = ledger.rawEntries;
    rawEntries[idx] = { ...rawEntries[idx], status: 'discharged', disposition };
    writeLedger(root, rawEntries);

    return {
      json: { ok: true, entry_id: entryId ?? null, legacy_handle: legacyHandle ?? null, status: 'discharged', class: cls, disposition },
      humanLine: `discharged ${entryId ?? legacyHandle} as ${cls}`,
    };
  });
}

// ---------------------------------------------------------------------------
// record-external
// ---------------------------------------------------------------------------

const RECORD_EXTERNAL_FLAGS = new Set(['file', 'provider', 'model', 'thread-id', 'round', 'note', 'json']);

async function runRecordExternal(rest) {
  checkUnknownFlags(rest, RECORD_EXTERNAL_FLAGS);
  const files = argAll('--file', rest);
  const provider = safeArg('provider', rest);
  const model = safeArg('model', rest);
  const threadId = safeArg('thread-id', rest);
  const roundStr = safeArg('round', rest);
  const note = safeArg('note', rest);

  if (files.length === 0) throw refusal('argument_invalid', { flag: 'file' }, 'at least one --file is required');
  if (!provider) throw refusal('argument_invalid', { flag: 'provider' }, '--provider is required');
  if (!threadId) throw refusal('argument_invalid', { flag: 'thread-id' }, '--thread-id is required');
  if (roundStr === undefined || !/^\d+$/.test(roundStr)) {
    throw refusal('argument_invalid', { flag: 'round' }, '--round is required and must be a non-negative integer');
  }
  const round = Number(roundStr);
  if (note === undefined) throw refusal('argument_invalid', { flag: 'note' }, '--note is required');
  if (/\r|\n/.test(note)) throw refusal('argument_invalid', { flag: 'note' }, '--note must not contain a newline');
  if (note.length > MAX_NOTE_LENGTH) throw refusal('argument_invalid', { flag: 'note' }, `--note exceeds ${MAX_NOTE_LENGTH} characters`);

  return withLedgerLock(root, async () => {
    const ledger = readLedger(root);
    if (ledger.availability === 'corrupt') throw refusal('ledger_corrupt', {}, 'the ledger is not valid JSON — left untouched for inspection');
    const list = ledger.availability === 'ok' ? ledger.rawEntries.slice() : [];

    const dup = list.some((e) => e && e.kind === 'external_review' && e.thread_id === threadId && e.round === round);
    if (dup) throw refusal('record_external_duplicate', { thread_id: threadId, round }, 'this (thread_id, round) was already recorded');

    const entry = {
      schema_version: 2,
      entry_id: randomUUID(),
      kind: 'external_review',
      status: 'active',
      recorded_at: new Date().toISOString(),
      provider,
      model: model ?? null,
      thread_id: threadId,
      round,
      note,
      files: files.slice(),
      disposition: null,
    };
    list.push(entry);
    writeLedger(root, list);

    return { json: { ok: true, entry_id: entry.entry_id }, humanLine: `recorded external review ${entry.entry_id}` };
  });
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

function runDigest(rest) {
  checkUnknownFlags(rest, new Set(['json']));
  const ledger = readLedger(root);
  if (ledger.availability === 'absent') throw refusal('ledger_absent', {}, 'no ledger at .sterling/review-ledger.json');
  if (ledger.availability === 'corrupt') throw refusal('ledger_corrupt', {}, 'the ledger is not valid JSON — left untouched for inspection');
  return { digest: ledgerDigest(ledger.raw) };
}

// ---------------------------------------------------------------------------
// reconcile — crash recovery for reserved entries ONLY (A7). Computed
// ATOMICALLY: every reserved entry's outcome is resolved before anything is
// written, so an ambiguous match anywhere aborts the WHOLE run with nothing
// written, rather than partially reconciling.
// ---------------------------------------------------------------------------

function reservationMatchesCommitTree(sha, indexBlobs) {
  for (const [path, expected] of Object.entries(indexBlobs ?? {})) {
    const actual = gitBlobAt(sha, path);
    if (expected === null) {
      if (actual !== null) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

// X1 (review round on fix 8590a004): a commit only genuinely BINDS a
// reservation when it carries what spendAndCommit's own post-commit verify
// would have demanded — the Review-Receipt trailer, the reservation's exact
// tree blobs (both checked to form a CANDIDATE), the roster trailer naming
// this receipt's OWN agent_type, and, for a reservation taken under
// --waive-bytes (reservation.waived), the Review-Bytes-Waiver trailer naming
// it (both checked to promote a candidate to BOUND). The two are kept
// distinct on purpose: a candidate whose bytes/trailer genuinely don't match
// is not this reservation's commit at all (safe to RELEASE, R1-C102's
// "blob-mismatch" arm); a candidate that DOES match receipt+bytes but is
// missing its roster/waiver trailer is a commit that is still out there
// naming this reservation with the right bytes — releasing it would let the
// same evidence be spent a second time, so it must stay RESERVED instead
// (never released, never finalized) until a human resolves it.
function findMatchingCommits(receipt, indexBlobs) {
  const entryId = receipt.entry_id;
  const agentType = receipt.reviewer?.agent_type;
  const waived = receipt.reservation?.waived === true;
  const candidates = [];
  for (const sha of reachableCommits()) {
    const trailers = readCommitTrailers(root, sha);
    if (!trailers.receipt.includes(entryId)) continue;
    if (!reservationMatchesCommitTree(sha, indexBlobs)) continue;
    const missingRoster = typeof agentType === 'string' && !trailers.roster.includes(agentType);
    const missingWaiver = waived && !trailers.waiver.includes(entryId);
    candidates.push({
      sha,
      bound: !missingRoster && !missingWaiver,
      missingTrailer: missingWaiver ? 'Review-Bytes-Waiver' : missingRoster ? 'Reviewed-By-Agent' : null,
    });
  }
  return candidates;
}

async function runReconcile(rest) {
  checkUnknownFlags(rest, new Set(['json']));

  return withLedgerLock(root, async () => {
    const ledger = readLedger(root);
    if (ledger.availability === 'corrupt') throw refusal('ledger_corrupt', {}, 'the ledger is not valid JSON — left untouched for inspection');
    if (ledger.availability === 'absent') return { json: { ok: true, reconciled: [] }, humanLine: 'nothing to reconcile' };

    const classified = ledger.entries;
    const reservedIdxs = [];
    for (let i = 0; i < classified.length; i++) {
      if (classified[i].kind === 'receipt' && classified[i].receipt.status === 'reserved') reservedIdxs.push(i);
    }
    if (reservedIdxs.length === 0) return { json: { ok: true, reconciled: [] }, humanLine: 'nothing to reconcile' };

    const plans = [];
    for (const idx of reservedIdxs) {
      const receipt = classified[idx].receipt;
      const reservation = receipt.reservation;
      const candidates = findMatchingCommits(receipt, reservation?.index_blobs);
      const bound = candidates.filter((c) => c.bound);
      if (bound.length > 1) {
        throw refusal('reconcile_ambiguous', { entry_id: receipt.entry_id, commits: bound.map((c) => c.sha) }, 'more than one commit binds this reservation — resolve by hand');
      }
      if (bound.length === 1) {
        plans.push({ idx, entryId: receipt.entry_id, outcome: 'finalized', sha: bound[0].sha, nonce: reservation.nonce });
        continue;
      }
      // A candidate exists (receipt trailer + exact tree bytes) but is missing
      // the roster/waiver trailer that would BIND it — the commit is real and
      // still out there naming this reservation, so it is neither released
      // (that would let the same bytes be spent again) nor finalized (that
      // would launder a verification failure through the recovery path).
      const unresolved = candidates.find((c) => !c.bound);
      if (unresolved) {
        throw refusal(
          'reconcile_unresolved',
          { entry_id: receipt.entry_id, commit_sha: unresolved.sha, missing_trailer: unresolved.missingTrailer },
          `a commit reachable from HEAD names this reservation and matches its bytes, but is missing its ${unresolved.missingTrailer} trailer — resolve by hand (never released: the commit still names it)`
        );
      }
      plans.push({ idx, entryId: receipt.entry_id, outcome: 'released', nonce: reservation.nonce });
    }

    // X1: every entry sharing a reservation NONCE was reserved together by
    // ONE spendAndCommit invocation and must resolve to the SAME commit — or
    // none may finalize. A split (some members finalizing to different
    // commits, or some finalizing while a sibling releases) means the
    // group's own binding requirements disagree about what actually landed,
    // exactly the shape a commit-msg hook stripping one trailer produces.
    // Checked BEFORE any write, same atomicity as reconcile_ambiguous above.
    const byNonce = new Map();
    for (const plan of plans) {
      if (!byNonce.has(plan.nonce)) byNonce.set(plan.nonce, []);
      byNonce.get(plan.nonce).push(plan);
    }
    for (const [nonce, group] of byNonce) {
      if (group.length < 2) continue;
      const resolutions = new Set(group.map((p) => (p.outcome === 'finalized' ? p.sha : null)));
      if (resolutions.size > 1) {
        throw refusal(
          'reconcile_nonce_split',
          { nonce, entries: group.map((p) => ({ entry_id: p.entryId, outcome: p.outcome, commit_sha: p.sha ?? null })) },
          'entries reserved together under one nonce resolved to different commits — resolve by hand'
        );
      }
    }

    const nowIso = new Date().toISOString();
    const rawEntries = ledger.rawEntries;
    for (const plan of plans) {
      const { reservation, ...rest } = rawEntries[plan.idx];
      // The reservation's index_blobs map already holds exactly the ASSIGNED
      // paths for a scoped spend (fix 8590a004) — its keys ARE consumption.paths,
      // so a reconciled partial-path reservation binds the same paths a clean
      // finalize would have.
      const assignedPaths = Object.keys(reservation?.index_blobs ?? {});
      rawEntries[plan.idx] = plan.outcome === 'finalized'
        ? { ...rest, status: 'consumed', consumption: { commit_sha: plan.sha, consumed_at: nowIso, nonce: plan.nonce, paths: assignedPaths } }
        : { ...rest, status: 'active' };
    }
    writeLedger(root, rawEntries);

    return {
      json: { ok: true, reconciled: plans.map((p) => ({ entry_id: p.entryId, outcome: p.outcome, ...(p.sha ? { commit_sha: p.sha } : {}) })) },
      humanLine: `reconciled ${plans.length} entr${plans.length === 1 ? 'y' : 'ies'}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function emitSuccess(result, jsonMode, verb) {
  if (verb === 'digest') {
    if (jsonMode) console.log(JSON.stringify({ ok: true, digest: result.digest }));
    else process.stdout.write(`${result.digest}\n`);
    return;
  }
  if (jsonMode) {
    const obj = { ...result.json };
    if (sessionOverrideNote) obj.disclosures = [...(obj.disclosures ?? []), toJson(sessionOverrideNote)];
    console.log(JSON.stringify(obj));
  } else {
    console.log(result.humanLine ?? 'ok');
  }
}

function emitFailure(e, jsonMode) {
  const rendered = e && e.kind === 'refusal' ? e : refusal('argument_invalid', { flag: 'internal' }, String(e?.message ?? e));
  if (jsonMode) {
    const obj = toJson(rendered);
    if (sessionOverrideNote) obj.disclosures = [toJson(sessionOverrideNote)];
    console.log(JSON.stringify(obj));
  } else {
    console.error(render(rendered));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);
  let jsonMode = false;
  try {
    jsonMode = safeHasFlag('json', rest);
  } catch (e) {
    emitFailure(e, false);
    process.exitCode = 1;
    return;
  }
  try {
    let result;
    switch (verb) {
      case 'discharge':
        result = await runDischarge(rest);
        break;
      case 'record-external':
        result = await runRecordExternal(rest);
        break;
      case 'digest':
        result = runDigest(rest);
        break;
      case 'reconcile':
        result = await runReconcile(rest);
        break;
      default:
        throw refusal('argument_invalid', { flag: 'verb' }, `unknown verb '${verb ?? ''}' — one of discharge | record-external | digest | reconcile`);
    }
    emitSuccess(result, jsonMode, verb);
    process.exitCode = 0;
  } catch (e) {
    emitFailure(e, jsonMode);
    process.exitCode = 1;
  }
}

main();
