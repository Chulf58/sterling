// Installed-copy predicate (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D). A /plugin-installed Sterling is a snapshot copied into
// ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/ with no git metadata; the
// authoring machine and legacy consumer machines run a git CLONE (a `.git`
// directory, or a `.git` FILE in a worktree). The presence of `.git` at the
// plugin root is the whole test — it drives H1's role text and post-update
// sync, and /sterling:update's refusal on an installed copy.
//
// Builtins only: hooks bundle this module.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** True when `<root>/.git` does not exist (neither a directory nor a worktree file). */
export function isInstalledCopy(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError(`isInstalledCopy: root must be a non-empty path string, got ${JSON.stringify(root)}`);
  }
  return !existsSync(join(root, '.git'));
}
