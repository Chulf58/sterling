// Work-mode shipping for /sterling:merge (decision
// project-mode-hobby-work-toggle-decides-flow, slice S2). In a WORK project the
// merge gate runs its usual preflight, then pushes the feature branch and opens
// (or reuses) a GitHub PR through `gh`. It never checks out, merges into or
// pushes the base: a human merges the PR, and the work repos block direct
// merges server-side, so no hook guards a hand-typed merge.
//
// Every gh call names the repo (host/owner/repo, parsed from origin's URL),
// head and base explicitly (the PR is created with `gh api POST .../pulls`,
// never `gh pr create`, which needs a local git binary gh can run), so the
// result never depends on gh's own default-repo guessing. Push reuses the gate's Windows git.exe
// retry. The flow is retryable end to end: a rerun after "pushed, but no PR"
// finds no open PR, pushes again (a no-op) and creates it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const PR_ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

function gh(cwd, args) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
}

const streams = (r) => (r.stderr || r.stdout || String(r.error?.message ?? '')).trim();

/** Where `gh` resolves on PATH (the first hit), or null. Reported when a gh
 * call fails, because on WSL the one that runs is often a Windows gh.exe. */
function resolveGhPath() {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh'] : ['gh', 'gh.exe'];
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The web page that opens a PR for `branch` into `base` by hand. */
const compareUrl = (repo, base, branch) => `https://${repo}/compare/${base.split('/').map(encodeURIComponent).join('/')}...${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;

/** origin's GitHub identity from its fetch URL: `https://host/owner/repo(.git)`,
 * `ssh://[user@]host[:port]/owner/repo(.git)` or `[user@]host:owner/repo(.git)`.
 * Returns { host, repo: 'host/owner/repo' } or null when the URL is not of
 * that shape. The repo is derived from the remote that `git push` targets,
 * never from gh's own default-repo resolution, which can pick another remote. */
export function parseOriginRepo(url) {
  const u = String(url ?? '').trim();
  let host;
  let path;
  let m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) [, host, path] = m;
  else if ((m = u.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/))) [, host, path] = m;
  else return null;
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  const seg = /^[A-Za-z0-9_.-]+$/;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(host) || !seg.test(owner) || !seg.test(name) || [owner, name].some((part) => part === '.' || part === '..')) return null;
  return { host, repo: `${host}/${owner}/${name}` };
}

/** True only when git answers and 'origin' is not among the remotes: a repo
 * that never had a GitHub remote (decision project-mode-hobby-work-toggle-decides-flow,
 * user-ruled 2026-10-08: such a project merges locally even in work mode). A
 * directory git cannot read is NOT "no origin": it keeps the work-mode path,
 * whose own preconditions refuse it by name. */
