// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import type { SterlingStore, MountedStores } from '@sterling/store';
import { MAX_RANK_TERMS } from '@sterling/store';
import { AGENT_MODEL_KEY } from '@sterling/schemas';
import { KNOWLEDGE_CATEGORIES, toCard, knowledgeCountBySource, knowledgeSubgroups, knowledgeSearch, completedQueueLines, queueCards, todoCards, noteCards, runView, type Card, type RunView } from './viewmodel.js';
import { bannerLines } from './banner.js';

export const TABS = ['Todos', 'Notes', 'Knowledge', 'Queue', 'Live-run', 'System'] as const;
/** the live-run tab — a FIXED index (no longer the last entry: System follows it),
 *  so run-tab semantics track 'Live-run' rather than TABS.length-1 */
export const RUN_TAB = TABS.indexOf('Live-run');
/** the knowledge explorer (formerly 'Articles'): a category→source→record tree */
export const KNOWLEDGE_TAB = 2;
export const QUEUE_TAB = 3;
/** the System tab (run r-f9a7): the agent roster with drift + catalog status,
 *  and the inline model/effort swap selector — the TUI's first write surface */
export const SYSTEM_TAB = TABS.indexOf('System');

export interface UiState {
  tab: number;
  cursor: number;
  expanded: string[];
  /** Knowledge-tab FTS filter; an always-visible field — printable keys feed it
   *  directly (no '/' toggle). Persists across tab switches until ESC clears it. */
  searchQuery: string;
  /** body scroll offset in display LINES (0-based) for the scrollable card tabs
   *  (Todos/Notes/Knowledge). Absent → 0. buildDashboardState clamps it to the
   *  content height each frame; the queue/run tabs have fixed layouts and never
   *  scroll. Wheel moves it; ↑/↓ adjust it to keep the selected row in view. */
  scroll?: number;
  /** System tab (run r-f9a7): the inline model/effort selector state machine.
   *  Absent → the plain roster is shown; present → a picker is open on
   *  ui.selector.key (model stage, then effort stage). ESCAPE clears it. */
  selector?: SystemSelector;
  /** Transient System-tab notice (audit findings 24/43, 41/43): a refusal or a
   *  degraded-loud message shown as a ⚠ banner row, so a silently-refused model
   *  swap or a catalog/roster failure is VISIBLE (not lost to the alternate
   *  screen). Cleared on the next navigation / tab switch / selector open. */
  notice?: string;
}

/** The System-tab inline selector (run r-f9a7). `key` is the config.models key
 *  under edit; the machine walks model → effort → commit; `highlight` is the
 *  current option index; `model` holds the model confirmed at the model stage. */
export interface SystemSelector {
  key: string;
  stage: 'model' | 'effort';
  highlight: number;
  model?: string;
}

export const initialUi: UiState = { tab: 0, cursor: 0, expanded: [], searchQuery: '', scroll: 0 };

// ---------------------------------------------------------------------------
// System tab (run r-f9a7) — the agent roster snapshot injected at TAB
// ACTIVATION (never the 1 Hz loop, per decision 98064d77) and the pure
// projections that render it. The snapshot carries the INSTALLED frontmatter
// values (the copy that governs dispatch), the authoritative config.models
// table, and the PRECOMPUTED catalog status (the now-dependent catalogStatus
// call happens in main.ts so buildSystemTab stays pure/deterministic).
// ---------------------------------------------------------------------------

/** One installed agent, as read from its .claude/agents/<name>.md frontmatter. */
export interface RosterAgent {
  name: string;
  installedModel: string;
  installedEffort: string;
}
/** A models-catalog entry (reference_material.catalog.entries[]). */
export interface CatalogEntry {
  id: string;
  label: string;
  tier: string;
  status: string;
}
/** The catalog-status view computed at activation (present/stale/staleDate) plus
 *  the entries the selector offers. Precomputed so the projection has no clock. */
export interface CatalogStatusView {
  present: boolean;
  stale: boolean;
  staleDate: string | null;
  entries: CatalogEntry[];
}
export interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
}

