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

export interface RowLine {
  text: string;
  /** title: the card's first line (inverse when selected); body: wrapped
   *  continuation of the expanded text; meta: the dim metadata line */
  kind: 'title' | 'body' | 'meta';
}

export interface Row {
  id: string;
  type: string;
  selected: boolean;
  expanded: boolean;
  /** exact display lines, pre-clipped/wrapped — the renderer prints them
   *  verbatim, so row heights and the click hit-test agree by construction */
  lines: RowLine[];
  /** 0-based screen line offset of this row within the body block */
  screenRow: number;
}

/** Pane geometry threaded in from the renderer side; Infinity = unbounded. */
export interface Viewport {
  /** columns available — wraps expanded bodies, clips collapsed titles */
  width?: number;
  /** body lines visible — the click hit-test bound (visibleBodyLines) */
  maxBodyLines?: number;
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
  | { kind: 'tab'; index: number } // digit hotkey 1..N → 0-based tab index; out-of-range ignored here
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

/** Word-wrap to width columns, preserving explicit newlines; words longer
 *  than the width are hard-broken. Infinity width → split on newlines only. */
export function wrapText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width < 1) return text.split('\n');
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const clipEllipsis = (s: string, width: number): string =>
  Number.isFinite(width) && s.length > width ? `${s.slice(0, Math.max(1, width) - 1)}…` : s;

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity): DashboardState {
  const cards = cardsFor(store, ui.tab);
  const cursor = Math.min(ui.cursor, Math.max(0, cards.length - 1));
  const rows: Row[] = [];
  let screenRow = 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const expanded = ui.expanded.includes(card.id);
    const selected = i === cursor;
    const marker = selected ? '› ' : '  ';
    let lines: RowLine[];
    if (expanded) {
      // full body, wrapped under a 2-column content indent; metadata last
      const wrapWidth = Number.isFinite(width) ? Math.max(1, width - 2) : width;
      lines = wrapText(card.body, wrapWidth).map((text, j) => ({
        text: (j === 0 ? marker : '  ') + text,
        kind: j === 0 ? ('title' as const) : ('body' as const),
      }));
      if (card.detail) lines.push({ text: `    ${card.detail}`, kind: 'meta' });
    } else {
      lines = [{ text: clipEllipsis(marker + card.title, width), kind: 'title' }];
    }
    rows.push({ id: card.id, type: card.type, selected, expanded, lines, screenRow });
    screenRow += lines.length;
  }
  const run = ui.tab === 2 ? runView(store) : undefined;
  return {
    tabs: TABS.map((label, i) => ({ label, active: i === ui.tab })),
    rows,
    run,
    runSelected: ui.tab === 2,
    emptyMessage: ui.tab === 2 ? (run ? undefined : 'no active run') : cards.length === 0 ? '(empty)' : undefined,
    footer: `←/→ or 1-${TABS.length} tabs · ↑/↓ or wheel · enter/click select+expand · right-click collapse · q quit`,
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
    if (bodyLine >= r.screenRow && bodyLine < r.screenRow + r.lines.length) return i;
  }
  return -1;
}

export function reduce(store: SterlingStore, ui: UiState, event: UiEvent, viewport: Viewport = {}): { ui: UiState; effects: Effect[] } {
  const maxBodyLines = viewport.maxBodyLines ?? Infinity;
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
    case 'tab':
      if (event.index < 0 || event.index >= TABS.length) return { ui, effects };
      return { ui: { ...ui, tab: event.index, cursor: 0 }, effects };
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
      // hit-test against the same width the renderer wrapped with — wrapped
      // heights must match what is on screen
      const state = buildDashboardState(store, ui, viewport.width ?? Infinity);
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
