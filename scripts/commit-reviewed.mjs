// scripts/commit-reviewed.mjs — CONDUCTOR-run CLI for part B of decision
// 12a26ca6-a301-466d-a45c-5e1eeff36694 (slug review-receipt-ledger; board
// 7814acc3-bb22-4cc5-abd7-789d6396743f).
//
// Structure mirrors scripts/enforcement-stamp.mjs: cwd-relative "target",
// fail() from scripts/lib/project.mjs (stderr + exit 1), no --target flag.
//
//   node scripts/commit-reviewed.mjs -m "<message>"
//
// Contract (decision 12a26ca6, part 2 of MECHANISM):
//   - Not a Sterling project root (no .sterling/ under cwd): refuse before
//     anything else — no message parsing, no git call.
//   - No -m / missing message: refuse (exit 1), no commit.
//   - Ledger entries are VALIDATED before stamping: only entries whose
//     agent_type is a string matching /^reviewer-[A-Za-z0-9_-]+$/ are
//     eligible (one line blocks \r/\n trailer-smuggling). A rejected entry
//     gets a one-line stderr warning naming why and is LEFT un-consumed in
//     the ledger — never silently dropped. Duplicate valid agent_types still
//     stamp one trailer each (no dedupe).
//   - Zero VALID entries in .sterling/review-ledger.json (missing file,
//     empty array, malformed JSON, or every entry rejected by validation —
//     all treated as empty): refuse (exit 1) with guidance — dispatch a
//     reviewer, or commit bare and answer at the merge gate — and make NO
//     commit.
//   - RECEIPT EXPIRY (decision review-ledger-receipt-expiry, 0408b295; board
//     09e03d76): a valid entry whose recorded `session_id` differs from THIS
//     session's, or whose recorded `branch` differs from the branch checked
//     out here, is FOREIGN — DISCLOSED BUT NOT STAMPED. It is named on stderr
//     (the foreign value verbatim + the receipt's age in the same 'Xh'
//     convention the staleness advisory uses), never turned into a trailer,
//     and never consumed: it stays in the ledger for H1 to report at the next
//     SessionStart. A receipt that records NO identity (the pre-expiry
//     {agent_type, files, at} shape), or whose identity cannot be judged
//     because this side is unknown (no session marker, no branch — e.g. a
//     detached HEAD), is UNJUDGEABLE and stays eligible: this mechanism only
//     ever withholds a stamp on positive evidence of foreignness, so its
//     failure direction is exactly today's behavior.
//   - HOW THIS CLI LEARNS THE CURRENT SESSION: hooks get session_id on stdin;
//     a bare CLI does not. H1 (SessionStart) writes the one it was handed to
//     .sterling/transient/session.json — a latest-value cell superseded by the
//     next SessionStart (P4), the same shape H10's pressure/gauge markers use
//     — and this reads it. STERLING_SESSION_ID overrides that file when set:
//     an explicit escape hatch for a non-hook context, and the seam the
//     receipt-expiry tests plumb their fixtures through.
//   - >=1 valid entry AND staged changes present: commit with the given
//     message plus one `Reviewed-By-Agent: <agent_type>` trailer per valid
//     entry (readable via the exact `%(trailers:key=Reviewed-By-Agent,
//     valueonly,unfold)` format scripts/direct-merge.mjs's receipt-gate
//     read uses). The commit is then VERIFIED against the CREATED SHA
//     (captured via `git rev-parse HEAD` immediately after the commit —
//     never a later, possibly-moved `HEAD` alias): the trailer is re-read
//     with that exact format and compared as a MULTISET against the
//     agent_types just stamped, and any mismatch (empty, partial, or
//     unrelated values) fails loudly (exit 1, commit-exists-but-unmergeable
//     message naming expected vs actual, ledger left un-consumed) rather
//     than silently landing an unmergeable or under-verified commit (N2).
//     Only on a successful verification does it CONSUME: RE-READ the ledger (it may have gained a fresh
//     entry while `git commit` ran — hooks can take seconds) and write back
//     every entry NOT identity-matched to the set just stamped (by entry_id for
//     a v2 entry, else agent_type + at + the partition fields), so a receipt
//     promoted mid-commit survives — P4: the artifact
//     that uses the evidence removes exactly that evidence, nothing more.
//     This read-modify-write is lock-guarded (withLedgerLock below) against
//     a concurrent H22 promotion write.
//   - SPEND ADVISORIES (board 09e03d76, warning-only — see the block above
//     the trailer lines): before committing, three anomalies in WHAT is being
//     spent are named on stderr and echoed in the reported summary's
//     `spend_warnings` — more than 3 receipts stamped on one commit, a
//     receipt whose recorded `files` do not overlap the staged diff, a
//     receipt recording no files at all, and a receipt older than a 12h
//     horizon. REVIEWED-BYTES joined that list (board 0f448efb): a receipt
//     carrying `reviewed_state.blobs` (the git blob sha of each reviewed file
//     recorded by H22 at review END) is compared against the INDEX blob sha of
//     the same path, and any difference is named — the first check here that
//     asks WHAT BYTES a receipt saw rather than only WHERE/WHOSE it is. That
//     field is also what the 12h horizon now measures from when present, since
//     `at` is stamped at the reviewer's DISPATCH, not its completion. THE
//     WARN-VS-REFUSE RULING HAS LANDED AND REVIEWED-BYTES IS NO LONGER PART OF
//     THIS ADVISORY BLOCK — see REVIEWED-BYTES ENFORCEMENT below. Every OTHER
//     check named here stays advisory: none of them rejects an entry, refuses,
//     or changes the no-dedupe rule, because the `files` attribution is
//     known-unreliable and a gate keyed on it would discard real reviews. That
//     block is FAIL-OPEN (guarded interpolation + a try/catch that degrades to
//     one stderr note), because a warning-only check that can abort a commit
//     inverts its own ruling.
//   - REVIEWED-BYTES ENFORCEMENT (decision 57984926, slug review-ledger-v2-
//     lifecycle-refuse-flip-and-external-review-design §2 — which executes the
//     REFUSE-LATER half of user ruling b0ad640d): a stamped-candidate receipt
//     whose recorded blob sha DIFFERS from the bytes about to be committed on a
//     path it covers, or whose evidence for such a path is INCONSISTENT
//     (present but not a usable sha) or ADMITTEDLY PARTIAL (truncated / v2
//     content_evidence.status 'partial') and therefore never bound that path,
//     now REFUSES the commit. All mismatches across all receipts aggregate into
//     ONE refusal naming every receipt and file, printed LAST, exit 1 — nothing
//     committed, nothing consumed, the ledger left byte-identical. Only
//     GENUINELY ABSENT evidence is grandfathered: a v1 receipt with no
//     reviewed_state KEY at all, and a v2 receipt whose content_evidence.status
//     is 'unavailable' AND which carries no usable blob sha (it commits, but is
//     DISCLOSED). Everything adjacent to those two is INCONSISTENT and refuses —
//     a reviewed_state key present but not an object, an 'unavailable' status
//     contradicted by recorded hashes, two blob keys normalizing to one path
//     with different shas. `--waive-bytes "<single-line reason, <=500 chars>"`
//     is the escape hatch: it waives the whole INVOCATION and stamps one
//     `Review-Bytes-Waiver: <identity>` trailer per AFFECTED receipt (v2
//     entry_id, or a receipt-derived stable fingerprint for v1), verified
//     post-commit exactly like Reviewed-By-Agent; asked for on a run with
//     nothing to waive, it is disclosed as unnecessary and stamps nothing.
//     This check is NOT inside the advisory fail-open wrapper — a refusal is
//     not an advisory — and it FAILS CLOSED (fix round 2026-08-31): an
//     unreadable index/tree, or a throw, still REFUSES for every receipt that
//     recorded comparable bytes for a path this commit touches, because "we
//     could not check" is not "it matched". Only a failure with NO comparable
//     evidence in play degrades to the REVIEWED-BYTES CHECK UNAVAILABLE warning.
//     After the commit lands, the CREATED COMMIT'S TREE is re-read and compared
//     against what the pre-commit check saw, so a `pre-commit` hook rewriting
//     the index cannot slip unverified bytes under a verified trailer.
//   - FILE-SCOPED STAMPING (board 51d93c34 requirement 2): stamping used to be
//     all-or-nothing — every eligible receipt landed on whatever was staged,
//     which forced concurrently-reviewed slices to commit as ONE unit
//     (decision reviewed-set-commits-as-one-unit-until-receipts-are-file-scoped,
//     c45b6ee4). Now a receipt whose recorded `files` intersect the staged set
//     is STAMPED; a receipt recording NO usable files is ALSO stamped (an empty
//     files[] is the STRONGEST unverifiable-territory signal, never "matches
//     nothing"); a receipt whose files intersect nothing staged is DEFERRED —
//     disclosed by name, NOT stamped, NOT consumed, NOT deleted, and left for
//     the commit that stages its territory, exactly like a foreign receipt.
//     FALLBACK: if NO eligible receipt matches the staged set there is nothing
//     to select on, so the rule does not apply and every eligible receipt is
//     stamped exactly as before — because H22's file attribution is measured
//     unreliable (board 09e03d76; research finding 289cd172: negated paths are
//     recorded, positively-asserted ones can be dropped, globs register
//     nothing), and refusing on it would brick this CLI and train
//     --waive-reviews. NET INVARIANT: the stamped set is always a SUBSET of the
//     old behavior's and never empty while any eligible receipt exists, so this
//     rule can only remove a FALSE attestation — it can never add a trailer,
//     invent evidence, or turn a commit that succeeds today into a refusal.
//   - >=1 valid entry but NOTHING STAGED: refuse (exit 1), do NOT consume
//     the ledger (P5 — never mint an empty commit that silently eats real
//     review evidence for nothing).
//   - The commit SUCCEEDS but the post-commit consume write fails: this is
//     NOT a refusal — the commit already exists. Print a distinct loud
//     message naming the ledger path and instructing manual cleanup, then
//     exit 1.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// sha256, for the v1 waiver fingerprint only (decision 57984926 §2) — a v1
// receipt has no entry_id, so its waiver trailer carries a STABLE identifier
// derived from the receipt's own content. See v1ReceiptFingerprint below.
import { createHash } from 'node:crypto';
import { arg, fail } from './lib/project.mjs';
// READ ADAPTER (decision 57984926, campaign slice S2b-1): h22-dispatch-
// register.mjs now promotes every NEW reviewer-* receipt as a v2 entry
// (nested reviewer/identity/territory/content_evidence); pre-existing v1
// entries are never migrated in place, so a real ledger mixes both shapes.
// Every read below maps each raw entry through this ONE adapter so the rest
// of this file keeps reading the same flat field names it always has
// (agent_type/files/at/session_id/branch/base_sha/reviewed_state) regardless
// of which shape produced them — v1 entries pass through byte-identical.
import { normalizeLedgerEntry } from './hooks/lib/review-ledger-entry.mjs';

const target = process.cwd();

// Moved up (was declared just before its first use, near the validation
// block below) so both the normal -m flow AND the --target-sha amend mode
// (which branches and exits before that code runs) share one definition.
const VALID_AGENT_TYPE = /^reviewer-[A-Za-z0-9_-]+$/;

// Guard the cwd before anything else (FIX 6): a bare directory has no
// review ledger and no meaningful contract to enforce.
if (!existsSync(join(target, '.sterling'))) {
  fail('commit-reviewed: not a Sterling project root — no .sterling/ directory under the current working directory');
}

const message = arg('-m') ?? arg('--message');
const targetShaArg = arg('--target-sha');
// PRESENCE, not truthiness (review fix): `-m ""` must still be treated as
// -m HAVING BEEN GIVEN for the contradiction check below — `if (message)`
// would silently let `--target-sha ... -m ""` through, since an empty string
// is falsy. The main flow's own `if (!message)` requirement further down is
// unaffected; only the contradiction check needed this.
const messageArgProvided = process.argv.slice(2).includes('-m') || process.argv.slice(2).includes('--message');

// ===========================================================================
// --waive-bytes "<reason>" (decision 57984926 §2) — the escape hatch the
// REFUSE flip needed decided in the same breath as the refusal itself, because
// legitimate rework-after-review produces the mismatch shape and a refusal
// with no sanctioned route is what trains --waive-reviews.
//
// PARSED AND VALIDATED HERE, BEFORE EITHER FLOW BRANCHES: a malformed
// invocation is a malformed invocation whether or not anything would have
// mismatched, and validating early means the reason-defect refusal can never
// be confused with (or fall through to) the byte refusal — two different
// failures must never share one message. Both flows read `waiveBytesReason`.
//
// THREE DEFECTS, ALL REFUSE, NONE SANITIZED:
//   (1) MULTI-LINE. A reason carrying \n or \r could forge a trailer line, and
//       "strip the newlines and carry on" would launder exactly that attempt
//       into an accepted waiver. The trailer VALUE never carries the reason
//       (it carries the receipt identity — see waiverIdentity below), so this
//       is defence in depth on top of that, not the only guard.
//   (2) EMPTY AFTER TRIM. PRESENCE, not truthiness — `--waive-bytes ""` is a
//       REASON DEFECT, never "no waiver requested". Read as absence it would
//       silently fall through to the byte refusal, i.e. the right exit code
//       for the wrong cause, which is indistinguishable from working.
//   (3) OVER THE BOUND. REFUSED, never truncated: a waiver's whole value is the
//       accountability text, and silently discarding half of it records a
//       decision nobody made.
// ===========================================================================
const WAIVE_BYTES_REASON_MAX = 500; // adjudicated bound (decision 57984926 §2, conductor adjudication 2026-08-31)
const waiveBytesProvided = process.argv.slice(2).includes('--waive-bytes');
const waiveBytesRaw = arg('--waive-bytes');
let waiveBytesReason = null;
if (waiveBytesProvided) {
  if (waiveBytesRaw === undefined) {
    fail('commit-reviewed: --waive-bytes requires a reason argument — a waiver with no reason records no accountability at all. Nothing committed, nothing consumed.');
  }
  if (/[\r\n]/.test(waiveBytesRaw)) {
    fail(
      `commit-reviewed: --waive-bytes reason must be a SINGLE LINE — the reason given contains a newline (${JSON.stringify(waiveBytesRaw)}). ` +
        `It is REFUSED, never silently stripped into acceptance: a multi-line reason can forge trailer lines, and laundering one into a valid waiver is ` +
        `worse than rejecting it. Re-run with a single-line reason. Nothing committed, nothing consumed.`
    );
  }
  const trimmed = waiveBytesRaw.trim();
  // (4) FLAG-SHAPED (roster review LOW-1, fix round 2026-08-31). `arg()` takes
  // the NEXT argv entry, so `--waive-bytes -m "msg"` silently records the reason
  // "-m" — an accountable override justified by a flag name, and the real
  // message argument then reads as a positional. Both spellings are refused:
  // anything starting with `--` (which no honest reason does), and an exact
  // match for one of THIS CLI's own flags (which catches the single-dash `-m`
  // without rejecting prose that legitimately opens with a hyphen).
  const OWN_FLAGS = ['-m', '--message', '--target-sha', '--waive-bytes'];
  if (trimmed.startsWith('--') || OWN_FLAGS.includes(trimmed)) {
    fail(
      `commit-reviewed: --waive-bytes was given ${JSON.stringify(waiveBytesRaw)} as its REASON, which is flag-shaped — almost certainly the next option ` +
        `rather than a reason (the reason is the argument immediately after --waive-bytes). A waiver justified by a flag name records no accountability ` +
        `at all, and accepting it would also consume the flag it swallowed. Re-run with --waive-bytes "<single-line reason>". Nothing committed, ` +
        `nothing consumed.`
    );
  }
  if (trimmed === '') {
    fail(
      'commit-reviewed: --waive-bytes was given an EMPTY reason — that is a reason defect, not "no waiver requested". A waiver is an accountable override of ' +
        'content evidence and must say why. Nothing committed, nothing consumed.'
    );
  }
  if (trimmed.length > WAIVE_BYTES_REASON_MAX) {
    fail(
      `commit-reviewed: --waive-bytes reason is ${trimmed.length} characters, over the ${WAIVE_BYTES_REASON_MAX}-character bound. It is REFUSED, NOT ` +
        `truncated — the reason IS the accountability record, and silently keeping half of it would record a decision nobody made. Shorten the reason (put ` +
        `the long form in the commit message body). Nothing committed, nothing consumed.`
    );
  }
  waiveBytesReason = trimmed;
}

// ===========================================================================
// --target-sha AMEND MODE (decision post-hoc-review-receipts-target-sha-amend,
// a899d6cc-0352-497f-ada5-f1accb643619; board 51d93c34 requirement 1). A
// review performed AFTER a bare `git commit` is otherwise unrecordable: this
// mode attaches current ledger receipts to an already-created UNPUSHED
// branch-tip commit by amending it. Entirely separate code path from the -m
// flow below (G7): it never requires -m, and its own refusals never cite
// -m/message wording, so a caller can't confuse the two failure vocabularies.
// See runTargetShaMode (bottom of file) for the guard-by-guard implementation.
// ===========================================================================
if (targetShaArg !== undefined) {
  if (messageArgProvided) {
    fail(
      'commit-reviewed: --target-sha and -m/--message are contradictory — amend mode reuses the target commit\'s existing message unchanged and never accepts a new one'
    );
  }
  runTargetShaMode(targetShaArg);
  process.exit(0);
}

if (!message) {
  fail('commit-reviewed: missing required -m/--message <commit message>');
}

// Tiny shared-convention lock guarding the review-ledger read-modify-write
// (duplicated here and in scripts/hooks/h22-dispatch-register.mjs — hooks
// stay dependency-light, so this is ~15 lines copied rather than a shared
// import; see the mirror copy there). mkdirSync is the atomic primitive: two
// processes racing to create the same directory, exactly one wins and the
// other gets EEXIST — no extra library needed. A lock dir older than 10s is
// treated as abandoned (a crashed holder) and removed. On timeout this
// proceeds UNLOCKED with a loud stderr note rather than crashing (P5).
function withLedgerLock(sterlingDir, run) {
  const lockPath = join(sterlingDir, 'review-ledger.lock');
  let acquired = false;
  for (let i = 0; i < 200 && !acquired; i++) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
          rmSync(lockPath, { recursive: true, force: true }); // stale — remove and retry immediately
          continue;
        }
      } catch {
        continue; // lock vanished under us (released concurrently) — retry immediately
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // ~5ms, no async available here
    }
  }
  if (!acquired) {
    console.error('commit-reviewed: review-ledger lock timed out — proceeding UNLOCKED (degraded-loud); a concurrent writer may lose this update');
    return run();
  }
  try {
    return run();
  } finally {
    rmdirSync(lockPath);
  }
}

const ledgerPath = join(target, '.sterling', 'review-ledger.json');
let ledger = [];
try {
  if (existsSync(ledgerPath)) {
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (Array.isArray(raw)) ledger = raw;
  }
} catch {
  ledger = []; // malformed ledger degrades to empty — treated identically to
  // a missing/empty ledger, never a crash
}
// Normalize ONCE, at read time — every downstream read in this file (validity,
// eligibility, file-scoping, spend advisories, trailer stamping) sees the flat
// legacy shape regardless of whether the raw entry was v1 or v2.
ledger = ledger.map(normalizeLedgerEntry);

const guidance =
  'commit-reviewed: no un-consumed review-ledger entries — dispatch a reviewer before committing, or commit bare and answer at the merge gate';
if (ledger.length === 0) {
  fail(guidance);
}

// Validate BEFORE stamping (FIX 4 — single line blocks \r/\n trailer
// smuggling): only entries whose agent_type matches the reviewer-* roster
// shape are eligible (VALID_AGENT_TYPE is declared near the top of the file,
// shared with --target-sha amend mode). A rejected entry is warned about and
// LEFT in the ledger un-consumed — never silently dropped.
const validEntries = [];
for (const e of ledger) {
  // MED-2 (decision 57984926 fix round, pin S13): a v2-CLAIMING entry missing
  // entry_id/started_at/identity is structurally deficient — normalizeLedgerEntry
  // marks it `v2_deficient` rather than mapping it into a spendable-looking
  // shape. Checked BEFORE the agent_type-format acceptance so a deficient
  // entry whose agent_type otherwise looks valid is never pushed to
  // validEntries — the strongest-unverifiable posture, same family as an
  // invalid agent_type, disclosed by its own distinct message.
  if (e && e.v2_deficient) {
    console.error(
      `commit-reviewed: skipping structurally-deficient v2 ledger entry (agent_type ${JSON.stringify(e.agent_type)} — missing entry_id/started_at/identity, per decision 57984926) — left un-consumed in the ledger, never stamped`
    );
  } else if (e && typeof e.agent_type === 'string' && VALID_AGENT_TYPE.test(e.agent_type)) {
    validEntries.push(e);
  } else {
    console.error(
      `commit-reviewed: skipping malformed ledger entry (agent_type ${JSON.stringify(e && e.agent_type)} does not match ^reviewer-[A-Za-z0-9_-]+$) — left un-consumed in the ledger`
    );
  }
}
if (validEntries.length === 0) {
  fail(guidance);
}

