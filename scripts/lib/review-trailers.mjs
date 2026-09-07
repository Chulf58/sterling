// scripts/lib/review-trailers.mjs — THE ONE trailer owner: the three commit
// trailer keys the review-receipt mechanism reads and writes, the roster
// value predicate, and the read/write pair that must never disagree.
//
// INVARIANT: exactly THREE trailer keys exist (Reviewed-By-Agent,
// Review-Bytes-Waiver, Review-Receipt), spelled once, here — every consumer
// (commit-reviewed, direct-merge, the supersession verifier) imports this
// module rather than declaring its own copy of any of the three. A roster
// value is recognized by ONE stateless predicate shared between the reader
// and the writer.
// DOES NOT GUARANTEE: that a trailer surviving in a commit message was not
// stripped or altered by a hook outside this mechanism's control; that
// `readCommitTrailers` reflects anything but the NAMED commit's own message
// (it never reads HEAD implicitly, and it never walks history).

import { spawnSync } from 'node:child_process';
import { receiptCoveredPaths, normalizeReceiptPath } from '../hooks/lib/review-ledger-entry.mjs';

export const TRAILER = { roster: 'Reviewed-By-Agent', waiver: 'Review-Bytes-Waiver', receipt: 'Review-Receipt' };

// A bare `reviewer-<class>` (what commit-reviewed stamps) or a decorated
// value (hand-written / post-hoc receipts, e.g. "reviewer-correctness (opus)
// — findings adjudicated") both count; free prose mentioning a reviewer does
// not, and neither does a bare 'reviewer-' with no class named. The whole
// value must be a SINGLE LINE — `.` excludes line terminators (\n, \r,
// U+2028, U+2029) by spec, so an embedded newline anywhere (before OR after
// the token) fails the match; the token itself ends at a space/tab or
// end-of-string, never at a bare `\s` (the old boundary let a newline
// masquerade as a valid separator, smuggling extra lines into a trailer).
export const ROSTER_TRAILER_VALUE = /^reviewer-[A-Za-z0-9_-]+(?:[ \t].*)?$/;

export function isRosterTrailerValue(v) {
  if (typeof v !== 'string') return false;
  return ROSTER_TRAILER_VALUE.test(v);
}

// isSha40 — the ONE sha-shape gate every git call in this module validates
// against before a ledger/CLI-influenced value reaches a positional argument.
export function isSha40(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
}

function readOneKey(cwd, sha, key) {
  const r = spawnSync('git', ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha], { cwd, encoding: 'utf8' });
  const out = r.status === 0 ? r.stdout ?? '' : '';
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// readCommitTrailers(cwd, sha) — every value for each of the three keys, in
// commit order, for the NAMED commit only. Absence is [], never undefined.
export function readCommitTrailers(cwd, sha) {
  return {
    roster: readOneKey(cwd, sha, TRAILER.roster),
    waiver: readOneKey(cwd, sha, TRAILER.waiver),
    receipt: readOneKey(cwd, sha, TRAILER.receipt),
  };
}

