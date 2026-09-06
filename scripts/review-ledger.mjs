// scripts/review-ledger.mjs — CONDUCTOR-run CLI for the review ledger's
// explicit LIFECYCLE verbs (decision 57984926, slug review-ledger-v2-lifecycle-
// refuse-flip-and-external-review-design, §3 "FALLBACK NARROWING + DISCHARGE";
// campaign slice S2b-3).
//
//   node scripts/review-ledger.mjs discharge \
//     (--entry-id <uuid> | --legacy-handle receipt-<32 hex>) \
//     --digest   <sha256 hex of the EXACT current ledger bytes> \
//     --class    <foreign-session|foreign-branch|no-live-territory|unattributable|superseded> \
//     [--superseded-by <entry_id | 40-hex commit sha>]   # REQUIRED for --class superseded
//     --reason   "<single-line reason>"
//
//   node scripts/review-ledger.mjs digest      # prints the concurrency token
//
//   exit 0 = discharged (a one-line JSON report on stdout)
//   exit 1 = refused (the reason on stderr; NOTHING written, ever)
//
// TWO SELECTORS, ONE PER SCHEMA VERSION (§3 verbatim: "selector is entry_id (v2)
// or a generated legacy handle"; board 7dd3200a). A v1 entry has no entry_id, so
// before the handle existed a stranded LEGACY receipt could not be discharged at
// all — it sat in the ledger forever, re-reported by H1 at every SessionStart and
// re-disclosed by commit-reviewed at every commit, with the only escape being the
// hand deletion §3 forbids. THE HANDLE IS NOT A NEW IDENTITY: it is the SAME
// content fingerprint §2 already stamps as a v1 `Review-Bytes-Waiver` trailer
// value, computed by the one shared legacyReceiptHandle() so a conductor can
// carry the string from either surface to the other verbatim.
//
// EXACT FORM ONLY — NEVER A PREFIX, NEVER AN ABBREVIATION (anti-pattern
// no-bounded-trail-guard-for-destructive-addressing, severity BLOCK). Discharge
// OVERWRITES an agent-writable evidence record and there is no resurrection verb,
// so the forgiving-addressing forms that are safe on a read are forbidden here:
// `--legacy-handle` accepts `receipt-<32 lowercase hex>` character-for-character
// and refuses everything else BEFORE the ledger is opened. Two v1 entries whose
// content fingerprints collide are AMBIGUOUS: both are named and nothing is
// written, exactly as a duplicate entry_id is.
//
// THE HANDLE DOES NOT MIGRATE THE ENTRY. §3 rejected in-place v1→v2 migration
// ("a bulk rewrite of an agent-writable evidence file is an unreviewable write")
// while licensing precisely this: "explicit discharge may add lifecycle fields to
// a v1 entry as a requested transition". So a discharged v1 entry stays a v1
// entry — its original evidence untouched, with `status` and `disposition` added
// beside it. The shared adapter's dischargeMarkerClass authenticates that PAIR on
// a legacy entry exactly as it does on a v2 one, which is what makes the
// discharge actually take effect at H1 and commit-reviewed rather than being a
// verb that reports success and changes nothing. A BARE `status:'discharged'` on
// a v1 entry, with no contentful disposition, is still NOT a discharge and still
// spends normally — that pass-through promise is unchanged.
//
// WHAT DISCHARGE IS FOR. A review receipt whose life ended without being spent
// — the session that earned it is over, it belongs to another branch, or the
// territory it reviewed no longer exists — is UNSPENDABLE but still real
// reviewer evidence. Before this verb the only ways out were to leave it in the
// ledger forever (where H1 re-reports it at every SessionStart and
// commit-reviewed re-discloses it at every commit) or to delete it by hand
// (destroying the evidence with no record of who decided that or why). Neither
// is acceptable, so §3 adds ONE explicit act that PRESERVES the entry, flips
// `status` to 'discharged', and records an accountable `disposition`.
//
// EXPLICIT-ONLY, NEVER AUTOMATIC (§3, and its rejected alternative
// "auto-discharge conclusively-classified residue without a conductor act"):
// territory can still originate from unreliable extraction, so the accountable
// reason plus the preserved record IS the safeguard an agent-writable evidence
// file needs.
//
// NO RESURRECTION VERB, DELIBERATELY (§3: "a mistake is corrected by
// re-dispatching a reviewer"). A discharged state that can be round-tripped
// back to active is worthless as a record. There is no undischarge/restore/
// reactivate/resurrect subcommand, and an unknown verb halts loudly (P5).
//
// THE CONCURRENCY TOKEN IS A SHA-256 OF THE EXACT LEDGER BYTES (§3; mtime was
// explicitly rejected — timestamp granularity, preserved mtimes and same-tick
// rewrites make changed content look unchanged). It is verified INSIDE the
// lock, immediately before the replace, against the bytes actually on disk —
// never against a re-serialization of the parsed value, which could differ from
// those bytes and would make the token check pass over a real concurrent write.
// The realistic racer is an H22 SubagentStop promotion appending a receipt
// between the conductor reading the ledger and running this command.
//
// DEPENDENCY-LIGHT, HOOKS-STYLE (invariant 4's posture): node builtins plus the
// ONE shared read adapter, no workspace imports, no store access. It shares the
// lock and tmp-rename shapes with scripts/commit-reviewed.mjs and
// scripts/hooks/h22-dispatch-register.mjs — the same ~15 copied lines those two
// already carry between them, for the same reason. THIS copy additionally
// OWNS its lock (owner token + mtime refresh, see withLedgerLock): its critical
// section runs git subprocesses that can outlast the shared 10s stale window,
// which the other two never do. The 10s convention itself is unchanged, so a
// genuinely dead holder is still recoverable by all three.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// ONE compatibility adapter for both ledger shapes (decision 57984926, slice
// S2b-1). A v1 entry passes through byte-identical; a v2 entry's nested
// reviewer/identity/territory/content_evidence are surfaced under the flat
// names every other reader already uses. This CLI selects and WRITES against
// the RAW entry (so the on-disk shape is never rewritten by a read convention)
// and READS its fields through the adapter.
import {
  normalizeLedgerEntry,
  dischargeMarkerClass,
  legacyReceiptHandle,
  isLegacyEntry,
  LEGACY_HANDLE_PATTERN,
  // THE SUPERSEDED CLASS READS A SECOND RECEIPT'S CONTENT EVIDENCE, and it does
  // so through the SAME two helpers commit-reviewed's reviewed-bytes verdict
  // uses — one definition of "is this a usable recorded blob" and one of "which
  // paths did this receipt bind", for both schema versions. A second local copy
  // would be a second answer to a question the ledger already answers once.
  isUsableBlobSha,
  receiptBlobEvidence,
} from './hooks/lib/review-ledger-entry.mjs';

const target = process.cwd();
const argv = process.argv.slice(2);

// THE VERSION OF THE CLASSIFICATION RULES THAT PRODUCED A VERDICT (§3's
// disposition.classifier_version). Recorded on every discharge so a later
// reader knows which rules were in force — the no-live comparison in
// particular is expected to get sharper (worktree/index views, rename
// following), and a disposition written under rev 1 must not read as though it
// had been decided under rev 2.
const CLASSIFIER_VERSION = 1;

// §3's three recognized unspendable classes, kebab-cased, PLUS the two added by
// board 1d6d01bd. CLOSED SET: an unrecognized class is REFUSED (P5 — unknown
// signals halt), because a verb that accepts any class string is a
// delete-anything-I-do-not-want-to-see verb wearing a flag.
//
// THE TWO NEW CLASSES CLOSE A MEASURED DEAD END (board 1d6d01bd, 2026-09-05):
// eight roster receipts sat active in this repo's own ledger that could neither
// be SPENT nor DISCHARGED — six carrying territory.source 'unattributable' from
// same-type batch dispatches (which commit-reviewed will never stamp by
// construction), plus every stale-bytes receipt whose reviewer's work was later
// re-done by a fresh, alone-dispatched reviewer. None of them is foreign-session,
// foreign-branch or no-live-territory, so the honest operator had NO route and
// commit-reviewed re-printed their disclosures on every commit forever. The
// sanctioned dispositions until now were three HAND REMOVALS with the evidence
// preserved in a decision record (decisions df1b7c41, d7f9237e, ad259700) —
// i.e. exactly the "delete it by hand" §3 exists to abolish, performed three
// times because the verb had no class for the shape. These two classes are that
// precedent, mechanized: same judgement, but VERIFIED before it is recorded and
// PRESERVING the entry instead of destroying it (§3: discharge preserves
// evidence).
//
// EACH ONE VERIFIES ITS OWN FACT — neither is an assertion the CLI merely
// records. 'unattributable' is proved by the receipt's OWN territory.source
// (H22 wrote it there; a receipt that does not say so is contradicted).
// 'superseded' is proved against a NAMED survivor — a newer active receipt or a
// review-stamped commit that demonstrably covers this receipt's trustworthy
// territory — because "something else covered it" with nothing named is not a
// class, it is a wish.
const RECOGNIZED_CLASSES = ['foreign-session', 'foreign-branch', 'no-live-territory', 'unattributable', 'superseded'];

const REASON_MAX = 500; // same bound as commit-reviewed's --waive-bytes reason (decision 57984926 §2)

// How many legacy handles an unknown-handle refusal prints (board 7dd3200a).
// Bounded because a refusal is a message, not a report — but generous enough
// that a real ledger's whole legacy set fits, since this listing is the only
// place a derived handle is ever shown.
const HANDLE_LIST_CAP = 20;

// THE NOTE BOUND for `record-external` (§4: "--note sanitized and bounded").
// Wider than REASON_MAX because a consult note summarizes a whole review round
// rather than justifying one flag, but still bounded: the ledger is a small
// hand-readable evidence file that H1, commit-reviewed and the merge gate all
// read and QUOTE, and one unbounded conductor paste makes it unreadable for
// every consumer at once. REFUSED over the bound, never truncated — half a
// recorded attestation is an attestation nobody made.
const NOTE_MAX = 4096;

// THE LOCK'S STATE, declared HERE rather than beside withLedgerLock below. The
// lock section (search LOCK_STALE_MS / heldLock further down) documents what
// these are for and why the window is what it is; they live above the verb
// dispatch only because `record-external` (§4) takes the lock from a dispatch
// placed above that section, and a `const`/`let` read from above its own
// declaration is a ReferenceError rather than a refusal.
const LOCK_STALE_MS = 10_000; // SHARED CONVENTION with commit-reviewed.mjs / h22 — do not diverge
/** The lock this process currently holds, or null. Module-level because gitRun
 *  (which refreshes the mtime) is called from the classifier, several frames
 *  below withLedgerLock, and threading a handle through every verifier would put
 *  the liveness guarantee at the mercy of whoever adds the next git call. */
let heldLock = null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** A refusal raised from INSIDE the ledger lock. It must be a throw, never a
 *  direct `fail()`: process.exit() does not run `finally` blocks, so exiting
 *  under the lock would leave the lock directory behind and make the NEXT
 *  invocation — including the corrected re-run this refusal is asking for —
 *  refuse for ten seconds with an unrelated "lock held" message. Thrown, it
 *  unwinds through withLedgerLock's finally (lock released) and is converted to
 *  the same stderr + exit 1 at the call site. P4: the mechanical event that ends
 *  the lock's life releases it, on every path. */
class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
    this.refusal = true;
  }
}
function refuse(message) {
  throw new Refusal(message);
}

/** argv lookup returning the NEXT entry — undefined when the flag is absent,
 *  and undefined when it is last (a flag with no value). PRESENCE is asked
 *  separately where an empty value must be distinguished from absence. */
function flag(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
function flagGiven(name) {
  return argv.includes(name);
}
/** EVERY value given for a REPEATABLE flag, in argv order (record-external's
 *  --file). A flag occurrence with no following value contributes `undefined`,
 *  which the caller rejects rather than silently dropping — a `--file` with
 *  nothing after it is a malformed invocation, not a shorter territory. */
function flagAll(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) out.push(argv[i + 1]);
  }
  return out;
}

const USAGE_DISCHARGE =
  "usage: node scripts/review-ledger.mjs discharge (--entry-id <uuid> | --legacy-handle receipt-<32 hex>) " +
  '--digest <sha256-hex-of-the-exact-current-ledger-bytes> ' +
  `--class <${RECOGNIZED_CLASSES.join('|')}> --reason "<single-line reason>" ` +
  '[--superseded-by <entry_id | 40-hex commit sha>  REQUIRED for --class superseded]';
const USAGE_RECORD_EXTERNAL =
  'usage: node scripts/review-ledger.mjs record-external --file <repo-relative path> [--file <path> …] --provider <id> [--model <id>] ' +
  '--thread-id <id> --round <n> [--note "<single-line note>"]';
const USAGE_DIGEST = 'usage: node scripts/review-ledger.mjs digest   (no flags — prints the sha256 of the exact current ledger bytes, and nothing else)';
// THE `superseded` ENTRY FORM IS NOT USABLE ON TODAY'S RECEIPTS, and the usage
// text says so rather than letting a conductor discover it from a refusal. The
// entry arm requires the superseder's `observed_reads` — the reads-only half of
// the observed-evidence upgrade — which NO ledger entry carries yet: H22 records
// only the merged `observed_files` (reads ∪ writes) today, and the split field
// arrives in a later slice. Until then the COMMIT form (--superseded-by <40-hex
// sha>) is the working half, and an entry-form attempt refuses by naming exactly
// this gap ([refusal: superseder-predates-observed-reads]) instead of silently
// falling back to observed_files — a writes-inclusive fallback would let a
// receipt be superseded by an agent that WROTE the files rather than REVIEWED
// them, which is the opposite of review evidence.
const USAGE_SUPERSEDED_CONSEQUENCE =
  "note: --class superseded's ENTRY form (--superseded-by <entry_id>) requires the named receipt to carry `observed_reads`, a field no ledger entry records " +
  'yet (H22 writes only the merged observed_files today; the split lands in a later slice). Until then use the COMMIT form: --superseded-by <40-hex sha> of a ' +
  'commit carrying a Reviewed-By-Agent trailer whose files cover this receipt.';
const USAGE = `${USAGE_DISCHARGE}\n${USAGE_RECORD_EXTERNAL}\n${USAGE_DIGEST}`;

// ===========================================================================
// VERBS. Three: 'discharge' (§3), 'record-external' (§4) and 'digest' (board
// 1d6d01bd). An unknown verb REFUSES rather than falling through to a default,
// and the message says so explicitly for the resurrection family — a conductor
// reaching for `restore` must learn that the absence is deliberate, not a
// missing feature.
// ===========================================================================
const KNOWN_VERBS = ['discharge', 'record-external', 'digest'];
const verb = argv[0];
if (verb === undefined || verb.startsWith('-')) {
  fail(`review-ledger: missing subcommand. ${USAGE}`);
}
if (!KNOWN_VERBS.includes(verb)) {
  fail(
    `review-ledger: unknown subcommand '${verb}' — the verbs are ${KNOWN_VERBS.map((v) => `'${v}'`).join(' and ')}. There is NO undischarge/restore/` +
      `reactivate/resurrect verb, and its absence is deliberate (decision 57984926 §3): a discharged receipt can never be returned to active, because a ` +
      `state that round-trips is worthless as a record. Correct a mistaken discharge by RE-DISPATCHING A REVIEWER for the work it covered. ${USAGE}`
  );
}

