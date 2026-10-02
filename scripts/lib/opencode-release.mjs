// The /sterling:merge OpenCode release step (decision
// sterling-on-opencode-installs-from-a-git-release-branch-v2): after a hobby
// merge that pushed the base and moved package.json's version, write the merged
// tree as a commit on the `opencode-release` branch, tag it v<version>, and push
// both to origin in one atomic push. OpenCode installs it with
// `opencode plugin add "github:Chulf58/sterling#semver:>=0.18.0"` (STERLING_GIT_SPEC
// in sterling-roots.mjs), which follows the tags.
//
// The release tree is the merged commit's tree with one change: package.json
// without `workspaces` and without the scripts that make a Git install run
// `prepare` and fail (finding opencode-2-0-21-plugin-add-git-spec-prepare-trigger-check-update).
// It is built with plumbing in a temporary index (read-tree, hash-object,
// update-index, write-tree, commit-tree), so the authoring tree is never checked
// out and every other blob, mode and symlink is the merged commit's own. A
// git-archive extract re-added with `git add` would drop the executable bit on a
// clone with core.filemode=false, which the /mnt/c clone has.
//
// Fail closed and loud, never failing the merge: an unreadable origin or a tag
// v<version> that already names other content refuses with a message and the
// re-run command; a release that ran and failed (a failed push) reports failed,
// and direct-merge exits non-zero. Every other merge (another package, an
// unpushed base, an unchanged version) is a one-line skip.
//
// The re-run entry point is scripts/opencode-release.mjs (rerunRelease). This
// module has no CLI of its own: it is bundled into bin/direct-merge.mjs, where an
// entry-point guard would compare equal and run a release inside the merge.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const RELEASE_PACKAGE = '@chulf58/sterling';
export const RELEASE_BRANCH = 'opencode-release';
/** pacote's GitFetcher prepares (and, with no node_modules, fails) when any of these exists. */
export const BUILD_CLASS_SCRIPTS = ['postinstall', 'build', 'preinstall', 'install', 'prepack', 'prepare'];

const short = (sha) => (sha ? sha.slice(0, 12) : '(none)');
const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}`.trim();
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

/** package.json text -> the shipped package.json text: no workspaces, no build-class scripts, everything else kept. */
export function releasePackageJson(text) {
  const pkg = JSON.parse(text);
  delete pkg.workspaces;
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const k of BUILD_CLASS_SCRIPTS) delete pkg.scripts[k];
    if (Object.keys(pkg.scripts).length === 0) delete pkg.scripts;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function git(target, args, { env, input } = {}) {
  return spawnSync('git', args, { cwd: target, encoding: 'utf8', timeout: 120_000, input, env: env ? { ...process.env, ...env } : process.env });
}

/** Run a git command against origin; on WSL a failed `git` is retried through git.exe (credentials live in GCM), as pushWithWindowsRetry does. */
export function defaultRemoteGit(args, { cwd }) {
  const run = (cmd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let r = run('git');
  if (r.status !== 0 && process.platform !== 'win32') {
    const win = run('git.exe');
    if (!win.error) r = win;
  }
  return r;
}

function revParse(target, rev) {
  const r = git(target, ['rev-parse', '-q', '--verify', rev]);
  return r.status === 0 ? r.stdout.trim() : null;
}

const isAncestor = (target, a, b) => git(target, ['merge-base', '--is-ancestor', a, b]).status === 0;

function packageAt(target, sha) {
  const r = git(target, ['show', `${sha}:package.json`]);
  if (r.status !== 0) return null;
  try {
    return { text: r.stdout, json: JSON.parse(r.stdout) };
  } catch {
    return null;
  }
}

/** ls-remote output -> Map(refname -> sha). */
function parseLsRemote(text) {
  const refs = new Map();
  for (const line of text.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) refs.set(name, sha);
  }
  return refs;
}

function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed: ${output(r)}`);
  return r.stdout.trim();
}