/** A projected System-tab line (renderer prints text verbatim; kind styles it). */
export interface SystemLine {
  text: string;
  kind?: string;
  selected?: boolean;
}
/** A System-tab row — one per config.models KEY (id 'sys:<key>'). */
export interface SystemRow {
  id: string;
  key?: string;
  drift?: boolean;
  agents?: string[];
  lines: SystemLine[];
}
export interface SystemTabView {
  rows: SystemRow[];
  banner: string[];
}

const EMPTY_ROSTER: AgentRosterSnapshot = {
  agents: [],
  configModels: {},
  catalog: { present: false, stale: false, staleDate: null, entries: [] },
};

/** Pure scalar drift check: true iff the installed value differs from config. */
export function driftOf(installed: string, config: string): boolean {
  return installed !== config;
}

/** §7.2 effort rule as data: subagent keys never offer xhigh or max; only
 *  coder_hard is permitted xhigh; max never appears anywhere. */
export function effortOptions(key: string): string[] {
  return key === 'coder_hard' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
}

/** The model-value floor (decision 98064d77): a committed swap model must be a
 *  claude-* id or the commit is refused. */
export const MODEL_VALUE_RE = /^claude-/;

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
  /** body scroll offset in display lines, clamped to [0, total − maxBodyLines].
   *  The render draws the body window starting at this line and screenLineToRow
   *  adds it back, so screen and clicks agree. 0 on the queue/run tabs and
   *  whenever the body fits (maxBodyLines ≥ content, e.g. an unbounded viewport). */
  scroll: number;
}

export interface SelectEffect {
  type: 'select';
  recordType: string;
  id: string;
}
export interface QuitEffect {
  type: 'quit';
}
/** The System-tab commit effect (run r-f9a7): a VALUE the impure main.ts loop
 *  executes (config.models write → setInstalledModelEffort projection → swap
 *  decision record). from = the CURRENT config value being replaced. */
export interface ModelSwapEffect {
  type: 'model_swap';
  key: string;
  from: { model: string; effort: string };
  to: { model: string; effort: string };
  agents: string[];
  decisionTitle: string;
}
export type Effect = SelectEffect | QuitEffect | ModelSwapEffect;

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
 * A navigable line-owning entry. On the Knowledge tab the tree has up to four
 * node kinds (category → source → sub-category → record), each carrying its
 * depth for indentation; card nodes also flag whether they are knowledge-tab
 * cards (readable layout) or plain cards (todos/notes/queue, the legacy
 * expansion). The sub-category level is OMITTED when a source resolves to a
 * single bucket (collapse-single-bucket), so its cards sit at depth 2 directly
 * under the source. Every other tab is a flat list of plain card nodes at
 * depth 0.
 */
export type Node =
  | { kind: 'category'; type: string; label: string; count: number }
  | { kind: 'source'; catType: string; source: string; count: number }
  | { kind: 'subcategory'; catType: string; source: string; key: string; label: string; count: number }
  | { kind: 'card'; card: Card; depth: number; knowledge: boolean };

const catId = (type: string) => `cat:${type}`;
const srcId = (type: string, source: string) => `src:${type}:${source}`;
const subId = (type: string, source: string, key: string) => `sub:${type}:${source}:${key}`;

/** Prefix-star a query into AND-joinable rank terms (mid-word matching). */
function rankTermsOf(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t.length < 64)
    .map((t) => `${t.replace(/\*+$/, '')}*`)
    // clamp to the store's rank_terms cap so a long query never throws a ZodError
    // in the live search path and crashes the TUI every frame (audit finding 9/43)
    .slice(0, MAX_RANK_TERMS);
}

/**
 * The Knowledge tab is an up-to-4-level collapse/expand tree: knowledge
 * CATEGORY → SOURCE store → SUB-CATEGORY (code component) → record. The
 * sub-category level groups an expanded source's records by component
 * (knowledgeSubgroups, single-bucket dominant) and is OMITTED when the source
 * resolves to a single bucket (collapse-single-bucket) — then its records sit
 * directly under the source as before. When a `knowledge` MountedStores is
 * provided the tree fans across stores (project FIRST, then each mounted domain
 * in manifest order; empty sources dropped) via knowledgeCountBySource (badges)
 * + querySource (records on expand) / knowledgeSearch. When `knowledge` is
 * ABSENT the tree is sourced from the PROJECT `store` alone, so the single
 * source under every non-empty category is named 'project' (the P3 path).
 * Empty categories/sources are hidden; everything is collapsed by default. A
 * non-empty search query REPLACES the tree with a flat, AND-filtered card list
 * (every term prefix-starred). The other card tabs stay flat lists.
 */