// Not a Sterling project root: refuse before anything else, same posture as
// commit-reviewed.mjs (no ledger, no meaningful contract to enforce).
if (!existsSync(join(target, '.sterling'))) {
  fail('review-ledger: not a Sterling project root — no .sterling/ directory under the current working directory. Nothing written.');
}

// ===========================================================================
// RECORD-EXTERNAL (§4) — dispatched HERE, ahead of the discharge-only argument
// validation below, and it NEVER RETURNS: recordExternal() ends in process.exit
// on every path (0 recorded, 0 duplicate no-op, 1 refused). The two verbs share
// nothing but the ledger, the lock and the tmp+rename write, so running one
// verb's required-argument checks over the other's invocation would refuse a
// well-formed command for a flag it does not take.
// ===========================================================================
if (verb === 'record-external') {
  recordExternal();
}

// ===========================================================================
// DIGEST (board 1d6d01bd) — dispatched HERE for the SAME reason record-external
// is, and it NEVER RETURNS: everything below this point is discharge's own
// argument validation, which would refuse a well-formed `digest` invocation for
// a selector, class, reason and digest it does not take.
//
// WHAT IT IS FOR. `discharge` requires --digest, the sha256 of the EXACT ledger
// bytes, as its concurrency token (§3; mtime was rejected). Every route to that
// number ran outside this CLI — `shasum -a 256 .sterling/review-ledger.json` in
// a shell, which is precisely the `.sterling/` path H15's store guard seals off
// from the shell. So the sanctioned command's REQUIRED argument was obtainable
// only through a denied route: the same unreachable-remedy shape decision
// 1434cd54 Ruling 2 records, one flag deeper. This verb makes the token
// obtainable from the same sanctioned script that demands it.
//
// IT IS A CONCURRENCY TOKEN, NEVER AUTHORIZATION. Printing the digest grants
// nothing and proves nothing about whether any entry may be discharged: it says
// only "these are the bytes I read". Every class verification still runs, inside
// the lock, against the bytes on disk at that moment.
//
// ZERO FLAGS, AND EXACTLY ONE LINE OF STDOUT. A caller substitutes this straight
// into `--digest "$(…)"`, so any second line, banner or trailing note would be
// carried into the token. Flags are REFUSED rather than ignored (P5): a caller
// passing `digest --entry-id X` has misunderstood what this verb does, and
// silently printing the whole-ledger digest anyway would answer a question they
// did not ask.
// ===========================================================================
if (verb === 'digest') {
  digestVerb();
}

// ===========================================================================
// ARGUMENT VALIDATION — every defect is its own refusal with its own wording,
// so a caller can never be told the wrong thing about which argument was
// wrong. Nothing is read, locked or written until all four are well-formed.
// ===========================================================================
// TWO SELECTORS, EXACTLY ONE PER INVOCATION (§3; board 7dd3200a). --entry-id
// addresses a v2 entry; --legacy-handle addresses a v1 one. They are mutually
// exclusive rather than "one wins": a command naming BOTH has two possible
// targets, and silently preferring either would let a mistyped flag discharge an
// entry the conductor never looked at — on a verb that overwrites evidence with
// no resurrection path. PRESENCE, not truthiness, on both.
const entryIdGiven = flagGiven('--entry-id');
const legacyHandleGiven = flagGiven('--legacy-handle');

// A REPEATED SELECTOR FLAG REFUSES — IT NEVER FIRST-WINS (Codex review MED-2,
// thread 01a05c7b). `flag()` returns the FIRST occurrence's value and the checks
// below only ask whether the flag is PRESENT, so `--legacy-handle X
// --legacy-handle Y` silently acted on X while the caller was looking at Y. That
// is the SAME defect class the exact-form rule closes one level up: a forgiving
// reading of an ambiguous address on a call that overwrites evidence with no
// resurrection path. "Two values for one selector" is exactly "two possible
// targets", which the both-selectors rule below already refuses — so it gets the
// same answer, whatever the values are. Refused even when the repeats are
// IDENTICAL: a duplicated flag means the caller does not know what they typed,
// and the cost of asking them to re-run is a second of typing against the cost
// of discharging a receipt nobody chose.
for (const selector of ['--entry-id', '--legacy-handle']) {
  const occurrences = flagAll(selector);
  if (occurrences.length > 1) {
    fail(
      `review-ledger discharge: ${selector} is given ${occurrences.length} times (${occurrences.map((v) => JSON.stringify(v)).join(', ')}) — a selector ` +
        `repeated is a discharge with more than one possible target, and this verb NEVER silently takes the first. Discharge overwrites an agent-writable ` +
        `evidence record and there is no resurrection verb, so acting on either value would be a guess about which receipt the conductor meant. Re-run with ` +
        `exactly one ${selector}. Nothing written. ${USAGE_DISCHARGE}`
    );
  }
}

if (entryIdGiven && legacyHandleGiven) {
  fail(
    `review-ledger discharge: --entry-id and --legacy-handle are BOTH given — they are two different selectors addressing two different schema versions, ` +
      `and a discharge with two possible targets has no target. Re-run with exactly one. Nothing written. ${USAGE_DISCHARGE}`
  );
}
if (!entryIdGiven && !legacyHandleGiven) {
  fail(
    `review-ledger discharge: a SELECTOR is required — --entry-id <uuid> for a schema_version 2 entry, or --legacy-handle receipt-<32 hex> for a LEGACY v1 ` +
      `entry (decision 57984926 §3). A discharge with no entry selected has no target. ${USAGE_DISCHARGE}`
  );
}

const entryIdRaw = flag('--entry-id');
if (entryIdGiven && (typeof entryIdRaw !== 'string' || entryIdRaw.trim() === '')) {
  fail(`review-ledger discharge: --entry-id <uuid> was given with no value — the selector is what a discharge targets. Nothing written. ${USAGE_DISCHARGE}`);
}
const entryId = entryIdGiven ? entryIdRaw.trim() : null;

// THE LEGACY HANDLE IS ACCEPTED IN ITS FULL EXACT FORM AND NOTHING ELSE
// (anti-pattern no-bounded-trail-guard-for-destructive-addressing, severity
// BLOCK). Discharge overwrites an agent-writable evidence record and offers no
// resurrection, so no prefix, abbreviation, truncation, case fold or surrounding
// whitespace is resolved for the caller: a handle is 'receipt-' plus exactly 32
// lowercase hex characters, matched character-for-character against the value
// legacyReceiptHandle() computes. The refusal SAYS SO, because the constraint is
// counter-intuitive on a surface where 8-char prefixes resolve everywhere else in
// Sterling — and the reason for the difference (this call destroys, those calls
// do not) is what the reader needs to carry away.
const legacyHandleRaw = flag('--legacy-handle');
if (legacyHandleGiven && (typeof legacyHandleRaw !== 'string' || legacyHandleRaw.trim() === '')) {
  fail(`review-ledger discharge: --legacy-handle was given with no value — the selector is what a discharge targets. Nothing written. ${USAGE_DISCHARGE}`);
}
const legacyHandle = legacyHandleGiven ? legacyHandleRaw : null;
if (legacyHandle !== null && !LEGACY_HANDLE_PATTERN.test(legacyHandle)) {
  fail(
    `review-ledger discharge: --legacy-handle ${JSON.stringify(legacyHandle)} is not a legacy receipt handle. The one accepted form is 'receipt-' followed by ` +
      `exactly 32 LOWERCASE HEX characters, EXACTLY as printed — this selector is NEVER prefix-resolved, abbreviated, case-folded or trimmed, because ` +
      `discharge overwrites an agent-writable evidence record and has no resurrection verb, so a forgiving addressing form could silently retarget a ` +
      `bystander receipt (anti-pattern no-bounded-trail-guard-for-destructive-addressing). The same string is what commit-reviewed stamps as a v1 ` +
      `'Review-Bytes-Waiver' trailer value. Nothing written.`
  );
}

const classRaw = flag('--class');
if (!flagGiven('--class') || typeof classRaw !== 'string' || classRaw.trim() === '') {
  fail(`review-ledger discharge: --class is required and must be one of ${RECOGNIZED_CLASSES.join(', ')}. ${USAGE_DISCHARGE}`);
}
const dischargeClass = classRaw.trim();
if (!RECOGNIZED_CLASSES.includes(dischargeClass)) {
  fail(
    `review-ledger discharge: UNRECOGNIZED class ${JSON.stringify(dischargeClass)} — the recognized unspendable classes are ${RECOGNIZED_CLASSES.join(', ')} ` +
      `(decision 57984926 §3). An arbitrary class string is refused, never recorded: a discharge is only legitimate for a receipt that CANNOT be spent, and ` +
      `accepting any class at all would turn this verb into "delete anything I do not want to see". Nothing written.`
  );
}

// NO-LIVE-TERRITORY IS A v2-ONLY CLASS, AND THE SELECTOR ALREADY SETTLES IT
// (§3: the classification "applies ONLY when ALL hold: v2 roster receipt,
// structured non-empty territory, usable base_sha …"). Checked HERE, against the
// selector, rather than left to verifyNoLiveTerritory's structured-territory
// test: decision 8f137474's FLAT `files_source` predates v2, so a legacy entry
// CAN carry files_source:'review-territory' and would otherwise slip past that
// test into a conclusive-sounding verdict on a receipt §3 excludes by schema
// version. The two foreign-* classes stay available to a legacy entry — a v1
// receipt records session_id and branch flat, which is exactly the pair those
// classes compare, and the stranded-v1 case this handle exists for is a foreign
// session.
if (legacyHandle !== null && dischargeClass === 'no-live-territory') {
  fail(
    `review-ledger discharge: --class 'no-live-territory' cannot be established for a LEGACY v1 entry. Decision 57984926 §3 makes a v2 roster receipt the ` +
      `FIRST precondition of that classification, alongside structured non-empty territory and a usable base_sha — a v1 receipt's territory attribution is ` +
      `the free-prose extraction measured unreliable by research finding 289cd172, so "none of these paths is live" computed over it would be a ` +
      `conclusive-sounding verdict about the wrong files. Any ambiguity yields UNKNOWN, never no-live. Discharge it as 'foreign-session' or ` +
      `'foreign-branch' if either holds, or judge it another way. Nothing written.`
  );
}

// --superseded-by: THE SURVIVOR THIS RECEIPT IS BEING RETIRED IN FAVOUR OF
// (board 1d6d01bd). REQUIRED for --class superseded and REFUSED for every other
// class — the two directions are separate defects and get separate refusals.
//
// WHY IT IS MANDATORY. "Superseded" is the only recognized class that is not a
// fact about the receipt itself: foreign-session/foreign-branch compare two
// identities the entry already carries, 'unattributable' reads the entry's own
// territory.source, and no-live-territory measures the working tree. Supersession
// is a claim about a DIFFERENT artifact, so with nothing named there is nothing
// to verify and the class would degrade into "I believe someone re-reviewed this"
// — an unverifiable assertion on a verb that makes reviewer evidence invisible.
// Naming the survivor is what turns it back into a checkable fact, and it is
// recorded in the disposition so a later reader can re-check it.
//
// A REPEATED FLAG REFUSES, NEVER FIRST-WINS — same reasoning as the selectors
// above (Codex review MED-2): two values for one piece of evidence means the
// caller does not know which survivor they named, and this evidence decides
// whether real review evidence is retired.
const supersededByGiven = flagGiven('--superseded-by');
{
  const occurrences = flagAll('--superseded-by');
  if (occurrences.length > 1) {
    fail(
      `review-ledger discharge: --superseded-by is given ${occurrences.length} times (${occurrences.map((v) => JSON.stringify(v)).join(', ')}) — the survivor ` +
        `is the EVIDENCE this class is verified against, and two values is two different claims about what covered this receipt. This verb never silently takes ` +
        `the first. Re-run with exactly one. Nothing written. ${USAGE_DISCHARGE}`
    );
  }
}
if (supersededByGiven && dischargeClass !== 'superseded') {
  fail(
    `review-ledger discharge: --superseded-by was given with --class ${JSON.stringify(dischargeClass)}, which does not take it — only 'superseded' is verified ` +
      `against a named survivor. It is REFUSED rather than ignored: an argument silently dropped reads to the caller as an argument that was honoured, and the ` +
      `recorded disposition would then carry no trace of the survivor they meant to name. Nothing written. ${USAGE_DISCHARGE}`
  );
}
const supersededByRaw = flag('--superseded-by');
if (dischargeClass === 'superseded') {
  if (!supersededByGiven || typeof supersededByRaw !== 'string' || supersededByRaw.trim() === '') {
    fail(
      `review-ledger discharge: --class 'superseded' REQUIRES --superseded-by <entry_id | 40-hex commit sha> — supersession is a claim about a DIFFERENT ` +
        `artifact, so a discharge that names no survivor has nothing this verb can verify and would record an unverifiable assertion about real reviewer ` +
        `evidence. Name the receipt or the review-stamped commit that actually covered this territory. Nothing written. ${USAGE_DISCHARGE}\n${USAGE_SUPERSEDED_CONSEQUENCE}`
    );
  }
  if (/[\r\n]/.test(supersededByRaw)) {
    fail(
      `review-ledger discharge: --superseded-by must be a SINGLE LINE (${safeLabel(supersededByRaw)}) — refused, never flattened. Nothing written.`
    );
  }
}
const supersededBy = dischargeClass === 'superseded' ? supersededByRaw.trim() : null;

// A discharge with no reason is not an accountability record at all — it is the
// silent auto-discharge §3 explicitly rejected, wearing a flag. PRESENCE is
// checked separately from emptiness so `--reason ""` refuses for the right
// cause rather than reading as "no reason requested".
const reasonRaw = flag('--reason');
if (!flagGiven('--reason') || reasonRaw === undefined) {
  fail(
    `review-ledger discharge: --reason "<text>" is required — the reason IS the accountability this verb exists for (decision 57984926 §3 chose explicit ` +
      `discharge over silent auto-discharge precisely so a human decision is on the record). Nothing written. ${USAGE_DISCHARGE}`
  );
}
if (/[\r\n]/.test(reasonRaw)) {
  fail(
    `review-ledger discharge: --reason must be a SINGLE LINE — the reason given contains a newline (${JSON.stringify(reasonRaw)}). It is REFUSED, never ` +
      `silently stripped: a reason recorded differently from the one given records a decision nobody made. Nothing written.`
  );
}
const reason = reasonRaw.trim();
if (reason === '') {
  fail(
    `review-ledger discharge: --reason is EMPTY — that is a reason defect, not "no reason given". An accountability record with no reason is not an ` +
      `accountability record. Nothing written.`
  );
}
if (reason.length > REASON_MAX) {
  fail(
    `review-ledger discharge: --reason is ${reason.length} characters, over the ${REASON_MAX}-character bound. REFUSED, not truncated — half a recorded ` +
      `justification is a decision nobody made. Nothing written.`
  );
}

