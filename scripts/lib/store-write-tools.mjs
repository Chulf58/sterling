// The Sterling store-write tool names, read from the implementor template's
// disallowedTools: the one list of what a non-writing agent may not call. Each
// host adds its own prefix (OpenCode `sterling_<tool>` in
// scripts/lib/opencode-install.mjs storeWriteTools; agy matches the bare name in
// scripts/hooks/lib/agy-role-guard.mjs). Builtins only, because the agy role
// guard bundles it into a hook (no workspace imports at runtime).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The implementor template these names are read from, under a Sterling root. */
export function implementorTemplatePath(pluginRoot) {
  return join(pluginRoot, 'agent-templates', 'implementor.md');
}

/**
 * The bare store-write tool names (knowledge_create, board_add, ...) in the order
 * the implementor template's disallowedTools lists them, each once. Empty when the
 * frontmatter has no disallowedTools line or no mcp__sterling__ entry; the caller
 * decides how to refuse. Throws when the template cannot be read.
 */
export function readStoreWriteToolNames(pluginRoot) {
  const text = readFileSync(implementorTemplatePath(pluginRoot), 'utf8').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const list = fm.match(/^disallowedTools:\s*(.+)$/m)?.[1] ?? '';
  return [...new Set(list.split(',').map((t) => t.trim().match(/^mcp__sterling__(\w+)$/)?.[1]).filter(Boolean))];
}
