// stdio entry point: sterling-mcp --store <path-to-sterling.db>
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSterlingServer } from './server.js';
import { recordRuntimeMarker } from './runtime.js';

const args = process.argv.slice(2);
const storeIdx = args.indexOf('--store');
if (storeIdx === -1 || !args[storeIdx + 1]) {
  console.error('usage: sterling-mcp --store <path-to-sterling.db>');
  process.exit(2);
}
const storePath = args[storeIdx + 1];

// P5: an unexpanded config placeholder must refuse boot loudly, never open a
// store. Project-scope and --mcp-config configs do NOT env-expand
// ${CLAUDE_PROJECT_DIR} at parse time (research_finding e518f9e5), so a bare
// placeholder reaches this process literally — proceeding would mkdir a phantom
// '${...}/.sterling/' store at cwd and silently serve an empty knowledge base
// (the 2026-06-24 native-launcher incident).
if (storePath.includes('${')) {
  console.error(
    `sterling-mcp: --store path contains an unexpanded placeholder: '${storePath}' — refusing to create a phantom store (P5). In --mcp-config or project-scope configs use \${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db (plugin-scope configs expand the bare form).`
  );
  process.exit(2);
}

// stale-server guard (P5/P7): record the build this process is running so H1 can
// detect a server older than the current dist. Fail-open inside — never blocks boot.
recordRuntimeMarker(storePath, dirname(fileURLToPath(import.meta.url)));

const { server } = createSterlingServer(storePath);
await server.connect(new StdioServerTransport());