const digestRaw = flag('--digest');
if (!flagGiven('--digest') || typeof digestRaw !== 'string' || digestRaw.trim() === '') {
  fail(
    `review-ledger discharge: --digest <sha256-hex> is required — it is the CONCURRENCY TOKEN (decision 57984926 §3): the SHA-256 of the exact ledger bytes ` +
      `you read before deciding. Without it this verb would overwrite a receipt promoted since. Nothing written. ${USAGE_DISCHARGE}`
  );
}
const expectedDigest = digestRaw.trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
  fail(
    `review-ledger discharge: --digest ${JSON.stringify(digestRaw)} is not a SHA-256 hex digest (64 hex characters). It is the sha256 of the EXACT bytes of ` +
      `.sterling/review-ledger.json — e.g. \`shasum -a 256 .sterling/review-ledger.json\`. Nothing written.`
  );
}

// ===========================================================================
// GIT + IDENTITY HELPERS (all read-only, all fail toward "unknown" rather than
// toward a claim).
// ===========================================================================
/** EVERY git call this CLI makes, in ONE place — which is what makes the two
 *  cross-cutting properties below enforceable rather than remembered.
 *
 *  (1) LITERAL PATHSPECS (Codex review, HIGH). The declared paths in a receipt's
 *  territory are DATA, written by H22's extractor from a dispatch prompt, and
 *  git's default pathspec grammar reads several leading forms as MAGIC: `:!p`
 *  and `:(exclude)p` NEGATE a path, `:(glob)`/`:(icase)` change matching, and a
 *  bare `*`/`?`/`[` globs. A negating pathspec is the dangerous one here: it
 *  silently makes the untracked and diff checks look at NOTHING for that entry,
 *  every check comes back clean, and the classifier concludes "no live
 *  territory" over a path it never examined — a false conclusive verdict, in the
 *  one class that discharges on positive evidence. `--literal-pathspecs` (a
 *  GLOBAL option, so it must precede the subcommand) turns the whole grammar
 *  off; GIT_LITERAL_PATHSPECS=1 is the same switch by env, set here as defence
 *  in depth for any git that ignores one of the two spellings.
 *
 *  (2) LOCK LIVENESS (Codex review, HIGH). A git subprocess may take seconds —
 *  the timeout below allows thirty — and the ledger lock is stealable once its
 *  directory mtime is 10s old. Refreshing that mtime immediately before every
 *  git invocation is what keeps a LIVE holder from looking abandoned while it
 *  waits on the classifier. See withLedgerLock for the ownership half. */
function gitRun(args) {
  refreshLockMtime();
  return spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: target,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
}

/** Same normalization commit-reviewed.mjs applies at both ends of every
 *  identity comparison: empty-after-trim IS absence, everywhere, and a
 *  non-primitive carries no usable identity (String()-ing arbitrary ledger JSON
 *  can throw, and would manufacture a value that compares foreign against
 *  everything). */
