export type CustomHost = 'claude' | 'opencode' | 'agy';
export const CUSTOM_RENDERER: string;
export const CUSTOM_HOSTS: CustomHost[];
export function outputPath(host: CustomHost, name: string): string;
export function translateTools(
  host: CustomHost,
  agent: { tools?: unknown; disallowedTools?: unknown },
): { ok: true; permission?: Record<string, string>; storeDeny?: boolean; tools?: string[] | null } | { ok: false; reason: string };
export function parseSource(text: string): { frontmatter: string; body: string; data: Record<string, unknown> } | { error: string };
export function detectInstalledHosts(projectRoot: string, opts?: { env?: NodeJS.ProcessEnv; home?: string; probes?: { opencode?: (o: object) => { installed: boolean }; agy?: (o: object) => { installed: boolean } } }): CustomHost[];
export function renderCustomAgent(args: object): { ok: true; name: string; content: string } | { ok: false; reason: string };
export interface CustomSyncReport {
  written: Array<{ key: string; host: CustomHost; path: string; status: 'created' | 'refreshed' }>;
  unchanged: Array<{ key: string; host: CustomHost; path: string }>;
  refused: Array<{ key: string; host: CustomHost | '*'; reason: string; path?: string }>;
  removed: Array<{ key: string; host: CustomHost; path: string }>;
  skipped: Array<{ key: string; reason: string }>;
}
export function planCustomAgents(projectRoot: string, config: { models?: Record<string, object> }, opts?: { hosts?: CustomHost[]; pluginRoot?: string; storeWriteDenies?: string[] }): CustomSyncReport & { ops: Array<{ path: string; content: string | null; previous: string | null }> };
export function syncCustomAgents(projectRoot: string, config: { models?: Record<string, object> }, opts?: { hosts?: CustomHost[]; dryRun?: boolean; pluginRoot?: string; storeWriteDenies?: string[]; env?: NodeJS.ProcessEnv; home?: string; probes?: object }): CustomSyncReport & { dryRun: boolean };
