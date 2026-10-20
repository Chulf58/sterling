// pr-review-wait.mjs — the ONE bounded gh helper of the PR review loop, and
// the only thing in it that polls (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3; SOP
// skills/pr-review-loop/SKILL.md).
//
//   node scripts/pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo]
//        [--since-review <id>] [--head <sha>] [--timeout <s>] [--interval <s>]
//        [--request-copilot] [--recheck-delay <s>] [--target <dir>]
//   node scripts/pr-review-wait.mjs --resolve-threads <comment-id,...> --pr <n|pr-url> [--target <dir>]
//   node scripts/pr-review-wait.mjs --settle <clean|capped|escalated> --pr <n|pr-url> [--unknown-retry-delay <s>]
//        [--checks-timeout <s>] [--checks-interval <s>] [--target <dir>]
//
// WAIT: the repo is bound to origin exactly as work-mode /sterling:merge binds
// it (parseOriginRepo over origin's fetch URL); a PR URL or --repo naming any
// other repo is an error before any gh call. Every call is `gh api --hostname
// <host> repos/<owner>/<repo>/...` — `gh api` takes no --repo flag, so the repo
// is named in the path and the host explicitly, and gh's default-repo guessing
// never applies. Each poll fetches the PR head SHA, the PR's pending review
// requests (GraphQL reviewRequests), then the reviews and the review comments
// with --paginate. It returns as soon as a COPILOT review (author login
// matching /copilot/i) that is completed and newer than --since-review exists,
// on ANY head — the OLDEST such review first, so none is ever skipped (GitHub
// issue #80: a review of the previous head that lands after a push used to be
// dropped). stale_review is true when the returned review is not of the
// current head (or the PR head is not yet --head): its findings are
// dispositioned like any other, but it is never a clean review of the head.
// A current-head review is returned only when the head read AFTER fetching it
// is still the reviewed SHA; otherwise the next poll returns it as stale.
// With nothing unconsumed, it sleeps with backoff and polls again until
// --timeout — but only while a Copilot review request is pending: with no
// request pending and no unconsumed review, nothing will arrive, so the call
// ends with status no_review_requested (exit 3) naming the remedy, instead of
// timing out quietly. An absent request is read ONCE more after
// --recheck-delay seconds (default 10, within the --timeout budget) before
// that exit, on every call (Sol review): a request accepted by this call's
// --request-copilot, by the previous call or by hand seconds ago may not show
// in reviewRequests yet (the review_requested event was measured within 10s,
// finding request-copilot-review-programmatically-requestreviewsbylogin).
// Pending on the recheck means wait on; a review that landed meanwhile is
// returned. The requests are read BEFORE the reviews:
// GitHub clears the request when the review is submitted, so a request seen
// cleared means its review is already visible to the reviews read. One call
// never runs forever: the deadline is checked before every gh call and caps
// each call's own timeout. --head takes 7-40 hex characters and matches the
// PR head by prefix (a short sha is accepted; anything else is refused naming
// the value).
//
// --request-copilot (opt-in): before the first poll, ask GitHub to review the
// head again — a fix push is not re-reviewed until Copilot is re-requested, and
// the REST re-request returns an empty list. It reads the PR's node id (`gh api
// repos/<o>/<r>/pulls/<n> --jq .node_id`) and fires the GraphQL mutation
// requestReviewsByLogin once. Success or failure is recorded in the output as
// copilot_request {requested, error?}; a failure is also written to stderr and
// never aborts the wait.
//
// UNVERIFIED until the S0 first use on a work machine: the Copilot reviewer's
// login (a Bot matched by /copilot/i until pinned in pr_review.copilot_logins,
// reported verbatim as observed_copilot_login, identity_confirmed only when
// pinned), that review ids grow monotonically (the
// --since-review comparison), that a review's commit_id is the head it
// reviewed, and that a Copilot request stays in reviewRequests while Copilot
// is still reviewing (measured 2026-10-01, finding
// request-copilot-review-programmatically-requestreviewsbylogin: the request
// shows as Bot 'copilot-pull-request-reviewer' and is empty after a review).
// A pending request is any Bot reviewer whose login matches /copilot/i; the
// pinned copilot_logins are review-author logins and do not apply to it. The skill asks for the observed facts to be reported back so they
// can be pinned as fixtures.
//
// Stdout is ONE JSON object:
//   {status:'review'|'timeout'|'no_review_requested'|'error', head_sha,
//    review:{id, commit_id, author, state, body}|null,
//    comments:[{id, path, line, body, in_reply_to}],
//    previously_missed:[string], previously_missed_unparsed,
//    body_findings_without_comments,
//    copilot_request:null|{requested, error?}, copilot_review_pending,
//    observed_copilot_login, stale_review, awaiting_head_review,
//    identity_confirmed[, error]}
// previously_missed is the findings under a "Previously missed" (or "N
// previously missed issues") heading of the review body, as list items or as
// nested <details> blocks ([] when absent);
// previously_missed_unparsed is true when that section exists but the findings
// read do not match it (none, or not the N its heading declares), so the
// body must be read by hand. body_findings_without_comments is true for any
// non-blank body with no inline comments, because the body format is Copilot's
// and may change: such a review is not clean until the body has been read.
// copilot_review_pending is what the last poll read (null before any poll).
// awaiting_head_review is true when the returned review is stale AND a Copilot
// request is still pending: a review of the current head is still on its way
// (a hint only; GitHub issue #162, behaviour unchanged).
// Exit 0 = review, 2 = timeout, 3 = no_review_requested, 1 = error. None but
// a review of the current head (stale_review false) is ever clean.
//
// RESOLVE-THREADS: replying to a finding never resolves its review thread, and
// an org ruleset (required_review_thread_resolution) blocks the merge until it
// is resolved (GitHub issue #42). Given the review-comment ids the wait helper
// returned (comments[].id) for findings that are dispositioned, it resolves each
// one's thread through the GraphQL resolveReviewThread mutation. Every id is
// matched to a thread before any mutation; an unknown id or a gh failure exits
// 1 naming it. Exit 0 with {status:'resolved', pr_number, resolved, already_resolved,
// same_thread_as_resolved}.
//
// SETTLE: the deliberate conductor act that discharges H10's 'PR review loop
// owed' duty — writes the outcome on .sterling/transient/pr-loop.json when the
// armed loop is owed, coherent, in origin's repo, and the PR --pr names
// (number or full URL). Exit 0 with {status, pr_number, pr_url}; any refusal
// exits 1 and writes nothing. Settling 'clean' first asks GitHub for the PR's
// mergeStateStatus, reviewDecision and review threads: unresolved threads, or a
// merge state that is not CLEAN/HAS_HOOKS/UNSTABLE, refuse the clean outcome
// (status 'blocked', exit 1, the blockers and unresolved threads named, nothing
// written); a PR that only awaits a required human review settles clean and the
// output says so, but only while the head's check rollup is SUCCESS or absent
// (a failing or pending required check also shows as BLOCKED). An UNKNOWN merge
// state, which GitHub computes lazily, is read once more after
// --unknown-retry-delay seconds (default 3) and blocks if still UNKNOWN. A clean
// output carries merge_state_status, review_decision, check_rollup, mergeable_now
// and awaiting_human_review. A gh failure refuses too.
// A clean output also carries auto_merge_on_clean (config
// pr_review.auto_merge_on_clean, absent = on) and auto_merge, which is true only
// when the switch is on AND mergeable_now AND the head's check rollup is SUCCESS
// or absent: the skill's cue to squash-merge the PR, pinned to head_sha (the
// current, reviewed head) (decision work-mode-pr-auto-merge-when-copilot-loop-ends-clean).
// UNSTABLE is mergeable to GitHub even when a check that is not required fails
// (GitHub issue #131), so a FAILURE, PENDING or any other rollup withholds the
// merge. auto_merge_withheld names every reason auto_merge is false (null when
// it is true). The switch is
// read before anything is asked or written; a value that is not a boolean
// refuses the clean settle, so a typo never decides a merge.
// head_sha is the PR's CURRENT head (headRefOid), never the armed one (GitHub
// issue #154: a review-fix push moves the head after arming); armed_head_sha
// and reviewed_head_sha (the commit of Copilot's newest completed review) are
// printed beside it, and a head Copilot's last review did not cover refuses
// the clean settle (status 'blocked'). A MERGED PR settles clean at once with
// already_merged true and auto_merge false (GitHub issue #152); a CLOSED one is
// blocked. A PENDING or EXPECTED rollup with nothing else blocking is read
// again every --checks-interval seconds (default 30) for up to
// --checks-timeout seconds (default 540) until it finishes (decision
// pr-settle-clean-waits-for-pending-checks-then-decides-merge, GitHub issue
// #150); a timeout withholds the merge and says so (checks_timed_out).
// --checks-timeout is one absolute deadline over every read (the first one
// too), page, retry and sleep, and a late SUCCESS is timed out too; a first
// read that cannot finish by it refuses the settle; only --checks-timeout 0 is
// one unbounded read. The head and Copilot's
// newest review seen by the first read are pinned: either changing during the
// wait refuses the settle (status 'blocked'). A loop
// already settled clean may be settled clean again: that re-runs only the
// merge decision, writes nothing, prints resettle true, and is refused when
// the PR head is no longer the settled one (settled_head_sha).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveStoreRoot } from './lib/worktree-root.mjs';
import { autoMergeOnCleanOf, DeadlineReachedError, fetchSettledMergeState, mergeBlockers, parseOriginRepo, parsePrUrl, resolveReviewThreads, settlePrLoop } from './lib/work-pr.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = resolve(flag('--target') ?? process.cwd());
// .sterling/ is gitignored, so a linked worktree has none: the pinned logins and
// the armed PR-loop marker live in the main checkout, where /sterling:merge
// (direct-merge) put them. Git and gh still run in `target`.
const storeRoot = resolveStoreRoot(target);

