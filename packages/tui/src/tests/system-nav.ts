// Id-based navigation for System-tab tests: a cursor index is looked up from the entry list the tab
// draws (systemCursorOf), never counted by hand from the number of config.models keys.
import { initialUi, systemCursorOf, type AgentRosterSnapshot, type UiState } from '../state.js';

/** The ids of the settings entries, in the order the tab lists them after the agent rows. */
export const SYS = {
  sparringEnabled: 'sys:sparring_enabled',
  sparringModel: 'sys:sparring_model',
  tdd: 'sys:tdd_enabled',
  mode: 'sys:project_mode',
  handoff: 'sys:handoff_files',
  autoMerge: 'sys:pr_auto_merge',
  overpass: 'sys:overpass',
  overpassProvider: 'sys:overpass_provider',
  overpassBypass: 'sys:overpass_bypass',
} as const;

/** The cursor index of the cursorable entry with this id. Throws when the snapshot draws no such entry. */
export function at(snap: AgentRosterSnapshot, id: string, ui: UiState = initialUi): number {
  const i = systemCursorOf(snap, ui, id);
  if (i < 0) throw new Error(`the System tab draws no cursorable entry '${id}' for this snapshot`);
  return i;
}

/** The cursor index of the last agent row (the one just before the first setting). */
export function lastAgentCursor(snap: AgentRosterSnapshot, ui: UiState = initialUi): number {
  return at(snap, SYS.sparringEnabled, ui) - 1;
}
