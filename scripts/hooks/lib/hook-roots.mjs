// The two roots a Claude Code session uses, shared by the hooks (common.mjs
// readStdin) and the Claude MCP server's startup (packages/mcp-server/src/main.ts),
// so the two can never disagree about where a session's state lives. Store-free
// on purpose: main.ts and every hook bundle import it without pulling a store in.
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isSterlingRoot } from './store-backend.mjs';
import { resolveProjectRoots } from '../../lib/worktree-root.mjs';

/**
 * The nearest Sterling root above `from` by the plain ancestor walk, or null.
 * This is the legacy hook root: a worktree nested in its main checkout
 * (.claude/worktrees/*) resolves to the main root, as it always has.
 */
export function hookProjectRoot(from) {
  if (!from) return null;
  let dir = resolve(String(from));
  for (;;) {
    if (isSterlingRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root — bounded, never walks forever
    dir = parent;
  }
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * { storeRoot, checkoutRoot } for a Claude Code session in `from`, or null outside
 * a Sterling project.
 *
 * A linked git worktree OUTSIDE its main checkout (scripts/lib/worktree-root.mjs
 * resolveProjectRoots, the classifier the OpenCode plugin uses) splits: storeRoot is
 * the main checkout (store, config, board, ledgers), checkoutRoot is the worktree
 * (transient state, HEAD, files). It is detected before the ancestor walk, so a
 * Sterling directory that merely contains the worktree (a hub holding project/ and
 * project.worktrees/alpha) is never taken for its project. Everything else keeps
 * the legacy walk with both roots equal, nested .claude/worktrees/* included.
 *
 * Does NOT split a nested worktree (its transient state stays the main root's, as
 * before), and inherits resolveProjectRoots' limits: results are cached per
 * directory for the process's life, and a bare-repo main is not recognised.
 */
export function hookRoots(from) {
  const roots = resolveProjectRoots(from, isSterlingRoot);
  if (roots && roots.checkoutRoot !== roots.storeRoot && !isWithin(roots.checkoutRoot, roots.storeRoot)) return roots;
  const root = hookProjectRoot(from);
  return root ? { storeRoot: root, checkoutRoot: root } : null;
}
