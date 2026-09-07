#!/usr/bin/env node
// scripts/commit-reviewed.mjs — THE SPEND CLI, rebuilt from blank against the
// frozen R1 contract (decision review-receipt-rebuild-invariant-three-owner-
// modules-tri-state-liveness-receipt-bound-supersession, knowledge_get 24dc4c63;
// contract sheet r1-contract-sheet.md §3.2, §6 A8/A9/A13; --target-sha per
// decision post-hoc-review-receipts-target-sha-amend, a899d6cc).
//
// INVARIANT: a commit spends a receipt only when the bytes being committed
// (the staged INDEX in new-commit mode, the TARGET COMMIT'S TREE in amend
// mode) equal the receipt's Stop-time worktree blob for every path it is held
// accountable for, or the operator waives visibly (--waive-bytes, disclosed,
// never silent). Spend is two-phase (reserve under lock -> commit -> verify ->
// finalize under lock) so a crash between commit and finalize leaves the
// receipt RESERVED (never silently lost, never silently double-spent) —
// `review-ledger.mjs reconcile` is the crash-recovery remedy. Every refusal
// and disclosure carries a `[code]` from the closed CODES set (review-errors.mjs).
// DOES NOT GUARANTEE: that a reviewer read the bytes it is credited for whole
// (see review-ledger-entry.mjs); that two invocations racing the SAME receipt
// without the ledger lock cannot both observe it active (the lock is what
// prevents that, and this script always spends under it); that history is
// safe to amend after it is published (the publication guard is advisory-
// proof only, not a lock on the remote).

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { arg, hasFlag } from './lib/project.mjs';
import { refusal, disclosure, render, toJson } from './lib/review-errors.mjs';
import { resolveSessionIdentity, withLedgerLock } from './lib/dispatch-register.mjs';
import {
  readLedger, writeLedger, receiptCoveredPaths, receiptIsSpendable, isCodePath,
  normalizeReceiptPath, isUsableBlobSha,
} from './hooks/lib/review-ledger-entry.mjs';
import { TRAILER, formatTrailerBlock, readCommitTrailers, isSha40 } from './lib/review-trailers.mjs';
import { readAttestationGlobs, inspectAttestations, attestationDisclosureLines } from './lib/attestation-inspection.mjs';

const ROOT = process.cwd();
const STALE_DAYS_DEFAULT = 14;
const MULTI_SPEND_THRESHOLD = 3;
const WAIVE_REASON_MAX = 500;

