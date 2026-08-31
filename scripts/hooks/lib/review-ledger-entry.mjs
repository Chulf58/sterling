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
//   entry_id               -> entry_id (v2-ONLY, campaign slice S2b-2 — see
//                              the ENTRY_ID note below)
//
// ENTRY_ID IS SURFACED (campaign slice S2b-2, decision 57984926 §2). The
// reviewed-bytes REFUSE flip stamps one `Review-Bytes-Waiver: <identity>`
// trailer per waived receipt, and §2 names that identity as "entry_id for v2,
// stable fingerprint for v1". The structural-completeness check (MED-2 below)
// already READ entry_id here to decide `v2_deficient`, but never exposed the
// value — so commit-reviewed.mjs could not name the very entry it was
// withholding or waiving without a `schema_version === 2` branch of its own,
// which is exactly the second hand-rolled switch this adapter exists to
// prevent (finding HIGH-3). v2-ONLY, same presence convention as
// content_evidence_status/agent_id: a v1 entry returns early and never gains
// the key, so a v1 waiver identity can never be mistaken for a real entry_id.
//
// STATUS IS SURFACED RAW (campaign slice S2b-3, decision 57984926 §3). The
// discharge verb (scripts/review-ledger.mjs) now exists, so a v2 entry really
// can carry status:'discharged' — evidence that has been explicitly ruled
// unspendable while being PRESERVED in place. Every spending surface must be
// able to see that, so `status` is passed through UNCHANGED rather than
// defaulted here: the compatibility rule §3 states is "missing status =
// active", and defaulting inside this adapter would erase the difference
// between "a real promotion recorded 'active'" and "this shape predates the
// field". A v1 entry returns early below and never gains the key at all, which
// is exactly the legacy-is-active reading. The SPENDING decision stays with the
// reader (commit-reviewed.mjs), same separation of concerns as
// content_evidence_status (F2) and v2_deficient (MED-2).
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
//
// FIX ROUND 2 (2026-08-31, Codex outside-family review thread 01a0586b) —
// three more findings landed here:
//
// HIGH-2/HIGH-3 — agent_id IS SURFACED, and it is the DISPATCH IDENTITY the
// ledger-append idempotency check (h22-dispatch-register.mjs) now keys on
// instead of agent_type+at (which two genuinely distinct same-instant
// same-type dispatches can share — pin DISPATCH-IDENTITY). Reading it through
// THIS adapter (rather than an inline schema_version branch in h22) is
// finding HIGH-3: one shape-transparency layer, not a second hand-rolled
// switch. A v1 entry never carried agent_id, so it normalizes to no
// `agent_id` key at all and can never false-match a real identity.
//
// MED-2 — STRUCTURAL COMPLETENESS. A v2 entry can claim schema_version:2
// while missing everything a real promotion always sets (entry_id/started_at/
// identity — see h22-ledger-v2-entry.test.mjs's V2-1). Mapping such an object
// through the same field homes as a real entry would silently manufacture a
// spendable-looking receipt out of a malformed one (pin S13). `v2_deficient`
// marks it so a reader (commit-reviewed.mjs) can withhold and disclose it —
// the STRUCTURAL check belongs here (this is the one place that already knows
// what a complete v2 entry looks like); the SPENDING decision still belongs to
// the reader, same separation of concerns as content_evidence_status (F2).
export function normalizeLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.schema_version !== 2) {
    return entry; // legacy/malformed — presented AS-IS, shape-transparent
  }
  const v2Deficient =
    typeof entry.entry_id !== 'string' ||
    entry.entry_id === '' ||
    typeof entry.started_at !== 'string' ||
    entry.started_at === '' ||
    !entry.identity ||
    typeof entry.identity !== 'object' ||
    Array.isArray(entry.identity); // an array passes typeof==='object' but is not the identity object a real promotion writes
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
    // S2b-2 — the v2 entry's own identity, surfaced so a reader can NAME the
    // entry it refuses or waives (decision 57984926 §2). undefined for v1.
    entry_id: entry.entry_id,
    // S2b-4 — THE KIND GATE (decision 57984926 §4). A v2 ledger is now
    // MULTI-KIND: 'roster_receipt' entries are spendable review receipts, and
    // 'external_review' entries are the conductor's attestation that an
    // outside-model consult happened (minted only by scripts/review-ledger.mjs
    // record-external). §4 requires external entries to be "never spendable,
    // never stamped, never counted by roster eligibility (kind gate +
    // agent-type regex, belt and braces)", so the KIND must be visible through
    // the one adapter every reader uses — otherwise each surface would need its
    // own `entry.kind` branch, which is the second hand-rolled switch this
    // adapter exists to prevent (finding HIGH-3). Passed through RAW and
    // undefaulted, same posture as `status`: an external entry carries no
    // reviewer object, no identity and no started_at, so WITHOUT this key it
    // normalizes to the shape of a structurally-deficient roster receipt and
    // gets reported as a malformed REVIEW receipt rather than as what it is.
    // undefined for v1 (early return above) and for a v2 entry promoted before
    // the field existed — both of which are roster receipts by construction.
    kind: entry.kind,
    // S2b-3 — the v2 LIFECYCLE STATUS, raw and undefaulted (see the STATUS note
    // in the header). undefined for v1; 'discharged' is the only value that
    // makes an entry unspendable.
    status: entry.status,
    // S2b-3 FIX ROUND — the DISPOSITION, raw and unvalidated. A discharge is
    // only AUTHENTICATED by the pair {status:'discharged', disposition:<object>}
    // (see isAuthenticatedDischarge below), and until this was surfaced no
    // reader could see the second half of that pair: `status` alone is a single
    // string any hand-written or truncated ledger can carry, which made a
    // one-field forgery enough to make real reviewer evidence invisible to every
    // spending surface. Passed through UNCHANGED for the same reason `status` is:
    // the shape-transparency layer reports what is there, the READER decides what
    // it means. undefined for v1 (which returns early and has no lifecycle).
    disposition: entry.disposition,
    agent_type: reviewer.agent_type,
    files: territory.files,
    files_source: territory.source,
    attribution: territory.attribution,
    at: entry.started_at,
    session_id: identity.session_id,
    branch: identity.branch,
    base_sha: identity.base_sha,
    // HIGH-2/HIGH-3 — the register's own dispatch identity, undefined for a
    // v1 entry (which never recorded it) or a legacy v2 entry promoted before
    // this field existed.
    agent_id: identity.agent_id,
    reviewed_state: {
      completed_at: typeof entry.finished_at === 'string' ? entry.finished_at : undefined,
      blobs,
      ...(truncatedFlag ? { truncated: true, truncated_of: truncatedOf } : {}),
    },
    // F2 — v2-ONLY marker (a v1 entry returns early above and never reaches
    // this object, so a reader that only ever sees this key set can rely on
    // its presence to mean "this came through the v2 branch").
    content_evidence_status: typeof contentEvidence?.status === 'string' ? contentEvidence.status : undefined,
    // MED-2 — v2-ONLY marker: true when this v2-claiming object is missing
    // entry_id/started_at/identity. A v1 entry never sets this key at all
    // (undefined, not false), matching content_evidence_status's v2-only
    // presence convention.
    v2_deficient: v2Deficient,
  };
}