// formatTrailerBlock — the write side of the same parser: whatever this
// formats must read back byte-identical through readCommitTrailers. An empty
// category emits no line at all (never a valueless key).
export function formatTrailerBlock({ roster = [], waiver = [], receipt = [] } = {}) {
  const lines = [];
  for (const v of roster) lines.push(`${TRAILER.roster}: ${v}`);
  for (const v of waiver) lines.push(`${TRAILER.waiver}: ${v}`);
  for (const v of receipt) lines.push(`${TRAILER.receipt}: ${v}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// verifyCommitReceiptBinding — THE ONE COMMIT-BINDING VERIFIER shared by
// review-ledger's superseded COMMIT form and direct-merge's additive
// Review-Receipt gate. Neither caller re-implements this: review-ledger.mjs
// layers ancestor/roster/recency/coverage checks AROUND it; direct-merge.mjs
// uses its verdicts directly, one per Review-Receipt trailer on the commit.
//
// For every `Review-Receipt: <id>` trailer on `sha` (read through
// readCommitTrailers — never a second trailer parse), the receipt named must
// be a PRESENT v2 roster receipt, CONSUMED for exactly this commit. A19: a
// receipt ALSO named by a `Review-Bytes-Waiver: <id>` trailer on the same
// commit is bound once consumed for it — the waiver IS the visible
// attestation, so blob equality is not required (facts.waived:true). An
// UNWAIVED receipt still needs content_evidence.blobs to equal this commit's
// OWN TREE for every covered path (deletions match by membership in
// absent_paths, per receiptCoveredPaths). Binding does NOT prove the
// receipt's TERRITORY was reviewed at these bytes beyond its own covered
// paths — a caller needing that (superseded's coverage rule) checks it
// separately against its own reference receipt.
// SHA HYGIENE (A19): every sha reaching git here is isSha40-validated first;
// git calls pass --end-of-options before the sha-derived positional.
// DOES NOT GUARANTEE: that `ledgerEntries` reflects the ledger's current
// on-disk state (the caller supplies the read); that a bound receipt's
// evidence is truthful, only that it is internally consistent with the tree.
// ---------------------------------------------------------------------------

function commitTreeBlob(cwd, sha, path) {
  if (!isSha40(sha)) return null;
  // MEASURED (this host's git): `rev-parse` does not consume a bare
  // `--end-of-options` before a `<rev>:<path>` positional the way
  // merge-base/cat-file/ls-tree do through the standard parse-options
  // machinery — it echoes the literal flag as an extra output line instead,
  // corrupting the result. Omitted here deliberately: `sha` is already
  // isSha40-validated (never starts with `-`), so the positional this
  // constructs can never be mistaken for an option in the first place.
  const r = spawnSync('git', ['rev-parse', `${sha}:${path}`], { cwd, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null; // null = absent in that tree
}

function verifyOneReceiptBinding({ cwd, sha, entryId, ledgerEntries, waived }) {
  const found = (ledgerEntries ?? []).find((e) => e && e.kind === 'receipt' && e.receipt.entry_id === entryId);
  if (!found) {
    return { ok: false, entry_id: entryId, code: 'superseder_commit_receipt_unbound', facts: { entry_id: entryId, reason: 'not-found' } };
  }
  const receipt = found.receipt;
  if (receipt.status !== 'consumed' || !receipt.consumption || receipt.consumption.commit_sha !== sha) {
    return { ok: false, entry_id: entryId, code: 'superseder_commit_receipt_unbound', facts: { entry_id: entryId, reason: 'not-consumed-for-this-sha' } };
  }
  if (waived) {
    return { ok: true, entry_id: entryId, receipt, facts: { waived: true } };
  }
  const covered = receiptCoveredPaths(receipt);
  const absentPaths = new Set(
    (receipt.content_evidence?.absent_paths ?? [])
      .filter((p) => typeof p === 'string')
      .map(normalizeReceiptPath)
      .filter((n) => n !== null)
  );
  const blobs = receipt.content_evidence?.blobs ?? {};
  const mismatches = [];
  for (const path of covered) {
    const n = normalizeReceiptPath(path);
    if (n === null) continue;
    const expected = blobs[path] ?? blobs[n];
    const actual = commitTreeBlob(cwd, sha, n);
    if (absentPaths.has(n)) {
      if (actual !== null) mismatches.push({ path: n, expected: 'absent', actual });
    } else if (actual !== expected) {
      mismatches.push({ path: n, expected: expected ?? null, actual });
    }
  }
  if (mismatches.length > 0) {
    return { ok: false, entry_id: entryId, code: 'superseder_commit_blob_mismatch', facts: { entry_id: entryId, mismatches } };
  }
  return { ok: true, entry_id: entryId, receipt };
}

// verifyCommitReceiptBinding({cwd, sha, ledgerEntries}) — ledgerEntries is the
// CLASSIFIED array (readLedger(root).entries — {kind, receipt|entry|legacy}
// per element), never the raw JSON. Returns {receiptIds, results}: one result
// per Review-Receipt trailer value found on `sha`, in trailer order (EVERY
// Review-Receipt trailer is judged — none skipped). A commit with no
// Review-Receipt trailer at all yields `results: []` — the caller decides
// what that means (review-ledger's commit form treats it as unbound;
// direct-merge's additive rule treats it as nothing to check, since a commit
// naming no receipt is judged by the roster rule alone).
export function verifyCommitReceiptBinding({ cwd, sha, ledgerEntries }) {
  if (!isSha40(sha)) {
    return { receiptIds: [], results: [{ ok: false, code: 'argument_invalid', facts: { flag: 'sha' } }] };
  }
  const trailers = readCommitTrailers(cwd, sha);
  const waivedIds = new Set(trailers.waiver);
  const results = trailers.receipt.map((entryId) =>
    verifyOneReceiptBinding({ cwd, sha, entryId, ledgerEntries, waived: waivedIds.has(entryId) })
  );
  return { receiptIds: trailers.receipt, results };
}
