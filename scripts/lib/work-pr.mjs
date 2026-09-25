// Work-mode shipping for /sterling:merge (decision
// project-mode-hobby-work-toggle-decides-flow, slice S2). In a WORK project the
// merge gate runs its usual preflight, then pushes the feature branch and opens
// (or reuses) a GitHub PR through `gh`. It never checks out, merges into or
// pushes the base: a human merges the PR, and the work repos block direct
// merges server-side, so no hook guards a hand-typed merge.
//
// Every gh call names the repo (host/owner/repo, parsed from origin's URL),
// head and base explicitly, so the result never depends on gh's own
// default-repo guessing. Push reuses the gate's Windows git.exe
// retry. The flow is retryable end to end: a rerun after "pushed, but no PR"
// finds no open PR, pushes again (a no-op) and creates it.
import { spawnSync } from 'node:child_process';

export const PR_ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

function gh(cwd, args) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
}

const streams = (r) => (r.stderr || r.stdout || String(r.error?.message ?? '')).trim();

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
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(host) || !seg.test(owner) || !seg.test(name) || owner.startsWith('.') || name.startsWith('.')) return null;
  return { host, repo: `${host}/${owner}/${name}` };
}

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
 * message as the error. Install it only once the mode is KNOWN to be work. */
export function installWorkResult() {
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

  state.stage = 'pr-create';
  const create = gh(cwd, ['pr', 'create', '--repo', repo, '--head', branch, '--base', base, '--title', text.title, '--body', text.body]);
  if (create.status !== 0) {
    return {
      exitCode: 1,
      error: [
        `direct-merge: PUSHED ${branch} to origin, but \`gh pr create\` FAILED — no PR exists yet.`,
        `Rerun /sterling:merge: it is safe (it finds no open PR, the push is a no-op, and it creates the PR).`,
        streams(create),
      ].join('\n'),
    };
  }
  let created;
  try {
    created = findOpenPr(cwd, repo, branch, base);
  } catch (e) {
    return { exitCode: 1, error: `direct-merge: the PR was created but reading it back failed: ${e.message}` };
  }
  if (!created) {
    return { exitCode: 1, error: `direct-merge: \`gh pr create\` succeeded but no open PR for ${branch} could be read back — check ${repo} on GitHub before rerunning. gh said: ${create.stdout.trim()}` };
  }
  state.pr_url = created.url;
  state.pr_number = created.number;
  state.created = true;
  log(`direct-merge: opened PR #${created.number}: ${created.url}`);
  return null;
}