export function noOriginRemote(cwd) {
  const r = spawnSync('git', ['remote'], { cwd, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && !r.stdout.split('\n').map((l) => l.trim()).includes('origin');
}

/** The loud line printed when work mode falls back to a local merge. */
export const NO_ORIGIN_LOCAL_MERGE_NOTICE =
  "direct-merge: WORK mode, but this repository has no 'origin' remote — merging LOCALLY like hobby mode. NO pull request was opened and NO Copilot review happened; nothing was pushed.";

/** Cheap preconditions, checked BEFORE the battery. Returns { repo } or { refusal }. */
export function workPreflight(cwd) {
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (url.status !== 0) {
    return { refusal: "direct-merge: work mode opens a PR against the 'origin' remote, and this repository has none. Add it: git remote add origin <url>" };
  }
  const origin = parseOriginRepo(url.stdout);
  if (!origin) {
    return {
      refusal:
        `direct-merge: origin's URL '${url.stdout.trim()}' is not a GitHub repository URL (https://host/owner/repo, ssh://host/owner/repo or host:owner/repo) — ` +
        'work mode derives the PR repo from origin and will not guess one.',
    };
  }
  // EVERY EFFECTIVE PUSH DESTINATION must be the repo gh is bound to. `git push
  // origin` uses remote.origin.pushurl when set (possibly several), and
  // pushInsteadOf rewrites the destination; `get-url --push --all` applies
  // both. A mismatch would land the branch in one repo while the PR is opened
  // in another, so it refuses before anything is pushed.
  const pushUrls = spawnSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (pushUrls.status !== 0) {
    return { refusal: `direct-merge: could not read origin's push URLs (git remote get-url --push --all origin, exit ${pushUrls.status}): ${streams(pushUrls)}` };
  }
  const destinations = pushUrls.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const mismatched = destinations.filter((d) => parseOriginRepo(d)?.repo !== origin.repo);
  if (destinations.length === 0 || mismatched.length > 0) {
    return {
      refusal: [
        `direct-merge: origin's push destinations do not all match the repo the PR would be opened in (${origin.repo}, from the fetch URL ${url.stdout.trim()}) — refusing before pushing.`,
        'Effective push destinations (remote.origin.pushurl and pushInsteadOf applied):',
        ...(destinations.length ? destinations : ['(none)']).map((d) => `  ${d}  →  ${parseOriginRepo(d)?.repo ?? 'not a GitHub repository URL'}${mismatched.includes(d) ? '  (MISMATCH)' : ''}`),
        `Point every push URL of origin at ${origin.repo} (git remote set-url --push origin <url>, or remove the pushInsteadOf rewrite), then rerun.`,
      ].join('\n'),
    };
  }
  const version = gh(cwd, ['--version']);
  if (version.error || version.status !== 0) {
    return {
      refusal:
        `direct-merge: work mode needs the GitHub CLI, and \`gh\` could not be run (${streams(version) || `exit ${version.status}`}).\n` +
        'Install gh, then authenticate: gh auth login',
    };
  }
  const auth = gh(cwd, ['auth', 'status', '--hostname', origin.host]);
  if (auth.status !== 0) {
    return { refusal: `direct-merge: work mode needs gh authenticated for ${origin.host} — \`gh auth status --hostname ${origin.host}\` failed:\n${streams(auth)}\nRun: gh auth login --hostname ${origin.host}` };
  }
  return { repo: origin.repo };
}

/** A refusal message when `branch` is not a real local branch, else null. The
 * push publishes refs/heads/<branch>, so a tag, a remote-tracking ref or a
 * SHA given as --branch must never be pushed under a branch name. */
export function localBranchRefusal(cwd, branch) {
  const fmt = spawnSync('git', ['check-ref-format', '--branch', branch], { cwd, encoding: 'utf8', timeout: 30_000 });
  const ref = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (fmt.status === 0 && ref.status === 0) return null;
  return `direct-merge: '${branch}' is not a local branch (no refs/heads/${branch}) — work mode pushes a local branch to open its PR. Check out the branch, or pass --branch <local branch>.`;
}

/** Title and body from the branch's own commits, oldest first. One commit:
 * its subject and body. Several: the branch name as title and every commit's
 * subject and body in the body (gh's own --fill semantics). The body always
 * ends with the PR attribution line. Returns null when the branch has no
 * commits beyond the base. */
export function prTextFromCommits(cwd, mergeBase, branchTip, branch) {
  const log = spawnSync('git', ['log', '--no-merges', '--reverse', '--format=%s%x1f%b%x1e', `${mergeBase}..${branchTip}`], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (log.status !== 0) throw new Error(`git log ${mergeBase}..${branchTip} failed: ${(log.stderr || '').trim()}`);
  const commits = log.stdout
    .split('\x1e')
    .map((c) => c.replace(/^\n/, ''))
    .filter((c) => c.trim())
    .map((c) => {
      const [subject, body = ''] = c.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
  if (commits.length === 0) return null;
  if (commits.length === 1) {
    const [only] = commits;
    return { title: only.subject, body: [only.body, PR_ATTRIBUTION].filter(Boolean).join('\n\n') };
  }
  const sections = commits.map((c) => (c.body ? `## ${c.subject}\n\n${c.body}` : `## ${c.subject}`));
  return { title: branch, body: [...sections, PR_ATTRIBUTION].join('\n\n') };
}

/** The open PR in `repo` from `branch` into `base`, or null. Filters by head
 * AND base, and validates both on every returned entry. Throws on a gh
 * failure, a malformed answer, or more than one match — an unknown answer
 * must never read as "no PR" (a duplicate) or pick one PR at random. */
export function findOpenPr(cwd, repo, branch, base) {
  const r = gh(cwd, ['pr', 'list', '--repo', repo, '--head', branch, '--base', base, '--state', 'open', '--json', 'url,number,headRefName,baseRefName']);
  if (r.status !== 0) throw new Error(`gh pr list --repo ${repo} --head ${branch} --base ${base} failed (exit ${r.status}): ${streams(r)}`);
  let prs;
  try {
    prs = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`gh pr list returned unparseable JSON (${e.message}): ${r.stdout.trim()}`);
  }
  if (!Array.isArray(prs)) throw new Error(`gh pr list returned a non-array: ${r.stdout.trim()}`);
  for (const pr of prs) {
    if (typeof pr?.url !== 'string' || !Number.isInteger(pr?.number) || typeof pr?.headRefName !== 'string' || typeof pr?.baseRefName !== 'string') {
      throw new Error(`gh pr list returned an entry without url/number/headRefName/baseRefName: ${JSON.stringify(pr)}`);
    }
  }
  const matches = prs.filter((pr) => pr.headRefName === branch && pr.baseRefName === base);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} open PRs in ${repo} from ${branch} into ${base} (${matches.map((pr) => `#${pr.number} ${pr.url}`).join(', ')}) — ` +
        'refusing to pick one. Close the duplicates on GitHub, then rerun.'
    );
  }
  return matches.length ? { url: matches[0].url, number: matches[0].number } : null;
}

/** `git push <args>` with the WSL git.exe retry (credentials in the Windows
 * credential manager). A git.exe that cannot spawn keeps the original failure. */
export function pushWithWindowsRetry(cwd, pushArgs, log) {
  const tryPush = (cmd) =>
    spawnSync(cmd, ['push', ...pushArgs], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  let push = tryPush('git');
  if (push.status !== 0 && process.platform !== 'win32') {
    log('direct-merge: `git push` failed — retrying through git.exe (Windows credential manager)…');
    const winPush = tryPush('git.exe');
    if (!winPush.error) push = winPush;
  }
  return push;
}

/** The ONE work-mode result writer. Every work-mode exit — success, refusal,
 * a fail() from a shared helper that calls process.exit itself (openProject),
 * or an uncaught exception — prints exactly one JSON object on stdout:
 *   {mode:'work', ok, stage, error, exit, branch, pushed, pr_url, pr_number, created}
 * Human text stays on stderr. `state` is mutated by the caller as it goes
 * (stage, branch, pushed, pr_*); an exit that bypasses fail() (a helper's own
 * process.exit) is caught by the exit hook, which reports the last stderr
 * message as the error. Install it only once the mode is KNOWN to be work.
 * `localFallback` (work mode in a repo with no origin, GitHub issue #39) adds
 * `work_mode_local_fallback: true` to every object, and `finishLocal` writes the
 * local merge's own report inside the same envelope. */
export function installWorkResult({ localFallback = false } = {}) {
  const state = { stage: 'start', branch: null, pushed: false, pr_url: null, pr_number: null, created: false };
  const stderr = console.error.bind(console);
  let lastError = null;
  let written = false;
  console.error = (...args) => {
    lastError = args.map(String).join(' ');
    stderr(...args);
  };
  const write = (obj) => {
    if (written) return;
    written = true;
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  };
  const result = (ok, error, exit) => ({
    mode: 'work',
    ok,
    stage: state.stage,
    error,
    exit,
    branch: state.branch,
    pushed: state.pushed,
    pr_url: state.pr_url,
    pr_number: state.pr_number,
    created: state.created,
    ...(localFallback ? { work_mode_local_fallback: true } : {}),
  });
  process.on('exit', (code) => {
    write(result(false, lastError ?? `exited with code ${code} during stage '${state.stage}' without a result`, code));
  });
  process.on('uncaughtException', (e) => {
    const message = `direct-merge: unexpected error during stage '${state.stage}': ${e?.stack ?? e}`;
    stderr(message);
    write(result(false, message, 1));
    process.exit(1);
  });
  return {
    state,
    fail(message, code = 1) {
      stderr(message);
      write(result(false, message, code));
      process.exit(code);
    },
    succeed() {
      state.stage = 'done';
      write(result(true, null, 0));
      process.exit(0);
    },
    /** The local-merge fallback's exit: the envelope plus the merge's own report
     * (merged_into, branch_merged, branches_swept, …), ok only on exit 0. */
    finishLocal(report, code = 0) {
      if (code === 0) state.stage = 'done';
      write({ ...result(code === 0, code === 0 ? null : lastError ?? `exited with code ${code} during stage '${state.stage}'`, code), ...report });
      process.exit(code);
    },
  };
}

/** Push the branch and open or reuse its PR, recording progress on `state`
 * (the installWorkResult state). Returns null on success, or
 * { error, exitCode } for the caller's result writer. Never touches the base. */
export function shipAsPr({ cwd, repo, branch, base, mergeBase, branchTip, state, log }) {
  let existing;
  state.stage = 'pr-lookup';
  try {
    existing = findOpenPr(cwd, repo, branch, base);
  } catch (e) {
    return { exitCode: 1, error: `direct-merge: could not look up an open PR for ${branch} — nothing pushed, nothing created. ${e.message}` };
  }
  const text = existing ? null : prTextFromCommits(cwd, mergeBase, branchTip, branch);
  if (!existing && text === null) {
    return { exitCode: 1, error: `direct-merge: ${branch} has no commits beyond ${base} — nothing to open a PR for. Nothing pushed.` };
  }

  // PINNED PUSH: the refspec names the SHA the preflight and battery checked,
  // never the mutable branch name, so a commit that lands on the branch while
  // the battery runs cannot ship unchecked. The same refspec goes through the
  // git.exe retry. The upstream is set separately, as plain config.
  state.stage = 'push';
  log(`direct-merge: work mode — pushing ${branch} at ${branchTip} to origin (the base ${base} is never pushed or merged here)…`);
  const push = pushWithWindowsRetry(cwd, ['origin', `${branchTip}:refs/heads/${branch}`], log);
  if (push.status !== 0) {
    return {
      exitCode: 1,
      error: [
        `direct-merge: the PUSH of ${branch} to origin FAILED — no PR was ${existing ? 'updated' : 'created'}. Fix the push and rerun.`,
        `  (on WSL, try: git.exe push origin ${branchTip}:refs/heads/${branch} — credentials live in GCM)`,
        streams(push),
      ].join('\n'),
    };
  }
  state.pushed = true;
  log(`direct-merge: pushed ${branch} (${branchTip}) to origin.`);
  for (const [key, value] of [[`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${branch}`]]) {
    const set = spawnSync('git', ['config', key, value], { cwd, encoding: 'utf8', timeout: 30_000 });
    if (set.status !== 0) log(`direct-merge: could not set the upstream (${key}); the push and PR are unaffected. Set it with: git branch --set-upstream-to=origin/${branch} ${branch}`);
  }

  if (existing) {
    state.pr_url = existing.url;
    state.pr_number = existing.number;
    log(`direct-merge: an open PR already exists for ${branch} — reused, the push updated it: ${existing.url}`);
    return null;
  }

  // The PR is created through the REST API, never `gh pr create`: that command
  // shells out to a local git binary, and the Windows gh.exe that WSL resolves
  // cannot find one ("unable to find git executable in PATH"). `gh api` needs
  // no git, and the repo is named explicitly (host, owner, repo from origin).
  state.stage = 'pr-create';
  const [host, owner, name] = repo.split('/');
  const create = gh(cwd, [
    'api', '--hostname', host, '--method', 'POST', `repos/${owner}/${name}/pulls`,
    '-f', `head=${branch}`, '-f', `base=${base}`, '-f', `title=${text.title}`, '-f', `body=${text.body}`,
  ]);
  const said = [create.stderr, create.stdout].map((t) => String(t ?? '').trim()).filter(Boolean).join('\n') || String(create.error?.message ?? '').trim();
  // A successful POST is authoritative: the 201 body names the PR it made.
  // Anything else (a failed call, or an answer that is not a PR) falls to a
  // STRICT READ-BACK: a failed create may still have made the PR (a race with
  // another run, a timeout after the server acted), so the repo/head/base
  // lookup decides. Found after a failure → reported as reused. Not found or
  // not readable → the state is UNKNOWN, never asserted absent.
  if (create.status === 0) {
    let made = null;
    try {
      made = JSON.parse(create.stdout);
    } catch {
      made = null;
    }
    if (typeof made?.html_url === 'string' && Number.isInteger(made?.number)) {
      state.pr_url = made.html_url;
      state.pr_number = made.number;
      state.created = true;
      log(`direct-merge: opened PR #${made.number}: ${made.html_url}`);
      return null;
    }
  }
  let found;
  let lookupError = null;
  try {
    found = findOpenPr(cwd, repo, branch, base);
  } catch (e) {
    found = null;
    lookupError = e.message;
  }
  if (!found) {
    const lookupCmd = `gh pr list --repo ${repo} --head ${branch} --base ${base} --state open`;
    return {
      exitCode: 1,
      error: [
        create.status !== 0
          ? `direct-merge: PUSHED ${branch} (${branchTip}) to origin, but the PR create (gh api POST repos/${owner}/${name}/pulls) FAILED, and whether a PR exists is UNKNOWN.`
          : `direct-merge: PUSHED ${branch} (${branchTip}) to origin and the PR create (gh api POST repos/${owner}/${name}/pulls) reported success, but its answer was not a PR and none could be read back, so the PR state is UNKNOWN.`,
        lookupError ? `The follow-up lookup failed: ${lookupError}` : 'The follow-up lookup found no open PR for this repo, head and base.',
        `Check with: ${lookupCmd}`,
        `Then rerun /sterling:merge: it is safe — it reuses an open PR for this head and base, or creates one; the push is a no-op.`,
        `If you open the PR by hand instead, rerunning /sterling:merge on ${branch} reuses it and arms the review loop.`,
        `Create it by hand at: ${compareUrl(repo, base, branch)}`,
        `Then rerun /sterling:merge on ${branch}.`,
        ...(create.status !== 0
          ? [`gh that ran: ${resolveGhPath() ?? 'not found on PATH'}. On WSL a Windows gh.exe is a known cause of this failure ("gh: Invalid argument").`]
          : []),
        `gh api said: ${said}`,
      ].join('\n'),
    };
  }
  state.pr_url = found.url;
  state.pr_number = found.number;
  if (create.status !== 0) {
    log(`direct-merge: the PR create failed (${said}), but an open PR for ${branch} into ${base} exists — reused: ${found.url}`);
    return null;
  }
  log(`direct-merge: the PR create's answer was not a PR, but an open PR for ${branch} into ${base} exists — reused: ${found.url}`);
  return null;
}

// ------------------------------------------------------------- PR review loop
// The H10 'PR review loop owed' duty (slice S3, skill pr-review-loop). A
// work-mode merge that creates OR reuses a PR arms it by writing
// .sterling/transient/pr-loop.json; the conductor discharges it only through
// the deliberate settle act (pr-review-wait.mjs --settle). H10 reads it on
// every Stop and nags while status is 'owed'. The loop's own state (round,
// consumed review id, reviewed head) lives on the PR's progress comment, never
// here: this file only says that a loop is owed, and for which PR.
export const PR_LOOP_REL = '.sterling/transient/pr-loop.json';
export const PR_LOOP_OUTCOMES = ['clean', 'capped', 'escalated'];
export const prLoopPath = (root) => join(root, PR_LOOP_REL);

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Arm (or re-arm) the duty for this PR at the pushed head. A re-arm on reuse
 * replaces any earlier state, settled or not: a new head is owed a new review. */
export function armPrLoop(root, { pr_url, pr_number, repo, head_sha, now = new Date().toISOString() }) {
  const state = { pr_url, pr_number, repo, head_sha, armed_at: now, status: 'owed' };
  writeAtomic(prLoopPath(root), state);
  return state;
}

/** The armed loop, or null when none was ever armed. Throws on an unreadable
 * or malformed file — an unknown state is never read as "nothing owed". */
export function readPrLoop(root) {
  const file = prLoopPath(root);
  if (!existsSync(file)) return null;
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${PR_LOOP_REL} is not valid JSON (${e.message})`);
  }
  // STRICT (Sol review): anything but an exact known status, a missing
  // repo/head_sha, or a settled outcome without settled_at is UNREADABLE —
  // the caller discloses it; it is never read as settled.
  const str = (v) => typeof v === 'string' && v.length > 0;
  if (!s || typeof s !== 'object' || Array.isArray(s) || !str(s.pr_url) || !Number.isInteger(s.pr_number) || !str(s.repo) || !str(s.head_sha) || !str(s.armed_at)) {
    throw new Error(`${PR_LOOP_REL} lacks pr_url/pr_number/repo/head_sha/armed_at: ${JSON.stringify(s)}`);
  }
  if (s.status !== 'owed' && !PR_LOOP_OUTCOMES.includes(s.status)) {
    throw new Error(`${PR_LOOP_REL} has status ${JSON.stringify(s.status)} — it must be exactly owed, ${PR_LOOP_OUTCOMES.join(', ')}`);
  }
  if (s.status !== 'owed' && !str(s.settled_at)) throw new Error(`${PR_LOOP_REL} is settled '${s.status}' without settled_at`);
  return s;
}

/** `https://host/owner/repo/pull/<n>` → { repo: 'host/owner/repo', number }, or null. */
export function parsePrUrl(url) {
  const m = String(url ?? '').match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  return m ? { repo: `${m[1]}/${m[2]}/${m[3]}`, number: Number(m[4]) } : null;
}

/** The deliberate settle act: mark the armed loop clean, capped or escalated.
 * `prRef` is the PR number or its full URL. BOUND (Sol review): the armed
 * state must be coherent (pr_url, repo and pr_number agree), its repo must be
 * `originRepo` (the current origin), `prRef` must name that same PR, and the
 * loop must still be OWED — a settled loop is never re-settled. `guard`, when
 * given, runs last with the armed state and throws to refuse (the clean
 * outcome uses it to check that GitHub would let the PR merge). Throws
 * (nothing written) otherwise. */
export function settlePrLoop(root, outcome, prRef, { originRepo, now = new Date().toISOString(), guard = null }) {
  if (!PR_LOOP_OUTCOMES.includes(outcome)) throw new Error(`--settle must be one of ${PR_LOOP_OUTCOMES.join('|')}, got '${outcome}'`);
  const ref = /^\d+$/.test(String(prRef ?? '')) ? { repo: null, number: Number(prRef) } : parsePrUrl(prRef);
  if (!ref) throw new Error('--settle needs --pr <number|PR URL>, the PR the loop was armed for');
  const s = readPrLoop(root);
  if (!s) throw new Error(`no PR review loop is armed here (${PR_LOOP_REL} is absent) — nothing to settle`);
  const armed = parsePrUrl(s.pr_url);
  if (!armed || armed.repo !== s.repo || armed.number !== s.pr_number) {
    throw new Error(`${PR_LOOP_REL} is incoherent (pr_url ${s.pr_url}, repo ${s.repo}, pr_number ${s.pr_number}) — nothing settled; rerun /sterling:merge to re-arm it`);
  }
  // A stuck loop (armed for a PR other than the one being settled, typically
  // because the PR was opened by hand after a failed create) names its way out.
  const unstick = `armed head ${s.head_sha}; to re-arm it for the current PR, rerun /sterling:merge on the branch this PR was opened from; to discard the armed state, run: rm ${prLoopPath(root)}`;
  if (s.repo !== originRepo) throw new Error(`the armed loop is for ${s.repo}, not origin's repo (${originRepo}) — nothing settled (${unstick})`);
  if (ref.number !== s.pr_number || (ref.repo !== null && ref.repo !== s.repo)) {
    throw new Error(`the armed loop is for PR #${s.pr_number} (${s.pr_url}), not ${prRef} — nothing settled (${unstick})`);
  }
  if (s.status !== 'owed') throw new Error(`the loop for ${s.pr_url} is already settled '${s.status}' (${s.settled_at}); only an owed loop can be settled`);
  if (guard) guard(s);
  const next = { ...s, status: outcome, settled_at: now };
  writeAtomic(prLoopPath(root), next);
  return next;
}

// ------------------------------------------------- merge state + review threads
// GitHub can refuse a merge although every Copilot finding was answered: an
// org ruleset with required_review_thread_resolution blocks until each review
// thread is RESOLVED, and replying never resolves it (GitHub issue #42). The
// loop therefore resolves the thread of each dispositioned finding and asks
// GitHub for the merge state before it settles clean. All calls are GraphQL
// through `gh api graphql`; a gh failure or a GraphQL errors payload throws.

const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

function ghGraphql(cwd, host, query) {
  const args = ['api', '--hostname', host, 'graphql', '-f', `query=${query}`];
  const r = gh(cwd, args);
  if (r.error || r.status !== 0) throw new Error(`gh api graphql failed (${r.error ? r.error.message : `exit ${r.status}`}): ${streams(r)}`);
  let reply;
  try {
    reply = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`gh api graphql returned invalid JSON (${e.message}): ${String(r.stdout).slice(0, 200)}`);
  }
  if (Array.isArray(reply?.errors) && reply.errors.length) throw new Error(`GraphQL returned errors: ${reply.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ')}`);
  return reply?.data;
}

const splitRepo = (repo) => {
  const [host, owner, name] = String(repo).split('/');
  return { host, owner, name };
};

/** The PR's mergeStateStatus, reviewDecision, the head commit's check rollup
 * state (null when the head has no checks) and EVERY review thread (paged), as
 * { merge_state_status, review_decision, check_rollup, threads: [{id, resolved,
 * outdated, path, url, comment_ids}] }. `repo` is 'host/owner/repo'. */
export function fetchPrMergeState(cwd, repo, number) {
  const { host, owner, name } = splitRepo(repo);
  const threads = [];
  let after = null;
  let state = null;
  for (;;) {
    const page = after ? `, after:"${after}"` : '';
    const query = `query { repository(owner:"${owner}", name:"${name}") { pullRequest(number:${number}) { mergeStateStatus reviewDecision commits(last:1) { nodes { commit { statusCheckRollup { state } } } } reviewThreads(first:100${page}) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path comments(first:50) { nodes { databaseId url } } } } } } }`;
    const pull = ghGraphql(cwd, host, query)?.repository?.pullRequest;
    if (!pull || typeof pull.mergeStateStatus !== 'string' || !Array.isArray(pull.reviewThreads?.nodes)) {
      throw new Error(`GraphQL returned no mergeStateStatus/reviewThreads for ${repo}#${number}`);
    }
    state ??= { merge_state_status: pull.mergeStateStatus, review_decision: pull.reviewDecision ?? null, check_rollup: pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null };
    for (const t of pull.reviewThreads.nodes) {
      const comments = t?.comments?.nodes ?? [];
      threads.push({ id: t.id, resolved: t.isResolved === true, outdated: t.isOutdated === true, path: t.path ?? null, url: comments[0]?.url ?? null, comment_ids: comments.map((c) => c.databaseId) });
    }
    const info = pull.reviewThreads.pageInfo;
    if (!info?.hasNextPage) break;
    if (typeof info.endCursor !== 'string' || !/^[A-Za-z0-9_=-]+$/.test(info.endCursor)) throw new Error(`GraphQL reviewThreads cursor is unusable: ${JSON.stringify(info.endCursor)}`);
    after = info.endCursor;
  }
  return { ...state, threads };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** fetchPrMergeState, read again ONCE after `retryDelayMs` when GitHub answers
 * UNKNOWN: it computes mergeability lazily, so a first read right after a push
 * or a resolve is often UNKNOWN. A second UNKNOWN is returned as it is and
 * mergeBlockers blocks on it. */
export function fetchSettledMergeState(cwd, repo, number, { retryDelayMs = 3000, sleep = sleepMs } = {}) {
  const first = fetchPrMergeState(cwd, repo, number);
  if (first.merge_state_status !== 'UNKNOWN') return first;
  sleep(retryDelayMs);
  return fetchPrMergeState(cwd, repo, number);
}

/** What blocks a human from merging, from fetchPrMergeState's result:
 * { mergeable_now, blockers: [string], unresolved_threads: [{id, path, url}],
 * awaiting_human_review }. Unresolved threads always block. A BLOCKED PR with
 * no unresolved thread whose reviewDecision is REVIEW_REQUIRED waits only for a
 * human's approval, which the loop can never give: that is reported
 * (awaiting_human_review) but does not stop the loop from ending clean, and
 * only when the head's check rollup is SUCCESS or absent (a failing or pending
 * required check also shows as BLOCKED, so any other rollup blocks and is
 * named). Every other state outside CLEAN/HAS_HOOKS/UNSTABLE blocks, unknown
 * ones included; UNKNOWN says to retry shortly. */
export function mergeBlockers(state) {
  const unresolved = state.threads.filter((t) => !t.resolved).map(({ id, path, url }) => ({ id, path, url }));
  const blockers = unresolved.map((t) => `unresolved review thread ${t.id}${t.path ? ` on ${t.path}` : ''}${t.url ? ` (${t.url})` : ''}`);
  const status = state.merge_state_status;
  let awaiting = false;
  if (!MERGEABLE_STATES.has(status)) {
    const rollup = state.check_rollup ?? null;
    if (status === 'BLOCKED' && unresolved.length === 0 && state.review_decision === 'REVIEW_REQUIRED') {
      if (rollup === null || rollup === 'SUCCESS') awaiting = true;
      else blockers.push(`mergeStateStatus is BLOCKED and the head commit's checks are ${rollup}, not only a required human review`);
    }
    else if (status === 'UNKNOWN') blockers.push('mergeStateStatus is UNKNOWN (GitHub is still computing mergeability; retry shortly)');
    else if (status === 'BLOCKED' && unresolved.length > 0) blockers.push('mergeStateStatus is BLOCKED');
    else if (status === 'BLOCKED') blockers.push(`mergeStateStatus is BLOCKED (reviewDecision ${state.review_decision ?? 'none'}) with no unresolved thread: a ruleset or required check blocks the merge`);
    else blockers.push(`mergeStateStatus is ${status}`);
  }
  return { mergeable_now: blockers.length === 0 && !awaiting, blockers, unresolved_threads: unresolved, awaiting_human_review: awaiting };
}

/** Resolve the review thread of each given review-comment id (the REST id the
 * wait helper returns in comments[].id; a reply anywhere in the thread counts).
 * Every id is matched to a thread BEFORE any mutation, so an unknown id throws
 * with nothing resolved. Returns { resolved: [{comment_id, thread_id}],
 * already_resolved: [comment_id], same_thread_as_resolved: [{comment_id,
 * thread_id}] } (a later id in a thread this call just resolved); a failed
 * mutation throws naming the threads already resolved. */
export function resolveReviewThreads(cwd, repo, number, commentIds) {
  const { host } = splitRepo(repo);
  const { threads } = fetchPrMergeState(cwd, repo, number);
  const plan = commentIds.map((id) => ({ id, thread: threads.find((t) => t.comment_ids.includes(id)) }));
  const missing = plan.filter((p) => !p.thread).map((p) => p.id);
  if (missing.length) throw new Error(`no review thread of ${repo}#${number} holds comment ${missing.join(', ')} — nothing resolved`);
  const resolved = [];
  const alreadyResolved = [];
  const sameThread = [];
  const done = new Set();
  for (const { id, thread } of plan) {
    if (thread.resolved) {
      alreadyResolved.push(id);
      continue;
    }
    if (done.has(thread.id)) {
      sameThread.push({ comment_id: id, thread_id: thread.id });
      continue;
    }
    if (!/^[A-Za-z0-9_=-]+$/.test(thread.id)) throw new Error(`review thread id ${JSON.stringify(thread.id)} is not a usable node id`);
    try {
      const out = ghGraphql(cwd, host, `mutation { resolveReviewThread(input:{threadId:"${thread.id}"}) { thread { id isResolved } } }`);
      if (out?.resolveReviewThread?.thread?.isResolved !== true) throw new Error(`resolveReviewThread did not leave thread ${thread.id} resolved: ${JSON.stringify(out)}`);
    } catch (e) {
      throw new Error(`${e.message} (already resolved this call: ${resolved.map((r) => r.thread_id).join(', ') || 'none'})`);
    }
    done.add(thread.id);
    resolved.push({ comment_id: id, thread_id: thread.id });
  }
  return { resolved, already_resolved: alreadyResolved, same_thread_as_resolved: sameThread };
}
