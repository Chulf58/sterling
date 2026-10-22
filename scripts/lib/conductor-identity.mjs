// THE ONE HOST-NEUTRAL CONDUCTOR CHECK (GitHub #199; decision
// host-neutral-conductor-check-is-one-shared-sterling-predicate).
//
// Sterling's conductor role runs under a different agent name on each host:
// 'sterling/conductor' on OpenCode (.opencode/agents/sterling/), 'conductor' on
// Claude Code. The background maintenance worker is a top-level session too, with
// agent 'sterling-maintenance-worker', so "any top-level session" is no fallback.
// Every Sterling tool and every consuming project's rule that counts conductor
// sessions calls isConductorSession; none keeps its own list of names (anti-pattern
// two-predicates-two-name-grammars-path-containment-drifts-apart).
//
// Consumers reach it from the Sterling root the session start prints:
//   import { isConductorSession } from '<Sterling root>/scripts/lib/conductor-identity.mjs';
//
// isConductorSession(session) is true for a ROOT session (no parent) whose agent is
// the OpenCode conductor, the Claude Code conductor, or absent (OpenCode records no
// agent on a session started under default_agent). `session` is the host's session
// info: `agent` (string, may be absent) and `parentID` (set on a subagent's child
// session, absent on a root). It is false for the maintenance worker, for any child
// session and for any other top-level agent (`build`, `plan`, a user's own agent).
// NOT guaranteed: a session that names no agent but is not the user's (a foreign
// tool's root session) reads as a conductor, because an unnamed root is
// indistinguishable from the default-agent conductor on OpenCode.
//
// STORE-FREE and dependency-free (no @sterling/* import), so a small bin script or a
// bundled hook can import it.

/** The conductor's role name, and its agent name on Claude Code. */
export const CONDUCTOR_ROLE = 'conductor';
/** The conductor's agent name on OpenCode. */
export const CONDUCTOR_AGENT = 'sterling/conductor';
/** The background maintenance worker's agent name on both hosts. */
export const WORKER_AGENT = 'sterling-maintenance-worker';

const CONDUCTOR_AGENTS = new Set([CONDUCTOR_ROLE, CONDUCTOR_AGENT]);

/** Whether `session` is a Sterling conductor session on either host (contract in the file header). */
export function isConductorSession(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.parentID) return false;
  const agent = session.agent;
  if (agent === undefined || agent === null || agent === '') return true;
  return typeof agent === 'string' && CONDUCTOR_AGENTS.has(agent);
}
