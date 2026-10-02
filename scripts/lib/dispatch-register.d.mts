// Type declarations for the parts of dispatch-register.mjs that TypeScript
// packages import statically (packages/tui/src/subagents.ts, the terminal
// dashboard's read-only Sub-agents source). Only lock-free readers are declared.
export interface RegisterEntry {
  agent_id: string;
  session_id: string;
  files: string[];
  at: string;
  agent_type?: string | null;
  round?: number;
  tool_use_id?: string | null;
  ended?: { at: string; event: string };
  [field: string]: unknown;
}

export function registerPath(root: string): string;
export function readRegister(root: string): { availability: 'ok' | 'absent' | 'corrupt'; entries: RegisterEntry[]; dropped: number };
export function dispatchStateDir(root: string): string;
export function dispatchStateKey(toolUseId: unknown): string;
