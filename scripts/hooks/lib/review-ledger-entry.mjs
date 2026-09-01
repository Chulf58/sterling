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
import { createHash } from 'node:crypto';

/** A plain, non-null, non-array object. THE ONE PREDICATE FOR EVERY LEVEL OF A
 *  RECEIPT'S EVIDENCE — the `content_evidence` container here, and the `blobs`
 *  map and v1 `reviewed_state` container in commit-reviewed.mjs, which imports
 *  it rather than keeping a second copy. The levels are the SAME QUESTION ("is
 *  there a readable record here, or merely a value?"), and each was a separate
 *  bypass while each had its own guard: `typeof x === 'object'` admits both
 *  `null` and an ARRAY, which is precisely the shape a tamper reaches for once
 *  the obvious ones refuse. One predicate means closing a level cannot leave a
 *  sibling level open. */
export function isEvidenceObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
  // isEvidenceObject, not the bare `&& typeof === 'object'` this used to be: an
  // ARRAY passes that test, so `content_evidence: ["array"]` was admitted as a
  // real (empty) evidence record whose every field read as absent. Same
  // array-shaped hole the identity check above already closes.
  const contentEvidence = isEvidenceObject(entry.content_evidence) ? entry.content_evidence : null;
  // F3: explicit `truncated` boolean wins; `truncated_of` alone (no explicit
  // flag) is the fallback inference, kept for a producer/fixture that has not
  // adopted the explicit flag yet.
  const truncatedFlag =
    contentEvidence && typeof contentEvidence.truncated === 'boolean'
      ? contentEvidence.truncated
      : contentEvidence && Number.isInteger(contentEvidence.truncated_of) && contentEvidence.truncated_of > 0;
  const truncatedOf =
    contentEvidence && Number.isInteger(contentEvidence.truncated_of) && contentEvidence.truncated_of > 0 ? contentEvidence.truncated_of : null;
  // BLOBS ARE PASSED THROUGH RAW, SHAPE-TRANSPARENT (board f55ab3e9, decision
  // 57984926 §2). This guard used to map ANY unusable content_evidence.blobs
  // value — the string "junk", 42, ["array"], true, null — to `undefined`, which
  // ERASED THE PRESENT-vs-ABSENT DISTINCTION: commit-reviewed.mjs's evidence
  // classifier then read "this receipt recorded nothing", the one shape §2
  // grandfathers ("grandfather only genuinely absent evidence"), when the truth
  // was "this receipt recorded something unusable", which §2 calls INCONSISTENT
  // and refuses. Overwriting a receipt's blob map with junk was therefore a
  // one-keystroke bypass of the entire reviewed-bytes gate, and status:'complete'
  // made it worse rather than better — the receipt claimed full coverage while
  // carrying nothing comparable.
  //
  // Same posture as `status`, `kind` and `disposition` above: the
  // shape-transparency layer reports WHAT IS THERE and the READER decides what it
  // MEANS. commit-reviewed.mjs's receiptEvidenceClass now classifies a
  // present-but-not-a-map blobs value as 'inconsistent' for BOTH schema versions,
  // through this one shared field name — which is also what closes the identical
  // v1 hole (a v1 reviewed_state that IS an object whose `blobs` is not), so the
  // two versions cannot drift apart on the same question.
  //
  // NOTHING DOWNSTREAM CAN ITERATE A NON-MAP BY ACCIDENT: every consumer of
  // `reviewed_state.blobs` guards its own read (commit-reviewed.mjs's
  // receiptBlobEvidence and recordedBlobs both test typeof/null/Array before
  // Object.entries), which is why the raw value is safe to surface.
  //
  // ABSENT STAYS ABSENT: a v2 entry with NO content_evidence KEY AT ALL yields
  // `undefined` — the genuine grandfather §2 protects — as does a
  // content_evidence object carrying no `blobs` key, which is the shape a
  // legitimate status:'unavailable' receipt has.
  //
  // THE SAME HOLE ONE LEVEL UP, CLOSED BY THE SAME LINE (coordinator scope
  // addition, this round): when the ENTIRE content_evidence VALUE is present but
  // is not a proper object ("junk", 42, ["array"], null), `contentEvidence` is
  // null above and the old `: undefined` fallback read that as "this receipt
  // recorded nothing" — the identical present-read-as-absent defect the inner
  // guard just closed, one nesting level up, and reachable without ever touching
  // the inner guard. Surfacing the raw outer value instead is exact rather than
  // approximate: what the receipt recorded as its content evidence IS that value,
  // so the reader's one present-but-not-a-map test (commit-reviewed.mjs's
  // receiptEvidenceClass, over the shared isEvidenceObject below) answers BOTH
  // levels with no second branch, no marker key, and no new class. The
  // distinction that matters survives intact: `entry.content_evidence` is
  // `undefined` exactly when the key is absent.
  const blobs = contentEvidence ? contentEvidence.blobs : entry.content_evidence;
  return {
    // THE SCHEMA VERSION IS SURFACED, and it is the ONE discriminator a reader
    // may use to tell the two shapes apart (roster review LOW-2, board 7dd3200a).
    // Reaching this line means `entry.schema_version === 2` — the gate at the top
    // of this function — so this key is written BY THE ADAPTER and is never the
    // writer's copy of it. That distinction is the whole finding: `v2_deficient`
    // reads as a v2-only marker, but on the LEGACY branch this function returns
    // the raw entry UNTOUCHED, so a hand-written v1 entry carrying its own
    // `v2_deficient` key had that key survive into the "normalized" view and could
    // steer a reader down the v2 path. Nothing a v1 entry can carry reaches this
    // object, so `schema_version === 2` is exactly as trustworthy as the gate it
    // mirrors — and isLegacyEntry() below asks the question in one place for both
    // raw and normalized entries.
    schema_version: 2,
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
 *    'v1-no-lifecycle' — a LEGACY entry carrying a status:'discharged' that is
 *                        NOT backed by a contentful disposition. Treated as an
 *                        ORDINARY ACTIVE v1 receipt (spendable), which keeps the
 *                        v1 pass-through promise: a bare status key — the one
 *                        shape any ledger writer can produce with a single
 *                        keystroke — can never retire somebody else's review
 *                        evidence.
 *    'none'            — not claiming a discharge at all.
 *
 *  A LEGACY ENTRY CAN NOW REACH 'authenticated' (board 7dd3200a; decision
 *  57984926 §3's legacy-handle selector). This branch used to return
 *  'v1-no-lifecycle' UNCONDITIONALLY, and its stated reason was a fact about the
 *  verb rather than about the shape: "the discharge verb refuses v1 entries
 *  outright — so this string was never written by a discharge and cannot mean
 *  one". Since scripts/review-ledger.mjs discharge accepts a generated legacy
 *  handle, that premise is false: a v1 entry CAN now carry a genuine discharge,
 *  written as the same {status, disposition} PAIR onto the untouched original
 *  evidence (§3's rejected in-place migration is what keeps it a v1 entry —
 *  "explicit discharge may add lifecycle fields to a v1 entry as a requested
 *  transition"). Had this branch been left alone, discharging a v1 receipt would
 *  have been a NO-OP at every reading surface — H1 would keep reporting it and
 *  commit-reviewed would keep spending it — i.e. a verb that reports success and
 *  changes nothing, which is worse than the refusal it replaced.
 *  THE AUTHENTICATION BAR IS IDENTICAL FOR BOTH SCHEMA VERSIONS, deliberately:
 *  the forgery this guards against (one agent-written key silently retiring real
 *  reviewer evidence) is the SAME question on both shapes, so it gets the same
 *  answer, and the ONLY thing that changes for v1 is which class an
 *  unauthenticated marker falls to — 'v1-no-lifecycle' (SPENDABLE) rather than
 *  v2's 'unauthenticated' (withheld and disclosed). That asymmetry is the
 *  pass-through promise, kept: a v1 entry that has not been discharged behaves
 *  exactly as it did before this change.
 */
export function dischargeMarkerClass(normalized) {
  const e = normalized;
  if (!e || typeof e !== 'object' || e.status !== 'discharged') return 'none';
  // THE DISCRIMINATOR IS THE SCHEMA VERSION, NOT `v2_deficient` (roster review
  // LOW-2, board 7dd3200a). This branch used to read `e.v2_deficient ===
  // undefined`, which is a field the LEDGER WRITER controls on the legacy path:
  // normalizeLedgerEntry returns a v1 entry byte-identical, so a hand-written
  // {status:'discharged', v2_deficient:false} entry carrying no disposition fell
  // through to the v2 tail, classed 'unauthenticated', and was WITHHELD FROM
  // SPENDING — a two-key laundering route that suppresses real reviewer evidence
  // and contradicts this docblock's own v1 pass-through promise. isLegacyEntry
  // asks the adapter's OWN gate question (schema_version !== 2), and on a
  // normalized v2 entry `schema_version` is written by the adapter rather than
  // copied from the writer, so there is no key a v1 entry can add to reach the v2
  // tail: setting schema_version:2 routes it through the v2 branch ENTIRELY,
  // where `v2_deficient` is recomputed here and a contentless entry is correctly
  // reported as deficient.
  if (isLegacyEntry(e)) return isContentfulDisposition(e.disposition) ? 'authenticated' : 'v1-no-lifecycle';
  if (e.v2_deficient === true) return 'v2-deficient';
  return isContentfulDisposition(e.disposition) ? 'authenticated' : 'unauthenticated';
}

/** CONTENTFUL, NOT MERELY PRESENT (final review, pre-merge). `disposition: {}`
 *  satisfied "a non-null object" and therefore classed as AUTHENTICATED — the
 *  ONE class excluded SILENTLY from spending and from H1's report. So an empty
 *  object, which a hand-edit or a truncated write produces trivially, could hide
 *  real reviewer evidence with no line printed anywhere: the exact failure the
 *  authentication check exists to prevent, reached by a two-character payload.
 *  The two fields checked here are the two the verb ALWAYS writes and the two a
 *  human actually needs — WHY it was discharged and UNDER WHICH recognized
 *  class — so no genuine discharge changes class, while every contentless or
 *  invented-class marker falls to the safe, NOT-SPENT-and-DISCLOSED path (or, on
 *  a v1 entry, to the SPENDABLE 'v1-no-lifecycle' pass-through). The class list
 *  is §3's closed set, mirroring scripts/review-ledger.mjs's RECOGNIZED_CLASSES:
 *  a disposition naming a class the verb would have refused was not written by
 *  the verb.
 *  An ARRAY passes typeof === 'object' but is not the disposition object a real
 *  discharge writes — the same reasoning the identity check above applies. */
function isContentfulDisposition(d) {
  if (!isEvidenceObject(d)) return false;
  const reasonOk = typeof d.reason === 'string' && d.reason.trim() !== '';
  const classOk = d.class === 'foreign-session' || d.class === 'foreign-branch' || d.class === 'no-live-territory';
  return reasonOk && classOk;
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

// ===========================================================================
// V1 RECEIPT IDENTITY — ONE COMPUTATION, TWO SURFACES (board 7dd3200a).
//
// A v1 entry has no entry_id, so BOTH surfaces that must name one derive a
// stable identifier from the receipt's own content:
//   * scripts/commit-reviewed.mjs stamps it in `Review-Bytes-Waiver: <identity>`
//     (decision 57984926 §2: "entry_id for v2, stable fingerprint for v1");
//   * scripts/review-ledger.mjs discharge accepts it as the SELECTOR
//     (§3: "entry_id (v2) or a generated legacy handle").
// §2's fingerprint and §3's handle are the SAME CONCEPT — "which v1 receipt is
// this?" — so they are the same function. Two independently-derived v1
// identities would be a defect on its face: the handle a conductor reads off a
// waiver trailer must be the handle the discharge verb accepts, and any drift
// between two copies silently breaks that in one direction or the other.
// These five helpers moved here from commit-reviewed.mjs UNCHANGED for that
// reason (the same "imports it rather than keeping a second copy" rule
// isEvidenceObject above already follows); commit-reviewed.mjs's reviewed-bytes
// verdict still uses receiptBlobEvidence/isUsableBlobSha/normalizeReceiptPath
// through this import, so there is exactly one definition of each.
// ===========================================================================

/** A USABLE recorded blob value: exactly 40 hex characters, the shape `git
 *  hash-object` produces. Anything else is present-but-unusable evidence,
 *  which decision 57984926 §2 treats as INCONSISTENT rather than absent. */
export function isUsableBlobSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
}

/** The one path spelling used on BOTH sides of every comparison in the
 *  reviewed-bytes verdict: backslashes to '/', a stripped leading './'.
 *
 *  NAMED normalizeReceiptPath, NOT normalizeRepoPath (roster review LOW-3, board
 *  7dd3200a). `normalizeRepoPath` is TAKEN: it is @sterling/schemas' path
 *  primitive, the invariant-2 owner, and it THROWS on a drive prefix, a parent
 *  traversal or an absolute path — a dozen hook and script call sites depend on
 *  exactly that. THIS function is deliberately LENIENT: it must never throw,
 *  because it reads arbitrary agent-written ledger JSON inside a byte verdict
 *  that is fail-open on the advisory side, and a throw there would silently
 *  disable the check. Two functions with opposite failure contracts must not
 *  share a name across one codebase — the next reader to add
 *  `import { normalizeRepoPath } from '@sterling/schemas'` to a file that already
 *  imports this one gets a silent semantic swap, in either direction. */
export function normalizeReceiptPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The receipt's recorded blob evidence: `{map, collisions}`, keyed by
 *  normalized path, values RAW AND UNFILTERED. That last part is load-bearing:
 *  a present-but-unusable value ('not-a-sha', '', a number) must stay
 *  DISTINGUISHABLE from an absent one, because §2 refuses INCONSISTENT evidence
 *  while grandfathering ABSENT evidence. Filtering at read time collapses those
 *  two into one and hands the trivial bypass (write junk instead of a sha) the
 *  grandfather clause.
 *
 *  ALIAS COLLISION IS AN EVIDENCE DEFECT, NOT A SPELLING PREFERENCE (Codex
 *  review MED, fix round 2026-08-31). Two recorded keys can normalize to ONE
 *  path ('src/a.mjs' and '.\\src\\a.mjs'). Recording the SAME sha under both is
 *  harmless — one path, one answer, so the map keeps it and nothing is flagged.
 *  Recording DIFFERENT shas means the receipt contradicts ITSELF about what it
 *  reviewed, and a first-spelling-wins rule silently picks one of the two:
 *  appending a MATCHING alias beside a MISMATCHING real key would otherwise be a
 *  one-line way to make the mismatch never be compared. Such a path is returned
 *  in `collisions`, and the verdict refuses on it as INCONSISTENT evidence
 *  rather than choosing a winner. */
export function receiptBlobEvidence(e) {
  const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
  const b = rs && typeof rs.blobs === 'object' && rs.blobs !== null && !Array.isArray(rs.blobs) ? rs.blobs : null;
  const map = new Map();
  const collisions = new Set();
  if (!b) return { map, collisions };
  for (const [p, sha] of Object.entries(b)) {
    if (typeof p !== 'string' || p === '') continue;
    const n = normalizeReceiptPath(p);
    if (!map.has(n)) {
      map.set(n, sha);
      continue;
    }
    const prev = map.get(n);
    // Two usable shas compare case-insensitively (hex spelling is not evidence);
    // anything else compares by identity, so two junk values only agree when
    // they are literally the same value.
    const agree = isUsableBlobSha(prev) && isUsableBlobSha(sha) ? prev.toLowerCase() === sha.toLowerCase() : Object.is(prev, sha);
    if (!agree) collisions.add(n);
  }
  return { map, collisions };
}

/** The blob map alone — for the v1 fingerprint, where a collision changes the
 *  identifier's VALUE but never a verdict (the verdict reads the full evidence
 *  through receiptBlobEvidence and refuses on the collision). */
export function receiptBlobMap(e) {
  return receiptBlobEvidence(e).map;
}

/** The territory the receipt DECLARES, normalized. Used together with the blob
 *  keys to decide COVERAGE — iterating the blob map alone would silently skip
 *  a declared-but-unbound path, which is precisely the partial-coverage hole
 *  §2 clause 2 exists to close. */
export function receiptDeclaredPaths(e) {
  return Array.isArray(e && e.files) ? e.files.filter((f) => typeof f === 'string' && f !== '').map(normalizeReceiptPath) : [];
}

/** A v1 receipt has no entry_id, so its identity is a fingerprint of the
 *  RECEIPT'S OWN CONTENT (§2: "stable fingerprint for v1"). STABLE means
 *  deterministic given the receipt: two byte-identical receipts fingerprint
 *  identically. Deliberately NOT derived from the commit sha, the clock, or
 *  randomUUID — a per-invocation value is a fingerprint of nothing and cannot
 *  say WHICH receipt was waived or discharged, which is the only thing either
 *  caller wants it for.
 *  The inputs are the receipt's identity-bearing fields: agent_type, the
 *  dispatch instant, the DECLARED TERRITORY, and the recorded blob map (both
 *  sorted, so key order in the ledger file cannot change the answer). Guarded
 *  stringify because a ledger value is arbitrary JSON.
 *  `files` IS PART OF THE INPUT (roster review MED-1, fix round 2026-08-31):
 *  since file-scoped stamping, territory is one of the fields that distinguishes
 *  two otherwise-identical receipts (the measured shape: two dispatches in ONE
 *  message sharing agent_type AND the Start-millisecond, differing only in
 *  files[]). Omitting it made those two receipts waive under ONE trailer value,
 *  i.e. an audit trail that cannot say WHICH review was overridden.
 *  WIDTH: 32 hex characters (Codex review LOW) — 16 hex is 64 bits, and an audit
 *  key is not a cache key. 32 hex keeps the handle at 40 characters, well inside
 *  the 100-char trailer-value bound commit-reviewed's waiverIdentity applies. */
export function v1ReceiptFingerprint(e) {
  const blobs = [...receiptBlobMap(e).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const files = [...receiptDeclaredPaths(e)].sort();
  let canonical;
  try {
    canonical = JSON.stringify([e && e.agent_type, e && e.at, files, blobs]);
    if (typeof canonical !== 'string') canonical = '<unserializable>';
  } catch {
    canonical = '<unserializable>';
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** THE HANDLE, in its ONE spelling: `receipt-<32 lowercase hex>`. This exact
 *  string is what commit-reviewed stamps as a v1 waiver identity and what
 *  `review-ledger discharge --legacy-handle` accepts, so a conductor can carry
 *  one from either surface to the other verbatim. */
export function legacyReceiptHandle(e) {
  return `receipt-${v1ReceiptFingerprint(e)}`;
}

/** The handle's EXACT form, and the reason it is anchored on both ends. The
 *  discharge verb OVERWRITES an agent-writable evidence record with no
 *  resurrection path, so anti-pattern
 *  no-bounded-trail-guard-for-destructive-addressing (severity BLOCK) forbids
 *  accepting any forgiving spelling of it: no prefix, no abbreviation, no
 *  case-insensitive or whitespace-tolerant match. A handle that does not match
 *  this pattern character-for-character is refused BEFORE the ledger is read. */
export const LEGACY_HANDLE_PATTERN = /^receipt-[0-9a-f]{32}$/;

/** A LEGACY (v1) entry: no schema_version 2 envelope. §3's compatibility rule,
 *  stated once — "missing schema_version = legacy roster receipt" — so the
 *  handle surface and the entry_id surface cannot disagree about which entries
 *  each one addresses. Takes the RAW entry (the shape on disk), not a
 *  normalized one: normalizeLedgerEntry returns a legacy entry unchanged, so
 *  both work, but the selector reads raw. */
export function isLegacyEntry(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && raw.schema_version !== 2;
}
