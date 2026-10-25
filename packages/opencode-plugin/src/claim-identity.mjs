// Claim identity for the board claim tools (board item 4da6582b). The MCP server takes
// `session` and `checkout` as free strings from the caller, and its own environment
// (PWD, OPENCODE_SESSION_ID) is stale, so the plugin is the one place that knows who is
// calling: tool.execute.before carries the calling session's id, and session.get gives
// that session's directory. Before a claim tool runs, the plugin writes the real session
// (and, for board_claim, board_takeover and board_adopt, the real checkout) into the call's arguments,
// and refuses a call that names another session. This holds whether or not OpenCode
// gives a worktree directory its own MCP process, which is unobserved.

import { sterlingToolName } from './mcp-name.mjs';

// A tool is first established as the Sterling MCP server's (mcp-name.mjs: the server
// segment of the host's tool name is the name the plugin registers), then classified by
// its Sterling tool name. Another server's tool, a kanban board_claim say, is never touched.
// board_update counts only when it names a session.
const CLAIM_TOOLS = new Set(['board_claim', 'board_reaffirm', 'board_release', 'board_takeover', 'board_adopt', 'board_update']);
// The other board tools the Sterling server serves (packages/mcp-server/src/server.ts).
const OTHER_BOARD_TOOLS = new Set(['board_add', 'board_edit', 'board_get', 'board_query', 'board_remove']);

/**
 * What `tool` is to the claim check: { claim: 'board_claim' | ... } for a claim tool,
 * { claim: null } for any other tool (every tool of another server), or { unknown: true }
 * for a board_* tool of the Sterling server that this plugin does not know.
 */
export function classifyTool(tool) {
  const name = sterlingToolName(tool);
  if (name === null) return { claim: null };
  if (CLAIM_TOOLS.has(name)) return { claim: name };
  if (OTHER_BOARD_TOOLS.has(name) || !name.startsWith('board_')) return { claim: null };
  return { unknown: true };
}

/** The Sterling claim tool `tool` names ('board_claim', ...), or null for any other tool. */
export function claimToolOf(tool) {
  return classifyTool(tool).claim ?? null;
}

function refusal(message) {
  return Object.assign(new Error(message), { claimIdentityRefusal: true });
}

/**
 * Fills the real session (and checkout) into a claim tool call, or throws to refuse it.
 * `checkoutOfSession(sessionID)` returns { checkout } or { why }.
 */
export async function applyClaimIdentity(input, { checkoutOfSession }) {
  const kind = classifyTool(input?.tool);
  // P5: a board tool the plugin cannot classify may be a claim tool it would let through unchecked.
  if (kind.unknown) {
    throw refusal(`Sterling refused ${input.tool}: it names a Sterling board tool this plugin does not know, so it cannot tell whether the call claims a task and needs your real session. Update Sterling so the plugin and the MCP server match, then call it again.`);
  }
  const name = kind.claim;
  if (!name) return;
  const args = input.input && typeof input.input === 'object' ? input.input : null;
  if (name === 'board_update' && (args === null || args.session === undefined)) return;
  const real = input.sessionID;
  if (typeof real !== 'string' || !real) {
    throw refusal(`Sterling refused ${name}: OpenCode gave no session id for this call, so the claim cannot be tied to your session.`);
  }
  if (args === null) throw refusal(`Sterling refused ${name}: the call has no arguments object to carry your session (${real}).`);
  if (args.session !== undefined && args.session !== real) {
    throw refusal(`Sterling refused ${name}: it names session '${String(args.session)}', but this call comes from session ${real}. A session can claim, renew or release only as itself; call again with session '${real}', or leave session out and Sterling fills it in.`);
  }
  args.session = real;
  if (name !== 'board_claim' && name !== 'board_takeover' && name !== 'board_adopt') return;
  const found = await checkoutOfSession(real);
  if (!found?.checkout) {
    throw refusal(`Sterling refused ${name}: the checkout of session ${real} could not be read (${found?.why ?? 'no reason given'}), and a claim records the real checkout, never the one a caller names.`);
  }
  args.checkout = found.checkout;
}
