// Type declarations for the parts of opencode-install.mjs that TypeScript
// packages import statically (packages/tui/src/controller.ts, the System-tab
// model-change re-rendering the Sterling-full OpenCode agents).
export interface OpenCodeRow {
  item: string;
  status: 'created' | 'matches' | 'refreshed' | 'skipped' | 'refused';
  detail?: string;
  refused?: boolean;
  instruction?: string;
}
export function sterlingRootFrom(moduleUrl?: string): string;
export interface StagedWrite {
  path: string;
  content: string;
  previous: string | null;
}
export type { AtomicWriteFs } from './atomic-write.mjs';
import type { AtomicWriteFs } from './atomic-write.mjs';
export function writeFileAtomic(path: string, content: string, fs?: AtomicWriteFs): void;
export function writeFullAgentFiles(writes: StagedWrite[], fs?: AtomicWriteFs): void;
export function restoreFullAgentFiles(writes: StagedWrite[], fs?: AtomicWriteFs): void;
