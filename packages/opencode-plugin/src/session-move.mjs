// The session-move guard: refuses an OpenCode session_move that would strand a session
// running a Sterling agent in a directory where OpenCode cannot find that agent.
//
// OpenCode 2.1.2 resolves a session's agent on every turn from the agent registry of the
// session's CURRENT directory (SessionContext.select -> Agent.select; a miss raises
// Session.AgentNotFoundError, `Agent not found: "<agent>"`). Project agents are loaded
// from `.opencode/agents/` in that directory and its parents. Sterling installs its
// roster in `.opencode/agents/sterling/` and keeps `/.opencode/` git-excluded, so a git
// worktree outside the project tree has no Sterling agents: a lane that moves its session
// into one (OpenCode's own system prompt suggests session_move after worktree_create)
// runs until the move, then every later turn and every resume by sessionID fails with
// Agent not found (GitHub #189, #192, #193, #197). Measured with `opencode debug agents`
// on 2.1.2: a project dir and a worktree nested inside it list sterling/implementor; a
// sibling worktree of the same repo does not.
//
// The tool reaches execute.before as `opencode_session_move` (namespace `opencode`,
// Tool id `<namespace>_<name>`; code-mode calls trigger execute.before with that id),
// with input { sessionID?, directory }; the directory is relative to the moved session's
// directory or absolute, and may start with ~.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { agentVisibleFrom } from '../../../scripts/lib/opencode-install.mjs';
import { agentRole } from './agent-name.mjs';

const MOVE_TOOLS = new Set(['opencode_session_move', 'session_move']);

/** Whether `tool` is OpenCode's session_move. */
export function isSessionMove(tool) {
  return MOVE_TOOLS.has(tool);
}

/** `dir` with a leading ~ expanded and a relative path resolved against `base`. */
export function moveTarget(dir, base, home = homedir()) {
  let d = String(dir);
  if (d === '~') d = home;
  else if (d.startsWith('~/') || d.startsWith('~\\')) d = join(home, d.slice(2));
  return isAbsolute(d) ? resolve(d) : resolve(base, d);
}

const isAbsoluteMove = (dir) => dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\') || isAbsolute(dir);
const sterlingAgent = (agent) => typeof agent === 'string' && agentRole(agent) !== agent;

/** The refusal for moving session `sessionID` (agent `agent`) to `target`. */
export function sessionMoveRefusal(sessionID, agent, target) {
  return `Sterling refused this session_move: session ${sessionID} runs agent ${agent}, and OpenCode looks up a session's agent in the session's current directory on every turn. OpenCode started in ${target} would not see ${agent} (no .opencode/agents/${agent}.md there or in a parent, and no config entry for it; Sterling keeps .opencode/ untracked, so a git worktree outside the project has none), so after the move every turn and every resume of this session would fail with 'Agent not found: "${agent}"' (GitHub #189). Stay in this directory and work in ${target} by path (the shell tool's workdir, absolute file paths), or copy the project's .opencode/agents/sterling/ into ${target} first and move again.`;
}

/** The refusal when the check itself could not run: the move is not let through unchecked. */
export function sessionMoveUncheckedRefusal(why) {
  return `Sterling refused this session_move: it could not check whether the moved session's agent would still be found at the destination (${why}). A move OpenCode cannot resolve the agent after makes every later turn fail with 'Agent not found' (GitHub #189), so an unchecked move is not let through. Try the move again; if it keeps failing, stay in this directory and work at the destination by path.`;
}

function refuse(message) {
  const e = new Error(message);
  e.sessionMoveRefusal = true;
  return e;
}

/**
 * The execute.before check, fail closed: throws a refusal (an Error with
 * sessionMoveRefusal) when the call is a session_move of a session running a Sterling
 * agent to a directory OpenCode would not resolve that agent from, and when that cannot
 * be established. For a move of the caller's own session the hook's `agent` is trusted,
 * and an absolute destination needs no lookup; otherwise `sessionInfo(id)` (session.get:
 * { agent, directory }) must succeed. Any other throw is the caller's to turn into a refusal.
 */
export async function checkSessionMove(input, { sessionInfo, env = process.env, home = homedir() } = {}) {
  if (!isSessionMove(input?.tool)) return;
  const args = input.input ?? {};
  if (typeof args.directory !== 'string' || !args.directory) return;
  const moved = typeof args.sessionID === 'string' && args.sessionID ? args.sessionID : input.sessionID;
  const ownWithAgent = moved === input.sessionID && typeof input.agent === 'string' && input.agent !== '';
  if (ownWithAgent && !sterlingAgent(input.agent)) return;
  let info = null;
  if (!ownWithAgent || !isAbsoluteMove(args.directory)) {
    try {
      info = await sessionInfo(moved);
    } catch (e) {
      throw refuse(sessionMoveUncheckedRefusal(`session.get for session ${moved} failed: ${e?.message ?? e}`));
    }
  }
  const agent = ownWithAgent ? input.agent : info?.agent;
  if (typeof agent !== 'string' || !agent) throw refuse(sessionMoveUncheckedRefusal(`session.get gave no agent for session ${moved}`));
  // Only a Sterling agent (sterling/<role>) is guarded: it is the one Sterling installs per project.
  if (!sterlingAgent(agent)) return;
  let target;
  if (isAbsoluteMove(args.directory)) target = moveTarget(args.directory, '/', home);
  else {
    if (typeof info?.directory !== 'string' || !info.directory) throw refuse(sessionMoveUncheckedRefusal(`session.get gave no location.directory for session ${moved}`));
    target = moveTarget(args.directory, info.directory, home);
  }
  if (!existsSync(target)) return;
  const seen = agentVisibleFrom({ dir: target, name: agent, env, home });
  if (seen.visible) return;
  if (seen.problems.length) throw refuse(sessionMoveUncheckedRefusal(`${seen.problems.map((p) => p.item).join(', ')} could not be read, so whether ${target} defines ${agent} is unknown`));
  throw refuse(sessionMoveRefusal(moved, agent, target));
}
