// Type declarations for the parts of handoff-projection.mjs that TypeScript
// packages import statically (packages/tui/src/controller.ts, the System-tab
// handoff files row).
export class HandoffSettingError extends Error {}
export function handoffSettingOf(
  parsed: unknown,
  root: string,
  where?: string,
): { enabled: boolean; source: 'config' | 'tracked' | 'default' };
