// Type declarations for the parts of transcript.mjs that TypeScript packages
// import statically (packages/tui/src/subagents.ts, the Sub-agents block's
// context fill).
export interface TranscriptUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [field: string]: unknown;
}

export function deriveAgentTranscript(parentTranscriptPath: string, agentId: string): string;
export function readTail(path: string, bytes?: number): string | null;
export function latestUsage(path: string): { usage: TranscriptUsage | null; model?: string; reason: string | null };
export function fillPct(usage: TranscriptUsage, windowSize: number): number;
