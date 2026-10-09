// GitHub status for the terminal dashboard (board 87bca3f8; design finding
// tui-github-status-strip-design-gh-graphql-october-2026). One gh GraphQL
// query per poll reads the open PRs (checks, merge state, draft, unresolved
// threads, Copilot review state) and the last 5 merged PRs; the PR review
// loop's outcome comes from .sterling/transient/pr-loop.json.
//
// The poller never blocks the dashboard: every process runs through an
// async execFile (never spawnSync), at most one poll is in flight, and the
// result is an immutable snapshot the 1 s tick hands to the state layer. The
// snapshot's `version` moves only when its content changes, so an unchanged
// poll costs no redraw. The state layer derives the strip row and the GitHub
// tab from the snapshot and never runs gh itself.
//
// parseOriginRepo and readPrLoop are imported from scripts/lib/work-pr.mjs,
// the way controller.ts imports the other scripts/lib modules: esbuild
// inlines them into the TUI bundle, and the OpenCode dashboard never loads
// this file. gh() in that module is synchronous and is not used here.
import { execFile as nodeExecFile } from 'node:child_process';
import { parseOriginRepo, readPrLoop } from '../../../scripts/lib/work-pr.mjs';

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';
export type CopilotState = 'requested' | 'reviewed' | 'stale' | 'none';
export type GithubFailure = 'not-logged-in' | 'no-access' | 'offline' | 'error';

export interface GithubPr {
  number: number;
  title: string;
  branch: string;
  draft: boolean;
  /** mergeStateStatus as GitHub reports it (CLEAN, BLOCKED, BEHIND, DIRTY, …) */
  merge: string;
  /** reviewDecision (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED) or '' */
  review: string;
  checks: ChecksState;
  unresolved: number;
  copilot: CopilotState;
}

export interface GithubMerged {
  number: number;
  title: string;
  mergedAt: string;
}

export interface GithubLoop {
  status: 'owed' | 'clean' | 'capped' | 'escalated';
  pr: number;
}

export interface GithubSnapshot {
  /** moves whenever the content changes; the dashboard's rebuild key */
  readonly version: number;
  /** loading: nothing fetched yet. hidden: no gh, no origin, or an origin that
   *  is not on github.com, so nothing is drawn. failed: the last poll failed. */
  readonly state: 'loading' | 'hidden' | 'ok' | 'failed';
  /** owner/name, once origin has been read */
  readonly repo?: string;
  /** hidden or failed: one line saying why */
  readonly reason?: string;
  readonly failure?: GithubFailure;
  /** the last good poll; after a failure it is kept for STALE_MS, then dropped */
  readonly data?: { readonly open: readonly GithubPr[]; readonly merged: readonly GithubMerged[]; readonly fetchedAt: number };
  readonly loop?: GithubLoop;
  /** pr-loop.json exists but could not be read (readPrLoop threw) */
  readonly loopError?: string;
}

export const POLL_MS = 60_000;
/** while any open PR has pending checks or a Copilot review requested */
export const FAST_POLL_MS = 20_000;
/** with no open PR, and while origin is missing or not on GitHub */
export const IDLE_POLL_MS = 300_000;
/** the backoff ceiling; also the wait after "not logged in" or "gh not installed" */
export const MAX_BACKOFF_MS = 900_000;
/** how long the last good data is shown after polls start failing */
export const STALE_MS = 600_000;
export const GH_TIMEOUT_MS = 15_000;

export interface ExecFileError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
}
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number; windowsHide: boolean },
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
) => unknown;

/** GitHub matches Copilot by a Bot whose login contains "copilot", as
 *  scripts/pr-review-wait.mjs does while no login is pinned. */
const COPILOT_LOGIN = /copilot/i;

