// scripts/review-ledger.mjs — CONDUCTOR-run CLI for the review ledger's
// explicit LIFECYCLE verbs (decision 57984926, slug review-ledger-v2-lifecycle-
// refuse-flip-and-external-review-design, §3 "FALLBACK NARROWING + DISCHARGE";
// campaign slice S2b-3).
//
//   node scripts/review-ledger.mjs discharge \
//     --entry-id <uuid> \
//     --digest   <sha256 hex of the EXACT current ledger bytes> \
//     --class    <foreign-session|foreign-branch|no-live-territory> \
//     --reason   "<single-line reason>"
//
//   exit 0 = discharged (a one-line JSON report on stdout)
//   exit 1 = refused (the reason on stderr; NOTHING written, ever)
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
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// ONE compatibility adapter for both ledger shapes (decision 57984926, slice
// S2b-1). A v1 entry passes through byte-identical; a v2 entry's nested
// reviewer/identity/territory/content_evidence are surfaced under the flat
// names every other reader already uses. This CLI selects and WRITES against
// the RAW entry (so the on-disk shape is never rewritten by a read convention)
// and READS its fields through the adapter.
import { normalizeLedgerEntry } from './hooks/lib/review-ledger-entry.mjs';

const target = process.cwd();
const argv = process.argv.slice(2);

// THE VERSION OF THE CLASSIFICATION RULES THAT PRODUCED A VERDICT (§3's
// disposition.classifier_version). Recorded on every discharge so a later
// reader knows which rules were in force — the no-live comparison in
// particular is expected to get sharper (worktree/index views, rename
// following), and a disposition written under rev 1 must not read as though it
// had been decided under rev 2.
const CLASSIFIER_VERSION = 1;

// §3's three recognized unspendable classes, kebab-cased. CLOSED SET: an
// unrecognized class is REFUSED (P5 — unknown signals halt), because a verb
// that accepts any class string is a delete-anything-I-do-not-want-to-see verb
// wearing a flag.
const RECOGNIZED_CLASSES = ['foreign-session', 'foreign-branch', 'no-live-territory'];

const REASON_MAX = 500; // same bound as commit-reviewed's --waive-bytes reason (decision 57984926 §2)

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

const USAGE =
  "usage: node scripts/review-ledger.mjs discharge --entry-id <uuid> --digest <sha256-hex-of-the-exact-current-ledger-bytes> " +
  `--class <${RECOGNIZED_CLASSES.join('|')}> --reason "<single-line reason>"`;

// ===========================================================================
// VERB. 'discharge' is the only one. An unknown verb REFUSES rather than
// falling through to a default, and the message says so explicitly for the
// resurrection family — a conductor reaching for `restore` must learn that the
// absence is deliberate, not a missing feature.
// ===========================================================================
const verb = argv[0];
if (verb === undefined || verb.startsWith('-')) {
  fail(`review-ledger: missing subcommand. ${USAGE}`);
}
if (verb !== 'discharge') {
  fail(
    `review-ledger: unknown subcommand '${verb}' — the only verb is 'discharge'. There is NO undischarge/restore/reactivate/resurrect verb, and its ` +
      `absence is deliberate (decision 57984926 §3): a discharged receipt can never be returned to active, because a state that round-trips is worthless ` +
      `as a record. Correct a mistaken discharge by RE-DISPATCHING A REVIEWER for the work it covered. ${USAGE}`
  );
}

// Not a Sterling project root: refuse before anything else, same posture as
// commit-reviewed.mjs (no ledger, no meaningful contract to enforce).
if (!existsSync(join(target, '.sterling'))) {
  fail('review-ledger: not a Sterling project root — no .sterling/ directory under the current working directory. Nothing written.');
}

// ===========================================================================
// ARGUMENT VALIDATION — every defect is its own refusal with its own wording,
// so a caller can never be told the wrong thing about which argument was
// wrong. Nothing is read, locked or written until all four are well-formed.
// ===========================================================================
const entryIdRaw = flag('--entry-id');
if (!flagGiven('--entry-id') || typeof entryIdRaw !== 'string' || entryIdRaw.trim() === '') {
  fail(`review-ledger discharge: --entry-id <uuid> is required — it is the SELECTOR, and a discharge with no entry selected has no target. ${USAGE}`);
}
const entryId = entryIdRaw.trim();

const classRaw = flag('--class');
if (!flagGiven('--class') || typeof classRaw !== 'string' || classRaw.trim() === '') {
  fail(`review-ledger discharge: --class is required and must be one of ${RECOGNIZED_CLASSES.join(', ')}. ${USAGE}`);
}
const dischargeClass = classRaw.trim();
if (!RECOGNIZED_CLASSES.includes(dischargeClass)) {
  fail(
    `review-ledger discharge: UNRECOGNIZED class ${JSON.stringify(dischargeClass)} — the recognized unspendable classes are ${RECOGNIZED_CLASSES.join(', ')} ` +
      `(decision 57984926 §3). An arbitrary class string is refused, never recorded: a discharge is only legitimate for a receipt that CANNOT be spent, and ` +
      `accepting any class at all would turn this verb into "delete anything I do not want to see". Nothing written.`
  );
}

