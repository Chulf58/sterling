// scripts/hooks/lib/review-ledger-entry.mjs — THE receipt/ledger shape owner.
//
// INVARIANT: this module is the ONE parser authority for every shape the
// review ledger persists — ReceiptV2 (schema_version 2, kind 'roster_receipt'),
// ExternalReview (kind 'external_review'), and the legacy (pre-v2, flat) v1
// shape — plus the ledger's own IO (readLedger/writeLedger/ledgerDigest) and
// the owner-mkdir lock it shares with the dispatch register (imported, not
// reimplemented). A receipt's spendability is a pure function of its parsed
// shape and the caller's {session_id, branch} context (receiptIsSpendable); a
// declared path only COUNTS as covered when it carries usable byte evidence
// (receiptCoveredPaths) — declaring territory is not the same claim as having
// reviewed it.
// DOES NOT GUARANTEE: that content_evidence.blobs reflects bytes the reviewer
// actually read (only that they existed in the worktree at Stop — see the R1
// decision); that a v1 (legacy) entry's fingerprint-derived handle survives a
// hand-edit of the entry's own fields (it is a fingerprint of exactly those
// fields, by design); that an entry passed to these parsers came from a
// trustworthy writer (the ledger is evidence under the project's own trust
// boundary, not a tamper-proof log).

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { withLedgerLock } from '../../lib/dispatch-register.mjs';

export { withLedgerLock };

function isEvidenceObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// normalizeReceiptPath / isUsableBlobSha — the two primitives every coverage
// and byte comparison depends on. Deliberately lenient on SPELLING (never
// throws; a backslash becomes a forward slash — R1-B27, frozen) but REFUSES
// (returns null) a path escaping repo-relative POSIX shape: `..` traversal,
// an absolute path, or a drive prefix — callers treat null as no evidence /
// not covered, never as a literal path segment.
// CONTRACT NOTE (reported, not silently resolved): a fix-round instruction
// asked this function to also refuse a backslash-bearing value outright;
// that contradicts the frozen pin R1-B27 (`normalizeReceiptPath('src\\a.mjs')
// === 'src/a.mjs'`, plus its idempotency assertion), which this module may
// not edit (H5). Backslash-to-forward-slash conversion is kept; only
// traversal/absolute/drive-prefix are refused.
// ---------------------------------------------------------------------------

export function normalizeReceiptPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^[A-Za-z]:/.test(s)) return null; // drive prefix
  if (s.startsWith('/')) return null; // absolute
  if (s.split('/').includes('..')) return null; // traversal
  return s;
}

export function isUsableBlobSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
}