// ===========================================================================
// RECEIPT EXPIRY (decision review-ledger-receipt-expiry, 0408b295) — the
// lifecycle half of board 09e03d76. The measured leak: a code-touching commit
// made with bare `git commit` never consumes the receipts its reviews earned,
// so they survive and are all spent at once on a LATER commit they never
// reviewed. The shipped advisories DISCLOSE that at spend time; this WITHHOLDS
// the spend, because the receipt's life is bound to the session/branch that
// earned it (P4) and stamping it anywhere else is the defect, not a warning.
//
// NEVER DELETES. A foreign receipt is real reviewer evidence: it is left in
// the ledger untouched so H1 reports it at the next SessionStart and a human
// decides. Withholding a stamp is reversible; discarding the evidence is not.
// ===========================================================================

/** IDENTITY NORMALIZATION, applied at BOTH ends of every comparison below
 *  (Codex review, MEDIUM). The defect it closes: `session_id: ''` is PRESENT
 *  evidence in the ledger but read as ABSENCE by a bare `typeof === 'string'`
 *  test, so an empty identity could masquerade as differing-yet-ignored. One
 *  function, used on the receipt's value AND on this side's value, means '' can
 *  never mean one thing in one place and another elsewhere: empty-after-trim IS
 *  absence, everywhere, and the fail direction stays positive-evidence-only.
 *  Trimming matches what STERLING_SESSION_ID already got, so a marker written
 *  with a stray newline cannot read as foreign against its own session.
 *  A non-primitive (object/array) carries no usable identity and returns null —
 *  UNJUDGEABLE, hence eligible; String()-ing it would both risk a throw (a
 *  ledger value is arbitrary JSON — the {toString:null} class, pin P10) and
 *  manufacture a '[object Object]' that compares foreign against everything,
 *  withholding stamps on garbage rather than on evidence. */
function normIdentity(v) {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null; // null/undefined/object/array/symbol/bigint/NaN → no usable identity
}

/** THIS session's id. Env first (explicit override + the tests' fixture seam),
 *  then H1's SessionStart cell. null = unknown, which makes session identity
 *  UNJUDGEABLE — every receipt then stays eligible on the session axis, i.e.
 *  pre-expiry behavior, rather than being withheld on an absence. */
function currentSessionId() {
  const override = normIdentity(process.env.STERLING_SESSION_ID);
  if (override !== null) return override;
  try {
    const cell = JSON.parse(readFileSync(join(target, '.sterling', 'transient', 'session.json'), 'utf8'));
    return normIdentity(cell && cell.session_id);
  } catch {
    return null; // no marker yet (a session started before this shipped), or unreadable
  }
}

/** The branch checked out here — same derivation H22 records with
 *  (symbolic-ref, so a detached HEAD is null/unknown rather than the shared
 *  literal 'HEAD'). null = unjudgeable on the branch axis. */
