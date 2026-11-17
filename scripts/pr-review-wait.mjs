// pr-review-wait.mjs — the ONE bounded gh helper of the PR review loop, and
// the only thing in it that polls (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3; SOP
// skills/pr-review-loop/SKILL.md).
//
//   node scripts/pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo]
//        [--since-review <id>] [--head <sha>] [--timeout <s>] [--interval <s>]
//        [--request-copilot] [--recheck-delay <s>] [--target <dir>]
//   node scripts/pr-review-wait.mjs --resolve-threads <comment-id,...> --pr <n|pr-url> [--target <dir>]
//   node scripts/pr-review-wait.mjs --settle <clean|capped|escalated|closed> --pr <n|pr-url> [--unknown-retry-delay <s>]
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
// ends the call at once with status error (exit 1): the request is not on the
// PR, so no review would arrive.
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
//    identity_confirmed, next_since_review[, error]}
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
// (a hint only; GitHub issue #162).
// HOLD FOR THE HEAD (GitHub issues #300, #296, #224; user-ruled 2026-11-17
// "Hold for head review"): WITH --head, only a review whose commit_id is the
// expected head (and the PR head is that head) is returned as the review. An
// unconsumed review of any other head is consumed-as-stale: it is listed in
// stale_reviews ({id, commit_id, author, state, body, comments}; comments are
// read when the head's review is returned, otherwise only the ids and bodies
// show) and the wait goes on for the head's review until --timeout, or until
// no request is pending (no_review_requested), as without it. The stale
// reviews are never skipped: the next --since-review is next_since_review,
// the highest id such that every unconsumed review up to it was returned (in
// review or stale_reviews), never simply the highest id returned: a late stale
// review can have a higher id than a head review not yet returned. A stale
// review above the watermark is listed again on the next call. WITHOUT --head nothing changes (the #80 behaviour:
// the oldest unconsumed review returns at once, stale_review true if not the
// head).
// A failed --request-copilot ends the call at once with status error (exit 1),
// the error naming the failure, and copilot_request {requested:false, error}.
// Exit 0 = review, 2 = timeout, 3 = no_review_requested, 4 = rate_limited,
// 1 = error. None but a review of the current head (stale_review false) is
// ever clean.
// RATE LIMIT (GitHub issue #294): when a poll's gh call fails with GitHub's
// rate-limit message, the helper reads `gh api rate_limit` once (only after
// such a failure, never per poll), sleeps until the core budget resets and
// polls again. If the reset falls after the --timeout deadline it ends at once
// with status rate_limited (exit 4), rate_limit_reset (ISO time) and error
// naming the reset; it never claims a review, and it is not a timeout.
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
// pr_review.auto_merge_on_clean, absent = on) and merge_authorized (auto_merge
// is the same boolean, kept for compatibility). It means the merge is
// AUTHORIZED, never that it happened: this script never merges. It is the
// skill's cue to squash-merge the PR, pinned to head_sha (the current,
// reviewed head) (decision work-mode-pr-auto-merge-when-copilot-loop-ends-clean),
// and it is true only when the switch is on AND mergeable_now AND the head's
// check rollup is SUCCESS AND the MERGE EVIDENCE (see mergeEvidence) holds:
// every required check of the base branch (rulesets and classic branch
// protection) is reported on the head and passed (success, skipped or
// neutral, as GitHub branch protection counts it), the head's newest workflow
// run per workflow and event is completed and succeeded (or was skipped or
// neutral), and
// the branch is not behind its base. A required check not reported or not
// finished yet, or a workflow run still running, is waited for inside the
// --checks-timeout wait below; it withholds only when that wait runs out
// (user-ruled 2026-11-17, "Match GitHub, and wait") (decision
// pr-auto-merge-requires-github-required-checks-as-the-expecte; GitHub issues
// #248, #273, #275). Required checks that are not configured or not readable
// withhold the merge. A null rollup (no checks on the head) withholds too
// (#273). UNSTABLE is mergeable to GitHub even when a check that is not
// required fails (GitHub issue #131), so a FAILURE, PENDING or any other rollup
// withholds the merge. withheld_reasons lists every reason ([] when
// authorized), auto_merge_withheld joins them (null when authorized), and
// merge_evidence carries what was read (null when the settle is blocked). What
// it does NOT guarantee: it trusts GitHub's published state at the time of the
// read; a check that is not required and not run by a workflow is not judged,
// and the head or base can move between this read and the merge. The switch is
// read before anything is asked or written; a value that is not a boolean
// refuses the clean settle, so a typo never decides a merge. A clean settle
// also writes one line to stderr: "authorized to merge <sha>" or "merge
// withheld: <reasons>".
// head_sha is the PR's CURRENT head (headRefOid), never the armed one (GitHub
// issue #154: a review-fix push moves the head after arming); armed_head_sha
// and reviewed_head_sha (the commit of Copilot's newest completed review) are
// printed beside it, and a head Copilot's last review did not cover refuses
// the clean settle (status 'blocked'), and so does a newest Copilot review whose
// body lists previously missed findings (GitHub issue #204; no override, a
// fresh review after the fix push gets past it). A MERGED PR settles clean at once with
// already_merged true and auto_merge false (GitHub issue #152); a CLOSED one is
// blocked. A PENDING or EXPECTED rollup with nothing else blocking is read
// again every --checks-interval seconds (default 30) for up to
// --checks-timeout seconds (default 540) until it finishes (decision
// pr-settle-clean-waits-for-pending-checks-then-decides-merge, GitHub issue
// #150); a timeout withholds the merge and says so (checks_timed_out). With a
// SUCCESS or null rollup, merge evidence that is only still to finish (a
// required check not reported or not completed, a workflow run not finished)
// is read again the same way; evidence with a failure is not waited for. The
// first evidence read always completes (each gh call keeps its own timeout);
// --checks-timeout bounds only the evidence re-reads after it.
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
import { describeReset, isRateLimitText, readCoreRateLimit } from './lib/gh-rate-limit.mjs';
import { autoMergeOnCleanOf, DeadlineReachedError, fetchPrMergeState, fetchReviewBody, fetchSettledMergeState, mergeBlockers, parseOriginRepo, parsePrUrl, resolveReviewThreads, settlePrLoop } from './lib/work-pr.mjs';

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