const COPILOT_LOGIN = /copilot/i; // UNVERIFIED until S0 (see the header); used only while unpinned
const COMPLETED_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);
const COPILOT_REQUEST_LOGIN = 'copilot-pull-request-reviewer[bot]'; // the bot GraphQL names; the REST re-request returns an empty list
const GH_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_S = 540; // under a 10-minute background Bash window
const DEFAULT_INTERVAL_S = 30;
const MAX_INTERVAL_S = 120;
const DEFAULT_RECHECK_DELAY_S = 10; // the review_requested event showed within 10s (finding in the header)
const DEFAULT_CHECKS_TIMEOUT_S = 540; // the settle's PENDING-checks wait, under a 10-minute background shell window like the review wait
const DEFAULT_CHECKS_INTERVAL_S = 30;
const PENDING_ROLLUPS = new Set(['PENDING', 'EXPECTED']); // checks still running, or a required one not reported yet

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const result = { status: 'error', head_sha: null, review: null, comments: [], observed_copilot_login: null, stale_review: false, awaiting_head_review: false, identity_confirmed: false, previously_missed: [], previously_missed_unparsed: false, body_findings_without_comments: false, copilot_request: null, copilot_review_pending: null };
function finish(status, extra = {}) {
  const out = { ...result, status, ...extra };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(status === 'review' ? 0 : status === 'timeout' ? 2 : status === 'no_review_requested' ? 3 : 1);
}
const error = (message) => finish('error', { review: null, comments: [], error: message });