function normIdentity(v) {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** THIS session's id: STERLING_SESSION_ID first (explicit override and the
 *  tests' fixture seam), then H1's SessionStart cell. null = unknown. */
function currentSessionId() {
  const override = normIdentity(process.env.STERLING_SESSION_ID);
  if (override !== null) return override;
  try {
    const cell = JSON.parse(readFileSync(join(target, '.sterling', 'transient', 'session.json'), 'utf8'));
    return normIdentity(cell && cell.session_id);
  } catch {
    return null;
  }
}

/** The branch checked out here — symbolic-ref, so a detached HEAD is unknown
 *  rather than the shared literal 'HEAD'. null = unknown. */
function currentBranch() {
  const r = gitRun(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.status === 0 ? normIdentity(r.stdout) : null;
}

function safeLabel(v) {
  if (v === undefined) return '<absent>';
  try {
    const j = JSON.stringify(v);
    return typeof j === 'string' ? j : '<unserializable>';
  } catch {
    return '<unserializable>';
  }
}

// A FUNCTION DECLARATION, not a const arrow: `record-external` (§4) runs from a
// dispatch placed above this line, and a const would be in its temporal dead
// zone there — a ReferenceError instead of a refusal, on the one surface whose
// whole contract is "every defect is a refusal, never a crash".
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

// ===========================================================================
// CLASS VERIFICATION.
//
// §3 verifies ONE class conclusively — no-live-territory — and the two foreign-*
// classes are facts about a session and a branch that the entry itself already
// carries. THEY NOW REQUIRE POSITIVE EVIDENCE OF FOREIGNNESS, not merely the
// absence of evidence against it (Codex review, HIGH — fix round 2026-08-31).
// Both identities must be KNOWN — the receipt's recorded value AND this side's
// current value — and UNEQUAL. Anything else refuses:
//
//   * recorded identity missing/empty/unreadable  -> UNKNOWN, not foreign
//   * this side's identity unknown (no session marker, detached HEAD)
//                                                 -> UNKNOWN, not foreign
//   * both known and EQUAL                        -> CONTRADICTED (spendable here)
//
// THE DIRECTION MATTERS AND IT IS THE OPPOSITE OF commit-reviewed's. There, an
// unjudgeable identity leaves a receipt ELIGIBLE, because the failure that costs
// nothing is declining to withhold a stamp. Here, an unjudgeable identity would
// let a discharge record 'foreign-session' about a receipt nobody could show was
// foreign — and a discharge makes real reviewer evidence invisible to every
// spending surface. So this side fails CLOSED: unknown is not foreign, and the
// remedy for a genuinely unknown identity is to make it knowable (run from the
// session/branch in question, or set STERLING_SESSION_ID) rather than to record
// a verdict the data does not support. Both refusals leave the receipt active.
//
// Every verifier returns {ok:true, facts} or {ok:false, message}; nothing is
// written unless the verdict is ok.
// ===========================================================================
function verifyForeignSession(norm) {
  const recorded = normIdentity(norm.session_id);
  const current = currentSessionId();
  if (recorded === null || current === null) {
    return {
      ok: false,
      refusal_class: 'session-identity-unknown',
      message:
        `review-ledger discharge: the class 'foreign-session' cannot be established — ` +
        (recorded === null
          ? `the entry records NO usable session_id (${safeLabel(norm.session_id)})`
          : `THIS side's session id is unknown (no usable .sterling/transient/session.json cell and no STERLING_SESSION_ID)`) +
        `, so there is no pair of identities to compare. UNKNOWN IS NOT FOREIGN: 'foreign-session' is a claim that the receipt belongs to a DIFFERENT ` +
        `session, and a discharge makes real reviewer evidence invisible to every spending surface — recording that claim on an absence would discharge ` +
        `evidence nobody could show was unspendable. Make the identity knowable (run this from the session in question, or set STERLING_SESSION_ID) or ` +
        `judge the receipt another way. The receipt stays ACTIVE; nothing written.`,
    };
  }
  if (recorded === current) {
    return {
      ok: false,
      refusal_class: 'session-identity-contradicted',
      message:
        `review-ledger discharge: the class 'foreign-session' is CONTRADICTED by the entry itself — its recorded session_id ${safeLabel(recorded)} is ` +
        `THIS session. A receipt earned in the session that is running now is not unspendable; it is spendable, here, by scripts/commit-reviewed.mjs. ` +
        `Nothing written.`,
    };
  }
  return { ok: true, facts: { recorded_session_id: recorded, current_session_id: current, verified: true } };
}

function verifyForeignBranch(norm) {
  const recorded = normIdentity(norm.branch);
  const current = currentBranch();
  if (recorded === null || current === null) {
    return {
      ok: false,
      refusal_class: 'branch-identity-unknown',
      message:
        `review-ledger discharge: the class 'foreign-branch' cannot be established — ` +
        (recorded === null
          ? `the entry records NO usable branch (${safeLabel(norm.branch)})`
          : `THIS side's branch is unknown (git symbolic-ref reports none — a detached HEAD, or not a branch checkout)`) +
        `, so there is no pair of identities to compare. UNKNOWN IS NOT FOREIGN: recording 'foreign-branch' on an absence would discharge real reviewer ` +
        `evidence on a claim the data does not support. Re-run from the branch in question, or judge the receipt another way. The receipt stays ACTIVE; ` +
        `nothing written.`,
    };
  }
  if (recorded === current) {
    return {
      ok: false,
      refusal_class: 'branch-identity-contradicted',
      message:
        `review-ledger discharge: the class 'foreign-branch' is CONTRADICTED by the entry itself — its recorded branch ${safeLabel(recorded)} is the branch ` +
        `checked out here. A receipt earned on this branch is not unspendable on it. Nothing written.`,
    };
  }
  return { ok: true, facts: { recorded_branch: recorded, current_branch: current, verified: true } };
}

/** NO-LIVE-TERRITORY (§3) — the ONE class that is VERIFIED before anything is
 *  written, and the one that can do real damage if it is wrong: discharging a
 *  receipt whose territory is still live destroys the requirement that the work
 *  be reviewed before it commits.
 *
 *  §3's preconditions, ALL required, each refusing on its own:
 *    (1) a v2 roster receipt (checked by the caller — a v1 entry has no
 *        territory.source at all and cannot be judged structured),
 *    (2) STRUCTURED, NON-EMPTY territory: free-prose paths are measured
 *        unreliable (finding 289cd172), so "no live territory" computed over
 *        them is a verdict about the wrong files,
 *    (3) a usable base_sha that RESOLVES in this repository — with nothing
 *        conclusive to compare against there is no classification to make.
 *
 *  THEN EVERY DECLARED PATH IS COMPARED, and every one must be at its base
 *  state. Deletions and untracked files are checked EXPLICITLY (§3) because
 *  neither is a content difference the naive comparison would see: a path
 *  removed from the index is absent rather than different, and an untracked
 *  file is invisible to a tree-vs-index diff entirely.
 *
 *  HEAD HAVING MOVED PAST base_sha IS IRRELEVANT — this compares CONTENT, not
 *  refs. A session legitimately commits other work while a receipt sits in the
 *  ledger, and a base_sha-vs-HEAD shortcut would call that "unknown" and refuse
 *  every real case. Equally, `git status --porcelain` being empty proves
 *  nothing: it says the worktree matches HEAD, not that it matches base.
 *
 *  ANY AMBIGUITY YIELDS 'unknown', NEVER no-live (§3): an unreadable path
 *  state or a git call that fails for any reason refuses, because "we could not
 *  check" is not "it was at base". */
function verifyNoLiveTerritory(norm) {
  if (norm.files_source !== 'review-territory') {
    return {
      ok: false,
      message:
        `review-ledger discharge: 'no-live-territory' requires STRUCTURED territory (territory.source 'review-territory'), but this entry records ` +
        `${safeLabel(norm.files_source)}. Free-prose territory is measured unreliable (research finding 289cd172: negated paths recorded, ` +
        `positively-asserted ones dropped, globs unregistered), so "none of these paths is live" would be a conclusive-sounding verdict about the wrong ` +
        `files. Any ambiguity yields UNKNOWN, never no-live (decision 57984926 §3). Nothing written.`,
    };
  }
  const files = Array.isArray(norm.files) ? norm.files.filter((f) => typeof f === 'string' && f) : [];
  if (files.length === 0) {
    return {
      ok: false,
      message:
        `review-ledger discharge: 'no-live-territory' requires a NON-EMPTY declared territory, but this entry records no usable file paths ` +
        `(files=${safeLabel(norm.files)}). An empty territory is the STRONGEST form of cannot-verify, never a conclusive "nothing is live". Nothing written.`,
    };
  }
  const base = typeof norm.base_sha === 'string' ? norm.base_sha.trim() : '';
  if (base === '') {
    return {
      ok: false,
      message:
        `review-ledger discharge: 'no-live-territory' requires a usable base_sha on the entry, but it records ${safeLabel(norm.base_sha)}. With no base ` +
        `state to compare against, "every declared path is back at base" cannot be established at all. Nothing written.`,
    };
  }
  const resolved = gitRun(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (resolved.status !== 0 || !(resolved.stdout ?? '').trim()) {
    return {
      ok: false,
      message:
        `review-ledger discharge: the entry's base_sha ${safeLabel(base)} does not resolve to a commit in this repository, so the base state it names ` +
        `cannot be read and no comparison is possible. Ambiguity yields UNKNOWN, never no-live. Nothing written.`,
    };
  }
  const baseSha = resolved.stdout.trim();

  // POST-HOC / AMEND AMBIGUITY: base_sha IS THE CURRENT HEAD -> REFUSE (roster
  // review MEDIUM-HIGH, fix round 2026-08-31).
  //
  // The comparison below asks the NEW-COMMIT question: is every declared path
  // back at base in the index and the worktree? For a receipt whose base_sha is
  // some ANCESTOR of HEAD that question is decisive — a clean answer means the
  // reviewed change is not sitting anywhere a commit could pick it up. But when
  // base_sha IS HEAD, a clean answer is exactly what a POST-HOC REVIEW of the
  // tip commit looks like: the reviewer reviewed the bytes that are already
  // committed, so of course nothing differs from base. That receipt is STILL
  // SPENDABLE — `scripts/commit-reviewed.mjs --target-sha <HEAD>` attaches it to
  // the tip by amending (decision post-hoc-review-receipts-target-sha-amend,
  // a899d6cc) — and discharging it as 'no-live-territory' would destroy real
  // reviewer evidence for work that is committed but NOT YET ATTESTED, which is
  // the one direction §3 forbids ("live territory is never dischargeable").
  //
  // A clean worktree therefore has TWO incompatible readings here — "the change
  // was reverted" and "the change was committed and reviewed afterwards" — and
  // this classifier cannot tell them apart: it has no record of whether the
  // reviewed bytes are in HEAD or were undone. FULL AMEND-MODE CLASSIFICATION
  // (comparing the receipt's recorded blobs against the tip commit's tree, per
  // §3's "MODE-SPECIFIC classifier semantics") IS DELIBERATELY UNBUILT in this
  // slice; refusing is the §3-conformant posture for the gap, because §3 says
  // any ambiguity yields UNKNOWN, never no-live. The refusal names the amend
  // route so a conductor is pointed at the SPEND, not at a workaround.
  const headForBase = gitRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const headShaForBase = headForBase.status === 0 ? (headForBase.stdout ?? '').trim() : '';
  if (headShaForBase !== '' && headShaForBase === baseSha) {
    return {
      ok: false,
      refusal_class: 'base-sha-is-head-amend-mode-unclassified',
      facts: {
        refusal_class: 'base-sha-is-head-amend-mode-unclassified',
        base_sha: baseSha,
        head_sha: headShaForBase,
        declared_paths: files.map(normalizePath),
        mode: 'amend (post-hoc) — NOT CLASSIFIED',
        classifier_version: CLASSIFIER_VERSION,
      },
      message:
        `review-ledger discharge: 'no-live-territory' is AMBIGUOUS for this receipt and is therefore REFUSED — its base_sha ${baseSha.slice(0, 8)} is the ` +
        `CURRENT HEAD. A clean comparison against base then has two incompatible readings: the reviewed change was REVERTED (unspendable), or it was ` +
        `COMMITTED and reviewed POST-HOC (still spendable — 'node scripts/commit-reviewed.mjs --target-sha ${headShaForBase}' attaches it to the tip by ` +
        `amending, decision post-hoc-review-receipts-target-sha-amend). This classifier cannot distinguish them: a post-hoc reviewer's clean worktree must ` +
        `not read as a revert. Amend-mode classification (receipt blobs vs the tip commit's tree) is not implemented, and §3 says any ambiguity yields ` +
        `UNKNOWN, never no-live. REMEDY: spend the receipt with --target-sha if it reviewed HEAD; otherwise discharge it under the class that actually ` +
        `applies (foreign-session / foreign-branch). The receipt stays ACTIVE; nothing written.`,
    };
  }

  const live = [];
  const ambiguous = [];
  for (const raw of files) {
    const p = normalizePath(raw);
    // UNTRACKED, CHECKED EXPLICITLY: a file present on disk but absent from the
    // index is invisible to both diffs below, so without this an added-back
    // (or never-added) file at a declared path would read as "at base".
    //
    // NO --exclude-standard (Codex review, MEDIUM — fix round 2026-08-31). That
    // flag hides IGNORED files, and an ignored file at a declared path is still
    // LIVE TERRITORY: the reviewed content is sitting on disk, a `git add -f` or
    // a later .gitignore edit stages it, and "no live territory" is a claim about
    // the WORKING STATE, not about what git would stage by default. Excluding
    // ignored paths made the strictly-safer answer (untracked -> live -> refuse)
    // depend on gitignore contents, which no reviewer receipt records.
    const others = gitRun(['ls-files', '--others', '-z', '--', p]);
    if (others.error || others.status !== 0) {
      ambiguous.push(`${p} (git ls-files --others failed: ${(others.stderr || (others.error && others.error.message) || 'unknown error').trim()})`);
      continue;
    }
    if ((others.stdout ?? '') !== '') {
      live.push(
        `${p} (present as an UNTRACKED file — ignored or not, it is not at its base state, and the reviewed content is sitting on disk where a 'git add' would pick it up)`
      );
      continue;
    }
    // BASE -> WORKTREE and BASE -> INDEX, both required. Either alone is a
    // partial view: a change staged but reverted on disk shows only in the
    // index comparison, and an unstaged edit shows only in the worktree one.
    // git's own diff handles deletions and mode changes natively, which is why
    // this is a diff and not a blob-sha comparison.
    const worktree = gitRun(['diff', '--quiet', baseSha, '--', p]);
    const index = gitRun(['diff', '--cached', '--quiet', baseSha, '--', p]);
    for (const [label, r] of [['worktree', worktree], ['index', index]]) {
      if (r.error || (r.status !== 0 && r.status !== 1)) {
        ambiguous.push(`${p} (git diff against the ${label} exited ${r.status}: ${(r.stderr || (r.error && r.error.message) || 'unknown error').trim()})`);
      } else if (r.status === 1) {
        live.push(`${p} (DIFFERS from its base state in the ${label} — modified, added or deleted since ${baseSha.slice(0, 8)})`);
      }
    }
  }

  if (ambiguous.length > 0) {
    return {
      ok: false,
      message:
        `review-ledger discharge: 'no-live-territory' could not be established CONCLUSIVELY — git could not compare ${ambiguous.length} declared path(s) ` +
        `against base ${baseSha.slice(0, 8)}: ${ambiguous.join('; ')}. Any ambiguity yields UNKNOWN, never no-live (decision 57984926 §3) — "we could not ` +
        `check" is not "it was at base". Nothing written.`,
    };
  }
  if (live.length > 0) {
    return {
      ok: false,
      message:
        `review-ledger discharge: the territory is still LIVE — ${live.length} of the ${files.length} declared path(s) DIFFER from their base state, so ` +
        `this receipt is not unspendable and must not be discharged as 'no-live-territory': ${live.join('; ')}. EVERY declared path must be back at base ` +
        `(decision 57984926 §3) — a classification computed from the paths that happen to match would discharge real review evidence for work that is still ` +
        `waiting to be committed. Nothing written.`,
    };
  }
  return {
    ok: true,
    facts: {
      base_sha: baseSha,
      declared_paths: files.map(normalizePath),
      comparison: 'base-commit vs both the index and the worktree, per declared path, with untracked presence checked explicitly',
      mode: 'new-commit (index/worktree view)',
      all_paths_at_base: true,
    },
  };
}

// ===========================================================================
// THE TWO CLASSES ADDED BY BOARD 1d6d01bd — 'unattributable' AND 'superseded'.
//
// EVERY REFUSAL BELOW CARRIES A UNIQUE TOKEN, printed as `[refusal: <token>]` at
// the end of its message. The older refusals in this file are told apart by
// their prose, which works while there are four of them and stops working at
// fifteen: the superseded class alone has a dozen distinct ways to fail, several
// of them one word apart in plain English ("the named entry is not newer" vs
// "the named entry is not active"), and a caller — or a test — that has to
// distinguish them by wording is distinguishing them by accident. The token is
// the refusal's IDENTITY: it appears exactly once per cause, it is what the
// facts object records as `refusal_class`, and it is stable across any rewording
// of the sentence around it. Existing refusal messages are deliberately
// UNTOUCHED (pin L9 and several sibling suites assert on their exact prose).
// ===========================================================================

/** Append a refusal's identity token. One helper, so a new refusal cannot be
 *  added without one — a refusal with no token is indistinguishable from its
 *  neighbours at the only surface anyone reads. */
function withToken(token, message) {
  return `${message} [refusal: ${token}]`;
}
function classRefusal(token, message, facts = {}) {
  return { ok: false, refusal_class: token, facts: { refusal_class: token, ...facts }, message: withToken(token, message) };
}

/** UNATTRIBUTABLE (board 1d6d01bd) — THE RECEIPT'S OWN RECORD IS THE PROOF.
 *
 *  H22 marks a reviewer receipt `territory.source: 'unattributable'` when the
 *  dispatch could not be bound to a block by position: SubagentStart carries no
 *  tool_use_id (research_finding ffa6219c), so with two same-type reviewers
 *  dispatched in one message the territory attributed to a receipt may belong to
 *  the OTHER one. commit-reviewed then refuses to stamp or consume it, BY
 *  CONSTRUCTION and forever — which is what makes it unspendable in exactly the
 *  sense §3 means, and what left six of them stranded in this repo's ledger.
 *
 *  THE VERIFICATION IS THE FIELD ITSELF, and that is not a weaker check than the
 *  other classes but a stronger one: foreign-session compares the entry against
 *  the outside world, no-live-territory compares it against the working tree,
 *  while here the entry's own producer already recorded the verdict. So there is
 *  nothing to re-derive — only the possibility that the conductor asserted the
 *  class about a receipt that never carried it, which is exactly what the
 *  refusal below catches. A receipt whose source is 'review-territory' is
 *  properly attributed and SPENDABLE; discharging it as unattributable would
 *  retire live review evidence on a claim its own record contradicts.
 *
 *  BOTH SPELLINGS ARE READ. `norm.files_source` is the adapter's flat view
 *  (v2's territory.source, or decision 8f137474's flat field on a v1 entry), and
 *  the raw `territory.source` is read beside it so a legacy entry carrying a
 *  nested territory object is judged on what it actually says rather than on
 *  which shape it happens to be. */
function verifyUnattributable(norm, raw) {
  const flatSource = norm && typeof norm === 'object' ? norm.files_source : undefined;
  const rawTerritory = raw && typeof raw === 'object' && raw.territory && typeof raw.territory === 'object' && !Array.isArray(raw.territory) ? raw.territory : null;
  const nestedSource = rawTerritory ? rawTerritory.source : undefined;
  if (flatSource === 'unattributable' || nestedSource === 'unattributable') {
    return {
      ok: true,
      facts: {
        files_source: 'unattributable',
        recorded_at: flatSource === 'unattributable' ? 'territory.source (normalized)' : 'territory.source (raw)',
        declared_paths: Array.isArray(norm.files) ? norm.files.filter((f) => typeof f === 'string' && f).map(normalizePath) : [],
        verified: true,
      },
    };
  }
  return classRefusal(
    'class-contradicted-by-receipt',
    `review-ledger discharge: the class 'unattributable' is CONTRADICTED by the entry itself — it records territory.source ${safeLabel(flatSource ?? nestedSource)}, ` +
      `not 'unattributable'. THE RECEIPT'S OWN RECORD IS THE PROOF for this class: H22 writes 'unattributable' when a reviewer dispatch could not be bound to a ` +
      `dispatch block by position, and scripts/commit-reviewed.mjs then never stamps or consumes it — which is precisely what makes such a receipt unspendable. ` +
      `A receipt that does NOT carry that mark is properly attributed and still spendable, so discharging it here would retire live reviewer evidence on a claim ` +
      `its own record denies. The receipt stays ACTIVE; nothing written.`,
    { recorded_files_source: typeof flatSource === 'string' ? flatSource : (typeof nestedSource === 'string' ? nestedSource : null) }
  );
}

// A COMMIT SHA IS THE FULL 40, NEVER AN ABBREVIATION (anti-pattern
// no-bounded-trail-guard-for-destructive-addressing). An abbreviated sha is
// resolved by git against whatever the repository holds TODAY and can become
// ambiguous as history grows, on evidence that decides whether real review
// evidence is retired. Case folds because hex case is an encoding detail, not an
// address: 40 hex characters name exactly one object in either spelling, so
// accepting both cannot retarget anything — unlike a prefix, which can.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** THE TRUSTWORTHY TERRITORY OF THE RECEIPT BEING DISCHARGED — what a superseder
 *  must cover.
 *
 *  `observed_files` WINS WHEN PRESENT (decision review-territory-observed-evidence,
 *  9500cce1): it is read from the departing agent's OWN transcript at Stop, so it
 *  is bound to THIS dispatch, while the declared `files` came from a prompt block
 *  that positional attribution may have mis-assigned — the very defect the
 *  'unattributable' class above exists for. Superseding on declared territory
 *  when observed territory exists would check coverage of files this reviewer may
 *  never have looked at.
 *
 *  AN EMPTY TERRITORY IS NOT A COVERED ONE. With no paths, the superset test
 *  below is vacuously satisfied by ANY survivor, and 'superseded' would become a
 *  free discharge for any receipt whose territory failed to record. That refuses
 *  (P5), the same way no-live-territory refuses an empty declared territory. */
function trustworthyTerritory(raw, norm) {
  const rawObserved = raw && typeof raw === 'object' ? raw.observed_files : undefined;
  if (Array.isArray(rawObserved)) {
    return { source: 'observed_files', paths: [...new Set(rawObserved.filter((f) => typeof f === 'string' && f !== '').map(normalizePath))] };
  }
  const declared = Array.isArray(norm && norm.files) ? norm.files : [];
  return { source: 'files (declared — this receipt records no observed_files)', paths: [...new Set(declared.filter((f) => typeof f === 'string' && f !== '').map(normalizePath))] };
}

/** The instant a receipt finished, for the strictly-newer test. `finished_at` is
 *  §1's field and the one the age advisory prefers; `started_at`/`at` are the
 *  fallbacks a v1 entry (and a v2 entry promoted before finished_at existed)
 *  leaves. Returns null when nothing parses — which REFUSES rather than
 *  defaulting, because "we could not tell which came first" is not "the survivor
 *  came second". */
function receiptInstant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const v of [raw.finished_at, raw.started_at, raw.at]) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return { iso: v, ms: t };
  }
  return null;
}

/** SUPERSEDED (board 1d6d01bd) — VERIFIED AGAINST A NAMED SURVIVOR, IN TWO FORMS.
 *
 *  THE SHAPE THIS CLASS EXISTS FOR, measured three times before it existed
 *  (decisions df1b7c41, d7f9237e, ad259700): a reviewer reviews the bytes as
 *  they were, the code then changes, a FRESH reviewer reviews the final bytes,
 *  and the first receipt is left permanently unspendable — its recorded blobs
 *  will never match the staged bytes again — while still being a stamp candidate
 *  that REFUSES the very commit its successor authorizes. All three were
 *  disposed of by hand-deleting the entry and preserving its evidence in a
 *  decision record. This class does the same judgement mechanically, and keeps
 *  the entry.
 *
 *  WHAT "SUPERSEDED" HAS TO MEAN TO BE SAFE: not "a later receipt exists" but
 *  "a later review DEMONSTRABLY COVERED this receipt's territory". Otherwise the
 *  class launders any inconvenient receipt behind any newer one, and the review
 *  floor becomes a formality. So the survivor must be:
 *
 *    ENTRY FORM — a DIFFERENT, ACTIVE, strictly NEWER receipt from the SAME
 *    session and branch, whose non-truncated `observed_reads` is a SUPERSET of
 *    this receipt's trustworthy territory, with a usable recorded blob sha for
 *    every covered path. Same-session/same-branch because a receipt from
 *    elsewhere is evidence about other work (and if THAT is the fact, the
 *    foreign-* classes are the ones that apply). observed_reads rather than the
 *    declared territory because the declaration is exactly what may be
 *    mis-attributed. NEVER a fallback to observed_files: that set is reads ∪
 *    WRITES, so a coder's own writes would count as having "reviewed" the file.
 *
 *    COMMIT FORM — a full 40-hex commit that exists here, carries a
 *    Reviewed-By-Agent trailer, and whose changed files cover the territory. A
 *    stamped commit is the strongest survivor available: the trailer means the
 *    merge gate already accepted a review for those bytes.
 *
 *  A CYCLE IS REFUSED. Two receipts that name each other as their superseder
 *  retire both while nothing ever reviewed anything — the laundering route this
 *  class most obviously invites. The check is explicit rather than resting on
 *  the active test, so the refusal names what actually happened. */
function verifySuperseded({ norm, rawEntry, index, entries }) {
  const covered = trustworthyTerritory(rawEntry, norm);
  if (covered.paths.length === 0) {
    return classRefusal(
      'no-trustworthy-territory-to-cover',
      `review-ledger discharge: 'superseded' cannot be established — this receipt records NO usable territory (neither observed_files nor declared files), so ` +
        `"the survivor covered it" is satisfied by every possible survivor and by none. An empty territory is the STRONGEST form of cannot-verify, never a free ` +
        `discharge. The receipt stays ACTIVE; nothing written.`
    );
  }
  return COMMIT_SHA_PATTERN.test(supersededBy)
    ? verifySupersededByCommit(covered)
    : verifySupersededByEntry({ norm, rawEntry, index, entries, covered });
}

