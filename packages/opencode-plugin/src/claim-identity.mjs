// Claim identity for the board claim tools (board item 4da6582b). The MCP server takes
// `session` and `checkout` as free strings from the caller, and its own environment
// (PWD, OPENCODE_SESSION_ID) is stale, so the plugin is the one place that knows who is
// calling: tool.execute.before carries the calling session's id, and session.get gives
// that session's directory. Before a claim tool runs, the plugin writes the real session
// (and, for board_claim and board_takeover, the real checkout) into the call's arguments,
// and refuses a call that names another session. This holds whether or not OpenCode
// gives a worktree directory its own MCP process, which is unobserved.

// The host's name for an MCP tool is unobserved for every host: OpenCode, Claude Code
// (mcp__sterling__board_claim) and a renamed server entry each prefix it differently. So a
// claim tool is recognised by its Sterling tool name as the suffix, whatever the prefix
// (board_update counts only when it names a session).
const CLAIM_TOOLS = ['board_claim', 'board_reaffirm', 'board_release', 'board_takeover', 'board_update'];
// The other board tools the Sterling server serves (packages/mcp-server/src/server.ts).
const OTHER_BOARD_TOOLS = ['board_add', 'board_edit', 'board_get', 'board_query', 'board_remove'];
const SUFFIX = (names) => new RegExp(`(?:^|[^A-Za-z0-9])(${names.join('|')})$`);
const CLAIM_SUFFIX = SUFFIX(CLAIM_TOOLS);
const OTHER_SUFFIX = SUFFIX(OTHER_BOARD_TOOLS);

/**
 * What `tool` is to the claim check: { claim: 'board_claim' | ... } for a claim tool,
 * { claim: null } for any other tool, or { unknown: true } for a Sterling tool whose name
 * mentions board_ but ends in no board tool this plugin knows, which it cannot classify.
 */
export function classifyTool(tool) {
  if (typeof tool !== 'string') return { claim: null };
  const claim = CLAIM_SUFFIX.exec(tool)?.[1];
  if (claim) return { claim };
  if (OTHER_SUFFIX.test(tool)) return { claim: null };
  if (/sterling/i.test(tool) && /board_/.test(tool)) return { unknown: true };
  return { claim: null };
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
  if (name !== 'board_claim' && name !== 'board_takeover') return;
  const found = await checkoutOfSession(real);
  if (!found?.checkout) {
    throw refusal(`Sterling refused ${name}: the checkout of session ${real} could not be read (${found?.why ?? 'no reason given'}), and a claim records the real checkout, never the one a caller names.`);
  }
  args.checkout = found.checkout;
}
