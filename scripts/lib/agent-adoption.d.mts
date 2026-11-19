export const AGENT_SOURCE_DIR: string;
export function sha256(text: string): string;
export function sourcePathOf(key: string): string;
export interface DiscoveredForAdoption {
  host: 'claude' | 'opencode' | 'agy';
  name: string;
  file: string;
  content?: string;
}
export interface AdoptionState {
  sourceFiles: string[];
  configKeys: string[];
  others: Array<{ host: 'claude' | 'opencode' | 'agy'; name: string; content?: string }>;
  hosts?: Array<'claude' | 'opencode' | 'agy'>;
}
export interface AdoptionRefusal {
  code: 'invalid-input' | 'outside-project' | 'unreadable' | 'generated' | 'invalid-name' | 'key-in-use' | 'source-exists' | 'key-collision' | 'ambiguous-duplicate' | 'no-frontmatter' | 'invalid-frontmatter' | 'origin-present' | 'permission-unrepresentable';
  message: string;
}
export interface AdoptionPlan {
  ok: boolean;
  refusals: AdoptionRefusal[];
  key?: string;
  move?: { from: string; to: string };
  contentHash?: string;
  sourceContent?: string;
  origin?: 'claude' | 'opencode' | 'agy';
  duplicates?: Array<{ host: string; name: string }>;
}
export function planAdoption(discovered: DiscoveredForAdoption, state: AdoptionState): AdoptionPlan;
export function readSourceFiles(projectRoot: string): string[];
export function adopt(projectRoot: string, plan: AdoptionPlan): { from: string; to: string; key: string };