function verifySupersededByEntry({ norm, rawEntry, index, entries, covered }) {
  // CANDIDATES ARE v2 ENTRIES ONLY, the same schema-disjoint rule the --entry-id
  // selector applies: `entry_id` is meaningful only inside the v2 envelope, and a
  // stray copy on a v1 entry is an unowned field anything can write.
  const matches = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (isLegacyEntry(e)) continue;
    if (e && typeof e === 'object' && typeof e.entry_id === 'string' && e.entry_id === supersededBy) matches.push(i);
  }
  if (matches.length === 0) {
    return classRefusal(
      'superseder-not-found',
      `review-ledger discharge: 'superseded' names ${JSON.stringify(supersededBy)} as the survivor, but NO schema_version 2 entry in this ledger has that ` +
        `entry_id (${entries.length} checked). The survivor is the evidence this class is verified against, so an unknown one is a refusal, never a discharge on ` +
        `trust. If you meant a COMMIT, give its full 40-hex sha. The receipt stays ACTIVE; nothing written.`
    );
  }
  if (matches.length > 1) {
    return classRefusal(
      'superseder-ambiguous',
      `review-ledger discharge: ${matches.length} schema_version 2 entries share entry_id ${JSON.stringify(supersededBy)}, so the named survivor is AMBIGUOUS ` +
        `and this verb will not pick one. Repair the duplicate ids first. Nothing written.`
    );
  }
  const j = matches[0];
  if (j === index) {
    return classRefusal(
      'superseder-is-the-discharged-entry',
      `review-ledger discharge: the named survivor IS the entry being discharged (${JSON.stringify(supersededBy)}) — a receipt cannot supersede itself, and ` +
        `recording that it did would put a self-referencing justification on the record. Nothing written.`
    );
  }
  const rawSup = entries[j];
  const normSup = normalizeLedgerEntry(rawSup);

  // CYCLE, CHECKED EXPLICITLY AND FIRST. A ↔ B mutual supersession retires two
  // receipts on the strength of each other, with no review anywhere in the loop.
  const supDisposition = rawSup.disposition && typeof rawSup.disposition === 'object' && !Array.isArray(rawSup.disposition) ? rawSup.disposition : null;
  const supSupersededBy = supDisposition && typeof supDisposition.superseded_by === 'string' ? supDisposition.superseded_by : null;
  const thisEntryIds = [typeof rawEntry.entry_id === 'string' ? rawEntry.entry_id : null, isLegacyEntry(rawEntry) ? legacyReceiptHandle(rawEntry) : null].filter(Boolean);
  if (supSupersededBy !== null && thisEntryIds.includes(supSupersededBy)) {
    return classRefusal(
      'supersession-cycle',
      `review-ledger discharge: SUPERSESSION CYCLE — the named survivor ${JSON.stringify(supersededBy)} was itself discharged as superseded BY THIS ENTRY ` +
        `(${JSON.stringify(supSupersededBy)}). Each would then be retired on the authority of the other and nothing would have reviewed anything. Nothing written.`,
      { superseder_superseded_by: supSupersededBy }
    );
  }

  // ACTIVE. A discharged (or otherwise non-active) survivor is evidence that has
  // ALREADY been ruled unspendable; retiring a second receipt behind it spends
  // authority nobody has.
  const supStatus = rawSup.status;
  if (supStatus !== undefined && supStatus !== 'active') {
    return classRefusal(
      'superseder-not-active',
      `review-ledger discharge: the named survivor ${JSON.stringify(supersededBy)} is not ACTIVE — its status is ${safeLabel(supStatus)}` +
        (dischargeMarkerClass(normSup) === 'authenticated' ? ` (an authenticated discharge, class ${safeLabel(supDisposition && supDisposition.class)})` : '') +
        `. A receipt that has itself been ruled unspendable cannot carry the review this discharge would retire. Nothing written.`
    );
  }

  // SAME SESSION AND BRANCH, both sides KNOWN. Fail-closed in the same direction
  // the foreign-* classes fail: an unknown identity is not a match, because
  // recording supersession across an unverifiable identity boundary retires real
  // evidence on an absence.
  const mine = { session: normIdentity(norm.session_id), branch: normIdentity(norm.branch) };
  const theirs = { session: normIdentity(normSup.session_id), branch: normIdentity(normSup.branch) };
  if (mine.session === null || theirs.session === null || mine.session !== theirs.session || mine.branch === null || theirs.branch === null || mine.branch !== theirs.branch) {
    return classRefusal(
      'superseder-identity-mismatch',
      `review-ledger discharge: the named survivor does not share this receipt's identity — this receipt records session ${safeLabel(mine.session)} / branch ` +
        `${safeLabel(mine.branch)}, the survivor records session ${safeLabel(theirs.session)} / branch ${safeLabel(theirs.branch)}. Both must be KNOWN and EQUAL: ` +
        `a receipt from another session or branch is evidence about other work, and an unknown identity on either side is not a match but an absence. If the ` +
        `receipt is unspendable because it belongs elsewhere, that is what 'foreign-session'/'foreign-branch' are for. Nothing written.`,
      { entry_identity: mine, superseder_identity: theirs }
    );
  }

  // STRICTLY NEWER. A survivor that finished first cannot have re-reviewed work
  // this receipt covered; equal instants are refused too — two receipts minted in
  // the same millisecond establish no order at all.
  const mineAt = receiptInstant(rawEntry);
  const theirsAt = receiptInstant(rawSup);
  if (mineAt === null || theirsAt === null || !(theirsAt.ms > mineAt.ms)) {
    return classRefusal(
      'superseder-not-newer',
      `review-ledger discharge: the named survivor is not strictly NEWER than this receipt — this receipt finished ${safeLabel(mineAt && mineAt.iso)}, the ` +
        `survivor ${safeLabel(theirsAt && theirsAt.iso)}. Supersession is an ordering claim: a review that finished first (or at the same instant, or at a time ` +
        `neither entry records readably) cannot have re-reviewed what this one covered. Nothing written.`,
      { entry_finished_at: mineAt && mineAt.iso, superseder_finished_at: theirsAt && theirsAt.iso }
    );
  }

  // OBSERVED_READS, OR NOTHING. See the class docblock: observed_files is reads ∪
  // writes, so falling back to it would accept an agent's own WRITES as evidence
  // it reviewed the file. The field does not exist in any ledger yet, which is
  // why this refusal names the gap instead of failing obscurely.
  if (rawSup.observed_reads === undefined) {
    return classRefusal(
      'superseder-predates-observed-reads',
      `review-ledger discharge: the named survivor records NO observed_reads, so there is no evidence of what it actually READ and the coverage this class ` +
        `requires cannot be established. THERE IS DELIBERATELY NO FALLBACK to observed_files: that field is reads UNION WRITES, so accepting it would let an ` +
        `agent's own writes count as having reviewed the file — the opposite of review evidence. NOTE: no ledger entry carries observed_reads yet (H22 records ` +
        `only the merged observed_files today; the split field lands in a later slice), so the ENTRY form of --superseded-by is usable only for receipts minted ` +
        `after that. ${USAGE_SUPERSEDED_CONSEQUENCE} Nothing written.`
    );
  }
  if (!Array.isArray(rawSup.observed_reads)) {
    return classRefusal(
      'superseder-observed-reads-malformed',
      `review-ledger discharge: the named survivor's observed_reads is ${safeLabel(rawSup.observed_reads)}, not a list of paths — present but unusable evidence ` +
        `is refused, never read as absent (decision 57984926 §2's INCONSISTENT-vs-ABSENT distinction). Nothing written.`
    );
  }
  if (rawSup.observed_truncated === true) {
    return classRefusal(
      'superseder-observed-reads-truncated',
      `review-ledger discharge: the named survivor's observed evidence is TRUNCATED (observed_truncated: true) — its transcript window did not cover the whole ` +
        `dispatch, so "this path is absent from observed_reads" and "this path fell outside the window" are indistinguishable. A superset test over a truncated ` +
        `set proves nothing. Nothing written.`
    );
  }
  const readSet = new Set(rawSup.observed_reads.filter((f) => typeof f === 'string' && f !== '').map(normalizePath));
  const uncovered = covered.paths.filter((p) => !readSet.has(p));
  if (uncovered.length > 0) {
    return classRefusal(
      'superseder-observed-reads-incomplete',
      `review-ledger discharge: the named survivor did not read ${uncovered.length} of the ${covered.paths.length} path(s) this receipt covers — ` +
        `${uncovered.join(', ')} (this receipt's territory comes from ${covered.source}). The survivor's observed_reads must be a SUPERSET: superseding on ` +
        `PARTIAL coverage retires review evidence for the paths nobody looked at again, which is the same hole a per-path stamp exists to close. Nothing written.`,
      { uncovered_paths: uncovered, territory_source: covered.source }
    );
  }

  // A USABLE RECORDED BLOB PER COVERED PATH. observed_reads says the survivor
  // LOOKED at the path; the blob sha says WHICH BYTES it looked at. Without the
  // second half the discharge rests on evidence commit-reviewed's own byte gate
  // would refuse to spend.
  const { map: supBlobs, collisions: supCollisions } = receiptBlobEvidence(normSup);
  const unbound = covered.paths.filter((p) => supCollisions.has(p) || !isUsableBlobSha(supBlobs.get(p)));
  if (unbound.length > 0) {
    return classRefusal(
      'superseder-content-evidence-incomplete',
      `review-ledger discharge: the named survivor records no usable content evidence for ${unbound.length} of the ${covered.paths.length} covered path(s) — ` +
        `${unbound.map((p) => `${p} (${supCollisions.has(p) ? 'contradictory recorded shas' : safeLabel(supBlobs.get(p))})`).join(', ')}. observed_reads says the ` +
        `survivor LOOKED at a path; a recorded 40-hex blob sha says WHICH BYTES it looked at, and a supersession resting on the first alone would retire this ` +
        `receipt behind evidence the reviewed-bytes gate itself could not spend. Nothing written.`,
      { unbound_paths: unbound }
    );
  }

  return {
    ok: true,
    facts: {
      form: 'entry',
      superseded_by: supersededBy,
      superseder_entry_id: rawSup.entry_id,
      superseder_agent_type: typeof normSup.agent_type === 'string' ? normSup.agent_type : null,
      superseder_finished_at: theirsAt.iso,
      entry_finished_at: mineAt.iso,
      identity: mine,
      territory_source: covered.source,
      covered_paths: covered.paths,
      superseder_blobs: Object.fromEntries(covered.paths.map((p) => [p, supBlobs.get(p)])),
      verified: true,
    },
  };
}