export const GITHUB_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title headRefName isDraft mergeStateStatus reviewDecision
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
        latestReviews(first: 20) { nodes { author { __typename login } commit { oid } } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on Bot { login } ... on User { login } } } }
      }
    }
    merged: pullRequests(states: MERGED, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title mergedAt }
    }
  }
}`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const nodes = (v: unknown): Json[] => {
  const n = obj(v).nodes;
  return Array.isArray(n) ? n.map(obj) : [];
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function checksOf(rollup: unknown): ChecksState {
  const state = str(obj(rollup).state);
  if (!state) return 'none';
  if (state === 'SUCCESS') return 'pass';
  if (state === 'FAILURE' || state === 'ERROR') return 'fail';
  return 'pending';
}

const isCopilot = (actor: unknown): boolean => {
  const a = obj(actor);
  return a.__typename === 'Bot' && COPILOT_LOGIN.test(str(a.login));
};

function copilotOf(pr: Json, headOid: string): CopilotState {
  if (nodes(pr.reviewRequests).some((r) => isCopilot(r.requestedReviewer))) return 'requested';
  const reviews = nodes(pr.latestReviews).filter((r) => isCopilot(r.author));
  if (headOid && reviews.some((r) => str(obj(r.commit).oid) === headOid)) return 'reviewed';
  return reviews.length ? 'stale' : 'none';
}

/** The GraphQL response → open and merged PRs. Throws when the response has
 *  no repository (the message is GitHub's own error when it sent one). */
export function deriveGithub(response: unknown): { open: GithubPr[]; merged: GithubMerged[] } {
  const root = obj(response);
  const repo = obj(root.data).repository;
  if (!repo || typeof repo !== 'object') {
    const errors = Array.isArray(root.errors) ? root.errors.map((e) => str(obj(e).message)).filter(Boolean) : [];
    throw new Error(errors[0] ?? 'the response has no repository');
  }
  const open = nodes(obj(repo).open).map((pr): GithubPr => {
    const head = obj(nodes(pr.commits)[0]?.commit);
    const headOid = str(head.oid);
    return {
      number: Number(pr.number),
      title: str(pr.title),
      branch: str(pr.headRefName),
      draft: pr.isDraft === true,
      merge: str(pr.mergeStateStatus),
      review: str(pr.reviewDecision),
      checks: checksOf(head.statusCheckRollup),
      unresolved: nodes(pr.reviewThreads).filter((t) => t.isResolved !== true).length,
      copilot: copilotOf(pr, headOid),
    };
  });
  const merged = nodes(obj(repo).merged).map((pr): GithubMerged => ({ number: Number(pr.number), title: str(pr.title), mergedAt: str(pr.mergedAt) }));
  return { open, merged };
}

/** A failed gh run → the failure kind and the one dim line the strip shows. */
export function classifyGhFailure(error: ExecFileError, stderr: string, repo: string): { failure: GithubFailure; reason: string } {
  const text = `${stderr}\n${error.message ?? ''}`;
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(text)) return { failure: 'not-logged-in', reason: 'gh not logged in' };
  if (error.killed || /could not resolve host|dial tcp|i\/o timeout|network is unreachable|connection refused|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text)) return { failure: 'offline', reason: 'gh offline' };
  if (/Could not resolve to a Repository|HTTP 403|HTTP 404|Resource not accessible|SAML/i.test(text)) return { failure: 'no-access', reason: `gh: no access to ${repo}` };
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  return { failure: 'error', reason: `gh failed: ${first}` };
}

/** The wait before the next poll after one that ended in `snapshot`;
 *  `failures` counts consecutive failed polls, this one included. */
export function nextPollDelay(snapshot: GithubSnapshot, failures: number): number {
  if (snapshot.state === 'hidden') return snapshot.reason === 'gh not installed' ? MAX_BACKOFF_MS : IDLE_POLL_MS;
  if (snapshot.state === 'failed') {
    if (snapshot.failure === 'not-logged-in') return MAX_BACKOFF_MS;
    return Math.min(POLL_MS * 2 ** Math.max(1, failures), MAX_BACKOFF_MS);
  }
  const open = snapshot.data?.open ?? [];
  if (open.length === 0) return IDLE_POLL_MS;
  if (open.some((p) => p.checks === 'pending' || p.copilot === 'requested')) return FAST_POLL_MS;
  return POLL_MS;
}

export interface GithubPollerOptions {
  /** the project root: git runs here and pr-loop.json is read under it */
  root: string;
  execFile?: ExecFile;
  /** reads the armed PR loop; readPrLoop from work-pr.mjs unless a test injects one */
  readLoop?: (root: string) => unknown;
  env?: NodeJS.ProcessEnv;
  /** the clock a finished poll schedules the next one from; Date.now unless a test injects one */
  clock?: () => number;
}

export interface GithubPoller {
  snapshot(): GithubSnapshot;
  /** Start a poll when one is due and none is in flight; true when it started
   *  one. Also drops stale data past STALE_MS. Never waits on the poll. */
  tick(now: number): boolean;
  /** The `r` key: poll now unless one is already in flight. */
  refresh(): boolean;
  inFlight(): boolean;
}

function loopOf(readLoop: (root: string) => unknown, root: string): Pick<GithubSnapshot, 'loop' | 'loopError'> {
  try {
    const s = obj(readLoop(root));
    if (!Object.keys(s).length) return {};
    return { loop: { status: s.status as GithubLoop['status'], pr: Number(s.pr_number) } };
  } catch (err) {
    return { loopError: (err as Error).message };
  }
}

export function createGithubPoller(options: GithubPollerOptions): GithubPoller {
  const run: ExecFile = options.execFile ?? (nodeExecFile as unknown as ExecFile);
  const readLoop = options.readLoop ?? readPrLoop;
  const clock = options.clock ?? Date.now;
  const env = { ...(options.env ?? process.env), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  const execOpts = { cwd: options.root, timeout: GH_TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  let current: GithubSnapshot = { version: 0, state: 'loading' };
  let busy = false;
  let nextAt = 0;
  let failures = 0;

  /** Publish `next` (without its version); the version moves only on a change. */
  function publish(next: Omit<GithubSnapshot, 'version'>): void {
    const { version: _v, ...prev } = current;
    if (JSON.stringify(prev) !== JSON.stringify(next)) current = { ...next, version: current.version + 1 };
  }

  function settle(next: Omit<GithubSnapshot, 'version'>): void {
    failures = next.state === 'failed' ? failures + 1 : 0;
    publish(next);
    nextAt = clock() + nextPollDelay(current, failures);
    busy = false;
  }

  function poll(): void {
    busy = true;
    run('git', ['remote', 'get-url', 'origin'], execOpts, (gitErr, gitOut) => {
      const origin = gitErr ? null : parseOriginRepo(gitOut);
      if (!origin) return settle({ state: 'hidden', reason: gitErr ? 'no origin remote' : 'origin is not a GitHub repository' });
      if (origin.host !== 'github.com') return settle({ state: 'hidden', reason: `origin is on ${origin.host}, not github.com` });
      const [, owner, name] = origin.repo.split('/');
      const repo = `${owner}/${name}`;
      const args = ['api', 'graphql', '-f', `query=${GITHUB_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
      run('gh', args, execOpts, (ghErr, ghOut, ghStderr) => {
        const at = clock();
        const loop = loopOf(readLoop, options.root);
        if (ghErr && ghErr.code === 'ENOENT') return settle({ state: 'hidden', reason: 'gh not installed' });
        const keep = current.data && at - current.data.fetchedAt <= STALE_MS ? { data: current.data } : {};
        if (ghErr) return settle({ state: 'failed', repo, ...classifyGhFailure(ghErr, String(ghStderr ?? ''), repo), ...keep, ...loop });
        let derived: { open: GithubPr[]; merged: GithubMerged[] };
        try {
          derived = deriveGithub(JSON.parse(String(ghOut)));
        } catch (err) {
          return settle({ state: 'failed', repo, failure: 'error', reason: `gh failed: ${(err as Error).message}`, ...keep, ...loop });
        }
        settle({ state: 'ok', repo, data: { ...derived, fetchedAt: at }, ...loop });
      });
    });
  }

  return {
    snapshot: () => current,
    tick(now) {
      if (current.state === 'failed' && current.data && now - current.data.fetchedAt > STALE_MS) {
        const { version: _v, data: _d, ...rest } = current;
        publish(rest);
      }
      if (busy || now < nextAt) return false;
      poll();
      return true;
    },
    refresh() {
      if (busy) return false;
      poll();
      return true;
    },
    inFlight: () => busy,
  };
}
