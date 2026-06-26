// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import type { SterlingStore } from '@sterling/store';
import { KNOWLEDGE_CATEGORIES, toCard, completedQueueLines, queueCards, todoCards, noteCards, runView, type Card, type RunView } from './viewmodel.js';
import { bannerLines } from './banner.js';

export const TABS = ['Todos', 'Notes', 'Knowledge', 'Queue', 'Live-run'] as const;
/** the run tab is always last — every other tab is a card list */
export const RUN_TAB = TABS.length - 1;
/** the knowledge explorer (formerly 'Articles'): a category→source→record tree */
export const KNOWLEDGE_TAB = 2;
export const QUEUE_TAB = 3;

export interface UiState {
  tab: number;
  cursor: number;
  expanded: string[];
  /** Knowledge-tab FTS filter; an always-visible field — printable keys feed it
   *  directly (no '/' toggle). Persists across tab switches until ESC clears it. */
  searchQuery: string;
}

export const initialUi: UiState = { tab: 0, cursor: 0, expanded: [], searchQuery: '' };

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
  /** whether the banner is shown (STERLING_NO_BANNER=1 → false) — drives the
   *  banner height, hence bodyTop and the tab-bar click row */
  showBanner?: boolean;
}

export interface DashboardState {
  tabs: { label: string; active: boolean }[];
  rows: Row[];
  run?: RunView;
  runSelected: boolean;
  emptyMessage?: string;
  footer: string;
  /** Knowledge-tab search bar (always-visible field), shown on the spacer line */
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
  /** banner rows (§11), width-aware: the full 3-row wordmark, a 1-line
   *  fallback, or [] when suppressed/too narrow — the renderer paints them with
   *  the gradient; their count drives bodyTop */
  banner: string[];
  /** the project's folder name, drawn bold on its own header row (below the
   *  banner) so a glance tells you which project's session this pane is
   *  observing (typing into the wrong session is the mistake this row prevents);
   *  the banner sits ABOVE this row, so suppressing it leaves the header intact */
  projectName: string;
  /** body starts at this screen line: banner.length + header + tab bar + blank
   *  spacer. No banner → 3 (header/tabs/spacer), the prior fixed layout. */
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

/**
 * A navigable line-owning entry. On the Knowledge tab the tree has three node
 * kinds (category → source → record), each carrying its depth for indentation;
 * card nodes also flag whether they are knowledge-tab cards (readable layout) or
 * plain cards (todos/notes/queue, the legacy expansion). Every other tab is a
 * flat list of plain card nodes at depth 0.
 */
export type Node =
  | { kind: 'category'; type: string; label: string; count: number }
  | { kind: 'source'; catType: string; source: string; count: number }
  | { kind: 'card'; card: Card; depth: number; knowledge: boolean };

const catId = (type: string) => `cat:${type}`;
const srcId = (type: string, source: string) => `src:${type}:${source}`;

/** Prefix-star a query into AND-joinable rank terms (mid-word matching). */
function rankTermsOf(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t.length < 64)
    .map((t) => `${t.replace(/\*+$/, '')}*`);
}

/**
 * The Knowledge tab is a 3-level collapse/expand tree: knowledge CATEGORY →
 * SOURCE store → record. P3 sources the tree from the PROJECT store alone, so
 * the single source under every non-empty category is named 'project' (the
 * MountedStores cross-store fan-out is P4). Empty categories/sources are hidden;
 * everything is collapsed by default. A non-empty search query REPLACES the tree
 * with a flat, AND-filtered card list (every term prefix-starred). The other
 * card tabs stay flat lists.
 */
