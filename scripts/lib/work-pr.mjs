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

/** Push the branch and open or reuse its PR. Returns { exitCode, result }
 * where result is the ONE stdout JSON object. Never touches the base. */
export function shipAsPr({ cwd, repo, branch, base, mergeBase, branchTip, log }) {
  const result = { mode: 'work', pr_url: null, pr_number: null, branch, created: false };
  let existing;
  try {
    existing = findOpenPr(cwd, repo, branch, base);
  } catch (e) {
    log(`direct-merge: could not look up an open PR for ${branch} — nothing pushed, nothing created. ${e.message}`);
    return { exitCode: 1, result };
  }
  const text = existing ? null : prTextFromCommits(cwd, mergeBase, branchTip, branch);
  if (!existing && text === null) {
    log(`direct-merge: ${branch} has no commits beyond ${base} — nothing to open a PR for. Nothing pushed.`);
    return { exitCode: 1, result };
  }

  log(`direct-merge: work mode — pushing ${branch} to origin (the base ${base} is never pushed or merged here)…`);
  const push = pushWithWindowsRetry(cwd, ['-u', 'origin', branch], log);
  if (push.status !== 0) {
    log(
      [
        `direct-merge: the PUSH of ${branch} to origin FAILED — no PR was ${existing ? 'updated' : 'created'}. Fix the push and rerun.`,
        `  (on WSL, try: git.exe push -u origin ${branch} — credentials live in GCM)`,
        streams(push),
      ].join('\n')
    );
    return { exitCode: 1, result };
  }
  log(`direct-merge: pushed ${branch} to origin.`);

  if (existing) {
    log(`direct-merge: an open PR already exists for ${branch} — reused, the push updated it: ${existing.url}`);
    return { exitCode: 0, result: { ...result, pr_url: existing.url, pr_number: existing.number } };
  }

  const create = gh(cwd, ['pr', 'create', '--repo', repo, '--head', branch, '--base', base, '--title', text.title, '--body', text.body]);
  if (create.status !== 0) {
    log(
      [
        '',
        `direct-merge: PUSHED ${branch} to origin, but \`gh pr create\` FAILED — no PR exists yet.`,
        `Rerun /sterling:merge: it is safe (it finds no open PR, the push is a no-op, and it creates the PR).`,
        streams(create),
      ].join('\n')
    );
    return { exitCode: 1, result: { ...result, pushed: true } };
  }
  let created;
  try {
    created = findOpenPr(cwd, repo, branch, base);
  } catch (e) {
    created = null;
    log(`direct-merge: the PR was created but reading it back failed: ${e.message}`);
  }
  if (!created) {
    log(`direct-merge: \`gh pr create\` succeeded but no open PR for ${branch} could be read back — check ${repo} on GitHub before rerunning. gh said: ${create.stdout.trim()}`);
    return { exitCode: 1, result: { ...result, pushed: true } };
  }
  log(`direct-merge: opened PR #${created.number}: ${created.url}`);
  return { exitCode: 0, result: { ...result, pr_url: created.url, pr_number: created.number, created: true } };
}
