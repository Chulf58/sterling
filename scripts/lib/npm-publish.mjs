// The /sterling:merge publish step (decision
// sterling-on-opencode-distributes-as-npm-package-via-opencode-plugin-add):
// after a hobby merge that pushed the base and moved package.json's version,
// publish @chulf58/sterling so `opencode plugin update` can see the release.
//
// Fail closed and loud, never failing the merge: no npm login, a version
// already on the registry, or a registry check that errors all refuse with a
// message and the command to finish by hand. Every other merge (another
// package, an unpushed base, an unchanged version) is a one-line skip.
//
// What ships is the COMMITTED tree of the merge head, extracted with
// `git archive` into a temp dir and published from there with
// --ignore-scripts: the registry package carries the committed bundles, and an
// untracked or gitignored file in the working tree can never leak into it.
// `prepare` (npm run build) is for a developer install of the monorepo and
// would fail in the staged copy, which has no node_modules.
//
// The npm runner is injected (`npm`), so tests never reach the network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExec } from './update.mjs';

export const PUBLISH_PACKAGE = '@chulf58/sterling';

/** The real npm runner: defaultExec handles the Windows .cmd shim (anti-pattern d9494504). */
export const defaultNpm = (args, { cwd } = {}) => defaultExec('npm', args, { cwd, timeout: 300_000 });

function packageAt(target, sha) {
  const r = spawnSync('git', ['show', `${sha}:package.json`], { cwd: target, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** Extract the committed tree at `sha` into `dest` (tracked files only). */
function stageCommit(target, sha, dest) {
  const tar = join(dest, '..', `${sha}.tar`);
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', tar, sha], { cwd: target, encoding: 'utf8', timeout: 120_000 });
  if (archive.status !== 0) throw new Error(`git archive ${sha} failed: ${(archive.stderr || archive.error?.message || '').trim()}`);
  const x = spawnSync('tar', ['-xf', tar, '-C', dest], { encoding: 'utf8', timeout: 120_000 });
  if (x.status !== 0) throw new Error(`tar -xf failed: ${(x.stderr || x.error?.message || '').trim()}`);
}

const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();

/**
 * @returns {{status: 'published'|'skipped'|'refused'|'failed', version: string|null, reason: string|null}}
 */
export function publishAfterMerge({ target, baseSha, headSha, pushed, npm = defaultNpm, log = (m) => console.error(m) }) {
  const skip = (reason, version = null) => {
    log(`direct-merge: npm publish SKIPPED: ${reason}.`);
    return { status: 'skipped', version, reason };
  };
  const head = packageAt(target, headSha);
  if (head?.name !== PUBLISH_PACKAGE) return skip(`package.json names ${head?.name ?? '(no package.json)'}, not ${PUBLISH_PACKAGE}`);
  const version = head.version ?? null;
  if (!pushed) return skip(`the base was not pushed, so ${PUBLISH_PACKAGE}@${version} would publish a release origin does not have`, version);
  const before = packageAt(target, baseSha)?.version ?? null;
  if (!version || version === before) return skip(`the version did not change (${version})`, version);

  const spec = `${PUBLISH_PACKAGE}@${version}`;
  const byHand = `Publish by hand from a clean checkout of the merged base: npm publish --ignore-scripts`;
  const refuse = (headline, detail) => {
    log([``, `direct-merge: npm publish REFUSED for ${spec}: ${headline}`, `THE MERGE STANDS: the base is merged and pushed. Only the npm release is missing.`, detail].filter(Boolean).join('\n'));
    return { status: 'refused', version, reason: headline };
  };

  const who = npm(['whoami'], { cwd: target });
  if (who.status !== 0) {
    return refuse('npm whoami failed (no login, npm missing, or network)', `If npm has no login, run \`npm login\` once; then: ${byHand}\n${output(who)}`);
  }
  const view = npm(['view', spec, 'version'], { cwd: target });
  if (view.status === 0 && view.stdout.trim() === version) {
    return refuse(`${version} is already published on npm.`, `Bump the version in .claude-plugin/plugin.json and package.json for the next release.`);
  }
  const firstPublish = view.status !== 0 && /\bE404\b/.test(output(view));
  if (view.status !== 0 && !firstPublish) {
    return refuse('the registry check failed, so the version could not be verified as unpublished.', `${byHand}\n${output(view)}`);
  }

  const failed = (detail) => {
    log([``, `direct-merge: npm publish FAILED for ${spec}.`, `THE MERGE STANDS: the base is merged and pushed. Only the npm release is missing.`, byHand, detail].join('\n'));
    return { status: 'failed', version, reason: detail };
  };
  const stageRoot = mkdtempSync(join(tmpdir(), 'sterling-publish-'));
  try {
    const dest = join(stageRoot, 'package');
    mkdirSync(dest);
    try {
      stageCommit(target, headSha, dest);
    } catch (e) {
      return failed(`Staging the committed tree failed: ${e.message}`);
    }
    const pub = npm(['publish', '--ignore-scripts'], { cwd: dest });
    if (pub.status !== 0) return failed(output(pub));
    log(`direct-merge: published ${spec} to npm.`);
    return { status: 'published', version, reason: null };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
