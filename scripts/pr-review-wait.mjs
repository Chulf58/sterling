// pr-review-wait.mjs — the ONE bounded gh helper of the PR review loop, and
// the only thing in it that polls (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3; SOP
// skills/pr-review-loop/SKILL.md).
//
//   node scripts/pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo]
//        [--since-review <id>] [--head <sha>] [--timeout <s>] [--interval <s>]
//        [--request-copilot] [--target <dir>]
//   node scripts/pr-review-wait.mjs --settle <clean|capped|escalated> --pr <n|pr-url> [--target <dir>]
//
// WAIT: the repo is bound to origin exactly as work-mode /sterling:merge binds
// it (parseOriginRepo over origin's fetch URL); a PR URL or --repo naming any
// other repo is an error before any gh call. Every call is `gh api --hostname
// <host> repos/<owner>/<repo>/...` — `gh api` takes no --repo flag, so the repo
// is named in the path and the host explicitly, and gh's default-repo guessing
// never applies. Each poll fetches the PR head SHA, then the reviews and the
// review comments with --paginate. It returns as soon as a COPILOT review
// (author login matching /copilot/i) that is completed, newer than
// --since-review and of the current head exists — the OLDEST such review
// first, so none is ever skipped; otherwise it sleeps with
// backoff and polls again until --timeout. One call never runs forever: the
// deadline is checked before every gh call and caps each call's own timeout.
// A review is returned only when the head read AFTER fetching it is still the
// reviewed SHA. --head takes 7-40 hex characters and matches the PR head by
// prefix (a short sha is accepted; anything else is refused naming the value).
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
// --since-review comparison), and that a review's commit_id is the head it
// reviewed. The skill asks for the observed facts to be reported back so they
// can be pinned as fixtures.
//
// Stdout is ONE JSON object:
//   {status:'review'|'timeout'|'error', head_sha, review:{id, commit_id,
//    author, state, body}|null, comments:[{id, path, line, body, in_reply_to}],
//    previously_missed:[string], body_findings_without_comments,
//    copilot_request:null|{requested, error?},
//    observed_copilot_login, stale_review_ignored, identity_confirmed[, error]}
// previously_missed is the list items under a "Previously missed" heading of the
// review body ([] when absent). body_findings_without_comments is true for any
// non-blank body with no inline comments, because the body format is Copilot's
// and may change: such a review is not clean until the body has been read.
// Exit 0 = review, 2 = timeout, 1 = error. Timeout and error are never clean.
//
// SETTLE: the deliberate conductor act that discharges H10's 'PR review loop
// owed' duty — writes the outcome on .sterling/transient/pr-loop.json when the
// armed loop is owed, coherent, in origin's repo, and the PR --pr names
// (number or full URL). Exit 0 with {status, pr_number, pr_url}; any refusal
// exits 1 and writes nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseOriginRepo, parsePrUrl, settlePrLoop } from './lib/work-pr.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = resolve(flag('--target') ?? process.cwd());

const COPILOT_LOGIN = /copilot/i; // UNVERIFIED until S0 (see the header); used only while unpinned
const COMPLETED_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);
const COPILOT_REQUEST_LOGIN = 'copilot-pull-request-reviewer[bot]'; // the bot GraphQL names; the REST re-request returns an empty list
const GH_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_S = 540; // under a 10-minute background Bash window
const DEFAULT_INTERVAL_S = 30;
const MAX_INTERVAL_S = 120;

const result = { status: 'error', head_sha: null, review: null, comments: [], observed_copilot_login: null, stale_review_ignored: false, identity_confirmed: false, previously_missed: [], body_findings_without_comments: false, copilot_request: null };
function finish(status, extra = {}) {
  const out = { ...result, status, ...extra };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(status === 'review' ? 0 : status === 'timeout' ? 2 : 1);
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
  const file = join(target, '.sterling', 'config.json');
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

// ------------------------------------------------------------------ settle
if (argv.includes('--settle')) {
  try {
    const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: target, encoding: 'utf8', timeout: 30_000 });
    const originRepo = url.status === 0 ? parseOriginRepo(url.stdout)?.repo : null;
    if (!originRepo) throw new Error(`origin in ${target} is missing or not a GitHub repository URL — settle is bound to origin`);
    const s = settlePrLoop(target, flag('--settle'), flag('--pr'), { originRepo });
    process.stdout.write(JSON.stringify({ status: s.status, pr_number: s.pr_number, pr_url: s.pr_url, settled_at: s.settled_at }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`pr-review-wait: settle refused — ${e.message}\n`);
    process.stdout.write(JSON.stringify({ status: 'error', error: e.message }) + '\n');
    process.exit(1);
  }
}

