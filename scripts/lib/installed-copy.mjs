// Installed-copy predicate (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D). An installed Sterling is a snapshot copied into one of the install
// roots that scripts/lib/sterling-roots.mjs names: Claude Code's plugin cache (a
// /plugin install) or OpenCode's npm cache (`opencode plugin add`). What the snapshot
// holds depends on the source (findings 429e6526, 6308c991): a GitHub source carries
// the tracked HEAD tree only; a directory source copies the working tree minus .git,
// so gitignored files DO come along. The predicate therefore never reasons about
// which files the copy holds. The authoring machine and legacy consumer machines run
// a git CLONE (a `.git` directory, or a `.git` FILE in a worktree). TWO INDEPENDENT
// SIGNALS, either one sufficient: (1) no `.git` at the plugin root (both measured
// sources drop it); (2) the root resolves (realpath) under an install root of either
// host, which holds whatever the install copies. The predicate drives H1's role text
// and post-update sync, and /sterling:update's refusal on an installed copy.
//
// Builtins only: hooks bundle this module.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installHostOf } from './sterling-roots.mjs';

/** True when `<root>/.git` does not exist (neither a directory nor a worktree file),
 *  OR when root resolves under an install root of either host. env/home are injectable for tests. */
export function isInstalledCopy(root, { env = process.env, home = homedir() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError(`isInstalledCopy: root must be a non-empty path string, got ${JSON.stringify(root)}`);
  }
  if (!existsSync(join(root, '.git'))) return true;
  return installHostOf(root, { env, home }) !== null;
}