// ------------------------------------------------------------------ identity
// The Copilot reviewer is a GitHub App: user.type must be 'Bot' (a human or an
// unrelated account whose login merely contains "copilot" never counts). While
// .sterling/config.json pr_review.copilot_logins is empty (the default) any
// Bot login matching /copilot/i is accepted and identity_confirmed is false —
// the skill has the user confirm it before the first CLEAN, and the S0 first
// use pins the exact login there. Pinned, only an exact login matches. The
// config schema keeps pr_review permissive; this is the strict judge.
function readPinnedLogins() {
  const file = join(storeRoot, '.sterling', 'config.json');
  if (!existsSync(file)) return [];
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    error(`.sterling/config.json is not valid JSON (${e.message}) — the pinned Copilot login cannot be read`);
  }
  const block = cfg?.pr_review;
  if (block === undefined) return [];
  const logins = block?.copilot_logins;
  if (block === null || typeof block !== 'object' || Array.isArray(block) || (logins !== undefined && (!Array.isArray(logins) || !logins.every((l) => typeof l === 'string' && l.length > 0)))) {
    error(`config pr_review.copilot_logins must be a list of exact reviewer logins, got ${JSON.stringify(block)}`);
  }
  return logins ?? [];
}
const isCopilot = (r, pinned) =>
  typeof r?.user?.login === 'string' && r.user.type === 'Bot' && Number.isInteger(r.id) && (pinned.length ? pinned.includes(r.user.login) : COPILOT_LOGIN.test(r.user.login));

// ------------------------------------------------- resolve-threads and settle
// Both act on origin's repo only, before any wait argument is parsed.
function originRepoOrThrow() {
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  const originRepo = url.status === 0 ? parseOriginRepo(url.stdout)?.repo : null;
  if (!originRepo) throw new Error(`origin in ${target} is missing or not a GitHub repository URL — this mode is bound to origin`);
  return originRepo;
}
function refuse(label, e) {
  process.stderr.write(`pr-review-wait: ${label} — ${e.message}\n`);
  process.stdout.write(JSON.stringify({ status: 'error', error: e.message }) + '\n');
  process.exit(1);
}

if (argv.includes('--resolve-threads')) {
  try {
    const originRepo = originRepoOrThrow();
    const raw = flag('--resolve-threads') ?? '';
    const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length || !ids.every((x) => /^\d+$/.test(x))) throw new Error(`--resolve-threads needs a comma-separated list of review comment ids, got '${raw}'`);
    const prRef = flag('--pr') ?? '';
    const ref = /^\d+$/.test(prRef) ? { repo: originRepo, number: Number(prRef) } : parsePrUrl(prRef);
    if (!ref) throw new Error('--resolve-threads needs --pr <number|PR URL>');
    if (ref.repo !== originRepo) throw new Error(`the PR ${prRef} is not in origin's repo (${originRepo}) — the PR repo is bound to origin`);
    const out = resolveReviewThreads(target, originRepo, ref.number, ids.map(Number));
    process.stdout.write(JSON.stringify({ status: 'resolved', pr_number: ref.number, ...out }) + '\n');
    process.exit(0);
  } catch (e) {
    refuse('resolve-threads failed', e);
  }
}

