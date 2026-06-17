// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import type { SterlingStore } from '@sterling/store';
import { articleCards, articleSearch, completedQueueLines, queueCards, todoCards, noteCards, runView, type Card, type RunView } from './viewmodel.js';

export const TABS = ['Todos', 'Notes', 'Articles', 'Queue', 'Live-run'] as const;
/** the run tab is always last — every other tab is a card list */
export const RUN_TAB = TABS.length - 1;
export const ARTICLES_TAB = 2;
export const QUEUE_TAB = 3;

export interface UiState {
  tab: number;
  cursor: number;
  expanded: string[];
  /** articles-tab FTS filter; persists across tab switches until ESC clears it */
  searchQuery: string;
  /** '/' input mode on the articles tab: printable keys append to the query */
  searchEditing: boolean;
}

export const initialUi: UiState = { tab: 0, cursor: 0, expanded: [], searchQuery: '', searchEditing: false };

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
  /** articles-tab search bar, shown on the spacer line when a query/input is live */
  searchLine?: string;
  /** queue tab only: the completed (drain log) section in the lower half —
   *  log lines, not records; never selectable (§3.2.7/§11) */
  queueCompleted?: {
    /** body-line offset of the divider (fixed at half the viewport) */
    startRow: number;
    header: string;
    lines: string[];
    /** present when pending was clipped at the divider: '… N more pending' */
    overflow?: string;
  };
  /** the project's folder name, drawn bold on the top header row so a glance
   *  tells you which project's session this pane is observing (typing into the
   *  wrong session is the mistake this row prevents) */
  projectName: string;
  /** body starts at this screen line (after the header + tab bar + blank line) */
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
  | { kind: 'key'; name: 'LEFT' | 'RIGHT' | 'TAB' | 'UP' | 'DOWN' | 'ENTER' | 'SPACE' | 'QUIT' | 'ESCAPE' | 'BACKSPACE' }
  | { kind: 'char'; ch: string } // printable keys — search input, 'q' quit, digit hotkeys, '/' search
  | { kind: 'tab'; index: number } // direct tab select, 0-based; out-of-range ignored here
  | { kind: 'click'; x: number; y: number }
  | { kind: 'rightclick' }
  | { kind: 'wheel'; dy: number };

export function cardsFor(store: SterlingStore, tab: number): Card[] {
  if (tab === 0) return todoCards(store);
  if (tab === 1) return noteCards(store);
  return [];
}

/** A navigable line-owning entry: a folder group header or a card. */
export type Node = { kind: 'group'; key: string; count: number } | { kind: 'card'; card: Card; indent: boolean };

const groupId = (key: string) => `group:${key}`;

/**
 * The articles tab is a folder tree derived from each article's owned file
 * paths (groups default collapsed; an article appears under every area it
 * owns). An active search replaces the tree with the bm25-ranked flat result
 * list — every term is prefix-starred so typing matches mid-word. The other
 * card tabs stay flat lists.
 */
export function nodesFor(store: SterlingStore, ui: UiState): Node[] {
  if (ui.tab === RUN_TAB) return [];
  if (ui.tab === QUEUE_TAB) return queueCards(store).map((card) => ({ kind: 'card' as const, card, indent: false }));
  if (ui.tab !== ARTICLES_TAB) return cardsFor(store, ui.tab).map((card) => ({ kind: 'card' as const, card, indent: false }));
  const query = ui.searchQuery.trim();
  if (query) {
    const terms = query
      .split(/\s+/)
      .filter((t) => t.length > 0 && t.length < 64)
      .map((t) => `${t.replace(/\*+$/, '')}*`);
    if (terms.length) return articleSearch(store, terms).map((card) => ({ kind: 'card' as const, card, indent: false }));
  }
  const groups = new Map<string, Card[]>();
  for (const card of articleCards(store)) {
    for (const g of card.groups ?? []) {
      const members = groups.get(g);
      if (members) members.push(card);
      else groups.set(g, [card]);
    }
  }
  const nodes: Node[] = [];
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)!;
    nodes.push({ kind: 'group', key, count: members.length });
    if (ui.expanded.includes(groupId(key))) {
      for (const card of [...members].sort((a, b) => a.title.localeCompare(b.title))) {
        nodes.push({ kind: 'card', card, indent: true });
      }
    }
  }
  return nodes;
}