function currentBranch() {
  try {
    const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
    return r.status === 0 ? normIdentity(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Age in the 'X.Xh' convention the STALE RECEIPT advisory below already uses. */
function ageLabel(at) {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? 'of unknown age (no usable timestamp)' : `${((Date.now() - t) / 3_600_000).toFixed(1)}h old`;
}

const thisSession = currentSessionId();
const thisBranch = currentBranch();
const eligibleEntries = [];
// Disclosures are collected as well as printed: a warning that reaches only
// stderr is invisible to anything reading this CLI's own JSON report, and what
// was NOT spent is exactly what the reader needs to weigh. (Kept separate from
// spendWarnings, which is declared further down — this runs before it.)
const foreignDisclosures = [];
for (const e of validEntries) {
  // POSITIVE EVIDENCE ONLY on both axes: the receipt must CARRY a usable
  // identity AND this side must know its own, before a mismatch can withhold a
  // stamp. A pre-expiry receipt (no session_id/branch at all) is unjudgeable
  // and stays eligible — this must never retroactively strand receipts earned
  // before the field existed. Both sides go through normIdentity, so an empty
  // or whitespace-only value is absence on either side, never a phantom
  // mismatch (and never a phantom MATCH: two nulls do not satisfy `!== null`).
  const receiptSession = normIdentity(e.session_id);
  const receiptBranch = normIdentity(e.branch);
  const foreignSession = receiptSession !== null && thisSession !== null && receiptSession !== thisSession;
  const foreignBranch = receiptBranch !== null && thisBranch !== null && receiptBranch !== thisBranch;
  if (!foreignSession && !foreignBranch) {
    eligibleEntries.push(e);
    continue;
  }
  // safeLabel is a hoisted, side-effect-free function declaration defined
  // below (with the review finding that motivated it): ledger values are
  // arbitrary JSON, and raw interpolation of one can THROW.
  const why = [
    foreignSession ? `a DIFFERENT session (receipt session_id ${safeLabel(e.session_id)}, this session ${safeLabel(thisSession)})` : null,
    foreignBranch ? `a DIFFERENT branch (receipt branch ${safeLabel(e.branch)}, checked out here ${safeLabel(thisBranch)})` : null,
  ]
    .filter(Boolean)
    .join(' and ');
  foreignDisclosures.push(
    `commit-reviewed: FOREIGN RECEIPT — NOT STAMPED, NOT CONSUMED, NOT DELETED — ${e.agent_type}'s receipt is ${ageLabel(e.at)} and was earned in ${why}. ` +
      `A review receipt's life is bound to the session and branch that earned it (decision review-ledger-receipt-expiry): stamping it onto this commit would ` +
      `claim a review that never looked at this diff, which is exactly the stale-spend leak board 09e03d76 measured. It stays in the ledger untouched — H1 ` +
      `reports it at the next SessionStart; consume it deliberately from its own branch/session, or remove it by hand once you have judged it.`
  );
}
for (const line of foreignDisclosures) console.error(line);
if (eligibleEntries.length === 0) {
  // Every receipt present is foreign. Refuse exactly as a ledger with zero
  // valid entries does — a bare commit here would silently ship an unreviewed
  // diff wearing no trailer, which the merge gate would then refuse anyway.
  // Nothing is consumed: the foreign receipts above survive verbatim.
  fail(
    `commit-reviewed: every un-consumed review receipt is FOREIGN (see the ${foreignDisclosures.length} disclosure(s) above) — none of them reviewed work in this ` +
      `session on this branch, so none is stamped and none is consumed. Dispatch a reviewer for THIS diff, or commit bare with 'git commit' and answer at the merge gate.`
  );
}

const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (staged.error) {
  fail(`commit-reviewed: git diff --cached --quiet failed: ${staged.error.message}`);
}
if (staged.status === 0) {
  // No staged differences: refuse WITHOUT consuming the ledger (P5) — an
  // empty commit would silently eat real review evidence for nothing.
  fail('commit-reviewed: nothing staged — refusing to create an empty commit that would consume review evidence for nothing');
} else if (staged.status !== 1) {
  // FIX 5: 0 and 1 are git's only documented outcomes for --quiet; anything
  // else is a real failure (git itself errored) and must not be silently
  // read as "staged".
  fail(`commit-reviewed: git diff --cached --quiet exited unexpectedly (${staged.status}): ${(staged.stderr || '').trim()}`);
}

// SABOTAGE-TARGETS-THE-DIFF CHECK (board 4a867546-2b3e-44ff-a5df-83fd4e9228f6):
// a mutation/sabotage check that PASSED can still verify nothing this commit
// changes — the incident this closes: a passing mutation check named
// sabotages of barrel_heat.gd while the diff changed machine_gun.gd, caught
// only by reviewers. Both inputs this needs — the sabotage's named target
// file(s) and the staged diff's file list — must actually be available to
// this CLI; the diff list is one git call away, and the sabotage target rides
// an OPTIONAL `sabotage_targets: string[]` field on the SAME ledger entry the
// reviewer receipt already lives on (the reviewing act that runs the mutation
// check is the act that writes the ledger entry, so this is the natural
// place for it — no other recorded source of this data reaches this script).
// WARN ONLY, never refuses: this is disclosure at commit time, not a gate: a
// missing/malformed field is guarded (Array.isArray) so an entry that names
// none never crashes and never warns.
// NOTHING WRITES sabotage_targets YET — the field is populated by the
// reviewer/mutation-check flow when that lands; this check is dormant (never
// fires) until then, and is safe to ship ahead of it (Array.isArray guard).
const diffNameOnly = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (diffNameOnly.error) {
  fail(`commit-reviewed: git diff --cached --name-only failed: ${diffNameOnly.error.message}`);
}
if (diffNameOnly.status !== 0) {
  fail(`commit-reviewed: git diff --cached --name-only exited unexpectedly (${diffNameOnly.status}): ${(diffNameOnly.stderr || '').trim()}`);
}
// -z (NUL-separated, no quoting) sidesteps core.quotePath's octal-escaping of
// non-ASCII/space-bearing paths, which the plain (newline) form can mangle.
// Both sides of the comparison are further normalized (backslash separators
// to '/', a stripped leading './') so a cosmetic path spelling difference
// can never produce a false "DOES NOT CHANGE" warning.
const normalizePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const stagedFiles = new Set(
  (diffNameOnly.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
);
// ===========================================================================
// FILE-SCOPED STAMPING (board 51d93c34 requirement 2). The measured defect:
// four valid same-session same-branch receipts covering THREE slices were all
// stamped and consumed on ONE commit, because stamping is commit-scoped while
// a receipt already records the files[] it reviewed. Decision
// reviewed-set-commits-as-one-unit-until-receipts-are-file-scoped (c45b6ee4)
// ruled the one-unit commit as the INTERIM answer and named this as the fix.
// Concurrently-reviewed slices can now commit separately: each commit spends
// only the receipts whose recorded territory it actually stages.
//
// THREE CLASSES, and the split is deliberate in every direction:
//   MATCHED      — usable files[] intersecting the staged set. Stamped.
//   UNATTRIBUTED — no usable file path at all. ALWAYS stamped. An empty
//                  files[] is the STRONGEST unverifiable-territory signal (see
//                  the RECORDS NO FILES advisory below), never "matches
//                  nothing": H22's extractor legitimately records nothing for
//                  a real review, and a reviewer brief phrased "do not modify
//                  X, only review it" is exactly the shape that produces it.
//                  Withholding here would silently destroy review evidence.
//   DEFERRED     — usable files[] intersecting NOTHING staged, while some
//                  OTHER receipt DID match. Not stamped, not consumed, not
//                  deleted; disclosed by name and left for the commit that
//                  stages its territory. Same posture as a foreign receipt.
//
// THE FALLBACK IS THE WHOLE SAFETY ARGUMENT. When NO eligible receipt matches
// the staged set, no selection is possible, so this rule does not fire at all
// and every eligible receipt is stamped exactly as before. That is not a
// loophole, it is the measured reality: research finding
// h26-registers-do-not-touch-paths-as-held-territory (289cd172, 2026-08-26)
// establishes that files[] is written by h22-dispatch-register.mjs with NO
// negation suppression and NO glob handling, so a receipt can both carry a
// path its brief forbade and LOSE a path the brief positively asserted
// ("do not edit tests/x, instead fix src/auth.mjs" drops src/auth.mjs). A
// zero-match ledger is therefore far more likely to mean the attribution
// failed than that every reviewer looked at other work — and board 09e03d76
// measured exactly that, every receipt mis-attributed. Refusing there would
// brick the CLI and train --waive-reviews, inverting this gate's purpose.
//
// INVARIANT THIS PRESERVES (the reason this is safe on the merge-gate
// surface): the stamped set is always a SUBSET of what today's code stamps,
// and is never empty while eligibleEntries is non-empty (the fallback
// guarantees it). So this rule can only ever REMOVE a trailer that would have
// been a false attestation — it can never add one, never invent evidence, and
// never turn a commit that succeeds today into a refusal.
//
// KNOWN, ACCEPTED LIMITATION (review, acknowledged no-action): a receipt whose
// files[] records a path git will never stage again — a pre-rename spelling, a
// deleted file — can be deferred on every future commit and so is effectively
// STRANDED in the ledger. It is not silent (each deferral discloses it by name,
// and H1 reports the survivor at the next SessionStart) and it is never a false
// attestation, which is the direction that matters on this surface. Remove such
// a receipt by hand once judged; do NOT relax the match to make it spendable.
const usableFiles = (e) => (Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string' && f) : []);
const touchesStaged = (e) => usableFiles(e).some((f) => stagedFiles.has(normalizePath(f)));
// Attributed = carries territory that CAN be judged. Scoping only applies when
// at least one attributed receipt actually matches this diff.
const fileScopingApplies = eligibleEntries.some((e) => usableFiles(e).length > 0 && touchesStaged(e));
const stampEntries = [];
const deferredEntries = [];
for (const e of eligibleEntries) {
  if (!fileScopingApplies || usableFiles(e).length === 0 || touchesStaged(e)) stampEntries.push(e);
  else deferredEntries.push(e);
}
// STRUCTURALLY UNREACHABLE, DELIBERATELY NOT SILENT (P5). The partition above
// guarantees a non-empty stamp set: fileScopingApplies is true only when some
// entry both has usable files AND touches the staged set (so that entry is
// stamped), and when it is false every eligible entry is stamped — and
// eligibleEntries was already proven non-empty. If a future edit breaks that
// reasoning, the failure would otherwise be SILENT AND WORST-CASE: zero trailer
// lines, a commit that lands anyway, and a trailer verification that compares
// [] against [] and PASSES — i.e. an unreviewed-looking commit reported as a
// success, with the ledger consumed. Refuse loudly instead, before committing.
if (stampEntries.length === 0) {
  fail(
    `commit-reviewed: INTERNAL INVARIANT VIOLATED — file-scoped stamping selected ZERO receipts out of ${eligibleEntries.length} eligible one(s), which the ` +
      `partition is constructed to make impossible. Refusing rather than creating a commit with no Reviewed-By-Agent trailer at all (which would land, ` +
      `verify vacuously, and consume the ledger). Nothing is stamped and nothing is consumed — report this, and commit with bare 'git commit' plus the ` +
      `merge gate if you need to proceed now.`
  );
}
// Collected as well as printed, for the same reason foreign disclosures are:
// what was NOT spent is exactly what a reader of this CLI's report needs.
const deferredDisclosures = deferredEntries.map(
  (e) =>
    `commit-reviewed: DEFERRED RECEIPT — NOT STAMPED, NOT CONSUMED, NOT DELETED — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) reviewed ` +
    `[${usableFiles(e).join(', ')}], none of which this commit stages, while ${stampEntries.length} other receipt(s) DO cover this diff. Stamping it here ` +
    `would claim a review of files absent from the diff (a false attestation on the merge gate's audit surface), and consuming it would strand the slice it ` +
    `really reviewed with no evidence at all (board 51d93c34). It stays in the ledger untouched — commit the files it names and it will be spent there.`
);
for (const line of deferredDisclosures) console.error(line);

// eligibleEntries, not validEntries: a foreign receipt is not being spent on
// this commit, so warning that its sabotage does not target this diff would be
// noise about a receipt this invocation deliberately leaves alone. stampEntries
// narrows that same reasoning one step further — a DEFERRED receipt is equally
// not being spent here.
for (const e of stampEntries) {
  if (!Array.isArray(e.sabotage_targets)) continue;
  for (const t of e.sabotage_targets) {
    if (typeof t !== 'string' || !t || stagedFiles.has(normalizePath(t))) continue;
    console.error(
      `commit-reviewed: SABOTAGE TARGETS ${t}, WHICH THIS DIFF DOES NOT CHANGE (named by ${e.agent_type}'s ledger entry) — this is a warning, not a refusal; verify the mutation actually pins the behavior this commit changes.`
    );
  }
}

// SPEND ADVISORIES (board 09e03d76-0986-431a-aa30-6262e01d399c): the ledger
// leaks — a code-touching commit made with bare `git commit` never consumes
// the receipts its reviews earned (measured: cb0d5a67, ea8a91da, both
// trailer-less), so they survive and are all spent at once on a LATER commit
// they never reviewed (measured: 32e4210 stamped 8, 35dfcad stamped 13).
// This block DISCLOSES that shape at the moment of spending. It is WARNING
// ONLY, by design and by the board item's explicit ruling: no entry is
// rejected, nothing is deduped, no path here can refuse. The reason a
// refusal would be wrong is the `files` attribution itself — it comes from
// H22's transcript-based dispatch-prompt extractor, which was measured
// attributing a real review's territory to the PREVIOUS slice's files, so a
// gate keyed on it would discard genuine reviews and train `--waive-reviews`.
// Until a receipt records its files from something authoritative, naming the
// anomaly and leaving the judgement to the human is the honest ceiling.
const MULTI_SPEND_WARN_ABOVE = 3; // 3 = the measured legitimate ceiling (one diff, three reviewer rounds: commit 30b2abf2)
const STALE_RECEIPT_HOURS = 12; // a receipt older than this predates the working session in every measured case
const spendWarnings = [];
function warnSpend(line) {
  spendWarnings.push(line);
  console.error(line);
}

// SAFE INTERPOLATION OF LEDGER-SUPPLIED VALUES (Codex review, HIGH): a ledger
// entry is JSON written by a hook, and every field except the regex-validated
// agent_type is arbitrary. Template interpolation calls toString, so a
// JSON-REPRESENTABLE entry can make `${e.at}` THROW — `{"at": {"toString":
// null}}` raises a TypeError, and so does String() on the same value, which is
// why the fallback below never reaches for it. A throw inside a warning-only
// block would abort a commit that is otherwise perfectly reviewed: the exact
// inversion of this feature's ruling. Every advisory interpolates through this.
// LABEL CONVENTIONS (conductor ruling, so pins can be exact): an ABSENT field
// is absent, not unserializable; a string prints QUOTED (at="n/a"), which is
// what makes an empty string, a stray space, or a look-alike numeric value
// visible in the advisory at all; everything else goes through a guarded
// JSON.stringify, and only a genuine serialization failure reads
// '<unserializable>'.
function safeLabel(v) {
  if (v === undefined) return '<absent>';
  try {
    const j = JSON.stringify(v);
    return typeof j === 'string' ? j : '<unserializable>'; // BigInt/symbol-valued and other non-representable inputs
  } catch {
    return '<unserializable>'; // circular graphs, throwing getters
  }
}

// FAIL-OPEN WRAPPER (Codex review, HIGH): safeLabel closes the KNOWN throw
// class; this closes the unknown ones. Any unforeseen throw anywhere in the
// advisory computation degrades to ONE disclosed stderr note and the commit
// proceeds untouched — an advisory can lose its own voice, but it can never
// cost a commit. Nothing inside this block writes, commits, or filters
// entries, so skipping it is always safe.
// Every advisory below is about WHAT IS BEING SPENT, so all of them iterate
// stampEntries — the foreign entries and the file-scope DEFERRED entries were
// already disclosed above, by mechanisms that WITHHOLD rather than warn, and
// re-warning about them here would double-report receipts this commit never
// touches.
try {
  if (stampEntries.length > MULTI_SPEND_WARN_ABOVE) {
    warnSpend(
      `commit-reviewed: MULTI-SPEND — ${stampEntries.length} review receipts are being stamped on ONE commit (advisory threshold: more than ${MULTI_SPEND_WARN_ABOVE}); ` +
        `all ${stampEntries.length} are consumed in this single act, so any that reviewed OTHER work is permanently spent here. Receipts: ` +
        `${stampEntries.map((e) => `${e.agent_type}@${safeLabel(e.at)}`).join(', ')}. ` +
        // CAUSE TEXT CORRECTED (board 51d93c34; decision c45b6ee4 measured the
        // old single-cause wording misdiagnosing the NORMAL case). The prior
        // text named only the bare-'git commit' leak, which would mislead
        // precisely in the workflow the session baseline (decision b39a478e)
        // makes standard: several lanes reviewed concurrently in ONE session.
        `TWO DIFFERENT CAUSES PRODUCE THIS, and they need opposite responses. (1) CONCURRENT MULTI-LANE REVIEW in one session — the normal shape under ` +
        `the session baseline (decision b39a478e), where each lane earns its own receipt; since file-scoped stamping shipped (board 51d93c34) every ` +
        `receipt named here either covers this diff or records no territory at all, so this is usually benign. (2) AN EARLIER code-touching commit made ` +
        `with bare 'git commit', which never consumed the receipts its own review earned — check for a trailer-less commit behind this one. ` +
        `This is a warning, not a refusal — nothing is rejected or deduped.`
    );
  }

  for (const e of stampEntries) {
    const entryFiles = Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string' && f) : [];
    if (entryFiles.length === 0) {
      // A receipt naming NO files is the STRONGEST form of unverifiable
      // territory, not the weakest — there is nothing to compare against the
      // diff at all — and H22's extractor can produce exactly this shape
      // (roster review). Reported distinctly from a non-overlap so the two
      // are never read as the same finding.
      warnSpend(
        `commit-reviewed: RECEIPT RECORDS NO FILES — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records no usable file paths at all ` +
          `(files=${safeLabel(e.files)}), so the territory it reviewed cannot be checked against this diff in either direction. That is the ` +
          `STRONGEST form of cannot-verify, not the weakest. ADVISORY ONLY, never a refusal: H22's transcript-based extractor can legitimately ` +
          `record nothing for a real review, so the entry is stamped and consumed exactly as before.`
      );
    } else if (!entryFiles.some((f) => stagedFiles.has(normalizePath(f)))) {
      // REACHABLE ONLY IN THE FILE-SCOPING FALLBACK (see the partition above):
      // when some other receipt DID match, a non-overlapping one is DEFERRED
      // rather than stamped, and is disclosed there instead. Reaching this line
      // therefore means NO eligible receipt matched the diff at all, which is
      // the state where the attribution itself is the prime suspect.
      warnSpend(
        `commit-reviewed: RECEIPT FILES DO NOT OVERLAP THIS DIFF — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) names [${entryFiles.join(', ')}], ` +
          `none of which this commit stages, AND no other eligible receipt covers this diff either — so file-scoped stamping (board 51d93c34) has nothing ` +
          `to select on and does not apply here. ADVISORY ONLY, and deliberately not a refusal: the recorded files come from H22's transcript-based ` +
          `dispatch-prompt extractor, which was MEASURED attributing a real review's territory to the wrong turn entirely (board 09e03d76) and which ` +
          `records negated paths while dropping some positively-asserted ones (research finding 289cd172), so a non-overlap is evidence to look at, never ` +
          `proof the review was unrelated. The entry is stamped and consumed exactly as before.`
      );
    }
  }

  // =========================================================================
  // REVIEWED-BYTES: THE COMPARISON ITSELF NO LONGER LIVES HERE (decision
  // 57984926 §2, slug review-ledger-v2-lifecycle-refuse-flip-and-external-
  // review-design; user ruling b0ad640d). Every check above this line asks
  // WHERE or WHOSE a receipt is — session, branch, filenames. NONE of them ever
  // asked WHAT BYTES it looked at, so a receipt earned in this session on this
  // branch, naming exactly the files being committed, was stamped without
  // objection onto content that changed after the review finished. The measured
  // report (dome-farmer 2026-08-28 §11/§13.4): the first receipt of a session
  // was timestamped before the substantive work even landed, and this CLI
  // stamped it regardless.
  //
  // THE RULING LANDED AND THE CHECK MOVED OUT OF THIS BLOCK. Board 0f448efb
  // left warn-vs-refuse open, and the warn phase then measured what the open
  // question was for: the advisories were ACCURATE AND IGNORED, and this CLI
  // prints the advisory and commits in the same invocation, so "did a
  // re-review follow" is not even measurable from here. Decision 57984926 §2
  // executed b0ad640d's REFUSE-LATER half, with --waive-bytes as the escape
  // hatch the refusal needed decided in the same breath. A REFUSAL CANNOT LIVE
  // INSIDE THIS BLOCK: everything here is wrapped in a fail-open try/catch that
  // degrades to one stderr note, which is right for a warning and fatal for a
  // gate — a refusal that a stray throw converts into a successful commit is
  // not a gate at all. The comparison therefore runs BELOW this block, outside
  // the wrapper, before the commit and before anything is consumed. See
  // reviewedBytesVerdict (bottom of file) and the REVIEWED-BYTES ENFORCEMENT
  // block after this try/catch.
  //
  // WHAT STAYS HERE is the evidence-shape disclosure the enforcement does not
  // duplicate: the truncation advisory and NO CONTENT EVIDENCE below, both of
  // which describe receipts the refusal deliberately does NOT act on.
  //
  // The evidence read is `reviewed_state.blobs` — a {path: git blob sha} map
  // that h22-dispatch-register.mjs records at SubagentSTOP, i.e. at review END
  // (a v2 entry's content_evidence.blobs arrives here through the same field
  // name via the read adapter). The recorded shas are produced by `git
  // hash-object` (filters applied) precisely so they are directly comparable to
  // the INDEX blob shas — a hand-rolled content hash would mismatch on every
  // file under autocrlf.
  //
  // WHY NOT MTIMES, the cheap version the report proposed: a `touch`, a branch
  // switch, or any checkout rewrites an mtime without changing a byte, and a
  // filesystem with coarse timestamps loses a same-second edit outright. A
  // content hash cannot be defeated that way, which is what makes this evidence
  // rather than a heuristic.
  //
  // SCOPED TO THE RECEIPT'S OWN TERRITORY, and only where that territory is
  // ACTUALLY STAGED — now doubly load-bearing, since the verdict refuses.
  // Comparing anything wider — a whole-worktree digest, say — would fire on
  // every commit of a normal multi-lane session, where sibling lanes
  // legitimately edit other files while this review ran. A check that fires
  // every time teaches its reader to ignore it, which is the exact fate the
  // files[] attribution advisory above is written to avoid.
  //
  // MISSING EVIDENCE IS NEVER A FINDING — BUT AN UNUSABLE ONE IS DISCLOSED
  // (review finding). A receipt with no reviewed_state (every receipt promoted
  // before this shipped) is still not audited here, exactly like the pre-expiry
  // receipts the session/branch check leaves unjudged. What changed is that
  // evidence which is PRESENT YET UNUSABLE — an emptied or malformed
  // reviewed_state — is now NAMED by the NO CONTENT EVIDENCE line below, rather
  // than degrading to output-free silence indistinguishable from a clean audit.
  // The exact boundary, and the residual gap it leaves, are stated there.
  const recordedBlobs = (e) => {
    const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
    const b = rs && typeof rs.blobs === 'object' && rs.blobs !== null && !Array.isArray(rs.blobs) ? rs.blobs : null;
    if (!b) return [];
    // Both halves validated: a ledger value is arbitrary JSON, and a malformed
    // pair must drop out silently rather than compare-as-mismatch and
    // manufacture a false disclosure out of bad data.
    return Object.entries(b).filter(
      ([p, sha]) => typeof p === 'string' && p !== '' && typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)
    );
  };
  // PARTIAL BINDING IS DISCLOSED, NOT ASSUMED AWAY (review finding, MEDIUM).
  // h22-dispatch-register records at most REVIEWED_BLOBS_CAP blob shas per
  // receipt (it bounds the argv `git hash-object` is spawned with) and marks
  // the overflow with `reviewed_state.truncated` / `truncated_of` — but until
  // this block NOTHING on the SPEND side read those keys, so the marker was
  // written at review end and then lost at consume time, which is the one place
  // it had to arrive. The measured shape: 65 reviewed files, the first 64
  // unchanged and the 65th edited after the review. The reviewed-bytes check
  // above compares the 64 it can see and finds them clean; NO CONTENT EVIDENCE
  // below does not fire either, because the blob map is non-empty. The commit
  // then stamps a trailer, consumes the ledger entry, and reports an audit
  // INDISTINGUISHABLE from a fully bound one — over a file whose bytes were
  // never compared at all.
  //
  // WHAT THIS CAN AND CANNOT SAY. It does NOT recover the missing evidence:
  // the shas for the files past the cap do not exist anywhere, so whether they
  // changed is unknowable from this side and this line never claims otherwise.
  // What it makes visible is the SCOPE of the audit — how many files the
  // receipt claimed versus how many it bound, and, concretely, which files THIS
  // COMMIT stages that the audit above could not have judged. Closing the gap
  // for real is a recording-side change (raise/remove the cap, or batch the
  // hashing), not something reachable here.
  //
  // STILL ADVISORY, BUT NO LONGER THE WHOLE ANSWER — AND THE RULING HAS MOVED
  // ON. This comment used to read "the user ruled WARN, not REFUSE, for this
  // whole mechanism"; that was the FIRST half of user ruling b0ad640d, whose
  // second half ("refuse later") was executed by decision 57984926 §2 (slug
  // review-ledger-v2-lifecycle-refuse-flip-and-external-review-design) on
  // 2026-08-31. What refuses now is a truncated receipt whose UNBOUND declared
  // file is one THIS COMMIT TOUCHES — the exact 65th-file shape measured above
  // — handled by reviewedBytesVerdict below, not here. THIS LINE keeps the
  // strictly wider disclosure the refusal does not make: the SCOPE of the
  // audit, including the globally-partial-but-locally-complete case that
  // deliberately still commits (evidence not covering this commit is only a
  // refusal when it fails to cover a file this commit touches). Nothing here
  // rejects a receipt, changes what is stamped, or alters what is consumed. It
  // goes through warnSpend so it also lands in `spend_warnings` on the JSON
  // report — a truncation disclosed only on stderr would still be dropped by
  // every reader of this CLI's own output.
  const truncationOf = (e) => {
    const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
    if (!rs || rs.truncated !== true) return null; // strict true — a truthy stray value is not this marker
    const of = Number.isInteger(rs.truncated_of) && rs.truncated_of > 0 ? rs.truncated_of : null;
    return { of };
  };
  for (const e of stampEntries) {
    const t = truncationOf(e);
    if (t === null) continue;
    const bound = new Set(recordedBlobs(e).map(([p]) => normalizePath(p)));
    const claimed = Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string' && f !== '').map(normalizePath) : [];
    // Files this commit actually stages that carry no recorded sha — the
    // concretely unaudited territory, as opposed to the abstract count.
    const unboundStaged = [...new Set(claimed)].filter((n) => stagedFiles.has(n) && !bound.has(n));
    warnSpend(
      `commit-reviewed: REVIEWED-BYTES BINDING TRUNCATED — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records ` +
        `reviewed_state.truncated${t.of === null ? '' : ` of ${t.of} reviewed file(s)`}, so only the ${bound.size} file(s) it bound could be ` +
        `compared against this diff; the rest were never hashed at review end and whether they changed since is NOT KNOWABLE from this receipt. ` +
        `${
          unboundStaged.length > 0
            ? `This commit stages ${unboundStaged.length} of the unbound file(s): ${unboundStaged.join(', ')} — no recorded bytes exist for them, which is why the enforcement below REFUSES rather than guessing.`
            : `None of the unbound files are staged by this commit, so the enforcement below covered every reviewed file it touches.`
        } ` +
        `A silently partial audit reads exactly like a clean one, which is why this is named rather than inferred. Advisory only: the receipt is ` +
        `stamped and consumed exactly as before.`
    );
  }

  // NO CONTENT EVIDENCE (review finding). The reviewed-bytes comparison can
  // only audit what reviewed_state.blobs actually carries, and it degrades to
  // NOTHING — with no output at all — when that field is emptied or filled with
  // values that fail the sha filter. Emptying it is therefore the trivial
  // bypass of the reviewed-bytes check, and until this line it looked exactly
  // like a clean audit. Mirrors the REVIEWED-BYTES CHECK UNAVAILABLE warning:
  // name what could NOT be verified. ADVISORY ONLY, and it stays advisory after
  // the refuse flip (decision 57984926 §2) precisely because of what the flip
  // does NOT cover: a receipt that RECORDS a bad value for a path this commit
  // touches is now INCONSISTENT evidence and refuses, but a receipt that
  // records nothing at all for a path nobody declared as truncated is
  // grandfathered, and this line is the only thing that says so out loud.
  //
  // WHAT IS DELIBERATELY NOT WARNED, and why: a commit where NO receipt has a
  // reviewed_state key at all. That is the shape of every receipt promoted
  // before reviewed-bytes recording shipped, i.e. the COMMON case today, and
  // warning on it would fire on essentially every commit — the fire-every-time
  // fate this file's own scoping comment above is written to avoid, and the
  // state commit-reviewed-spend-warnings P2 pins as a clean run. The residual
  // gap is stated plainly rather than hidden: the predicate below is purely
  // RELATIVE — it fires only when SOME receipt on the commit carries usable
  // evidence and another does not. So stripping reviewed_state off EVERY
  // receipt of a commit is silent — not just a single-receipt commit, any
  // commit where all receipts are missing the field — because there is
  // nothing here that independently expects the field to exist; it only
  // compares receipts against each other. This is not a case that closes
  // itself over time as more receipts carry the field, since a receipt
  // already carrying it can still be stripped back to nothing after the
  // fact. Closing it for real needs an INDEPENDENT expectation — e.g. a
  // registered promotion time after which reviewed_state is known to be
  // required — which nothing in this check currently supplies. What IS
  // caught: an emptied/malformed reviewed_state (present but yielding
  // nothing), and a missing one alongside a sibling that has real evidence —
  // a mechanism that recorded blobs for one receipt of this commit and none
  // for another.
  // FIX ROUND finding F2 (decision 57984926): a v2 entry's `reviewed_state` is
  // UNCONDITIONALLY present (mapped from v2's always-on content_evidence), so
  // `hasState` alone no longer distinguishes "an attempt was made and then
  // emptied/tampered" (v1's actual meaning, since v1 only ever wrote the key
  // on a successful hash) from "this receipt legitimately never had anything
  // to hash" (a v2 receipt with no declared territory, or a reviewed deletion
  // whose every declared path is absent — status:'unavailable'). The adapter
  // exposes `content_evidence_status` ONLY for a v2-derived entry (undefined
  // for v1/legacy), so branching on its presence keeps v1 behavior untouched
  // while giving v2 entries the honest reading: `status === 'unavailable'` or
  // no usable files were ever declared both RECORD NONE BY DESIGN and stay
  // silent here; anything else reaching this point (status 'complete'/
  // 'partial' with declared files, yet no usable blobs) means evidence was
  // EXPECTED and is genuinely missing — still warned, exactly as before.
  const anyRecordedEvidence = stampEntries.some((e) => recordedBlobs(e).length > 0);
  const noEvidence = stampEntries.filter((e) => {
    if (recordedBlobs(e).length > 0) return false;
    const hasState = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null;
    const v2Status = e && typeof e.content_evidence_status === 'string' ? e.content_evidence_status : undefined;
    if (v2Status !== undefined) {
      const recordedNoneByDesign = v2Status === 'unavailable' || usableFiles(e).length === 0;
      return !recordedNoneByDesign;
    }
    return hasState || anyRecordedEvidence; // v1/legacy — unchanged
  });
  if (noEvidence.length > 0) {
    warnSpend(
      `commit-reviewed: NO CONTENT EVIDENCE — ${noEvidence.length} of the ${stampEntries.length} receipt(s) being stamped record no usable ` +
        `reviewed_state.blobs (${noEvidence.map((e) => `${e.agent_type}@${safeLabel(e.at)}`).join(', ')}), so NOTHING they cover could be compared ` +
        `against the bytes those reviews actually looked at — for them the reviewed-bytes check did not pass, it did not run. Two very different causes ` +
        `share this shape: a reviewed_state that was emptied, stripped or malformed after the fact (which is exactly how that check is made to have ` +
        `nothing to check), or an H22 promotion that genuinely recorded none. Advisory only: the receipts are stamped and consumed exactly as before.`
    );
  }

  for (const e of stampEntries) {
    // AGE IS MEASURED FROM REVIEW END WHEN THE RECEIPT KNOWS IT (board
    // 0f448efb). `at` is copied from the H22 register entry, which is stamped at
    // SubagentSTART — so it marks when the review BEGAN, and a long review of
    // early bytes reads as FRESHER than it is against this horizon. When the
    // receipt carries reviewed_state.completed_at (the Stop instant) that is the
    // honest moment; `at` stays the fallback for every receipt promoted before
    // the field existed, so this can never retroactively change the verdict on
    // an older receipt. The message names WHICH moment it used, because "3h old"
    // means two different things depending on the answer.
    const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
    const completedAt = rs && typeof rs.completed_at === 'string' ? rs.completed_at : null;
    const rawCompletedMs = completedAt === null ? NaN : Date.parse(completedAt);
    // BOUNDED TO [at, now], AND DISCARDED WHEN IT FALLS OUTSIDE (review
    // finding). completed_at now DRIVES this horizon but is validated by
    // nothing except Date.parse, and — unlike `at`, which is coupled to H22's
    // duplicate-promotion key and to the consume identity, so editing it has
    // side effects — it is otherwise free. Anyone who can write
    // .sterling/review-ledger.json could therefore set a FUTURE completed_at
    // and make an arbitrarily old receipt read fresh, which would make the
    // honest-moment change a NET WEAKENING of the horizon it was meant to
    // strengthen. A review cannot end before its own dispatch, nor in the
    // future.
    //
    // AN OUT-OF-RANGE VALUE FALLS BACK TO `at`, IT IS NOT CLAMPED TO THE NEAR
    // BOUND — this is the load-bearing half, MEASURED: clamping a future
    // completed_at to `now` yields age 0, so the 30h-old receipt this exists to
    // catch STILL read fresh and the horizon still never fired; only the
    // warning changed. `at` is both the harder field to forge and the moment
    // that drove this horizon before completed_at existed, so falling back to
    // it can never be weaker than the pre-change behaviour. For a
    // too-EARLY completed_at that fallback IS the [at, now] lower clamp; for a
    // future one it is strictly stronger than the bound. Disclosed either way,
    // never silently repaired.
    const nowMs = Date.now();
    const startMs = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
    const lowerMs = Number.isNaN(startMs) ? -Infinity : startMs; // no usable `at` → only the now-bound is enforceable
    let completedMs = rawCompletedMs;
    if (!Number.isNaN(rawCompletedMs) && (rawCompletedMs < lowerMs || rawCompletedMs > nowMs)) {
      completedMs = NaN; // untrusted → the `at` fallback below owns the verdict
      warnSpend(
        `commit-reviewed: COMPLETED_AT OUT OF RANGE — ${e.agent_type}'s receipt records reviewed_state.completed_at ${safeLabel(completedAt)}, which is ` +
          `${rawCompletedMs > nowMs ? 'in the FUTURE' : `EARLIER than its own dispatch instant (at ${safeLabel(e.at)})`}. A review cannot end outside ` +
          `[dispatch, now], so that value is DISCARDED and the ${STALE_RECEIPT_HOURS}h staleness horizon below is measured from \`at\` instead. Trusted, ` +
          `a future completed_at would make an arbitrarily old receipt read fresh — that is a bypass of the horizon, not a rounding error. Advisory only: ` +
          `the entry is stamped and consumed as normal, but treat this receipt's timestamps as untrusted.`
      );
    }
    const useCompleted = !Number.isNaN(completedMs);
    const recordedAt = useCompleted ? completedMs : typeof e.at === 'string' ? Date.parse(e.at) : NaN;
    const moment = useCompleted
      ? `review END, reviewed_state.completed_at ${safeLabel(completedAt)}`
      : `review START, at ${safeLabel(e.at)} — the DISPATCH instant, so this age is an UNDER-estimate of how stale the review is`;
    if (Number.isNaN(recordedAt)) {
      warnSpend(
        `commit-reviewed: RECEIPT AGE UNVERIFIABLE — ${e.agent_type}'s receipt carries no usable timestamp (at=${safeLabel(e.at)}), so the ` +
          `${STALE_RECEIPT_HOURS}h staleness horizon could not be checked against it. Advisory only — the entry is stamped and consumed as normal.`
      );
      continue;
    }
    const ageHours = (Date.now() - recordedAt) / 3_600_000;
    if (ageHours > STALE_RECEIPT_HOURS) {
      warnSpend(
        `commit-reviewed: STALE RECEIPT — ${e.agent_type}'s receipt is ${ageHours.toFixed(1)}h old (measured from ${moment}; advisory horizon ` +
          `${STALE_RECEIPT_HOURS}h, i.e. almost certainly an earlier session than this commit). A receipt that outlived its own session was not ` +
          `consumed by the commit its review was for — most often because that commit was made with bare 'git commit'. Advisory only: it is still ` +
          `stamped and consumed here, so verify it actually reviewed THIS diff before relying on the trailer at the merge gate.`
      );
    }
  }
} catch (err) {
  warnSpend(
    `commit-reviewed: SPEND ADVISORIES SKIPPED — the advisory computation itself threw (${safeLabel(err && err.message ? err.message : err)}). ` +
      `Disclosed and NON-FATAL: the commit proceeds and every receipt is stamped and consumed exactly as it would have been, because a ` +
      `warning-only check must never abort a commit. Some or all spend advisories for this commit are missing — inspect the ledger by hand if you need them.`
  );
}

// ===========================================================================
// REVIEWED-BYTES ENFORCEMENT (decision 57984926 §2, slug review-ledger-v2-
// lifecycle-refuse-flip-and-external-review-design; executes user ruling
// b0ad640d's REFUSE-LATER half).
//
// PLACED HERE ON PURPOSE, and the position is the mechanism:
//   - OUTSIDE the advisory try/catch above. That wrapper turns any throw into
//     one stderr note and a successful commit, which is correct for a warning
//     and is a bypass for a gate.
//   - BEFORE `git commit` and before ANY consume, so a refusal leaves the
//     working tree, HEAD and the ledger exactly as it found them.
//   - LAST BEFORE THE COMMIT, so the refusal is the final thing printed. A
//     fatal message buried above eight advisories reads as a ninth advisory,
//     which is the habituation the warn phase measured.
//
// ITS OWN try/catch, AND IT FAILS CLOSED (Codex review HIGH, fix round
// 2026-08-31 — superseding the original fail-open adjudication, which read "an
// absence of verdict is not a mismatch" and degraded EVERY failure to a
// REVIEWED-BYTES CHECK UNAVAILABLE note plus a normal commit). The correction:
// an absence of verdict is not a MATCH either, and this gate's whole job is to
// refuse an unverified attestation. So the axis is not "did it run" but "was
// there evidence it should have compared":
//   - findings already established -> they STAND, whatever threw afterwards.
//   - no findings, but receipts recorded comparable bytes for paths this commit
//     touches -> REFUSE with an explanation (--waive-bytes is the way through,
//     so a broken git never bricks the CLI).
//   - nothing comparable recorded at all -> the old fail-open note, because
//     there was no verdict to lose.
// ===========================================================================
let byteFindings = [];
// Written INTO by the verdict as findings are established, so a throw anywhere
// after the fact still refuses on what was already proven (see the catch).
const byteProgress = { findings: [], evidence_entries: [], checked: new Map() };
let byteCheckedBlobs = new Map();
try {
  const verdict = reviewedBytesVerdict(
    stampEntries,
    stagedFiles,
    (paths) => {
      // --stage gives the INDEX blob sha, which is exactly what the commit about
      // to be created will contain. -z for the same path-mangling reason the
      // staged-file read above uses it. --literal-pathspecs (a GLOBAL git flag,
      // hence before the subcommand) because these paths come from the RECEIPT:
      // without it a recorded path containing `*`, `?` or a leading `:` is
      // interpreted as a pathspec pattern, so a receipt could match files it
      // never named — or match nothing and read as a clean audit (roster review
      // MED-3).
      const lsFiles = spawnSync('git', ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths], {
        cwd: target,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (lsFiles.error || lsFiles.status !== 0) {
        return { ok: false, detail: (lsFiles.stderr || (lsFiles.error && lsFiles.error.message) || `exit ${lsFiles.status}`).toString().trim() };
      }
      const map = new Map();
      for (const rec of (lsFiles.stdout ?? '').split('\0')) {
        if (!rec) continue;
        // Record shape: "<mode> <sha> <stage>\t<path>".
        const tab = rec.indexOf('\t');
        if (tab === -1) continue;
        const meta = rec.slice(0, tab).split(' ');
        if (meta.length < 2 || !/^[0-9a-f]{40}$/i.test(meta[1])) continue;
        map.set(normalizePath(rec.slice(tab + 1)), meta[1].toLowerCase());
      }
      return { ok: true, map };
    },
    byteProgress
  );
  byteFindings = verdict.findings;
  byteCheckedBlobs = verdict.checked;
  if (verdict.unreadable !== null) {
    // FAIL-CLOSED (Codex review HIGH, fix round 2026-08-31): this used to be
    // the fail-open REVIEWED-BYTES CHECK UNAVAILABLE note and a normal commit.
    // The receipts here DID record comparable bytes for staged paths, so the
    // only missing piece is our own read — and "we could not check" is not
    // "it matched". The verdict has already turned each such path into a
    // finding, so the aggregated refusal below carries them; this line names
    // the CAUSE, which the refusal's per-file text would otherwise bury.
    warnSpend(
      `commit-reviewed: REVIEWED-BYTES EVIDENCE COULD NOT BE READ — git ls-files --stage failed (${verdict.unreadable}), so the reviewed file(s) this ` +
        `commit stages could not be compared against the bytes their receipts recorded at review end. FAIL-CLOSED: receipts that recorded comparable ` +
        `bytes for those paths are REFUSED below rather than stamped on an unverified basis — one broken git call must not silently disable this gate. ` +
        `Fix the repository state and re-run, or override with --waive-bytes "<reason>" if a human has genuinely re-checked the content.`
    );
  }
  for (const e of verdict.contradictory) {
    // Disclosed as well as enforced: a receipt claiming its hashing never ran
    // while carrying hashes is a PRODUCER bug (or a tamper) worth seeing, and
    // the refusal below only speaks about the paths whose bytes moved.
    warnSpend(
      `commit-reviewed: CONTRADICTORY CONTENT EVIDENCE — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records content_evidence.status ` +
        `'unavailable' ("the hashing never ran") while CARRYING usable blob shas. The recorded bytes are the evidence and the status is only a claim ` +
        `about them, so this receipt is ENFORCED like any other rather than grandfathered — otherwise the status field would be a one-word disable ` +
        `switch for the whole check (decision 57984926 §2 fix round).`
    );
  }
  for (const e of verdict.unavailable) {
    // v2 content_evidence.status 'unavailable' = the hashing never ran. §2
    // grandfathers GENUINELY ABSENT evidence, and this is the v2 spelling of
    // it — so it COMMITS. It does not commit SILENTLY (conductor adjudication
    // 2026-08-31, frozen pin C3): silence is indistinguishable from a clean
    // audit, which is exactly the state that made the previous warn phase
    // unmeasurable.
    warnSpend(
      `commit-reviewed: NO CONTENT EVIDENCE (RECORDED AS UNAVAILABLE) — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records ` +
        `content_evidence.status 'unavailable', so the bytes it reviewed were ` +
        `never hashed and the file(s) it covers in this commit CANNOT be checked against them. Genuinely absent evidence is grandfathered by decision ` +
        `57984926 §2 — the receipt is stamped and consumed — but the absence is disclosed rather than passing for a clean audit.`
    );
  }
} catch (err) {
  // A THROW NEVER ERASES WHAT WAS ALREADY PROVEN (Codex review HIGH, fix round
  // 2026-08-31). This block used to reset byteFindings to [], so a throw AFTER
  // the verdict had established real mismatches — from the git callback, from a
  // hostile ledger value inside a later message — converted a refusal into a
  // clean commit. The findings live in byteProgress, written as they are
  // established, so they survive the throw and still refuse. Three cases, and
  // only the last one degrades to a warning:
  //   (a) findings already established -> REFUSE on them.
  //   (b) none established, but receipts carried AUDITABLE evidence for staged
  //       paths -> REFUSE with an explanation: evidence existed to compare and
  //       we failed to compare it, which is the same fail-closed reasoning as
  //       an unreadable index read. --waive-bytes is the route through.
  //   (c) no evidence to compare at all -> the original fail-open note. Nothing
  //       was checkable, so there is nothing this could have missed.
  byteCheckedBlobs = byteProgress.checked;
  byteFindings = byteProgress.findings;
  if (byteFindings.length > 0) {
    warnSpend(
      `commit-reviewed: REVIEWED-BYTES CHECK THREW AFTER ESTABLISHING FINDINGS (${safeLabel(err && err.message ? err.message : err)}) — ` +
        `${byteFindings.length} receipt finding(s) had already been proven when the computation failed, and they STAND: the refusal below is made on ` +
        `them. The check may be INCOMPLETE (later receipts were never evaluated), so treat the list as a floor, not a total. Report this.`
    );
  } else if (byteProgress.evidence_entries.length > 0) {
    byteFindings = byteProgress.evidence_entries.map((e) => ({
      entry: e,
      files: [
        `(EVIDENCE UNCHECKABLE — this receipt recorded content evidence covering path(s) this commit touches, but the verdict computation threw before it could be evaluated: ${safeLabel(
          err && err.message ? err.message : err
        )})`,
      ],
    }));
    warnSpend(
      `commit-reviewed: REVIEWED-BYTES CHECK THREW (${safeLabel(err && err.message ? err.message : err)}) before any verdict was reached, but ` +
        `${byteProgress.evidence_entries.length} receipt(s) carried auditable content evidence for path(s) this commit touches. FAIL-CLOSED: refusing ` +
        `rather than stamping them on an unverified basis — a crash must not be a quieter way to pass the check than a mismatch. Report this, and use ` +
        `--waive-bytes "<reason>" only if a human has genuinely re-checked the content.`
    );
  } else {
    warnSpend(
      `commit-reviewed: REVIEWED-BYTES CHECK UNAVAILABLE — the enforcement computation itself threw (${safeLabel(err && err.message ? err.message : err)}) ` +
        `before any receipt with auditable evidence was found. FAIL-OPEN and disclosed (conductor adjudication, decision 57984926 §2): with nothing ` +
        `comparable recorded for this commit's paths there was no verdict to lose, so the commit proceeds and every receipt is stamped and consumed — ` +
        `but NO content-level check ran. Report this, and inspect the ledger by hand.`
    );
  }
}

// THE WAIVER IS PER INVOCATION (§2: "one commit, one accountable decision"),
// but its TRAILERS are per AFFECTED receipt: only a receipt that actually
// mismatched is waived, so a Review-Bytes-Waiver trailer always means "this
// specific review was overridden" and never becomes decoration on a clean run.
const waivedReceipts = waiveBytesReason !== null ? byteFindings.map((f) => waiverIdentity(f.entry)) : [];
// AN UNNECESSARY WAIVER IS DISCLOSED, NOT SILENT (roster review LOW-2, fix round
// 2026-08-31). A waiver that overrode nothing looks, from the outside, exactly
// like a waiver that overrode something — same exit code, same commit, and
// (correctly) zero trailers. Saying so is what stops --waive-bytes becoming
// habitual belt-and-braces decoration: the caller learns THIS run did not need
// it, instead of concluding the flag is always harmless to add.
const waiverUnusedNote =
  waiveBytesReason !== null && byteFindings.length === 0
    ? `commit-reviewed: --waive-bytes WAS NOT NEEDED AND WAS NOT USED — no receipt's recorded bytes differ from what is being committed, so nothing was ` +
      `overridden and NO Review-Bytes-Waiver trailer is stamped (a waiver trailer is evidence of an accountable override, never decoration). The reason ` +
      `given was: ${waiveBytesReason}`
    : null;
if (waiverUnusedNote !== null) console.error(waiverUnusedNote);
if (byteFindings.length > 0) {
  if (waiveBytesReason === null) {
    console.error(reviewedBytesRefusal(byteFindings, 'staged for this commit'));
    process.exit(1);
  }
  console.error(
    `commit-reviewed: REVIEWED-BYTES REFUSAL WAIVED — --waive-bytes was given, so ${byteFindings.length} receipt(s) whose recorded bytes differ from ` +
      `what is being committed are stamped anyway. REASON: ${waiveBytesReason}. Waived receipts: ` +
      `${byteFindings.map((f, i) => `${f.entry.agent_type} [${waivedReceipts[i]}] — ${f.files.join('; ')}`).join(' | ')}. ` +
      `One Review-Bytes-Waiver trailer per receipt above is stamped on the commit and verified after it, so the override is auditable at the merge gate ` +
      `instead of invisible.`
  );
}

const trailerLines = [
  ...stampEntries.map((e) => `Reviewed-By-Agent: ${e.agent_type}`),
  // The trailer VALUE carries only the receipt identifier — never the reason,
  // which is arbitrary user text and belongs on stderr and in the JSON report
  // where it cannot shape a trailer line.
  ...waivedReceipts.map((id) => `Review-Bytes-Waiver: ${id}`),
];
const fullMessage = `${message}\n\n${trailerLines.join('\n')}`;

const commit = spawnSync('git', ['commit', '-m', fullMessage], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (commit.error) {
  // R2: spawnSync surfaces a spawn failure/timeout via .error (status stays
  // null and stderr/stdout stay empty in that case) — mirror the staged-check
  // pattern above rather than falling through to a bare, contentless message.
  fail(`commit-reviewed: git commit failed: ${commit.error.message}`);
}
if (commit.status !== 0) {
  fail(`commit-reviewed: git commit failed: ${(commit.stderr || commit.stdout || '').trim()}`);
}

// CAPTURE THE CREATED SHA (Codex P1-A): HEAD is a moving alias — a
// SUBSEQUENT `git rev-parse HEAD` call is not safe against a concurrent ref
// move, and in particular against a `post-commit` hook that itself commits
// again (moving HEAD) BEFORE the `git commit` invocation above even
// returns. Parse the sha `git commit` prints in its own summary line
// instead (`[branch[ (root-commit)] <abbrev-sha>] <subject>`) — that line
// is emitted by the commit-creating git process reporting the commit IT
// just made, before any hook runs, so it names the right commit regardless
// of what happens afterward in this working tree.
// Anchor on the trailing bracket, not the leading branch field: a detached
// HEAD renders the branch field as translated, SPACE-CONTAINING text
// ('[detached HEAD abc1234] ...') and non-English locales translate the
// field too, so a leading-field parse misses on perfectly good commits
// (review finding). Fallback: rev-parse HEAD — a weaker target (a
// concurrent ref move could race it), so its use is DISCLOSED in the
// verification messages rather than silent.
const commitShaMatch = /^\[.*?\b([0-9a-f]{7,40})\]/m.exec(commit.stdout ?? '');
let createdSha;
let shaSource = "git's own commit summary";
if (commitShaMatch) {
  createdSha = commitShaMatch[1];
} else {
  const revParse = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  if (revParse.status !== 0 || !(revParse.stdout ?? '').trim()) {
    fail(
      `commit-reviewed: COMMIT SUCCEEDED but its sha could not be parsed from git's summary line AND rev-parse HEAD failed — cannot verify the trailer. ` +
        `git commit stdout was: ${JSON.stringify(commit.stdout)}. The review-ledger entries were NOT consumed; ` +
        `note a retry requires amending the existing commit outside this CLI (nothing is staged any more).`
    );
  }
  createdSha = revParse.stdout.trim();
  shaSource = 'rev-parse HEAD (summary-line parse missed — weaker target, disclosed)';
}

// TRAILER SURVIVAL CHECK (N2): the commit above just landed with trailer
// lines in its message, but git's trailer PARSER (not string-search) is the
// only thing that decides whether direct-merge.mjs's merge gate will ever
// see them. The required shape is a blank line SEPARATING the subject from
// the trailer block, then a FINAL PARAGRAPH consisting ENTIRELY of
// trailer-shaped lines (`Key: value`) — that blank line is correct and
// necessary, not the danger. The destroyer is any NON-trailer line inside
// that final paragraph, or any content appended AFTER it: either one makes
// the whole paragraph unparseable as trailers, so `%(trailers:...)` returns
// nothing even though the trailer text is sitting right there in `git log`.
// Measured: `git commit --amend -F <file>` where the supplied message has
// such a stray line produces exactly this shape, and six code-touching
// commits in one session were unmergeable as a result. Re-read with the
// EXACT format string scripts/direct-merge.mjs's receipt-gate read uses
// (`%(trailers:key=Reviewed-By-Agent,valueonly,unfold)`), against the
// CREATED SHA (never bare HEAD), so this check can never pass while that
// gate would still refuse. Deliberately BEFORE ledger consumption: the
// commit already exists either way, but if the trailer did not survive, the
// evidence was never actually delivered — leave the ledger entries
// un-consumed for a retry rather than discarding them on a broken commit.
const trailerCheck = spawnSync(
  'git',
  ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', createdSha],
  { cwd: target, encoding: 'utf8', timeout: 30_000 }
);
if (trailerCheck.error) {
  fail(`commit-reviewed: COMMIT SUCCEEDED but the post-commit trailer verification could not run: ${trailerCheck.error.message}`);
}
if (trailerCheck.status !== 0) {
  // The commit already exists — a non-zero `git log` here (e.g. a corrupt
  // HEAD) is a git failure, not evidence the trailer was destroyed. Mirror
  // the staged-check posture above (FIX 5): an unexpected exit is reported
  // as exactly that, never silently folded into the empty-trailer branch.
  fail(
    `commit-reviewed: COMMIT SUCCEEDED but the post-commit trailer verification failed unexpectedly (git log exited ${trailerCheck.status}): ` +
      `${(trailerCheck.stderr || trailerCheck.stdout || '').trim()} — this is a git failure, not evidence the trailer was destroyed; ` +
      `investigate the repository state directly. The review-ledger entries were NOT consumed; ` +
      `note a retry requires amending the existing commit outside this CLI (nothing is staged any more).`
  );
}
// COMPARE AGAINST THE EXACT STAMPED MULTISET (Codex P1-A): a bare
// non-empty check would accept ANY surviving trailer value, including a
// PARTIAL survival (e.g. 2 of 3 stamped entries destroyed by a concurrent
// truncation) or a value that belongs to none of the entries this
// invocation actually stamped. Trailers are a multiset (duplicates allowed,
// FIX/R1 above), so both sides are sorted before comparing.
const expectedTrailerValues = [...stampEntries.map((e) => e.agent_type)].sort();
const actualTrailerValues = (trailerCheck.stdout ?? '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '')
  .sort();
const trailerMatches =
  actualTrailerValues.length === expectedTrailerValues.length &&
  actualTrailerValues.every((v, i) => v === expectedTrailerValues[i]);
if (!trailerMatches) {
  console.error(
    `commit-reviewed: COMMIT SUCCEEDED (${createdSha}, target resolved from ${shaSource}) but the 'Reviewed-By-Agent' trailer is NOT readable — or does not match what was just stamped — via ` +
      `the exact format string scripts/direct-merge.mjs's receipt-gate read uses ('git log -1 --format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)') — ` +
      `this commit exists but is UNMERGEABLE until fixed.\n` +
      `Expected: [${expectedTrailerValues.join(', ')}]\n` +
      `Actual:   [${actualTrailerValues.join(', ')}]\n` +
      `The required shape: subject, ONE blank line, then a FINAL PARAGRAPH consisting ENTIRELY of 'Key: value' trailer lines with nothing else mixed in and ` +
      `nothing appended after it — any other line inside or after that block makes the whole paragraph unparseable as trailers, even though the text is ` +
      `still present in the raw commit message. A known way this happens: 'git commit --amend -F <file>' where the supplied message has a stray non-trailer ` +
      `line inside the final paragraph, or trailing content after it. Inspect the commit message with 'git log -1 --format=%B ${createdSha}', fix it with a ` +
      `correctly-formatted amend, and re-run this same read before relying on the commit. ` +
      `The review-ledger entries were NOT consumed — they remain available for a retry.`
  );
  process.exit(1);
}

// WAIVER TRAILER SURVIVAL CHECK (decision 57984926 §2: "trailers verified
// after commit/amend like Reviewed-By-Agent"). Same read, same multiset
// comparison, same never-consume-before-it-passes posture — a waiver whose
// trailer did not survive is an override with no audit trail, which is worse
// than the mismatch it waived. Run UNCONDITIONALLY, including when nothing was
// waived: expected [] vs actual [] also proves no waiver trailer was invented.
const waiverCheck = spawnSync(
  'git',
  ['log', '-1', '--format=%(trailers:key=Review-Bytes-Waiver,valueonly,unfold)', createdSha],
  { cwd: target, encoding: 'utf8', timeout: 30_000 }
);
if (waiverCheck.error || waiverCheck.status !== 0) {
  fail(
    `commit-reviewed: COMMIT SUCCEEDED (${createdSha}) but the post-commit Review-Bytes-Waiver verification could not run ` +
      `(${waiverCheck.error ? waiverCheck.error.message : `git log exited ${waiverCheck.status}: ${(waiverCheck.stderr || '').trim()}`}) — ` +
      `the review-ledger entries were NOT consumed.`
  );
}
const expectedWaiverValues = [...waivedReceipts].sort();
const actualWaiverValues = (waiverCheck.stdout ?? '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '')
  .sort();
if (
  actualWaiverValues.length !== expectedWaiverValues.length ||
  !actualWaiverValues.every((v, i) => v === expectedWaiverValues[i])
) {
  console.error(
    `commit-reviewed: COMMIT SUCCEEDED (${createdSha}, target resolved from ${shaSource}) but the 'Review-Bytes-Waiver' trailer set does not match what ` +
      `this invocation waived — read with the same format string the receipt gate uses.\n` +
      `Expected: [${expectedWaiverValues.join(', ')}]\nActual:   [${actualWaiverValues.join(', ')}]\n` +
      `A byte waiver whose trailer did not survive is an unaudited override: the commit claims a review of bytes nobody reviewed, with nothing on the ` +
      `commit to say so. Fix the commit message shape (see the Reviewed-By-Agent guidance above) before relying on this commit. ` +
      `The review-ledger entries were NOT consumed — they remain available for a retry.`
  );
  process.exit(1);
}

// ===========================================================================
// INDEX TOCTOU — THE COMMIT'S TREE MUST STILL CARRY THE BYTES THAT WERE CHECKED
// (Codex review HIGH, fix round 2026-08-31).
//
// The reviewed-bytes verdict reads the INDEX (`git ls-files --stage`) BEFORE
// `git commit` runs. Between those two moments the index is writable by anyone
// — most concretely by a `pre-commit` hook, which git runs after this CLI's own
// read and which can `git add` whatever it likes. The result was a commit that
// passed the byte gate on one set of bytes and then stored ANOTHER, wearing a
// Reviewed-By-Agent trailer for the first: precisely the false attestation the
// whole flip exists to prevent, reached through a window the flip itself opened.
//
// So the created commit's TREE is re-read and compared against exactly what the
// pre-commit check saw. Same posture as the trailer verification above, for the
// same reason: the commit ALREADY EXISTS, so this is not a refusal — it is a
// loud "this commit carries unverified bytes", with the ledger deliberately NOT
// consumed so the receipts survive for a corrected re-run.
//
// SCOPE: only the paths the verdict actually compared (byteCheckedBlobs). Paths
// nobody recorded evidence for were never attested, so re-verifying them would
// claim a guarantee this CLI never made. When the verdict compared nothing (no
// evidence, an unreadable index, a waived run whose read failed) this block does
// nothing at all — there is no earlier reading to contradict.
// ===========================================================================
if (byteCheckedBlobs instanceof Map && byteCheckedBlobs.size > 0) {
  const auditPaths = [...byteCheckedBlobs.keys()];
  // --literal-pathspecs for the same reason the index read uses it: these paths
  // are receipt-derived, and a glob character must never widen or empty the read.
  const treeRead = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', '-r', createdSha, '--', ...auditPaths], {
    cwd: target,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (treeRead.error || treeRead.status !== 0) {
    console.error(
      `commit-reviewed: COMMIT SUCCEEDED (${createdSha}, target resolved from ${shaSource}) but its TREE could not be re-read to confirm it carries the ` +
        `bytes the reviewed-bytes check verified (git ls-tree failed: ${
          treeRead.error ? treeRead.error.message : `exit ${treeRead.status}: ${(treeRead.stderr || '').trim()}`
        }). The commit exists but carries UNVERIFIED bytes — a pre-commit hook can rewrite the index between the check and the commit, which is exactly ` +
        `what this re-read exists to catch. The review-ledger entries were NOT consumed — inspect 'git show ${createdSha}' before relying on this commit.`
    );
    process.exit(1);
  }
  const committedBlobs = new Map();
  for (const rec of (treeRead.stdout ?? '').split('\0')) {
    if (!rec) continue;
    // Record shape: "<mode> <type> <sha>\t<path>".
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const meta = rec.slice(0, tab).split(' ');
    if (meta.length < 3 || meta[1] !== 'blob' || !/^[0-9a-f]{40}$/i.test(meta[2])) continue;
    committedBlobs.set(normalizePath(rec.slice(tab + 1)), meta[2].toLowerCase());
  }
  const drifted = auditPaths
    .filter((p) => committedBlobs.get(p) !== byteCheckedBlobs.get(p))
    .map((p) => `  - ${p}: checked ${byteCheckedBlobs.get(p).slice(0, 12)}, committed ${(committedBlobs.get(p) ?? 'ABSENT/DELETED').slice(0, 12)}`);
  if (drifted.length > 0) {
    console.error(
      `commit-reviewed: COMMIT SUCCEEDED (${createdSha}, target resolved from ${shaSource}) but it CARRIES UNVERIFIED BYTES — ${drifted.length} path(s) ` +
        `changed between the reviewed-bytes check and the commit itself:\n${drifted.join('\n')}\n` +
        `The bytes this commit stores are NOT the bytes the receipts were checked against, so its Reviewed-By-Agent trailer attests a review of content ` +
        `nobody reviewed. The most likely cause is a 'pre-commit' hook (or a concurrent process) writing to the index after this CLI read it. ` +
        `The review-ledger entries were NOT consumed — they remain available. Inspect 'git show ${createdSha}', then re-commit the intended content ` +
        `(amend or reset) before relying on this commit at the merge gate.`
    );
    process.exit(1);
  }
}

// CONSUME the stamped entries: the commit that used the evidence removes it
// (P4). RE-READ rather than reuse `ledger` — `git commit` runs hooks inline
// and can take seconds, during which a reviewer's SubagentStop may have
// promoted a fresh entry into the ledger; that entry must survive. Only
// entries identity-matched to what was just stamped are removed — by entry_id
// for a v2 entry, else by agent_type + at + the partition fields
// session_id/branch/base_sha/files.
// Lock-guarded (FIX 2) against a concurrent H22 promotion write.
try {
  withLedgerLock(join(target, '.sterling'), () => {
    let freshLedger = [];
    try {
      if (existsSync(ledgerPath)) {
        const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        if (Array.isArray(raw)) freshLedger = raw;
      }
    } catch {
      freshLedger = []; // malformed at consume time degrades to empty, same posture as the initial read
    }
    // R1: identity is a MULTISET, not a Set. Two stamped entries can share
    // an identity key (same agent_type + Start-timestamp millisecond, e.g.
    // a parallel dispatch batch, which now share their session/branch too), so
    // identity collisions are handled here by
    // counting stamped occurrences and removing exactly one matching
    // re-read entry per stamped occurrence. Any excess occurrence (a fresh
    // receipt appended mid-commit that happens to collide with a stamped
    // identity) is left over and survives.
    //
    // IDENTITY IS COMPARED BY VALUE, NEVER THROUGH A SERIALIZED KEY. Two
    // earlier shapes of this comparison both failed, in opposite directions:
    //   - TEMPLATE INTERPOLATION (`${e.at}`) THREW 'Cannot convert object to
    //     primitive value' on the JSON-VALID entry `"at": {"toString": null}`
    //     (measured 2026-08-25, pin P10). The commit had already landed, so
    //     the throw surfaced as the post-commit consume failure and left the
    //     STAMPED entry in the ledger — exactly the stale-receipt leak board
    //     09e03d76 exists to close, reached from ledger DATA rather than from
    //     a missed commit.
    //   - A GUARDED-STRINGIFY KEY cured the throw but was total without being
    //     INJECTIVE, and its collisions fell the WRONG way (Codex review):
    //     two different too-deep values both hit JSON.stringify's RangeError
    //     and collapsed onto one token, and `at: 1e400` parses to Infinity
    //     whose stringify is the literal "null" — colliding with a genuine
    //     `at: null`. Either collision lets an UNSTAMPED fresh receipt spend
    //     a stamped count and be DESTROYED, the one outcome this path must
    //     never produce.
    // So: agent_type by strict string equality (already regex-validated), and
    // `at` by identity-or-bounded-deep-equality, with no serialization
    // anywhere. EVERY false case fails toward SURVIVAL — a type mismatch, a
    // differing key set, or hitting the depth cap all read as "not matched",
    // so the fresh entry stays in the ledger and is re-offered on the next
    // invocation, loudly, through the staleness/unverifiable advisories
    // above. Deep equality also ignores key ORDER, so an entry rewritten with
    // reordered keys between the two reads now MATCHES, where a serialized
    // key would have missed it.
    const IDENTITY_DEPTH_CAP = 64; // deeper than any real receipt; a pathological value hits the cap, is NOT matched, and SURVIVES
    const boundedDeepEqual = (a, b, depth) => {
      if (a === b) return true; // strings, finite numbers, Infinity, null, booleans, undefined, same reference
      if (depth <= 0) return false; // cap reached — not matched, so the fresh entry survives
      if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const keysA = Object.keys(a);
      if (keysA.length !== Object.keys(b).length) return false;
      for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!boundedDeepEqual(a[k], b[k], depth - 1)) return false;
      }
      return true;
    };
    // THE PARTITION FIELDS ARE PART OF THE IDENTITY (Codex review, HIGH).
    // agent_type + at alone is no longer a sufficient key now that a ledger can
    // hold BOTH an eligible and a foreign receipt: parallel reviewer dispatches
    // genuinely produce the same agent_type at the same Start-millisecond, so a
    // FOREIGN entry could be spliced away IN PLACE OF the eligible one it
    // collides with — three failures at once (the never-consumed guarantee
    // broken, foreign_receipts reporting a receipt that is now gone, and the
    // eligible receipt left behind to be spent a second time on the next
    // commit). Including session_id/branch/base_sha makes the very fields that
    // decided the partition decide the consume, so the two can never disagree.
    // NULL-SAFE via `?? null`: a legacy pre-expiry entry carries none of the
    // three, and absence normalizes identically on both sides (both reads come
    // from the same file), so those entries still match exactly as before.
    //
    // `files` JOINED THAT LIST WITH FILE-SCOPED STAMPING (review, HIGH — board
    // 51d93c34). The rule above is not decoration: EVERY field that decides the
    // partition must decide the consume. File scoping made `files` a partition
    // field, and omitting it reintroduced — inside the very feature built to
    // prevent it — the silent destruction of a real reviewer's evidence.
    // THE MEASURED SHAPE: two reviewer-security dispatches in ONE message share
    // agent_type AND the Start-millisecond `at`, and being same-session
    // same-branch they share session_id/branch/base_sha too, so those five
    // fields discriminate NOTHING. One records lane A, one lane B. Commit lane A
    // and the partition stamps A while deferring B — but if B precedes A in the
    // file, the filter below finds sameIdentity(B, A) true and splices B out.
    // Lane B's evidence is destroyed, the never-consumed guarantee is broken,
    // and A's receipt is then stamped onto the lane B commit through the
    // no-match fallback: a trailer naming a review that never saw that diff.
    // Before file scoping this was harmless (both were stamped and the multiset
    // consumed both); the DEFERRED class is what created the asymmetry.
    // SHAPE-STABLE across every files[] form, because both sides are parsed from
    // the SAME file: absent normalizes to null on both sides and matches;
    // absent vs [] correctly does NOT match (the a===null guard); [] vs [] and
    // ['x'] vs ['x'] deep-equal; a non-array string compares by string equality.
    // Max depth 2, far inside IDENTITY_DEPTH_CAP. Two receipts identical in
    // EVERY field including files still consume correctly — they share one
    // partition verdict by construction, and the multiset splice below claims
    // one stamped occurrence each, so neither can survive forever.
    //
    // entry_id WINS WHERE IT EXISTS (Codex review MED, fix round 2026-08-31).
    // Everything above describes a key assembled out of fields that were never
    // meant to identify anything; a v2 entry CARRIES a minted identity, and the
    // adapter surfaces it, so matching on the five-field key while an exact one
    // sits unread is a defect waiting for the next collision. When either side
    // has an entry_id the match is entry_id equality ALONE (plus agent_type,
    // which is regex-validated and free); the multi-field key stays the answer
    // for v1 entries, which have no id. A mixed pair (one side has an id, the
    // other does not) is a NON-match, which fails toward SURVIVAL exactly like
    // every other false case here. See ledgerEntryId (bottom of file).
    const identityField = (e, k) => (e[k] === undefined ? null : e[k]);
    const sameIdentity = (fresh, stamped) => {
      if (typeof fresh.agent_type !== 'string' || fresh.agent_type !== stamped.agent_type) return false;
      const sid = ledgerEntryId(stamped);
      const fid = ledgerEntryId(fresh);
      if (sid !== null || fid !== null) return sid !== null && fid !== null && sid === fid;
      return (
        boundedDeepEqual(fresh.at, stamped.at, IDENTITY_DEPTH_CAP) &&
        ['session_id', 'branch', 'base_sha', 'files'].every((k) =>
          boundedDeepEqual(identityField(fresh, k), identityField(stamped, k), IDENTITY_DEPTH_CAP)
        )
      );
    };
    // MULTISET consume by splicing the stamped list: each fresh entry claims at
    // most one still-unclaimed stamped occurrence, so two identical stamped
    // entries consume exactly two matching fresh ones and any excess fresh
    // occurrence survives. O(n^2) is irrelevant at ledger scale (tens).
    // The STAMPED set — stampEntries, never validEntries or eligibleEntries: a
    // foreign receipt and a file-scope DEFERRED receipt were both never
    // stamped, so neither must ever be identity-matched away here. That is the
    // "never silently deleted" half of both rulings, and it holds STRUCTURALLY
    // (those entries simply are not in this list) rather than by a filter that
    // could be got wrong.
    const unclaimedStamped = [...stampEntries];
    const survivors = freshLedger.filter((e) => {
      if (!e || typeof e !== 'object') return true; // a malformed fresh entry was never stamped — it survives untouched
      // Normalized ONLY for the identity comparison below — the RAW entry `e`
      // (v1 or v2, byte-for-byte as re-read from disk) is what actually
      // survives into `survivors`, so a v2 entry's true on-disk shape is
      // never rewritten by this consume step.
      const i = unclaimedStamped.findIndex((s) => sameIdentity(normalizeLedgerEntry(e), s));
      if (i === -1) return true;
      unclaimedStamped.splice(i, 1);
      return false; // consumes exactly one stamped occurrence
    });
    const tmpPath = join(target, '.sterling', `review-ledger.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(survivors));
    renameSync(tmpPath, ledgerPath);
  });
} catch (e) {
  // FIX 3: the commit ALREADY EXISTS — this is not a refusal, it is a
  // distinct failure mode where evidence was used but could not be removed.
  // Loud and specific, never conflated with a normal refusal message.
  // safeLabel (not raw interpolation): this very message must not itself throw
  // while reporting a failure — the P10 defect above reached the reader only
  // because the thrown value happened to be a plain Error.
  console.error(
    `commit-reviewed: COMMIT SUCCEEDED but the review ledger was NOT consumed (${safeLabel(e && e.message ? e.message : e)}) — ${ledgerPath} still carries the entries just stamped into this commit; remove them by hand before the next commit-reviewed invocation`
  );
  process.exit(1);
}

// The reported summary carries the advisories too (board 09e03d76): a warning
// printed only on stderr is invisible to anything that reads this CLI's own
// report, and the spend it names is exactly what the reader needs to weigh.
console.log(
  JSON.stringify({
    committed: true,
    reviewed_by: stampEntries.map((e) => e.agent_type),
    spend_warnings: spendWarnings,
    // What was deliberately NOT spent, for the same reason spend_warnings are
    // echoed here: a reader of this report must see the withheld receipts too.
    foreign_receipts: foreignDisclosures,
    // Withheld by FILE SCOPE rather than by session/branch identity (board
    // 51d93c34) — reported separately because the two withholdings mean
    // different things and have different remedies.
    deferred_receipts: deferredDisclosures,
    // THE OVERRIDE IS IN THE REPORT, not only on stderr and the commit
    // (decision 57984926 §2). The trailer carries the receipt identity; the
    // REASON — the accountable half — lives here and on stderr, so a reader of
    // this CLI's own output sees that content evidence was overridden and why.
    // null, never omitted: absence of the key would be indistinguishable from
    // an older CLI that could not waive at all.
    waived_bytes:
      waivedReceipts.length > 0
        ? { reason: waiveBytesReason, receipts: waivedReceipts, files: byteFindings.map((f) => ({ agent_type: f.entry.agent_type, files: f.files })) }
        : null,
    // A waiver that overrode nothing (roster review LOW-2): null on every other
    // run, so a reader can tell "no waiver was asked for" from "a waiver was
    // asked for and turned out to be unnecessary" — the same
    // null-never-omitted convention waived_bytes uses.
    waiver_unused: waiverUnusedNote,
  })
);

// ===========================================================================
// --target-sha AMEND MODE — implementation (decision
// post-hoc-review-receipts-target-sha-amend, a899d6cc). Everything below is a
// separate code path from the -m flow above: it is called (and the process
// exited) BEFORE any of the -m-flow code runs, so it is written to be fully
// self-contained rather than reaching for that flow's already-consumed
// `ledger`/`validEntries`/`stampEntries` locals. It reuses only genuinely
// shared, dependency-free helpers declared as hoisted `function` declarations
// elsewhere in this file (safeLabel, ageLabel, normIdentity, withLedgerLock)
// plus the module-level VALID_AGENT_TYPE regex (moved to the top of the file
// for exactly this reason) — never a `const` from the -m flow's body, which
// would still be in its temporal-dead-zone when amend mode runs.
//
// GUARD ORDER (cheapest/most-local first, network-ish last, nothing written
// until every guard has passed):
//   G1 tip-only -> G2 clean index+worktree -> G3 base_sha match -> G4
//   file-scoped partition (commit's OWN diff) -> G6 published-history guard
//   -> G5 amend + verify + consume + report both shas.
// ===========================================================================

/** git wrapper local to amend mode: returns {status, stdout, stderr, error}.
 *  `input` (optional) is piped to the child's stdin — used for
 *  interpret-trailers and the `-F -` amend, so a hostile/oversized message
 *  is never passed as a single argv entry. */
function gitRun(args, input) {
  return spawnSync('git', args, {
    cwd: target,
    encoding: 'utf8',
    timeout: 30_000,
    ...(input !== undefined ? { input } : {}),
  });
}

/** Strips exactly the ONE trailing newline `git log --format=...` adds as its
 *  own record-separator artifact — never more, so a genuine trailing blank
 *  line that is actually part of the stored bytes survives. Shared by the
 *  original-message recovery and the interpret-trailers output (both go
 *  through the same "%B round trip" — see the G5 header note). */
function stripOneTrailingNewline(s) {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** ONLY exit status 1 means the git-config key is absent (review fix D —
 *  config trichotomy). status 0 = present (use stdout). Anything else — a
 *  non-1 non-0 exit, or a spawn error — is a git failure, never silently
 *  folded into "absent"; the caller must refuse regardless of any seam. */
function readConfigValue(key) {
  const r = gitRun(['config', '--get', '--', key]);
  if (r.error) return { state: 'error', detail: r.error.message };
  if (r.status === 0) return { state: 'present', value: (r.stdout ?? '').trim() };
  if (r.status === 1) return { state: 'absent' };
  return { state: 'error', detail: (r.stderr || '').trim() || `git config exited ${r.status}` };
}

function runTargetShaMode(targetShaArg) {
  // ---------------------------------------------------------------------
  // G1: <sha> must resolve to the checked-out branch TIP and HEAD. A
  // non-tip commit is refused rather than rewritten via rebase, which would
  // multiply the blast radius onto its descendants (decision, alternatives
  // rejected).
  // ---------------------------------------------------------------------
  // NOTE (hygiene, measured): a leading `--` before a revision expression
  // breaks `rev-parse --verify`'s own resolution here (probed empirically —
  // `git rev-parse --verify --quiet -- <full-40-hex-sha>^{commit}` fails
  // even for a perfectly valid sha; `--` is git's rev/path separator for
  // this family of commands, not a generic "stop treating as option"
  // terminator). targetShaArg is never interpolated into any OTHER
  // argument position in this file, so there is no compounding risk; `--`
  // IS applied below wherever git actually accepts it (ls-remote, merge-base,
  // config --get — all verified empirically to tolerate it correctly).
  const resolve = gitRun(['rev-parse', '--verify', '--quiet', `${targetShaArg}^{commit}`]);
  if (resolve.status !== 0 || !(resolve.stdout ?? '').trim()) {
    fail(`commit-reviewed: --target-sha '${targetShaArg}' does not resolve to a commit in this repository — nothing amended.`);
  }
  const resolvedSha = resolve.stdout.trim();

  const branchResult = gitRun(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;

  const headResult = gitRun(['rev-parse', 'HEAD']);
  if (headResult.status !== 0) {
    fail(`commit-reviewed: git rev-parse HEAD failed: ${(headResult.stderr || '').trim()}`);
  }
  const headSha = headResult.stdout.trim();

  if (!branch || resolvedSha !== headSha) {
    fail(
      `commit-reviewed: --target-sha must resolve to the checked-out branch TIP and HEAD — '${targetShaArg}' resolves to ${resolvedSha}, ` +
        `but ${!branch ? 'HEAD is not on a branch (detached)' : `HEAD is ${headSha}`}. Amending a non-tip commit would rewrite its descendants, ` +
        `which this CLI refuses to do; only the tip commit is eligible. Nothing amended.`
    );
  }

  // ---------------------------------------------------------------------
  // G2: refuse on a dirty index OR a dirty worktree — both checked
  // separately, so the amended tree stays provably identical to what was
  // reviewed.
  // ---------------------------------------------------------------------
  const indexCheck = gitRun(['diff', '--cached', '--quiet']);
  if (indexCheck.error) fail(`commit-reviewed: git diff --cached --quiet failed: ${indexCheck.error.message}`);
  if (indexCheck.status !== 0 && indexCheck.status !== 1) {
    fail(`commit-reviewed: git diff --cached --quiet exited unexpectedly (${indexCheck.status}): ${(indexCheck.stderr || '').trim()}`);
  }
  const worktreeCheck = gitRun(['diff', '--quiet']);
  if (worktreeCheck.error) fail(`commit-reviewed: git diff --quiet failed: ${worktreeCheck.error.message}`);
  if (worktreeCheck.status !== 0 && worktreeCheck.status !== 1) {
    fail(`commit-reviewed: git diff --quiet exited unexpectedly (${worktreeCheck.status}): ${(worktreeCheck.stderr || '').trim()}`);
  }
  const indexDirty = indexCheck.status === 1;
  const worktreeDirty = worktreeCheck.status === 1;
  if (indexDirty || worktreeDirty) {
    fail(
      `commit-reviewed: refusing to amend with a dirty ${indexDirty ? 'index (staged, uncommitted changes present)' : 'worktree (unstaged modifications present)'} — ` +
        `--target-sha amend requires a clean index AND worktree, so the amended tree stays provably identical to what was reviewed. Nothing amended.`
    );
  }

  // ---------------------------------------------------------------------
  // Load + validate the ledger (own read — self-contained, see header note).
  // ---------------------------------------------------------------------
  const sterlingDir = join(target, '.sterling');
  const ledgerFilePath = join(sterlingDir, 'review-ledger.json');
  let ledger = [];
  try {
    if (existsSync(ledgerFilePath)) {
      const raw = JSON.parse(readFileSync(ledgerFilePath, 'utf8'));
      if (Array.isArray(raw)) ledger = raw;
    }
  } catch {
    ledger = []; // malformed ledger degrades to empty, same posture as the -m flow
  }
  // Same one-adapter normalization as the -m flow above.
  ledger = ledger.map(normalizeLedgerEntry);
  const validEntries = [];
  for (const e of ledger) {
    // MED-2 — same structural-completeness check as the -m flow (see there).
    if (e && e.v2_deficient) {
      console.error(
        `commit-reviewed: skipping structurally-deficient v2 ledger entry (agent_type ${JSON.stringify(e.agent_type)} — missing entry_id/started_at/identity, per decision 57984926) — left un-consumed in the ledger, never stamped`
      );
    } else if (e && typeof e.agent_type === 'string' && VALID_AGENT_TYPE.test(e.agent_type)) {
      validEntries.push(e);
    } else {
      console.error(
        `commit-reviewed: skipping malformed ledger entry (agent_type ${JSON.stringify(e && e.agent_type)} does not match ^reviewer-[A-Za-z0-9_-]+$) — left un-consumed in the ledger`
      );
    }
  }

  // ---------------------------------------------------------------------
  // G3: eligible receipts must carry base_sha === target sha. Missing or
  // different base_sha is a LOUD refusal naming base_sha — never a silent
  // judgement.
  // ---------------------------------------------------------------------
  const baseMatchingEntries = validEntries.filter((e) => typeof e.base_sha === 'string' && e.base_sha === resolvedSha);
  if (baseMatchingEntries.length === 0) {
    fail(
      `commit-reviewed: no eligible review receipt carries base_sha === the target sha (${resolvedSha}) — ${validEntries.length} valid ` +
        `ledger entr${validEntries.length === 1 ? 'y' : 'ies'} checked, none match. A receipt earned against a different base cannot be attributed to ` +
        `this exact commit's tree. Nothing amended, nothing consumed.`
    );
  }

  // ---------------------------------------------------------------------
  // G4: target file set = the commit's OWN diff (git diff-tree), then the
  // EXISTING MATCHED/UNATTRIBUTED/DEFERRED partition applies unchanged
  // (files:[] always stamps; a disjoint-files receipt is DEFERRED, not
  // consumed, when some OTHER receipt matched).
  // ---------------------------------------------------------------------
  // --root: a root commit (no parent) must still yield its FULL file set —
  // without it, diff-tree reports an empty diff for a parentless commit,
  // which would misclassify every receipt as DEFERRED/no-match. -z (NUL
  // separated) + no trim(), matching exactly how the -m flow already reads
  // the STAGED file list, so a newline- or space-bearing filename partitions
  // correctly instead of being mangled or split on the wrong boundary. `--`
  // is deliberately NOT added before resolvedSha here (unlike the rev-parse
  // call above): for diff-tree, `--` is diff-tree's OWN tree-ish/path
  // separator, and prefixing the revision with it would misclassify
  // resolvedSha as a pathspec instead of the tree-ish to diff. resolvedSha
  // is already canonical 40-hex from our own `rev-parse --verify` above, so
  // it can never be argv-injected regardless.
  const diffTree = gitRun(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', resolvedSha]);
  if (diffTree.error) fail(`commit-reviewed: git diff-tree failed: ${diffTree.error.message}`);
  if (diffTree.status !== 0) {
    fail(`commit-reviewed: git diff-tree exited unexpectedly (${diffTree.status}): ${(diffTree.stderr || '').trim()}`);
  }
  const normalizePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const targetFiles = new Set(
    (diffTree.stdout ?? '')
      .split('\0')
      .filter(Boolean)
      .map(normalizePath)
  );
  const usableFiles = (e) => (Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string' && f) : []);
  const touchesTarget = (e) => usableFiles(e).some((f) => targetFiles.has(normalizePath(f)));
  const fileScopingApplies = baseMatchingEntries.some((e) => usableFiles(e).length > 0 && touchesTarget(e));
  const stampEntries = [];
  const deferredEntries = [];
  for (const e of baseMatchingEntries) {
    if (!fileScopingApplies || usableFiles(e).length === 0 || touchesTarget(e)) stampEntries.push(e);
    else deferredEntries.push(e);
  }
  if (stampEntries.length === 0) {
    // Structurally unreachable (same invariant as the -m flow's partition),
    // deliberately not silent — see that flow's identical guard for why.
    fail(
      `commit-reviewed: INTERNAL INVARIANT VIOLATED — file-scoped stamping (target-sha mode) selected ZERO receipts out of ${baseMatchingEntries.length} ` +
        `base_sha-matching one(s), which the partition is constructed to make impossible. Refusing rather than amending with no Reviewed-By-Agent trailer ` +
        `at all. Nothing amended, nothing consumed — report this.`
    );
  }
  const deferredDisclosures = deferredEntries.map(
    (e) =>
      `commit-reviewed: DEFERRED RECEIPT — NOT STAMPED, NOT CONSUMED, NOT DELETED — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) reviewed ` +
      `[${usableFiles(e).join(', ')}], none of which the target commit ${resolvedSha} actually changed, while ${stampEntries.length} other receipt(s) ` +
      `DO cover it. It stays in the ledger untouched — amend the commit that stages its territory and it will be spent there.`
  );
  for (const line of deferredDisclosures) console.error(line);

  // ---------------------------------------------------------------------
  // G4b: REVIEWED-BYTES ENFORCEMENT, MEASURED AGAINST THE TARGET COMMIT'S
  // TREE (decision 57984926 §2: "--target-sha gets identical enforcement
  // against the TARGET COMMIT'S TREE"). IDENTICAL means the same
  // reviewedBytesVerdict, the same grandfather classes, the same aggregated
  // refusal and the same --waive-bytes escape — the ONLY difference is where
  // "the bytes being committed" are read from: `git ls-tree` on the target,
  // not the index. An `if (!targetSha)` guard around the new-commit check
  // would leave post-hoc amends silently unenforced, and no new-commit test
  // could ever see it.
  //
  // Placed BEFORE the published-history guard and before any mutation, so a
  // refusal here amends nothing and consumes nothing. FAIL-CLOSED on an
  // unreadable tree or a throw, on the same three-case rule as the -m flow (see
  // the header above its enforcement block). There is no warnSpend in this
  // flow, so every note goes straight to stderr.
  //
  // NO POST-AMEND TREE RE-CHECK IS NEEDED HERE, unlike the -m flow's index
  // TOCTOU guard: `git commit --amend -F -` changes only the message, and the
  // post-amend invariant check below already proves the new commit's TREE is
  // byte-identical to the target's — the tree this verdict measured.
  // ---------------------------------------------------------------------
  let byteFindings = [];
  // Same fail-closed out-param as the -m flow (see reviewedBytesVerdict).
  const byteProgress = { findings: [], evidence_entries: [], checked: new Map() };
  try {
    const verdict = reviewedBytesVerdict(
      stampEntries,
      targetFiles,
      (paths) => {
        // -r so a path in a subdirectory resolves to its blob record; -z for the
        // same path-mangling reason every other path read here uses it.
        // --literal-pathspecs (global flag, before the subcommand) because these
        // paths are RECEIPT-derived: a recorded path bearing a glob character
        // must not be read as a pathspec pattern (roster review MED-3).
        // Record shape: "<mode> <type> <sha>\t<path>".
        const lsTree = gitRun(['--literal-pathspecs', 'ls-tree', '-z', '-r', resolvedSha, '--', ...paths]);
        if (lsTree.error || lsTree.status !== 0) {
          return { ok: false, detail: (lsTree.stderr || (lsTree.error && lsTree.error.message) || `exit ${lsTree.status}`).toString().trim() };
        }
        const map = new Map();
        for (const rec of (lsTree.stdout ?? '').split('\0')) {
          if (!rec) continue;
          const tab = rec.indexOf('\t');
          if (tab === -1) continue;
          const meta = rec.slice(0, tab).split(' ');
          if (meta.length < 3 || meta[1] !== 'blob' || !/^[0-9a-f]{40}$/i.test(meta[2])) continue;
          map.set(normalizePath(rec.slice(tab + 1)), meta[2].toLowerCase());
        }
        return { ok: true, map };
      },
      byteProgress
    );
    byteFindings = verdict.findings;
    if (verdict.unreadable !== null) {
      // FAIL-CLOSED, identically to the -m flow: the receipts recorded
      // comparable bytes for paths this commit changes, so an unreadable tree
      // leaves the attestation unverified rather than verified.
      console.error(
        `commit-reviewed: REVIEWED-BYTES EVIDENCE COULD NOT BE READ — git ls-tree failed for target ${resolvedSha} (${verdict.unreadable}), so the ` +
          `reviewed file(s) this commit changes could not be compared against the bytes their receipts recorded. FAIL-CLOSED: receipts that recorded ` +
          `comparable bytes for those paths are REFUSED below rather than stamped on an unverified basis. Fix the repository state and re-run, or ` +
          `override with --waive-bytes "<reason>".`
      );
    }
    for (const e of verdict.contradictory) {
      console.error(
        `commit-reviewed: CONTRADICTORY CONTENT EVIDENCE — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records content_evidence.status ` +
          `'unavailable' while CARRYING usable blob shas. The recorded bytes are the evidence and the status is only a claim about them, so this receipt ` +
          `is ENFORCED like any other rather than grandfathered (decision 57984926 §2 fix round).`
      );
    }
    for (const e of verdict.unavailable) {
      console.error(
        `commit-reviewed: NO CONTENT EVIDENCE (RECORDED AS UNAVAILABLE) — ${e.agent_type}'s receipt (recorded ${safeLabel(e.at)}) records ` +
          `content_evidence.status 'unavailable', so the bytes it reviewed were never hashed. Genuinely absent evidence is grandfathered ` +
          `(decision 57984926 §2) — the receipt is stamped and consumed — but the absence is disclosed rather than passing for a clean audit.`
      );
    }
  } catch (err) {
    // Findings already established SURVIVE the throw and still refuse; a throw
    // before any finding still refuses when auditable evidence existed. Only a
    // throw with nothing comparable recorded degrades to a warning. (Same three
    // cases as the -m flow — see its catch for the full reasoning.)
    byteFindings = byteProgress.findings;
    if (byteFindings.length > 0) {
      console.error(
        `commit-reviewed: REVIEWED-BYTES CHECK THREW AFTER ESTABLISHING FINDINGS (${safeLabel(err && err.message ? err.message : err)}) — ` +
          `${byteFindings.length} receipt finding(s) had already been proven and they STAND: the refusal below is made on them. The check may be ` +
          `INCOMPLETE, so treat the list as a floor, not a total. Report this.`
      );
    } else if (byteProgress.evidence_entries.length > 0) {
      byteFindings = byteProgress.evidence_entries.map((e) => ({
        entry: e,
        files: [
          `(EVIDENCE UNCHECKABLE — this receipt recorded content evidence covering path(s) this commit changes, but the verdict computation threw before it could be evaluated: ${safeLabel(
            err && err.message ? err.message : err
          )})`,
        ],
      }));
      console.error(
        `commit-reviewed: REVIEWED-BYTES CHECK THREW (${safeLabel(err && err.message ? err.message : err)}) before any verdict was reached, but ` +
          `${byteProgress.evidence_entries.length} receipt(s) carried auditable content evidence for path(s) this commit changes. FAIL-CLOSED: refusing ` +
          `rather than amending on an unverified basis. Report this.`
      );
    } else {
      console.error(
        `commit-reviewed: REVIEWED-BYTES CHECK UNAVAILABLE — the enforcement computation itself threw ` +
          `(${safeLabel(err && err.message ? err.message : err)}) before any receipt with auditable evidence was found. FAIL-OPEN and disclosed: with ` +
          `nothing comparable recorded there was no verdict to lose, so the amend proceeds, but NO content-level check ran. Report this.`
      );
    }
  }
  const waivedReceipts = waiveBytesReason !== null ? byteFindings.map((f) => waiverIdentity(f.entry)) : [];
  // Unnecessary-waiver disclosure, identical rule to the -m flow (roster LOW-2).
  const waiverUnusedNote =
    waiveBytesReason !== null && byteFindings.length === 0
      ? `commit-reviewed: --waive-bytes WAS NOT NEEDED AND WAS NOT USED — no receipt's recorded bytes differ from the target commit's tree, so nothing ` +
        `was overridden and NO Review-Bytes-Waiver trailer is stamped. The reason given was: ${waiveBytesReason}`
      : null;
  if (waiverUnusedNote !== null) console.error(waiverUnusedNote);
  if (byteFindings.length > 0) {
    if (waiveBytesReason === null) {
      console.error(reviewedBytesRefusal(byteFindings, `in the tree of target commit ${resolvedSha}`));
      process.exit(1);
    }
    console.error(
      `commit-reviewed: REVIEWED-BYTES REFUSAL WAIVED — --waive-bytes was given, so ${byteFindings.length} receipt(s) whose recorded bytes differ from ` +
        `the target commit's tree are stamped anyway. REASON: ${waiveBytesReason}. Waived receipts: ` +
        `${byteFindings.map((f, i) => `${f.entry.agent_type} [${waivedReceipts[i]}] — ${f.files.join('; ')}`).join(' | ')}.`
    );
  }

  // ---------------------------------------------------------------------
  // G6: PUBLISHED-HISTORY GUARD. Query the configured upstream's ACTUAL
  // remote ref (never a stale local tracking ref). Refuse when the target is
  // reachable from that remote sha, and ALSO when publication is unprovable
  // (no configured upstream / unreachable remote / malformed query) — no
  // waiver exists. STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM treats "no
  // configured upstream" as provably unpublished (test seam only); it never
  // bypasses an actual reachability refusal or a config-query error —
  // reachability, and any UNPROVABLE state, beat the seam.
  //
  // (A) UPSTREAM REF: the ref to query is branch.<name>.merge — the EXACT
  // configured merge ref — never assumed as refs/heads/<branch name>. A
  // local branch tracking a differently-named remote branch must not read
  // that mismatch as "absent ref = unpublished".
  // (D) CONFIG TRICHOTOMY: readConfigValue's state is 'absent' ONLY on git
  // config's own exit-1 convention; 'present' on exit 0; anything else is
  // 'error' and refuses regardless of the seam (a config-read failure is not
  // evidence of anything).
  // ---------------------------------------------------------------------
  const seamOn = normIdentity(process.env.STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM) !== null;
  const remoteInfo = readConfigValue(`branch.${branch}.remote`);

  if (remoteInfo.state === 'error') {
    fail(
      `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — could not determine the configured upstream (git config --get branch.${branch}.remote: ` +
        `${remoteInfo.detail}); publication status is UNPROVABLE, refusing to amend regardless of the seam (no waiver flag exists). Nothing amended, nothing consumed.`
    );
  }
  if (remoteInfo.state === 'absent') {
    if (!seamOn) {
      fail(
        `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — no configured upstream for branch '${branch}', so publication status is UNPROVABLE; ` +
          `refusing to amend (no waiver flag exists). Set STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM=1 (test-fixture-only seam) to treat "no upstream" as ` +
          `provably unpublished. Nothing amended, nothing consumed.`
      );
    }
    // seam ON, no upstream configured at all — provably unpublished by the
    // fixture seam's definition; fall through to the amend.
  } else {
    const remoteName = remoteInfo.value;
    if (!remoteName) {
      fail(
        `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — branch.${branch}.remote is configured but empty; publication status is UNPROVABLE, ` +
          `refusing to amend regardless of the seam (no waiver flag exists). Nothing amended, nothing consumed.`
      );
    }
    const mergeInfo = readConfigValue(`branch.${branch}.merge`);
    if (mergeInfo.state !== 'present' || !mergeInfo.value) {
      fail(
        `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — a remote ('${remoteName}') is configured for branch '${branch}' but ` +
          `branch.${branch}.merge is ${mergeInfo.state === 'error' ? `unreadable (${mergeInfo.detail})` : 'missing or empty'} — the exact remote ref to ` +
          `check cannot be determined. Publication status is UNPROVABLE, refusing to amend regardless of the seam (no waiver flag exists). ` +
          `Nothing amended, nothing consumed.`
      );
    }
    const mergeRef = mergeInfo.value;

    // (B) LS-REMOTE HARDENING: `--` is a mandatory option terminator ahead
    // of the remote name and ref (both can, in principle, be adversarial
    // config values). Accept ONLY output that is exactly zero or one record
    // shaped <40-hex>\t<the exact requested ref> — anything else (multiple
    // refs, a malformed line, extra whitespace shape) is UNPROVABLE, never
    // guessed at.
    const lsRemote = gitRun(['ls-remote', '--', remoteName, mergeRef]);
    if (lsRemote.error || lsRemote.status !== 0) {
      fail(
        `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — could not query the actual remote ref for '${remoteName}' ` +
          `(git ls-remote failed: ${(lsRemote.stderr || (lsRemote.error && lsRemote.error.message) || '').trim()}); publication status is UNPROVABLE, ` +
          `refusing to amend (no waiver flag exists). Nothing amended, nothing consumed.`
      );
    }
    const lsRemoteLines = (lsRemote.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    let remoteSha = null;
    if (lsRemoteLines.length === 1) {
      const parts = lsRemoteLines[0].split(/\s+/);
      if (parts.length !== 2 || !/^[0-9a-f]{40}$/i.test(parts[0]) || parts[1] !== mergeRef) {
        fail(
          `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — git ls-remote returned a malformed record for '${remoteName} ${mergeRef}' ` +
            `(${JSON.stringify(lsRemoteLines[0])}); publication status is UNPROVABLE, refusing to amend (no waiver flag exists). Nothing amended, nothing consumed.`
        );
      }
      remoteSha = parts[0];
    } else if (lsRemoteLines.length > 1) {
      fail(
        `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — git ls-remote returned ${lsRemoteLines.length} records for a single ref ` +
          `('${remoteName} ${mergeRef}'), which should never happen for an exact ref query; publication status is UNPROVABLE, refusing to amend ` +
          `(no waiver flag exists). Nothing amended, nothing consumed.`
      );
    }
    // lsRemoteLines.length === 0: the remote is reachable but has never seen
    // this ref at all, which makes the target commit provably unpublished —
    // proceed without needing the seam.

    if (remoteSha) {
      const ancestorCheck = gitRun(['merge-base', '--is-ancestor', '--', resolvedSha, remoteSha]);
      if (ancestorCheck.status === 0) {
        fail(
          `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — ${resolvedSha} is reachable from the ACTUAL remote ref ${remoteName}/${mergeRef} ` +
            `(${remoteSha}); it has already been published. Amending published history is refused unconditionally — no waiver flag exists. ` +
            `Nothing amended, nothing consumed.`
        );
      }
      if (ancestorCheck.status !== 1) {
        fail(
          `commit-reviewed: --target-sha PUBLISHED-HISTORY GUARD — could not determine reachability against the actual remote ref ` +
            `(git merge-base --is-ancestor exited ${ancestorCheck.status}: ${(ancestorCheck.stderr || '').trim()}); publication status is UNPROVABLE, ` +
            `refusing to amend (no waiver flag exists). Nothing amended, nothing consumed.`
        );
      }
      // ancestorCheck.status === 1: provably NOT reachable from the actual
      // remote ref — proceed without needing the seam.
    }
  }

  // ---------------------------------------------------------------------
  // G5: amend.
  //  (1) TRAILER PARAGRAPH: use `git interpret-trailers` rather than manual
  //      string concatenation, so a message whose final paragraph is ALREADY
  //      trailer-shaped (round one's Reviewed-By-Agent lines from an earlier
  //      --target-sha amend) gets the new lines appended INTO that same
  //      paragraph — round one's trailers stay parseable by %(trailers), and
  //      a second amend never opens a competing trailer block.
  //  (2) MESSAGE FIDELITY: the original body is read via `%B` and used
  //      completely unmodified (no trailing-newline stripping) as
  //      interpret-trailers' stdin; the composed message is then passed to
  //      `git commit --amend --cleanup=verbatim -F -` via STDIN, never `-m`
  //      — cleanup=whitespace (the default for -m) collapses consecutive
  //      blank lines, which would corrupt fidelity to the original body.
  //  The trailer-survival verification below then compares against the
  //  UNION of pre-existing Reviewed-By-Agent values (read BEFORE the amend)
  //  plus the newly stamped ones — never the new set alone, or round one's
  //  trailers would look "lost" on every second amend.
  // ---------------------------------------------------------------------
  const originalMessageResult = gitRun(['log', '-1', '--format=%B', resolvedSha]);
  if (originalMessageResult.status !== 0) {
    fail(`commit-reviewed: could not read the original commit message: ${(originalMessageResult.stderr || '').trim()}`);
  }
  // `git log --format=%B` adds exactly ONE trailing newline of its own as a
  // record-separator artifact (measured empirically), on top of whatever the
  // stored commit object itself ends with — strip exactly that one, never
  // more, to recover the TRUE stored bytes (a `.replace(/\n+$/, '')` here
  // would also eat a genuine blank line the original author put at the
  // message's edge, which is exactly what byte-fidelity must not do).
  const originalMessage = stripOneTrailingNewline(originalMessageResult.stdout ?? '');

  const existingTrailerCheck = gitRun(['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', resolvedSha]);
  if (existingTrailerCheck.status !== 0) {
    fail(`commit-reviewed: could not read the original commit's existing trailers: ${(existingTrailerCheck.stderr || '').trim()}`);
  }
  const existingTrailerValues = (existingTrailerCheck.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  // Read the pre-existing waiver trailers too, for the SAME union reason the
  // Reviewed-By-Agent read above exists: an earlier --target-sha round may
  // already have stamped one, and comparing against the new set alone would
  // report round one's waiver as "lost" on every second amend.
  const existingWaiverCheck = gitRun(['log', '-1', '--format=%(trailers:key=Review-Bytes-Waiver,valueonly,unfold)', resolvedSha]);
  if (existingWaiverCheck.status !== 0) {
    fail(`commit-reviewed: could not read the original commit's existing Review-Bytes-Waiver trailers: ${(existingWaiverCheck.stderr || '').trim()}`);
  }
  const existingWaiverValues = (existingWaiverCheck.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const trailerLines = [
    ...stampEntries.map((e) => `Reviewed-By-Agent: ${e.agent_type}`),
    // Same interpret-trailers path as the review trailers (never manual string
    // concatenation), so a waiver lands INSIDE the one trailer paragraph and
    // stays parseable by %(trailers) exactly like Reviewed-By-Agent.
    ...waivedReceipts.map((id) => `Review-Bytes-Waiver: ${id}`),
  ];
  // --if-exists add IS LOAD-BEARING (roster review MED-1, fix round
  // 2026-08-31). git's default for this is `addIfDifferentNeighbor`, which
  // SILENTLY DROPS a trailer whose key+value already sits beside the insertion
  // point — and duplicate identical values are legitimate here twice over: the
  // no-dedupe rule means two receipts from the same agent_type stamp two
  // identical Reviewed-By-Agent lines, and a second amend round can re-stamp a
  // value round one already added. Dropped lines then fail the trailer-survival
  // multiset comparison below, so the amend reports COMMIT SUCCEEDED BUT
  // UNMERGEABLE for a message git itself chose to deduplicate. `add` appends
  // unconditionally, which is exactly the multiset semantics this CLI verifies
  // against. Passed as a flag, not read from trailer.ifexists config, so a
  // repository-local config cannot change the outcome.
  const interpretArgs = ['interpret-trailers', '--if-exists', 'add'];
  for (const line of trailerLines) interpretArgs.push('--trailer', line);
  const interpret = gitRun(interpretArgs, originalMessage);
  if (interpret.error) fail(`commit-reviewed: git interpret-trailers failed: ${interpret.error.message}`);
  if (interpret.status !== 0) {
    fail(`commit-reviewed: git interpret-trailers exited unexpectedly (${interpret.status}): ${(interpret.stderr || '').trim()}`);
  }
  // interpret-trailers echoes back its own single trailing newline (matching
  // whatever the input ended with) — strip it here too, for the same
  // byte-fidelity reason as originalMessage above: `-F -` with
  // --cleanup=verbatim stores EXACTLY what it is given, with no forced
  // trailing-newline normalization (unlike `-m`, which always appends one),
  // so passing this through unstripped would grow the message by one
  // newline on every single amend round.
  const fullMessage = stripOneTrailingNewline(interpret.stdout ?? '');

  // ---------------------------------------------------------------------
  // (3) TOCTOU: the ls-remote round trip above is a long window. Re-run the
  // HEAD==target check and BOTH dirty checks immediately before the actual
  // mutating call, rather than trusting the checks done before the network
  // round trip.
  // ---------------------------------------------------------------------
  const recheckHead = gitRun(['rev-parse', 'HEAD']);
  if (recheckHead.status !== 0 || recheckHead.stdout.trim() !== resolvedSha) {
    fail(
      `commit-reviewed: --target-sha TOCTOU GUARD — HEAD changed since the initial checks (now ` +
        `${recheckHead.status === 0 ? recheckHead.stdout.trim() : 'unreadable'}, expected ${resolvedSha}); the publication-guard round trip is a long ` +
        `window and something moved the tip. Refusing to amend a moving target. Nothing amended, nothing consumed.`
    );
  }
  const recheckIndex = gitRun(['diff', '--cached', '--quiet']);
  if (recheckIndex.error) fail(`commit-reviewed: git diff --cached --quiet (re-check) failed: ${recheckIndex.error.message}`);
  if (recheckIndex.status !== 0 && recheckIndex.status !== 1) {
    fail(`commit-reviewed: git diff --cached --quiet (re-check) exited unexpectedly (${recheckIndex.status}): ${(recheckIndex.stderr || '').trim()}`);
  }
  const recheckWorktree = gitRun(['diff', '--quiet']);
  if (recheckWorktree.error) fail(`commit-reviewed: git diff --quiet (re-check) failed: ${recheckWorktree.error.message}`);
  if (recheckWorktree.status !== 0 && recheckWorktree.status !== 1) {
    fail(`commit-reviewed: git diff --quiet (re-check) exited unexpectedly (${recheckWorktree.status}): ${(recheckWorktree.stderr || '').trim()}`);
  }
  if (recheckIndex.status === 1 || recheckWorktree.status === 1) {
    fail(
      `commit-reviewed: --target-sha TOCTOU GUARD — the ${recheckIndex.status === 1 ? 'index' : 'worktree'} became dirty since the initial checks ` +
        `(the publication-guard round trip is a long window); refusing to amend. Nothing amended, nothing consumed.`
    );
  }

  const amend = gitRun(['commit', '--amend', '--cleanup=verbatim', '-F', '-'], fullMessage);
  if (amend.error) fail(`commit-reviewed: git commit --amend failed: ${amend.error.message}`);
  if (amend.status !== 0) fail(`commit-reviewed: git commit --amend failed: ${(amend.stderr || amend.stdout || '').trim()}`);

  const newShaResult = gitRun(['rev-parse', 'HEAD']);
  if (newShaResult.status !== 0 || !(newShaResult.stdout ?? '').trim()) {
    fail(
      `commit-reviewed: AMEND SUCCEEDED but the new sha could not be determined (git rev-parse HEAD failed: ${(newShaResult.stderr || '').trim()}) — ` +
        `the review-ledger entries were NOT consumed; inspect the repository directly.`
    );
  }
  const newSha = newShaResult.stdout.trim();

  // (3) TOCTOU, post-amend half: the amend must change ONLY the message —
  // same tree, same parent. `^` on a root commit fails (no parent); both
  // sides degrade to null identically in that case, so a root commit still
  // compares equal to itself. This check runs AFTER the mutating amend, so a
  // failure here reports the new sha and instructs manual inspection rather
  // than silently proceeding — the amend already happened and cannot be
  // undone by this CLI.
  // No leading `--` here either — same measured reason as the G1 resolve
  // call above (it turns rev-parse's echo-back/path mode on instead of
  // resolving); both shas are already canonical 40-hex from our own earlier
  // rev-parse output, so there is no injection surface to close with it.
  const treeOf = (sha) => {
    const r = gitRun(['rev-parse', `${sha}^{tree}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const parentOf = (sha) => {
    const r = gitRun(['rev-parse', `${sha}^`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const oldTree = treeOf(resolvedSha);
  const newTree = treeOf(newSha);
  const oldParent = parentOf(resolvedSha);
  const newParent = parentOf(newSha);
  if (oldTree === null || newTree !== oldTree || newParent !== oldParent) {
    console.error(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but a post-amend invariant check FAILED — tree: expected ${oldTree}, ` +
        `got ${newTree}; parent: expected ${safeLabel(oldParent)}, got ${safeLabel(newParent)}. The amend already happened and cannot be undone by this ` +
        `CLI — inspect the repository directly ('git show ${newSha}') before trusting this commit. The review-ledger entries were NOT consumed.`
    );
    process.exit(1);
  }

  // TRAILER SURVIVAL CHECK — same exact format string direct-merge.mjs's
  // receipt-gate read uses, same posture as the -m flow's own check: never
  // consume before this passes. Compared against the UNION of pre-existing
  // trailer values (read before the amend, above) and the newly stamped
  // ones — never the new set alone (see the G5 header note).
  const trailerCheck = gitRun(['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', newSha]);
  if (trailerCheck.error) {
    fail(`commit-reviewed: AMEND SUCCEEDED (${newSha}) but the post-amend trailer verification could not run: ${trailerCheck.error.message}`);
  }
  if (trailerCheck.status !== 0) {
    fail(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but the post-amend trailer verification failed unexpectedly ` +
        `(git log exited ${trailerCheck.status}): ${(trailerCheck.stderr || trailerCheck.stdout || '').trim()} — the review-ledger entries were NOT consumed.`
    );
  }
  const expectedTrailerValues = [...existingTrailerValues, ...stampEntries.map((e) => e.agent_type)].sort();
  const actualTrailerValues = (trailerCheck.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .sort();
  const trailerMatches =
    actualTrailerValues.length === expectedTrailerValues.length && actualTrailerValues.every((v, i) => v === expectedTrailerValues[i]);
  if (!trailerMatches) {
    console.error(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but the 'Reviewed-By-Agent' trailer is NOT readable — or does not match ` +
        `the UNION of pre-existing plus newly stamped values — via the exact format string scripts/direct-merge.mjs's receipt-gate read uses; this ` +
        `commit exists but is UNMERGEABLE until fixed.\nExpected: [${expectedTrailerValues.join(', ')}]\nActual:   [${actualTrailerValues.join(', ')}]\n` +
        `The review-ledger entries were NOT consumed — they remain available for a retry.`
    );
    process.exit(1);
  }

  // WAIVER TRAILER SURVIVAL CHECK — identical posture and identical union
  // style (decision 57984926 §2). Runs unconditionally: expected [] vs actual
  // [] also proves no waiver trailer was invented where nothing was waived.
  const waiverCheck = gitRun(['log', '-1', '--format=%(trailers:key=Review-Bytes-Waiver,valueonly,unfold)', newSha]);
  if (waiverCheck.error || waiverCheck.status !== 0) {
    fail(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but the post-amend Review-Bytes-Waiver verification could not run ` +
        `(${waiverCheck.error ? waiverCheck.error.message : `git log exited ${waiverCheck.status}: ${(waiverCheck.stderr || '').trim()}`}) — ` +
        `the review-ledger entries were NOT consumed.`
    );
  }
  const expectedWaiverValues = [...existingWaiverValues, ...waivedReceipts].sort();
  const actualWaiverValues = (waiverCheck.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .sort();
  if (
    actualWaiverValues.length !== expectedWaiverValues.length ||
    !actualWaiverValues.every((v, i) => v === expectedWaiverValues[i])
  ) {
    console.error(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but the 'Review-Bytes-Waiver' trailer set does not match the UNION of ` +
        `pre-existing plus newly stamped values.\nExpected: [${expectedWaiverValues.join(', ')}]\nActual:   [${actualWaiverValues.join(', ')}]\n` +
        `A byte waiver whose trailer did not survive is an unaudited override. The review-ledger entries were NOT consumed.`
    );
    process.exit(1);
  }

  // CONSUME the stamped entries (P4) — lock-guarded, identity by value (never
  // a serialized key — see the -m flow's identical reasoning above), RE-READ
  // rather than reuse `ledger` so an entry promoted mid-amend survives.
  try {
    consumeStampedEntries(ledgerFilePath, sterlingDir, stampEntries);
  } catch (e) {
    console.error(
      `commit-reviewed: AMEND SUCCEEDED (original ${resolvedSha}, new ${newSha}) but the review ledger was NOT consumed ` +
        `(${safeLabel(e && e.message ? e.message : e)}) — ${ledgerFilePath} still carries the entries just stamped; remove them by hand.`
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      amended: true,
      original_sha: resolvedSha,
      new_sha: newSha,
      reviewed_by: stampEntries.map((e) => e.agent_type),
      deferred_receipts: deferredDisclosures,
      waived_bytes:
        waivedReceipts.length > 0
          ? { reason: waiveBytesReason, receipts: waivedReceipts, files: byteFindings.map((f) => ({ agent_type: f.entry.agent_type, files: f.files })) }
          : null,
      // See the -m flow's report: null on every run that did not ask for an
      // unnecessary waiver, never omitted.
      waiver_unused: waiverUnusedNote,
    })
  );
}

// ===========================================================================
// REVIEWED-BYTES ENFORCEMENT — the shared verdict (decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design §2;
// executes the REFUSE-LATER half of user ruling b0ad640d, 2026-08-31).
//
// EVERYTHING HERE IS HOISTED `function` DECLARATIONS, for the same reason
// safeLabel/ageLabel/withLedgerLock are: BOTH flows use them, and the
// --target-sha flow runs before the -m flow's `const`s leave their temporal
// dead zone. The two flows differ ONLY in what "the bytes about to be
// committed" means — the INDEX for -m, the TARGET COMMIT'S TREE for an amend —
// which is why the tree read is a caller-supplied callback rather than a
// branch inside the verdict. Identical enforcement in both modes is §2's
// explicit requirement, and an `if (!targetSha)` guard around the check would
// be invisible to every new-commit test.
// ===========================================================================

/** A USABLE recorded blob value: exactly 40 hex characters, the shape `git
 *  hash-object` produces. Anything else is present-but-unusable evidence,
 *  which §2 treats as INCONSISTENT rather than absent.
 *  A hoisted `function`, NOT a module const, and that is load-bearing rather
 *  than stylistic: the -m flow runs at module top level, ABOVE this section, so
 *  a `const` regex here sits in its temporal dead zone when the verdict runs
 *  and every call throws 'Cannot access before initialization'. Because the
 *  enforcement is deliberately fail-open on a throw, that TDZ error surfaced
 *  not as a crash but as a CLEAN COMMIT with a REVIEWED-BYTES CHECK
 *  UNAVAILABLE note — i.e. the gate silently disabling itself (measured while
 *  building this slice). Same reason every other helper here is hoisted. */
function isUsableBlobSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
}

/** The one path spelling used on BOTH sides of every comparison here (mirrors
 *  the per-flow `normalizePath` consts — same rule, hoisted so the shared
 *  verdict can apply it too): backslashes to '/', a stripped leading './'. */
function normalizeRepoPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The receipt's recorded blob evidence: `{map, collisions}`, keyed by
 *  normalized path, values RAW AND UNFILTERED. That last part is load-bearing
 *  and is the difference between this and the advisory block's `recordedBlobs`:
 *  a present-but-unusable value ('not-a-sha', '', a number) must stay
 *  DISTINGUISHABLE from an absent one, because §2 refuses INCONSISTENT evidence
 *  while grandfathering ABSENT evidence. Filtering at read time — which the
 *  advisory could afford, since every outcome there was a warning — collapses
 *  those two into one and hands the trivial bypass (write junk instead of a sha)
 *  the grandfather clause.
 *
 *  ALIAS COLLISION IS AN EVIDENCE DEFECT, NOT A SPELLING PREFERENCE (Codex
 *  review MED, fix round 2026-08-31). Two recorded keys can normalize to ONE
 *  path ('src/a.mjs' and '.\\src\\a.mjs'). Recording the SAME sha under both is
 *  harmless — one path, one answer, so the map keeps it and nothing is flagged.
 *  Recording DIFFERENT shas means the receipt contradicts ITSELF about what it
 *  reviewed, and the previous first-spelling-wins rule silently picked one of
 *  the two: appending a MATCHING alias beside a MISMATCHING real key was
 *  therefore a one-line way to make the mismatch never be compared. Such a path
 *  is returned in `collisions`, and the verdict refuses on it as INCONSISTENT
 *  evidence rather than choosing a winner. */
function receiptBlobEvidence(e) {
  const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
  const b = rs && typeof rs.blobs === 'object' && rs.blobs !== null && !Array.isArray(rs.blobs) ? rs.blobs : null;
  const map = new Map();
  const collisions = new Set();
  if (!b) return { map, collisions };
  for (const [p, sha] of Object.entries(b)) {
    if (typeof p !== 'string' || p === '') continue;
    const n = normalizeRepoPath(p);
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
function receiptBlobMap(e) {
  return receiptBlobEvidence(e).map;
}

/** The territory the receipt DECLARES, normalized. Used together with the blob
 *  keys to decide COVERAGE — iterating the blob map alone would silently skip
 *  a declared-but-unbound path, which is precisely the partial-coverage hole
 *  §2 clause 2 exists to close. */
function receiptDeclaredPaths(e) {
  return Array.isArray(e && e.files) ? e.files.filter((f) => typeof f === 'string' && f !== '').map(normalizeRepoPath) : [];
}

/** The receipt ADMITS its content evidence does not cover everything it
 *  declares — v1's reviewed_state.truncated (strict true, never a truthy
 *  stray) or v2's content_evidence.status 'partial', surfaced by the adapter
 *  as content_evidence_status. Both spellings are checked because reading only
 *  the v1 one would leave every v2 partial receipt unenforced. */
function receiptAdmitsPartial(e) {
  const rs = e && typeof e.reviewed_state === 'object' && e.reviewed_state !== null ? e.reviewed_state : null;
  if (rs && rs.truncated === true) return true;
  return !!(e && e.content_evidence_status === 'partial');
}

/** GRANDFATHERING IS NARROW AND POSITIVE (§2: "grandfather only genuinely
 *  absent evidence — schema absence does not imply blob absence"):
 *    'absent'       — a v1/legacy receipt with NO reviewed_state KEY at all,
 *                     i.e. every receipt promoted before reviewed-bytes
 *                     recording shipped. Never audited, never refused: refusing
 *                     here would brick every live ledger the day this lands,
 *                     which is the over-broad flip clause 3 forbids.
 *    'inconsistent' — a v1/legacy receipt whose reviewed_state KEY IS PRESENT
 *                     but is not an object (null, an array, a string, a
 *                     number). Codex review HIGH, fix round 2026-08-31: the
 *                     previous code folded this into 'absent', because its one
 *                     object-guard answered "is there a usable object?" rather
 *                     than "did the receipt record anything?". That handed the
 *                     grandfather clause to the SHORTEST possible tamper —
 *                     overwrite reviewed_state with `null` and the entire check
 *                     evaporates, which is the same bypass clause 2 closes for
 *                     a junk BLOB VALUE one level down. A key that is present
 *                     and unreadable is INCONSISTENT evidence, and the verdict
 *                     refuses on any staged path the receipt covers, disclosing
 *                     the shape it actually found.
 *    'unavailable'  — a v2 receipt whose content_evidence.status says the
 *                     hashing never ran. Grandfathered (commits) but DISCLOSED
 *                     (conductor adjudication 2026-08-31 on the frozen suite's
 *                     C3): silence here would be indistinguishable from a clean
 *                     audit. THE GRANDFATHER IS CONDITIONAL ON THE BLOB MAP
 *                     BEING EMPTY OF USABLE SHAS — see the verdict: a receipt
 *                     that says the hashing never ran while carrying hashes
 *                     contradicts itself, and the verdict ENFORCES its recorded
 *                     blobs rather than believing the status field.
 *    'present'      — anything else. ENFORCED. */
function receiptEvidenceClass(e) {
  const status = e && typeof e.content_evidence_status === 'string' ? e.content_evidence_status : undefined;
  if (status === 'unavailable') return 'unavailable';
  if (status !== undefined) return 'present';
  // v1/legacy from here down: the adapter never sets content_evidence_status
  // for a v1 entry, so `status === undefined` IS the v1 branch.
  const hasKey = !!e && typeof e === 'object' && e.reviewed_state !== undefined;
  if (!hasKey) return 'absent'; // genuinely absent — the only v1 grandfather
  // An ARRAY is excluded deliberately: `typeof [] === 'object' && [] !== null`
  // is true, so the obvious object-guard admits `reviewed_state: []` as a real
  // (empty) evidence record — the exact shape a tamper reaches for after `null`
  // is refused. A v2-derived entry always arrives as a plain object here, so
  // this narrowing costs nothing on that path.
  const usableObject = typeof e.reviewed_state === 'object' && e.reviewed_state !== null && !Array.isArray(e.reviewed_state);
  return usableObject ? 'present' : 'inconsistent';
}

/** The human-readable SHAPE of a present-but-unreadable reviewed_state, for the
 *  'inconsistent' disclosure. Names the shape AND shows the value (bounded),
 *  because "not an object" alone does not tell a reader whether they are
 *  looking at a tamper, a producer bug, or a hand-edited fixture. */
function evidenceShapeLabel(v) {
  const kind = v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`;
  const shown = safeLabel(v);
  return `${kind} (${shown.length > 120 ? `${shown.slice(0, 120)}…` : shown})`;
}

/** THE VERDICT. Never throws in any path it controls — the caller's degraded
 *  contract depends on that, and an accidental throw in here would otherwise
 *  decide the outcome by accident. The one thing it does NOT control is the
 *  caller-supplied `readBlobs` callback, which spawns git: that is exactly why
 *  `progress` exists (see below).
 *
 *  @param entries      the STAMPED CANDIDATES only. Never the eligible set: a
 *                      foreign or file-scope DEFERRED receipt is not being
 *                      spent here, so its bytes are not this commit's business
 *                      (frozen pin D2), and a receipt covering nothing this
 *                      commit touches produces no finding at all (pin D1 — the
 *                      no-reliable-intersection fallback stays the existing
 *                      attribution WARNING, never relabelled a byte mismatch).
 *  @param touchedPaths the normalized paths this commit actually changes.
 *  @param readBlobs    (paths) => {ok:true, map} | {ok:false, detail} — the
 *                      blob sha of each path in the content being committed.
 *  @param progress     OUT-PARAM, and it is the fail-CLOSED half of this
 *                      mechanism (Codex review HIGH, fix round 2026-08-31).
 *                      Findings and the auditable-evidence set are written into
 *                      it AS THEY ARE ESTABLISHED, so a throw anywhere after
 *                      the fact — including inside readBlobs — leaves the
 *                      caller holding everything already proven rather than an
 *                      empty array it would read as "nothing to refuse". Its
 *                      `checked` map is the pre-commit INDEX/TREE reading the
 *                      caller re-verifies against the CREATED COMMIT'S TREE.
 *  @returns {{findings, unavailable, contradictory, unreadable, checked}}
 */
function reviewedBytesVerdict(entries, touchedPaths, readBlobs, progress) {
  const p = progress && typeof progress === 'object' ? progress : {};
  if (!Array.isArray(p.findings)) p.findings = [];
  if (!Array.isArray(p.evidence_entries)) p.evidence_entries = [];
  if (!(p.checked instanceof Map)) p.checked = new Map();
  const findings = p.findings;

  const candidates = [];
  const unavailable = [];
  const contradictory = [];
  const needed = new Set();
  for (const e of entries) {
    const cls = receiptEvidenceClass(e);
    if (cls === 'absent') continue;
    const { map: blobs, collisions } = receiptBlobEvidence(e);
    // COVERAGE = declared territory UNION recorded blob keys, intersected with
    // what this commit touches. Iterating only the blob map is the single most
    // likely shortcut and it silently skips exactly the unbound staged path
    // clause 2 refuses on.
    const covered = [...new Set([...receiptDeclaredPaths(e), ...blobs.keys()])].filter((x) => touchedPaths.has(x)).sort();
    if (covered.length === 0) continue;
    if (cls === 'unavailable') {
      // CONTRADICTORY GRANDFATHER (Codex review HIGH, fix round 2026-08-31).
      // 'unavailable' means "the hashing never ran", and that is grandfathered
      // ONLY while the receipt agrees with itself. A receipt that says the
      // hashing never ran while CARRYING usable hashes made the status field a
      // one-word disable switch for the whole check — write 'unavailable' and
      // every recorded sha stops being compared. The recorded blobs are the
      // evidence; the status is a claim about them, so the evidence wins and
      // this entry is ENFORCED like any other (the contradiction is disclosed
      // separately by the caller, since it is also a producer bug worth seeing).
      if (![...blobs.values()].some(isUsableBlobSha)) {
        unavailable.push(e);
        continue;
      }
      contradictory.push(e);
    }
    for (const x of covered) {
      if (!collisions.has(x) && isUsableBlobSha(blobs.get(x))) needed.add(x);
    }
    candidates.push({ e, blobs, collisions, covered, cls });
    p.evidence_entries.push(e);
  }

  let treeBlobs = new Map();
  let unreadable = null;
  if (needed.size > 0) {
    const r = readBlobs([...needed]);
    if (r.ok) {
      treeBlobs = r.map;
      // Remember exactly what was read, so the caller can prove the bytes it
      // verified are the bytes that landed (the index-TOCTOU re-check).
      for (const x of needed) {
        const sha = treeBlobs.get(x);
        if (typeof sha === 'string') p.checked.set(x, sha.toLowerCase());
      }
    } else {
      treeBlobs = null; // the comparison cannot be made — see the FAIL-CLOSED note below
      unreadable = r.detail;
    }
  }

  for (const { e, blobs, collisions, covered, cls } of candidates) {
    const files = [];
    for (const x of covered) {
      const bound = blobs.has(x);
      const raw = blobs.get(x);
      if (collisions.has(x)) {
        // Two recorded keys normalize to this one path with DIFFERENT shas —
        // the receipt contradicts itself, so there is no "the sha it recorded"
        // to compare (see receiptBlobEvidence).
        files.push(
          `${x} (INCONSISTENT EVIDENCE — two recorded blob keys normalize to this path but record DIFFERENT shas, so the receipt contradicts itself about what it reviewed)`
        );
      } else if (bound && isUsableBlobSha(raw)) {
        if (treeBlobs === null) {
          // FAIL-CLOSED ON AN UNREADABLE COMPARISON (Codex review HIGH, fix
          // round 2026-08-31). This used to `continue`, degrading to the
          // caller's REVIEWED-BYTES CHECK UNAVAILABLE warning and committing.
          // The reasoning was "an absence of verdict is not a mismatch" — true,
          // but it is not a MATCH either, and here the receipt DID record
          // comparable bytes for a path this commit touches, so the only thing
          // missing is our own read. Committing then stamps an attestation
          // nobody verified, and one broken `git ls-files` call disables the
          // gate silently. It refuses instead — and --waive-bytes is the
          // sanctioned route through, so a genuinely broken git never bricks
          // the CLI.
          files.push(
            `${x} (EVIDENCE UNCHECKABLE — the receipt recorded ${raw.slice(0, 12)}, but the bytes being committed could not be read: ${unreadable})`
          );
          continue;
        }
        const actual = treeBlobs.get(x);
        if (actual === undefined) {
          // A staged DELETION has no index entry at all, so an absent sha is
          // the strongest possible form of "not the bytes that were reviewed".
          files.push(`${x} (reviewed ${raw.slice(0, 12)}, now DELETED/absent from the content being committed)`);
        } else if (actual.toLowerCase() !== raw.toLowerCase()) {
          files.push(`${x} (reviewed ${raw.slice(0, 12)}, committing ${actual.slice(0, 12)})`);
        }
      } else if (bound) {
        // INCONSISTENT, not absent (conductor adjudication 2026-08-31, frozen
        // pin C2): the receipt asserts it recorded this path's bytes and the
        // value it recorded is not bytes. Grandfathering that would make
        // "overwrite the sha with junk" the one-keystroke bypass of the entire
        // check, and the grandfather clause is for evidence that was never
        // written — not for evidence that was written and then broken.
        files.push(`${x} (INCONSISTENT EVIDENCE — the receipt records ${safeLabel(raw)} for this path, which is not a usable blob sha)`);
      } else if (cls === 'inconsistent') {
        // The reviewed_state KEY is present but unreadable (null/array/string).
        // Same family as the junk-sha case one level down, disclosed with the
        // shape actually found so a producer bug is distinguishable from a
        // tamper (see receiptEvidenceClass).
        files.push(
          `${x} (INCONSISTENT EVIDENCE — the receipt's reviewed_state is ${evidenceShapeLabel(e && e.reviewed_state)}, not a map of recorded blob shas, so nothing it claims about this path can be read)`
        );
      } else if (cls === 'unavailable' || receiptAdmitsPartial(e)) {
        // The receipt itself says its binding is incomplete, and the file this
        // commit stages is one of the ones it never bound. Evidence that does
        // not cover this commit is not evidence. GLOBALLY partial stays fine —
        // this fires only for a path THIS commit touches (frozen pin B0). A
        // CONTRADICTORY 'unavailable' receipt (blobs present, status says none)
        // is treated as partial for exactly the same reason.
        files.push(`${x} (NO RECORDED BYTES — this receipt admits partial/truncated content evidence and never bound this path)`);
      } else if (blobs.size > 0) {
        // THE BINDING IS THE GUARD, NOT THE TRUNCATION FLAG (frozen hardening
        // pins H2a/H2b). The two branches above key off what the receipt SAYS
        // about its own coverage — `truncated`, `status` — and both fields are
        // written by the same producer as the blob map, so deleting one key
        // from a 'complete' receipt left a staged path unaudited while every
        // self-declaration still read clean. A receipt that recorded evidence
        // for OTHER paths demonstrably HAS content evidence, so §2's
        // grandfather (which is per-RECEIPT — "schema absence does not imply
        // blob absence") cannot reach it: the missing binding is a hole in the
        // audit, not an absence of one.
        // THE `blobs.size > 0` CONDITION IS THE FENCE, and it is what keeps this
        // from swallowing the grandfather whole: a receipt whose map is EMPTY
        // recorded nothing at all, which is genuinely absent evidence and stays
        // an advisory (frozen pin completed_at (c)). Empty means absent; partial
        // means unaudited.
        files.push(
          `${x} (NO RECORDED BYTES — the receipt records content evidence for ${blobs.size} other path(s) but bound NOTHING for this one, while claiming complete coverage: a missing binding is an unaudited path, not absent evidence)`
        );
      }
    }
    if (files.length > 0) findings.push({ entry: e, files });
  }
  return { findings, unavailable, contradictory, unreadable, checked: p.checked };
}

/** A v1 receipt has no entry_id, so its waiver trailer carries a fingerprint
 *  of the RECEIPT'S OWN CONTENT (§2: "stable fingerprint for v1"). STABLE means
 *  deterministic given the receipt: two byte-identical receipts fingerprint
 *  identically (frozen pin E3 runs the same fixture twice and compares).
 *  Deliberately NOT derived from the commit sha, the clock, or randomUUID —
 *  a per-invocation value is a fingerprint of nothing and cannot say WHICH
 *  receipt was waived, which is the only thing the trailer is for.
 *  The inputs are the receipt's identity-bearing fields: agent_type, the
 *  dispatch instant, the DECLARED TERRITORY, and the recorded blob map (both
 *  sorted, so key order in the ledger file cannot change the answer). Guarded
 *  stringify for the same reason safeLabel exists — a ledger value is arbitrary
 *  JSON.
 *  `files` IS PART OF THE INPUT (roster review MED-1, fix round 2026-08-31):
 *  since file-scoped stamping, territory is one of the fields that distinguishes
 *  two otherwise-identical receipts (the measured shape: two dispatches in ONE
 *  message sharing agent_type AND the Start-millisecond, differing only in
 *  files[] — file-scoping S9). Omitting it made those two receipts waive under
 *  ONE trailer value, i.e. an audit trail that cannot say WHICH review was
 *  overridden — the single thing the trailer exists for.
 *  WIDTH: 32 hex characters (Codex review LOW) — 16 hex is 64 bits, and a
 *  waiver identifier is an audit key, not a cache key. 32 hex keeps
 *  `receipt-<fp>` at 40 characters, well inside waiverIdentity's 100-char
 *  trailer-value bound. */
function v1ReceiptFingerprint(e) {
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

/** The value stamped in `Review-Bytes-Waiver: <identity>` — v2's entry_id when
 *  it is present AND TRAILER-SAFE, else the v1 fingerprint.
 *  THE SHAPE CHECK IS NOT COSMETIC: the ledger is agent-writable, so an
 *  entry_id carrying \n would forge a trailer line inside the very block this
 *  CLI verifies — the same smuggling VALID_AGENT_TYPE closes for agent_type.
 *  An entry_id that fails it degrades to the content fingerprint rather than
 *  being dropped, so a waived receipt is always identified by something. */
function waiverIdentity(e) {
  const id = e && typeof e.entry_id === 'string' ? e.entry_id : '';
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(id)) return id;
  return `receipt-${v1ReceiptFingerprint(e)}`;
}

/** The ONE refusal message, shared by both flows (§2: "aggregated into ONE
 *  refusal listing every mismatched receipt+file"). Carries the 'REVIEWED
 *  BYTES' anchor, names every offending receipt (agent_type, plus entry_id
 *  where the entry has one) and every offending file, and names ONLY those —
 *  a receipt whose bytes still match is never listed. The caller prints it
 *  LAST and exits: a refusal followed by more output reads as one more
 *  advisory, which is how the previous ruling's warnings got ignored. */
function reviewedBytesRefusal(findings, whatIsBeingCommitted) {
  const lines = findings.map((f) => {
    const id = f.entry && typeof f.entry.entry_id === 'string' && f.entry.entry_id !== '' ? ` (entry ${f.entry.entry_id})` : '';
    return `  - ${f.entry.agent_type}${id}: ${f.files.join('; ')}`;
  });
  return (
    `commit-reviewed: REVIEWED BYTES CHANGED — REFUSING. ${findings.length} review receipt(s) would be stamped onto content that is NOT what they ` +
    `reviewed (${whatIsBeingCommitted}):\n${lines.join('\n')}\n` +
    `A trailer stamped here would attest a review of bytes nobody reviewed — the false attestation board 0f448efb measured, on the merge gate's own ` +
    `audit surface. The blob shas above were recorded at each reviewer's SubagentStop, so this is content evidence, not a timestamp heuristic. ` +
    `This was an ADVISORY until user ruling b0ad640d ("refuse later") was executed by decision 57984926 (slug review-ledger-v2-lifecycle-refuse-flip-and-` +
    `external-review-design) — the warn phase measured the advisories as accurate AND ignored, which is why they became a refusal. ` +
    `NOTHING was committed and NOTHING was consumed: every receipt is still in the ledger. ` +
    `Re-dispatch a reviewer for the current bytes, or — if a human has genuinely re-checked the changed lines — re-run with ` +
    `--waive-bytes "<single-line reason>", which commits and stamps one Review-Bytes-Waiver trailer per receipt named above.`
  );
}

/** A v2 entry's own identity as surfaced by the read adapter, or null for a v1
 *  entry (which never had one) and for any unusable value. THE CONSUME PATHS
 *  MATCH ON THIS FIRST (Codex review MED, fix round 2026-08-31): entry_id is
 *  minted per promotion, so it discriminates two receipts that the multi-field
 *  identity cannot — the measured collision is two dispatches in ONE message
 *  sharing agent_type, the Start-millisecond, session, branch and base_sha.
 *  Falling back to the multi-field key ONLY when NEITHER side has an entry_id
 *  keeps every v1 receipt behaving exactly as before, and makes the mixed case
 *  (one side has an id, the other does not) a NON-match — which fails toward
 *  SURVIVAL, the direction every identity decision on this path takes. */
function ledgerEntryId(e) {
  return e && typeof e.entry_id === 'string' && e.entry_id !== '' ? e.entry_id : null;
}

/** Lock-guarded read-modify-write consume, shared shape with the -m flow's
 *  inline consume block but self-contained (own ledgerFilePath/sterlingDir
 *  args) so --target-sha amend mode never depends on that flow's locals. */
function consumeStampedEntries(ledgerFilePath, sterlingDir, stampEntries) {
  const IDENTITY_DEPTH_CAP = 64;
  const boundedDeepEqual = (a, b, depth) => {
    if (a === b) return true;
    if (depth <= 0) return false;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!boundedDeepEqual(a[k], b[k], depth - 1)) return false;
    }
    return true;
  };
  const identityField = (e, k) => (e[k] === undefined ? null : e[k]);
  // entry_id FIRST (see the -m flow's identical helper for the full reasoning).
  const sameIdentity = (fresh, stamped) => {
    if (typeof fresh.agent_type !== 'string' || fresh.agent_type !== stamped.agent_type) return false;
    const sid = ledgerEntryId(stamped);
    const fid = ledgerEntryId(fresh);
    if (sid !== null || fid !== null) return sid !== null && fid !== null && sid === fid;
    return (
      boundedDeepEqual(fresh.at, stamped.at, IDENTITY_DEPTH_CAP) &&
      ['session_id', 'branch', 'base_sha', 'files'].every((k) =>
        boundedDeepEqual(identityField(fresh, k), identityField(stamped, k), IDENTITY_DEPTH_CAP)
      )
    );
  };

  withLedgerLock(sterlingDir, () => {
    let freshLedger = [];
    try {
      if (existsSync(ledgerFilePath)) {
        const raw = JSON.parse(readFileSync(ledgerFilePath, 'utf8'));
        if (Array.isArray(raw)) freshLedger = raw;
      }
    } catch {
      freshLedger = [];
    }
    const unclaimedStamped = [...stampEntries];
    const survivors = freshLedger.filter((e) => {
      if (!e || typeof e !== 'object') return true;
      // Normalized only for identity matching; the RAW re-read entry is what
      // survives, so a v2 entry's on-disk shape is never rewritten here.
      const i = unclaimedStamped.findIndex((s) => sameIdentity(normalizeLedgerEntry(e), s));
      if (i === -1) return true;
      unclaimedStamped.splice(i, 1);
      return false;
    });
    const tmpPath = join(sterlingDir, `review-ledger.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(survivors));
    renameSync(tmpPath, ledgerFilePath);
  });
}