function verifySupersededByCommit(covered) {
  const sha = supersededBy.toLowerCase();
  const resolved = gitRun(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (resolved.status !== 0 || !(resolved.stdout ?? '').trim()) {
    return classRefusal(
      'superseder-commit-unresolvable',
      `review-ledger discharge: the named survivor commit ${sha} does not resolve to a commit in this repository, so neither its review trailer nor its files ` +
        `can be read and nothing about it can be verified. Nothing written.`
    );
  }
  const resolvedSha = resolved.stdout.trim();
  const body = gitRun(['show', '-s', '--format=%B', resolvedSha]);
  if (body.error || body.status !== 0) {
    return classRefusal(
      'superseder-commit-unreadable',
      `review-ledger discharge: git could not read the message of the survivor commit ${resolvedSha.slice(0, 8)} ` +
        `(${(body.stderr || (body.error && body.error.message) || 'unknown error').trim()}). "We could not check" is not "it was reviewed". Nothing written.`
    );
  }
  // THE TRAILER IS THE POINT. A commit sha alone says work landed, not that it
  // was reviewed — and this class retires reviewer evidence, so only a commit the
  // merge gate would itself accept as reviewed can stand in for it.
  if (!/^Reviewed-By-Agent:[ \t]*\S/m.test(body.stdout ?? '')) {
    return classRefusal(
      'superseder-commit-lacks-review-trailer',
      `review-ledger discharge: the survivor commit ${resolvedSha.slice(0, 8)} carries NO 'Reviewed-By-Agent' trailer, so it is not evidence that anything ` +
        `reviewed these bytes — it is only evidence that they landed. A commit with no review attestation cannot retire a review receipt; that would let ` +
        `committing the work discharge the requirement to review it. Nothing written.`
    );
  }
  // core.quotePath=false so a non-ASCII path arrives as itself rather than as an
  // octal-escaped quoted string, which would read as an uncovered path and refuse
  // a legitimate supersession.
  const names = gitRun(['-c', 'core.quotePath=false', 'show', '--name-only', '--pretty=format:', resolvedSha]);
  if (names.error || names.status !== 0) {
    return classRefusal(
      'superseder-commit-files-unreadable',
      `review-ledger discharge: git could not list the files of the survivor commit ${resolvedSha.slice(0, 8)} ` +
        `(${(names.stderr || (names.error && names.error.message) || 'unknown error').trim()}). Nothing written.`
    );
  }
  const commitPaths = new Set(
    (names.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map(normalizePath)
  );
  const uncovered = covered.paths.filter((p) => !commitPaths.has(p));
  if (uncovered.length > 0) {
    return classRefusal(
      'superseder-commit-territory-incomplete',
      `review-ledger discharge: the survivor commit ${resolvedSha.slice(0, 8)} does not touch ${uncovered.length} of the ${covered.paths.length} path(s) this ` +
        `receipt covers — ${uncovered.join(', ')} (this receipt's territory comes from ${covered.source}). The commit's files must be a SUPERSET: a commit that ` +
        `never touched a path cannot have superseded the review of it. Nothing written.`,
      { uncovered_paths: uncovered, commit_paths: [...commitPaths], territory_source: covered.source }
    );
  }
  return {
    ok: true,
    facts: {
      form: 'commit',
      superseded_by: resolvedSha,
      superseder_commit: resolvedSha,
      reviewed_by_agent_trailer: true,
      territory_source: covered.source,
      covered_paths: covered.paths,
      commit_paths: [...commitPaths],
      verified: true,
    },
  };
}

// ===========================================================================
// THE LOCK — the same mkdirSync-as-atomic-primitive shape scripts/commit-
// reviewed.mjs and scripts/hooks/h22-dispatch-register.mjs both carry, with the
// SAME 10s stale-steal convention (deliberately unchanged: a genuinely dead
// holder must still be recoverable by the other two writers, which know nothing
// about the ownership token below). UNLIKE those two, a timeout here REFUSES
// rather than proceeding unlocked: they are appending or removing their OWN
// entries, while this rewrites an entry in place under a concurrency token, and
// honouring a token verified outside the lock is exactly the race the token
// exists to prevent.
//
// OWNERSHIP, ADDED IN THE S2b-3 FIX ROUND (Codex review, HIGH). The 10s window
// was measured against the WRONG clock: an mtime set once at acquire, while this
// command's critical section runs a git call per declared path and each call is
// allowed thirty seconds. A live classifier working through a ten-path receipt
// therefore looks abandoned long before it finishes, and a second writer steals
// the lock UNDER IT — after which the first process's release would delete the
// SECOND process's lock, handing a third writer a critical section that overlaps
// both. Two halves close that:
//
//   REFRESH — gitRun() touches the lock directory's mtime immediately before
//   every git invocation (see gitRun), so a holder that is doing work never
//   ages past the steal window. The window still exists for a holder that is
//   doing nothing, which is the only holder it should ever apply to.
//
//   OWNER TOKEN — a pid + random nonce written INSIDE the lock directory at
//   acquire. The pid alone is not identity (anti-pattern: a recycled pid gives
//   a false positive), so the nonce is what makes the token unforgeable in
//   practice. The release removes the lock ONLY if the token on disk is still
//   ours; otherwise the lock belongs to a USURPER and is left strictly alone,
//   with the steal disclosed on stderr.
//
// THE RELEASE NEVER THROWS. It runs from a `finally` that may be unwinding a
// Refusal — the accountable "nothing was written, here is why" the caller must
// see — and a throw there would replace that refusal with a filesystem error
// about the lock. Every failure path in the release is disclosed and swallowed
// (a missing lock directory included: rmSync force already tolerates ENOENT,
// and the try/catch covers the rest).
// ===========================================================================
// LOCK_STALE_MS and heldLock are declared ABOVE the verb dispatch (see the note
// there) — `record-external` takes this same lock from a dispatch that runs
// before this point in the file.

/** Keep a HELD lock looking alive. Called before every git invocation; a failure
 *  is silent BY DESIGN — if the directory is gone or unwritable the lock has
 *  already been stolen, and the release's token check is the authority on that,
 *  not this best-effort touch. */
function refreshLockMtime() {
  if (heldLock === null) return;
  try {
    const now = new Date();
    utimesSync(heldLock.path, now, now);
  } catch {
    /* stolen or vanished — releaseHeldLock() decides what that means */
  }
}

/** Release ONLY a lock we still own. Never throws (see the header). */
function releaseHeldLock() {
  const held = heldLock;
  heldLock = null;
  if (held === null) return;
  let onDisk = null;
  try {
    onDisk = readFileSync(held.ownerPath, 'utf8');
  } catch {
    onDisk = null; // no owner token: not ours (a usurper's lock, or ours already removed)
  }
  if (onDisk !== held.token) {
    console.error(
      `review-ledger: THE LEDGER LOCK WAS TAKEN OVER while this discharge held it (${held.path}) — its owner token is now ` +
        `${onDisk === null ? '<absent>' : JSON.stringify(onDisk.slice(0, 64))}, not ours. The current holder's lock is LEFT EXACTLY AS IT IS: removing it ` +
        `would hand a third writer a critical section overlapping an active one. This is disclosed, not repaired — a stolen lock means a concurrent writer ` +
        `judged this process dead, so re-read the ledger before trusting any state you saw.`
    );
    return;
  }
  try {
    rmSync(held.path, { recursive: true, force: true }); // recursive: the owner token lives INSIDE the dir; force: ENOENT is not an error
  } catch (e) {
    console.error(
      `review-ledger: could not remove the ledger lock ${held.path} after this discharge (${e && e.message ? e.message : e}) — it will be treated as ` +
        `abandoned by the next writer after ${LOCK_STALE_MS / 1000}s. Disclosed, never rethrown: this must not replace the report of what the discharge did.`
    );
  }
}

function withLedgerLock(sterlingDir, run) {
  const lockPath = join(sterlingDir, 'review-ledger.lock');
  const ownerPath = join(lockPath, 'owner');
  const token = `${process.pid}:${randomBytes(12).toString('hex')}`;
  let acquired = false;
  for (let i = 0; i < 200 && !acquired; i++) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (!acquired) {
    fail(
      `review-ledger ${verb}: the review-ledger lock is held by another process and did not clear — REFUSING rather than writing unlocked, because a ` +
        'digest verified outside the lock is exactly the race the digest exists to prevent. Nothing written; re-run.'
    );
  }
  // The token is written BEFORE any work: a critical section whose owner cannot
  // be identified must never start, because its release would then have to
  // choose between deleting a possible usurper's lock and leaking its own.
  try {
    writeFileSync(ownerPath, token);
  } catch (e) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best effort — the stale window is the backstop */
    }
    fail(
      `review-ledger ${verb}: acquired the ledger lock but could not write its owner token (${e && e.message ? e.message : e}) — REFUSING rather than ` +
        `running a critical section this process cannot prove it owns, because the release would then be unable to tell its own lock from a usurper's. ` +
        `Nothing written; re-run.`
    );
  }
  heldLock = { path: lockPath, ownerPath, token };
  try {
    return run();
  } finally {
    releaseHeldLock();
  }
}

// ===========================================================================
// DISCHARGE.
// ===========================================================================
const sterlingDir = join(target, '.sterling');
const ledgerFilePath = join(sterlingDir, 'review-ledger.json');

/** The whole discharge, run UNDER the ledger lock: read the exact bytes, verify
 *  the concurrency token against them, resolve the selector, check the
 *  lifecycle state, verify the class, and replace atomically. Read-verify-write
 *  is one critical section on purpose — a token verified outside the lock is
 *  exactly the race the token exists to prevent. */
