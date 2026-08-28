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
//     every entry NOT identity-matched (agent_type + at) to the set just
//     stamped, so a receipt promoted mid-commit survives — P4: the artifact
//     that uses the evidence removes exactly that evidence, nothing more.
//     This read-modify-write is lock-guarded (withLedgerLock below) against
//     a concurrent H22 promotion write.
//   - SPEND ADVISORIES (board 09e03d76, warning-only — see the block above
//     the trailer lines): before committing, three anomalies in WHAT is being
//     spent are named on stderr and echoed in the reported summary's
//     `spend_warnings` — more than 3 receipts stamped on one commit, a
//     receipt whose recorded `files` do not overlap the staged diff, a
//     receipt recording no files at all, and a receipt older than a 12h
//     horizon. None of them rejects an entry, refuses, or changes the
//     no-dedupe rule: the `files` attribution is known-unreliable, so a gate
//     keyed on it would discard real reviews. The whole block is FAIL-OPEN
//     (guarded interpolation + a try/catch that degrades to one stderr note),
//     because a warning-only check that can abort a commit inverts its own
//     ruling.
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
import { arg, fail } from './lib/project.mjs';

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
  if (e && typeof e.agent_type === 'string' && VALID_AGENT_TYPE.test(e.agent_type)) {
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

  for (const e of stampEntries) {
    const recordedAt = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
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
        `commit-reviewed: STALE RECEIPT — ${e.agent_type}'s receipt is ${ageHours.toFixed(1)}h old (recorded ${safeLabel(e.at)}; advisory horizon ` +
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

const trailerLines = stampEntries.map((e) => `Reviewed-By-Agent: ${e.agent_type}`);
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

// CONSUME the stamped entries: the commit that used the evidence removes it
// (P4). RE-READ rather than reuse `ledger` — `git commit` runs hooks inline
// and can take seconds, during which a reviewer's SubagentStop may have
// promoted a fresh entry into the ledger; that entry must survive. Only
// entries identity-matched (agent_type + at + the partition fields
// session_id/branch/base_sha) to what was just stamped are removed.
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
    const identityField = (e, k) => (e[k] === undefined ? null : e[k]);
    const sameIdentity = (fresh, stamped) =>
      typeof fresh.agent_type === 'string' &&
      fresh.agent_type === stamped.agent_type &&
      boundedDeepEqual(fresh.at, stamped.at, IDENTITY_DEPTH_CAP) &&
      ['session_id', 'branch', 'base_sha', 'files'].every((k) =>
        boundedDeepEqual(identityField(fresh, k), identityField(stamped, k), IDENTITY_DEPTH_CAP)
      );
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
      const i = unclaimedStamped.findIndex((s) => sameIdentity(e, s));
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
  const validEntries = [];
  for (const e of ledger) {
    if (e && typeof e.agent_type === 'string' && VALID_AGENT_TYPE.test(e.agent_type)) {
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

  const trailerLines = stampEntries.map((e) => `Reviewed-By-Agent: ${e.agent_type}`);
  const interpretArgs = ['interpret-trailers'];
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
    })
  );
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
  const sameIdentity = (fresh, stamped) =>
    typeof fresh.agent_type === 'string' &&
    fresh.agent_type === stamped.agent_type &&
    boundedDeepEqual(fresh.at, stamped.at, IDENTITY_DEPTH_CAP) &&
    ['session_id', 'branch', 'base_sha', 'files'].every((k) =>
      boundedDeepEqual(identityField(fresh, k), identityField(stamped, k), IDENTITY_DEPTH_CAP)
    );

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
      const i = unclaimedStamped.findIndex((s) => sameIdentity(e, s));
      if (i === -1) return true;
      unclaimedStamped.splice(i, 1);
      return false;
    });
    const tmpPath = join(sterlingDir, `review-ledger.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(survivors));
    renameSync(tmpPath, ledgerFilePath);
  });
}