// A discharge with no reason is not an accountability record at all — it is the
// silent auto-discharge §3 explicitly rejected, wearing a flag. PRESENCE is
// checked separately from emptiness so `--reason ""` refuses for the right
// cause rather than reading as "no reason requested".
const reasonRaw = flag('--reason');
if (!flagGiven('--reason') || reasonRaw === undefined) {
  fail(
    `review-ledger discharge: --reason "<text>" is required — the reason IS the accountability this verb exists for (decision 57984926 §3 chose explicit ` +
      `discharge over silent auto-discharge precisely so a human decision is on the record). Nothing written. ${USAGE}`
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
      `you read before deciding. Without it this verb would overwrite a receipt promoted since. Nothing written. ${USAGE}`
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

const normalizePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

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
const LOCK_STALE_MS = 10_000; // SHARED CONVENTION with commit-reviewed.mjs / h22 — do not diverge

/** The lock this process currently holds, or null. Module-level because gitRun
 *  (which refreshes the mtime) is called from the classifier, several frames
 *  below withLedgerLock, and threading a handle through every verifier would put
 *  the liveness guarantee at the mercy of whoever adds the next git call. */
let heldLock = null;

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
      'review-ledger discharge: the review-ledger lock is held by another process and did not clear — REFUSING rather than writing unlocked, because a ' +
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
      `review-ledger discharge: acquired the ledger lock but could not write its owner token (${e && e.message ? e.message : e}) — REFUSING rather than ` +
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

  // SELECTOR: exact entry_id equality on the RAW entry. No prefix matching and
  // no "the only entry" / "the first entry" fallback — a forgiving selector on
  // a state-changing operation is the shape anti-pattern
  // no-bounded-trail-guard-for-destructive-addressing forbids, and here it
  // would discharge a bystander as a consolation prize.
  const matches = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && typeof e === 'object' && typeof e.entry_id === 'string' && e.entry_id === entryId) matches.push(i);
  }
  if (matches.length === 0) {
    refuse(
      `review-ledger discharge: NO LEDGER ENTRY has entry_id ${JSON.stringify(entryId)} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} ` +
        `checked, none match. Nothing is discharged in its place and nothing is written: an unknown selector is a refusal, never a substitute target.`
    );
  }
  if (matches.length > 1) {
    refuse(
      `review-ledger discharge: ${matches.length} ledger entries share entry_id ${JSON.stringify(entryId)} — the selector is AMBIGUOUS, so no entry is ` +
        `discharged. Nothing written; repair the duplicate ids first.`
    );
  }
  const index = matches[0];
  const rawEntry = entries[index];

  // v2 ONLY. §3 names "entry_id (v2) or a generated legacy handle"; the legacy
  // handle is unspecified and unbuilt, so a v1 entry is REFUSED here rather
  // than given an invented lifecycle. That refusal is also the honest one for
  // no-live-territory, whose first precondition is "v2 roster receipt".
  if (rawEntry.schema_version !== 2) {
    refuse(
      `review-ledger discharge: entry ${JSON.stringify(entryId)} is not a schema_version 2 ledger entry (schema_version=${safeLabel(rawEntry.schema_version)}) ` +
        `— it is a LEGACY v1 receipt, which carries no lifecycle fields and no territory.source at all. The v2 entry_id selector does not address it, and ` +
        `§3's generated legacy handle is not implemented, so there is nothing to discharge safely here. Nothing written.`
    );
  }
  const norm = normalizeLedgerEntry(rawEntry);
  if (norm.v2_deficient) {
    refuse(
      `review-ledger discharge: entry ${JSON.stringify(entryId)} claims schema_version 2 but is STRUCTURALLY DEFICIENT (missing entry_id/started_at/identity) ` +
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
  if (rawEntry.status === 'discharged') {
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
  if (rawEntry.status !== undefined && rawEntry.status !== 'active') {
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
        : verifyForeignBranch(norm);
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
  const dischargedEntry = {
    ...rawEntry,
    status: 'discharged',
    disposition: {
      reason,
      at: new Date().toISOString(),
      head_sha: headSha,
      classifier_version: CLASSIFIER_VERSION,
      class: dischargeClass,
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

  return {
    discharged: true,
    entry_id: entryId,
    agent_type: typeof norm.agent_type === 'string' ? norm.agent_type : null,
    class: dischargeClass,
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
