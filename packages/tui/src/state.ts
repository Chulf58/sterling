// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import type { SterlingStore } from '@sterling/store';
import { todoCards, noteCards, runView, type Card, type RunView } from './viewmodel.js';

export const TABS = ['Todos', 'Notes', 'Live-run'] as const;

export interface UiState {
  tab: number;
  cursor: number;
  expanded: string[];
}

export const initialUi: UiState = { tab: 0, cursor: 0, expanded: [] };

export interface Row {
  id: string;
  type: string;
  text: string;
  selected: boolean;
  expanded: boolean;
  detail?: string;
  /** 0-based screen line offset of this row within the body block */
  screenRow: number;
}

export interface DashboardState {
  tabs: { label: string; active: boolean }[];
  rows: Row[];
  run?: RunView;
  runSelected: boolean;
  emptyMessage?: string;
  footer: string;
  /** body starts at this screen line (after the tab bar + blank line) */
  bodyTop: number;
}

export interface SelectEffect {
  type: 'select';
  recordType: string;
  id: string;
}
export interface QuitEffect {
  type: 'quit';
}
export type Effect = SelectEffect | QuitEffect;

export type UiEvent =
  | { kind: 'key'; name: 'LEFT' | 'RIGHT' | 'TAB' | 'UP' | 'DOWN' | 'ENTER' | 'SPACE' | 'QUIT' }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'rightclick' }
  | { kind: 'wheel'; dy: number };

export function cardsFor(store: SterlingStore, tab: number): Card[] {
  if (tab === 0) return todoCards(store);
  if (tab === 1) return noteCards(store);
  return [];
}

const BODY_TOP = 2; // line 0: tab bar; line 1: blank

/**
 * Body lines visible at a given terminal height: the body spans screen lines
 * bodyTop+1 .. height-2 (bottom two reserved for the blank spacer + footer).
 * Must stay in sync with the draw() clamp in render.ts — rows the renderer
 * clips must not be clickable.
 */
export function visibleBodyLines(height: number): number {
  return Math.max(0, height - BODY_TOP - 2);
}

export function buildDashboardState(store: SterlingStore, ui: UiState): DashboardState {
  const cards = cardsFor(store, ui.tab);
  const cursor = Math.min(ui.cursor, Math.max(0, cards.length - 1));
  const rows: Row[] = [];
  let screenRow = 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const expanded = ui.expanded.includes(card.id);
    rows.push({
      id: card.id,
      type: card.type,
      text: card.title,
      selected: i === cursor,
      expanded,
      detail: expanded && card.detail ? card.detail : undefined,
      screenRow,
    });
    screenRow += expanded && card.detail ? 2 : 1;
  }
  const run = ui.tab === 2 ? runView(store) : undefined;
  return {
    tabs: TABS.map((label, i) => ({ label, active: i === ui.tab })),
    rows,
    run,
    runSelected: ui.tab === 2,
    emptyMessage: ui.tab === 2 ? (run ? undefined : 'no active run') : cards.length === 0 ? '(empty)' : undefined,
    footer: '←/→ tabs · ↑/↓ or wheel · enter/click select+expand · right-click collapse · q quit',
    bodyTop: BODY_TOP,
  };
}

/** Map an absolute screen line (1-based, terminal convention) to a row index, or -1.
 *  maxBodyLines bounds the hit-test to the rendered viewport (visibleBodyLines). */
export function screenLineToRow(state: DashboardState, line1: number, maxBodyLines = Infinity): number {
  const bodyLine = line1 - 1 - state.bodyTop; // to 0-based body offset
  if (bodyLine < 0 || bodyLine >= maxBodyLines) return -1;
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    const height = r.detail ? 2 : 1;
    if (bodyLine >= r.screenRow && bodyLine < r.screenRow + height) return i;
  }
  return -1;
}

export function reduce(store: SterlingStore, ui: UiState, event: UiEvent, maxBodyLines = Infinity): { ui: UiState; effects: Effect[] } {
  const cards = cardsFor(store, ui.tab);
  const clamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, cards.length - 1)));
  const effects: Effect[] = [];

  const activate = (index: number): UiState => {
    if (ui.tab === 2) {
      const run = runView(store);
      if (run) effects.push({ type: 'select', recordType: 'run', id: run.id });
      return ui;
    }
    const card = cards[index];
    if (!card) return ui;
    effects.push({ type: 'select', recordType: card.type, id: card.id });
    const expanded = ui.expanded.includes(card.id) ? ui.expanded.filter((x) => x !== card.id) : [...ui.expanded, card.id];
    return { ...ui, cursor: index, expanded };
  };

  switch (event.kind) {
    case 'key':
      switch (event.name) {
        case 'QUIT':
          effects.push({ type: 'quit' });
          return { ui, effects };
        case 'LEFT':
          return { ui: { ...ui, tab: (ui.tab + TABS.length - 1) % TABS.length, cursor: 0 }, effects };
        case 'RIGHT':
        case 'TAB':
          return { ui: { ...ui, tab: (ui.tab + 1) % TABS.length, cursor: 0 }, effects };
        case 'UP':
          return { ui: { ...ui, cursor: clamp(ui.cursor - 1) }, effects };
        case 'DOWN':
          return { ui: { ...ui, cursor: clamp(ui.cursor + 1) }, effects };
        case 'ENTER':
        case 'SPACE':
          return { ui: activate(clamp(ui.cursor)), effects };
      }
      break;
    case 'wheel':
      return { ui: { ...ui, cursor: clamp(ui.cursor + (event.dy > 0 ? 1 : -1)) }, effects };
    case 'click': {
      // tab bar click (line 1): pick the tab by x extent
      if (event.y === 1) {
        let x = 1;
        for (let i = 0; i < TABS.length; i++) {
          const width = TABS[i].length + 2; // ' label '
          if (event.x >= x && event.x < x + width) return { ui: { ...ui, tab: i, cursor: 0 }, effects };
          x += width;
        }
        return { ui, effects };
      }
      const state = buildDashboardState(store, ui);
      const row = screenLineToRow(state, event.y, maxBodyLines);
      if (row !== -1) return { ui: activate(row), effects };
      return { ui, effects };
    }
    case 'rightclick':
      // collapse everything — the quick "back to overview" gesture
      return { ui: { ...ui, expanded: [] }, effects };
  }
  return { ui, effects };
}

export function runEffects(store: SterlingStore, effects: Effect[], now: () => string = () => new Date().toISOString()): boolean {
  let quit = false;
  for (const e of effects) {
    if (e.type === 'select') store.writeSelection(e.recordType, e.id, now());
    if (e.type === 'quit') quit = true;
  }
  return quit;
}