const result = { status: 'error', head_sha: null, review: null, comments: [], observed_copilot_login: null, stale_review: false, awaiting_head_review: false, identity_confirmed: false, previously_missed: [], previously_missed_unparsed: false, body_findings_without_comments: false, copilot_request: null, copilot_review_pending: null, stale_reviews: [] };
function finish(status, extra = {}) {
  const out = { ...result, status, ...extra };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(status === 'review' ? 0 : status === 'timeout' ? 2 : status === 'no_review_requested' ? 3 : status === 'rate_limited' ? 4 : 1);
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

// ------------------------------------------------------ merge authorization
// MERGE EVIDENCE (decision pr-auto-merge-requires-github-required-checks-as-the-expecte,
// user-ruled 2026-11-11, re-confirmed 2026-11-17; GitHub issues #248, #273,
// #275). A clean settle authorizes the merge only on GitHub's published
// evidence for the pinned head: the base branch's required checks (rulesets
// and classic branch protection) are all present and successful on the head,
// the head's newest workflow runs are all completed and none failed, and the
// branch is not behind its base. Absent, unreadable or unmet evidence
// withholds the merge with a named reason; it never refuses the settle.
const RATE_LIMIT_PROBE_MS = 30_000; // the gh api rate_limit read after a rate-limited call, capped to any deadline left
const EVIDENCE_MAX_BUFFER = 64 * 1024 * 1024; // compare and check-runs answers can be large
// A workflow run passes on success, skipped (it ran no job, so it hides no
// failure) or neutral, which GitHub treats as non-failing (user-ruled
// 2026-11-17, "Match GitHub").
const RUN_CONCLUSIONS_OK = new Set(['success', 'skipped', 'neutral']);
// A required check passes as GitHub branch protection counts it (user-ruled
// 2026-11-17, "Match GitHub, and wait"): success, skipped or neutral. failure,
// cancelled, timed_out, action_required, stale and startup_failure withhold.
const REQUIRED_CONCLUSIONS_OK = new Set(['success', 'skipped', 'neutral']);
const httpStatusOf = (text) => Number(String(text).match(/\(HTTP (\d{3})\)/)?.[1] ?? 0) || null;

/** The top-level JSON values of a gh answer (one per page under --paginate),
 * NOT flattened. Strict, unlike parsePages: an empty answer, a top-level value
 * that is not an object or an array, text outside the values, or a truncated
 * value throws, so a malformed answer is never read as an empty inventory. */
function strictPages(text) {
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
    if (depth === 0 && c !== '[' && c !== '{') {
      if (/\s/.test(c)) continue;
      throw new Error(`unexpected '${c}' outside a JSON object or array`);
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
  if (depth !== 0 || inString) throw new Error('truncated JSON');
  if (!values.length) throw new Error('an empty answer');
  return values;
}

/** One REST read for the merge evidence: { ok, pages } or { ok: false,
 * http, error }. pages are strictPages' values. A rate-limited read names the
 * reset. Never throws on gh. With `deadline` (ms since the epoch) the call,
 * and the rate-limit probe after it, end by it. */
function evidenceRead(host, path, { paginate = false, deadline = null } = {}) {
  const remaining = deadline === null ? GH_CALL_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0) return { ok: false, http: null, error: `--checks-timeout ran out before gh api ${path} could be read` };
  const args = ['api', '--hostname', host, ...(paginate ? ['--paginate'] : []), path];
  const r = spawnSync('gh', args, { cwd: target, encoding: 'utf8', timeout: Math.min(GH_CALL_TIMEOUT_MS, remaining), maxBuffer: EVIDENCE_MAX_BUFFER, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  const text = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
  if (!r.error && r.status !== 0 && isRateLimitText(text)) {
    const probeMs = deadline === null ? RATE_LIMIT_PROBE_MS : Math.min(RATE_LIMIT_PROBE_MS, deadline - Date.now());
    const limit = probeMs > 0 ? readCoreRateLimit((a) => spawnSync('gh', a, { cwd: target, encoding: 'utf8', timeout: probeMs, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }), host) : null;
    return { ok: false, http: 403, error: `GitHub's REST rate limit is exhausted${limit?.resetMs ? ` (resets ${describeReset(limit.resetMs)})` : ''}` };
  }
  if (r.error || r.status !== 0) return { ok: false, http: httpStatusOf(text), error: `gh api ${path} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || r.stdout || '').trim()}` };
  try {
    return { ok: true, pages: strictPages(r.stdout) };
  } catch (e) {
    return { ok: false, http: null, error: `gh api ${path} returned unreadable JSON (${e.message})` };
  }
}

/** The merge evidence for `headSha` of PR `number`: { reasons: [string],
 * evidence, pending }. Every reason withholds the merge. pending is true when
 * every reason is something still to finish (a required check not reported or
 * not completed yet, a workflow run not finished), so the settle's bounded
 * checks wait reads it again instead of withholding at once. */
function mergeEvidence(originRepo, number, headSha, { deadline = null } = {}) {
  const [host, owner, name] = originRepo.split('/');
  const repoPath = `repos/${owner}/${name}`;
  const reasons = [];
  let finals = 0; // reasons that waiting cannot change
  const evidence = { base_ref: null, required_checks: [], required_checks_missing: [], required_checks_pending: [], required_checks_failing: [], workflow_runs: [], behind_by: null };
  const read = (path, opts = {}) => evidenceRead(host, path, { ...opts, deadline });
  // ENVELOPES (Sol review): every answer must have its endpoint's shape, or it
  // is unreadable and withholds; it never reads as an empty inventory. A paged
  // list must hold every item its total_count declares.
  const one = (res, path, check) => {
    if (!res.ok) return res;
    if (res.pages.length !== 1 || !check(res.pages[0])) return { ok: false, http: null, error: `gh api ${path} returned an answer of an unexpected shape: ${JSON.stringify(res.pages).slice(0, 200)}` };
    return { ok: true, value: res.pages[0] };
  };
  const paged = (res, path, key) => {
    if (!res.ok) return res;
    const bad = res.pages.find((p) => p === null || typeof p !== 'object' || Array.isArray(p) || !Array.isArray(p[key]) || !Number.isInteger(p.total_count));
    if (bad !== undefined) return { ok: false, http: null, error: `gh api ${path} returned a page without a ${key} list and a total_count: ${JSON.stringify(bad).slice(0, 200)}` };
    const items = res.pages.flatMap((p) => p[key]);
    const total = res.pages[0].total_count;
    if (items.length < total) return { ok: false, http: null, error: `gh api ${path} returned ${items.length} of the ${total} ${key} it declares (incomplete pages)` };
    return { ok: true, items };
  };
  const final = (reason) => {
    reasons.push(reason);
    finals++;
  };

  const pullPath = `${repoPath}/pulls/${number}`;
  const pull = one(read(pullPath), pullPath, (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.base?.ref === 'string' && v.base.ref !== '');
  const baseRef = pull.ok ? pull.value.base.ref : undefined;
  if (!pull.ok) {
    final(`the PR's base branch could not be read (${pull.error}), so its required checks and the behind-base check cannot be read`);
    return { reasons, evidence, pending: reasons.length > 0 && finals === 0 };
  }
  evidence.base_ref = baseRef;
  const branch = encodeURIComponent(baseRef);

  // Required checks: rulesets plus classic branch protection (Sol review). Only
  // a PROVEN absence counts as not configured: rulesets answering a readable
  // list (an empty one, or one without a required_status_checks rule), and
  // classic protection answering 404 "Branch not protected". Anything else (a
  // 403, a plain 404 Not Found, which is also what a token without access gets,
  // a rate limit, a 5xx, an answer of the wrong shape) makes that source
  // unreadable, and an unreadable source withholds even when the other one
  // names passing checks: the unread source may require more.
  const required = new Set();
  const unreadable = [];
  const notConfigured = [];
  const rulesPath = `${repoPath}/rules/branches/${branch}`;
  const rules = read(rulesPath, { paginate: true });
  const ruleShapeOk = (r) => r !== null && typeof r === 'object' && !Array.isArray(r) && typeof r.type === 'string' && (r.type !== 'required_status_checks' || (Array.isArray(r.parameters?.required_status_checks) && r.parameters.required_status_checks.every((c) => typeof c?.context === 'string' && c.context !== '')));
  if (!rules.ok) unreadable.push(`rulesets: ${rules.error}`);
  else if (!rules.pages.every((p) => Array.isArray(p) && p.every(ruleShapeOk))) unreadable.push(`rulesets: gh api ${rulesPath} returned an answer of an unexpected shape: ${JSON.stringify(rules.pages).slice(0, 200)}`);
  else {
    const before = required.size;
    for (const rule of rules.pages.flat()) if (rule.type === 'required_status_checks') for (const c of rule.parameters.required_status_checks) required.add(c.context);
    if (required.size === before) notConfigured.push('no ruleset requires a status check');
  }
  const classicPath = `${repoPath}/branches/${branch}/protection/required_status_checks`;
  const classicRead = read(classicPath);
  if (!classicRead.ok && classicRead.http === 404 && /Branch not protected/i.test(classicRead.error)) notConfigured.push('the branch is not protected');
  else {
    const classic = one(classicRead, classicPath, (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.contexts) && v.contexts.every((c) => typeof c === 'string') && (v.checks === undefined || (Array.isArray(v.checks) && v.checks.every((c) => typeof c?.context === 'string'))));
    if (!classic.ok) unreadable.push(`branch protection: ${classic.error}`);
    else {
      const contexts = [...classic.value.contexts, ...(classic.value.checks ?? []).map((c) => c.context)].filter((c) => c !== '');
      for (const c of contexts) required.add(c);
      if (!contexts.length) notConfigured.push('branch protection requires no status check');
    }
  }
  evidence.required_checks = [...required].sort();
  if (unreadable.length) {
    final(`required checks not configured or unreadable for ${baseRef}: ${unreadable.join('; ')}: a source that cannot be read may require checks the other does not name, so the merge cannot be authorized`);
  } else if (!required.size) {
    final(`required checks not configured or unreadable for ${baseRef} (${notConfigured.join(', ')}): configure required status checks for ${baseRef} in a ruleset or branch protection so the merge can be authorized`);
  } else {
    // The newest check run per name, and the combined status's latest per context.
    const runsPath = `${repoPath}/commits/${headSha}/check-runs?per_page=100`;
    const statusPath = `${repoPath}/commits/${headSha}/status?per_page=100`;
    const runs = paged(read(runsPath, { paginate: true }), runsPath, 'check_runs');
    const statuses = paged(read(statusPath), statusPath, 'statuses');
    if (!runs.ok || !statuses.ok) {
      final(`the head commit's checks could not be read (${[runs, statuses].filter((x) => !x.ok).map((x) => x.error).join('; ')}), so the required checks cannot be confirmed`);
    } else {
      const latest = new Map();
      for (const cr of runs.items) {
        if (typeof cr?.name !== 'string') continue;
        const seen = latest.get(cr.name);
        if (!seen || (cr.id ?? 0) > (seen.id ?? 0)) latest.set(cr.name, cr);
      }
      const contexts = new Map(statuses.items.filter((s) => typeof s?.context === 'string').map((s) => [s.context, s]));
      for (const name of evidence.required_checks) {
        const cr = latest.get(name);
        const st = contexts.get(name);
        if (cr) {
          if (cr.status !== 'completed') evidence.required_checks_pending.push(`${name} (${cr.status})`);
          else if (!REQUIRED_CONCLUSIONS_OK.has(cr.conclusion)) evidence.required_checks_failing.push(`${name} (${cr.conclusion})`);
        } else if (st) {
          if (st.state === 'pending') evidence.required_checks_pending.push(`${name} (pending)`);
          else if (st.state !== 'success') evidence.required_checks_failing.push(`${name} (${st.state})`);
        } else evidence.required_checks_missing.push(name);
      }
      if (evidence.required_checks_missing.length) reasons.push(`required check${evidence.required_checks_missing.length > 1 ? 's' : ''} ${evidence.required_checks_missing.join(', ')} not reported on the head commit (never created, or not started yet): if it is still to run, run --settle clean again on this unchanged head once it has passed; otherwise re-run the workflow`);
      if (evidence.required_checks_pending.length) reasons.push(`required check${evidence.required_checks_pending.length > 1 ? 's' : ''} not finished on the head commit: ${evidence.required_checks_pending.join(', ')}: run --settle clean again on this unchanged head once ${evidence.required_checks_pending.length > 1 ? 'they finish' : 'it finishes'}`);
      if (evidence.required_checks_failing.length) final(`required check${evidence.required_checks_failing.length > 1 ? 's' : ''} not successful on the head commit: ${evidence.required_checks_failing.join(', ')}`);
    }
  }

  // Workflow runs for the head: the newest run per workflow and event must be
  // completed with no failure, whatever the check rollup says (#275, #273).
  const wrPath = `${repoPath}/actions/runs?head_sha=${headSha}&per_page=100`;
  const wr = paged(read(wrPath, { paginate: true }), wrPath, 'workflow_runs');
  if (!wr.ok) final(`the head commit's workflow runs could not be read (${wr.error}), so a failed or unfinished run cannot be ruled out`);
  else {
    const newest = new Map();
    for (const run of wr.items) {
      if (run?.head_sha !== undefined && run.head_sha !== headSha) continue;
      const key = `${run?.workflow_id ?? run?.name}:${run?.event ?? ''}`;
      const seen = newest.get(key);
      if (!seen || (run.id ?? 0) > (seen.id ?? 0)) newest.set(key, run);
    }
    evidence.workflow_runs = [...newest.values()].map((r) => ({ id: r.id ?? null, name: r.name ?? null, event: r.event ?? null, status: r.status ?? null, conclusion: r.conclusion ?? null, run_attempt: r.run_attempt ?? null }));
    const unfinished = evidence.workflow_runs.filter((r) => r.status !== 'completed');
    const failed = evidence.workflow_runs.filter((r) => r.status === 'completed' && !RUN_CONCLUSIONS_OK.has(r.conclusion));
    const label = (r) => `'${r.name ?? r.id}' (run ${r.id}, ${r.status === 'completed' ? r.conclusion : r.status})`;
    if (failed.length) final(`workflow run${failed.length > 1 ? 's' : ''} for the head did not succeed: ${failed.map(label).join(', ')}: fix or re-run, then settle again`);
    if (unfinished.length) reasons.push(`workflow run${unfinished.length > 1 ? 's' : ''} for the head not finished: ${unfinished.map(label).join(', ')}: run --settle clean again on this unchanged head once ${unfinished.length > 1 ? 'they finish' : 'it finishes'}`);
  }

  // Behind base (#248): the head must contain the base branch's head.
  const cmpPath = `${repoPath}/compare/${branch}...${headSha}`;
  const cmp = one(read(cmpPath), cmpPath, (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.behind_by) && v.behind_by >= 0);
  const behind = cmp.ok ? cmp.value.behind_by : undefined;
  if (!cmp.ok) final(`whether the branch is behind ${baseRef} could not be read (${cmp.error})`);
  else {
    evidence.behind_by = behind;
    if (behind > 0) final(`the branch is behind base: ${behind} commit${behind > 1 ? 's' : ''} on ${baseRef} are not in the head, so the merged result was never reviewed or tested: merge ${baseRef} into the branch, push, and run the loop again`);
  }
  return { reasons, evidence, pending: reasons.length > 0 && finals === 0 };
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
      let bodyRead = null;
      let reads = 0; // merge-state reads completed; lastEvidence.read names the one it was read for
      let lastEvidence = null;
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
        reads++;
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
        // GitHub issue #204: a review body that lists previously missed findings
        // is open work even when no thread is: refused, no override. A fresh
        // Copilot review after the fix push is the way past it.
        // The body is read once per review id, apart from the merge-state query
        // (which every thread page repeats); a failed read refuses the settle.
        if (bodyRead?.id !== last.id) {
          let body;
          try {
            body = fetchReviewBody(target, originRepo, armed.pr_number, last.id, { deadline: bounded ? deadline : null });
          } catch (e) {
            if (e instanceof DeadlineReachedError) throw e;
            throw blocked(`the newest Copilot review (${last.id}) body could not be read (${e.message}), so previously missed findings cannot be ruled out and the loop is NOT clean: settle again; nothing settled`, { head_sha: state.head_sha, reviewed_head_sha: reviewedHead, armed_head_sha: armed.head_sha });
          }
          bodyRead = { id: last.id, missed: parsePreviouslyMissed(body) };
        }
        const missed = bodyRead.missed;
        if (missed.items.length || missed.unparsed) {
          throw blocked(
            `the newest Copilot review (${last.id}) lists previously missed findings${missed.unparsed ? ' that could not be read in full' : ''}, so the loop is NOT clean: disposition each finding and push the fix so Copilot reviews again, then settle again; nothing settled`,
            { head_sha: state.head_sha, reviewed_head_sha: reviewedHead, armed_head_sha: armed.head_sha, previously_missed: missed.items, previously_missed_unparsed: missed.unparsed }
          );
        }
        if (bounded && Date.now() > deadline) {
          timedOut = true; // finished, but not within --checks-timeout
          // The last complete evidence read stands for this late merge-state read.
          if (lastEvidence) lastEvidence = { ...lastEvidence, read: reads };
          break;
        }
        const pending = PENDING_ROLLUPS.has(state.check_rollup) && !state.check_rollup_error && state.threads.every((t) => t.resolved);
        let waitingFor = pending ? `the head's check rollup is ${state.check_rollup}` : null;
        // MERGE EVIDENCE WAIT (user-ruled 2026-11-17, "Match GitHub, and wait"): a
        // required check not reported or not finished yet, or a workflow run still
        // running, is waited for inside the same bounded wait. Only a rollup that
        // could still authorize (SUCCESS or null) on an unblocked PR is worth it.
        if (!pending && (state.check_rollup === 'SUCCESS' || state.check_rollup === null) && !mergeBlockers(state).blockers.length) {
          // The FIRST evidence read always completes, bounded only by each gh
          // call's own timeout (a read that errors still withholds); the
          // deadline bounds only the re-reads of the wait after it.
          const reRead = lastEvidence !== null;
          const fresh = { ...mergeEvidence(originRepo, armed.pr_number, state.head_sha, { deadline: bounded && reRead ? deadline : null }), read: reads };
          if (reRead && bounded && Date.now() > deadline) {
            // A re-read not within --checks-timeout: a read the deadline cut
            // short is no evidence, so the last complete one stands, as the
            // last complete merge-state read does.
            timedOut = true;
            lastEvidence = { ...lastEvidence, read: reads };
            break;
          }
          lastEvidence = fresh;
          if (lastEvidence.pending) waitingFor = `the head's required checks or workflow runs are not finished (${[...lastEvidence.evidence.required_checks_missing.map((n) => `${n} not reported`), ...lastEvidence.evidence.required_checks_pending, ...lastEvidence.evidence.workflow_runs.filter((r) => r.status !== 'completed').map((r) => `run ${r.id} ${r.status}`)].join(', ')})`;
        }
        if (!waitingFor) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        process.stderr.write(`pr-review-wait: ${waitingFor}; waiting for the checks to finish (up to ${Math.ceil(remaining / 1000)}s more)\n`);
        sleep(Math.min(checksWait.intervalMs, remaining));
      }
      const checksWaitedS = Math.round((Date.now() - started) / 1000);
      // GitHub issue #152: a PR merged before the settle is clean with nothing
      // left to merge; GitHub keeps its merge state UNKNOWN for good.
      if (state.merged) {
        const reason = 'the PR is already merged: there is nothing left to merge';
        merge = { pr_state: state.pr_state, already_merged: true, merge_state_status: state.merge_state_status, review_decision: state.review_decision, check_rollup: state.check_rollup, mergeable_now: false, awaiting_human_review: false, auto_merge_on_clean: autoMergeOnClean, auto_merge: false, merge_authorized: false, withheld_reasons: [reason], auto_merge_withheld: reason, head_sha: state.head_sha, armed_head_sha: armed.head_sha, ...(resettle ? { resettle: true } : {}) };
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
      else if (timedOut && !lastEvidence?.pending) withheld.push(`the head commit's check rollup reached ${rollup} only after --checks-timeout ran out (${checksWaitedS}s): run --settle clean again on this unchanged head (it re-runs only the merge decision)`);
      else if (rollup === null) withheld.push(`the head commit reports no checks (check rollup null): no checks ran, or they are being re-created by a re-run, so nothing shows the head passed: run --settle clean again on this unchanged head once its checks have run`);
      else if (rollup !== 'SUCCESS') withheld.push(`the head commit's check rollup is ${rollup}, not SUCCESS: fix the failing check, push, and run the loop again`);
      // The evidence is read only when the settle can succeed; a blocked settle
      // authorizes nothing either way.
      if (timedOut && lastEvidence?.pending && lastEvidence.read === reads) withheld.push(`the head's required checks or workflow runs were still not finished after waiting ${checksWaitedS}s (--checks-timeout): once they finish, run --settle clean again on this unchanged head (it re-runs only the merge decision)`);
      let evidence = null;
      if (!verdict.blockers.length) {
        // The evidence read for this same merge-state read stands; otherwise read it now.
        const found = lastEvidence?.read === reads ? lastEvidence : mergeEvidence(originRepo, armed.pr_number, state.head_sha);
        withheld.push(...found.reasons);
        evidence = found.evidence;
      }
      const authorized = withheld.length === 0;
      merge = { pr_state: state.pr_state, already_merged: false, merge_state_status: state.merge_state_status, review_decision: state.review_decision, check_rollup: state.check_rollup, checks_waited_s: checksWaitedS, checks_timed_out: timedOut, mergeable_now: verdict.mergeable_now, awaiting_human_review: verdict.awaiting_human_review, auto_merge_on_clean: autoMergeOnClean, auto_merge: authorized, merge_authorized: authorized, withheld_reasons: withheld, auto_merge_withheld: withheld.length ? withheld.join('; ') : null, merge_evidence: evidence, head_sha: state.head_sha, reviewed_head_sha: reviewedHead, armed_head_sha: armed.head_sha, ...(resettle ? { resettle: true } : {}) };
      if (verdict.blockers.length) {
        throw blocked(`GitHub still blocks the merge, so the loop is NOT clean: ${verdict.blockers.join('; ')} — resolve the threads (--resolve-threads) or fix the blocker, then settle again; nothing settled`, { blockers: verdict.blockers, unresolved_threads: verdict.unresolved_threads });
      }
      return { head_sha: state.head_sha };
    };
    // GitHub issue #194: a PR closed without merging (superseded) ends its loop
    // as 'closed'. Only the PR's own state is read, and a PR that is open or
    // merged is refused: open means the loop still runs, merged settles clean.
    const closedGuard = (armed) => {
      const state = fetchPrMergeState(target, originRepo, armed.pr_number);
      merge = { pr_state: state.pr_state, already_merged: state.merged, head_sha: state.head_sha, armed_head_sha: armed.head_sha };
      if (state.merged) throw new Error(`the PR is already merged, so it was not closed unmerged: settle clean instead; nothing settled`);
      if (state.pr_state !== 'CLOSED') throw new Error(`the PR is ${state.pr_state}, not closed: settle closed only for a PR closed without merging; nothing settled`);
      return { head_sha: state.head_sha };
    };
    const s = settlePrLoop(storeRoot, outcome, flag('--pr'), { originRepo, guard: outcome === 'clean' ? guard : outcome === 'closed' ? closedGuard : null });
    // This script never merges: the line says what it authorized, nothing more.
    if (outcome === 'clean' && merge) {
      process.stderr.write(
        merge.merge_authorized
          ? `pr-review-wait: settled clean; authorized to merge ${merge.head_sha} (this script does not merge: the conductor runs the merge pinned to that head)\n`
          : `pr-review-wait: settled clean; merge withheld: ${merge.withheld_reasons.join('; ')}\n`
      );
    }
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
result.next_since_review = sinceReview;
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
/** A gh call failed on GitHub's rate limit; resetMs is the epoch ms the budget
 * resets (null when it could not be read). */
class RateLimited extends Error {
  constructor(message, resetMs) {
    super(message);
    this.resetMs = resetMs;
  }
}
const SECONDARY_BACKOFF_MS = 60_000; // a secondary limit or unreadable reset: no reset time to wait for
function rateLimitReset() {
  // The probe is capped to the --timeout budget left (Sol review): it never
  // keeps the call running past --timeout. With no budget left it is skipped.
  const probeMs = Math.min(RATE_LIMIT_PROBE_MS, deadline - Date.now());
  const limit = probeMs > 0 ? readCoreRateLimit((args) => spawnSync('gh', args, { cwd: target, encoding: 'utf8', timeout: probeMs, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }), origin.host) : null;
  return limit?.exhausted && limit.resetMs ? limit.resetMs : Date.now() + SECONDARY_BACKOFF_MS;
}
function ghApi(path, { paginate = false, extra = [] } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeadlineReached();
  const args = ['api', '--hostname', origin.host, ...(paginate ? ['--paginate'] : []), ...extra, path];
  const r = spawnSync('gh', args, { cwd: target, encoding: 'utf8', timeout: Math.min(GH_CALL_TIMEOUT_MS, remaining), env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.error?.code === 'ETIMEDOUT' && Date.now() >= deadline) throw new DeadlineReached();
  if (!r.error && r.status !== 0 && isRateLimitText(`${r.stderr}\n${r.stdout}`)) {
    throw new RateLimited(`gh ${args.join(' ')} hit the GitHub rate limit: ${(r.stderr || r.stdout || '').trim()}`, rateLimitReset());
  }
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
    error(`--request-copilot failed, so no review of the head will be requested: ${message}`);
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
  const unconsumed = copilot.filter((r) => COMPLETED_STATES.has(r.state) && (sinceReview === null || r.id > sinceReview));
  const headExpected = expectedHead === null || head.toLowerCase().startsWith(expectedHead);
  // With --head only a review of the expected head is returned; the rest are
  // consumed-as-stale and held for the result (see HOLD FOR THE HEAD).
  const isHeadReview = (r) => headExpected && r.commit_id === head;
  const fresh = expectedHead === null ? unconsumed : unconsumed.filter(isHeadReview);
  const staleHeld = expectedHead === null ? [] : unconsumed.filter((r) => !isHeadReview(r)).sort((a, b) => a.id - b.id);
  result.stale_reviews = staleHeld.map((r) => ({ id: r.id, commit_id: r.commit_id, author: r.user.login, state: r.state, body: r.body ?? '', comments: [] }));
  // NEXT WATERMARK (Sol review of #300): the highest id such that every
  // unconsumed review up to it was returned (as the review or in
  // stale_reviews). The skill passes it as the next --since-review, so a head
  // review with a lower id than a returned stale one is never skipped.
  const ascending = [...unconsumed].sort((a, b) => a.id - b.id);
  const watermark = (returnedIds) => {
    let next = sinceReview;
    for (const r of ascending) {
      if (!returnedIds.has(r.id)) break;
      next = r.id;
    }
    result.next_since_review = next;
  };
  watermark(new Set(staleHeld.map((r) => r.id)));
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
  const stale = !isHeadReview(review);
  const allComments = parsePages(ghApi(`${base}/comments`, { paginate: true }));
  const commentsOf = (id) => allComments
    .filter((c) => c?.pull_request_review_id === id)
    .map((c) => ({ id: c.id, path: c.path ?? null, line: c.line ?? c.original_line ?? null, body: c.body ?? '', in_reply_to: c.in_reply_to_id ?? null }));
  const comments = commentsOf(review.id);
  for (const held of result.stale_reviews) held.comments = commentsOf(held.id);
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
  watermark(new Set([review.id, ...staleHeld.map((r) => r.id)]));
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
    if (e instanceof RateLimited) {
      // Wait out the reset (plus a second) and poll again, unless it lands after the deadline.
      const resumeAt = e.resetMs + 1000;
      if (resumeAt >= deadline) {
        const message = `GitHub's REST rate limit is exhausted and resets ${describeReset(e.resetMs)}, after this wait's --timeout; run the wait again after the reset`;
        process.stderr.write(`pr-review-wait: ${message}\n`);
        finish('rate_limited', { review: null, comments: [], error: message, rate_limit_reset: new Date(e.resetMs).toISOString() });
      }
      sleep(Math.max(0, resumeAt - Date.now()));
      continue;
    }
    error(e.message);
  }
  if (found) finish('review', found);
  const remaining = deadline - Date.now();
  if (remaining <= 0) finish('timeout', { review: null, comments: [] });
  sleep(Math.min(intervalS * 1000, remaining));
  intervalS = Math.min(intervalS * 1.5, MAX_INTERVAL_S);
}
