// Type declarations for the parts of opencode-install.mjs that TypeScript
// packages import statically (packages/tui/src/controller.ts, the System-tab
// swap re-rendering the Sterling-full OpenCode agents).
export interface OpenCodeRow {
  item: string;
  status: 'created' | 'matches' | 'refreshed' | 'skipped' | 'refused';
  detail?: string;
  refused?: boolean;
  instruction?: string;
}
export function sterlingRootFrom(moduleUrl?: string): string;
export function swapFullAgentModel(opts: {
  projectDir: string;
  pluginRoot: string;
  agents: string[];
  model: string;
}): { skipped: string; rows?: undefined } | { rows: OpenCodeRow[]; skipped?: undefined };
