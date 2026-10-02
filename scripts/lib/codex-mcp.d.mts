// Type declarations for the parts of codex-mcp.mjs that TypeScript packages
// import statically (packages/tui/src/main.ts, the System-tab codex probe).
export function userScopeCodexServer(opts?: {
  env?: Record<string, string | undefined>;
  home?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}): { found: boolean; path: string; unreadable?: string };
