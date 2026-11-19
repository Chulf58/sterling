// Id-based navigation for System-tab tests: a cursor index is looked up from the entry list the tab
// draws (systemCursorOf), never counted by hand. `snap` builds a canonical roster snapshot.
import { initialUi, systemCursorOf, type AgentRosterSnapshot, type UiState } from '../state.js';

export const SYS = {
  mergePath: 'sys:merge_path',
  reviewers: 'sys:reviewers',
  copilotLoop: 'sys:copilot_loop',
  autoMerge: 'sys:pr_auto_merge',
  tdd: 'sys:tdd_enabled',
  overpassProvider: 'sys:overpass_provider',
  handoff: 'sys:handoff_files',
} as const;

export function snap(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    models: {
      implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'medium' },
      reviewer: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
    },
    hosts: ['claude', 'opencode'],
    catalog: {
      present: true,
      stale: false,
      staleDate: null,
      entries: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active' },
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'sonnet', status: 'active' },
        { id: 'gpt-5.6-sol', label: 'Sol', tier: 'sol', status: 'active', vendor: 'openai' },
      ],
    },
    workflow: { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true },
    tdd: { enabled: true },
    handoff: false,
    ...over,
  };
}

/** The cursor index of the cursorable entry with this id. Throws when the snapshot draws no such entry. */
export function at(s: AgentRosterSnapshot, id: string, ui: UiState = initialUi): number {
  const i = systemCursorOf(s, ui, id);
  if (i < 0) throw new Error(`the System tab draws no cursorable entry '${id}' for this snapshot`);
  return i;
}