// --unknown-retry-delay <s>: the wait before the one re-read of an UNKNOWN merge state.
function retryDelayMs() {
  const raw = flag('--unknown-retry-delay');
  if (raw === undefined) return 3000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--unknown-retry-delay must be a number of seconds >= 0, got '${raw}'`);
  return n * 1000;
}

// config pr_review.auto_merge_on_clean through its strict judge; an unreadable
// config throws instead of reading as either value.
function readAutoMergeOnClean() {
  const file = join(storeRoot, '.sterling', 'config.json');
  if (!existsSync(file)) return autoMergeOnCleanOf(undefined);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`.sterling/config.json is not valid JSON (${e.message}) — the auto-merge switch cannot be read; nothing settled`);
  }
  return autoMergeOnCleanOf(cfg);
}

// --checks-timeout <s> / --checks-interval <s>: how long a clean settle waits
// for a PENDING check rollup to finish, and how often it reads it meanwhile.
function checksWaitMs() {
  const read = (name, dflt, zeroOk) => {
    const raw = flag(name);
    if (raw === undefined) return dflt * 1000;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || (n === 0 && !zeroOk)) throw new Error(`${name} must be a number of seconds ${zeroOk ? '>= 0' : '> 0'}, got '${raw}'`);
    return n * 1000;
  };
  return { timeoutMs: read('--checks-timeout', DEFAULT_CHECKS_TIMEOUT_S, true), intervalMs: read('--checks-interval', DEFAULT_CHECKS_INTERVAL_S, false) };
}

// The newest completed Copilot review in fetchPrMergeState's reviews, or null.
// GraphQL names the bot without the REST '[bot]' suffix the pinned logins carry.
function lastCopilotReview(reviews, pinned) {
  const copilot = reviews.filter(
    (r) => r.bot && typeof r.login === 'string' && Number.isInteger(r.id) && COMPLETED_STATES.has(r.state) && (pinned.length ? pinned.includes(r.login) || pinned.includes(`${r.login}[bot]`) : COPILOT_LOGIN.test(r.login))
  );
  return copilot.length ? copilot.reduce((a, b) => (b.id > a.id ? b : a)) : null;
}

if (argv.includes('--settle')) {
  let merge = null;
  try {
    const originRepo = originRepoOrThrow();
    const outcome = flag('--settle');
    const autoMergeOnClean = outcome === 'clean' ? readAutoMergeOnClean() : null;
    const checksWait = outcome === 'clean' ? checksWaitMs() : null;
    const pinnedLogins = outcome === 'clean' ? readPinnedLogins() : [];
    // Only a clean outcome claims the PR is ready for a human, so only it asks GitHub.
    const guard = (armed, { resettle = false } = {}) => {
      const blocked = (message, extra) => {
        const err = new Error(message);
        err.blocked = { ...merge, ...extra };
        return err;
      };
      const started = Date.now();
      let state;
      let reviewedHead = null;
      let timedOut = false;
      // PENDING WAIT (decision pr-settle-clean-waits-for-pending-checks-then-decides-merge,
      // GitHub issue #150): while the head's checks are still running and
      // nothing else blocks, read the merge state again until they finish or
      // --checks-timeout runs out. ONE absolute deadline bounds every re-read
      // (each gh call, page and UNKNOWN retry) and every sleep, the FIRST read
      // included; only an explicit --checks-timeout 0 is one unbounded
      // snapshot. A read that ends after the deadline counts as timed out
      // whatever it says (Sol re-check); a first read that cannot finish by it
      // refuses the settle, since nothing is known. The head and Copilot's newest review seen by the first read are
      // pinned: a push or a new review during the wait is unreviewed by the
      // conductor, so it refuses the settle (Sol review).
      const bounded = checksWait.timeoutMs > 0;
      const deadline = started + checksWait.timeoutMs;
      let pinnedAt = null;
      for (;;) {
        const firstRead = pinnedAt === null;
        try {
          state = fetchSettledMergeState(target, originRepo, armed.pr_number, { retryDelayMs: retryDelayMs(), deadline: bounded ? deadline : null });
        } catch (e) {
          if (!(e instanceof DeadlineReachedError)) throw e;
          if (firstRead) {
            throw new Error(`GitHub's merge state could not be read within --checks-timeout (${checksWait.timeoutMs / 1000}s; an UNKNOWN state is re-read after --unknown-retry-delay inside it), so nothing is known about the PR — settle again, with a longer --checks-timeout if GitHub is slow; nothing settled`);
          }
          timedOut = true; // the last complete read (state) stands
          break;
        }
        if (state.merged || state.pr_state !== 'OPEN') break;
        // A merge-only re-settle is held to the head the clean settle vouched for.
        const settledHead = armed.settled_head_sha ?? armed.head_sha;
        if (resettle && state.head_sha !== settledHead) {
          throw new Error(`the PR head moved from ${settledHead} (settled clean) to ${state.head_sha}, so its new commits are unreviewed — a merge-only re-settle needs the unchanged head; rerun /sterling:merge to push and re-arm the loop; nothing settled`);
        }
        // GitHub issue #154: the head to merge is the PR's CURRENT head, and
        // only when Copilot's last completed review covered it.
        const last = lastCopilotReview(state.reviews, pinnedLogins);
        if (firstRead) pinnedAt = { head: state.head_sha, review: last?.id ?? null };
        else if (state.head_sha !== pinnedAt.head || (last?.id ?? null) !== pinnedAt.review) {
          throw blocked(
            state.head_sha !== pinnedAt.head
              ? `the PR head moved from ${pinnedAt.head} to ${state.head_sha} while the settle waited for the checks, so the loop's clean judgment does not cover it and the loop is NOT clean: wait for and disposition the review of the new head, then settle again; nothing settled`
              : `a new Copilot review (${last?.id ?? 'none'}, was ${pinnedAt.review}) arrived while the settle waited for the checks, so it is not dispositioned and the loop is NOT clean: disposition it, then settle again; nothing settled`,
            { head_sha: state.head_sha, settle_start_head_sha: pinnedAt.head, reviewed_head_sha: last?.commit ?? null, armed_head_sha: armed.head_sha }
          );
        }
        reviewedHead = last?.commit ?? null;
        if (reviewedHead !== state.head_sha) {
          throw blocked(
            `the PR head ${state.head_sha} is not the head Copilot last reviewed (${reviewedHead ?? 'no completed Copilot review on the PR'}), so its newest commits are unreviewed and the loop is NOT clean: run the wait with --request-copilot, disposition that review, then settle again; nothing settled`,
            { head_sha: state.head_sha, reviewed_head_sha: reviewedHead, armed_head_sha: armed.head_sha }
          );
        }
        if (bounded && Date.now() > deadline) {
          timedOut = true; // finished, but not within --checks-timeout
          break;
        }
        const pending = PENDING_ROLLUPS.has(state.check_rollup) && !state.check_rollup_error && state.threads.every((t) => t.resolved);
        if (!pending) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        process.stderr.write(`pr-review-wait: the head's check rollup is ${state.check_rollup}; waiting for the checks to finish (up to ${Math.ceil(remaining / 1000)}s more)\n`);
        sleep(Math.min(checksWait.intervalMs, remaining));
      }
      const checksWaitedS = Math.round((Date.now() - started) / 1000);
      // GitHub issue #152: a PR merged before the settle is clean with nothing
      // left to merge; GitHub keeps its merge state UNKNOWN for good.
      if (state.merged) {
        merge = { pr_state: state.pr_state, already_merged: true, merge_state_status: state.merge_state_status, review_decision: state.review_decision, check_rollup: state.check_rollup, mergeable_now: false, awaiting_human_review: false, auto_merge_on_clean: autoMergeOnClean, auto_merge: false, auto_merge_withheld: 'the PR is already merged: there is nothing left to merge', head_sha: state.head_sha, armed_head_sha: armed.head_sha, ...(resettle ? { resettle: true } : {}) };
        return { head_sha: state.head_sha };
      }
      if (state.pr_state !== 'OPEN') {
        merge = { pr_state: state.pr_state, already_merged: false, head_sha: state.head_sha, armed_head_sha: armed.head_sha };
        throw blocked(`the PR is ${state.pr_state}, not open and not merged, so the loop is NOT clean: reopen it and settle again, or settle escalated; nothing settled`, { blockers: [`the PR is ${state.pr_state}`], unresolved_threads: [] });
      }
      const verdict = mergeBlockers(state);
      // A clean settle may still carry a failing or pending check that is not
      // required (UNSTABLE); only a green or absent rollup lets it auto-merge.
      const rollup = state.check_rollup ?? null;
      const withheld = [];
      if (autoMergeOnClean !== true) withheld.push('the auto-merge switch pr_review.auto_merge_on_clean is off');
      if (verdict.awaiting_human_review) withheld.push('the PR awaits a required human review');
      else if (verdict.mergeable_now !== true) withheld.push('GitHub does not report the PR mergeable now');
      if (timedOut && PENDING_ROLLUPS.has(rollup)) withheld.push(`the head commit's check rollup is ${rollup}, still not SUCCESS after waiting ${checksWaitedS}s: once the checks finish, run --settle clean again on this unchanged head (it re-runs only the merge decision)`);
      else if (timedOut) withheld.push(`the head commit's check rollup reached ${rollup} only after --checks-timeout ran out (${checksWaitedS}s): run --settle clean again on this unchanged head (it re-runs only the merge decision)`);
      else if (rollup !== null && rollup !== 'SUCCESS') withheld.push(`the head commit's check rollup is ${rollup}, not SUCCESS: fix the failing check, push, and run the loop again`);
      merge = { pr_state: state.pr_state, already_merged: false, merge_state_status: state.merge_state_status, review_decision: state.review_decision, check_rollup: state.check_rollup, checks_waited_s: checksWaitedS, checks_timed_out: timedOut, mergeable_now: verdict.mergeable_now, awaiting_human_review: verdict.awaiting_human_review, auto_merge_on_clean: autoMergeOnClean, auto_merge: withheld.length === 0, auto_merge_withheld: withheld.length ? withheld.join('; ') : null, head_sha: state.head_sha, reviewed_head_sha: reviewedHead, armed_head_sha: armed.head_sha, ...(resettle ? { resettle: true } : {}) };
      if (verdict.blockers.length) {
        throw blocked(`GitHub still blocks the merge, so the loop is NOT clean: ${verdict.blockers.join('; ')} — resolve the threads (--resolve-threads) or fix the blocker, then settle again; nothing settled`, { blockers: verdict.blockers, unresolved_threads: verdict.unresolved_threads });
      }
      return { head_sha: state.head_sha };
    };
    const s = settlePrLoop(storeRoot, outcome, flag('--pr'), { originRepo, guard: outcome === 'clean' ? guard : null });
    process.stdout.write(JSON.stringify({ status: s.status, pr_number: s.pr_number, pr_url: s.pr_url, settled_at: s.settled_at, ...(merge ?? {}) }) + '\n');
    process.exit(0);
  } catch (e) {
    if (e.blocked) {
      process.stderr.write(`pr-review-wait: settle refused — ${e.message}\n`);
      process.stdout.write(JSON.stringify({ status: 'blocked', error: e.message, ...e.blocked }) + '\n');
      process.exit(1);
    }
    refuse('settle refused', e);
  }
}

