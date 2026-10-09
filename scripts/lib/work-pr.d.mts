// Type declarations for the parts of work-pr.mjs that TypeScript packages
// import statically (packages/tui/src/github-status.ts, the dashboard's
// GitHub status poller).
export function parseOriginRepo(url: string): { host: string; repo: string } | null;
export function readPrLoop(root: string): {
  pr_url: string;
  pr_number: number;
  repo: string;
  head_sha: string;
  armed_at: string;
  status: 'owed' | 'clean' | 'capped' | 'escalated';
  settled_at?: string;
} | null;
