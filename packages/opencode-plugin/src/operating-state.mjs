// H1's host-neutral operating-state lines for the OpenCode conductor's context
// (board cbee2b3d, audit f2ba68c2 row 2): MACHINE ROLE, TDD posture, Project mode,
// the pending Sterling issue-report count and the undeclared-source scan. The line
// text and the config reading are scripts/hooks/lib/operating-state.mjs, shared
// with h1-session-start.mjs.
// The deep-queue and reconcile-backlog lines are scripts/hooks/lib/maintenance-state.mjs.
// Left to Claude Code, with the reason: agent currency and the conductor-activation
// diagnostic (both read .claude/agents and .claude/settings.json), the INSTALLED
// PLUGIN role text (it names /plugin's Installed tab), the clone-behind probe (it
// fetches and tells the user to relaunch the Claude Code CLI) and the plan-lock,
// rotation, dispatch-residue and registry sections (their writers are Claude hooks).
import { computeUndeclaredSourceDisclosure } from '../../../scripts/hooks/lib/undeclared-source-scan.mjs';
import { renderUnavailable } from '../../../scripts/hooks/lib/undeclared-source.mjs';
import { queueDepthLine, reconcileBacklog } from '../../../scripts/hooks/lib/maintenance-state.mjs';
import { machineRoleLine, pendingIssueReportsLine, projectModeLine, readProjectConfig, tddPostureLine } from '../../../scripts/hooks/lib/operating-state.mjs';
import { samePath } from '../../../scripts/lib/post-update-sync.mjs';

/**
 * The config-derived lines, read live on every request so a TUI toggle shows on
 * the next turn. `pluginRoot` is the resolved Sterling root, or null when it could
 * not be resolved (the MACHINE ROLE line is then not stated). Returns the lines
 * and the config the undeclared-source scan reads.
 */
export function operatingStateLines(root, pluginRoot) {
  const { config, configUnreadable } = readProjectConfig(root);
  const atClone = Boolean(pluginRoot && samePath(root, pluginRoot));
  const lines = [machineRoleLine({ atClone, installedCopy: false, config, host: 'opencode' }), tddPostureLine({ config, configUnreadable }), projectModeLine({ config, configUnreadable }), pendingIssueReportsLine({ cwd: root, pluginRoot })].filter(Boolean);
  return { lines, config };
}

/**
 * The undeclared-source disclosure, or '' when every tracked source file is
 * covered. An abnormal shape renders as one UNAVAILABLE line, never silence
 * (decision undeclared-source-disclosure-per-file-coverage-live-h1-scan).
 */
export function undeclaredSourceBlock(root, config) {
  try {
    return computeUndeclaredSourceDisclosure({ cwd: root, config }) ?? '';
  } catch (e) {
    return renderUnavailable(`unexpected error: ${(e && e.message) || e}`);
  }
}

/**
 * The maintenance-queue lines (the deep-queue signal and the reconcile backlog)
 * for a state read by `readMaintenanceState`. `config` supplies the deep-queue
 * threshold. Both lines are '' when there is nothing to say.
 */
export function maintenanceLines(state, config, root) {
  const queue = queueDepthLine({ ...state, deepThreshold: config?.maintenance_queue?.deep_threshold });
  const backlog = reconcileBacklog({ reconcile: state.reconcile, cwd: root });
  return [queue, backlog.line].filter(Boolean);
}