// -------------------------------------------------------------------- args
const valued = new Set(['--repo', '--since-review', '--head', '--timeout', '--interval', '--recheck-delay', '--target']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
if (positional.length !== 1) error('usage: pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo] [--since-review <id>] [--head <sha>] [--timeout <s>] [--request-copilot]');
const seconds = (name, dflt) => {
  const raw = flag(name);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) error(`${name} must be a positive number of seconds, got '${raw}'`);
  return n;
};
const timeoutS = seconds('--timeout', DEFAULT_TIMEOUT_S);
let intervalS = seconds('--interval', DEFAULT_INTERVAL_S);
const sinceRaw = flag('--since-review');
if (sinceRaw !== undefined && !/^\d+$/.test(sinceRaw)) error(`--since-review must be a review id, got '${sinceRaw}'`);
const sinceReview = sinceRaw === undefined ? null : Number(sinceRaw);
const headRaw = flag('--head');
if (headRaw !== undefined && !/^[0-9a-f]{7,40}$/i.test(headRaw)) error(`--head must be 7-40 hex characters of a commit sha, got '${headRaw}'`);
const expectedHead = headRaw === undefined ? null : headRaw.toLowerCase();
const requestCopilot = argv.includes('--request-copilot');
const recheckRaw = flag('--recheck-delay');
const recheckDelayS = recheckRaw === undefined ? DEFAULT_RECHECK_DELAY_S : Number(recheckRaw);
if (recheckRaw !== undefined && (recheckRaw.trim() === '' || !Number.isFinite(recheckDelayS) || recheckDelayS < 0)) error(`--recheck-delay must be a number of seconds >= 0, got '${recheckRaw}'`);
const pinnedLogins = readPinnedLogins();
result.identity_confirmed = pinnedLogins.length > 0;