export function nodesFor(store: SterlingStore, ui: UiState, knowledge?: MountedStores): Node[] {
  if (ui.tab === RUN_TAB) return [];
  if (ui.tab === QUEUE_TAB) return queueCards(store).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: false }));
  if (ui.tab !== KNOWLEDGE_TAB) return cardsFor(store, ui.tab).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: false }));

  const cap = 500;
  const query = ui.searchQuery.trim();
  if (query) {
    const terms = rankTermsOf(query);
    if (terms.length) {
      if (knowledge) {
        return knowledgeSearch(knowledge, terms).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: true }));
      }
      const types = KNOWLEDGE_CATEGORIES.map((c) => c.type);
      return store
        .query({ types, rank_terms: terms, match_all: true, cap })
        .map((r) => ({ kind: 'card' as const, card: { ...toCard(r), source: 'project' }, depth: 0, knowledge: true }));
    }
  }

  // collapsed default tree: only non-empty categories, in registry order; each
  // non-empty source appears when its category is expanded; cards appear when
  // their source is expanded. Category + source BADGES come from COUNT(*) — no
  // record body is fetched or parsed until a source is actually expanded (the
  // perf path: the default all-collapsed view runs counts, not 500-row body
  // fetches per category every frame). With `knowledge`, sources fan across
  // stores (knowledgeCountBySource: project first, domains next, empty dropped);
  // without it, the single 'project' source from the project store.
  const nodes: Node[] = [];
  for (const cat of KNOWLEDGE_CATEGORIES) {
    const sources = knowledge
      ? knowledgeCountBySource(knowledge, cat.type)
      : [{ source: 'project', count: store.count({ types: [cat.type] }) }].filter((s) => s.count > 0);
    const total = sources.reduce((n, s) => n + s.count, 0);
    if (total === 0) continue; // empty categories hidden
    nodes.push({ kind: 'category', type: cat.type, label: cat.label, count: total });
    if (!ui.expanded.includes(catId(cat.type))) continue;
    for (const sc of sources) {
      nodes.push({ kind: 'source', catType: cat.type, source: sc.source, count: sc.count });
      if (!ui.expanded.includes(srcId(cat.type, sc.source))) continue;
      // source expanded → NOW fetch this ONE source's record bodies (perf path)
      const records = knowledge
        ? knowledge.querySource(sc.source, { types: [cat.type], cap })
        : store.query({ types: [cat.type], cap });
      // 4th level: bucket the fetched records by code COMPONENT (single-bucket,
      // dominant). A source that resolves to a single bucket SKIPS the
      // sub-category level (collapse-single-bucket, P1) — its cards sit at
      // depth 2 directly under the source, exactly as before. Otherwise each
      // bucket is a foldable sub-category node and its cards sit at depth 3 when
      // expanded. No new query — we regroup the records already fetched, so the
      // COUNT-then-fetch perf model is untouched.
      const groups = knowledgeSubgroups(records);
      if (groups.length <= 1) {
        for (const card of groups[0]?.cards ?? []) {
          nodes.push({ kind: 'card', card: { ...card, source: sc.source }, depth: 2, knowledge: true });
        }
        continue;
      }
      for (const g of groups) {
        nodes.push({ kind: 'subcategory', catType: cat.type, source: sc.source, key: g.key, label: g.label, count: g.cards.length });
        if (!ui.expanded.includes(subId(cat.type, sc.source, g.key))) continue;
        for (const card of g.cards) {
          nodes.push({ kind: 'card', card: { ...card, source: sc.source }, depth: 3, knowledge: true });
        }
      }
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

/**
 * Pure System-tab projection (run r-f9a7): one row per config.models KEY, in
 * insertion order, id 'sys:<key>'. Governed agents (AGENT_MODEL_KEY) list under
 * their key; the INSTALLED frontmatter value renders (the copy that governs
 * dispatch), and a key whose installed value disagrees with config is flagged
 * drift with a visible marker (AC4; the P5 backstop for a partial projection).
 * config-only keys (coder_hard/classifiers) render their config value with no
 * governed agent. When ui.selector is open on a key, that row also renders the
 * inline picker options (catalog entries at the model stage; effort options at
 * the effort stage). Every line is clipped to `width` so the 33-col floor holds.
 */
export function buildSystemTab(snapshot: AgentRosterSnapshot, ui: UiState, width = Infinity): SystemTabView {
  const snap = snapshot ?? EMPTY_ROSTER;
  const keys = Object.keys(snap.configModels);
  const selector = ui.selector;
  const clip = (s: string): string => clipEllipsis(s, width);

  const rows: SystemRow[] = keys.map((key, i) => {
    const config = snap.configModels[key];
    const governed = snap.agents.filter((a) => AGENT_MODEL_KEY[a.name] === key);
    const agentNames = governed.map((a) => a.name);
    // the INSTALLED governing copy for a governed key; config for a config-only key
    const shownModel = governed.length ? governed[0].installedModel : config.model;
    const shownEffort = governed.length ? governed[0].installedEffort : config.effort;
    // row drift = ANY governed agent whose installed model/effort disagrees with
    // config (a partial projection leaves one agent stale → the AC4 P5 backstop)
    const drift = governed.some(
      (a) => driftOf(a.installedModel, config.model) || driftOf(a.installedEffort, config.effort)
    );
    const selected = i === ui.cursor;
    const marker = selected ? '› ' : '  ';
    // Title-cased label: the leading letter is capitalized so a config-only key
    // like coder_hard never surfaces the substring an agent name ('coder') would
    // match — the roster lists each agent in exactly one row (AC1).
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    const lines: SystemLine[] = [
      { text: clip(`${marker}${label}: ${shownModel} ${shownEffort}${drift ? '  drift' : ''}`), kind: 'title', selected },
    ];
    for (const name of agentNames) lines.push({ text: clip(`    ${name}`), kind: 'body' });

    if (selector && selector.key === key) {
      if (selector.stage === 'model') {
        snap.catalog.entries.forEach((e, oi) => {
          const m = oi === selector.highlight ? '› ' : '  ';
          lines.push({ text: clip(`  ${m}${e.id} ${e.label}`), kind: 'option', selected: oi === selector.highlight });
        });
      } else {
        effortOptions(key).forEach((eff, oi) => {
          const m = oi === selector.highlight ? '› ' : '  ';
          lines.push({ text: clip(`  ${m}effort ${eff}`), kind: 'option', selected: oi === selector.highlight });
        });
      }
    }
    return { id: `sys:${key}`, key, drift, agents: agentNames, lines };
  });

  // While a selector is open the view FOCUSES on the key under edit — the other
  // rows (and their config values, e.g. coder_hard's xhigh) are hidden so the
  // open picker's offered set is the only model/effort text on screen.
  const shown = selector ? rows.filter((r) => r.key === selector.key) : rows;
  // transient notice as a ⚠ banner line (audit findings 24/43, 41/43): a refusal
  // or a catalog/roster failure is visible above the roster, not lost.
  const catBanner = catalogBanner(snap.catalog, width);
  const banner = ui.notice ? [clip(`⚠ ${ui.notice}`), ...catBanner] : catBanner;
  return { rows: shown, banner };
}

/** The catalog-status banner: absent / current(fresh) / stale-with-date. */
function catalogBanner(catalog: CatalogStatusView, width: number): string[] {
  const clip = (s: string): string => clipEllipsis(s, width);
  if (!catalog.present) return [clip('catalog: none found')];
  if (catalog.stale) return [clip(`catalog stale (as of ${catalog.staleDate ?? '?'})`)];
  return [clip('catalog: current')];
}

/** Bridge the pure System projection into a DashboardState the renderer draws:
 *  the catalog banner as leading dim rows, then the roster rows. Untested by the
 *  phase oracle (which calls buildSystemTab directly) — this feeds main.ts. */
function systemDashboardState(
  ui: UiState,
  width: number,
  banner: string[],
  projectName: string,
  bodyTop: number,
  roster?: AgentRosterSnapshot
): DashboardState {
  const view = buildSystemTab(roster ?? EMPTY_ROSTER, ui, width);
  const rows: Row[] = [];
  let screenRow = 0;
  // the ⚠ notice (findings 24/43, 41/43) rides view.banner from buildSystemTab, so
  // it renders here through the normal banner loop below.
  for (const text of view.banner) {
    rows.push({ id: `sysbanner:${screenRow}`, type: 'system-banner', selected: false, expanded: false, lines: [{ text, kind: 'meta' }], screenRow });
    screenRow += 1;
  }
  for (const sr of view.rows) {
    const lines: RowLine[] = sr.lines.map((l) => ({
      text: l.text,
      kind: (l.kind === 'title' ? 'title' : l.kind === 'meta' ? 'meta' : 'body') as RowLine['kind'],
    }));
    rows.push({ id: sr.id, type: 'system', selected: sr.lines.some((l) => l.selected === true), expanded: false, lines, screenRow });
    screenRow += lines.length;
  }
  return {
    tabs: TABS.map((label, i) => ({ label, active: i === ui.tab })),
    rows,
    runSelected: false,
    emptyMessage: view.rows.length ? undefined : '(no configured models)',
    footer: `←/→ or 1-${TABS.length} tabs · ↑/↓ rows · enter change model/effort · esc cancel · q quit`,
    banner,
    projectName,
    bodyTop,
    scroll: 0,
  };
}

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false, knowledge?: MountedStores, roster?: AgentRosterSnapshot): DashboardState {
  const banner = bannerLines(width, showBanner);
  const bodyTop = banner.length + CHROME_BELOW_BANNER;
  // System tab (run r-f9a7): its own projection, not a card/knowledge list.
  if (ui.tab === SYSTEM_TAB) return systemDashboardState(ui, width, banner, projectName, bodyTop, roster);
  const nodes = nodesFor(store, ui, knowledge);
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
    } else if (node.kind === 'subcategory') {
      id = subId(node.catType, node.source, node.key);
      type = 'subcategory';
      expanded = ui.expanded.includes(id);
      const pad = '    '; // depth 2
      lines = [{ text: clipEllipsis(`${marker}${pad}${expanded ? '▾' : '▸'} ${node.label} (${node.count})`, width), kind: 'title' }];
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
  // body scroll (scrollable card tabs only): clamp the persisted offset to the
  // content height so the render window and the click hit-test agree. The
  // queue/run tabs have fixed layouts and never scroll; an unbounded viewport
  // (maxBodyLines = Infinity, e.g. tests) yields maxScroll 0 → scroll 0, so all
  // pre-scroll behaviour is unchanged.
  const scrollable = ui.tab !== QUEUE_TAB && ui.tab !== RUN_TAB;
  const totalBodyLines = rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
  const maxScroll = Number.isFinite(maxBodyLines) ? Math.max(0, totalBodyLines - maxBodyLines) : 0;
  const scroll = scrollable ? Math.max(0, Math.min(ui.scroll ?? 0, maxScroll)) : 0;
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
    scroll,
  };
}

