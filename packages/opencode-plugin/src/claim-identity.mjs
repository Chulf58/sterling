// Claim identity for the board claim tools (board item 4da6582b). The MCP server takes
// `session` and `checkout` as free strings from the caller, and its own environment
// (PWD, OPENCODE_SESSION_ID) is stale, so the plugin is the one place that knows who is
// calling: tool.execute.before carries the calling session's id, and session.get gives
// that session's directory. Before a claim tool runs, the plugin writes the real session
// (and, for board_claim and board_takeover, the real checkout) into the call's arguments,
// and refuses a call that names another session. This holds whether or not OpenCode
// gives a worktree directory its own MCP process, which is unobserved.

/** The claim tools by their MCP name; board_update only when it names a session. */
const CLAIM_TOOL = /^(?:.*[_.])?sterling[_.]+(board_(?:claim|reaffirm|release|takeover|update))$/;

/** The Sterling claim tool `tool` names ('board_claim', ...), or null for any other tool. */
export function claimToolOf(tool) {
  return typeof tool === 'string' ? (CLAIM_TOOL.exec(tool)?.[1] ?? null) : null;
}

function refusal(message) {
  return Object.assign(new Error(message), { claimIdentityRefusal: true });
}

/**
 * Fills the real session (and checkout) into a claim tool call, or throws to refuse it.
 * `checkoutOfSession(sessionID)` returns { checkout } or { why }.
 */
export async function applyClaimIdentity(input, { checkoutOfSession }) {
  const name = claimToolOf(input?.tool);
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
