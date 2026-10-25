// The name the plugin registers its MCP server under (config.mjs sets the `sterling`
// entry), and the tool names a host builds from it. Which form a host uses is unobserved
// for OpenCode, so every form seen for this server is accepted: <name>_<tool>,
// <name>_<name>__<tool>, mcp__<name>__<tool> and mcp__plugin_<name>_<name>__<tool>
// (Claude Code's plugin form). A tool of any other server matches none of them.
export const MCP_SERVER_NAME = 'sterling';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const n = escape(MCP_SERVER_NAME);
const STERLING_TOOL = new RegExp(`^(?:${n}_(?:${n}__)?|mcp__(?:plugin_${n}_)?${n}__)([a-z][a-z0-9_]*)$`);

/** The Sterling MCP server's own name for `tool` ('board_claim', ...), or null when `tool` belongs to another server. */
export function sterlingToolName(tool) {
  return typeof tool === 'string' ? (STERLING_TOOL.exec(tool)?.[1] ?? null) : null;
}
