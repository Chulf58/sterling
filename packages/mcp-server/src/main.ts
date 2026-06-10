// stdio entry point: sterling-mcp --store <path-to-sterling.db>
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSterlingServer } from './server.js';

const args = process.argv.slice(2);
const storeIdx = args.indexOf('--store');
if (storeIdx === -1 || !args[storeIdx + 1]) {
  console.error('usage: sterling-mcp --store <path-to-sterling.db>');
  process.exit(2);
}

const { server } = createSterlingServer(args[storeIdx + 1]);
await server.connect(new StdioServerTransport());
