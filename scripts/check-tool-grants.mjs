// Tool-grant linter (board bc272f83) — commit-time: every registered agent
// template names only REAL Sterling tools, names BOTH MCP prefixes for each
// store tool it grants, and carries ToolSearch when it grants any.
//
// Why this check exists (decision e7a805b6, research_finding 4211a9f7): the
// platform silently ignores a `tools:` entry naming an unmounted tool, so a
// wrong or half-declared grant produces an agent that just lacks the tool and
// reports nothing. That failure shipped twice before anything checked it.
//
// Empty registry passes (the check exists before the members — invariant 3).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintToolGrants, readRegisteredToolNames, collectAgentTemplates } from './lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templates = collectAgentTemplates(join(root, 'agent-templates'));
const registeredTools = readRegisteredToolNames(join(root, 'packages', 'mcp-server', 'src', 'server.ts'));

const violations = templates.flatMap((t) => lintToolGrants(t.content, t.file, registeredTools));
if (violations.length) {
  console.error('tool-grant linter FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  process.exit(1);
}
console.log(`tool-grant linter: ok (${templates.length} template(s), ${registeredTools.size} registered tool(s))`);