const BODY_TOP = 3; // line 0: project-name header; line 1: tab bar; line 2: blank (doubles as the search bar)

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

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = ''): DashboardState {
  const nodes = nodesFor(store, ui);
  const cursor = Math.min(ui.cursor, Math.max(0, nodes.length - 1));
  let rows: Row[] = [];
  let screenRow = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const selected = i === cursor;
    const marker = selected ? '› ' : '  ';
    let lines: RowLine[];
    let id: string;
    let type: string;
    let expanded: boolean;
    if (node.kind === 'group') {
      id = groupId(node.key);
      type = 'group';
      expanded = ui.expanded.includes(id);
      lines = [{ text: clipEllipsis(`${marker}${expanded ? '▾' : '▸'} ${node.key} (${node.count})`, width), kind: 'title' }];
    } else {
      const { card, indent } = node;
      id = card.id;
      type = card.type;
      expanded = ui.expanded.includes(card.id);
      const pad = indent ? '  ' : '';
      if (expanded) {
        // full body, wrapped under the marker + indent columns; metadata last
        const prefix = 2 + pad.length;
        const wrapWidth = Number.isFinite(width) ? Math.max(1, width - prefix) : width;
        lines = wrapText(card.body, wrapWidth).map((text, j) => ({
          text: (j === 0 ? marker + pad : ' '.repeat(prefix)) + text,
          kind: j === 0 ? ('title' as const) : ('body' as const),
        }));
        if (card.detail) lines.push({ text: `    ${pad}${card.detail}`, kind: 'meta' });
      } else {
        lines = [{ text: clipEllipsis(marker + pad + card.title, width), kind: 'title' }];
      }
    }
    rows.push({ id, type, selected, expanded, lines, screenRow });
    screenRow += lines.length;
  }
  // queue tab: fixed half-split — pending rows are TRUNCATED in the state
  // layer so the click hit-test and the screen agree by construction; the
  // completed (drain log) section owns the lower half (§3.2.7/§11)
  let queueCompleted: DashboardState['queueCompleted'];
  if (ui.tab === QUEUE_TAB) {
    const totalLines = rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
    const startRow = Number.isFinite(maxBodyLines) ? Math.max(1, Math.floor(maxBodyLines / 2)) : totalLines;
    let overflow: string | undefined;
    if (totalLines > startRow) {
      const keep: Row[] = [];
      for (const r of rows) {
        if (r.screenRow + r.lines.length <= startRow - 1) keep.push(r);
        else break;
      }
      overflow = `… ${rows.length - keep.length} more pending`;
      rows = keep;
    }
    const completed = completedQueueLines(store);
    queueCompleted = {
      startRow,
      header: '— completed —',
      lines: completed.length ? completed : ['(nothing completed yet)'],
      ...(overflow ? { overflow } : {}),
    };
  }
  const run = ui.tab === RUN_TAB ? runView(store) : undefined;
  const searchActive = ui.tab === ARTICLES_TAB && (ui.searchEditing || ui.searchQuery.length > 0);
  return {
    tabs: TABS.map((label, i) => ({ label, active: i === ui.tab })),
    rows,
    run,
    runSelected: ui.tab === RUN_TAB,
    emptyMessage:
      ui.tab === RUN_TAB
        ? run
          ? undefined
          : 'no active run'
        : nodes.length === 0
          ? ui.tab === ARTICLES_TAB && ui.searchQuery
            ? '(no matches)'
            : ui.tab === QUEUE_TAB
              ? '(queue empty)'
              : '(empty)'
          : undefined,
    footer:
      `←/→ or 1-${TABS.length} tabs · ↑/↓ or wheel · enter/click select+expand · right-click collapse · q quit` +
      (ui.tab === ARTICLES_TAB ? ' · / search · esc clears' : ''),
    searchLine: searchActive ? `search: ${ui.searchQuery}${ui.searchEditing ? '▌' : ''}` : undefined,
    queueCompleted,
    projectName,
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
  const nodes = nodesFor(store, ui);
  const clamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, nodes.length - 1)));
  const effects: Effect[] = [];

  const switchTab = (index: number): UiState => ({ ...ui, tab: index, cursor: 0, searchEditing: false });

  const activate = (index: number): UiState => {
    if (ui.tab === RUN_TAB) {
      const run = runView(store);
      if (run) effects.push({ type: 'select', recordType: 'run', id: run.id });
      return ui;
    }
    const node = nodes[index];
    if (!node) return ui;
    if (node.kind === 'group') {
      // fold/unfold the folder — navigation, not a selection
      const id = groupId(node.key);
      const expanded = ui.expanded.includes(id) ? ui.expanded.filter((x) => x !== id) : [...ui.expanded, id];
      return { ...ui, cursor: index, expanded };
    }
    const card = node.card;
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
        case 'ESCAPE':
          if (ui.tab === ARTICLES_TAB && (ui.searchEditing || ui.searchQuery)) {
            return { ui: { ...ui, searchEditing: false, searchQuery: '', cursor: 0 }, effects };
          }
          return { ui, effects };
        case 'BACKSPACE':
          if (ui.searchEditing && ui.tab === ARTICLES_TAB) {
            return { ui: { ...ui, searchQuery: ui.searchQuery.slice(0, -1), cursor: 0 }, effects };
          }
          return { ui, effects };
        case 'LEFT':
          return { ui: switchTab((ui.tab + TABS.length - 1) % TABS.length), effects };
        case 'RIGHT':
        case 'TAB':
          return { ui: switchTab((ui.tab + 1) % TABS.length), effects };
        case 'UP':
          return { ui: { ...ui, cursor: clamp(ui.cursor - 1) }, effects };
        case 'DOWN':
          return { ui: { ...ui, cursor: clamp(ui.cursor + 1) }, effects };
        case 'ENTER':
          if (ui.searchEditing) return { ui: { ...ui, searchEditing: false }, effects }; // keep the filter, leave input mode
          return { ui: activate(clamp(ui.cursor)), effects };
        case 'SPACE':
          return { ui: activate(clamp(ui.cursor)), effects };
      }
      break;
    case 'char': {
      const ch = event.ch;
      if (ch.length !== 1) return { ui, effects };
      // search input mode swallows every printable key — 'q' and digits included
      if (ui.searchEditing && ui.tab === ARTICLES_TAB) {
        return { ui: { ...ui, searchQuery: ui.searchQuery + ch, cursor: 0 }, effects };
      }
      if (ch === 'q') {
        effects.push({ type: 'quit' });
        return { ui, effects };
      }
      if (ch === '/' && ui.tab === ARTICLES_TAB) {
        return { ui: { ...ui, searchEditing: true, cursor: 0 }, effects };
      }
      if (ch === ' ') return { ui: activate(clamp(ui.cursor)), effects };
      if (/^[1-9]$/.test(ch)) {
        const index = Number(ch) - 1;
        if (index < TABS.length) return { ui: switchTab(index), effects };
      }
      return { ui, effects };
    }
    case 'tab':
      if (event.index < 0 || event.index >= TABS.length) return { ui, effects };
      return { ui: switchTab(event.index), effects };
    case 'wheel':
      return { ui: { ...ui, cursor: clamp(ui.cursor + (event.dy > 0 ? 1 : -1)) }, effects };
    case 'click': {
      // tab bar click (line 2 — the project-name header is line 1): pick the tab by x extent
      if (event.y === 2) {
        let x = 1;
        for (let i = 0; i < TABS.length; i++) {
          const width = TABS[i].length + 2; // ' label '
          if (event.x >= x && event.x < x + width) return { ui: switchTab(i), effects };
          x += width;
        }
        return { ui, effects };
      }
      // hit-test against the same viewport the renderer drew with — wrapped
      // heights and the queue tab's pending truncation must match the screen
      const state = buildDashboardState(store, ui, viewport.width ?? Infinity, maxBodyLines);
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
