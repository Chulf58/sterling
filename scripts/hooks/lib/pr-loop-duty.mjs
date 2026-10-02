// The 'PR review loop owed' duty rule (decision
// project-mode-hobby-work-toggle-decides-flow, slice S3), shared by H10 (the
// Claude Code Stop hook) and the OpenCode plugin's settlement notice
// (packages/opencode-plugin/src/pr-loop.mjs): when the duty is owed, what an
// unevaluable state says, and the next-action text. Each host keeps its own
// delivery (H10 blocks once per session and reminds on every other Stop; the
// plugin raises a notice), so the two cannot drift on what "owed" means.
import { readProjectMode } from '../../lib/handoff-projection.mjs';
import { PR_LOOP_REL, readPrLoop } from '../../lib/work-pr.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const errMessage = (e) => String((e && e.message) || e);

/**
 * Whether the loop is owed in the project at `root`: { state, degraded }.
 * `state` is the armed loop, only when the project is WORK and its status is
 * 'owed', else null. `degraded` is a disclosure line when the answer cannot be
 * known (an unreadable mode with a loop file present, or an unreadable loop
 * file in a work project); an armed loop is never silently suppressed.
 */
export function evaluatePrLoop(root) {
  let mode;
  try {
    mode = readProjectMode(root);
  } catch (e) {
    if (existsSync(join(root, PR_LOOP_REL))) {
      return {
        state: null,
        degraded: `• PR review loop: the project mode is unreadable (${errMessage(e)}) — ${PR_LOOP_REL} exists but its state was not evaluated. Fix config.mode (TUI System tab); if it is a work project, a PR review loop may be owed.`,
      };
    }
    return { state: null, degraded: null };
  }
  if (mode !== 'work') return { state: null, degraded: null };
  let state;
  try {
    state = readPrLoop(root);
  } catch (e) {
    return { state: null, degraded: `• PR review loop: ${PR_LOOP_REL} is unreadable (${errMessage(e)}) — whether a loop is owed is UNKNOWN; rerun /sterling:merge to re-arm it, or delete the file if no PR is open.` };
  }
  if (!state || state.status !== 'owed') return { state: null, degraded: null };
  return { state, degraded: null };
}

/** The next action; `waitScript` is how the host names pr-review-wait.mjs. */
export function prLoopNext(state, waitScript) {
  return (
    `run the pr-review-loop skill: wait with node "${waitScript}" ${state.pr_url} (background), disposition each finding, push fixes via /sterling:merge; ` +
    `when the loop ends, settle it: node "${waitScript}" --settle <clean|capped|escalated> --pr ${state.pr_number}. ` +
    `Ending the session mid-loop: board item pointing at the PR + the PR link and next action in the rotation note.`
  );
}

export const prLoopOwedText = (state, next) =>
  `• PR review loop owed (work mode): PR #${state.pr_number} ${state.pr_url} (head ${String(state.head_sha ?? '?').slice(0, 7)}, armed ${state.armed_at}) — ${next}`;

export const prLoopReminderText = (state) => `PR review loop owed: PR #${state.pr_number} ${state.pr_url} — next: pr-review-loop skill, then --settle clean|capped|escalated --pr ${state.pr_number}.`;