export const LEGACY_HANDLE_PATTERN = /^receipt-[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// The lifecycle sub-parsers. Each returns {ok:true, value} | {ok:false}.
// ---------------------------------------------------------------------------

export function parseDisposition(raw) {
  if (!isEvidenceObject(raw)) return { ok: false };
  if (typeof raw.class !== 'string' || raw.class === '') return { ok: false };
  if (typeof raw.reason !== 'string' || raw.reason === '') return { ok: false };
  if (typeof raw.at !== 'string' || raw.at === '') return { ok: false };
  if (typeof raw.head_sha !== 'string' || raw.head_sha === '') return { ok: false };
  if (typeof raw.classifier_version !== 'number') return { ok: false };
  const facts = isEvidenceObject(raw.facts) ? raw.facts : {};
  return {
    ok: true,
    value: { class: raw.class, reason: raw.reason, at: raw.at, head_sha: raw.head_sha, classifier_version: raw.classifier_version, facts },
  };
}

export function parseReservation(raw) {
  if (!isEvidenceObject(raw)) return { ok: false };
  if (typeof raw.nonce !== 'string' || raw.nonce === '') return { ok: false };
  if (typeof raw.at !== 'string' || raw.at === '') return { ok: false };
  if (!isEvidenceObject(raw.index_blobs)) return { ok: false };
  if (typeof raw.operation !== 'string' || raw.operation === '') return { ok: false };
  return { ok: true, value: { nonce: raw.nonce, at: raw.at, index_blobs: { ...raw.index_blobs }, operation: raw.operation } };
}

export function parseConsumption(raw) {
  if (!isEvidenceObject(raw)) return { ok: false };
  if (!isUsableBlobSha(raw.commit_sha)) return { ok: false };
  if (typeof raw.consumed_at !== 'string' || raw.consumed_at === '') return { ok: false };
  if (typeof raw.nonce !== 'string' || raw.nonce === '') return { ok: false };
  return { ok: true, value: { commit_sha: raw.commit_sha, consumed_at: raw.consumed_at, nonce: raw.nonce } };
}

// A3: a missing `basis` on a pre-rebuild v2 entry reads as
// 'stop-time-worktree-snapshot' — compatible parsing, not a second adapter.
export function parseContentEvidence(raw) {
  if (!isEvidenceObject(raw)) return { ok: false };
  if (raw.status !== 'complete' && raw.status !== 'partial' && raw.status !== 'unavailable') return { ok: false };
  const basis = typeof raw.basis === 'string' && raw.basis ? raw.basis : 'stop-time-worktree-snapshot';

  // GENUINELY ABSENT (key missing) defaults; PRESENT-BUT-WRONG-SHAPE is
  // malformed — coercing a junk value to {}/[] would erase the exact
  // distinction §2 needs between "no evidence" and "inconsistent evidence".
  let blobs;
  if (raw.blobs === undefined) {
    blobs = {};
  } else if (isEvidenceObject(raw.blobs)) {
    blobs = { ...raw.blobs };
  } else {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'content_evidence.blobs' } };
  }

  let absentPaths;
  if (raw.absent_paths === undefined) {
    absentPaths = [];
  } else if (Array.isArray(raw.absent_paths)) {
    absentPaths = raw.absent_paths.filter((p) => typeof p === 'string');
  } else {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'content_evidence.absent_paths' } };
  }

  const value = { basis, status: raw.status, blobs, absent_paths: absentPaths };

  if (raw.index_blobs !== undefined) {
    if (!isEvidenceObject(raw.index_blobs)) {
      return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'content_evidence.index_blobs' } };
    }
    value.index_blobs = { ...raw.index_blobs };
  }
  if (raw.truncated === true) value.truncated = true;
  if (Number.isInteger(raw.truncated_of)) value.truncated_of = raw.truncated_of;
  if (typeof raw.failure_reason === 'string' && raw.failure_reason) value.failure_reason = raw.failure_reason;
  return { ok: true, value };
}

// The observed-evidence TRI-STATE: ABSENT ("could not observe") must survive
// distinct from [] ("observed nothing") — collapsing them is the false
// corroboration decision review-territory-observed-evidence exists to
// prevent. Always ok: an unobserved receipt is not a malformed one.
export function parseObservedEvidence(raw) {
  const value = {};
  if (Array.isArray(raw?.observed_files)) value.observed_files = raw.observed_files.filter((p) => typeof p === 'string');
  if (Array.isArray(raw?.observed_reads)) value.observed_reads = raw.observed_reads.filter((p) => typeof p === 'string');
  if (typeof raw?.observed_source === 'string' && raw.observed_source) value.observed_source = raw.observed_source;
  if (raw?.observed_truncated === true) value.observed_truncated = true;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// parseReceipt — v2-ONLY. A v1 shape must never reach it (adaptLegacyEntry is
// the only v1 reader); resume_count and every other stale/unknown key are
// dropped by construction (the parser builds a fresh object from named
// fields, it never spreads the input through).
// ---------------------------------------------------------------------------

const RECEIPT_STATUSES = new Set(['active', 'reserved', 'consumed', 'discharged']);

// A13: entry_id is the spend/discharge/trailer ADDRESS — an unaddressable
// receipt cannot be bound to a commit, so a non-uuid value is malformed.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A trailer-safe token: this value is stamped verbatim into a
// Reviewed-By-Agent trailer, so it must be a single unbroken token.
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9_-]+$/;

// B34: territory.source is a closed enum.
const TERRITORY_SOURCES = new Set(['review-territory', 'free-prose-fallback', 'unattributable']);