/** THE DISCHARGE MARKER'S AUTHENTICATION CLASS (decision 57984926 §3; S2b-3 fix
 *  round, Codex review MED "authenticated discharge marker"). Takes a
 *  NORMALIZED entry (the output of normalizeLedgerEntry above), because the
 *  verdict needs all three of `status`, `disposition` and the v2 marker
 *  `v2_deficient`, and only the normalized view carries the last one.
 *
 *  WHY A CLASS AND NOT A BOOLEAN. `status:'discharged'` is a single string, and
 *  a discharge is the one lifecycle state that makes real reviewer evidence
 *  INVISIBLE to every spending surface — so a one-field marker is a one-field
 *  forgery, reachable from a hand-edited ledger, a truncated write, or a fixture
 *  written before the verb existed. The genuine act (scripts/review-ledger.mjs
 *  discharge) always writes the PAIR {status:'discharged', disposition:{reason,
 *  at, head_sha, classifier_version, class, facts}} onto a structurally complete
 *  v2 entry, so the PAIR is what a reader honors. The classes differ in what the
 *  reader must DO, which is why they are not collapsed into a boolean:
 *
 *    'authenticated'   — v2, non-deficient, status EXACTLY 'discharged', and a
 *                        non-null non-array disposition object. THE ONLY class
 *                        excluded SILENTLY (already adjudicated, its reason
 *                        recorded in the entry) and the only class H1 stops
 *                        reporting.
 *    'unauthenticated' — v2, non-deficient, status 'discharged', but no usable
 *                        disposition. NOT SPENT (fail toward not-spending: a
 *                        malformed lifecycle marker is not evidence that the
 *                        receipt IS spendable either) but DISCLOSED, never
 *                        silently skipped, and still reported by H1.
 *    'v2-deficient'    — a v2-claiming entry missing entry_id/started_at/
 *                        identity. Already withheld AND disclosed by the
 *                        deficiency path (MED-2); its discharge claim adds
 *                        nothing to that verdict.
 *    'v1-no-lifecycle' — a LEGACY entry carrying a stray status:'discharged'.
 *                        v1 has NO lifecycle at all — the discharge verb refuses
 *                        v1 entries outright — so this string was never written
 *                        by a discharge and cannot mean one. Treated as an
 *                        ORDINARY ACTIVE v1 receipt (spendable), which keeps the
 *                        v1 pass-through promise: a v1 entry's behavior through
 *                        every reader is unchanged by this slice.
 *    'none'            — not claiming a discharge at all.
 */
