// The 'PR review loop owed' duty on OpenCode (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code,
// parity P9). H10 carries it on Claude Code: it blocks one Stop per session per
// arming and reminds on every other Stop until pr-review-wait.mjs --settle
// settles it. OpenCode has no stop block, so each execution end raises the same
// text as a notice for every owed PR: the full next-action text the first time
// per PR and arming in this plugin process, the short reminder after that.
// The rule (work mode only, status 'owed', an unreadable state disclosed) is
// scripts/hooks/lib/pr-loop-duty.mjs, shared with H10.
import { join } from 'node:path';
import { evaluatePrLoops, prLoopNext, prLoopOwedText, prLoopReminderText } from '../../../scripts/hooks/lib/pr-loop-duty.mjs';
import { sterlingRoot } from './layer.mjs';
import { addNotice } from './notices.mjs';
import { storeRootFor } from '../../../scripts/lib/worktree-root.mjs';

/**
 * Returns `notify(root)`. `root` is the location's checkout: the project mode and the
 * PR-loop markers are read at its store root (direct-merge and pr-review-wait keep them
 * there), and the notices go to the checkout, where this session reads them.
 * `pluginRoot` (the Sterling copy that holds bin/pr-review-wait.mjs) defaults to the resolved root.
 */
export function createPrLoopNotice({ now, pluginRoot } = {}) {
  const stamp = now ?? (() => new Date().toISOString());
  const announced = new Set();
  return function notify(root) {
    const { states, degraded } = evaluatePrLoops(storeRootFor(root));
    const at = stamp();
    if (degraded) addNotice(root, degraded, at);
    // One notice per owed PR (GitHub issue #104): concurrent PRs each keep their own loop.
    for (const state of states) {
      // One key per PR and arming: the full text and every reminder say the same thing, so
      // the conductor sees it once per session, and a re-arm is a new key (notices.mjs).
      const key = `pr-loop-owed:${state.pr_number}:${state.armed_at}`;
      if (announced.has(key)) {
        addNotice(root, prLoopReminderText(state), at, key);
        continue;
      }
      announced.add(key);
      addNotice(root, prLoopOwedText(state, prLoopNext(state, join(pluginRoot ?? sterlingRoot(), 'bin', 'pr-review-wait.mjs'), { host: 'opencode' })), at, key);
    }
  };
}