export function parseReceipt(raw) {
  if (!isEvidenceObject(raw)) return { ok: false, code: 'ledger_entry_malformed' };
  if (raw.schema_version !== 2) return { ok: false, code: 'ledger_entry_malformed' };
  if (raw.kind !== undefined && raw.kind !== 'roster_receipt') return { ok: false, code: 'ledger_entry_malformed' };
  if (typeof raw.entry_id !== 'string' || !UUID_PATTERN.test(raw.entry_id)) return { ok: false, code: 'ledger_entry_malformed' };
  if (!RECEIPT_STATUSES.has(raw.status)) return { ok: false, code: 'ledger_entry_malformed' };
  // A11: started_at/finished_at must be STRINGS but need not parse as dates —
  // the evidence is recorded as captured; an unparseable finished_at surfaces
  // later as a spend/supersession disclosure, never a parse-time refusal.
  if (typeof raw.started_at !== 'string' || !raw.started_at) return { ok: false, code: 'ledger_entry_malformed' };
  if (typeof raw.finished_at !== 'string' || !raw.finished_at) return { ok: false, code: 'ledger_entry_malformed' };
  if (!isEvidenceObject(raw.reviewer)) return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'reviewer' } };
  // reviewer.agent_type must be a TRAILER-SAFE token — this value is stamped
  // verbatim into a Reviewed-By-Agent trailer, so an embedded newline, null
  // or an object must never reach that surface.
  if (typeof raw.reviewer.agent_type !== 'string' || !AGENT_TYPE_PATTERN.test(raw.reviewer.agent_type)) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'reviewer.agent_type' } };
  }
  if (!isEvidenceObject(raw.identity)) return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'identity' } };
  if (typeof raw.identity.agent_id !== 'string' || !raw.identity.agent_id) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'identity.agent_id' } };
  }
  if (!isEvidenceObject(raw.territory) || !Array.isArray(raw.territory.files)) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'territory' } };
  }
  // territory.source and territory.attribution are CLOSED ENUMS: every
  // downstream guard (receiptIsSpendable's receipt_unattributable arm, the
  // discharge classes, supersession coverage) branches on these two exact
  // strings, so an unvalidated junk value would fall through whichever
  // branch happens to run last instead of failing loudly at classification.
  if (!TERRITORY_SOURCES.has(raw.territory.source)) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'territory.source' } };
  }
  if (raw.territory.attribution !== 'block' && raw.territory.attribution !== 'union') {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'territory.attribution' } };
  }

  const contentParsed = parseContentEvidence(raw.content_evidence);
  if (!contentParsed.ok) {
    return { ok: false, code: 'ledger_entry_malformed', facts: contentParsed.facts ?? { field: 'content_evidence' } };
  }

  // SECTION <-> STATUS EXCLUSIVITY, BOTH WAYS: the required section for the
  // current status must parse, AND a section belonging to a DIFFERENT status
  // must be absent — a stray reservation/consumption survives no honest
  // lifecycle transition, and admitting one is how a forged section could
  // make a receipt look like it passed through a step it never did.
  let reservation;
  let consumption;
  let disposition = null;
  if (raw.status === 'reserved') {
    const r = parseReservation(raw.reservation);
    if (!r.ok) return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'reservation' } };
    reservation = r.value;
  } else if (raw.reservation !== undefined) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'reservation' } };
  }
  if (raw.status === 'consumed') {
    const c = parseConsumption(raw.consumption);
    if (!c.ok) return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'consumption' } };
    consumption = c.value;
  } else if (raw.consumption !== undefined) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'consumption' } };
  }
  if (raw.status === 'discharged') {
    const d = parseDisposition(raw.disposition);
    if (!d.ok) return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'disposition' } };
    disposition = d.value;
  } else if (raw.disposition !== undefined && raw.disposition !== null) {
    return { ok: false, code: 'ledger_entry_malformed', facts: { field: 'disposition' } };
  }

  const identity = {
    session_id: typeof raw.identity.session_id === 'string' ? raw.identity.session_id : null,
    branch: typeof raw.identity.branch === 'string' ? raw.identity.branch : null,
    base_sha: typeof raw.identity.base_sha === 'string' ? raw.identity.base_sha : null,
    agent_id: raw.identity.agent_id,
  };

  const observed = parseObservedEvidence(raw).value;

  const receipt = {
    schema_version: 2,
    entry_id: raw.entry_id,
    kind: 'roster_receipt',
    status: raw.status,
    started_at: raw.started_at,
    finished_at: raw.finished_at,
    reviewer: {
      agent_type: raw.reviewer.agent_type,
      model: raw.reviewer.model ?? null,
      model_family: raw.reviewer.model_family ?? null,
      model_source: raw.reviewer.model_source ?? null,
    },
    identity,
    territory: {
      files: raw.territory.files.filter((f) => typeof f === 'string'),
      source: raw.territory.source,
      attribution: raw.territory.attribution,
    },
    content_evidence: contentParsed.value,
    disposition,
    ...observed,
  };
  if (reservation) receipt.reservation = reservation;
  if (consumption) receipt.consumption = consumption;
  return { ok: true, receipt };
}

