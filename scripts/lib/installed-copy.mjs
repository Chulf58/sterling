// Installed-copy predicate (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D). A /plugin-installed Sterling is a snapshot copied into
// ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/. What the snapshot holds depends
// on the marketplace source (findings 429e6526, 6308c991): a GitHub source carries
// the tracked HEAD tree only; a directory source copies the working tree minus .git,
// so gitignored files DO come along. The predicate therefore never reasons about
// which files the copy holds. The authoring machine and legacy consumer machines run
// a git CLONE (a `.git` directory, or a `.git` FILE in a worktree). TWO INDEPENDENT
// SIGNALS, either one sufficient: (1) no `.git` at the plugin root (both measured
// sources drop it); (2) the root resolves (realpath) under Claude Code's plugin
// cache, <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/cache/, which holds whatever the
// install copies. The predicate drives H1's role text and post-update sync, and
// /sterling:update's refusal on an installed copy.
//
// Builtins only: hooks bundle this module.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// realpath when the path exists; a path that does not exist cannot be reached
// through a symlink, so its plain resolved form is its identity.
function canonical(p) {
  try {
    return realpathSync(p);
  } catch (err) {
    if (err?.code === 'ENOENT') return resolve(p);
    throw err;
  }
}

/** Claude Code's plugin cache: <CLAUDE_CONFIG_DIR or <home>/.claude>/plugins/cache. */
export function pluginCacheDir({ env = process.env, home = homedir() } = {}) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins', 'cache');
}

/** True when `<root>/.git` does not exist (neither a directory nor a worktree file),
 *  OR when root resolves under the plugin cache. env/home are injectable for tests. */
export function isInstalledCopy(root, { env = process.env, home = homedir() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError(`isInstalledCopy: root must be a non-empty path string, got ${JSON.stringify(root)}`);
  }
  if (!existsSync(join(root, '.git'))) return true;
  const cache = canonical(pluginCacheDir({ env, home }));
  const real = canonical(root);
  return real.startsWith(cache + sep);
}
