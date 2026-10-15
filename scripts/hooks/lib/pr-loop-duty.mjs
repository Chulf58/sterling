// The 'PR review loop owed' duty rule (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3), shared by H10 (the
// Claude Code Stop hook) and the OpenCode plugin's settlement notice
// (packages/opencode-plugin/src/pr-loop.mjs): when the duty is owed, what an
// unevaluable state says, and the next-action text. Each host keeps its own
// delivery (H10 blocks once per session and reminds on every other Stop; the
// plugin raises a notice), so the two cannot drift on what "owed" means.
import { readProjectMode } from '../../lib/handoff-projection.mjs';
import { PR_LOOP_REL, PR_LOOPS_DIR_REL, prLoopStateExists, readPrLoops } from '../../lib/work-pr.mjs';

const errMessage = (e) => String((e && e.message) || e);
const LOOP_FILES = `${PR_LOOPS_DIR_REL}/ or ${PR_LOOP_REL}`;

/**
 * Every loop owed in the project at `root`: { states, degraded }. `states` is
 * the armed loops whose status is 'owed', oldest arming first, and only when
 * the project is WORK; one per PR (GitHub issue #104). `degraded` is a
 * disclosure line when the answer cannot be known (an unreadable mode with
 * loop state present, or an unreadable loop file in a work project); an armed
 * loop is never silently suppressed.
 */
export function evaluatePrLoops(root) {
  let mode;
  try {
    mode = readProjectMode(root);
  } catch (e) {
    if (prLoopStateExists(root)) {
      return {
        states: [],
        degraded: `• PR review loop: the project mode is unreadable (${errMessage(e)}) — PR loop state exists (${LOOP_FILES}) but its state was not evaluated. Fix config.mode (TUI System tab); if it is a work project, a PR review loop may be owed.`,
      };
    }
    return { states: [], degraded: null };
  }
  if (mode !== 'work') return { states: [], degraded: null };
  let loops;
  try {
    loops = readPrLoops(root);
  } catch (e) {
    return { states: [], degraded: `• PR review loop: ${e?.rel ?? LOOP_FILES} is unreadable (${errMessage(e)}) — whether a loop is owed is UNKNOWN; rerun /sterling:merge to re-arm it, or delete the file if its PR is not open.` };
  }
  return { states: loops.filter((s) => s.status === 'owed'), degraded: null };
}

/**
 * The single-loop view of evaluatePrLoops, for a host that nags about one
 * loop at a time (H10): { state, degraded }, `state` being the OLDEST owed
 * loop, so each owed loop comes up once the ones before it are settled.
 */
export function evaluatePrLoop(root) {
  const { states, degraded } = evaluatePrLoops(root);
  return { state: states[0] ?? null, degraded };
}

/** The next action; `waitScript` is how the host names pr-review-wait.mjs.
 * `host` 'opencode' words the wait the OpenCode way (GitHub issue #100): the
 * bare "(background)" of the Claude Code text read as "detach it" there. On
 * OpenCode the wait runs with the shell tool's `background: true`, which
 * notifies the session when it ends; never nohup or &, whose death nobody
 * hears (issue #79). User-ruled 2026-10-15, "Background (Recommended)". */
export function prLoopNext(state, waitScript, { host = 'claude-code' } = {}) {
  const wait =
    host === 'opencode'
      ? `wait with node "${waitScript}" ${state.pr_url} (add --request-copilot on the first wait after a push) started with the shell tool's background: true, which notifies you when it ends; never detach it with nohup or &`
      : `wait with node "${waitScript}" ${state.pr_url} (background)`;
  return (
    `run the pr-review-loop skill: ${wait}, disposition each finding, push fixes via /sterling:merge; ` +
    `when the loop ends, settle it: node "${waitScript}" --settle <clean|capped|escalated> --pr ${state.pr_number}. ` +
    `Ending the session mid-loop: board item pointing at the PR + the PR link and next action in the rotation note.`
  );
}

export const prLoopOwedText = (state, next) =>
  `• PR review loop owed (work mode): PR #${state.pr_number} ${state.pr_url} (head ${String(state.head_sha ?? '?').slice(0, 7)}, armed ${state.armed_at}) — ${next}`;

export const prLoopReminderText = (state) => `PR review loop owed: PR #${state.pr_number} ${state.pr_url} — next: pr-review-loop skill, then --settle clean|capped|escalated --pr ${state.pr_number}.`;