/** The release tree for `headSha`: its own tree with package.json replaced. Writes objects only, never a ref, the index or the work tree. */
function buildReleaseTree(target, headSha, pkgText) {
  const tmp = mkdtempSync(join(tmpdir(), 'sterling-release-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    must(git(target, ['read-tree', headSha], { env }), `git read-tree ${headSha}`);
    const blob = must(git(target, ['hash-object', '-w', '--stdin'], { input: releasePackageJson(pkgText) }), 'git hash-object');
    must(git(target, ['update-index', '--cacheinfo', `100644,${blob},package.json`], { env }), 'git update-index');
    return must(git(target, ['write-tree'], { env }), 'git write-tree');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The re-run entry is the target's own scripts/opencode-release.mjs: a release only
// runs when the target's package.json names RELEASE_PACKAGE, so the target is a
// Sterling checkout. Never this module's own path, which inside the bin/direct-merge.mjs
// bundle is the merge script.
export function rerunCommand(target, ref) {
  return `node ${quote(join(resolve(target), 'scripts', 'opencode-release.mjs'))} --target ${quote(resolve(target))} --ref ${quote(ref)}`;
}

/**
 * Release `version` from the merged commit `headSha` of `into`. The caller has
 * checked the release condition.
 * @returns {{status: 'published'|'refused'|'failed', version: string, commit: string|null, reason: string|null}}
 */
function releaseVersion({ target, into, headSha, version, pkgText, remoteGit, log, prefix }) {
  const tag = `v${version}`;
  const rerun = rerunCommand(target, into);
  const stands = `THE MERGE STANDS: the base is merged and pushed. Only the OpenCode release is missing.`;
  const refuse = (headline, detail) => {
    log([``, `${prefix}: opencode release REFUSED for ${tag}: ${headline}`, stands, detail, `Re-run the release once fixed: ${rerun}`].filter(Boolean).join('\n'));
    return { status: 'refused', version, commit: null, reason: headline };
  };
  const failed = (detail, commit = null) => {
    log([``, `${prefix}: opencode release FAILED for ${tag}.`, stands, `Re-run the release: ${rerun}`, detail].join('\n'));
    return { status: 'failed', version, commit, reason: detail };
  };

  const ls = remoteGit(['ls-remote', 'origin', `refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`], { cwd: target });
  if (ls.status !== 0) return refuse('could not read origin (git ls-remote failed), so the tag and branch could not be checked.', output(ls));
  const remote = parseLsRemote(ls.stdout);
  const remoteBranch = remote.get(`refs/heads/${RELEASE_BRANCH}`) ?? null;
  const remoteTag = remote.get(`refs/tags/${tag}^{}`) ?? remote.get(`refs/tags/${tag}`) ?? null;
  if (remoteBranch) {
    const fetch = remoteGit(['fetch', '--no-tags', 'origin', `+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`], { cwd: target });
    if (fetch.status !== 0) return refuse(`could not fetch origin's ${RELEASE_BRANCH}, so the release cannot build on it.`, output(fetch));
  }
  const localTag = revParse(target, `refs/tags/${tag}^{commit}`);
  const localBranch = revParse(target, `refs/heads/${RELEASE_BRANCH}`);
  if (localTag && remoteTag && localTag !== remoteTag) {
    return refuse(`the local ${tag} tag (${short(localTag)}) differs from origin's (${short(remoteTag)}).`, `Inspect both; delete the wrong one by hand (git tag -d ${tag}, or the tag on origin).`);
  }

  let tree;
  try {
    tree = buildReleaseTree(target, headSha, pkgText);
  } catch (e) {
    return failed(`Building the release tree failed: ${e.message}`);
  }

  let commit = remoteTag ?? localTag;
  if (commit) {
    const where = remoteTag ? 'on origin' : 'locally';
    const existingTree = revParse(target, `${commit}^{tree}`);
    if (!existingTree) return refuse(`${tag} already exists ${where} at ${short(commit)}, a commit this clone does not have.`, `A version is released once. Bump the version in .claude-plugin/plugin.json and package.json for the next release.`);
    if (existingTree !== tree) return refuse(`${tag} already exists ${where} at ${short(commit)} with other content.`, `A version is released once. Bump the version in .claude-plugin/plugin.json and package.json for the next release.`);
    if (remoteTag && remoteBranch && (remoteBranch === commit || isAncestor(target, commit, remoteBranch))) {
      log(`${prefix}: opencode release ${tag} is already on origin at ${short(commit)}; nothing to push.`);
      return { status: 'published', version, commit, reason: null };
    }
  } else {
    const parent = remoteBranch ?? localBranch;
    const message = `Sterling ${version} for OpenCode\n\nRelease of ${headSha} (${into}): the merged tree with a package.json that installs from Git (no workspaces, no build-class scripts).\n`;
    const made = git(target, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: message });
    if (made.status !== 0) return failed(`git commit-tree failed: ${output(made)}`);
    commit = made.stdout.trim();
  }

  if (!(localBranch && (localBranch === commit || isAncestor(target, commit, localBranch)))) {
    const upd = git(target, ['update-ref', `refs/heads/${RELEASE_BRANCH}`, commit]);
    if (upd.status !== 0) return failed(`git update-ref refs/heads/${RELEASE_BRANCH} failed: ${output(upd)}`, commit);
  }
  if (!localTag) {
    const t = git(target, ['tag', tag, commit]);
    if (t.status !== 0) return failed(`git tag ${tag} failed: ${output(t)}`, commit);
  }
  const push = remoteGit(['push', '--atomic', 'origin', `refs/heads/${RELEASE_BRANCH}:refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}:refs/tags/${tag}`], { cwd: target });
  if (push.status !== 0) return failed(`git push --atomic origin ${RELEASE_BRANCH} ${tag} failed (the local branch and tag are kept for the re-run):\n${output(push)}`, commit);
  log(`${prefix}: released ${RELEASE_PACKAGE} ${tag} on ${RELEASE_BRANCH} (${short(commit)}) and pushed both to origin.`);
  return { status: 'published', version, commit, reason: null };
}

/**
 * After a merge: release when the merged base's package.json names RELEASE_PACKAGE,
 * the merge moved its version, and the push landed; otherwise one SKIPPED line.
 * @returns {{status: 'published'|'skipped'|'refused'|'failed', version: string|null, commit: string|null, reason: string|null}}
 */
export function releaseAfterMerge({ target, into, baseSha, headSha, pushed, remoteGit = defaultRemoteGit, log = (m) => console.error(m), prefix = 'direct-merge' }) {
  const skip = (reason, version = null) => {
    log(`${prefix}: opencode release SKIPPED: ${reason}.`);
    return { status: 'skipped', version, commit: null, reason };
  };
  const head = packageAt(target, headSha);
  if (head?.json?.name !== RELEASE_PACKAGE) return skip(`package.json names ${head?.json?.name ?? '(no package.json)'}, not ${RELEASE_PACKAGE}`);
  const version = head.json.version ?? null;
  if (!pushed) return skip(`the base was not pushed, so v${version} would release a commit origin does not have`, version);
  const before = packageAt(target, baseSha)?.json?.version ?? null;
  if (!version || version === before) return skip(`the version did not change (${version})`, version);
  return releaseVersion({ target, into, headSha, version, pkgText: head.text, remoteGit, log, prefix });
}

/** The re-run: release the version at `ref`, which origin's `ref` must already contain. */
export function rerunRelease({ target, ref, remoteGit = defaultRemoteGit, log = (m) => console.error(m), prefix = 'opencode-release' }) {
  const skip = (reason, version = null) => {
    log(`${prefix}: opencode release SKIPPED: ${reason}.`);
    return { status: 'skipped', version, commit: null, reason };
  };
  const headSha = revParse(target, `${ref}^{commit}`);
  if (!headSha) return skip(`${ref} does not resolve to a commit in ${target}`);
  const head = packageAt(target, headSha);
  if (head?.json?.name !== RELEASE_PACKAGE) return skip(`package.json at ${ref} names ${head?.json?.name ?? '(no package.json)'}, not ${RELEASE_PACKAGE}`);
  const version = head.json.version ?? null;
  if (!version) return skip(`package.json at ${ref} has no version`);
  const ls = remoteGit(['ls-remote', 'origin', `refs/heads/${ref}`], { cwd: target });
  if (ls.status !== 0) {
    log(`${prefix}: opencode release REFUSED for v${version}: could not read origin (git ls-remote failed).\n${output(ls)}`);
    return { status: 'refused', version, commit: null, reason: 'could not read origin (git ls-remote failed)' };
  }
  const tip = parseLsRemote(ls.stdout).get(`refs/heads/${ref}`) ?? null;
  const onOrigin = tip && (tip === headSha || (revParse(target, `${tip}^{commit}`) && isAncestor(target, headSha, tip)));
  if (!onOrigin) return skip(`${short(headSha)} is not on origin's ${ref}, so v${version} would release a commit origin does not have; push ${ref} first`, version);
  return releaseVersion({ target, into: ref, headSha, version, pkgText: head.text, remoteGit, log, prefix });
}
