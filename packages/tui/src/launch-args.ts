// The terminal TUI's command line: sterling-tui --store <path-to-sterling.db> [--host claude|opencode].
// Kept out of main.ts (which draws to the terminal on import) so the step from
// the launch arguments to the opened dashboard is testable: main.ts opens its
// dashboard through openLaunchDashboard, and the tests call the same function.
import { openDashboard, type DashboardController, type DashboardOptions } from './controller.js';

export interface LaunchArgs {
  storePath: string;
  /** The host whose subagents the Agents tab shows (default claude). */
  host: 'claude' | 'opencode';
}

/** Parse the launch arguments; null when they are not a valid command line. */
export function parseLaunchArgs(args: string[]): LaunchArgs | null {
  const storeIdx = args.indexOf('--store');
  const hostIdx = args.indexOf('--host');
  const host = hostIdx === -1 ? 'claude' : args[hostIdx + 1];
  if (storeIdx === -1 || !args[storeIdx + 1] || (host !== 'claude' && host !== 'opencode')) return null;
  return { storePath: args[storeIdx + 1], host };
}

/** Open the dashboard for a launch: --host opencode becomes openDashboard's
 *  host 'opencode', which offers the Overpass rows in work mode. */
export function openLaunchDashboard(launch: LaunchArgs, options: Omit<DashboardOptions, 'host'>): DashboardController {
  return openDashboard(launch.storePath, { ...options, host: launch.host === 'opencode' ? 'opencode' : undefined });
}
