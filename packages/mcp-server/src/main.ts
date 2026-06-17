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

// stale-server guard (P5/P7): record the build this process is running so H1 can
// detect a server older than the current dist. Fail-open inside — never blocks boot.
recordRuntimeMarker(storePath, dirname(fileURLToPath(import.meta.url)));

const { server } = createSterlingServer(storePath);
await server.connect(new StdioServerTransport());
