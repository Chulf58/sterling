// pr-review-wait.mjs — the ONE bounded gh helper of the PR review loop, and
// the only thing in it that polls (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3; SOP
// skills/pr-review-loop/SKILL.md).
//
//   node scripts/pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo]
//        [--since-review <id>] [--head <sha>] [--timeout <s>] [--interval <s>]
//        [--target <dir>]
//   node scripts/pr-review-wait.mjs --settle <clean|capped|escalated> --pr <n> [--target <dir>]
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
// deadline bounds the whole call and each gh call has its own timeout.
//
// UNVERIFIED until the S0 first use on a work machine: the Copilot reviewer's
// login (matched by /copilot/i, and reported verbatim as
// observed_copilot_login), that review ids grow monotonically (the
// --since-review comparison), and that a review's commit_id is the head it
// reviewed. The skill asks for the observed facts to be reported back so they
// can be pinned as fixtures.
//
// Stdout is ONE JSON object:
//   {status:'review'|'timeout'|'error', head_sha, review:{id, commit_id,
//    author, state, body}|null, comments:[{id, path, line, body, in_reply_to}],
//    observed_copilot_login, stale_review_ignored[, error]}
// Exit 0 = review, 2 = timeout, 1 = error. Timeout and error are never clean.
//
// SETTLE: the deliberate conductor act that discharges H10's 'PR review loop
// owed' duty — writes the outcome on .sterling/transient/pr-loop.json when the
// armed PR matches --pr. Exit 0 with {status, pr_number, pr_url}; any refusal
// exits 1 and writes nothing.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseOriginRepo, settlePrLoop } from './lib/work-pr.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = resolve(flag('--target') ?? process.cwd());

const COPILOT_LOGIN = /copilot/i; // UNVERIFIED until S0 (see the header)
const COMPLETED_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);
const GH_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_S = 540; // under a 10-minute background Bash window
const DEFAULT_INTERVAL_S = 30;
const MAX_INTERVAL_S = 120;

const result = { status: 'error', head_sha: null, review: null, comments: [], observed_copilot_login: null, stale_review_ignored: false };
function finish(status, extra = {}) {
  const out = { ...result, status, ...extra };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(status === 'review' ? 0 : status === 'timeout' ? 2 : 1);
}
const error = (message) => finish('error', { review: null, comments: [], error: message });

// ------------------------------------------------------------------ settle
if (argv.includes('--settle')) {
  const pr = flag('--pr');
  try {
    const s = settlePrLoop(target, flag('--settle'), pr !== undefined && /^\d+$/.test(pr) ? Number(pr) : NaN);
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
if (positional.length !== 1) error('usage: pr-review-wait.mjs <pr-url|number> [--repo host/owner/repo] [--since-review <id>] [--head <sha>] [--timeout <s>]');
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
const expectedHead = flag('--head') ?? null;

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
  const m = pr.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!m) error(`'${pr}' is neither a PR number nor a PR URL (https://host/owner/repo/pull/<n>)`);
  if (`${m[1]}/${m[2]}/${m[3]}` !== origin.repo) error(`the PR URL ${pr} is not in origin's repo (${origin.repo}) — the PR repo is bound to origin`);
  prNumber = Number(m[4]);
}
const [, owner, name] = origin.repo.split('/');
const base = `repos/${owner}/${name}/pulls/${prNumber}`;

// -------------------------------------------------------------------- gh
function ghApi(path, { paginate = false } = {}) {
  const args = ['api', '--hostname', origin.host, ...(paginate ? ['--paginate'] : []), path];
  const r = spawnSync('gh', args, { cwd: target, encoding: 'utf8', timeout: GH_CALL_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.error || r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
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
  const copilot = reviews.filter((r) => typeof r?.user?.login === 'string' && COPILOT_LOGIN.test(r.user.login) && Number.isInteger(r.id));
  if (copilot.length) result.observed_copilot_login = copilot.reduce((a, b) => (b.id > a.id ? b : a)).user.login;
  const fresh = copilot.filter((r) => COMPLETED_STATES.has(r.state) && (sinceReview === null || r.id > sinceReview));
  const current = expectedHead === null || expectedHead === head ? fresh.filter((r) => r.commit_id === head) : [];
  result.stale_review_ignored = result.stale_review_ignored || fresh.some((r) => r.commit_id !== head);
  if (!current.length) return null;
  // The LOWEST fresh id first (Sol review, HIGH): a later review never hides an
  // earlier one's findings. The skill advances --since-review only after each
  // returned review is fully dispositioned, so the next call yields the next.
  const review = current.reduce((a, b) => (b.id < a.id ? b : a));
  const comments = parsePages(ghApi(`${base}/comments`, { paginate: true }))
    .filter((c) => c?.pull_request_review_id === review.id)
    .map((c) => ({ id: c.id, path: c.path ?? null, line: c.line ?? c.original_line ?? null, body: c.body ?? '', in_reply_to: c.in_reply_to_id ?? null }));
  return {
    review: { id: review.id, commit_id: review.commit_id, author: review.user.login, state: review.state, body: review.body ?? '' },
    comments,
  };
}

const deadline = Date.now() + timeoutS * 1000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) {
  let found;
  try {
    found = poll();
  } catch (e) {
    error(e.message);
  }
  if (found) finish('review', found);
  const remaining = deadline - Date.now();
  if (remaining <= 0) finish('timeout', { review: null, comments: [] });
  sleep(Math.min(intervalS * 1000, remaining));
  intervalS = Math.min(intervalS * 1.5, MAX_INTERVAL_S);
}
