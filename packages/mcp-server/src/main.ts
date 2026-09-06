// stdio entry point: sterling-mcp --store <path-to-sterling.db>
import { dirname, resolve } from 'node:path';
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
const storePathArg = args[storeIdx + 1];

// P5: an unexpanded config placeholder must refuse boot loudly, never open a
// store. Project-scope and --mcp-config configs do NOT env-expand
// ${CLAUDE_PROJECT_DIR} at parse time (research_finding e518f9e5), so a bare
// placeholder reaches this process literally — proceeding would mkdir a phantom
// '${...}/.sterling/' store at cwd and silently serve an empty knowledge base
// (the 2026-06-24 native-launcher incident).
if (storePathArg.includes('${')) {
  console.error(
    `sterling-mcp: --store path contains an unexpanded placeholder: '${storePathArg}' — refusing to create a phantom store (P5). In --mcp-config or project-scope configs use \${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db (plugin-scope configs expand the bare form).`
  );
  process.exit(2);
}

// board b8639752: the store path is made ABSOLUTE here, once, before anything
// derives from it. server.ts computes repoRoot as dirname(dirname(storePath)),
// so the documented `${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db` form —
// which degrades to `./.sterling/sterling.db` when the variable is unset —
// produced the repoRoot string '.'. That value is TRUTHY, so every
// `if (!this.repoRoot)` guard in tools.ts passes it through, and it reaches
// enforcement_reconcile as the spawn cwd of a DESTRUCTIVE script: a relative
// root is resolved against whatever cwd the server process happens to hold,
// which is not necessarily the project. EXPORTED as the observation seam: main.ts
// is the stdio entry, so importing it runs the entry — a pin can only read this
// resolution as a named export (spawn a probe that imports main.js with argv
// '--store <relative>' and assert isAbsolute). The pin itself is NOT authored
// here: H5 freezes test paths for pipeline agents (board b8639752 residual).
export const storePath = resolve(storePathArg);

// stale-server guard (P5/P7): record the build this process is running so H1 can
// detect a server older than the current dist. Fail-open inside — never blocks boot.
recordRuntimeMarker(storePath, dirname(fileURLToPath(import.meta.url)));

const { server } = createSterlingServer(storePath);
await server.connect(new StdioServerTransport());