function dischargeUnderLock() {
  if (!existsSync(ledgerFilePath)) {
    refuse(`review-ledger discharge: no review ledger at ${ledgerFilePath} — there is nothing to discharge. Nothing written.`);
  }
  // The EXACT bytes: the digest is computed over these, and JSON.parse reads
  // the same buffer, so the token can never describe a different read than the
  // one this command acts on.
  let bytes;
  try {
    bytes = readFileSync(ledgerFilePath);
  } catch (e) {
    refuse(`review-ledger discharge: could not read ${ledgerFilePath} (${e && e.message ? e.message : e}). Nothing written.`);
  }
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== expectedDigest) {
    refuse(
      `review-ledger discharge: LEDGER DIGEST MISMATCH — the token you supplied (${expectedDigest}) is not the sha256 of the ledger's current bytes ` +
        `(${actualDigest}). The ledger CHANGED between the read your decision was based on and this command, so the entry you meant to discharge may not ` +
        `be the entry you would be writing (the usual cause is an H22 SubagentStop promoting a fresh receipt). REFUSED and NOTHING WRITTEN — re-read the ` +
        `ledger, re-check your decision, and re-run with a fresh digest.`
    );
  }

  let entries;
  try {
    entries = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    refuse(
      `review-ledger discharge: ${ledgerFilePath} is not valid JSON (${e && e.message ? e.message : e}) — refusing to rewrite an evidence file this ` +
        `command cannot parse. Nothing written.`
    );
  }
  if (!Array.isArray(entries)) {
    refuse(`review-ledger discharge: ${ledgerFilePath} does not hold a JSON array (got ${typeof entries}) — refusing to rewrite it. Nothing written.`);
  }

  // SELECTOR: exact equality on the RAW entry, in whichever of the two spellings
  // was given. No prefix matching and no "the only entry" / "the first entry"
  // fallback — a forgiving selector on a state-changing operation is the shape
  // anti-pattern no-bounded-trail-guard-for-destructive-addressing forbids, and
  // here it would discharge a bystander as a consolation prize.
  //
  // EACH SELECTOR'S CANDIDATE SET IS SCHEMA-DISJOINT — the legacy arm considers
  // ONLY legacy entries, and the v2 arm ONLY v2 entries (Codex review MED-1,
  // thread 01a05c7b). isLegacyEntry is §3's "missing schema_version = legacy
  // roster receipt", stated once in the shared adapter, so both arms ask one
  // question one way.
  //
  // THE v2 ARM'S FILTER IS THE FIX, NOT DECORATION. It used to match EVERY object
  // carrying the id, so a LEGACY entry that happened to carry the same entry_id as
  // a real v2 entry joined the candidate set and made the selector AMBIGUOUS —
  // blocking the discharge of a perfectly valid v2 receipt on the strength of a
  // field a v1 entry was never supposed to have (and which anything writing the
  // ledger can add). The ledger is agent-writable, so that was a one-key denial of
  // service against the v2 arm. `entry_id` is meaningful ONLY inside the v2
  // envelope; on a legacy entry it is an unowned stray field, and it is now read
  // exactly that way — as a DIAGNOSTIC below, never as a selection candidate.
  const matches = [];
  if (legacyHandle !== null) {
    for (let i = 0; i < entries.length; i++) {
      if (!isLegacyEntry(entries[i])) continue;
      if (legacyReceiptHandle(entries[i]) === legacyHandle) matches.push(i);
    }
  } else {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (isLegacyEntry(e)) continue; // a stray entry_id on a v1 entry is not a v2 address
      if (e && typeof e === 'object' && typeof e.entry_id === 'string' && e.entry_id === entryId) matches.push(i);
    }
  }
  if (matches.length === 0) {
    if (legacyHandle !== null) {
      // THE ONE PLACE HANDLES ARE PRINTED. A handle is DERIVED, not stored, so a
      // conductor holding a stranded v1 receipt has nowhere else to read it from
      // — and a selector nobody can discover is a selector nobody can use. The
      // list is of FULL EXACT handles (never truncated: a clipped handle here
      // would train the very abbreviation this verb refuses) and is capped, since
      // a refusal is a message, not a report.
      const legacyIdx = entries.map((e, i) => (isLegacyEntry(e) ? i : -1)).filter((i) => i !== -1);
      const shown = legacyIdx.slice(0, HANDLE_LIST_CAP);
      const listing =
        legacyIdx.length === 0
          ? ' The ledger holds NO legacy v1 entries at all — every entry is schema_version 2, addressed by --entry-id.'
          : ` The ${legacyIdx.length} legacy v1 entr${legacyIdx.length === 1 ? 'y' : 'ies'} present ${legacyIdx.length === 1 ? 'has' : 'have'} these handles: ` +
            shown.map((i) => `${legacyReceiptHandle(entries[i])} (${safeLabel(normalizeLedgerEntry(entries[i]).agent_type)}, at ${safeLabel(entries[i].at)})`).join('; ') +
            (legacyIdx.length > shown.length ? `; …and ${legacyIdx.length - shown.length} more` : '') +
            '.';
      refuse(
        `review-ledger discharge: NO LEGACY LEDGER ENTRY has handle ${JSON.stringify(legacyHandle)} — ${entries.length} ` +
          `entr${entries.length === 1 ? 'y' : 'ies'} checked. Nothing is discharged in its place and nothing is written: an unknown selector is a refusal, ` +
          `never a substitute target, and it is never widened into a prefix search to find something close.${listing}`
      );
    }
    // DIAGNOSTIC ONLY, RUN AFTER SELECTION HAS ALREADY FAILED (Codex review
    // MED-1). A legacy entry carrying this entry_id was never a candidate above —
    // that is the whole point of the disjoint sets — but it IS the likeliest
    // reason a conductor is here, so the refusal names its handle rather than
    // dead-ending. Looking it up HERE, on a path that has already decided to
    // refuse, is what keeps it a diagnostic: nothing it finds can change the
    // outcome, promote a target, or resolve an ambiguity. Before the legacy
    // handle existed this refusal was terminal, and that is what stranded the
    // receipt this feature exists for.
    const strays = entries
      .map((e, i) => (isLegacyEntry(e) && e && typeof e === 'object' && typeof e.entry_id === 'string' && e.entry_id === entryId ? i : -1))
      .filter((i) => i !== -1);
    const redirect =
      strays.length === 0
        ? ''
        : ` NOTE: ${strays.length} LEGACY v1 entr${strays.length === 1 ? 'y carries' : 'ies carry'} that entry_id as a stray field, which is NOT a v2 address ` +
          `— entry_id is meaningful only inside the v2 envelope, and a v1 entry is addressed by its generated handle (decision 57984926 §3). Re-run with ` +
          `${strays.map((i) => `--legacy-handle ${legacyReceiptHandle(normalizeLedgerEntry(entries[i]))}`).join(' or ')}. Note that --class 'no-live-territory' ` +
          `is not available for a v1 entry: §3 makes a v2 roster receipt its first precondition.`;
    refuse(
      `review-ledger discharge: NO SCHEMA_VERSION 2 LEDGER ENTRY has entry_id ${JSON.stringify(entryId)} — ${entries.length} ` +
        `entr${entries.length === 1 ? 'y' : 'ies'} checked, none match. Nothing is discharged in its place and nothing is written: an unknown selector is a ` +
        `refusal, never a substitute target.${redirect}`
    );
  }
  if (matches.length > 1) {
    if (legacyHandle !== null) {
      // A HANDLE COLLISION NAMES BOTH SIDES AND WRITES NOTHING. Two v1 entries
      // whose agent_type, dispatch instant, declared territory AND recorded blob
      // map all agree are indistinguishable to this selector, so picking either
      // would be picking at random on a call that overwrites evidence.
      refuse(
        `review-ledger discharge: ${matches.length} LEGACY ledger entries share the handle ${JSON.stringify(legacyHandle)} — the selector is AMBIGUOUS, so no ` +
          `entry is discharged and NOTHING is written. The colliding entries are: ` +
          matches
            .map((i) => {
              const n = normalizeLedgerEntry(entries[i]);
              return `index ${i} (agent_type ${safeLabel(n.agent_type)}, at ${safeLabel(n.at)}, files ${safeLabel(n.files)})`;
            })
            .join('; ') +
          `. A handle is a fingerprint of the receipt's own content (agent_type + dispatch instant + declared territory + recorded blobs), so a collision ` +
          `means two receipts recorded identical content and neither can be told from the other here. Judge them by hand, or re-dispatch a reviewer for the ` +
          `work they cover — this verb will not pick one at random.`
      );
    }
    // v2 ENTRIES ONLY, by construction of the candidate set above (MED-1): a
    // legacy entry carrying a stray copy of this id can no longer inflate this
    // count, so reaching here means two REAL v2 entries genuinely share an id.
    refuse(
      `review-ledger discharge: ${matches.length} schema_version 2 ledger entries share entry_id ${JSON.stringify(entryId)} — the selector is AMBIGUOUS, so ` +
        `no entry is discharged. Nothing written; repair the duplicate ids first.`
    );
  }
  const index = matches[0];
  const rawEntry = entries[index];
  // What the messages below call the target. One definition, so a refusal can
  // never name the selector the caller did NOT use.
  const selectorLabel = legacyHandle !== null ? `legacy handle ${JSON.stringify(legacyHandle)}` : `entry ${JSON.stringify(entryId)}`;

  // SELECTOR/SCHEMA AGREEMENT IS ESTABLISHED BY THE CANDIDATE SETS, not by a
  // check here (Codex review MED-1). A post-selection `schema_version !== 2`
  // refusal used to stand at this point; it is GONE rather than kept as belt and
  // braces, because with disjoint candidate sets it is unreachable, and an
  // unreachable guard is the worse of the two options: it reads as the thing
  // enforcing the rule, so the next reader relaxes the filter above believing
  // this still catches it. `matches` therefore holds exactly one v2 entry on the
  // v2 arm and exactly one legacy entry on the legacy arm, and the redirect a v1
  // entry with a stray entry_id used to get is now issued by the zero-match
  // refusal above, where it belongs.
  const norm = normalizeLedgerEntry(rawEntry);
  // THE v2 ARM ONLY, for the same reason LOW-2 moved dischargeMarkerClass off this
  // field: on the LEGACY arm `norm` IS the raw entry (the adapter returns a v1
  // entry untouched), so a hand-written `v2_deficient: true` key would otherwise
  // refuse the discharge of a perfectly ordinary v1 receipt — a one-key denial of
  // service re-stranding the entry, in a ledger anything can write. On the v2 arm
  // the field is computed by the adapter and is trustworthy.
  if (legacyHandle === null && norm.v2_deficient) {
    refuse(
      `review-ledger discharge: ${selectorLabel} claims schema_version 2 but is STRUCTURALLY DEFICIENT (missing entry_id/started_at/identity) ` +
        `— commit-reviewed already withholds it from spending for that reason, and rewriting a malformed evidence record would manufacture a well-formed ` +
        `disposition out of a shape nothing produced. Nothing written.`
    );
  }

  // ALREADY DISCHARGED — refused BEFORE any class verification, so a repeat
  // discharge is answered on the fact that matters (this was already decided)
  // rather than on whatever the new class happens to claim. NEVER a second
  // state flip, and NEVER a rewritten disposition: a silently overwritten
  // justification lets a later, weaker reason replace the recorded one with no
  // trace. There is no resurrection verb either — see the header.
  //
  // ON A LEGACY ENTRY THE AUTHORITY IS THE MARKER CLASS, NOT THE BARE FIELD
  // (board 7dd3200a). `status:'discharged'` alone on a v1 entry is NOT a
  // lifecycle state — the shared adapter reads it as 'v1-no-lifecycle' and every
  // spending surface still spends the receipt (frozen pin P4a) — so refusing
  // here on the bare field would tell the conductor "already discharged" about a
  // receipt that is demonstrably still being spent, and would re-strand exactly
  // the entry this handle exists to free. So the legacy arm refuses on an
  // AUTHENTICATED marker (the pair the verb itself writes) and on any recorded
  // disposition it did not write, and otherwise proceeds — disclosing the stray
  // field it is about to overwrite rather than overwriting it in silence.
  if (legacyHandle !== null) {
    if (dischargeMarkerClass(norm) === 'authenticated') {
      const prior = rawEntry.disposition;
      refuse(
        `review-ledger discharge: the entry addressed by ${selectorLabel} is ALREADY DISCHARGED — class ${safeLabel(prior && prior.class)}, at ` +
          `${safeLabel(prior && prior.at)}, reason ${safeLabel(prior && prior.reason)}. The recorded disposition is LEFT EXACTLY AS IT IS: a second discharge ` +
          `would either flip a state that is already flipped or overwrite an accountable justification with a later one. Nothing written.`
      );
    }
    if (rawEntry.disposition !== undefined && rawEntry.disposition !== null) {
      refuse(
        `review-ledger discharge: the entry addressed by ${selectorLabel} already carries a disposition ${safeLabel(rawEntry.disposition)} that this verb did ` +
          `not write — it does not authenticate as a discharge (no contentful reason and recognized class), yet it records SOMETHING, and this verb will not ` +
          `silently replace a justification a human may have meant. Repair or remove the field deliberately, then re-run. Nothing written.`
      );
    }
    if (rawEntry.status !== undefined && rawEntry.status !== 'active' && rawEntry.status !== 'discharged') {
      refuse(
        `review-ledger discharge: the entry addressed by ${selectorLabel} carries an UNRECOGNIZED status ${safeLabel(rawEntry.status)} — the known lifecycle ` +
          `states are 'active' and 'discharged'. Unknown signals halt (P5); nothing written.`
      );
    }
  } else if (rawEntry.status === 'discharged') {
    const prior = rawEntry.disposition && typeof rawEntry.disposition === 'object' ? rawEntry.disposition : null;
    refuse(
      `review-ledger discharge: entry ${JSON.stringify(entryId)} is ALREADY DISCHARGED` +
        (prior
          ? ` — class ${safeLabel(prior.class)}, at ${safeLabel(prior.at)}, reason ${safeLabel(prior.reason)}`
          : ' (its disposition is missing or malformed)') +
        `. The recorded disposition is LEFT EXACTLY AS IT IS: a second discharge would either flip a state that is already flipped or overwrite an ` +
        `accountable justification with a later one, and both are ways of losing the record this verb exists to keep. Nothing written.`
    );
  }
  // v2 ARM ONLY — the legacy arm made this same check above, with 'discharged'
  // deliberately excluded from it (a stray bare marker on a v1 entry is not a
  // lifecycle state and must stay dischargeable). Reaching here on the v2 arm
  // means the status is neither 'active' nor 'discharged', since the branch above
  // already refused the latter.
  if (legacyHandle === null && rawEntry.status !== undefined && rawEntry.status !== 'active') {
    refuse(
      `review-ledger discharge: entry ${JSON.stringify(entryId)} carries an UNRECOGNIZED status ${safeLabel(rawEntry.status)} — the known lifecycle states ` +
        `are 'active' and 'discharged'. Unknown signals halt (P5); nothing written.`
    );
  }

  const verdict =
    dischargeClass === 'no-live-territory'
      ? verifyNoLiveTerritory(norm)
      : dischargeClass === 'foreign-session'
        ? verifyForeignSession(norm)
        : dischargeClass === 'foreign-branch'
          ? verifyForeignBranch(norm)
          : dischargeClass === 'unattributable'
            ? verifyUnattributable(norm, rawEntry)
            : verifySuperseded({ norm, rawEntry, index, entries });
  if (!verdict.ok) refuse(verdict.message);

  const headResult = gitRun(['rev-parse', 'HEAD']);
  const headSha = headResult.status === 0 ? (headResult.stdout ?? '').trim() || null : null;

  // PRESERVE, DO NOT REPLACE. The entry is spread as it is on disk and only
  // `status`/`disposition` are set, so every field that constitutes the review
  // record — reviewer provenance, territory, content evidence, identity, the
  // timestamps — survives the state flip byte-for-byte, and (because both keys
  // already exist on a real v2 entry) even the key order is unchanged. Every
  // OTHER entry in the array is written back untouched: this verb writes
  // exactly one entry.
  //
  // ON A LEGACY ENTRY THIS ADDS TWO KEYS AND MIGRATES NOTHING (board 7dd3200a).
  // §3 rejected in-place v1→v2 migration outright while licensing exactly this
  // shape — "explicit discharge may add lifecycle fields to a v1 entry as a
  // REQUESTED TRANSITION" — so the entry stays v1: no schema_version is written,
  // no field is renamed or nested, no evidence is rewritten. It simply gains
  // `status` and `disposition` beside everything it already recorded, which is
  // the same one-entry, evidence-preserving write the v2 arm performs.
  const dischargedEntry = {
    ...rawEntry,
    status: 'discharged',
    disposition: {
      reason,
      at: new Date().toISOString(),
      head_sha: headSha,
      classifier_version: CLASSIFIER_VERSION,
      class: dischargeClass,
      // THE NAMED SURVIVOR, ON THE MARKER ITSELF (board 1d6d01bd) — not only
      // inside `facts`. A 'superseded' disposition whose survivor a reader has to
      // dig for is a claim with the evidence filed elsewhere, and the survivor is
      // the ONE thing that makes this class re-checkable later. It is also what
      // the cycle guard in verifySupersededByEntry reads back, so its home has to
      // be somewhere stable rather than inside a per-class facts blob. Written
      // for the superseded class ONLY (null elsewhere, never omitted: a key whose
      // PRESENCE varies by class cannot be read by a consumer that does not
      // already know the class).
      superseded_by: supersededBy,
      // §3's "underlying facts": what the classifier actually observed, so a
      // later reader can re-check the verdict instead of trusting the label.
      facts: verdict.facts,
    },
  };
  const next = entries.slice();
  next[index] = dischargedEntry;

  // ATOMIC REPLACE: write a sibling tmp and rename over the ledger, so a reader
  // (or a crash) never observes a half-written evidence file. Same shape as
  // commit-reviewed's consume write.
  const tmpPath = join(sterlingDir, `review-ledger.json.tmp-${process.pid}`);
  writeFileSync(tmpPath, JSON.stringify(next));
  renameSync(tmpPath, ledgerFilePath);

  // THE STRAY-MARKER DISCLOSURE IS PRINTED HERE — AFTER renameSync, THE LINE THAT
  // MAKES THE REPLACEMENT REAL, AND NOWHERE EARLIER (roster review LOW-1, then
  // Codex re-verdict, thread 01a05c7b). It says a stray `status:'discharged'` on
  // the target entry HAS BEEN replaced, which is a claim about a completed write.
  // It has now moved twice, and the second move is the one that finishes the job:
  // beside the marker check it fired on every refusal below it; above the write it
  // still fired when writeFileSync/renameSync THREW — permissions, a full disk, a
  // vanished .sterling — and that throw is NOT a Refusal, so it propagates out of
  // withLedgerLock and is re-raised untouched at the call site, leaving the ledger
  // byte-identical after stderr had already announced the replacement. "Nearly
  // written" is written, as far as a reader deciding what to do next is concerned.
  // Below the rename there is no failure path left that can un-write it.
  if (legacyHandle !== null && rawEntry.status === 'discharged') {
    console.error(
      `review-ledger discharge: the legacy entry addressed by ${selectorLabel} carried a bare status:'discharged' with no disposition. That is NOT a ` +
        `discharge — every reading surface still spends such a receipt (decision 57984926 §3's "missing status = active", read to its conclusion) — so this ` +
        // WORDING IS FROZEN BY PIN L9, which asserts this exact phrase is ABSENT
        // on every refusing path. Rewording it (e.g. to the past tense that now
        // reads more naturally below the write) would satisfy that doesNotMatch
        // for the wrong reason — drift, not correctness — and quietly hollow out
        // the pin. The phrase stays; only its POSITION moved.
        `discharge REPLACES the stray marker with an authenticated one. Disclosed, not silent.`
    );
  }

  return {
    discharged: true,
    // BOTH SELECTOR FIELDS ARE ALWAYS PRESENT, one of them null — a report whose
    // KEYS change with the selector cannot be read by a consumer that does not
    // already know which selector was used. schema_version says which shape was
    // written, so a reader never has to infer it from which field is populated.
    entry_id: entryId,
    legacy_handle: legacyHandle,
    schema_version: rawEntry.schema_version === 2 ? 2 : 1,
    agent_type: typeof norm.agent_type === 'string' ? norm.agent_type : null,
    class: dischargeClass,
    superseded_by: supersededBy,
    reason,
    at: dischargedEntry.disposition.at,
    head_sha: headSha,
    classifier_version: CLASSIFIER_VERSION,
    facts: verdict.facts,
    preserved: true,
    ledger: ledgerFilePath,
  };
}

// Every refusal inside the critical section is THROWN (see Refusal above) so
// the lock is released by withLedgerLock's finally before this converts it to
// stderr + exit 1. A non-Refusal throw is re-raised untouched: an unexpected
// failure must not be laundered into a tidy refusal message.
let report;
try {
  report = withLedgerLock(sterlingDir, dischargeUnderLock);
} catch (e) {
  if (e && e.refusal) fail(e.message);
  throw e;
}

console.log(JSON.stringify(report));

// ===========================================================================
// RECORD-EXTERNAL (decision 57984926 §4 "EXTERNAL REVIEW"; campaign slice
// S2b-4).
//
//   node scripts/review-ledger.mjs record-external \
//     --file <repo-relative path> [--file <path> …] \
//     --provider <id> [--model <id>] --thread-id <id> --round <n> \
//     [--note "<single-line note>"]
//
// WHAT THIS RECORDS, AND WHAT IT IS NOT. §4 verbatim: this is "conductor-
// attested evidence of a completed consult, NOT PROOF". The conductor typed the
// command; nothing here verifies that the consult happened, which provider
// answered, or what it said. That is precisely why the entry is minted ONLY by
// an explicit command — §4 rejected minting external entries by inferring review
// purpose from Codex prompts or H29 observations, because H29 cannot tell design
// sparring from review and keyword inference FALSE-MINTS review evidence.
// Under-recording through an explicit verb is the safer failure.
//
// NEVER SPENDABLE, BY TWO INDEPENDENT GUARDS (§4: "kind gate + agent-type
// regex, belt and braces"). The entry declares kind:'external_review', which
// every reading surface gates on through the shared adapter; and it carries NO
// agent_type ANYWHERE, so it also fails commit-reviewed's VALID_AGENT_TYPE
// roster check. Neither guard stands in for the other: dropping the kind gate
// must not make this spendable, and neither must a future entry shape that
// happens to acquire a reviewer-looking field. If external provenance ever
// reaches a commit it does so under a DISTINCT `External-Review:` trailer, never
// `Reviewed-By-Agent:` — the merge gate's receipt read is keyed to the latter.
//
// NO --digest, DELIBERATELY (adjudicated). The discharge verb takes a
// concurrency token because it REWRITES AN EXISTING ENTRY IN PLACE, and a stale
// read there means flipping the state of an entry other than the one the
// conductor judged. An APPEND is not a state flip: it changes no existing entry,
// so a receipt promoted between the conductor's read and this command is not a
// hazard — it simply survives beside the new entry. The lock (not a token) is
// what makes the append safe against a concurrent H22 promotion.
//
// IDEMPOTENT ON (thread_id, round). One consult thread holds SEVERAL review
// rounds (§4: "round/consult id for idempotency — one thread can hold several
// review rounds"), so the round is what distinguishes them and the PAIR is the
// key. The command is hand-typed, so re-running it is the natural conductor
// mistake, and a ledger that doubles its own evidence on a re-run cannot be
// COUNTED — the count is exactly what a reader of external review evidence
// wants. A repeat writes NOTHING, preserves the first attestation verbatim, and
// DISCLOSES the duplicate (P5: never a silent success).
// ===========================================================================

/** MODEL IS RECORDED OR ABSENT — NEVER INVENTED (§4's "--model-or-null").
 *  A consult whose model the conductor cannot observe records null. Defaulting
 *  to the provider's flagship, to the configured reviewer model, or to the
 *  string 'unknown' would turn conductor-attested evidence into a FALSE
 *  PROVENANCE CLAIM, which is the one thing §4 says this entry is not. */