export function nodesFor(store: SterlingStore, ui: UiState): Node[] {
  if (ui.tab === RUN_TAB) return [];
  if (ui.tab === QUEUE_TAB) return queueCards(store).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: false }));
  if (ui.tab !== KNOWLEDGE_TAB) return cardsFor(store, ui.tab).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: false }));

  const cap = 500;
  const query = ui.searchQuery.trim();
  if (query) {
    const terms = rankTermsOf(query);
    if (terms.length) {
      const types = KNOWLEDGE_CATEGORIES.map((c) => c.type);
      return store
        .query({ types, rank_terms: terms, match_all: true, cap })
        .map((r) => ({ kind: 'card' as const, card: { ...toCard(r), source: 'project' }, depth: 0, knowledge: true }));
    }
  }

  // collapsed default tree: only non-empty categories, in registry order; the
  // single 'project' source appears when its category is expanded; cards appear
  // when their source is expanded.
  const nodes: Node[] = [];
  for (const cat of KNOWLEDGE_CATEGORIES) {
    const records = store.query({ types: [cat.type], cap });
    if (records.length === 0) continue; // empty categories hidden
    nodes.push({ kind: 'category', type: cat.type, label: cat.label, count: records.length });
    if (!ui.expanded.includes(catId(cat.type))) continue;
    // P3: the project store is the only source
    nodes.push({ kind: 'source', catType: cat.type, source: 'project', count: records.length });
    if (!ui.expanded.includes(srcId(cat.type, 'project'))) continue;
    for (const r of records) {
      nodes.push({ kind: 'card', card: { ...toCard(r), source: 'project' }, depth: 2, knowledge: true });
    }
  }
  return nodes;
}

// fixed chrome below the banner: the project-name header, the tab bar, and the
// blank line (which doubles as the search bar). bodyTop = banner.length + this.
const CHROME_BELOW_BANNER = 3;

/**
 * Body lines visible at a given terminal height: the body spans screen lines
 * bodyTop+1 .. height-2 (bottom two reserved for the blank spacer + footer).
 * bannerHeight shrinks the body region by the banner's rows. Must stay in sync
 * with the draw() clamp in render.ts — rows the renderer clips must not be
 * clickable.
 */