// ---------------------------------------------------------------------------
// Legacy (v1) — the ONE v1 reader. Never rewrites its input; the handle is a
// content fingerprint so identical bytes always address the same entry.
// ---------------------------------------------------------------------------

function legacyFingerprint(raw) {
  const files = Array.isArray(raw?.files)
    ? raw.files.filter((f) => typeof f === 'string').map(normalizeReceiptPath).sort()
    : [];
  const blobsObj = isEvidenceObject(raw?.reviewed_state) && isEvidenceObject(raw.reviewed_state.blobs) ? raw.reviewed_state.blobs : {};
  const blobs = Object.entries(blobsObj)
    .map(([p, s]) => [normalizeReceiptPath(p), s])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let canonical;
  try {
    canonical = JSON.stringify([raw?.agent_type ?? null, raw?.at ?? null, files, blobs]);
    if (typeof canonical !== 'string') canonical = '<unserializable>';
  } catch {
    canonical = '<unserializable>';
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function legacyReceiptHandle(raw) {
  return `receipt-${legacyFingerprint(raw)}`;
}

export function adaptLegacyEntry(raw) {
  const blobsObj = isEvidenceObject(raw?.reviewed_state) && isEvidenceObject(raw.reviewed_state.blobs) ? { ...raw.reviewed_state.blobs } : {};
  return {
    kind: 'legacy',
    handle: legacyReceiptHandle(raw),
    agent_type: typeof raw?.agent_type === 'string' ? raw.agent_type : null,
    files: Array.isArray(raw?.files) ? raw.files.slice() : [],
    at: typeof raw?.at === 'string' ? raw.at : null,
    session_id: typeof raw?.session_id === 'string' ? raw.session_id : null,
    branch: typeof raw?.branch === 'string' ? raw.branch : null,
    base_sha: typeof raw?.base_sha === 'string' ? raw.base_sha : null,
    blobs: blobsObj,
    status: raw?.status === 'discharged' ? 'discharged' : 'active',
  };
}

function looksLikeLegacyV1(raw) {
  return typeof raw?.agent_type === 'string' && raw.agent_type !== '' && Array.isArray(raw?.files) && typeof raw?.at === 'string' && raw.at !== '';
}

// ---------------------------------------------------------------------------
// classifyLedgerEntry — the ONE routing authority: receipt | external_review
// | legacy | malformed.
// ---------------------------------------------------------------------------

export function classifyLedgerEntry(raw) {
  if (!isEvidenceObject(raw)) {
    return { kind: 'malformed', code: 'ledger_entry_malformed', facts: { reason: 'not-an-object' } };
  }
  if (raw.schema_version === 2) {
    if (raw.kind === 'external_review') {
      if (typeof raw.entry_id !== 'string' || !raw.entry_id || typeof raw.thread_id !== 'string' || !Array.isArray(raw.files)) {
        return { kind: 'malformed', code: 'ledger_entry_malformed', facts: { reason: 'external_review' } };
      }
      return { kind: 'external_review', entry: raw };
    }
    const parsed = parseReceipt(raw);
    if (!parsed.ok) return { kind: 'malformed', code: 'ledger_entry_malformed', facts: parsed.facts ?? { reason: 'receipt' } };
    return { kind: 'receipt', receipt: parsed.receipt };
  }
  if (looksLikeLegacyV1(raw)) {
    return { kind: 'legacy', legacy: adaptLegacyEntry(raw) };
  }
  return { kind: 'malformed', code: 'ledger_entry_malformed', facts: { reason: 'unrecognized' } };
}

// ---------------------------------------------------------------------------
// receiptCoveredPaths / receiptIsSpendable — operate on a receipt-shaped
// object directly (raw-but-well-formed, or the output of parseReceipt: both
// carry the same field names).
// ---------------------------------------------------------------------------

// A9 + A13: declared territory WITH usable byte evidence, UNION declared
// paths recorded as genuinely absent at Stop (a reviewed DELETION is
// evidence, not a coverage gap). A declared path with neither a usable blob
// nor an absence record is NOT covered — closing the exact laundering route
// where a declared-but-unhashed path would count as reviewed bytes.
export function receiptCoveredPaths(receipt) {
  const files = Array.isArray(receipt?.territory?.files) ? receipt.territory.files : [];
  const blobs = isEvidenceObject(receipt?.content_evidence?.blobs) ? receipt.content_evidence.blobs : {};
  const absentPaths = new Set(
    (Array.isArray(receipt?.content_evidence?.absent_paths) ? receipt.content_evidence.absent_paths : [])
      .filter((p) => typeof p === 'string')
      .map(normalizeReceiptPath)
      .filter((n) => n !== null)
  );
  const covered = [];
  for (const f of files) {
    if (typeof f !== 'string') continue;
    const n = normalizeReceiptPath(f);
    if (n === null) continue; // a path escaping repo-relative shape is never covered
    const sha = blobs[f] ?? blobs[n];
    if (isUsableBlobSha(sha) || absentPaths.has(n)) covered.push(n);
  }
  return covered;
}

// A13/A15: the ONE predicate deciding which staged paths need review
// coverage. Config-driven when review_ledger.code_globs is set (simple glob
// support: '*' within one path segment, '**' across segments); otherwise a
// built-in extension classification — everything is code EXCEPT recognized
// prose/media files. A15: .json/.yml/.yaml/.toml stay CODE — hooks.json,
// package.json and config files are enforcement/build surface and need
// review coverage; only the prose/media set is excluded.
const DEFAULT_NON_CODE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.lock', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.ico',
]);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// A23: GENERATED artifacts — repo-root hooks/*.mjs (the esbuild hook
// bundles) and packages/tui/bundle/** — are derived from reviewed sources
// and proven byte-identical by check-bundles-fresh; demanding their own
// receipt would make every bundle-carrying commit refuse.
const GENERATED_PREFIXES = ['hooks/', 'packages/tui/bundle/'];

