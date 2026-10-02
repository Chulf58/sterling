// Re-run the OpenCode release (scripts/lib/opencode-release.mjs) for the version
// at a ref origin already has: what /sterling:merge prints after a refused or
// failed release (decision sterling-on-opencode-installs-from-a-git-release-branch-v2).
// Builtins only, so it runs from the source tree with no build.
//   node scripts/opencode-release.mjs [--target <dir>] [--ref <branch>]
// Prints {opencode_release, version, commit, reason} on stdout and exits 0 only
// when the release is on origin.
import { resolve } from 'node:path';
import { rerunRelease } from './lib/opencode-release.mjs';

const argv = process.argv.slice(2);
const known = new Set(['--target', '--ref']);
const opts = {};
for (let i = 0; i < argv.length; i += 2) {
  const value = argv[i + 1];
  if (!known.has(argv[i]) || !value || value.startsWith('--')) {
    console.error(`opencode-release: unrecognized or incomplete argument '${argv[i]}'; usage: opencode-release.mjs [--target <dir>] [--ref <branch>]`);
    process.exit(2);
  }
  opts[argv[i]] = value;
}
const result = rerunRelease({ target: resolve(opts['--target'] ?? process.cwd()), ref: opts['--ref'] ?? 'main' });
console.log(JSON.stringify({ opencode_release: result.status, version: result.version, commit: result.commit, reason: result.reason }, null, 2));
process.exit(result.status === 'published' ? 0 : 1);