// ---------------------------------------------------------------------------
// small git plumbing — every call is synchronous, scoped to ROOT.
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000, ...opts });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function gitOk(args, opts = {}) {
  const r = git(args, opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

function stagedPaths() {
  const r = git(['diff', '--cached', '--name-only', '--no-renames', '-z']);
  if (r.code !== 0) return [];
  return [...new Set(r.stdout.split('\0').filter(Boolean).map(normalizeReceiptPath))];
}

function indexBlobMap() {
  const r = git(['ls-files', '-s', '-z']);
  const map = new Map();
  if (r.code !== 0) return map;
  for (const line of r.stdout.split('\0').filter(Boolean)) {
    const m = line.match(/^\d+ ([0-9a-f]{40}) \d+\t(.*)$/s);
    if (m) map.set(normalizeReceiptPath(m[2]), m[1]);
  }
  return map;
}

function targetDiffTreePaths(targetSha) {
  const r = git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', targetSha]);
  if (r.code !== 0) return [];
  return [...new Set(r.stdout.split('\n').filter(Boolean).map(normalizeReceiptPath))];
}
// `git rev-parse` on this host echoes an unrecognized `--end-of-options`
// token back as literal output rather than consuming it (measured: it
// prefixed the printed blob with the literal string) — so this positional is
// guarded by isSha40/tree-relative construction instead of that flag. `sha`
// is always a value this module already resolved through `rev-parse
// --verify` or produced from git itself; `path` never comes from an
// unvalidated ledger field without going through normalizeReceiptPath first.
function treeBlobFor(sha, path) {
  return gitOk(['rev-parse', `${sha}:${path}`]);
}
function committedTreeBlob(sha, path) {
  return gitOk(['rev-parse', `${sha}:${path}`]);
}
// isAncestorOrEqual — A19 sha hygiene: `candidateSha` is ledger-derived
// (identity.base_sha); a value that is not shaped like a real sha never
// reaches git as a positional — it simply reads as "not an ancestor", which
// the caller (isDeferred) already turns into a disclosed receipt_deferred.
function isAncestorOrEqual(candidateSha, ofSha) {
  if (!isSha40(candidateSha)) return false;
  if (candidateSha === ofSha) return true;
  return git(['merge-base', '--is-ancestor', '--end-of-options', candidateSha, ofSha]).code === 0;
}

function readConfig() {
  try {
    const p = join(ROOT, '.sterling', 'config.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function currentBranch() {
  return gitOk(['rev-parse', '--abbrev-ref', 'HEAD']);
}

// ---------------------------------------------------------------------------
// ARGUMENT PARSING — every value flows through the ONE sanctioned parser
// (scripts/lib/project.mjs arg/hasFlag); a caller-thrown duplicate/flag-
// shaped-value error is converted to [argument_invalid] rather than crashing.
// ---------------------------------------------------------------------------

const KNOWN_BOOL_FLAGS = new Set(['--json']);
const KNOWN_VALUE_FLAGS = new Set(['-m', '--message', '--target-sha', '--waive-bytes']);

function findUnknownFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-') || tok === '-' || tok === '--') continue;
    const eq = tok.indexOf('=');
    const bare = eq === -1 ? tok : tok.slice(0, eq);
    if (KNOWN_BOOL_FLAGS.has(bare)) continue;
    if (KNOWN_VALUE_FLAGS.has(bare)) {
      if (eq === -1) i++;
      continue;
    }
    return tok;
  }
  return null;
}

function safeArg(name, argv, flagLabel) {
  try {
    return { value: arg(name, argv) };
  } catch (e) {
    return { error: refusal('argument_invalid', { flag: flagLabel }, e.message) };
  }
}
function safeHasFlag(name, argv, flagLabel) {
  try {
    return { value: hasFlag(name, argv) };
  } catch (e) {
    return { error: refusal('argument_invalid', { flag: flagLabel }, e.message) };
  }
}

function parseArgs(argv) {
  const unknown = findUnknownFlag(argv);
  if (unknown) return { error: refusal('argument_invalid', { flag: unknown }, `unknown flag ${unknown}`) };

  const json = safeHasFlag('--json', argv, '--json');
  if (json.error) return { error: json.error };

  const targetShaProvided = safeHasFlag('--target-sha', argv, '--target-sha');
  if (targetShaProvided.error) return { error: targetShaProvided.error };
  const targetShaVal = safeArg('--target-sha', argv, '--target-sha');
  if (targetShaVal.error) return { error: targetShaVal.error };
  if (targetShaProvided.value && targetShaVal.value === undefined) {
    return { error: refusal('argument_invalid', { flag: '--target-sha' }, '--target-sha requires a value') };
  }

  const mProvided = safeHasFlag('-m', argv, '-m');
  if (mProvided.error) return { error: mProvided.error };
  const messageProvided = safeHasFlag('--message', argv, '--message');
  if (messageProvided.error) return { error: messageProvided.error };
  const anyMessageFlag = mProvided.value || messageProvided.value;

  if (targetShaProvided.value && anyMessageFlag) {
    return { error: refusal('argument_invalid', { flag: '--target-sha' }, '--target-sha and -m/--message are contradictory') };
  }

  const waiveProvided = safeHasFlag('--waive-bytes', argv, '--waive-bytes');
  if (waiveProvided.error) return { error: waiveProvided.error };
  let waiveReason;
  if (waiveProvided.value) {
    const waiveVal = safeArg('--waive-bytes', argv, '--waive-bytes');
    if (waiveVal.error) return { error: waiveVal.error };
    if (waiveVal.value === undefined) {
      return { error: refusal('argument_invalid', { flag: '--waive-bytes' }, '--waive-bytes requires a reason') };
    }
    if (waiveVal.value === '') {
      return { error: refusal('waiver_reason_missing', {}, '--waive-bytes requires a non-empty reason') };
    }
    if (/[\r\n]/.test(waiveVal.value) || waiveVal.value.length > WAIVE_REASON_MAX) {
      return { error: refusal('argument_invalid', { flag: '--waive-bytes' }, '--waive-bytes reason is malformed (embedded newline or overlong)') };
    }
    waiveReason = waiveVal.value;
  }

  // The message-required check is DEFERRED (never refused here): in
  // new-commit mode, `nothing_staged` must win when nothing is staged even if
  // -m was never given — an empty diff needs no message to be told so.
  let message;
  let messageMissing = false;
  if (!targetShaProvided.value) {
    const mVal = safeArg('-m', argv, '-m');
    if (mVal.error) return { error: mVal.error };
    const msgVal = safeArg('--message', argv, '--message');
    if (msgVal.error) return { error: msgVal.error };
    message = mVal.value !== undefined ? mVal.value : msgVal.value;
    messageMissing = message === undefined || message === '';
  }

  return {
    value: {
      json: json.value,
      targetSha: targetShaVal.value,
      message,
      messageMissing,
      waiveReason,
    },
  };
}

// ---------------------------------------------------------------------------
// SELECTION — shared between new-commit and amend mode. `territoryPaths` is
// the set a receipt's territory is checked for overlap against (staged paths,
// or the target commit's own diff-tree); `isDeferred(base_sha)` decides
// whether a receipt's identity.base_sha disqualifies it (strict equality
// against the target sha in amend mode; ancestor-of-current-HEAD in
// new-commit mode, since an intervening unrelated commit must not retire an
// otherwise-good review — R1-D14).
// ---------------------------------------------------------------------------

function selectReceipts({ ledgerEntries, territoryPaths, isDeferred, ctx }) {
  const territorySet = new Set(territoryPaths);
  const disclosures = [];
  const considered = [];
  const selectedUnscoped = [];
  const selectedScoped = []; // {receipt, overlap}
  const noOverlapWithheld = [];
  let legacyCount = 0;

  // Reserved-elsewhere is a RACE, not an ordinary exclusion: it wins over
  // every other classification and refuses the whole run immediately.
  for (const e of ledgerEntries) {
    if (e.kind !== 'receipt') continue;
    const receipt = e.receipt;
    if (receipt.status === 'reserved') {
      const overlaps = receipt.territory.files.length === 0
        || receiptCoveredPaths(receipt).some((p) => territorySet.has(p));
      if (overlaps) {
        return { conflict: refusal('reservation_conflict', { entry_id: receipt.entry_id }, 'a receipt covering this diff is reserved by another operation') };
      }
    }
  }

  for (const e of ledgerEntries) {
    if (e.kind === 'legacy') { legacyCount++; continue; }
    if (e.kind === 'malformed') {
      disclosures.push(disclosure('ledger_entry_malformed', e.facts ?? {}, 'a ledger entry could not be parsed and was skipped'));
      continue;
    }
    if (e.kind !== 'receipt') continue;
    const receipt = e.receipt;

    const spend = receiptIsSpendable(receipt, { session_id: ctx.sessionId, branch: ctx.branch });
    if (!spend.ok) {
      considered.push({ entry_id: receipt.entry_id, code: spend.code });
      if (spend.code === 'receipt_unattributable') disclosures.push(disclosure('receipt_unattributable', { entry_id: receipt.entry_id }));
      else if (spend.code === 'receipt_identity_unknown') disclosures.push(disclosure('receipt_identity_unknown', { entry_id: receipt.entry_id }));
      else if (spend.code === 'receipt_foreign_session' || spend.code === 'receipt_foreign_branch') disclosures.push(disclosure('receipt_foreign', { entry_id: receipt.entry_id }));
      continue;
    }

    if (isDeferred(receipt.identity.base_sha)) {
      considered.push({ entry_id: receipt.entry_id, code: 'receipt_deferred' });
      disclosures.push(disclosure('receipt_deferred', { entry_id: receipt.entry_id }));
      continue;
    }

    if (receipt.territory.files.length === 0) {
      selectedUnscoped.push(receipt);
      disclosures.push(disclosure('receipt_unscoped', { entry_id: receipt.entry_id }));
      continue;
    }

    if (!hasAnyEvidenceAttempt(receipt)) {
      // No evidence was ever RECORDED for any declared path (not merely
      // unusable, and not merely "assigned to a different diff") — a genuine
      // absence, functionally unspendable; it counts toward the
      // no_spendable_receipt exclusion set rather than a coverage gap on THIS
      // diff (R1-D56, distinguished from R1-D34/R1-D60/R1-D69 by whether the
      // receipt ever ATTEMPTED evidence for a declared path at all).
      considered.push({ entry_id: receipt.entry_id, code: 'receipt_no_overlap' });
      disclosures.push(disclosure('receipt_no_overlap', { entry_id: receipt.entry_id }));
      continue;
    }
    const covered = receiptCoveredPaths(receipt);
    const overlap = covered.filter((p) => territorySet.has(p));
    if (overlap.length === 0) {
      noOverlapWithheld.push(receipt);
      disclosures.push(disclosure('receipt_no_overlap', { entry_id: receipt.entry_id }));
      continue;
    }
    selectedScoped.push({ receipt, overlap });
  }

  if (legacyCount > 0) disclosures.push(disclosure('legacy_entries_present', { count: legacyCount }));

  const v2ReceiptsCount = ledgerEntries.filter((e) => e.kind === 'receipt').length;
  const selected = [...selectedUnscoped, ...selectedScoped.map((s) => s.receipt)];

  return {
    conflict: null, disclosures, considered, selectedUnscoped, selectedScoped, selected,
    noOverlapWithheld, v2ReceiptsCount,
  };
}

// ---------------------------------------------------------------------------
// COVERAGE + BYTE RULE
// ---------------------------------------------------------------------------

function effectiveReceiptBlobFor(receipt, path) {
  const blobs = receipt.content_evidence?.blobs || {};
  const matches = [];
  for (const [k, v] of Object.entries(blobs)) {
    if (normalizeReceiptPath(k) === path) matches.push(v);
  }
  const usable = [...new Set(matches.filter(isUsableBlobSha))];
  if (usable.length > 1) return { kind: 'conflict', values: usable };
  if (usable.length === 1) return { kind: 'sha', value: usable[0] };
  const absentPaths = (receipt.content_evidence?.absent_paths || []).map(normalizeReceiptPath);
  if (absentPaths.includes(path)) return { kind: 'absent' };
  return { kind: 'none' };
}

// priorReceiptMatchesTree — A18 H2: does a PRIOR (already-consumed) receipt's
// covered-path evidence still equal the given tree? Used only for the amend
// re-bind's fail-closed pre-check (R1-D113); a receipt with no covered paths
// at all trivially matches (nothing to disagree about).
function priorReceiptMatchesTree(receipt, sha) {
  const covered = receiptCoveredPaths(receipt);
  for (const p of covered) {
    const side = effectiveReceiptBlobFor(receipt, p);
    const actual = treeBlobFor(sha, p);
    if (side.kind === 'sha') {
      if (actual !== side.value) return false;
    } else if (side.kind === 'absent') {
      if (actual !== null) return false;
    } else {
      return false;
    }
  }
  return true;
}

// getComparisonBlob(path) -> 40-hex sha | null (absent)
function computeByteRule(selection, codePaths, getComparisonBlob) {
  const mismatches = [];
  const coveredByCode = new Set();
  for (const { receipt, overlap } of selection.selectedScoped) {
    for (const p of overlap) {
      coveredByCode.add(p);
      const side = effectiveReceiptBlobFor(receipt, p);
      const actual = getComparisonBlob(p); // sha or null
      let match = false;
      let receiptBlobFact = 'absent';
      if (side.kind === 'sha') {
        receiptBlobFact = side.value;
        match = actual !== null && actual === side.value;
      } else if (side.kind === 'absent') {
        receiptBlobFact = 'absent';
        match = actual === null;
      } else if (side.kind === 'conflict') {
        receiptBlobFact = side.values[0];
        match = false;
      }
      if (!match) mismatches.push({ path: p, receipt_blob: receiptBlobFact, index_blob: actual ?? 'absent' });
    }
  }
  const uncovered = codePaths.filter((p) => !coveredByCode.has(p));
  return { mismatches, uncovered };
}

// ---------------------------------------------------------------------------
// STALENESS / AGE DISCLOSURES
// ---------------------------------------------------------------------------

function ageDisclosuresFor(receipt, staleDays) {
  const out = [];
  const startedMs = Date.parse(receipt.started_at);
  const finishedRaw = receipt.finished_at;
  const finishedMs = typeof finishedRaw === 'string' ? Date.parse(finishedRaw) : NaN;
  let unverifiable = false;
  if (typeof finishedRaw !== 'string' || Number.isNaN(finishedMs)) unverifiable = true;
  else if (!Number.isNaN(startedMs) && (finishedMs < startedMs || finishedMs > Date.now())) unverifiable = true;

  let ageMs = null;
  if (unverifiable) {
    out.push(disclosure('receipt_age_unverifiable', { entry_id: receipt.entry_id }));
    ageMs = Number.isNaN(startedMs) ? null : Date.now() - startedMs;
  } else {
    ageMs = Date.now() - finishedMs;
  }
  if (ageMs !== null && ageMs > staleDays * 24 * 3_600_000) {
    out.push(disclosure('receipt_stale', { entry_id: receipt.entry_id }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// TRAILER TEXT HELPERS (amend mode: preserve + extend the trailer paragraph)
// ---------------------------------------------------------------------------

function commitRawMessage(sha) {
  const r = git(['cat-file', 'commit', sha]);
  if (r.code !== 0) return null;
  const idx = r.stdout.indexOf('\n\n');
  return idx === -1 ? '' : r.stdout.slice(idx + 2);
}
function parseTrailersFromText(text) {
  const r = git(['interpret-trailers', '--parse'], { input: text });
  const out = { roster: [], waiver: [], receipt: [] };
  if (r.code !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([^:]+):\s?(.*)$/);
    if (!m) continue;
    if (m[1] === TRAILER.roster) out.roster.push(m[2].trim());
    else if (m[1] === TRAILER.waiver) out.waiver.push(m[2].trim());
    else if (m[1] === TRAILER.receipt) out.receipt.push(m[2].trim());
  }
  return out;
}
function mergeTrailers(originalText, block) {
  const args = ['interpret-trailers', '--if-exists=add'];
  for (const v of block.roster) args.push('--trailer', `${TRAILER.roster}: ${v}`);
  for (const v of block.waiver) args.push('--trailer', `${TRAILER.waiver}: ${v}`);
  for (const v of block.receipt) args.push('--trailer', `${TRAILER.receipt}: ${v}`);
  const r = git(args, { input: originalText });
  if (r.code !== 0) return null;
  // git interpret-trailers appends exactly one trailing newline of its own;
  // strip that single artifact so a round-trip through %B stays byte-faithful.
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

// ---------------------------------------------------------------------------
// ATTESTATION DISCLOSURE (fail-open, never a refusal — decision 1f069af4)
// ---------------------------------------------------------------------------

function attestationLines(touchedPaths, subject) {
  try {
    const { globs, dropped } = readAttestationGlobs(ROOT);
    const result = inspectAttestations({ projectRoot: ROOT, touchedPaths, declaredGlobs: globs });
    return attestationDisclosureLines({ tool: 'commit-reviewed', result, declaredGlobs: globs, subject, dropped });
  } catch (e) {
    return attestationDisclosureLines({
      tool: 'commit-reviewed', result: { available: false, reason: e?.message ?? String(e) },
      declaredGlobs: [], subject, dropped: {},
    });
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { code: 1, refusalObj: parsed.error };
  const { json, targetSha, message, messageMissing, waiveReason } = parsed.value;

  if (!existsSync(join(ROOT, '.sterling'))) {
    return { code: 1, refusalObj: refusal('not_sterling_project', {}, 'no .sterling/ at the project root') };
  }

  // A19/A20: THE ONE session-identity resolver, shared with review-ledger.mjs
  // so the two CLIs cannot drift — env wins for session_id; `override` is
  // true only on a genuine disagreement (env set AND a marker exists AND
  // they differ), which is exactly when the disclosure below fires.
  const identity = resolveSessionIdentity(ROOT);
  const ctx = { sessionId: identity.session_id, branch: currentBranch() };
  const config = readConfig();

  const result = targetSha
    ? await runAmend({ targetSha, waiveReason, json, ctx, config })
    : await runNewCommit({ message, messageMissing, waiveReason, json, ctx, config });

  // A19: any GENUINE override of session identity is disclosed — never
  // silent — in both the human and --json channels, on every outcome
  // (refusal or success), since it changes which receipts read as foreign.
  if (identity.override) {
    const sessionOverride = disclosure('session_identity_override', { var: 'STERLING_SESSION_ID' }, 'STERLING_SESSION_ID disagrees with the session marker and won');
    result.disclosures = [sessionOverride, ...(result.disclosures ?? [])];
    if (result.success) result.success.disclosures = [sessionOverride, ...(result.success.disclosures ?? [])];
  }
  return result;
}

// hasAnyEvidenceAttempt — did content_evidence ever RECORD something for at
// least one declared path (a blobs KEY present, whether or not its value is
// usable, or absent_paths membership)? Distinguishes a genuine evidence
// ABSENCE (R1-D56: no_spendable_receipt) from an ATTEMPTED-but-unusable
// value (R1-D60: coverage_incomplete, since a bad sha still leaves the path
// eligible for a fresh review round rather than reading as "never reviewed").
function hasAnyEvidenceAttempt(receipt) {
  const files = Array.isArray(receipt?.territory?.files) ? receipt.territory.files : [];
  const blobs = receipt?.content_evidence?.blobs && typeof receipt.content_evidence.blobs === 'object' && !Array.isArray(receipt.content_evidence.blobs)
    ? receipt.content_evidence.blobs : {};
  const absentPaths = new Set((receipt?.content_evidence?.absent_paths || []).map(normalizeReceiptPath));
  for (const f of files) {
    const n = normalizeReceiptPath(f);
    if (Object.prototype.hasOwnProperty.call(blobs, f) || Object.prototype.hasOwnProperty.call(blobs, n)) return true;
    if (absentPaths.has(n)) return true;
  }
  return false;
}

function loadLedgerOrRefusal() {
  const l = readLedger(ROOT);
  if (l.availability === 'corrupt') return { error: refusal('ledger_corrupt', {}, 'the review ledger could not be parsed') };
  return { entries: l.entries };
}

async function runNewCommit({ message, messageMissing, waiveReason, json, ctx, config }) {
  const staged = stagedPaths();
  if (staged.length === 0) {
    return { code: 1, refusalObj: refusal('nothing_staged', {}, 'nothing is staged') };
  }
  if (messageMissing) {
    return { code: 1, refusalObj: refusal('message_missing', {}, '-m/--message is required') };
  }
  const codePaths = staged.filter((p) => isCodePath(p, config));

  const ledgerLoad = loadLedgerOrRefusal();
  if (ledgerLoad.error) return { code: 1, refusalObj: ledgerLoad.error };

  const headSha = gitOk(['rev-parse', 'HEAD']);
  const selection = selectReceipts({
    ledgerEntries: ledgerLoad.entries, territoryPaths: staged,
    isDeferred: (baseSha) => !isAncestorOrEqual(baseSha, headSha), ctx,
  });
  if (selection.conflict) return { code: 1, refusalObj: selection.conflict };

  if (selection.selected.length === 0) {
    if (selection.v2ReceiptsCount > 0 && selection.noOverlapWithheld.length > 0) {
      return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('coverage_incomplete', { uncovered: codePaths, considered: [] }, 'no selected receipt covers the staged code') };
    }
    return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('no_spendable_receipt', { considered: selection.considered }, 'no spendable receipt') };
  }

  const indexBlobs = indexBlobMap();
  const byteRule = computeByteRule(selection, codePaths, (p) => indexBlobs.get(p) ?? null);

  const unscopedConsidered = selection.selectedUnscoped.map((r) => ({ entry_id: r.entry_id, code: 'receipt_unscoped' }));
  if (byteRule.uncovered.length > 0) {
    return {
      code: 1, disclosures: selection.disclosures,
      refusalObj: refusal('coverage_incomplete', { uncovered: byteRule.uncovered, considered: [...selection.considered, ...unscopedConsidered] }, 'a staged code path is not covered by any selected receipt'),
    };
  }

  let waivedIds = [];
  if (byteRule.mismatches.length > 0) {
    if (!waiveReason) {
      return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('receipt_bytes_mismatch', { mismatches: byteRule.mismatches }, 'staged bytes do not match the reviewed bytes') };
    }
    waivedIds = [...new Set(selection.selectedScoped
      .filter((s) => byteRule.mismatches.some((m) => s.overlap.includes(m.path)))
      .map((s) => s.receipt.entry_id))];
  }

  const disclosures = [...selection.disclosures];
  if (waivedIds.length > 0) disclosures.push(disclosure('bytes_waived', { entry_ids: waivedIds, reason: waiveReason }));
  if (selection.selected.length > MULTI_SPEND_THRESHOLD) disclosures.push(disclosure('multi_spend', { count: selection.selected.length }));
  const staleDays = typeof config?.review_ledger?.stale_days === 'number' ? config.review_ledger.stale_days : STALE_DAYS_DEFAULT;
  for (const r of selection.selected) disclosures.push(...ageDisclosuresFor(r, staleDays));

  return spendAndCommit({
    json, message, selection, waivedIds, disclosures,
    reservationIndexBlobsFor: (receipt, overlap) => {
      const map = {};
      for (const p of overlap) map[p] = indexBlobs.get(p) ?? null;
      return map;
    },
    buildMessage: () => `${message}\n\n${formatTrailerBlock({
      roster: selection.selected.map((r) => r.reviewer.agent_type),
      waiver: waivedIds,
      receipt: selection.selected.map((r) => r.entry_id),
    })}`,
    commitAndGetSha: (fullMessage) => {
      const before = gitOk(['rev-parse', 'HEAD']);
      const c = git(['commit', '--cleanup=verbatim', '-F', '-'], { input: fullMessage });
      if (c.code !== 0) return { ok: false, error: c.stderr || c.stdout || `git commit exited ${c.code}` };
      const after = gitOk(['rev-parse', 'HEAD']);
      if (after === before) return { ok: false, error: 'no new commit was created' };
      const revs = gitOk(['rev-list', `${before}..HEAD`])?.split('\n').filter(Boolean) ?? [];
      const sha = revs.length > 0 ? revs[revs.length - 1] : after;
      return { ok: true, sha };
    },
    attestationSubject: 'the staged bytes',
    attestationTouched: staged,
  });
}

async function runAmend({ targetSha, waiveReason, json, ctx, config }) {
  const resolved = gitOk(['rev-parse', '--verify', '--end-of-options', `${targetSha}^{commit}`]);
  if (!resolved) return { code: 1, refusalObj: refusal('target_sha_unresolvable', {}, `--target-sha ${targetSha} does not resolve to a commit`) };

  const headSha = gitOk(['rev-parse', 'HEAD']);
  if (resolved !== headSha) return { code: 1, refusalObj: refusal('target_sha_not_head', {}, '--target-sha must be the checked-out branch tip') };

  const dirtyIndex = git(['diff', '--cached', '--name-only']).stdout.trim() !== '';
  const dirtyWorktree = git(['diff', '--name-only']).stdout.trim() !== '';
  if (dirtyIndex || dirtyWorktree) return { code: 1, refusalObj: refusal('target_sha_tree_dirty', {}, 'the index and worktree must be clean to amend') };

  const pubCheck = checkPublicationGuard(resolved);
  if (pubCheck.refusal) return { code: 1, refusalObj: pubCheck.refusal };

  const originalText = commitRawMessage(resolved) ?? '';
  const priorTrailers = parseTrailersFromText(originalText);

  const ledgerLoad = loadLedgerOrRefusal();
  if (ledgerLoad.error) return { code: 1, refusalObj: ledgerLoad.error };

  // A13/A18 RE-BIND, fail-closed BEFORE amending: every prior Review-Receipt
  // trailer must resolve to a receipt consumed for the OLD sha AND whose
  // covered-path blobs still equal the amended tree (which --amend preserves
  // exactly, per the clean-tree guard above) — presence and status alone are
  // not enough; a receipt that never matched the tree must not be carried
  // forward into a NEW sha (R1-D113).
  const byId = new Map();
  for (const e of ledgerLoad.entries) if (e.kind === 'receipt') byId.set(e.receipt.entry_id, e.receipt);
  for (const priorId of priorTrailers.receipt) {
    const priorReceipt = byId.get(priorId);
    const boundOk = priorReceipt && priorReceipt.status === 'consumed' && priorReceipt.consumption?.commit_sha === resolved
      && priorReceiptMatchesTree(priorReceipt, resolved);
    if (!boundOk) {
      return { code: 1, refusalObj: refusal('target_sha_prior_receipt_unbound', { entry_id: priorId }, 'a preserved Review-Receipt trailer names a receipt not consumed for the old sha, or whose bytes do not match the amended tree') };
    }
  }

  const targetPaths = targetDiffTreePaths(resolved);
  const codePaths = targetPaths.filter((p) => isCodePath(p, config));

  const selection = selectReceipts({
    ledgerEntries: ledgerLoad.entries, territoryPaths: targetPaths,
    isDeferred: (baseSha) => baseSha !== resolved, ctx,
  });
  if (selection.conflict) return { code: 1, refusalObj: selection.conflict };

  if (selection.selected.length === 0) {
    if (selection.v2ReceiptsCount > 0 && selection.noOverlapWithheld.length > 0) {
      return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('coverage_incomplete', { uncovered: codePaths, considered: [] }, 'no selected receipt covers the target diff') };
    }
    return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('no_spendable_receipt', { considered: selection.considered }, 'no spendable receipt') };
  }

  const byteRule = computeByteRule(selection, codePaths, (p) => treeBlobFor(resolved, p));
  const unscopedConsidered = selection.selectedUnscoped.map((r) => ({ entry_id: r.entry_id, code: 'receipt_unscoped' }));
  if (byteRule.uncovered.length > 0) {
    return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('coverage_incomplete', { uncovered: byteRule.uncovered, considered: [...selection.considered, ...unscopedConsidered] }, 'the target diff is not fully covered') };
  }

  let waivedIds = [];
  if (byteRule.mismatches.length > 0) {
    if (!waiveReason) {
      return { code: 1, disclosures: selection.disclosures, refusalObj: refusal('receipt_bytes_mismatch', { mismatches: byteRule.mismatches }, 'target tree bytes do not match the reviewed bytes') };
    }
    waivedIds = [...new Set(selection.selectedScoped
      .filter((s) => byteRule.mismatches.some((m) => s.overlap.includes(m.path)))
      .map((s) => s.receipt.entry_id))];
  }

  const disclosures = [...selection.disclosures];
  if (waivedIds.length > 0) disclosures.push(disclosure('bytes_waived', { entry_ids: waivedIds, reason: waiveReason }));
  if (selection.selected.length > MULTI_SPEND_THRESHOLD) disclosures.push(disclosure('multi_spend', { count: selection.selected.length }));
  const staleDays = typeof config?.review_ledger?.stale_days === 'number' ? config.review_ledger.stale_days : STALE_DAYS_DEFAULT;
  for (const r of selection.selected) disclosures.push(...ageDisclosuresFor(r, staleDays));

  return spendAndCommit({
    json, message: null, selection, waivedIds, disclosures,
    reservationIndexBlobsFor: (receipt, overlap) => {
      const map = {};
      for (const p of overlap) map[p] = treeBlobFor(resolved, p);
      return map;
    },
    buildMessage: () => mergeTrailers(originalText, {
      roster: selection.selected.map((r) => r.reviewer.agent_type),
      waiver: waivedIds,
      receipt: selection.selected.map((r) => r.entry_id),
    }),
    commitAndGetSha: (fullMessage) => {
      if (fullMessage === null) return { ok: false, error: 'trailer merge failed' };
      const c = git(['commit', '--amend', '--cleanup=verbatim', '-F', '-'], { input: fullMessage });
      if (c.code !== 0) return { ok: false, error: c.stderr || c.stdout || `git commit --amend exited ${c.code}` };
      const sha = gitOk(['rev-parse', 'HEAD']);
      return { ok: true, sha };
    },
    attestationSubject: 'the target commit tree',
    attestationTouched: targetPaths,
    amend: { oldSha: resolved, rebind: priorTrailers.receipt.filter((id) => byId.has(id)) },
  });
}

function checkPublicationGuard(targetSha) {
  const seamOn = process.env.STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM === '1';
  const branch = currentBranch();
  const remoteName = gitOk(['config', `branch.${branch}.remote`]);
  const mergeRef = gitOk(['config', `branch.${branch}.merge`]);
  if (!remoteName || !mergeRef) {
    if (seamOn) return {};
    return { refusal: refusal('target_sha_publication_unprovable', {}, 'no upstream is configured') };
  }
  const lsRemote = git(['ls-remote', '--', remoteName, mergeRef]);
  const line = lsRemote.code === 0 ? lsRemote.stdout.trim().split('\n').filter(Boolean) : [];
  const m = line.length === 1 ? line[0].match(/^([0-9a-f]{40})\t(\S+)$/) : null;
  if (!m) {
    if (seamOn) return {};
    return { refusal: refusal('target_sha_publication_unprovable', {}, 'the upstream ref could not be read') };
  }
  const remoteSha = m[1];
  const isAncestor = git(['merge-base', '--is-ancestor', '--end-of-options', targetSha, remoteSha]).code === 0;
  if (isAncestor) return { refusal: refusal('target_sha_published', {}, 'the target commit is reachable from the published upstream ref') };
  return {};
}

// spendAndCommit — the shared two-phase reserve/commit/verify/finalize body.
async function spendAndCommit({
  json, selection, waivedIds, disclosures, reservationIndexBlobsFor, buildMessage, commitAndGetSha,
  attestationSubject, attestationTouched, amend,
}) {
  let nonce;
  let reservedIds;
  let indexBlobsById;
  try {
    const result = await withLedgerLock(ROOT, () => {
      const l = readLedger(ROOT);
      const rawEntries = l.rawEntries.slice();
      const freshByEntryId = new Map();
      for (const ce of l.entries) if (ce.kind === 'receipt') freshByEntryId.set(ce.receipt.entry_id, ce);
      // A18 RE-VALIDATION: re-check status UNDER THE LOCK. THIS IS ALL-OR-
      // NOTHING — buildMessage() below stamps a Reviewed-By-Agent/Review-
      // Receipt/waiver line for EVERY entry in selection.selected, so
      // reserving only a SUBSET would commit a Review-Receipt trailer for a
      // receipt that was never actually reserved (direct-merge later refuses
      // that as unbound). A receipt no longer `active` here is NEVER
      // overwritten, and NOTHING is reserved when any one of them fails —
      // ledger byte-identical, refuse before any write.
      const notFoundIds = [];
      const notActiveDetails = [];
      for (const r of selection.selected) {
        const fresh = freshByEntryId.get(r.entry_id);
        if (!fresh) { notFoundIds.push(r.entry_id); continue; }
        if (fresh.receipt.status !== 'active') notActiveDetails.push({ entry_id: r.entry_id, status: fresh.receipt.status });
      }
      if (notFoundIds.length > 0) {
        throw refusal('entry_not_found', { entry_id: notFoundIds[0], entry_ids: notFoundIds }, 'a selected receipt could not be found under the lock');
      }
      if (notActiveDetails.length > 0) {
        throw refusal('reservation_conflict', { entry_ids: notActiveDetails.map((d) => d.entry_id), statuses: notActiveDetails }, 'a selected receipt is no longer active under the lock — nothing is reserved');
      }
      nonce = randomBytes(8).toString('hex');
      const at = new Date().toISOString();
      const blobsById = {};
      const ids = selection.selected.map((r) => r.entry_id);
      for (const id of ids) {
        const idx = freshByEntryId.get(id).index;
        const entry = rawEntries[idx];
        const overlap = selection.selectedScoped.find((s) => s.receipt.entry_id === id)?.overlap ?? [];
        const indexBlobs = reservationIndexBlobsFor(entry, overlap);
        blobsById[id] = indexBlobs;
        rawEntries[idx] = { ...entry, status: 'reserved', reservation: { nonce, at, operation: 'commit-reviewed', index_blobs: indexBlobs } };
      }
      writeLedger(ROOT, rawEntries);
      return { ids, blobsById };
    });
    reservedIds = result.ids;
    indexBlobsById = result.blobsById;
  } catch (e) {
    return { code: 1, disclosures, refusalObj: isReviewErrorLike(e) ? e : refusal('ledger_lock_held', { }, e?.message ?? String(e)) };
  }

  const fullMessage = buildMessage();
  const committed = commitAndGetSha(fullMessage);
  if (!committed.ok) {
    // A18 RELEASE: re-read FRESH under the lock and clear ONLY the
    // reservations carrying THIS run's nonce — never a snapshot restore,
    // which would erase anything a concurrent writer appended meanwhile.
    try {
      await withLedgerLock(ROOT, () => {
        const l = readLedger(ROOT);
        const rawEntries = l.rawEntries.slice();
        for (let i = 0; i < rawEntries.length; i++) {
          const entry = rawEntries[i];
          if (entry && entry.status === 'reserved' && entry.reservation?.nonce === nonce) {
            const { reservation, ...rest } = entry;
            rawEntries[i] = { ...rest, status: 'active' };
          }
        }
        writeLedger(ROOT, rawEntries);
      });
    } catch {
      // best-effort release; the lock's own diagnostics cover a stuck case
    }
    return { code: 1, disclosures, refusalObj: refusal('commit_failed', {}, String(committed.error)) };
  }
  const sha = committed.sha;

  const trailers = readCommitTrailers(ROOT, sha);
  const missing = [];
  const expectedReceiptIds = reservedIds;
  for (const id of expectedReceiptIds) if (!trailers.receipt.includes(id)) missing.push(`${TRAILER.receipt}:${id}`);
  // The commit's Review-Receipt trailers must equal reservedIds EXACTLY (plus
  // any amend-preserved prior receipts, which are legitimately re-bound, not
  // reserved by this run) — an extra one naming a receipt this run never
  // reserved or preserved is just as unbound as a missing one, and
  // direct-merge refuses it the same way.
  const allowedReceiptIds = new Set([...expectedReceiptIds, ...(amend?.rebind ?? [])]);
  for (const id of trailers.receipt) if (!allowedReceiptIds.has(id)) missing.push(`unexpected:${TRAILER.receipt}:${id}`);
  const selectedById = new Map(selection.selected.map((r) => [r.entry_id, r]));
  const expectedRoster = reservedIds.map((id) => selectedById.get(id)?.reviewer?.agent_type);
  for (const v of expectedRoster) {
    const idx = trailers.roster.indexOf(v);
    if (idx === -1) missing.push(`${TRAILER.roster}:${v}`);
    else trailers.roster.splice(idx, 1);
  }
  for (const id of waivedIds) if (!trailers.waiver.includes(id)) missing.push(`${TRAILER.waiver}:${id}`);

  // A18: VERIFY THE COMMITTED TREE — the reservation's index_blobs (exactly
  // what was staged at reserve time) must equal what actually landed. A
  // pre-commit hook (formatter/linter) that rewrites a covered file after
  // reservation must never be silently spent as "reviewed".
  const differences = [];
  for (const id of reservedIds) {
    const indexBlobs = indexBlobsById[id] ?? {};
    for (const [path, expected] of Object.entries(indexBlobs)) {
      const actual = committedTreeBlob(sha, path);
      if (actual !== expected) differences.push({ path, expected: expected ?? null, actual: actual ?? null });
    }
  }

  if (missing.length > 0 || differences.length > 0) {
    return {
      code: 1, disclosures,
      refusalObj: refusal('commit_verify_failed', { missing_trailers: missing, differences, remedy: 'run scripts/review-ledger.mjs reconcile' }, 'the committed trailer block or tree does not survive verification'),
    };
  }

  try {
    await withLedgerLock(ROOT, () => {
      const l = readLedger(ROOT);
      const rawEntries = l.rawEntries.slice();
      const indexByEntryId = new Map();
      for (const ce of l.entries) if (ce.kind === 'receipt') indexByEntryId.set(ce.receipt.entry_id, ce.index);
      // A18 FINALIZE ACCOUNTING: every reserved id must still be found
      // `reserved` under THIS run's nonce, or the whole finalize refuses —
      // never a silent exit 0 with an unbound Review-Receipt trailer. THE
      // COMMIT ALREADY EXISTS at this point (finalize runs post-commit) —
      // this CLI cannot un-create it (that would contradict the established
      // "leave reserved, remedy is reconcile" contract of D105/D109 for the
      // single-entry case). What it CAN and MUST do for a MULTI-receipt spend
      // (R1-D115) is never leave the OTHER, still-genuinely-reserved entries
      // stuck: it releases them back to active (this spend is all-or-nothing)
      // and refuses naming the one that moved — never silently finalizing a
      // partial set, and never overwriting whatever the other writer settled.
      const unaccounted = [];
      let anyConsumedElsewhere = false;
      for (const id of reservedIds) {
        const idx = indexByEntryId.get(id);
        const entry = idx !== undefined ? rawEntries[idx] : undefined;
        if (!entry || entry.status !== 'reserved' || entry.reservation?.nonce !== nonce) {
          unaccounted.push(id);
          if (entry?.status === 'consumed') anyConsumedElsewhere = true;
        }
      }
      if (unaccounted.length > 0) {
        for (const id of reservedIds) {
          if (unaccounted.includes(id)) continue; // never touch the one that moved
          const idx = indexByEntryId.get(id);
          const entry = rawEntries[idx];
          if (entry && entry.status === 'reserved' && entry.reservation?.nonce === nonce) {
            const { reservation, ...rest } = entry;
            rawEntries[idx] = { ...rest, status: 'active' };
          }
        }
        writeLedger(ROOT, rawEntries);
        const code = anyConsumedElsewhere ? 'reservation_conflict' : 'finalize_failed';
        const facts = code === 'reservation_conflict'
          ? { entry_ids: unaccounted }
          : { entry_id: unaccounted, remedy: 'run scripts/review-ledger.mjs reconcile' };
        throw refusal(code, facts, 'a reserved entry was settled by another operation before finalize — the rest of this spend is released, never partially bound');
      }
      const consumedAt = new Date().toISOString();
      for (const id of reservedIds) {
        const idx = indexByEntryId.get(id);
        const entry = rawEntries[idx];
        const { reservation, ...rest } = entry;
        rawEntries[idx] = { ...rest, status: 'consumed', consumption: { commit_sha: sha, consumed_at: consumedAt, nonce } };
      }
      if (amend) {
        // Re-check UNDER THE LOCK that each prior receipt is still consumed
        // for the OLD sha before rewriting its consumption — a concurrent
        // discharge/reconcile between the pre-amend check and finalize must
        // not be silently carried forward onto the new sha.
        const unbound = [];
        for (const priorId of amend.rebind) {
          const idx = indexByEntryId.get(priorId);
          const entry = idx !== undefined ? rawEntries[idx] : undefined;
          if (!entry || entry.status !== 'consumed' || entry.consumption?.commit_sha !== amend.oldSha) unbound.push(priorId);
        }
        if (unbound.length > 0) {
          throw refusal('finalize_failed', { entry_id: unbound, remedy: 'run scripts/review-ledger.mjs reconcile' }, 'a prior receipt is no longer consumed for the old sha — nothing was re-bound');
        }
        for (const priorId of amend.rebind) {
          const idx = indexByEntryId.get(priorId);
          rawEntries[idx] = { ...rawEntries[idx], consumption: { ...rawEntries[idx].consumption, commit_sha: sha } };
        }
      }
      writeLedger(ROOT, rawEntries);
    });
  } catch (e) {
    return {
      code: 1, disclosures,
      refusalObj: isReviewErrorLike(e) ? e : refusal('finalize_failed', { reserved: reservedIds, remedy: 'run scripts/review-ledger.mjs reconcile' }, e?.message ?? String(e)),
    };
  }

  const attestation = attestationLines(attestationTouched, attestationSubject);
  // A18 SUCCESS REPORT: {commit_sha, reviewed_by, receipts, waived, disclosures}
  // — reviewed_by/receipts are built from the FINAL stamped set (reservedIds),
  // which may be narrower than selection.selected if reserve-time
  // re-validation excluded a receipt raced to a terminal state.
  const successJson = {
    ok: true,
    commit_sha: sha,
    reviewed_by: reservedIds.map((id) => selectedById.get(id)?.reviewer?.agent_type),
    receipts: [...reservedIds],
    waived: [...waivedIds],
    disclosures,
    attestation_disclosure: attestation,
  };
  if (amend) { successJson.old_sha = amend.oldSha; successJson.new_sha = sha; }
  return { code: 0, success: successJson, disclosures, attestation };
}

function isReviewErrorLike(e) {
  return e && typeof e === 'object' && e.kind === 'refusal';
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

run(process.argv.slice(2)).then((result) => {
  const wantsJson = process.argv.slice(2).some((t) => t === '--json' || t.startsWith('--json='));
  for (const d of result.disclosures ?? []) console.error(render(d));
  if (result.refusalObj) {
    if (wantsJson) {
      const out = toJson(result.refusalObj);
      out.disclosures = result.disclosures ?? [];
      console.log(JSON.stringify(out));
    } else {
      console.error(render(result.refusalObj));
    }
    process.exitCode = 1;
    return;
  }
  for (const line of result.attestation ?? []) console.error(line);
  // The success report is ALWAYS a JSON object on stdout, --json or not — the
  // pre-rebuild contract this preserves (attestation-disclosure-wiring.test.mjs
  // parses stdout without passing --json); --json governs REFUSAL formatting.
  console.log(JSON.stringify(result.success));
  process.exitCode = result.code;
}).catch((e) => {
  console.error(`commit-reviewed: unexpected failure: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