export function isCodePath(path, config = {}) {
  const p = normalizeReceiptPath(path);
  if (p === null) return false;
  if (GENERATED_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  const globs = Array.isArray(config?.review_ledger?.code_globs) ? config.review_ledger.code_globs : null;
  if (globs && globs.length > 0) {
    return globs.some((g) => globToRegExp(g).test(p));
  }
  return !DEFAULT_NON_CODE_EXTENSIONS.has(extname(p).toLowerCase());
}

export function receiptIsSpendable(receipt, ctx) {
  if (receipt?.status !== 'active') return { ok: false, code: 'receipt_not_active' };
  if (receipt?.territory?.source === 'unattributable') return { ok: false, code: 'receipt_unattributable' };
  const identity = isEvidenceObject(receipt?.identity) ? receipt.identity : {};
  if (identity.session_id === null || identity.session_id === undefined) return { ok: false, code: 'receipt_identity_unknown' };
  if (identity.branch === null || identity.branch === undefined) return { ok: false, code: 'receipt_identity_unknown' };
  if (identity.session_id !== ctx.session_id) return { ok: false, code: 'receipt_foreign_session' };
  if (identity.branch !== ctx.branch) return { ok: false, code: 'receipt_foreign_branch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ledger IO — availability tri-state, never a throw; atomic writes.
// ---------------------------------------------------------------------------

function ledgerPath(root) {
  return join(root, '.sterling', 'review-ledger.json');
}

export function readLedger(root) {
  const p = ledgerPath(root);
  if (!existsSync(p)) return { availability: 'absent', entries: [], rawEntries: [], raw: '' };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { availability: 'corrupt', entries: [], rawEntries: [], raw: '' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { availability: 'corrupt', entries: [], rawEntries: [], raw: '' };
  }
  if (!Array.isArray(parsed)) return { availability: 'corrupt', entries: [], rawEntries: [], raw: '' };
  // rawEntries is the parsed JSON array EXACTLY as read (same order as
  // entries) — a locked read-modify-write rewrites from this, never from a
  // re-parse of `raw`, and never loses a legacy/malformed entry's original
  // fields that classifyLedgerEntry does not surface. Each classified entry
  // carries `index`, its position in rawEntries, so a writer can splice the
  // exact element back in place.
  return {
    availability: 'ok',
    entries: parsed.map((e, index) => ({ ...classifyLedgerEntry(e), index })),
    rawEntries: parsed,
    raw,
  };
}

export function writeLedger(root, entries) {
  const dir = join(root, '.sterling');
  mkdirSync(dir, { recursive: true });
  const p = ledgerPath(root);
  const tmp = `${p}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, p);
}

// The digest is over the exact RAW bytes — a discharge --digest concurrency
// token must invalidate on any byte change, not merely a semantic one.
export function ledgerDigest(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
