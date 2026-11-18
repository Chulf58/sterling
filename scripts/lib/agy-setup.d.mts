export function probeAgy(opts: { env?: NodeJS.ProcessEnv; home?: string }): { installed: boolean; reason?: string };
export function setupAgy(opts: { projectDir: string; pluginRoot: string; env?: NodeJS.ProcessEnv; home?: string }): { skipped?: string; root?: string; rows?: Array<{ item?: string; status?: string; refused?: boolean; detail?: string }> };
export const AGY_ROSTER: string[];
export const AGY_AGENTS_DIR: string;
