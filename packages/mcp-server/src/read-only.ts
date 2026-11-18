// Read-only mode (--read-only): the Sterling MCP server that a read-only role
// declares on Antigravity CLI (agy), under the entry name 'sterling-ro' (decision
// antigravity-cli-agy-read-only-role-guard-read-the-agent-role). agy's tools:
// list cannot hold back single MCP tools, but an agent reaches only the servers
// it declares, so the refusal lives here: every store-write tool is registered
// with a handler that refuses, under a description that says so and an input
// schema that takes any arguments (so a call is refused, never argued over);
// nothing else changes. The write tools are the
// one shared list (scripts/lib/store-write-tools.mjs, read from the implementor
// template's disallowedTools). An empty or unreadable list refuses boot, so a
// broken install never serves a read-only role an unguarded server.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readStoreWriteToolNames } from '../../../scripts/lib/store-write-tools.mjs';

/**
 * The store-write tool names a read-only server refuses. `pluginRoot` is the
 * Sterling root holding agent-templates/ (null when none was found). Throws,
 * naming the cause, when the root is missing, the template cannot be read or
 * it names no store-write tool.
 */
export function readOnlyWriteTools(pluginRoot: string | null): string[] {
  if (!pluginRoot) throw new Error('--read-only: no Sterling root (.claude-plugin/plugin.json) above the server, so the store-write tool list cannot be read');
  let names: string[];
  try {
    names = readStoreWriteToolNames(pluginRoot);
  } catch (e) {
    throw new Error(`--read-only: the store-write tool list could not be read from ${pluginRoot}/agent-templates/implementor.md (${(e as Error)?.message ?? String(e)})`);
  }
  if (names.length === 0) throw new Error(`--read-only: ${pluginRoot}/agent-templates/implementor.md names no mcp__sterling__ tool in disallowedTools, so there is nothing to refuse`);
  return names;
}

/** The text a read-only server answers a store-write call with. */
export function readOnlyRefusal(name: string): string {
  return `${name} writes the Sterling store, and this server runs with --read-only for a read-only role (reviewer, researcher, scout, sparring, preflight). Put what you would record into your report; the conductor writes the store.`;
}

/**
 * Make every later registerTool of a name in `writeTools` register a handler
 * that refuses. Install it before the first registerTool. Returns the names it
 * saw registered, so the caller can check every listed tool exists.
 */
export function guardReadOnlyTools(server: McpServer, writeTools: ReadonlySet<string>): ReadonlySet<string> {
  type Handler = (...a: unknown[]) => unknown;
  const seen = new Set<string>();
  const register = server.registerTool.bind(server) as unknown as (name: string, config: unknown, cb: Handler) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
    if (!writeTools.has(name)) return register(name, config, cb);
    seen.add(name);
    const refused = { description: `REFUSED on this server: ${readOnlyRefusal(name)}`, inputSchema: z.object({}).passthrough() };
    return register(name, refused, () => {
      throw new Error(readOnlyRefusal(name));
    });
  };
  return seen;
}
