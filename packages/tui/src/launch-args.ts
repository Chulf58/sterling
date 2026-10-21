// The terminal TUI's command line: sterling-tui --store <path-to-sterling.db> [--host claude|opencode].
// Kept out of main.ts (which draws to the terminal on import) so the mapping
// from the launch arguments to openDashboard's options is testable.
import type { DashboardOptions } from './controller.js';

export interface LaunchArgs {
  storePath: string;
  /** The host whose subagents the Agents tab shows (default claude). */
  host: 'claude' | 'opencode';
  /** The host option for openDashboard: 'opencode' offers the Overpass rows in work mode. */
  dashboardHost: DashboardOptions['host'];
}

/** Parse the launch arguments; null when they are not a valid command line. */
export function parseLaunchArgs(args: string[]): LaunchArgs | null {
  const storeIdx = args.indexOf('--store');
  const hostIdx = args.indexOf('--host');
  const host = hostIdx === -1 ? 'claude' : args[hostIdx + 1];
  if (storeIdx === -1 || !args[storeIdx + 1] || (host !== 'claude' && host !== 'opencode')) return null;
  return { storePath: args[storeIdx + 1], host, dashboardHost: host === 'opencode' ? 'opencode' : undefined };
}
