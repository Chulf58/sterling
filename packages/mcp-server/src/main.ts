// stdio entry point: sterling-mcp --project <project root>
// (hobby back-compat: sterling-mcp --store <path-to-sterling.db>)
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveStoreRoute } from '@sterling/store/routing';
import { createSterlingServer } from './server.js';
import { recordRuntimeMarker } from './runtime.js';
import { startHookBroker } from './broker.js';

const args = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};
const projectArg = valueOf('--project');
const storeArg = valueOf('--store');
// Exactly one of the two, with a value. --project routes by config.storage
// (SQLite or Postgres); --store opens that SQLite file and refuses a
// project whose storage is 'postgres' (StoreArgInPostgresStorageError).
if ((projectArg === undefined) === (storeArg === undefined) || !(projectArg ?? storeArg)) {
  console.error('usage: sterling-mcp --project <project root>   (or, for a hobby project, --store <path-to-sterling.db>)');
  process.exit(2);
}
const flagName = projectArg !== undefined ? '--project' : '--store';
const pathArg = (projectArg ?? storeArg) as string;

// P5: an unexpanded config placeholder must refuse boot loudly, never open a
// store. Project-scope and --mcp-config configs do NOT env-expand
// ${CLAUDE_PROJECT_DIR} at parse time (research_finding foreign_e518f9e5), so a bare
// placeholder reaches this process literally — proceeding would mkdir a phantom
// '${...}/.sterling/' store at cwd and silently serve an empty knowledge base
// (the 2026-06-24 native-launcher incident).
if (pathArg.includes('${')) {
  console.error(
    `sterling-mcp: ${flagName} path contains an unexpanded placeholder: '${pathArg}' — refusing to create a phantom store (P5). In --mcp-config or project-scope configs use \${CLAUDE_PROJECT_DIR:-.} (plugin-scope configs expand the bare form).`
  );
  process.exit(2);
}

// board b8639752: the store path is made ABSOLUTE here, once, before anything
// derives from it. server.ts computes repoRoot as dirname(dirname(storePath)),
// so the documented `${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db` form —
// which degrades to `./.sterling/sterling.db` when the variable is unset —
// produced the repoRoot string '.'. That value is TRUTHY, so every
// `if (!this.repoRoot)` guard in tools.ts passes it through, and (historically,
// before enforcement_reconcile was removed per decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1) it reached
// enforcement_reconcile as the spawn cwd of a destructive script — the same
// hazard applies to any surviving tools.ts caller that resolves a filesystem
// path against repoRoot: a relative root is resolved against whatever cwd the
// server process happens to hold, which is not necessarily the project.
// EXPORTED as the observation seam: main.ts
// is the stdio entry, so importing it runs the entry — a pin can only read this
// resolution as a named export (spawn a probe that imports main.js with argv
// '--store <relative>' and assert isAbsolute). The pin itself is NOT authored
// here: H5 freezes test paths for pipeline agents (board b8639752 residual).
// With --project, storePath is the local anchor <root>/.sterling/sterling.db:
// the runtime marker, ledgers and locks live beside it in both modes, whether
// or not a SQLite file exists there (Postgres storage has none).
export const projectRoot = projectArg !== undefined ? resolve(projectArg) : undefined;
export const storePath = projectRoot !== undefined ? join(projectRoot, '.sterling', 'sterling.db') : resolve(pathArg);

// The stores open first, so a refused boot (a Postgres store that is missing
// or unreachable, a --store path in a project whose storage is 'postgres')
// writes nothing, not even
// the runtime marker. The error is printed by name and the process exits 1.
let created: ReturnType<typeof createSterlingServer>;
try {
  created = createSterlingServer(projectRoot !== undefined ? { projectRoot } : storePath);
} catch (e) {
  // The class name: ProjectModeError and ProjectIdentityError keep name 'Error'.
  const err = e as Error;
  console.error(`sterling-mcp: ${err?.constructor?.name ?? err?.name ?? 'Error'}: ${err?.message ?? String(e)}`);
  process.exit(1);
}

// stale-server guard (P5/P7): record the build this process is running so H1 can
// detect a server older than the current dist. Fail-open inside — never blocks boot.
recordRuntimeMarker(storePath, dirname(fileURLToPath(import.meta.url)));

await created.server.connect(new StdioServerTransport());

// The hook store broker (decision hook-store-broker-whole-method-rpc-over-local-socket):
// on Postgres storage, hooks reach this server's open stores over a local socket
// instead of each paying its own TLS login. SQLite storage never starts it. A
// broker that cannot start is announced and the server keeps serving tools;
// hooks then open their own connection and say so (DEGRADED).
if (projectRoot !== undefined) {
  const route = resolveStoreRoute(projectRoot);
  if (route?.storage === 'postgres') {
    try {
      const broker = await startHookBroker({ stores: created.store, route, serverDir: dirname(fileURLToPath(import.meta.url)) });
      if (broker === null) {
        console.error('sterling-mcp: the hook store broker is not available on this platform (no Unix sockets with uids); hooks connect to Postgres directly.');
      } else {
        // Remove only this server's own files, on every way out.
        process.on('exit', () => broker.close());
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
          process.once(signal, () => {
            broker.close();
            process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[signal]);
          });
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(`sterling-mcp: the hook store broker did not start (${err?.constructor?.name ?? err?.name ?? 'Error'}: ${err?.message ?? String(e)}); hooks connect to Postgres directly.`);
    }
  }
}