/** Map an absolute screen line (1-based, terminal convention) to a row index, or -1.
 *  maxBodyLines bounds the hit-test to the rendered viewport (visibleBodyLines). */
export function screenLineToRow(state: DashboardState, line1: number, maxBodyLines = Infinity): number {
  const scroll = state.scroll ?? 0;
  // render draws absolute body line `abs` at bodyTop + (abs - scroll); invert
  // with + scroll. Visible window is [scroll, scroll + maxBodyLines). With
  // scroll 0 this is identical to the prior bodyLine math.
  const abs = line1 - 1 - state.bodyTop + scroll;
  if (abs < scroll || abs >= scroll + maxBodyLines) return -1;
  for (let i = 0; i < state.rows.length; i++) {
    const r = state.rows[i];
    if (abs >= r.screenRow && abs < r.screenRow + r.lines.length) return i;
  }
  return -1;
}

export function reduce(store: SterlingStore, ui: UiState, event: UiEvent, viewport: Viewport = {}, knowledge?: MountedStores, roster?: AgentRosterSnapshot): { ui: UiState; effects: Effect[] } {
  const maxBodyLines = viewport.maxBodyLines ?? Infinity;
  const nodes = nodesFor(store, ui, knowledge);
  const clamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, nodes.length - 1)));
  const effects: Effect[] = [];

  // a tab switch resets the cursor + scroll AND dismisses any open selector
  const switchTab = (index: number): UiState => ({ ...ui, tab: index, cursor: 0, scroll: 0, selector: undefined, notice: undefined });

  // the queue/run tabs have fixed layouts; only the card tabs scroll
  const scrollable = ui.tab !== QUEUE_TAB && ui.tab !== RUN_TAB;
  const buildSelf = (uiNext: UiState): DashboardState =>
    buildDashboardState(store, uiNext, viewport.width ?? Infinity, maxBodyLines, '', viewport.showBanner ?? false, knowledge, roster);

  // move the selection by `delta` and keep it inside the scroll window so the
  // viewport follows the cursor. An unbounded viewport or a non-scrolling tab
  // just moves the cursor (scroll stays 0) — the prior behaviour.
  const moveCursor = (delta: number): UiState => {
    const cursor = clamp(ui.cursor + delta);
    if (!scrollable || !Number.isFinite(maxBodyLines)) return { ...ui, cursor };
    const st = buildSelf({ ...ui, cursor });
    const total = st.rows.length ? st.rows[st.rows.length - 1].screenRow + st.rows[st.rows.length - 1].lines.length : 0;
    const max = Math.max(0, total - maxBodyLines);
    let scroll = ui.scroll ?? 0;
    const row = st.rows[cursor];
    if (row) {
      const top = row.screenRow;
      const bottom = row.screenRow + row.lines.length;
      if (top < scroll) scroll = top; // selection above the window → scroll up to its top
      else if (bottom > scroll + maxBodyLines) scroll = Math.min(top, bottom - maxBodyLines); // below → reveal it
    }
    return { ...ui, cursor, scroll: Math.max(0, Math.min(scroll, max)) };
  };

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
    if (node.kind === 'subcategory') {
      // fold/unfold the sub-category — navigation, not a selection
      return { ...ui, cursor: index, expanded: toggle(subId(node.catType, node.source, node.key)) };
    }
    const card = node.card;
    effects.push({ type: 'select', recordType: card.type, id: card.id });
    return { ...ui, cursor: index, expanded: toggle(card.id) };
  };

  switch (event.kind) {
    case 'key':
      // System tab (run r-f9a7): the inline model/effort selector state machine.
      // Handles roster navigation + open/navigate/confirm/commit/cancel; the
      // tab-switch / quit keys fall through to the generic handler below.
      if (ui.tab === SYSTEM_TAB && roster) {
        const sysKeys = Object.keys(roster.configModels);
        const sysClamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, sysKeys.length - 1)));
        const sel = ui.selector;
        switch (event.name) {
          case 'UP':
            if (sel) return { ui: { ...ui, selector: { ...sel, highlight: Math.max(0, sel.highlight - 1) } }, effects };
            return { ui: { ...ui, cursor: sysClamp(ui.cursor - 1) }, effects };
          case 'DOWN': {
            if (sel) {
              const n = sel.stage === 'model' ? roster.catalog.entries.length : effortOptions(sel.key).length;
              return { ui: { ...ui, selector: { ...sel, highlight: Math.min(Math.max(0, n - 1), sel.highlight + 1) } }, effects };
            }
            return { ui: { ...ui, cursor: sysClamp(ui.cursor + 1) }, effects };
          }
          case 'ESCAPE':
            if (sel) return { ui: { ...ui, selector: undefined }, effects };
            return { ui, effects };
          case 'ENTER':
          case 'SPACE': {
            const cursor = sysClamp(ui.cursor);
            const key = sysKeys[cursor];
            if (!key) return { ui, effects };
            if (!sel) {
              // do NOT open a picker on an empty/invalid catalog (audit finding
              // 24/43): the selector would show zero rows and every commit would
              // be silently refused — surface a notice instead.
              if (roster.catalog.entries.length === 0) {
                return { ui: { ...ui, cursor, notice: 'model catalog empty or invalid — nothing to pick; refresh the catalog first' }, effects };
              }
              // open the MODEL picker on the key under the cursor (highlight 0)
              return { ui: { ...ui, cursor, selector: { key, stage: 'model', highlight: 0 }, notice: undefined }, effects };
            }
            if (sel.stage === 'model') {
              // confirm the highlighted model → advance to the EFFORT picker
              const entry = roster.catalog.entries[sel.highlight];
              return { ui: { ...ui, selector: { key: sel.key, stage: 'effort', highlight: 0, model: entry ? entry.id : '' } }, effects };
            }
            // effort stage → COMMIT: validate the model floor, then emit the swap
            const efforts = effortOptions(sel.key);
            const effort = efforts[sel.highlight] ?? efforts[0];
            const model = sel.model ?? '';
            const config = roster.configModels[sel.key];
            if (config && MODEL_VALUE_RE.test(model)) {
              const agents = roster.agents.filter((a) => AGENT_MODEL_KEY[a.name] === sel.key).map((a) => a.name);
              effects.push({
                type: 'model_swap',
                key: sel.key,
                from: { model: config.model, effort: config.effort },
                to: { model, effort },
                agents,
                decisionTitle: `Model swap: ${sel.key} ${config.model}→${model} (System tab)`,
              });
              return { ui: { ...ui, selector: undefined, notice: undefined }, effects };
            }
            // a non-claude model is REFUSED — surface it (audit finding 24/43); a
            // silent close was indistinguishable from a successful swap.
            return {
              ui: { ...ui, selector: undefined, notice: `model swap refused: '${model || '(none)'}' is not a valid claude-* model id` },
              effects,
            };
          }
        }
      }
      switch (event.name) {
        case 'QUIT':
          effects.push({ type: 'quit' });
          return { ui, effects };
        case 'ESCAPE':
          // the Knowledge field is always live: Esc clears the query + cursor
          if (ui.tab === KNOWLEDGE_TAB) {
            return { ui: { ...ui, searchQuery: '', cursor: 0, scroll: 0 }, effects };
          }
          return { ui, effects };
        case 'BACKSPACE':
          if (ui.tab === KNOWLEDGE_TAB) {
            return { ui: { ...ui, searchQuery: ui.searchQuery.slice(0, -1), cursor: 0, scroll: 0 }, effects };
          }
          return { ui, effects };
        case 'LEFT':
          return { ui: switchTab((ui.tab + TABS.length - 1) % TABS.length), effects };
        case 'RIGHT':
        case 'TAB':
          return { ui: switchTab((ui.tab + 1) % TABS.length), effects };
        case 'UP':
          return { ui: moveCursor(-1), effects };
        case 'DOWN':
          return { ui: moveCursor(1), effects };
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
        return { ui: { ...ui, searchQuery: ui.searchQuery + ch, cursor: 0, scroll: 0 }, effects };
      }
      if (ch === 'q') {
        effects.push({ type: 'quit' });
        return { ui, effects };
      }
      // A real space key arrives as a CHAR (terminal-kit names printable keys by
      // their character, so a 'SPACE' key-name never reaches the reducer from a
      // real terminal). On the System tab, activate() no-ops (no card nodes), so
      // route space to the same selector logic as ENTER — otherwise the picker's
      // SPACE handling was reachable only by tests (audit finding 39/43).
      if (ch === ' ' && ui.tab === SYSTEM_TAB) {
        return reduce(store, ui, { kind: 'key', name: 'ENTER' }, viewport, knowledge, roster);
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
    case 'wheel': {
      // wheel scrolls the viewport by lines (so you can read a tall expanded
      // record); on the fixed queue/run tabs it keeps moving the cursor.
      if (!scrollable) return { ui: { ...ui, cursor: clamp(ui.cursor + (event.dy > 0 ? 1 : -1)) }, effects };
      const desired = (ui.scroll ?? 0) + (event.dy > 0 ? 3 : -3);
      const st = buildSelf({ ...ui, scroll: desired });
      return { ui: { ...ui, scroll: st.scroll }, effects };
    }
    case 'click': {
      // build the same geometry the renderer drew with — wrapped heights, the
      // queue tab's pending truncation, AND the banner-driven bodyTop must all
      // match the screen, so the tab-bar row and body hit-test track the banner
      const state = buildDashboardState(store, ui, viewport.width ?? Infinity, maxBodyLines, '', viewport.showBanner ?? false, knowledge, roster);
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
      return { ui: { ...ui, expanded: [], scroll: 0 }, effects };
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