export function visibleBodyLines(height: number, bannerHeight = 0): number {
  return Math.max(0, height - bannerHeight - CHROME_BELOW_BANNER - 2);
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

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false): DashboardState {
  const banner = bannerLines(width, showBanner);
  const bodyTop = banner.length + CHROME_BELOW_BANNER;
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
    if (node.kind === 'category') {
      id = catId(node.type);
      type = 'category';
      expanded = ui.expanded.includes(id);
      lines = [{ text: clipEllipsis(`${marker}${expanded ? '▾' : '▸'} ${node.label} (${node.count})`, width), kind: 'title' }];
    } else if (node.kind === 'source') {
      id = srcId(node.catType, node.source);
      type = 'source';
      expanded = ui.expanded.includes(id);
      const pad = '  '; // depth 1
      lines = [{ text: clipEllipsis(`${marker}${pad}${expanded ? '▾' : '▸'} ${node.source} (${node.count})`, width), kind: 'title' }];
    } else {
      const { card, depth, knowledge } = node;
      id = card.id;
      type = card.type;
      expanded = ui.expanded.includes(card.id);
      const pad = '  '.repeat(depth);
      if (expanded && knowledge) {
        // readable layout (AC4): title line, blank separator, wrapped body
        // lines, dim meta — the title is NEVER replaced by the body.
        const indent = ' '.repeat(2 + pad.length);
        const wrapWidth = Number.isFinite(width) ? Math.max(1, width - indent.length) : width;
        lines = [{ text: clipEllipsis(marker + pad + card.title, width), kind: 'title' }, { text: '', kind: 'body' }];
        for (const text of wrapText(card.body, wrapWidth)) lines.push({ text: indent + text, kind: 'body' });
        lines.push({ text: clipEllipsis(`${indent}${card.detail}`, width), kind: 'meta' });
      } else if (expanded) {
        // legacy card expansion (todos/notes/queue): first wrapped body line
        // carries the 'title' kind, then body lines, then meta.
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
  // the Knowledge search field is ALWAYS visible (no '/' toggle) — its line
  // shows on the spacer row on the Knowledge tab regardless of the query.
  const searchActive = ui.tab === KNOWLEDGE_TAB;
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
          ? ui.tab === KNOWLEDGE_TAB && ui.searchQuery
            ? '(no matches)'
            : ui.tab === QUEUE_TAB
              ? '(queue empty)'
              : '(empty)'
          : undefined,
    footer:
      `←/→ or 1-${TABS.length} tabs · ↑/↓ or wheel · enter/click select+expand · right-click collapse · q quit` +
      (ui.tab === KNOWLEDGE_TAB ? ' · type to search · esc clears' : ''),
    searchLine: searchActive ? `search: ${ui.searchQuery}` : undefined,
    queueCompleted,
    banner,
    projectName,
    bodyTop,
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

  const switchTab = (index: number): UiState => ({ ...ui, tab: index, cursor: 0 });

  const toggle = (id: string): string[] =>
    ui.expanded.includes(id) ? ui.expanded.filter((x) => x !== id) : [...ui.expanded, id];

  const activate = (index: number): UiState => {
    if (ui.tab === RUN_TAB) {
      const run = runView(store);
      if (run) effects.push({ type: 'select', recordType: 'run', id: run.id });
      return ui;
    }
    const node = nodes[index];
    if (!node) return ui;
    if (node.kind === 'category') {
      // fold/unfold the category — navigation, not a selection
      return { ...ui, cursor: index, expanded: toggle(catId(node.type)) };
    }
    if (node.kind === 'source') {
      // fold/unfold the source — navigation, not a selection
      return { ...ui, cursor: index, expanded: toggle(srcId(node.catType, node.source)) };
    }
    const card = node.card;
    effects.push({ type: 'select', recordType: card.type, id: card.id });
    return { ...ui, cursor: index, expanded: toggle(card.id) };
  };

  switch (event.kind) {
    case 'key':
      switch (event.name) {
        case 'QUIT':
          effects.push({ type: 'quit' });
          return { ui, effects };
        case 'ESCAPE':
          // the Knowledge field is always live: Esc clears the query + cursor
          if (ui.tab === KNOWLEDGE_TAB) {
            return { ui: { ...ui, searchQuery: '', cursor: 0 }, effects };
          }
          return { ui, effects };
        case 'BACKSPACE':
          if (ui.tab === KNOWLEDGE_TAB) {
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
          return { ui: activate(clamp(ui.cursor)), effects };
        case 'SPACE':
          return { ui: activate(clamp(ui.cursor)), effects };
      }
      break;
    case 'char': {
      const ch = event.ch;
      if (ch.length !== 1) return { ui, effects };
      // the Knowledge tab is an always-visible search field: EVERY printable key
      // feeds the query — 'q' and digits included (they are not hotkeys here).
      if (ui.tab === KNOWLEDGE_TAB) {
        return { ui: { ...ui, searchQuery: ui.searchQuery + ch, cursor: 0 }, effects };
      }
      if (ch === 'q') {
        effects.push({ type: 'quit' });
        return { ui, effects };
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
      // build the same geometry the renderer drew with — wrapped heights, the
      // queue tab's pending truncation, AND the banner-driven bodyTop must all
      // match the screen, so the tab-bar row and body hit-test track the banner
      const state = buildDashboardState(store, ui, viewport.width ?? Infinity, maxBodyLines, '', viewport.showBanner ?? false);
      // tab bar sits one line above the body block (its own header row is just
      // above the body); terminal line = bodyTop - 1. Pick the tab by x extent.
      if (event.y === state.bodyTop - 1) {
        let x = 1;
        for (let i = 0; i < TABS.length; i++) {
          const width = TABS[i].length + 2; // ' label '
          if (event.x >= x && event.x < x + width) return { ui: switchTab(i), effects };
          x += width;
        }
        return { ui, effects };
      }
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
