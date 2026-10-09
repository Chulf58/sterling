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
  /** the role's OpenCode-only override (<provider>/<model>); absent pins anthropic/<model> */
  opencodeModel?: string;
}): { skipped: string; rows?: undefined } | { rows: OpenCodeRow[]; skipped?: undefined };
export interface StagedWrite {
  path: string;
  content: string;
  previous: string | null;
}
export function stageFullAgentModel(opts: {
  projectDir: string;
  pluginRoot: string;
  agents: string[];
  model: string;
  opencodeModel?: string;
}): { skipped: string; rows?: undefined; writes?: undefined } | { rows: OpenCodeRow[]; writes: StagedWrite[]; skipped?: undefined };
export function writeFullAgentFiles(writes: StagedWrite[]): void;
export function restoreFullAgentFiles(writes: StagedWrite[]): void;
