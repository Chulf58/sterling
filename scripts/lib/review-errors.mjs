// scripts/lib/review-errors.mjs — THE mechanism-level refusal/disclosure
// authority for the review-receipt mechanism (register, ledger, CLIs, hooks).
//
// INVARIANT: every refusal or disclosure rendered anywhere in the mechanism
// carries a code drawn from CODES below, and is constructed through refusal()
// or disclosure() — never a bare thrown string, never an ad hoc {ok:false}
// shape with an unregistered code. A code outside CODES throws at
// construction: a typo here is a defect in the caller, not a new code.
// DOES NOT GUARANTEE: that the code chosen for a given situation is the
// RIGHT code (that judgement belongs to the caller) — only that whatever is
// rendered is well-formed and drawn from one fixed, closed vocabulary.

export const CODES = new Set([
  // §1.4 ledger verbs
  'ledger_corrupt',
  'ledger_absent',
  'ledger_digest_mismatch',
  'compatibility_lock_held',
  'entry_not_found',
  'entry_selector_ambiguous',
  'entry_not_active',
  'class_unknown',
  'class_not_applicable',
  'superseder_not_found',
  'superseder_not_reviewer_class',
  'superseder_not_newer',
  'superseder_branch_mismatch',
  'superseder_lifecycle_unacceptable',
  'superseder_coverage_incomplete',
  'superseder_commit_not_ancestor',
  'superseder_commit_trailer_not_roster',
  'superseder_commit_receipt_unbound',
  'superseder_commit_blob_mismatch',
  'covering_not_allowed',
  'covering_receipt_invalid',
  'no_live_territory_disproved',
  'reconcile_no_match',
  'reconcile_ambiguous',
  'reconcile_nonce_split',
  'reconcile_unresolved',
  'record_external_duplicate',
  'argument_invalid',
  // commit operation
  'nothing_staged',
  'message_missing',
  'no_spendable_receipt',
  'receipt_bytes_mismatch',
  'coverage_incomplete',
  'reservation_conflict',
  'commit_failed',
  'finalize_failed',
  'waiver_reason_missing',
  // A13 additions
  'target_sha_prior_receipt_unbound',
  'commit_verify_failed',
  'not_sterling_project',
  'receipt_unscoped',
  // §1.4 disclosures (never refuse)
  'receipt_unattributable',
  'receipt_foreign',
  'receipt_identity_unknown',
  'receipt_deferred',
  'receipt_stale',
  'receipt_age_unverifiable',
  'receipt_no_overlap',
  'multi_spend',
  'bytes_waived',
  'legacy_entries_present',
  'receipt_not_spent_stale_bytes',
  'register_unavailable',
  'dispatch_status_unknown',
  // A9 register/ledger additions
  'register_entry_malformed',
  'register_agent_id_duplicate',
  'register_lock_held',
  'receipt_not_active',
  'receipt_foreign_session',
  'receipt_foreign_branch',
  // A9 --target-sha amend mode
  'target_sha_unresolvable',
  'target_sha_not_head',
  'target_sha_tree_dirty',
  'target_sha_published',
  'target_sha_publication_unprovable',
  // A11 additions
  'territory_declaration_missing',
  'territory_declaration_malformed',
  'dispatch_overlap',
  'dispatch_residue',
  // ledger entry classification
  'ledger_entry_malformed',
  // A19 (security review): an env override of identity is disclosed, never silent
  'session_identity_override',
  // dispatch state machine (decision dispatch-state-machine-pre-slot-post-
  // binding-locked-start-resolution-replaces-transcript-attribution, §2/§5/§6)
  'dispatch_state_collision',
  'dispatch_post_late',
  'dispatch_post_mismatch',
  'dispatch_post_refused',
  'dispatch_state_poisoned',
  'dispatch_unattributable',
  'dispatch_lock_held',
  'dispatch_post_only',
]);

function assertCode(code) {
  if (!CODES.has(code)) {
    throw new TypeError(`review-errors: '${code}' is not in the closed CODES set — a typo is a defect, not a new code`);
  }
}

// refusal() builds a throwable Error carrying {kind:'refusal', code, facts,
// message} — throw it, or return it; both are legitimate per the owner
// modules' calling convention (the caller's choice, never the shape's).
export function refusal(code, facts = {}, message = code) {
  assertCode(code);
  const err = new Error(message);
  err.kind = 'refusal';
  err.code = code;
  err.facts = facts;
  return err;
}

// disclosure() builds a plain (non-throwable) {kind:'disclosure', code,
// facts, message} object — a disclosure is never thrown, only printed.
export function disclosure(code, facts = {}, message = code) {
  assertCode(code);
  return { kind: 'disclosure', code, facts, message };
}

export function isRefusal(x) {
  return !!x && x.kind === 'refusal';
}

// render() is what every hook/CLI prints — the `[code]` token is what pins
// match, never sentence text.
export function render(x) {
  const label = x?.kind === 'refusal' ? 'REFUSED' : 'NOTE';
  return `${label} [${x?.code}] ${x?.message ?? ''}`;
}

// toJson() is the --json surface: one object, ok:false for a refusal, the
// bare disclosure shape otherwise.
export function toJson(x) {
  if (x?.kind === 'refusal') {
    return { ok: false, code: x.code, facts: x.facts, message: x.message };
  }
  return { code: x?.code, facts: x?.facts, message: x?.message };
}