function recordExternal() {
  let outcome;
  try {
    outcome = recordExternalUnderLock(buildExternalEntryFromArgv());
  } catch (e) {
    if (e && e.refusal) fail(e.message);
    throw e;
  }
  if (outcome.duplicate) {
    // EXIT 0, NOTHING WRITTEN, LOUDLY DISCLOSED. A repeat is not an error — the
    // consult it names really is recorded — but a silent success would leave the
    // conductor believing a second attestation exists.
    console.error(
      `review-ledger record-external: DUPLICATE — an external_review entry for thread_id ${JSON.stringify(outcome.thread_id)} round ${outcome.round} is ` +
        `ALREADY RECORDED (entry_id ${JSON.stringify(outcome.existing_entry_id)}). NOTHING WAS WRITTEN and the first attestation is preserved exactly as it ` +
        `was: (thread_id, round) identifies ONE consult, and recording it twice would double evidence that readers COUNT. If this is genuinely a different ` +
        `consult round, re-run with the round it actually was.`
    );
    console.log(JSON.stringify({ recorded: false, duplicate: true, entry_id: outcome.existing_entry_id, thread_id: outcome.thread_id, round: outcome.round }));
    process.exit(0);
  }
  console.log(JSON.stringify({ recorded: true, ...outcome.report }));
  process.exit(0);
}

/** ARGUMENT VALIDATION + ENTRY CONSTRUCTION. Every defect is its own refusal
 *  NAMING THE GAP, and nothing is read, locked or written until the whole
 *  invocation is well-formed — a missing required argument is REFUSED, never
 *  defaulted. Each default this refuses to take is separately corrosive: an
 *  inferred provider is a fabricated provenance claim; a generated thread-id
 *  destroys the (thread, round) idempotency key; a files default silently
 *  attributes territory nobody attested to, which is the exact mis-attribution
 *  research finding 289cd172 measured on the roster side. */
function buildExternalEntryFromArgv() {
  // --- TERRITORY: repeatable --file, at least one ---
  const fileArgs = flagAll('--file');
  if (fileArgs.length === 0) {
    fail(
      `review-ledger record-external: at least one --file <repo-relative path> is required — the files are the TERRITORY the consult covered, and an ` +
        `attestation naming no territory says nothing about any diff. It is refused, never defaulted to the staged paths: territory nobody attested to is ` +
        `mis-attributed evidence. Nothing written. ${USAGE_RECORD_EXTERNAL}`
    );
  }
  const files = [];
  for (const raw of fileArgs) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      fail(
        `review-ledger record-external: a --file argument has no value (${safeLabel(raw)}) — a flag with nothing after it is a malformed invocation, not a ` +
          `shorter territory. Nothing written. ${USAGE_RECORD_EXTERNAL}`
      );
    }
    if (/[\r\n]/.test(raw)) {
      fail(
        `review-ledger record-external: a --file path contains a newline (${safeLabel(raw)}) — refused, never flattened. Ledger values are read back into ` +
          `refusal messages and advisories, where an embedded second line reads as the mechanism's own output. Nothing written.`
      );
    }
    const p = normalizePath(raw.trim());
    if (!files.includes(p)) files.push(p); // repeated identical paths are one path, in argv order
  }

  // --- PROVIDER: required (who was consulted) ---
  const provider = requiredSingleLineFlag('--provider', 'the PROVIDER identifies WHO was consulted, and an attestation with no provider names no outside party at all');
  // --- THREAD-ID: required (which conversation) ---
  const threadId = requiredSingleLineFlag(
    '--thread-id',
    'the THREAD ID is half the idempotency key — generating one here would make every re-run of the same command look like a new consult'
  );

  // --- ROUND: required (which round within the thread) ---
  // §4 does not spell out that --round is mandatory, but idempotency KEYS on it:
  // with no round a repeat could only be judged per-thread, and §4 is explicit
  // that "one thread can hold several review rounds". So it is required, and an
  // unparseable value refuses rather than defaulting to 1.
  const roundRaw = flag('--round');
  if (!flagGiven('--round') || typeof roundRaw !== 'string' || roundRaw.trim() === '') {
    fail(
      `review-ledger record-external: --round <n> is required — one consult THREAD holds several review ROUNDS (decision 57984926 §4), so the round is what ` +
        `tells them apart and (thread_id, round) is the idempotency key. Nothing written. ${USAGE_RECORD_EXTERNAL}`
    );
  }
  const round = Number(roundRaw.trim());
  if (!Number.isInteger(round) || round < 0) {
    fail(
      `review-ledger record-external: --round ${safeLabel(roundRaw)} is not a non-negative integer — the round is a counter within the thread and is compared ` +
        `for equality when detecting a duplicate, so a value that is not a plain integer would make two spellings of the same round read as two consults. ` +
        `Nothing written.`
    );
  }

  // --- MODEL: OPTIONAL. Absent means null (see the header). ---
  let model = null;
  if (flagGiven('--model')) {
    const modelRaw = flag('--model');
    if (typeof modelRaw !== 'string' || modelRaw.trim() === '') {
      fail(
        `review-ledger record-external: --model was given with no usable value (${safeLabel(modelRaw)}) — OMIT the flag entirely to record an unknown model ` +
          `as null. An empty model string is neither a model nor an honest absence. Nothing written.`
      );
    }
    if (/[\r\n]/.test(modelRaw)) {
      fail(`review-ledger record-external: --model must be a SINGLE LINE (${safeLabel(modelRaw)}) — refused, never flattened. Nothing written.`);
    }
    model = modelRaw.trim();
  }

  // --- NOTE: OPTIONAL, single-line, bounded, sanitized like --reason. ---
  let note = null;
  if (flagGiven('--note')) {
    const noteRaw = flag('--note');
    if (typeof noteRaw !== 'string') {
      fail(
        `review-ledger record-external: --note was given with no value — a flag with nothing after it is a malformed invocation. Omit --note entirely to ` +
          `record no note. Nothing written. ${USAGE_RECORD_EXTERNAL}`
      );
    }
    if (/[\r\n]/.test(noteRaw)) {
      // THE REFUSAL DOES NOT ECHO THE NOTE. The note is exactly the
      // newline-bearing text this check exists to keep OUT of a message stream
      // (anti-pattern ee89c3fd): quoting it here would print the forged second
      // line as this mechanism's own output while explaining why it was refused.
      fail(
        `review-ledger record-external: --note must be a SINGLE LINE — the note given contains a newline (${noteRaw.length} characters, not echoed here). ` +
          `REFUSED, never silently flattened: the ledger is read back into refusal messages and advisories, and an embedded second line reads there as the ` +
          `mechanism's own output. Re-run with a one-line note. Nothing written.`
      );
    }
    if (noteRaw.length > NOTE_MAX) {
      fail(
        `review-ledger record-external: --note is ${noteRaw.length} characters, over the ${NOTE_MAX}-character bound. REFUSED, not truncated — half a ` +
          `recorded attestation is an attestation nobody made — and the oversize note is deliberately NOT echoed back here. Nothing written.`
      );
    }
    // EMPTY IS ABSENCE, RECORDED AS null. Never a half-built entry: the rest of
    // the entry is constructed exactly as it would be with a note.
    note = noteRaw.trim() === '' ? null : noteRaw.trim();
  }

  // §1's v2 envelope, in the EXTERNAL shape (§4). NO reviewer object and no
  // agent_type ANYWHERE — an agent_type is what roster eligibility matches on,
  // so carrying one is precisely how this entry would become spendable.
  return {
    entry: {
      schema_version: 2,
      entry_id: randomUUID(),
      kind: 'external_review',
      status: 'active',
      recorded_at: new Date().toISOString(),
      provider,
      model,
      thread_id: threadId,
      round,
      note,
      files,
      disposition: null,
    },
    thread_id: threadId,
    round,
  };
}

/** A required flag that must be present, non-empty and single-line. `why` is
 *  appended so each refusal explains what the missing argument was FOR rather
 *  than printing a generic usage error. */
function requiredSingleLineFlag(name, why) {
  const raw = flag(name);
  if (!flagGiven(name) || typeof raw !== 'string' || raw.trim() === '') {
    fail(`review-ledger record-external: ${name} is required — ${why}. It is refused, never inferred or defaulted. Nothing written. ${USAGE_RECORD_EXTERNAL}`);
  }
  if (/[\r\n]/.test(raw)) {
    fail(`review-ledger record-external: ${name} must be a SINGLE LINE (${safeLabel(raw)}) — refused, never flattened. Nothing written.`);
  }
  return raw.trim();
}

// ===========================================================================
// DIGEST (board 1d6d01bd) — see the dispatch note near the top of this file for
// what it is FOR. This is the whole implementation; it never returns.
//
// NO LOCK, DELIBERATELY. This is a pure read, and the ledger is replaced by
// rename (here, in commit-reviewed and in h22), so a reader either sees the old
// file or the new one — never a torn one. Taking the write lock to read would
// also invert the token's meaning: the number describes the bytes AT THE MOMENT
// OF THE READ, and the discharge that consumes it re-verifies it inside its own
// lock against the bytes on disk then. That re-verification is the guarantee;
// this is only how the caller obtains a number to be checked.
//
// THE THREE REFUSALS ARE NOT DEFENSIVE PADDING. A missing ledger, a directory or
// device where the ledger should be, and a file that is not a JSON array are
// each a state in which the printed digest would be a perfectly valid sha256 of
// something that is not a ledger — and the caller would carry it straight into a
// --digest argument, where it would either mismatch confusingly or (on the empty
// -file case) match a file no discharge should ever be run against. Refusing
// names the real problem at the point it is discoverable.
// ===========================================================================
function digestVerb() {
  const extra = argv.slice(1);
  if (extra.length > 0) {
    fail(
      `review-ledger digest: this verb takes NO arguments, but ${extra.length} were given (${extra.map((v) => JSON.stringify(v)).join(' ')}). It prints ONE ` +
        `thing — the sha256 of the exact current ledger bytes — and a caller substitutes that straight into 'discharge --digest', so an argument it does not ` +
        `understand is REFUSED rather than ignored: silently printing the whole-ledger digest anyway would answer a question you did not ask. ${USAGE_DIGEST}`
    );
  }
  const p = join(target, '.sterling', 'review-ledger.json');
  let st = null;
  try {
    st = statSync(p);
  } catch {
    st = null;
  }
  if (st === null) {
    fail(`review-ledger digest: no review ledger at ${p} — there is nothing to digest, and a digest of nothing is not a concurrency token for anything.`);
  }
  if (!st.isFile()) {
    fail(`review-ledger digest: ${p} is not a regular file (it is a directory or another special file), so its "exact bytes" are not defined. Refusing.`);
  }
  let bytes;
  try {
    bytes = readFileSync(p);
  } catch (e) {
    fail(`review-ledger digest: could not read ${p} (${e && e.message ? e.message : e}).`);
  }
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    parseError = e;
  }
  if (parseError !== null) {
    fail(
      `review-ledger digest: ${p} is not valid JSON (${parseError && parseError.message ? parseError.message : parseError}) — refusing to hand back a ` +
        `concurrency token for a file no ledger reader can parse. Every consumer of this token (discharge, and the surfaces it protects) would refuse on the ` +
        `same file, so the honest answer is here rather than one command later.`
    );
  }
  if (!Array.isArray(parsed)) {
    fail(`review-ledger digest: ${p} does not hold a JSON array (got ${typeof parsed}) — that is not a review ledger. Refusing.`);
  }
  // EXACTLY ONE LINE ON STDOUT, and nothing else on it: 64 lowercase hex plus a
  // newline. console.log would do the same today, but process.stdout.write states
  // the contract in the code — the newline is part of the output, and there is no
  // second thing to print.
  process.stdout.write(`${createHash('sha256').update(bytes).digest('hex')}\n`);
  process.exit(0);
}

/** The APPEND, run under the ledger lock: re-read the ledger, check the
 *  (thread_id, round) idempotency key against what is ACTUALLY on disk now, and
 *  append atomically. Read-check-write is one critical section for the same
 *  reason the discharge is: a duplicate check performed outside the lock could
 *  be raced by a concurrent record-external and both would append. */
function recordExternalUnderLock({ entry, thread_id: threadId, round }) {
  const sterlingDirLocal = join(target, '.sterling');
  const ledgerPathLocal = join(sterlingDirLocal, 'review-ledger.json');
  return withLedgerLock(sterlingDirLocal, () => {
    let entries = [];
    if (existsSync(ledgerPathLocal)) {
      let bytes;
      try {
        bytes = readFileSync(ledgerPathLocal, 'utf8');
      } catch (e) {
        refuse(`review-ledger record-external: could not read ${ledgerPathLocal} (${e && e.message ? e.message : e}). Nothing written.`);
      }
      try {
        entries = JSON.parse(bytes);
      } catch (e) {
        // NEVER degrade a malformed evidence file to empty and write over it —
        // that would DESTROY every receipt in it. commit-reviewed can degrade to
        // empty because it only READS; this appends.
        refuse(
          `review-ledger record-external: ${ledgerPathLocal} is not valid JSON (${e && e.message ? e.message : e}) — refusing to append to an evidence file ` +
            `this command cannot parse, because writing a fresh array over it would destroy every receipt it holds. Nothing written.`
        );
      }
      if (!Array.isArray(entries)) {
        refuse(`review-ledger record-external: ${ledgerPathLocal} does not hold a JSON array (got ${typeof entries}) — refusing to append. Nothing written.`);
      }
    }

    // IDEMPOTENCY KEY: (kind, thread_id, round). thread_id by strict string
    // equality; round compared BOTH strictly and by string form, so a ledger
    // holding `"round": "2"` (a hand-edit, or a future producer) still reads as
    // the same consult as `--round 2` rather than minting a second entry.
    const existing = entries.find(
      (e) =>
        e &&
        typeof e === 'object' &&
        e.kind === 'external_review' &&
        e.thread_id === threadId &&
        (e.round === round || String(e.round) === String(round))
    );
    if (existing) {
      return { duplicate: true, existing_entry_id: typeof existing.entry_id === 'string' ? existing.entry_id : null, thread_id: threadId, round };
    }

    // APPEND — every pre-existing entry is written back exactly as re-read, so
    // recording a consult never rewrites, reorders or drops review evidence.
    const next = [...entries, entry];
    const tmpPath = join(sterlingDirLocal, `review-ledger.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(next));
    renameSync(tmpPath, ledgerPathLocal);

    return {
      duplicate: false,
      report: {
        entry_id: entry.entry_id,
        kind: entry.kind,
        provider: entry.provider,
        model: entry.model,
        thread_id: entry.thread_id,
        round: entry.round,
        files: entry.files,
        note: entry.note,
        recorded_at: entry.recorded_at,
        spendable: false,
        ledger: ledgerPathLocal,
      },
    };
  });
}