// ------------------------------------------------------ repo, bound to origin
const originUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
if (originUrl.status !== 0) error(`no 'origin' remote in ${target} — the PR repo is bound to origin and is never guessed`);
const origin = parseOriginRepo(originUrl.stdout);
if (!origin) error(`origin's URL '${originUrl.stdout.trim()}' is not a GitHub repository URL — the PR repo is bound to origin`);
const repoFlag = flag('--repo');
if (repoFlag !== undefined && repoFlag !== origin.repo) error(`--repo ${repoFlag} is not origin's repo (${origin.repo}) — the PR repo is bound to origin`);
let prNumber;
const pr = positional[0];
if (/^\d+$/.test(pr)) prNumber = Number(pr);
else {
  const parsed = parsePrUrl(pr);
  if (!parsed) error(`'${pr}' is neither a PR number nor a PR URL (https://host/owner/repo/pull/<n>)`);
  if (parsed.repo !== origin.repo) error(`the PR URL ${pr} is not in origin's repo (${origin.repo}) — the PR repo is bound to origin`);
  prNumber = parsed.number;
}
const deadline = Date.now() + timeoutS * 1000;
const [, owner, name] = origin.repo.split('/');
const base = `repos/${owner}/${name}/pulls/${prNumber}`;

// -------------------------------------------------------------------- gh
// THE DEADLINE BOUNDS THE WHOLE CALL (Sol review): it is checked before every
// gh call, and each call's own timeout is capped to the budget left, so a
// hanging gh ends the call at --timeout instead of after another full poll.
class DeadlineReached extends Error {}
function ghApi(path, { paginate = false, extra = [] } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeadlineReached();
  const args = ['api', '--hostname', origin.host, ...(paginate ? ['--paginate'] : []), ...extra, path];
  const r = spawnSync('gh', args, { cwd: target, encoding: 'utf8', timeout: Math.min(GH_CALL_TIMEOUT_MS, remaining), env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.error?.code === 'ETIMEDOUT' && Date.now() >= deadline) throw new DeadlineReached();
  if (r.error || r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

/** The "Previously missed" findings of a review body, under a heading
 * (markdown heading, bold line or <summary>) that starts with that phrase, up
 * to the next markdown heading or the </details> that closes the section. Two
 * finding shapes are read: list items (a line indented under an item
 * continues it), and nested <details> blocks, one per finding, as Copilot's
 * ccr-overview-v2 body writes them (GitHub issue #102): the block's <summary>
 * is the title, a line that is only a backticked `path:line` is the location,
 * and the remaining lines are the text, joined as "title (path:line): text".
 * The heading also matches with the count first, when its label (the
 * <strong> text, else the text before a <br>, else the whole heading) is
 * exactly "N previously missed issue(s)", as Copilot writes it (GitHub issues
 * #124-#127, #130); a <summary> that spans lines is read as one line.
 * `unparsed` is true when a section was found but the findings read do not
 * match it: none read, fewer or more than the N its heading declares ("(N)"
 * after the phrase, or N before it), or a nested block that is empty or never
 * closed (an empty block is not counted as a finding).
 * { items: [], unparsed: false } when the section is absent. */
function parsePreviouslyMissed(body) {
  const items = [];
  let found = false;
  let declared = null;
  let depth = 0; // <details> nesting relative to the body, counted inside the section
  let base = 0; // the depth of the section itself: 1 when it is a <details> block
  let nested = null; // the finding block being read: { title, loc, text[] }
  let malformed = false; // a nested block was empty or never closed
  const finishNested = () => {
    const title = nested.title ?? '';
    const text = nested.text.join(' ');
    const finding = `${title}${nested.loc ? `${title ? ' ' : ''}(${nested.loc})` : ''}${text ? `${title || nested.loc ? ': ' : ''}${text}` : ''}`;
    if (finding) items.push(finding);
    else malformed = true;
    nested = null;
  };
  // The label of a count-first heading: the <strong> text, else the text before
  // a <br>, else the whole line, without tags or markdown emphasis.
  const labelOf = (line) => {
    const strong = line.match(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i);
    return (strong ? strong[1] : line.split(/<br\s*\/?>/i)[0]).replace(/<[^>]*>/g, '').replace(/^[\s#*_]+|[\s#*_]+$/g, '');
  };
  const stripTags = (s) => s.replace(/<[^>]*>/g, '').trim();
  const text = String(body ?? '').replace(/<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi, (m) => m.replace(/\s*\r?\n\s*/g, ' '));
  for (const line of text.split(/\r?\n/)) {
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
    if (!found) {
      const plain = line.replace(/<[^>]*>/g, '').replace(/^[\s#*_]+/, '');
      const countFirst = labelOf(line).match(/^(\d+)\s+previously missed issues?$/i);
      if ((countFirst || /^previously missed/i.test(plain)) && (isHeading || /^\s*(\*\*|__|<summary|<details)/i.test(line))) {
        found = true;
        const count = countFirst ?? plain.match(/^previously missed\s*\((\d+)\)/i);
        declared = count ? Number(count[1]) : null;
        base = /<summary|<details/i.test(line) ? 1 : 0;
        depth = base;
      }
      continue;
    }
    if (isHeading && !nested) break;
    let ended = false;
    let rest = '';
    for (const part of line.split(/(<details\b[^>]*>|<\/details\s*>|<summary\b[^>]*>[\s\S]*?<\/summary\s*>)/i)) {
      if (/^<details\b/i.test(part)) {
        depth++;
        if (!nested && depth === base + 1) nested = { title: null, loc: null, text: [] };
      } else if (/^<\/details/i.test(part)) {
        if (nested && depth === base + 1) {
          if (rest.trim()) nested.text.push(rest.trim());
          rest = '';
          finishNested();
        }
        depth--;
        if (depth < base || depth < 0) {
          ended = true;
          break;
        }
      } else if (/^<summary\b/i.test(part)) {
        if (nested && nested.title === null) nested.title = stripTags(part);
      } else rest += part;
    }
    if (ended) break;
    if (nested) {
      const t = stripTags(rest);
      const loc = t.match(/^`([^`\s]+:\d+(?:-\d+)?)`$/);
      if (loc && nested.loc === null) nested.loc = loc[1];
      else if (t) nested.text.push(t);
      continue;
    }
    const item = rest.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (item) items.push(item[1]);
    else if (items.length && /^\s+\S/.test(rest)) items[items.length - 1] += ` ${rest.trim()}`;
  }
  if (nested) {
    malformed = true; // never closed: what was read is kept, but the section is not trusted
    finishNested();
  }
  const unparsed = found && (malformed || (declared === null ? items.length === 0 : declared !== items.length));
  return { items, unparsed };
}

/** --request-copilot: one GraphQL mutation, never aborting the wait. */
function requestCopilotReview() {
  try {
    const nodeId = ghApi(base, { extra: ['--jq', '.node_id'] }).trim();
    if (!/^[A-Za-z0-9_=-]+$/.test(nodeId) || nodeId === 'null') throw new Error(`gh api ${base} returned no usable node_id (got '${nodeId}')`);
    const query = `mutation { requestReviewsByLogin(input:{pullRequestId:"${nodeId}", botLogins:["${COPILOT_REQUEST_LOGIN}"], union:true}) { pullRequest { id } } }`;
    const reply = JSON.parse(ghApi('graphql', { extra: ['-f', `query=${query}`] }));
    if (Array.isArray(reply?.errors) && reply.errors.length) throw new Error(`requestReviewsByLogin returned errors: ${reply.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ')}`);
    result.copilot_request = { requested: true };
  } catch (e) {
    const message = e instanceof DeadlineReached ? 'the --timeout budget ran out before the request completed' : e.message;
    result.copilot_request = { requested: false, error: `requestReviewsByLogin failed: ${message}` };
    process.stderr.write(`pr-review-wait: --request-copilot failed — ${message}\n`);
  }
}

/** gh prints each page of an array endpoint back to back (`[..][..]`) under
 * --paginate; this splits the top-level JSON values and flattens the arrays. */
function parsePages(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (depth !== 0 || inString) throw new Error('gh returned truncated JSON');
  return values.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

/** Is a Copilot review request pending on the PR? GraphQL reviewRequests is
 * the view that names the Copilot bot (finding
 * request-copilot-review-programmatically-requestreviewsbylogin). */
const REVIEW_REQUESTS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewRequests(first:100){nodes{requestedReviewer{__typename ... on Bot{login} ... on User{login}}}}}}}';
function copilotReviewPending() {
  const reply = JSON.parse(ghApi('graphql', { extra: ['-f', `query=${REVIEW_REQUESTS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`] }));
  if (Array.isArray(reply?.errors) && reply.errors.length) throw new Error(`reviewRequests query returned errors: ${reply.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ')}`);
  const nodes = reply?.data?.repository?.pullRequest?.reviewRequests?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`reviewRequests query returned no pull request #${prNumber} in ${origin.repo}`);
  return nodes.some((n) => n?.requestedReviewer?.__typename === 'Bot' && COPILOT_LOGIN.test(n.requestedReviewer.login ?? ''));
}

class NoReviewRequested extends Error {}
function poll(recheckAbsent = true) {
  const [pull] = parsePages(ghApi(base));
  const head = pull?.head?.sha;
  if (typeof head !== 'string') throw new Error(`gh api ${base} returned no head.sha`);
  result.head_sha = head;
  // Requests BEFORE reviews: a request cleared by a submitted review means the
  // review is already there for the reviews read below.
  const pending = copilotReviewPending();
  result.copilot_review_pending = pending;
  const reviews = parsePages(ghApi(`${base}/reviews`, { paginate: true }));
  const copilot = reviews.filter((r) => isCopilot(r, pinnedLogins));
  if (copilot.length) result.observed_copilot_login = copilot.reduce((a, b) => (b.id > a.id ? b : a)).user.login;
  const fresh = copilot.filter((r) => COMPLETED_STATES.has(r.state) && (sinceReview === null || r.id > sinceReview));
  if (!fresh.length) {
    if (pending) return null;
    if (!recheckAbsent) throw new NoReviewRequested();
    // One bounded recheck before the loud exit: a request accepted seconds ago
    // may not show yet. The deadline still bounds it (the next gh call throws
    // DeadlineReached once the budget is spent).
    sleep(Math.max(0, Math.min(recheckDelayS * 1000, deadline - Date.now())));
    return poll(false);
  }
  // The LOWEST fresh id first, on ANY head (Sol review, HIGH; GitHub issue
  // #80): a later review never hides an earlier one's findings, and a review
  // of an older head is returned, never dropped. The skill advances
  // --since-review only after each returned review is fully dispositioned, so
  // the next call yields the next.
  const review = fresh.reduce((a, b) => (b.id < a.id ? b : a));
  const headExpected = expectedHead === null || head.toLowerCase().startsWith(expectedHead);
  const stale = !(headExpected && review.commit_id === head);
  const comments = parsePages(ghApi(`${base}/comments`, { paginate: true }))
    .filter((c) => c?.pull_request_review_id === review.id)
    .map((c) => ({ id: c.id, path: c.path ?? null, line: c.line ?? c.original_line ?? null, body: c.body ?? '', in_reply_to: c.in_reply_to_id ?? null }));
  if (!stale) {
    // HEAD RACE (Sol review): a push between the first head read and here
    // would make this a review of a superseded head. Re-read the head; return
    // it as current only if both reads equal the reviewed SHA (and --head,
    // checked above), otherwise poll again: the next poll returns it stale.
    const [again] = parsePages(ghApi(base));
    if (again?.head?.sha !== head) {
      result.head_sha = typeof again?.head?.sha === 'string' ? again.head.sha : head;
      return null;
    }
  }
  const body = review.body ?? '';
  const missed = parsePreviouslyMissed(body);
  return {
    review: { id: review.id, commit_id: review.commit_id, author: review.user.login, state: review.state, body },
    comments,
    stale_review: stale,
    awaiting_head_review: stale && pending,
    previously_missed: missed.items,
    previously_missed_unparsed: missed.unparsed,
    body_findings_without_comments: body.trim() !== '' && comments.length === 0,
  };
}

if (requestCopilot) requestCopilotReview();

for (;;) {
  let found;
  try {
    found = poll();
  } catch (e) {
    if (e instanceof DeadlineReached) finish('timeout', { review: null, comments: [] });
    if (e instanceof NoReviewRequested) {
      const message = `no Copilot review is requested on PR #${prNumber} and no unconsumed Copilot review exists${sinceReview === null ? '' : ` after --since-review ${sinceReview}`}, so nothing will arrive: run the wait again with --request-copilot (always after a push)`;
      process.stderr.write(`pr-review-wait: ${message}\n`);
      finish('no_review_requested', { review: null, comments: [], error: message });
    }
    error(e.message);
  }
  if (found) finish('review', found);
  const remaining = deadline - Date.now();
  if (remaining <= 0) finish('timeout', { review: null, comments: [] });
  sleep(Math.min(intervalS * 1000, remaining));
  intervalS = Math.min(intervalS * 1.5, MAX_INTERVAL_S);
}
