// REVIEW-LEDGER ENTRY v2 READ ADAPTER (campaign slice S2b-1, decision 57984926
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design).
//
// scripts/hooks/h22-dispatch-register.mjs now promotes EVERY new reviewer-*
// SubagentStop into the v2 envelope (schema_version:2, nested reviewer/
// identity/territory/content_evidence). Pre-existing entries in
// .sterling/review-ledger.json are NEVER migrated in place (decision
// 57984926: "v1 entries are NEVER migrated in place — readers use one
// compatibility adapter"), so a real ledger file mixes both shapes forever.
//
// normalizeLedgerEntry(entry) is that ONE compatibility adapter: every reader
// of the ledger (scripts/commit-reviewed.mjs today; scripts/hooks/
// h1-session-start.mjs's receipt-age report is DEFERRED — see that file's own
// header) maps every entry through this function ONCE, at read time, and then
// keeps reading the SAME flat field names it always has
// (agent_type/files/at/session_id/branch/base_sha/files_source/attribution/
// reviewed_state) regardless of which shape actually produced them. Scattering
// `schema_version === 2` conditionals across every consumer is exactly the
// shape decision 57984926 rejects ("one compatibility adapter").
//
// LEGACY (missing/non-2 schema_version) IS IDENTITY-SHAPED: returned
// byte-for-byte unchanged, not even a shallow clone — a v1 entry's behavior
// through every reader must be provably untouched by this slice.
//
// FIELD HOMES for a v2 entry, per decision 57984926:
//   reviewer.agent_type    -> agent_type
//   territory.files        -> files
//   territory.source       -> files_source   (decision 8f137474's field, nested in v2)
//   territory.attribution  -> attribution    (decision 8f137474's field, nested in v2)
//   started_at             -> at             (the pre-existing Start instant)
//   identity.session_id    -> session_id
//   identity.branch        -> branch
//   identity.base_sha      -> base_sha
//   finished_at + content_evidence.blobs/truncated
//                           -> reviewed_state{completed_at, blobs, truncated?, truncated_of?}
//                              (the shape commit-reviewed.mjs's REVIEWED-BYTES
//                              check and staleness advisory already read;
//                              `finished_at` is "the completed_at moment the
//                              age advisory prefers" per the launching brief)
//   content_evidence.status -> content_evidence_status (v2-ONLY marker, see
//                              finding F2 below; absent/undefined for a v1
//                              entry, which never had this concept)
//
// STATUS:'discharged' entries are explicitly OUT OF SCOPE this slice (decision
// 57984926 part 3; no discharge verb exists yet, so no v2 entry can carry that
// status today) — no special-casing here, every v2 entry this slice can ever
// produce is status:'active'.
//
// FIX ROUND (2026-08-31, roster review of this slice) — two findings landed
// here:
//
// F2 — content_evidence_status IS THE NEW FIELD. v1's `reviewed_state` key was
// OPTIONAL and its mere presence was itself weak evidence of "an attempt was
// made" (H22's old reviewEndState only ever wrote the key when at least one
// file actually hashed). v2's `content_evidence` is UNCONDITIONAL — every v2
// entry carries one, including the fully legitimate "nothing to hash" cases
// (a vacuous no-declared-files receipt, or a reviewed DELETION whose every
// declared path is absent, status:'unavailable'). Mapping those straight to a
// present `reviewed_state` object made commit-reviewed.mjs's NO CONTENT
// EVIDENCE advisory fire on every such receipt by construction — exactly the
// fire-every-time fate that check's own comments forbid, and a false tamper
// signal for the common case. Exposing the raw `status` string lets the
// reader (commit-reviewed.mjs) tell "recorded none by design" (status
// 'unavailable', or no files were ever declared) apart from "evidence was
// expected but came back empty" (status 'complete'/'partial' with files
// declared, blobs still empty — a genuine hashing failure or post-hoc tamper)
// WITHOUT this adapter itself making that call — the call belongs to the
// reader that knows what a stamp means, not to the shape-transparency layer.
//
// F3 — TRUNCATED IS READ FROM THE EXPLICIT BOOLEAN FIRST. The write side
// (scripts/hooks/h22-dispatch-register.mjs's buildContentEvidence) now emits
// `truncated: true` alongside `truncated_of` as the single authority for the
// truncation verdict; inferring truncation from "truncated_of is a positive
// integer" was a SECOND, weaker copy of that same decision (satisfiable by any
// producer — or hand-written ledger fixture — that sets a truncated_of without
// ever having gone through the write side's actual cap check). The inference
// is kept ONLY as a fallback for a `content_evidence` that carries
// `truncated_of` but not the newer `truncated` flag (e.g. a fixture authored
// before F3, or a future producer that has not adopted it yet) — explicit
// beats inferred whenever both are present.
export function normalizeLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.schema_version !== 2) {
    return entry; // legacy/malformed — presented AS-IS, shape-transparent
  }
  const reviewer = entry.reviewer && typeof entry.reviewer === 'object' ? entry.reviewer : {};
  const identity = entry.identity && typeof entry.identity === 'object' ? entry.identity : {};
  const territory = entry.territory && typeof entry.territory === 'object' ? entry.territory : {};
  const contentEvidence = entry.content_evidence && typeof entry.content_evidence === 'object' ? entry.content_evidence : null;
  // F3: explicit `truncated` boolean wins; `truncated_of` alone (no explicit
  // flag) is the fallback inference, kept for a producer/fixture that has not
  // adopted the explicit flag yet.
  const truncatedFlag =
    contentEvidence && typeof contentEvidence.truncated === 'boolean'
      ? contentEvidence.truncated
      : contentEvidence && Number.isInteger(contentEvidence.truncated_of) && contentEvidence.truncated_of > 0;
  const truncatedOf =
    contentEvidence && Number.isInteger(contentEvidence.truncated_of) && contentEvidence.truncated_of > 0 ? contentEvidence.truncated_of : null;
  const blobs =
    contentEvidence && typeof contentEvidence.blobs === 'object' && contentEvidence.blobs !== null && !Array.isArray(contentEvidence.blobs)
      ? contentEvidence.blobs
      : undefined;
  return {
    agent_type: reviewer.agent_type,
    files: territory.files,
    files_source: territory.source,
    attribution: territory.attribution,
    at: entry.started_at,
    session_id: identity.session_id,
    branch: identity.branch,
    base_sha: identity.base_sha,
    reviewed_state: {
      completed_at: typeof entry.finished_at === 'string' ? entry.finished_at : undefined,
      blobs,
      ...(truncatedFlag ? { truncated: true, truncated_of: truncatedOf } : {}),
    },
    // F2 — v2-ONLY marker (a v1 entry returns early above and never reaches
    // this object, so a reader that only ever sees this key set can rely on
    // its presence to mean "this came through the v2 branch").
    content_evidence_status: typeof contentEvidence?.status === 'string' ? contentEvidence.status : undefined,
  };
}