// -------------------------------------------------------------------- args
const valued = new Set(['--repo', '--since-review', '--head', '--timeout', '--interval', '--target']);
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

/** The "Previously missed" findings of a review body: the list items under a
 * heading (markdown heading, bold line or <summary>) that starts with that
 * phrase, up to the next markdown heading or </details>. A line indented under
 * an item continues it. [] when the section is absent. */
function parsePreviouslyMissed(body) {
  const items = [];
  let inSection = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const plain = line.replace(/<[^>]*>/g, '').replace(/^[\s#*_]+/, '');
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
    if (/^previously missed/i.test(plain) && (isHeading || /^\s*(\*\*|__|<summary|<details)/i.test(line))) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (isHeading || /<\/details>/i.test(line)) break;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (item) items.push(item[1]);
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
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

function poll() {
  const [pull] = parsePages(ghApi(base));
  const head = pull?.head?.sha;
  if (typeof head !== 'string') throw new Error(`gh api ${base} returned no head.sha`);
  result.head_sha = head;
  const reviews = parsePages(ghApi(`${base}/reviews`, { paginate: true }));
  const copilot = reviews.filter((r) => isCopilot(r, pinnedLogins));
  if (copilot.length) result.observed_copilot_login = copilot.reduce((a, b) => (b.id > a.id ? b : a)).user.login;
  const fresh = copilot.filter((r) => COMPLETED_STATES.has(r.state) && (sinceReview === null || r.id > sinceReview));
  const current = expectedHead === null || head.toLowerCase().startsWith(expectedHead) ? fresh.filter((r) => r.commit_id === head) : [];
  result.stale_review_ignored = result.stale_review_ignored || fresh.some((r) => r.commit_id !== head);
  if (!current.length) return null;
  // The LOWEST fresh id first (Sol review, HIGH): a later review never hides an
  // earlier one's findings. The skill advances --since-review only after each
  // returned review is fully dispositioned, so the next call yields the next.
  const review = current.reduce((a, b) => (b.id < a.id ? b : a));
  const comments = parsePages(ghApi(`${base}/comments`, { paginate: true }))
    .filter((c) => c?.pull_request_review_id === review.id)
    .map((c) => ({ id: c.id, path: c.path ?? null, line: c.line ?? c.original_line ?? null, body: c.body ?? '', in_reply_to: c.in_reply_to_id ?? null }));
  // HEAD RACE (Sol review): a push between the first head read and here would
  // make this a review of a superseded head. Re-read the head; return the
  // review only if both reads equal the reviewed SHA (and --head, checked
  // above), otherwise poll again — the next poll sees it as stale.
  const [again] = parsePages(ghApi(base));
  if (again?.head?.sha !== head) {
    result.head_sha = typeof again?.head?.sha === 'string' ? again.head.sha : head;
    return null;
  }
  const body = review.body ?? '';
  return {
    review: { id: review.id, commit_id: review.commit_id, author: review.user.login, state: review.state, body },
    comments,
    previously_missed: parsePreviouslyMissed(body),
    body_findings_without_comments: body.trim() !== '' && comments.length === 0,
  };
}

if (requestCopilot) requestCopilotReview();

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) {
  let found;
  try {
    found = poll();
  } catch (e) {
    if (e instanceof DeadlineReached) finish('timeout', { review: null, comments: [] });
    error(e.message);
  }
  if (found) finish('review', found);
  const remaining = deadline - Date.now();
  if (remaining <= 0) finish('timeout', { review: null, comments: [] });
  sleep(Math.min(intervalS * 1000, remaining));
  intervalS = Math.min(intervalS * 1.5, MAX_INTERVAL_S);
}