export function dischargeMarkerClass(normalized) {
  const e = normalized;
  if (!e || typeof e !== 'object' || e.status !== 'discharged') return 'none';
  // v2_deficient is the v2-ONLY presence marker: undefined means the entry came
  // out of the legacy early-return, i.e. it has no lifecycle to speak of.
  if (e.v2_deficient === undefined) return 'v1-no-lifecycle';
  if (e.v2_deficient === true) return 'v2-deficient';
  const d = e.disposition;
  // An ARRAY passes typeof === 'object' but is not the disposition object a real
  // discharge writes — the same reasoning the identity check above applies.
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return 'unauthenticated';
  // CONTENTFUL, NOT MERELY PRESENT (final review, pre-merge). `disposition: {}`
  // satisfied "a non-null object" and therefore classed as AUTHENTICATED — the
  // ONE class excluded SILENTLY from spending and from H1's report. So an empty
  // object, which a hand-edit or a truncated write produces trivially, could hide
  // real reviewer evidence with no line printed anywhere: the exact failure the
  // authentication check exists to prevent, reached by a two-character payload.
  // The two fields checked here are the two the verb ALWAYS writes and the two a
  // human actually needs — WHY it was discharged and UNDER WHICH recognized
  // class — so no genuine discharge changes class, while every contentless or
  // invented-class marker falls to 'unauthenticated', which is already the safe,
  // NOT-SPENT-and-DISCLOSED path. The class list is §3's closed set, mirroring
  // scripts/review-ledger.mjs's RECOGNIZED_CLASSES: a disposition naming a class
  // the verb would have refused was not written by the verb.
  const reasonOk = typeof d.reason === 'string' && d.reason.trim() !== '';
  const classOk = d.class === 'foreign-session' || d.class === 'foreign-branch' || d.class === 'no-live-territory';
  return reasonOk && classOk ? 'authenticated' : 'unauthenticated';
}

/** The one predicate every spending/reporting surface asks: may this entry be
 *  treated as EXPLICITLY RULED UNSPENDABLE AND ALREADY ADJUDICATED? True only
 *  for the 'authenticated' class above. */
export function isAuthenticatedDischarge(normalized) {
  return dischargeMarkerClass(normalized) === 'authenticated';
}

/** EXTERNAL REVIEW EVIDENCE, NEVER A SPENDABLE RECEIPT (decision 57984926 §4,
 *  campaign slice S2b-4). Takes a NORMALIZED entry, like the discharge
 *  predicates above, so every surface asks the question the same way.
 *
 *  An external entry is the conductor's attestation that an outside-model
 *  consult COMPLETED — "evidence of a completed consult, not proof" (§4). It is
 *  therefore excluded from validity, eligibility, roster counts, trailer
 *  stamping and reviewed_by everywhere, and — because the consume step removes
 *  only entries it actually STAMPED — it survives a consume write untouched,
 *  the same structural posture a discharged entry has.
 *
 *  STRICT STRING EQUALITY, and the ONE kind that is excluded. A missing/unknown
 *  kind reads as a roster receipt (the compatibility rule: every entry that
 *  predates the field is one), so this predicate can only ever ADD an exclusion
 *  for an entry that explicitly declares itself external — it can never
 *  silently withhold a real review receipt. The agent-type regex on the reading
 *  side is the second, independent guard §4 asks for ("belt and braces"): an
 *  external entry carries NO agent_type at all, so it fails that check too, and
 *  neither guard stands in for the other. */
export function isExternalReviewEntry(normalized) {
  return !!normalized && typeof normalized === 'object' && normalized.kind === 'external_review';
}
