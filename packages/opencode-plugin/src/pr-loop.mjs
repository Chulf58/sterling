// The 'PR review loop owed' duty on OpenCode (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code,
// parity P9). H10 carries it on Claude Code: it blocks one Stop per session per
// arming and reminds on every other Stop until pr-review-wait.mjs --settle
// changes .sterling/transient/pr-loop.json. OpenCode has no stop block, so each
// execution end raises the same text as a notice: the full next-action text the
// first time per arming in this plugin process, the short reminder after that.
// The rule (work mode only, status 'owed', an unreadable state disclosed) is
// scripts/hooks/lib/pr-loop-duty.mjs, shared with H10.
import { join } from 'node:path';
import { evaluatePrLoop, prLoopNext, prLoopOwedText, prLoopReminderText } from '../../../scripts/hooks/lib/pr-loop-duty.mjs';
import { sterlingRoot } from './layer.mjs';
import { addNotice } from './notices.mjs';

/** Returns `notify(root)`; `pluginRoot` (the Sterling copy that holds bin/pr-review-wait.mjs) defaults to the resolved root. */
export function createPrLoopNotice({ now, pluginRoot } = {}) {
  const stamp = now ?? (() => new Date().toISOString());
  const announced = new Set();
  return function notify(root) {
    const { state, degraded } = evaluatePrLoop(root);
    const at = stamp();
    if (degraded) addNotice(root, degraded, at);
    if (!state) return;
    if (announced.has(state.armed_at)) {
      addNotice(root, prLoopReminderText(state), at);
      return;
    }
    announced.add(state.armed_at);
    addNotice(root, prLoopOwedText(state, prLoopNext(state, join(pluginRoot ?? sterlingRoot(), 'bin', 'pr-review-wait.mjs'))), at);
  };
}
