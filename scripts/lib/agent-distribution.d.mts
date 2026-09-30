// Type declarations for the parts of agent-distribution.mjs that TypeScript
// packages import statically (packages/tui/src/main.ts, the System-tab swap).
// A static import lets esbuild inline the module into tui/sterling-tui.mjs, so
// the swap runs from an installed copy that has no node_modules.
export interface InstalledHeader {
  headerLine: string;
  pluginVersion: string;
  template: string;
  templateHash: string;
  contentHash: string;
  installedAt: string;
}
export function parseInstalledHeader(content: string): InstalledHeader | null;
export function setInstalledModelEffort(
  installedContent: string,
  opts: { model: string; effort: string; pluginVersion: string; now: string },
): string;
