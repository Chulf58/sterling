// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import { execFileSync } from 'node:child_process';
import type { SterlingStore, MountedStores } from '@sterling/store';
import { MAX_RANK_TERMS, rankTermDedupeKey } from '@sterling/store';
import { AGENT_MODEL_KEY } from '@sterling/schemas';
import { KNOWLEDGE_CATEGORIES, toCard, toInboundSupersedesEntries, withInboundSupersedes, knowledgeCountBySource, knowledgeSubgroups, knowledgeSearch, completedQueueLines, activityLines, queueCards, todoCards, type Card } from './viewmodel.js';
import { bannerLines } from './banner.js';
import type { GithubPr, GithubSnapshot } from './github-status.js';

/** 40-hex commit sha — mirrors mcp-server's MEASURED_AT_HEAD_RE
 *  (packages/mcp-server/src/tools.ts:1008, decision
 *  board-provenance-measured-at-head), so a malformed resolver result reads
 *  the same as an unresolved one rather than reaching the store to fail
 *  zod's identical regex there. */
const MEASURED_AT_HEAD_RE = /^[0-9a-f]{40}$/;

/** Tasks tab board-item edit, fix 1 (Opus review round, feat/gap-hunt-round-1
 *  71c1f41): the default `resolveHeadSha` a board_edit commit uses to restamp
 *  measured_at_head, mirroring board_update's own restamp-on-text-change
 *  (packages/mcp-server/src/tools.ts:9684-9690). `git rev-parse HEAD` walks
 *  UP from cwd to find `.git` on its own, so no repoRoot needs threading in —
 *  state.ts has none (SterlingStore exposes no public path/repoRoot getter,
 *  and main.ts, which resolves the project root from --store, is out of this
 *  round's edit scope). `process.cwd()` is exactly what a user's own git
 *  commands would resolve against too, since sterling-tui is launched from
 *  the project directory in normal use. Returns undefined (never throws) on
 *  any failure — no git binary, not a repo, a shallow clone with no HEAD —
 *  so reduce()'s caller degrades loud (a notice) rather than crashing. */
function defaultResolveHeadSha(): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return MEASURED_AT_HEAD_RE.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export const TABS = ['Tasks', 'Knowledge', 'Queue', 'Agents', 'System', 'GitHub'] as const;
/** the board (user-source todos) — the tab boardEdit's 'e' key operates on */
export const TASKS_TAB = TABS.indexOf('Tasks');
/** the knowledge explorer (formerly 'Articles'): a category→source→record tree */
export const KNOWLEDGE_TAB = TABS.indexOf('Knowledge');
export const QUEUE_TAB = TABS.indexOf('Queue');
/** the live Sub-agents cards (Claude Code's terminal dashboard only): the host paints the
 *  cards, this layer owns the tab, its count label and its navigation. A host that does not
 *  paint them (the OpenCode full view, which lists sub-agents under every tab) leaves
 *  Viewport.agents unset, and the tab is neither shown nor reachable. */
export const AGENTS_TAB = TABS.indexOf('Agents');
/** the System tab (run r-f9a7): the agent roster with drift + catalog status,
 *  and the inline model/effort swap selector — the TUI's first write surface */
export const SYSTEM_TAB = TABS.indexOf('System');
/** the GitHub tab (board 87bca3f8): open PRs, the PR loop and recent merges,
 *  from the host's GitHub poller snapshot (Viewport.github). A host without a
 *  poller (the OpenCode dashboard) leaves it unset, and the tab is neither
 *  shown nor reachable. */
export const GITHUB_TAB = TABS.indexOf('GitHub');

/** The Knowledge tab's feature-article state filter, in cycle order. 'all' is the
 *  unfiltered position (UiState.stateFilter absent); the rest mirror the state
 *  enum in packages/schemas/src/records.ts. */
export const ARTICLE_STATE_FILTERS = ['all', 'planned', 'built', 'wired_in', 'active', 'dormant', 'deprecated'] as const;

export interface UiState {
  /** the selected row's id (record id, or the cat:/src:/sub: id of a tree
   *  node). It wins over `cursor` while the row is still listed, so a record
   *  added or removed above the selection does not move it to another record. */
  selectedId?: string;
  tab: number;
  cursor: number;
  expanded: string[];
  /** Knowledge-tab FTS filter; an always-visible field — printable keys feed it
   *  directly (no '/' toggle). Persists across tab switches until ESC clears it. */
  searchQuery: string;
  /** Knowledge tab: show only feature articles in this state (ctrl-f cycles
   *  ARTICLE_STATE_FILTERS). Absent → all. Other record types are not filtered. */
  stateFilter?: string;
  /** body scroll offset in display LINES (0-based). Absent → 0.
   *  buildDashboardState clamps it to the content height each frame; on the
   *  Queue tab it scrolls the pending list inside its upper-half window. Wheel
   *  moves it; ↑/↓ adjust it to keep the selected row in view. */
  scroll?: number;
  /** Queue tab: scroll offset of the history list (completed + activity) in
   *  lines, independent of the pending list's `scroll`. Absent → 0. */
  historyScroll?: number;
  /** System tab (run r-f9a7): the inline model/effort selector state machine.
   *  Absent → the plain roster is shown; present → a picker is open on
   *  ui.selector.key (model stage, then effort stage). ESCAPE clears it. */
  selector?: SystemSelector;
  /** Transient System-tab notice (audit findings 24/43, 41/43): a refusal or a
   *  degraded-loud message shown as a ⚠ banner row, so a silently-refused model
   *  swap or a catalog/roster failure is VISIBLE (not lost to the alternate
   *  screen). Cleared on the next navigation / tab switch / selector open. */
  notice?: string;
  /** System tab, sparring-partner model row (board a0714d0b, slice 2): free-text
   *  edit-in-progress buffer for sparring_partner.model. Absent → the plain
   *  value is shown; present (even '') → every printable key/BACKSPACE feeds
   *  it, ENTER commits (empty commits as "unset"), ESCAPE cancels. Mirrors the
   *  Knowledge tab's always-visible-field idiom, scoped to one row. */
  sparringModelEdit?: string;
  /** Tasks tab, board item edit-in-progress (user-ruled 2026-09-28, board
   *  f25e5547 lane J: "Add TUI edit"). Absent → the plain card is shown;
   *  present → 'e' has opened the selected todo's text for editing — every
   *  printable key/BACKSPACE feeds `text`, ENTER commits (through the same
   *  store write path board_update uses), ESCAPE cancels. Mirrors
   *  sparringModelEdit's always-capture idiom, scoped to one card.
   *  `version` (fix round, Opus review of 71c1f41) is the record's version
   *  as read the moment 'e' was pressed — read fresh via store.get, never
   *  from the projected Card, which carries no version field. ENTER re-reads
   *  the live record and refuses the commit (visible notice, buffer KEPT) if
   *  the stored version has moved — the lost-update guard. */
  boardEdit?: { id: string; text: string; version: number };
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
// ACTIVATION (never the 1 Hz loop, per decision foreign_98064d77) and the pure
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
/** Sparring-partner config (board a0714d0b, article sparring-partner interaction
 *  h/i): the TUI-editable slice of config.sparring_partner. model absent/empty
 *  = Codex CLI default. */
export interface SparringPartnerView {
  enabled: boolean;
  model?: string;
}
export interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
  /** config.sparring_partner, read at the same activation-only cadence as the
   *  rest of the snapshot. Additive-optional (decision foreign_34d61f60's idiom, as
   *  cited for the roster? param itself): absent → defaults applied where
   *  rendered, so the phase-4 fixtures that predate this field keep compiling
   *  and passing unchanged. */
  sparringPartner?: SparringPartnerView;
  /** Machine-probe fact (article interaction h, P5): whether THIS machine's
   *  plugin manifest (.claude-plugin/sterling-mcp.json) carries a codex mcp
   *  server entry. Presence = wired. Computed once at activation, never the
   *  1 Hz loop — a probe, not a live poll. Distinct from sparringPartner.enabled
   *  (a deliberate per-project choice): this is a per-machine capability fact
   *  that flipping the toggle must never hide. Additive-optional, same reason
   *  as sparringPartner above. */
  codexWired?: boolean;
  /** config.tdd (decision foreign_752caf98, tdd-and-mutation-toggles-in-system-tab):
   *  the TDD-by-default posture toggle. Additive-optional, same idiom as
   *  sparringPartner — absent → the buildSystemTab default below applies. */
  tdd?: { enabled: boolean };
  /** config.mode (decision project-mode-hobby-work-toggle-decides-flow): the RAW
   *  config value, never the parsed one, so an invalid value renders INVALID
   *  instead of vanishing into a failed parse. Absent → hobby (the schema default);
   *  null → the config could not be read (UNKNOWN, never the default). */
  mode?: string | null;
  /** The handoff setting (decision
   *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
   *  true or false is the EFFECTIVE setting as the writers read it
   *  (readHandoffEnabled: config.handoff.enabled, or on when the key is absent
   *  and handoff files are tracked in git). A string is a raw value that is
   *  not a boolean (INVALID). Absent → off; null → the setting could not be
   *  determined (UNKNOWN, never the default): the config could not be read, or
   *  the key is absent and git could not say what is tracked. */
  handoff?: boolean | string | null;
  /** Why the handoff row reads as it does, shown in brackets after the value:
   *  'not set' for an absent key, the tracked-files note for ON without a key,
   *  and the git error for UNKNOWN. Absent for an explicit key; an UNKNOWN
   *  without it is an unreadable config. */
  handoffDetail?: string;
  /** config.storage (decision storage-backend-is-its-own-config-key-written-only-by-store-move),
   *  read-only: the RAW config value, so an unrecognized value shows as such instead
   *  of vanishing. Absent → SQLite (the routing default); null → the config could
   *  not be read (UNKNOWN, never the default). Only 'sqlite' and 'postgres' are
   *  recognized; any other value comes back as its JSON text. */
  storage?: string | null;
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
  /** Sparring-partner rows (board a0714d0b, slice 2): a SEPARATE list from
   *  `rows` — `rows` stays exactly one entry per config.models key (the
   *  phase-4 frozen contract), so the toggle + model rows never join it.
   *  Two rows, ids 'sys:sparring_enabled' / 'sys:sparring_model', in that
   *  order; hidden while a config.models picker (ui.selector) is open, same
   *  focus rule as the roster rows. */
  sparringRows: SystemRow[];
  /** tdd toggle row (decision foreign_752caf98): a single-entry list, mirroring
   *  sparringRows[0]'s toggle-only shape (the field carries no model, so
   *  there is no second row). Appended after sparringRows in cursor order;
   *  hidden while a config.models picker is open, same focus rule as
   *  sparringRows/rows. The sibling mutationRows list this used to sit
   *  beside was REMOVED entirely (decision
   *  cleanup-run-deletes-dead-scripts-and-removes-mutation-verification-key,
   *  2026-09-22). */
  tddRows: SystemRow[];
  /** project mode toggle row (decision project-mode-hobby-work-toggle-decides-flow):
   *  a single-entry list, same toggle-only shape as tddRows, appended after it in
   *  cursor order; hidden while a config.models picker is open. */
  modeRows: SystemRow[];
  /** handoff files toggle row (decision
   *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
   *  a single-entry list, same toggle-only shape as modeRows, appended after it in
   *  cursor order; hidden while a config.models picker is open. */
  handoffRows: SystemRow[];
  /** storage row (board 6ca1a3c5): a single-entry READ-ONLY list drawn after the
   *  handoff row. It owns no cursor index (the cursor clamp does not count it) and
   *  no effect, because only the move-store skill writes config.storage. */
  storageRows: SystemRow[];
}

const EMPTY_ROSTER: AgentRosterSnapshot = {
  agents: [],
  configModels: {},
  catalog: { present: false, stale: false, staleDate: null, entries: [] },
  sparringPartner: { enabled: true },
  codexWired: false,
  tdd: { enabled: true },
  mode: 'hobby',
  handoff: false,
  storage: undefined,
};

/** Pure scalar drift check: true iff the installed value differs from config. */
export function driftOf(installed: string, config: string): boolean {
  return installed !== config;
}

/** System tab, LOW-3 (second Opus re-check round, feat/gap-hunt-round-1
 *  22e20f9): the ONLY config.models keys the System tab may render/edit —
 *  every governed agent key from AGENT_MODEL_KEY (the classless four-agent
 *  roster, decision agent-roster-is-classless-four-agents f0893161) plus
 *  'classifiers', the schema's one legitimate config-only key
 *  (packages/schemas/src/config.ts's `models` object — the only 5 keys it
 *  actually defines). A relic/legacy key such as 'coder_hard' — no agent has
 *  EVER read it, and update/init now flag it as unread — is filtered out
 *  here rather than trusted from whatever `configModels` the caller hands
 *  in: a defensive floor, not just a fixture cleanup, since an old
 *  project's config.json can carry a stray key forever. */
const SYSTEM_TAB_MODEL_KEYS = new Set<string>([...Object.values(AGENT_MODEL_KEY), 'classifiers']);

/** §7.2 effort rule as data: no System-tab key ever offers xhigh or max. The
 *  one-time exception (coder_hard) was itself a config-only key no agent
 *  ever read, and it is no longer a renderable row at all (LOW-3 above) —
 *  so there is no longer a key this function needs to special-case. */
export function effortOptions(key: string): string[] {
  return ['low', 'medium', 'high'];
}

/** The model-value floor (decision foreign_98064d77): a committed swap model must be a
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
/** Enables the Agents tab; `running` is the live agent count shown in its label. */
export interface AgentsTab {
  running: number;
}

/** The tab indices a host can reach: every tab, minus Agents and GitHub unless the host enabled them. */
export function visibleTabs(agents?: AgentsTab, github?: GithubSnapshot): number[] {
  return TABS.map((_, i) => i).filter((i) => (i !== AGENTS_TAB || agents !== undefined) && (i !== GITHUB_TAB || github !== undefined));
}

export interface Viewport {
  /** set by a host that paints the Agents tab's cards */
  agents?: AgentsTab;
  /** columns available — wraps expanded bodies, clips collapsed titles */
  width?: number;
  /** body lines visible — the click hit-test bound (visibleBodyLines) */
  maxBodyLines?: number;
  /** whether the banner is shown (STERLING_NO_BANNER=1 → false) — drives the
   *  banner height, hence bodyTop and the tab-bar click row */
  showBanner?: boolean;
  /** pane rows: under COMPACT_BELOW_HEIGHT the banner is the 4-row scene, so
   *  bodyTop and the tab-bar click row move with it. Absent → unbounded. */
  height?: number;
  /** set by a host that polls GitHub (github-status.ts): the poller's latest
   *  snapshot. It enables the GitHub tab and the strip row; the state layer
   *  only reads it and never runs gh. */
  github?: GithubSnapshot;
}

export interface DashboardState {
  /** `index` is the tab's TABS index: the tab bar can skip a tab, so a position is not an index */
  tabs: { label: string; active: boolean; index: number }[];
  rows: Row[];
  emptyMessage?: string;
  /** the mode's key help, at most 48 columns and clipped to the pane; the
   *  renderer pins it to the last row */
  footer: string;
  /** a warning ('⚠ …', clipped to the pane) drawn on its own row just above
   *  the footer (above the strip when there is one) in the warning colour;
   *  absent when there is none */
  notice?: string;
  /** the GitHub strip row (githubStrip), pinned just above the footer; dim for
   *  a failure or stale data. Absent when there is nothing to show, and then
   *  the row is not reserved. */
  strip?: { text: string; dim: boolean };
  /** Knowledge-tab search bar (always-visible field), shown on the spacer line */
  searchLine?: string;
  /** queue tab only: the completed (drain log) section in the lower half —
   *  log lines, not records; never selectable (§3.2.7/§11) */
  queueCompleted?: {
    /** body-line offset of the divider (fixed at half the viewport) */
    startRow: number;
    /** lines of the pending list's window (rows above it scroll by `scroll`);
     *  absent → startRow */
    pendingLines?: number;
    /** history scroll: lines of `lines` + the activity section skipped from
     *  the top, clamped. Absent → 0 */
    scroll?: number;
    header: string;
    lines: string[];
    /** present when pending was clipped at the divider: '… N more pending' */
    overflow?: string;
  };
  /** queue tab only: the ACTIVITY section (board 39d6462d) — every knowledge
   *  write (create/update/link/remove/retire/promote), newest first. A
   *  SEPARATE section from queueCompleted: that section's meaning stays
   *  'maintenance debt paid' (drain log), unchanged; this one is "what has
   *  been done" across the whole store. Drawn immediately below the completed
   *  section (render.ts), same log-line convention: dim, never selectable. */
  queueActivity?: {
    header: string;
    lines: string[];
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
   *  adds it back, so screen and clicks agree. 0 on the queue tab and
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
/** The `r` key on a host with a GitHub poller: poll now. */
export interface GithubRefreshEffect {
  type: 'github_refresh';
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
/** System tab, sparring-partner toggle row (board a0714d0b): flips
 *  config.sparring_partner.enabled. Advisory-only (article interaction a) — the
 *  toggle only silences the automatic consult moments, it never gates. */
export interface SparringToggleEffect {
  type: 'sparring_toggle';
  enabled: boolean;
}
/** System tab, sparring-partner model row: commits the free-text edit. An empty
 *  value clears the field back to unset (CLI default). */
export interface SparringModelEffect {
  type: 'sparring_model';
  model: string;
}
/** System tab, tdd toggle row (decision foreign_752caf98): flips config.tdd.enabled.
 *  OFF silences the automatic default posture only — H5/H18 test protection
 *  is untouched, and an explicit user ask still fires TDD. */
export interface TddToggleEffect {
  type: 'tdd_toggle';
  enabled: boolean;
}
/** System tab, project mode row (decision project-mode-hobby-work-toggle-decides-flow):
 *  writes config.mode. Carries the NEW mode. */
export interface ModeToggleEffect {
  type: 'mode_toggle';
  mode: 'hobby' | 'work';
}
/** System tab, handoff files row (decision
 *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
 *  writes config.handoff.enabled. Carries the NEW value. */
export interface HandoffToggleEffect {
  type: 'handoff_toggle';
  enabled: boolean;
}
/** Tasks tab board-item edit commit (user-ruled 2026-09-28, board f25e5547
 *  lane J): the TUI's second write surface after the System tab. Carries the
 *  full replacement text; runEffects executes it through the same store
 *  write path board_update uses (SterlingStore.updateTodo — same id, same
 *  slug, version bumped), never the MCP tool surface. `version` (fix round)
 *  is the pre-write version reduce() already confirmed live and unmoved —
 *  carried through as `expected_version` so the store's own optimistic-
 *  concurrency check backstops the reduce()-time guard against the (in a
 *  single TUI process, vanishingly small) window between the check and this
 *  write. `measuredAtHead`, when reduce() resolved one, restamps
 *  measured_at_head the same way board_update does on a text change
 *  (decision board-provenance-measured-at-head); absent when the resolver
 *  failed — the field is then left untouched, never cleared. */
export interface BoardEditEffect {
  type: 'board_edit';
  id: string;
  text: string;
  version: number;
  measuredAtHead?: string;
}
export type Effect =
  | SelectEffect
  | QuitEffect
  | ModelSwapEffect
  | SparringToggleEffect
  | SparringModelEffect
  | TddToggleEffect
  | ModeToggleEffect
  | HandoffToggleEffect
  | BoardEditEffect
  | GithubRefreshEffect;

export type UiEvent =
  | { kind: 'key'; name: 'LEFT' | 'RIGHT' | 'TAB' | 'UP' | 'DOWN' | 'ENTER' | 'SPACE' | 'QUIT' | 'ESCAPE' | 'BACKSPACE' | 'STATE_FILTER' }
  | { kind: 'char'; ch: string } // printable keys — search input, 'q' quit, digit hotkeys, '/' search
  | { kind: 'tab'; index: number } // direct tab select, 0-based; out-of-range ignored here
  | { kind: 'click'; x: number; y: number }
  | { kind: 'rightclick' }
  | { kind: 'wheel'; dy: number; y?: number }; // y: 1-based screen line, picks the Queue tab's list

/** One glyph per feature-article state, filling up along the lifecycle
 *  (planned → built → wired_in → active); the expanded card's meta line names
 *  the state in words. */
export const STATE_GLYPHS: Readonly<Record<string, string>> = {
  planned: '○',
  built: '◔',
  wired_in: '◑',
  active: '●',
  dormant: '◌',
  deprecated: '×',
};
/** The Knowledge tab's state column: a 1-character glyph and a space on
 *  feature article rows ('?' for a state not in STATE_GLYPHS), nothing on any
 *  other row. */
function stateColumn(card: Card): string {
  return card.state ? `${STATE_GLYPHS[card.state] ?? '?'} ` : '';
}

export function cardsFor(store: SterlingStore, tab: number, expanded: string[] = []): Card[] {
  if (tab === 0) return todoCards(store, expanded);
  return [];
}

/**
 * A navigable line-owning entry. On the Knowledge tab the tree has up to four
 * node kinds (category → source → sub-category → record), each carrying its
 * depth for indentation; card nodes also flag whether they are knowledge-tab
 * cards (readable layout) or plain cards (todos/queue, the legacy
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

/** The row id buildDashboardState gives a node. */
function nodeId(node: Node): string {
  if (node.kind === 'category') return catId(node.type);
  if (node.kind === 'source') return srcId(node.catType, node.source);
  if (node.kind === 'subcategory') return subId(node.catType, node.source, node.key);
  return node.card.id;
}

/** The cursor the dashboard draws: the row holding ui.selectedId while it is
 *  still listed, else ui.cursor; clamped to the list. */
function resolveCursor(ui: UiState, nodes: Node[]): number {
  const held = ui.selectedId === undefined ? -1 : nodes.findIndex((n) => nodeId(n) === ui.selectedId);
  return Math.min(held >= 0 ? held : ui.cursor, Math.max(0, nodes.length - 1));
}

/** Prefix-star a query into AND-joinable rank terms (mid-word matching).
 *  Dedupe (via the store's OWN rankTermDedupeKey — one definition, not two)
 *  runs BEFORE the cap: a repeated search word must not eat a slot a
 *  distinct word needed (Sol fix round item 3). Exported for direct testing
 *  (file header: testability lives in state.ts, never the renderer). */
export function rankTermsOf(query: string): string[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && t.length < 64)
    .map((t) => `${t.replace(/\*+$/, '')}*`);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const term of words) {
    const key = rankTermDedupeKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(term);
  }
  // clamp to the store's rank_terms cap so a long query never throws a ZodError
  // in the live search path and crashes the TUI every frame (audit finding 9/43)
  return deduped.slice(0, MAX_RANK_TERMS);
}

/**
 * Reverse-edge (`inbound_supersedes`) disclosure for ONE card, board c6e3561f
 * arm 2. Applied at the point a card is known to be RENDERED — every node-push
 * site in nodesFor, the search branches included — and gated on that card
 * being EXPANDED, because only an expanded card's body is ever built
 * (buildDashboardState renders `card.body` for expanded knowledge cards only).
 *

 * THE HONEST BOUND is "one reverse-edge query per STRUCTURALLY EMITTED, EXPANDED
 * knowledge card, per projection call" — NOT "one per tick", and NOT bounded by
 * what the user can actually SEE. Two amplifications, both confirmed by outside-
 * family review 2026-08-27 and deliberately NOT engineered away here:
 * (a) hydration runs while building every emitted node, BEFORE viewport clipping,
 *     so an expanded card scrolled far above or below the visible rows is still
 *     queried; and

 * (b) a single input event can call nodesFor() more than once — there are FOUR
 *     call sites (reduce, buildSelf, the click path, and main.ts's redraw), so
 *     "per tick" undercounts by whatever the event path multiplies.
 * The pin below measures ONE direct buildDashboardState() call with an effectively
 * unbounded viewport, so it CANNOT see either amplification: treat the bound as
 * read-verified, not test-enforced. Stated at full strength rather than softened

 * because the previous wording overclaimed and a reader trusted it.
 *
 * WHY N IS IRREDUCIBLE, given the above: `ui.expanded` is ADDITIVE — reduce's
 * toggle never collapses siblings — so N simultaneously-expanded cards cost N
 * queries, and each of those N cards is drawing a body that must carry its
 * disclosure. What hydrating at the PUSH SITE buys is the other direction, which
 * the earlier record-level gate got wrong: it also fired for cards sitting behind
 * a COLLAPSED sub-category, which are never emitted at all. Those now cost zero.
 */
function hydrateInbound(
  card: Card,
  ui: UiState,
  reader: { inboundSupersedes(id: string): unknown[] },
): Card {
  if (!ui.expanded.includes(card.id)) return card;
  const inbound = reader.inboundSupersedes(card.id);
  return inbound.length ? withInboundSupersedes(card, toInboundSupersedesEntries(inbound)) : card;
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
  if (ui.tab === QUEUE_TAB) return queueCards(store).map((card) => ({ kind: 'card' as const, card, depth: 0, knowledge: false }));
  if (ui.tab !== KNOWLEDGE_TAB) return cardsFor(store, ui.tab, ui.expanded).map((card) => ({ kind: 'card' as const, card, depth: card.depth ?? 0, knowledge: false }));

  const cap = 500;
  const query = ui.searchQuery.trim();
  // state filter: drops feature articles outside the chosen state; every other
  // record type passes through untouched.
  const inState = (r: unknown): boolean => {
    const rec = r as { type?: string; state?: string };
    return !ui.stateFilter || rec.type !== 'feature_article' || rec.state === ui.stateFilter;
  };
  const cardInState = (c: Card): boolean => !ui.stateFilter || c.type !== 'feature_article' || c.state === ui.stateFilter;
  if (query) {
    const terms = rankTermsOf(query);
    if (terms.length) {
      // SEARCH also carries the inbound_supersedes disclosure (review finding,
      // lane A2): a card reached by search and the same card reached by the
      // category tree must render identically — same body, same disclosure —
      // and the query stays gated on that card being expanded.
      if (knowledge) {
        return knowledgeSearch(knowledge, terms).filter(cardInState).map((card) => ({ kind: 'card' as const, card: hydrateInbound(card, ui, knowledge), depth: 0, knowledge: true }));
      }
      const types = KNOWLEDGE_CATEGORIES.map((c) => c.type);
      return store
        .query({ types, rank_terms: terms, match_all: true, cap })
        .filter(inState)
        .map((r) => ({ kind: 'card' as const, card: hydrateInbound({ ...toCard(r), source: 'project' }, ui, store), depth: 0, knowledge: true }));
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
      // inbound_supersedes disclosure (board c6e3561f part (2)) is hydrated
      // per CARD at the push sites below (hydrateInbound), not per fetched
      // record here: a record behind a COLLAPSED sub-category is fetched but
      // never rendered, and paying a reverse-edge query for it was the false
      // half of the old "one query for the expanded card" bound.
      // 4th level: bucket the fetched records by code COMPONENT (single-bucket,
      // dominant). A source that resolves to a single bucket SKIPS the
      // sub-category level (collapse-single-bucket, P1) — its cards sit at
      // depth 2 directly under the source, exactly as before. Otherwise each
      // bucket is a foldable sub-category node and its cards sit at depth 3 when
      // expanded. No new query — we regroup the records already fetched, so the
      // COUNT-then-fetch perf model is untouched.
      const groups = knowledgeSubgroups(records.filter(inState));
      const reader = knowledge ?? store;
      if (groups.length <= 1) {
        for (const card of groups[0]?.cards ?? []) {
          nodes.push({ kind: 'card', card: hydrateInbound({ ...card, source: sc.source }, ui, reader), depth: 2, knowledge: true });
        }
        continue;
      }
      for (const g of groups) {
        nodes.push({ kind: 'subcategory', catType: cat.type, source: sc.source, key: g.key, label: g.label, count: g.cards.length });
        if (!ui.expanded.includes(subId(cat.type, sc.source, g.key))) continue;
        for (const card of g.cards) {
          nodes.push({ kind: 'card', card: hydrateInbound({ ...card, source: sc.source }, ui, reader), depth: 3, knowledge: true });
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
 * bodyTop+1 .. height-2 (bottom two reserved for the notice row + footer).
 * bannerHeight shrinks the body region by the banner's rows, and stripRows
 * (githubStripRows: 1 while the GitHub strip shows) by the strip's row above
 * the footer. Must stay in sync with the draw() clamp in render.ts — rows the
 * renderer clips must not be clickable.
 */
export function visibleBodyLines(height: number, bannerHeight = 0, stripRows = 0): number {
  return Math.max(0, height - bannerHeight - CHROME_BELOW_BANNER - 2 - stripRows);
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
 * Pure System-tab projection (run r-f9a7): one row per LIVE config.models
 * KEY (SYSTEM_TAB_MODEL_KEYS — LOW-3, second Opus re-check round: a relic
 * key like 'coder_hard' is filtered out here regardless of what the caller's
 * snapshot carries), in insertion order, id 'sys:<key>'. Governed agents
 * (AGENT_MODEL_KEY) list under their key; the INSTALLED frontmatter value
 * renders (the copy that governs dispatch), and a key whose installed value
 * disagrees with config is flagged drift with a visible marker (AC4; the P5
 * backstop for a partial projection). classifiers, the one config-only key,
 * renders its config value with no governed agent. When ui.selector is open
 * on a key, that row also renders the inline picker options (catalog
 * entries at the model stage; effort options at the effort stage). Every
 * line is clipped to `width` so the 33-col floor holds.
 */
export function buildSystemTab(snapshot: AgentRosterSnapshot, ui: UiState, width = Infinity): SystemTabView {
  const snap = snapshot ?? EMPTY_ROSTER;
  const keys = Object.keys(snap.configModels).filter((k) => SYSTEM_TAB_MODEL_KEYS.has(k));
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
    // like classifiers never surfaces the substring an agent name would match —
    // the roster lists each agent in exactly one row (AC1).
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
  // rows (and their config values) are hidden so the open picker's offered set
  // is the only model/effort text on screen.
  const shown = selector ? rows.filter((r) => r.key === selector.key) : rows;
  // transient notice as a ⚠ banner line (audit findings 24/43, 41/43): a refusal
  // or a catalog/roster failure is visible above the roster, not lost.
  const catBanner = catalogBanner(snap.catalog, width);
  const banner = ui.notice ? [clip(`⚠ ${ui.notice}`), ...catBanner] : catBanner;
  // Sparring-partner rows sit AFTER the config.models keys in cursor order
  // (cursorBase = keys.length); hidden while a config.models picker focuses the
  // view, same rule as the roster rows above.
  const sparringRows = selector ? [] : sparringPartnerRows(snap, ui, width, keys.length);
  // the tdd row continues past the two sparring rows (keys.length,
  // keys.length + 1) at keys.length + 2.
  const tddRows = selector ? [] : [tddToggleRow(snap, ui, width, keys.length + 2)];
  // the project mode row follows the tdd row, at keys.length + 3.
  const modeRows = selector ? [] : [modeToggleRow(snap, ui, width, keys.length + 3)];
  // the handoff files row follows the project mode row, at keys.length + 4.
  const handoffRows = selector ? [] : [handoffToggleRow(snap, ui, width, keys.length + 4)];
  // the storage row is read-only: it takes no cursor index.
  const storageRows = selector ? [] : [storageRow(snap, width)];
  return { rows: shown, banner, sparringRows, tddRows, modeRows, handoffRows, storageRows };
}

/** The catalog-status banner: absent / current(fresh) / stale-with-date. */
function catalogBanner(catalog: CatalogStatusView, width: number): string[] {
  const clip = (s: string): string => clipEllipsis(s, width);
  if (!catalog.present) return [clip('catalog: none found')];
  if (catalog.stale) return [clip(`catalog stale (as of ${catalog.staleDate ?? '?'})`)];
  return [clip('catalog: current')];
}

/**
 * Sparring-partner rows (board a0714d0b, slice 2 — article sparring-partner
 * interactions h/i): two rows appended after the config.models roster —
 * `cursorBase` is the toggle row's cursor index (cursorBase+1 = the model
 * row), so cursor addressing composes with the existing sysKeys.length scheme
 * in reduce() without touching it.
 *
 * TOGGLE ROW: shows ON/OFF from sparringPartner.enabled. When codexWired is
 * false, ALWAYS appends '(not wired on this machine)' — a machine-capability
 * fact distinct from the deliberate per-project enabled/disabled choice
 * (article interaction h, P5): flipping the toggle changes ON/OFF but never
 * hides this marker, so a machine missing Codex never reads as a silently
 * successful "on".
 *
 * MODEL ROW: shows sparringPartner.model, or '(CLI default)' when unset. While
 * ui.sparringModelEdit is defined AND this row is under the cursor, the row
 * shows the live edit buffer with a caret instead of the committed value.
 *
 * The label says DEFAULT (board 7423f7a2 slice 5, decision foreign_8b329d57 as
 * corrected forward): since H20's PreToolUse arm fills this value into a codex
 * consult that names no model, the value is exactly a DEFAULT — a model named
 * on the call itself still wins, and a running codex-reply thread keeps its
 * opener's model because that tool's schema has no model field. A bare 'Model'
 * label promised more than the mechanism delivers, which is how "it just says
 * default and doesnt work" was reported.
 */
function sparringPartnerRows(snap: AgentRosterSnapshot, ui: UiState, width: number, cursorBase: number): SystemRow[] {
  const clip = (s: string): string => clipEllipsis(s, width);
  const sparringPartner = snap.sparringPartner ?? { enabled: true };
  const codexWired = snap.codexWired ?? false;
  const toggleSelected = ui.cursor === cursorBase;
  const modelSelected = ui.cursor === cursorBase + 1;
  const toggleMarker = toggleSelected ? '› ' : '  ';
  const modelMarker = modelSelected ? '› ' : '  ';
  const onOff = sparringPartner.enabled ? 'ON' : 'OFF';
  const wiredSuffix = codexWired ? '' : '  (not wired on this machine)';
  const toggleRow: SystemRow = {
    id: 'sys:sparring_enabled',
    lines: [{ text: clip(`${toggleMarker}Sparring partner: ${onOff}${wiredSuffix}`), kind: 'title', selected: toggleSelected }],
  };
  const editing = ui.sparringModelEdit !== undefined && modelSelected;
  const modelText = editing
    ? `${ui.sparringModelEdit}▌`
    : sparringPartner.model && sparringPartner.model.length
      ? sparringPartner.model
      : '(CLI default)';
  const modelRow: SystemRow = {
    id: 'sys:sparring_model',
    lines: [{ text: clip(`${modelMarker}Default Codex model: ${modelText}`), kind: 'title', selected: modelSelected }],
  };
  return [toggleRow, modelRow];
}

/** tdd toggle row (decision foreign_752caf98): ON/OFF from tdd.enabled, one row, no
 *  model sibling. Mirrors sparringPartnerRows' toggle-row shape exactly. */
function tddToggleRow(snap: AgentRosterSnapshot, ui: UiState, width: number, cursorIndex: number): SystemRow {
  const clip = (s: string): string => clipEllipsis(s, width);
  const tdd = snap.tdd ?? { enabled: true };
  const selected = ui.cursor === cursorIndex;
  const marker = selected ? '› ' : '  ';
  const onOff = tdd.enabled ? 'ON' : 'OFF';
  return { id: 'sys:tdd_enabled', lines: [{ text: clip(`${marker}TDD: ${onOff}`), kind: 'title', selected }] };
}

/** project mode row (decision project-mode-hobby-work-toggle-decides-flow): HOBBY or
 *  WORK from the raw config.mode (absent → HOBBY), UNKNOWN for an unreadable
 *  config, and INVALID for any other value — never shown as either flow.
 *  Mirrors tddToggleRow's shape. */
function modeToggleRow(snap: AgentRosterSnapshot, ui: UiState, width: number, cursorIndex: number): SystemRow {
  const clip = (s: string): string => clipEllipsis(s, width);
  const mode = snap.mode === undefined ? 'hobby' : snap.mode;
  const selected = ui.cursor === cursorIndex;
  const marker = selected ? '› ' : '  ';
  const shown = mode === null ? 'UNKNOWN (config unreadable)' : mode === 'hobby' || mode === 'work' ? mode.toUpperCase() : `INVALID ('${mode}')`;
  return { id: 'sys:project_mode', lines: [{ text: clip(`${marker}Project mode: ${shown}`), kind: 'title', selected }] };
}

/** handoff files row (decision
 *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting): ON or
 *  OFF from the effective setting (absent → OFF), UNKNOWN for an unreadable
 *  config or a git failure, and INVALID for a raw value that is not a boolean —
 *  never shown as on or off. handoffDetail follows the value in brackets, so an
 *  absent key reads OFF (not set) and an explicit false reads OFF. Mirrors
 *  modeToggleRow's shape. */
function handoffToggleRow(snap: AgentRosterSnapshot, ui: UiState, width: number, cursorIndex: number): SystemRow {
  const clip = (s: string): string => clipEllipsis(s, width);
  const handoff = snap.handoff === undefined ? false : snap.handoff;
  const selected = ui.cursor === cursorIndex;
  const marker = selected ? '› ' : '  ';
  const why = snap.handoffDetail === undefined ? '' : ` (${snap.handoffDetail})`;
  const shown = handoff === null ? `UNKNOWN (${snap.handoffDetail ?? 'config unreadable'})` : handoff === true ? `ON${why}` : handoff === false ? `OFF${why}` : `INVALID (${handoff})`;
  return { id: 'sys:handoff_files', lines: [{ text: clip(`${marker}Handoff files: ${shown}`), kind: 'title', selected }] };
}

/** storage row (board 6ca1a3c5), READ-ONLY and never selected: SERVED POSTGRES for
 *  'postgres', SQLITE for 'sqlite' or an absent key (told apart by the bracket),
 *  UNKNOWN for an unreadable config, and UNRECOGNIZED with the raw value for
 *  anything else, never shown as SQLite. Store routing's rule: absent means SQLite. */
function storageRow(snap: AgentRosterSnapshot, width: number): SystemRow {
  const clip = (s: string): string => clipEllipsis(s, width);
  const storage = snap.storage;
  const shown =
    storage === null
      ? 'UNKNOWN (config unreadable)'
      : storage === undefined
        ? 'SQLITE (not set)'
        : storage === 'sqlite'
          ? 'SQLITE'
          : storage === 'postgres'
            ? 'SERVED POSTGRES'
            : `UNRECOGNIZED (${storage})`;
  return { id: 'sys:storage', lines: [{ text: clip(`  Storage: ${shown} (read-only; switch with the move-store skill)`), kind: 'title' }] };
}

/** Bridge the pure System projection into a DashboardState the renderer draws:
 *  the catalog banner as leading dim rows, then the roster rows. Untested by the
 *  phase oracle (which calls buildSystemTab directly) — this feeds main.ts. */
/**
 * Tab labels, with the Tasks tab carrying its open-task count: "Tasks (13)".
 *
 * THE COUNT IS OPEN USER-SOURCE TODOS — the board, not the maintenance queue.
 * `source: 'user'` is load-bearing: without it this would also count the
 * system-source maintenance items that live on the Queue tab, and those two
 * surfaces answer different questions (a task is wanted work; a queue item is
 * mechanism-detected debt). It counts ITEMS, not objectives, so an objective
 * holding four slices contributes 4 — the tab answers "how much is on the
 * board", while the rows beneath it group those same items by objective.
 *
 * Via store.count(), i.e. COUNT(*) through the same baseFilter query() uses —
 * deliberately NOT todoCards().length, which counts GROUP headers rather than
 * items and would silently cap at its own listing cap.
 *
 * DISCLOSED DIVERGENCE, above todoCards' cap (500 since 2026-08-27) only: this
 * count is UNCAPPED while the listing is capped, so a board of 600 renders
 * "Tasks (600)" above 500 listed rows. Deliberate — the tab should tell the
 * truth about the board's size rather than echo a display limit — but it means
 * the number and the row count stop agreeing past the cap, and the honest fix
 * is paging the listing, never capping the count to match it. The two numbers
 * live in different files, so if the cap moves again this sentence must move
 * with it.
 *
 * THESE LABELS ARE THE ONLY SOURCE OF TRUTH FOR TAB WIDTH. The mouse hit-test
 * derives each tab's x-extent from the label actually rendered, so a count that
 * changes a label's length moves the click target with it. Anything recomputing
 * widths from the bare TABS constant would drift the moment a count appears —
 * which is why this returns labels rather than just a number.
 */
function tabsFor(store: SterlingStore, activeTab: number, agents?: AgentsTab, github?: GithubSnapshot): { label: string; active: boolean; index: number }[] {
  let taskCount: number | null = null;
  try {
    taskCount = store.count({ types: ['todo'], source: 'user' });
  } catch {
    // A count is decoration on a tab bar; failing to read one must never take
    // the whole dashboard down, so degrade to the bare label. NOT claimed: that
    // the missing count is a useful signal — a viewer cannot tell it from the
    // feature being off. It is silent, and that is acceptable ONLY because a
    // genuinely broken store cannot hide here: nodesFor/todoCards read the same
    // store in the same buildDashboardState call and would throw first.
    taskCount = null;
  }
  return visibleTabs(agents, github).map((i) => {
    const label: string = TABS[i]!;
    return {
      label: label === 'Tasks' && taskCount !== null ? `${label} (${taskCount})` : label === 'Agents' && agents ? `${label} (${agents.running})` : label,
      active: i === activeTab,
      index: i,
    };
  });
}

type TabCell = { label: string; active: boolean; index: number };

/**
 * Fit the tab bar into `width` columns (each cell is ' label '). Steps, first
 * fit wins: full labels; inactive tabs drop their '(…)' count; the active tab
 * drops its count too; inactive tabs shorten to 3 letters, then to 1; the
 * active name is clipped with an ellipsis. When even 1-letter cells for every
 * tab do not fit, the bar becomes a window: the active tab (clipped to the
 * pane) plus as many 1-letter neighbours as fit, nearest first. Works from the
 * label text, so a count of any length ('Agents (2 running · 3 quiet)') goes
 * the same way. The result may be a subset: each cell keeps its TABS `index`,
 * and the click hit-test measures these cells, so every drawn tab is
 * clickable. Under 3 columns no cell fits at all.
 */
export function fitTabs(tabs: TabCell[], width: number): TabCell[] {
  if (!Number.isFinite(width)) return tabs;
  const bare = (l: string): string => l.replace(/ \(.*\)$/, '');
  const steps: [(l: string) => string, (l: string) => string][] = [
    [(l) => l, (l) => l],
    [(l) => l, bare],
    [bare, bare],
    [bare, (l) => bare(l).slice(0, 3)],
    [bare, (l) => bare(l).slice(0, 1)],
  ];
  for (const [active, inactive] of steps) {
    const labels = tabs.map((t) => (t.active ? active(t.label) : inactive(t.label)));
    if (labels.reduce((n, l) => n + l.length + 2, 0) <= width) return tabs.map((t, i) => ({ ...t, label: labels[i]! }));
  }
  // every tab as a cell still fits when the active name keeps at least 3 columns ('Sy…')
  const room = width - 3 * tabs.filter((t) => !t.active).length - 2;
  const activeName = bare(tabs.find((t) => t.active)?.label ?? '');
  if (room >= Math.min(3, activeName.length)) return tabs.map((t) => ({ ...t, label: t.active ? clipEllipsis(bare(t.label), room) : bare(t.label).slice(0, 1) }));
  const ai = Math.max(0, tabs.findIndex((t) => t.active));
  const window: TabCell[] = [{ ...tabs[ai]!, label: clipEllipsis(bare(tabs[ai]!.label), Math.max(1, width - 2)) }];
  let used = window[0]!.label.length + 2;
  let lo = ai;
  let hi = ai;
  for (let grew = true; grew; ) {
    grew = false;
    if (hi + 1 < tabs.length && used + 3 <= width) {
      hi += 1;
      window.push({ ...tabs[hi]!, label: bare(tabs[hi]!.label).slice(0, 1) });
      used += 3;
      grew = true;
    }
    if (lo > 0 && used + 3 <= width) {
      lo -= 1;
      window.unshift({ ...tabs[lo]!, label: bare(tabs[lo]!.label).slice(0, 1) });
      used += 3;
      grew = true;
    }
  }
  return window;
}

/** The key help for the tab and mode on screen: at most 48 columns (the
 *  launcher's 35% pane), then clipped to the pane. */
function footerFor(ui: UiState, tabCount: number, width: number): string {
  const tabs = `1-${tabCount} tabs`;
  let text: string;
  if (ui.tab === TASKS_TAB) text = ui.boardEdit ? 'editing · enter save · esc cancel' : `${tabs} · ↑↓ · enter expand · e edit · q quit`;
  else if (ui.tab === KNOWLEDGE_TAB) text = 'type to search · esc clear · ^f state · ←→ tabs';
  else if (ui.tab === QUEUE_TAB) text = `${tabs} · ↑↓ pending · wheel scrolls · q quit`;
  else if (ui.tab === AGENTS_TAB) text = `←/→ or ${tabs} · q quit`;
  else if (ui.tab === GITHUB_TAB) text = `${tabs} · ↑↓ scroll · r refresh · q quit`;
  else text = `${tabs} · enter change · esc cancel · q quit`;
  return clipEllipsis(text, width);
}

/** The one notice row: the transient ui.notice as a '⚠ ' warning, clipped. */
const noticeFor = (ui: UiState, width: number): string | undefined => (ui.notice ? clipEllipsis(`⚠ ${ui.notice}`, width) : undefined);

// ---------------------------------------------------------------------------
// GitHub status (board 87bca3f8): the strip row and the GitHub tab, derived
// from the host poller's snapshot (github-status.ts). Nothing here runs gh.
// ---------------------------------------------------------------------------

/** HH:MM of a poll, for "as of" labels. */
const clockOf = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

const CHECKS_WORD: Readonly<Record<GithubPr['checks'], string>> = { pass: 'checks ✓', fail: 'checks ✗', pending: 'checks …', none: '' };
const MERGE_WORD: Readonly<Record<string, string>> = { CLEAN: 'mergeable', HAS_HOOKS: 'mergeable', UNSTABLE: 'unstable', BLOCKED: 'blocked', BEHIND: 'behind', DIRTY: 'conflicts' };

/** One PR as short strip parts: number, draft, checks, merge, Copilot, threads. */
function prParts(pr: GithubPr): string[] {
  return [
    `#${pr.number}`,
    pr.draft ? 'draft' : '',
    CHECKS_WORD[pr.checks],
    pr.draft ? '' : MERGE_WORD[pr.merge] ?? '',
    pr.copilot === 'none' ? '' : `copilot ${pr.copilot}`,
    pr.unresolved > 0 ? `${pr.unresolved} unresolved` : '',
  ].filter(Boolean);
}

/**
 * The strip row, or undefined when there is nothing to show: no host poller,
 * still loading, hidden (no gh, no origin, not on github.com), or a project
 * with no open PR and no owed review loop (a hobby project). A failed poll
 * shows its one dim reason ('gh not logged in'); within STALE_MS of the last
 * good poll it shows that poll's data instead, dim, marked "as of HH:MM". The
 * PR named first is the loop's PR when it is open, else the most recently
 * updated one.
 */
export function githubStrip(github: GithubSnapshot | undefined, width = Infinity): { text: string; dim: boolean } | undefined {
  if (!github || github.state === 'loading' || github.state === 'hidden') return undefined;
  const clip = (text: string): string => clipEllipsis(text, width);
  if (github.loopError) return { text: clip(`⚠ pr-loop.json unreadable: ${github.loopError}`), dim: false };
  const data = github.data;
  if (github.state === 'failed' && !data) return { text: clip(github.reason ?? 'gh failed'), dim: true };
  const open = data?.open ?? [];
  const loop = github.loop;
  const owed = loop?.status === 'owed' ? loop : undefined;
  if (open.length === 0 && !owed) return undefined;
  const parts: string[] = [];
  if (github.state === 'failed' && github.asOf !== undefined) parts.push(`as of ${clockOf(github.asOf)}`);
  const lead = open.find((p) => p.number === loop?.pr) ?? open[0];
  if (lead) {
    parts.push(prParts(lead).join(' '));
    if (loop && loop.pr === lead.number) parts.push(`loop ${loop.status}`);
  }
  if (owed && owed.pr !== lead?.number) parts.push(`loop owed #${owed.pr}${open.some((p) => p.number === owed.pr) ? '' : ' (not open)'}`);
  if (open.length > 1) parts.push(`+${open.length - 1} open`);
  return { text: clip(`PR ${parts.join(' · ')}`), dim: github.state === 'failed' };
}

/** Rows the strip takes above the footer: 1 while it shows, else 0. The host
 *  passes this to visibleBodyLines so its hit-test matches the drawn body. */
export function githubStripRows(github: GithubSnapshot | undefined): number {
  return githubStrip(github) ? 1 : 0;
}

/** The GitHub tab's body lines: status, open PRs with their detail, the PR
 *  review loop, and the last merged PRs. Display only: nothing is selectable. */
export function githubTabLines(github: GithubSnapshot, width = Infinity): RowLine[] {
  const clip = (text: string): string => clipEllipsis(text, width);
  const lines: RowLine[] = [];
  const meta = (text: string): void => {
    lines.push({ text: clip(text), kind: 'meta' });
  };
  if (github.state === 'loading') {
    meta('checking GitHub…');
    return lines;
  }
  if (github.state === 'hidden') {
    meta(`GitHub status off: ${github.reason ?? 'unavailable'}`);
    return lines;
  }
  const data = github.data;
  meta(`${github.repo ?? ''}${github.asOf !== undefined ? ` · as of ${clockOf(github.asOf)}` : ''}`);
  if (github.state === 'failed') meta(`${github.reason ?? 'gh failed'}${data ? ' (showing the last good poll)' : ''}`);
  if (github.loopError) lines.push({ text: clip(`⚠ pr-loop.json unreadable: ${github.loopError}`), kind: 'body' });
  if (data) {
    lines.push({ text: '', kind: 'body' });
    lines.push({ text: clip(data.open.length ? `open pull requests (${data.open.length})` : 'no open pull requests'), kind: 'title' });
    const wrapWidth = Number.isFinite(width) ? Math.max(1, width - 4) : width;
    for (const pr of data.open) {
      lines.push({ text: clip(`  #${pr.number} ${pr.title}`), kind: 'body' });
      const detail = [
        pr.branch,
        pr.draft ? 'draft' : '',
        pr.checks === 'none' ? 'no checks' : `checks ${pr.checks}`,
        pr.merge ? `merge ${pr.merge.toLowerCase()}` : '',
        pr.review ? `review ${pr.review.toLowerCase().replace(/_/g, ' ')}` : '',
        `copilot ${pr.copilot}`,
        `${pr.unresolved} unresolved`,
      ].filter(Boolean).join(' · ');
      for (const text of wrapText(detail, wrapWidth)) lines.push({ text: `    ${text}`, kind: 'meta' });
    }
  }
  lines.push({ text: '', kind: 'body' });
  const loop = github.loop;
  lines.push({ text: clip(loop ? `PR review loop: ${loop.status} for #${loop.pr}` : 'PR review loop: none armed'), kind: 'title' });
  if (data) {
    lines.push({ text: '', kind: 'body' });
    lines.push({ text: clip(data.merged.length ? 'recently merged' : 'nothing merged yet'), kind: 'title' });
    for (const pr of data.merged) lines.push({ text: clip(`  #${pr.number} ${pr.title} · ${pr.mergedAt.slice(0, 10)}`), kind: 'body' });
  }
  return lines;
}

/** The GitHub tab's state: one display-only row of githubTabLines, scrolled
 *  by ui.scroll with the same clamp as the other tabs. */
function githubDashboardState(ui: UiState, width: number, banner: string[], projectName: string, bodyTop: number, tabs: TabCell[], maxBodyLines: number, github: GithubSnapshot, agents?: AgentsTab): DashboardState {
  const lines = githubTabLines(github, width);
  const maxScroll = Number.isFinite(maxBodyLines) ? Math.max(0, lines.length - maxBodyLines) : 0;
  return {
    tabs,
    rows: [{ id: 'github', type: 'github', selected: false, expanded: false, lines, screenRow: 0 }],
    footer: footerFor(ui, visibleTabs(agents, github).length, width),
    notice: noticeFor(ui, width),
    strip: githubStrip(github, width),
    banner,
    projectName,
    bodyTop,
    scroll: Math.max(0, Math.min(ui.scroll ?? 0, maxScroll)),
  };
}

function systemDashboardState(
  ui: UiState,
  width: number,
  banner: string[],
  projectName: string,
  bodyTop: number,
  tabs: { label: string; active: boolean; index: number }[],
  maxBodyLines: number,
  roster?: AgentRosterSnapshot,
  agents?: AgentsTab,
  github?: GithubSnapshot
): DashboardState {
  const view = buildSystemTab(roster ?? EMPTY_ROSTER, ui, width);
  const rows: Row[] = [];
  let screenRow = 0;
  // the ⚠ notice (findings 24/43, 41/43) leads view.banner from buildSystemTab;
  // it is drawn on the notice row instead (state.notice), so only the catalog
  // status rows go into the body here.
  for (const text of view.banner.slice(ui.notice ? 1 : 0)) {
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
  // sparring-partner rows (board a0714d0b): drawn after the config.models
  // roster, same row shape — a SEPARATE list from view.rows (phase-4 frozen
  // contract), never merged into it.
  for (const sr of view.sparringRows) {
    const lines: RowLine[] = sr.lines.map((l) => ({
      text: l.text,
      kind: (l.kind === 'title' ? 'title' : l.kind === 'meta' ? 'meta' : 'body') as RowLine['kind'],
    }));
    rows.push({ id: sr.id, type: 'system', selected: sr.lines.some((l) => l.selected === true), expanded: false, lines, screenRow });
    screenRow += lines.length;
  }
  // tdd toggle row (decision foreign_752caf98): drawn after the sparring-partner
  // rows, same row shape — a separate list, never merged.
  // project mode row (decision project-mode-hobby-work-toggle-decides-flow): drawn
  // after the tdd row, same row shape. The handoff files row follows it.
  for (const sr of [...view.tddRows, ...view.modeRows, ...view.handoffRows, ...view.storageRows]) {
    const lines: RowLine[] = sr.lines.map((l) => ({
      text: l.text,
      kind: (l.kind === 'title' ? 'title' : l.kind === 'meta' ? 'meta' : 'body') as RowLine['kind'],
    }));
    rows.push({ id: sr.id, type: 'system', selected: sr.lines.some((l) => l.selected === true), expanded: false, lines, screenRow });
    screenRow += lines.length;
  }
  // body scroll: the System tab honors ui.scroll the way the card tabs do
  // (clamp discipline mirrored from buildDashboardState below) — an unbounded
  // viewport (maxBodyLines = Infinity, e.g. tests) yields maxScroll 0 → scroll
  // 0, so every existing test stays green.
  const totalBodyLines = rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
  const maxScroll = Number.isFinite(maxBodyLines) ? Math.max(0, totalBodyLines - maxBodyLines) : 0;
  const scroll = Math.max(0, Math.min(ui.scroll ?? 0, maxScroll));
  return {
    tabs,
    rows,
    emptyMessage: view.rows.length ? undefined : '(no configured models)',
    footer: footerFor(ui, visibleTabs(agents, github).length, width),
    notice: noticeFor(ui, width),
    strip: githubStrip(github, width),
    banner,
    projectName,
    bodyTop,
    scroll,
  };
}

/** A drawn frame: the state the renderer painted, the nodes it was built from
 *  and the cursor it drew, plus the UiState it was built from. The reducer
 *  hit-tests a click against the frame, so the click selects the record that
 *  was on screen even when the store changed after the draw. */
export interface DashboardFrame {
  ui: UiState;
  state: DashboardState;
  nodes: Node[];
  cursor: number;
}

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false, knowledge?: MountedStores, roster?: AgentRosterSnapshot, agents?: AgentsTab, height = Infinity, github?: GithubSnapshot): DashboardState {
  return buildDashboardFrame(store, ui, width, maxBodyLines, projectName, showBanner, knowledge, roster, agents, height, github).state;
}

export function buildDashboardFrame(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false, knowledge?: MountedStores, roster?: AgentRosterSnapshot, agents?: AgentsTab, height = Infinity, github?: GithubSnapshot): DashboardFrame {
  // the pane height picks the compact scene under COMPACT_BELOW_HEIGHT rows;
  // the host passes the same height to visibleBodyLines, so draw and clicks agree
  const banner = bannerLines(width, showBanner, height);
  const bodyTop = banner.length + CHROME_BELOW_BANNER;
  // Computed ONCE here and threaded into every projection, so the Tasks count
  // and the widths the hit-test measures can never come from two places.
  const tabs = fitTabs(tabsFor(store, ui.tab, agents, github), width);
  // System tab (run r-f9a7): its own projection, not a card/knowledge list.
  if (ui.tab === SYSTEM_TAB) return { ui, state: systemDashboardState(ui, width, banner, projectName, bodyTop, tabs, maxBodyLines, roster, agents, github), nodes: [], cursor: ui.cursor };
  // GitHub tab: the poller snapshot's display lines; the store is not read for its body.
  if (ui.tab === GITHUB_TAB && github) return { ui, state: githubDashboardState(ui, width, banner, projectName, bodyTop, tabs, maxBodyLines, github, agents), nodes: [], cursor: ui.cursor };
  const nodes = nodesFor(store, ui, knowledge);
  const cursor = resolveCursor(ui, nodes);
  const rows: Row[] = [];
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
      if (ui.boardEdit && ui.boardEdit.id === card.id) {
        // Tasks tab board-item edit in progress (user-ruled 2026-09-28, board
        // f25e5547 lane J): the live buffer + caret, wrapped like the legacy
        // card expansion below — takes priority over both expansion styles so
        // an editor open on an already-expanded card still shows the buffer,
        // not the stale stored body.
        const prefix = 2 + pad.length;
        const wrapWidth = Number.isFinite(width) ? Math.max(1, width - prefix) : width;
        lines = wrapText(`${ui.boardEdit.text}▌`, wrapWidth).map((text, j) => ({
          text: (j === 0 ? marker + pad : ' '.repeat(prefix)) + text,
          kind: j === 0 ? ('title' as const) : ('body' as const),
        }));
      } else if (expanded && knowledge) {
        // readable layout (AC4): title line, blank separator, wrapped body
        // lines, dim meta — the title is NEVER replaced by the body.
        const indent = ' '.repeat(2 + pad.length);
        const wrapWidth = Number.isFinite(width) ? Math.max(1, width - indent.length) : width;
        lines = [{ text: clipEllipsis(marker + pad + stateColumn(card) + card.title, width), kind: 'title' }, { text: '', kind: 'body' }];
        for (const text of wrapText(card.body, wrapWidth)) lines.push({ text: indent + text, kind: 'body' });
        lines.push({ text: clipEllipsis(`${indent}${card.detail}`, width), kind: 'meta' });
      } else if (expanded) {
        // legacy card expansion (todos/queue): first wrapped body line
        // carries the 'title' kind, then body lines, then meta.
        const prefix = 2 + pad.length;
        const wrapWidth = Number.isFinite(width) ? Math.max(1, width - prefix) : width;
        lines = wrapText(card.body, wrapWidth).map((text, j) => ({
          text: (j === 0 ? marker + pad : ' '.repeat(prefix)) + text,
          kind: j === 0 ? ('title' as const) : ('body' as const),
        }));
        if (card.detail) lines.push({ text: `    ${pad}${card.detail}`, kind: 'meta' });
        if (card.blocked) lines.push({ text: `    ${pad}${card.blocked}`, kind: 'meta' });
        if (card.unblocks) lines.push({ text: `    ${pad}${card.unblocks}`, kind: 'meta' });
      } else {
        lines = [{ text: clipEllipsis(marker + pad + stateColumn(card) + card.title, width), kind: 'title' }];
      }
    }
    rows.push({ id, type, selected, expanded, lines, screenRow });
    screenRow += lines.length;
  }
  const totalBodyLines = rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
  // queue tab: fixed half-split. The pending list owns the upper half as a
  // window of `pendingLines` lines scrolled by ui.scroll (the renderer and
  // screenLineToRow both stop at it, so a row below the window is neither
  // drawn nor clickable); the history list (completed, then activity) owns the
  // lower half under a fixed header and scrolls by ui.historyScroll
  // (§3.2.7/§11). An unbounded viewport shows everything and never scrolls.
  let queueCompleted: DashboardState['queueCompleted'];
  let queueActivity: DashboardState['queueActivity'];
  let scroll: number;
  if (ui.tab === QUEUE_TAB) {
    const finite = Number.isFinite(maxBodyLines);
    const startRow = finite ? Math.max(1, Math.floor(maxBodyLines / 2)) : totalBodyLines;
    // the row above the divider carries the overflow note when pending does not fit
    const pendingLines = totalBodyLines > startRow ? startRow - 1 : startRow;
    scroll = Math.max(0, Math.min(ui.scroll ?? 0, totalBodyLines - pendingLines));
    const hidden = rows.filter((r) => r.screenRow < scroll || r.screenRow + r.lines.length > scroll + pendingLines).length;
    const completed = completedQueueLines(store);
    const activity = activityLines(store);
    queueActivity = {
      header: '— activity —',
      lines: activity.length ? activity : ['(no activity yet)'],
    };
    const lines = completed.length ? completed : ['(nothing completed yet)'];
    const historyTotal = lines.length + 1 + queueActivity.lines.length;
    const historyLines = finite ? Math.max(0, maxBodyLines - startRow - 1) : historyTotal;
    queueCompleted = {
      startRow,
      pendingLines,
      scroll: Math.max(0, Math.min(ui.historyScroll ?? 0, historyTotal - historyLines)),
      header: '— completed —',
      lines,
      ...(hidden > 0 ? { overflow: `… ${hidden} more pending` } : {}),
    };
  } else {
    // body scroll: clamp the persisted offset to the content height so the
    // render window and the click hit-test agree; an unbounded viewport
    // (maxBodyLines = Infinity, e.g. tests) yields maxScroll 0 → scroll 0
    const maxScroll = Number.isFinite(maxBodyLines) ? Math.max(0, totalBodyLines - maxBodyLines) : 0;
    scroll = Math.max(0, Math.min(ui.scroll ?? 0, maxScroll));
  }
  // the Knowledge search field is ALWAYS visible (no '/' toggle) — its line
  // shows on the spacer row on the Knowledge tab regardless of the query.
  const searchActive = ui.tab === KNOWLEDGE_TAB;
  const state: DashboardState = {
    tabs,
    rows,
    emptyMessage:
      ui.tab === AGENTS_TAB
        ? undefined
        : nodes.length === 0
        ? ui.tab === KNOWLEDGE_TAB && ui.searchQuery
          ? '(no matches)'
          : ui.tab === QUEUE_TAB
            ? '(queue empty)'
            : '(empty)'
        : undefined,
    footer: footerFor(ui, visibleTabs(agents, github).length, width),
    // a board_edit refusal, a failed selection write or a degraded store read
    // (ui.notice) is drawn on its own row in the warning colour
    notice: noticeFor(ui, width),
    strip: githubStrip(github, width),
    searchLine: searchActive ? `search: ${ui.searchQuery}${ui.stateFilter ? `  state: ${ui.stateFilter}` : ''}` : undefined,
    queueCompleted,
    queueActivity,
    banner,
    projectName,
    bodyTop,
    scroll,
  };
  return { ui, state, nodes, cursor };
}

/** Body lines the row list may use: the viewport, or on the Queue tab the
 *  pending list's window above the divider (render.ts stops at the same line). */
function bodyWindow(state: DashboardState, maxBodyLines: number): number {
  const qc = state.queueCompleted;
  return qc ? Math.min(maxBodyLines, qc.pendingLines ?? qc.startRow) : maxBodyLines;
}

/** Map an absolute screen line (1-based, terminal convention) to a row index, or -1.
 *  maxBodyLines bounds the hit-test to the rendered viewport (visibleBodyLines). */
export function screenLineToRow(state: DashboardState, line1: number, maxBodyLines = Infinity): number {
  const scroll = state.scroll ?? 0;
  maxBodyLines = bodyWindow(state, maxBodyLines);
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

export function reduce(
  store: SterlingStore,
  ui: UiState,
  event: UiEvent,
  viewport: Viewport = {},
  knowledge?: MountedStores,
  roster?: AgentRosterSnapshot,
  // Tasks tab board-item edit, fix 1: injectable so tests can control HEAD
  // resolution without shelling out to real git or depending on this
  // worktree's own repo state. Defaults to the real `git rev-parse HEAD`
  // resolver, so every existing/main.ts call site needs no change.
  resolveHeadSha: () => string | undefined = defaultResolveHeadSha,
  // The last drawn frame, when the host has one built from this same `ui` and
  // viewport: a click hit-tests what is on screen and nothing is re-read from
  // the store. Without one (or with a frame built from another ui) the reducer
  // reads the nodes itself.
  frame?: DashboardFrame
): { ui: UiState; effects: Effect[] } {
  const drawn = frame !== undefined && frame.ui === ui ? frame : undefined;
  const nodes = drawn ? drawn.nodes : nodesFor(store, ui, knowledge);
  const cursor = drawn ? drawn.cursor : ui.tab === SYSTEM_TAB ? ui.cursor : resolveCursor(ui, nodes);
  const base = cursor === ui.cursor ? ui : { ...ui, cursor };
  const out = reduceNodes(store, base, event, viewport, knowledge, roster, resolveHeadSha, nodes, drawn);
  // a no-op event hands back the caller's own UiState, so its frame stays current
  if (out.ui === base) return { ui, effects: out.effects };
  return { ui: holdSelection(base, out.ui, nodes), effects: out.effects };
}

/** Keep the selection by id: after an event on a card tab, ui.selectedId names
 *  the node under the new cursor. A tab switch or a new search or filter starts
 *  a fresh list, where the cursor index rules. Returns `next` itself when
 *  nothing changes, so a no-op event leaves the UiState identical. */
function holdSelection(prev: UiState, next: UiState, nodes: Node[]): UiState {
  const fresh = next.tab !== prev.tab || next.searchQuery !== prev.searchQuery || next.stateFilter !== prev.stateFilter;
  const cardTab = next.tab !== SYSTEM_TAB && next.tab !== AGENTS_TAB && next.tab !== GITHUB_TAB;
  const node = !fresh && cardTab && nodes.length ? nodes[Math.min(next.cursor, nodes.length - 1)] : undefined;
  const selectedId = node ? nodeId(node) : undefined;
  if (selectedId === next.selectedId) return next;
  if (selectedId !== undefined) return { ...next, selectedId };
  const { selectedId: _dropped, ...rest } = next;
  return rest;
}

function reduceNodes(
  store: SterlingStore,
  ui: UiState,
  event: UiEvent,
  viewport: Viewport,
  knowledge: MountedStores | undefined,
  roster: AgentRosterSnapshot | undefined,
  resolveHeadSha: () => string | undefined,
  nodes: Node[],
  drawn: DashboardFrame | undefined
): { ui: UiState; effects: Effect[] } {
  const maxBodyLines = viewport.maxBodyLines ?? Infinity;
  const clamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, nodes.length - 1)));
  const effects: Effect[] = [];

  // a tab switch resets the cursor + scroll AND dismisses any open selector
  // (and any in-progress sparring-partner model edit, same discard-on-switch rule)
  const switchTab = (index: number): UiState => ({ ...ui, tab: index, cursor: 0, scroll: 0, historyScroll: undefined, selector: undefined, notice: undefined, sparringModelEdit: undefined, boardEdit: undefined });

  // the tabs this host can reach, in bar order: a digit picks the n-th, left/right step through them
  const reachable = visibleTabs(viewport.agents, viewport.github);
  const stepTab = (dir: number): number => reachable[(reachable.indexOf(ui.tab) + dir + reachable.length) % reachable.length] ?? reachable[0]!;

  const buildSelf = (uiNext: UiState): DashboardState =>
    buildDashboardState(store, uiNext, viewport.width ?? Infinity, maxBodyLines, '', viewport.showBanner ?? false, knowledge, roster, viewport.agents, viewport.height, viewport.github);

  // move the selection by `delta` and keep it inside the scroll window so the
  // viewport follows the cursor. An unbounded viewport or a non-scrolling tab
  // just moves the cursor (scroll stays 0) — the prior behaviour.
  /** Move the cursor to `cursor` and scroll the selected row into view — shared
   *  by the generic tabs and the System tab's sparring rows (which sit past the
   *  config.models keys and would otherwise leave the edit caret below the fold). */
  const revealAt = (cursor: number): UiState => {
    if (!Number.isFinite(maxBodyLines)) return { ...ui, cursor };
    // row heights do not depend on the cursor, so on the card tabs the drawn
    // frame's geometry serves (the System tab's picker rows follow the cursor)
    const st = drawn && ui.tab !== SYSTEM_TAB ? drawn.state : buildSelf({ ...ui, cursor });
    const total = st.rows.length ? st.rows[st.rows.length - 1].screenRow + st.rows[st.rows.length - 1].lines.length : 0;
    // the Queue tab's pending list scrolls inside its own window
    const window = bodyWindow(st, maxBodyLines);
    const max = Math.max(0, total - window);
    let scroll = ui.scroll ?? 0;
    // ui.cursor addresses only the SELECTABLE rows (config.models roster +
    // sparring/tdd toggles) — systemDashboardState prepends the
    // notice/catalog banner rows (view.banner) ahead of them in st.rows, so on
    // the System tab the cursor's row sits `bannerOffset` positions later than
    // its own index. Non-system tabs carry no such leading rows (offset 0).
    const bannerOffset = ui.tab === SYSTEM_TAB ? st.rows.filter((r) => r.type === 'system-banner').length : 0;
    const row = st.rows[cursor + bannerOffset];
    if (row) {
      const top = row.screenRow;
      const bottom = row.screenRow + row.lines.length;
      if (top < scroll) scroll = top; // selection above the window → scroll up to its top
      else if (bottom > scroll + window) scroll = Math.min(top, bottom - window); // below → reveal it
    }
    return { ...ui, cursor, scroll: Math.max(0, Math.min(scroll, max)) };
  };
  const moveCursor = (delta: number): UiState => revealAt(clamp(ui.cursor + delta));

  const toggle = (id: string): string[] =>
    ui.expanded.includes(id) ? ui.expanded.filter((x) => x !== id) : [...ui.expanded, id];

  const activate = (index: number): UiState => {
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
    if (card.type === 'objective') {
      // objective group header (decision foreign_a8d2ce6c): fold/unfold — navigation,
      // not a selection; nothing durable to select behind the derived label.
      return { ...ui, cursor: index, expanded: toggle(card.id) };
    }
    effects.push({ type: 'select', recordType: card.type, id: card.id });
    return { ...ui, cursor: index, expanded: toggle(card.id) };
  };

  switch (event.kind) {
    case 'key':
      // Tasks tab board-item edit (user-ruled 2026-09-28, board f25e5547 lane
      // J): while ui.boardEdit is open, ENTER commits, BACKSPACE deletes, and
      // ESCAPE cancels — every other named key is swallowed (no cursor
      // movement, no quit) so the editor owns input the same way the System
      // tab's sparringModelEdit does. Checked first, ahead of the System-tab
      // selector block below, since the two never overlap (boardEdit is only
      // ever opened on TASKS_TAB).
      if (ui.tab === TASKS_TAB && ui.boardEdit) {
        const be = ui.boardEdit;
        switch (event.name) {
          case 'ESCAPE':
            return { ui: { ...ui, boardEdit: undefined, notice: undefined }, effects };
          case 'BACKSPACE':
            return { ui: { ...ui, boardEdit: { ...be, text: be.text.slice(0, -1) } }, effects };
          case 'ENTER': {
            const trimmed = be.text.trim();
            // an edit trimmed to empty writes nothing (todoSchema requires
            // non-empty text) — close the editor rather than let a doomed
            // write reach the store and throw (P5: refuse loud, not late).
            if (!trimmed) return { ui: { ...ui, boardEdit: undefined, notice: undefined }, effects };
            // Fix round (Opus review of 71c1f41), fixes 2+3 — re-read the LIVE
            // record at commit time, never trust the snapshot 'e' opened with:
            //   • vanished, or no longer a live todo (status 'superseded') →
            //     nothing to write to; a notice, never an uncaught throw to
            //     main.ts's fatal handler (P5: degrade loud, don't crash).
            //   • still live but its version moved since 'e' was pressed → a
            //     concurrent write happened elsewhere; refuse with a visible
            //     notice and KEEP the buffer open — never a silent overwrite
            //     (lost-update guard).
            const current = store.get(be.id) as (Record<string, unknown> & { type?: string; status?: string; version?: number }) | undefined;
            if (!current || current.type !== 'todo' || current.status === 'superseded' || typeof current.version !== 'number') {
              return {
                ui: { ...ui, boardEdit: undefined, notice: `board item no longer exists — the edit was discarded` },
                effects,
              };
            }
            if (current.version !== be.version) {
              // MEDIUM-1 (second Opus re-check round): ADOPT the current
              // version into the kept buffer. Leaving be.version at the
              // stale value it was opened with made "press ENTER to try
              // again" a lie — every later ENTER would re-read the same
              // still-live-but-now-current version, find it STILL disagrees
              // with the never-updated be.version, and refuse forever with
              // no way out but ESCAPE. Adopting it here means the very next
              // ENTER's version check passes and the buffer commits — a
              // deliberate, explicit overwrite the user asked for by
              // pressing ENTER again, never a silent one.
              return {
                ui: {
                  ...ui,
                  boardEdit: { ...be, version: current.version },
                  notice: `board item changed since it was opened — press ENTER again to overwrite it, ESC to cancel`,
                },
                effects,
              };
            }
            // Fix 1 — restamp measured_at_head on this text change, mirroring
            // board_update (decision board-provenance-measured-at-head): a
            // resolve failure degrades loud (a notice) rather than silently
            // keeping the stale stamp — but it does NOT block the save, the
            // same way board_update itself proceeds when git is unavailable.
            let head: string | undefined;
            try {
              head = resolveHeadSha();
            } catch {
              head = undefined;
            }
            effects.push({
              type: 'board_edit',
              id: be.id,
              text: trimmed,
              version: be.version,
              ...(head ? { measuredAtHead: head } : {}),
            });
            return {
              ui: {
                ...ui,
                boardEdit: undefined,
                notice: head ? undefined : `could not read the current git HEAD — measured_at_head was not refreshed (the text edit was still saved)`,
              },
              effects,
            };
          }
        }
        return { ui, effects };
      }
      // System tab (run r-f9a7): the inline model/effort selector state machine.
      // Handles roster navigation + open/navigate/confirm/commit/cancel; the
      // tab-switch / quit keys fall through to the generic handler below.
      if (ui.tab === SYSTEM_TAB && roster) {
        // LOW-3 (second Opus re-check round): filtered the SAME way buildSystemTab
        // filters `keys` — a relic key never occupies a cursor slot here either,
        // so the two stay in lockstep (a stray key in roster.configModels would
        // otherwise misalign every row/toggle index below it).
        const sysKeys = Object.keys(roster.configModels).filter((k) => SYSTEM_TAB_MODEL_KEYS.has(k));
        // + 3: the sparring-partner toggle row (index sysKeys.length) and its
        // model row (sysKeys.length + 1), appended after the config.models
        // roster (board a0714d0b) — then the tdd toggle row (sysKeys.length + 2),
        // decision foreign_752caf98 — cursor addressing composes over all three.
        // The sibling mutation_verification toggle row that used to sit at
        // sysKeys.length + 3 was REMOVED entirely (decision
        // cleanup-run-deletes-dead-scripts-and-removes-mutation-verification-key,
        // 2026-09-22).
        // + 4 since the project mode row (sysKeys.length + 3, decision
        // project-mode-hobby-work-toggle-decides-flow) joined after the tdd row.
        // + 5 since the handoff files row (sysKeys.length + 4, decision
        // project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting)
        // joined after the project mode row.
        const sysClamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, sysKeys.length + 5 - 1)));
        const sel = ui.selector;
        const editing = ui.sparringModelEdit !== undefined;
        switch (event.name) {
          case 'UP':
            if (sel) return { ui: { ...ui, selector: { ...sel, highlight: Math.max(0, sel.highlight - 1) } }, effects };
            if (editing) return { ui, effects }; // arrow keys are no-ops while typing the model field
            return { ui: revealAt(sysClamp(ui.cursor - 1)), effects };
          case 'DOWN': {
            if (sel) {
              const n = sel.stage === 'model' ? roster.catalog.entries.length : effortOptions(sel.key).length;
              return { ui: { ...ui, selector: { ...sel, highlight: Math.min(Math.max(0, n - 1), sel.highlight + 1) } }, effects };
            }
            if (editing) return { ui, effects };
            return { ui: revealAt(sysClamp(ui.cursor + 1)), effects };
          }
          case 'ESCAPE':
            if (sel) return { ui: { ...ui, selector: undefined }, effects };
            if (editing) return { ui: { ...ui, sparringModelEdit: undefined }, effects };
            return { ui, effects };
          case 'BACKSPACE':
            if (editing) return { ui: { ...ui, sparringModelEdit: (ui.sparringModelEdit ?? '').slice(0, -1) }, effects };
            return { ui, effects };
          case 'ENTER':
          case 'SPACE': {
            const cursor = sysClamp(ui.cursor);
            if (editing) {
              // commit the free-text model edit — empty clears back to unset
              // (CLI default). No ^claude- floor here: the model is a FREE
              // string, codex validates server-side with a loud 400.
              const committedModel = (ui.sparringModelEdit ?? '').trim();
              effects.push({ type: 'sparring_model', model: committedModel });
              // WHAT THE VALUE ACTUALLY GOVERNS, said at the moment it is set
              // (board 7423f7a2 slice 5): H20 injects it only into a consult
              // that names NO model, so an explicit call-site model overrides
              // it, and codex-reply carries no model field at all — an
              // already-open thread keeps its opener's model however this row
              // is changed. Stating both limits here is the repair for "it
              // just says default and doesnt work".
              const sparringNotice = committedModel
                ? `Default Codex model set to '${committedModel}' — a model named on the call itself overrides it, and existing Codex threads keep their opener's model until a new consult starts.`
                : `Default Codex model cleared — consults now take the Codex CLI default. A model named on the call itself still overrides it, and existing Codex threads keep their opener's model.`;
              return { ui: { ...ui, sparringModelEdit: undefined, notice: sparringNotice }, effects };
            }
            if (cursor === sysKeys.length) {
              // sparring-partner toggle row: an immediate flip, no picker
              effects.push({ type: 'sparring_toggle', enabled: !(roster.sparringPartner?.enabled ?? true) });
              return { ui: { ...ui, cursor, notice: undefined }, effects };
            }
            if (cursor === sysKeys.length + 1) {
              // sparring-partner model row: open the free-text edit
              return { ui: { ...ui, cursor, sparringModelEdit: roster.sparringPartner?.model ?? '', notice: undefined }, effects };
            }
            if (cursor === sysKeys.length + 2) {
              // tdd toggle row (decision foreign_752caf98): an immediate flip, no picker
              effects.push({ type: 'tdd_toggle', enabled: !(roster.tdd?.enabled ?? true) });
              return { ui: { ...ui, cursor, notice: undefined }, effects };
            }
            if (cursor === sysKeys.length + 3) {
              // project mode row: an immediate flip. An invalid value flips to
              // hobby, the default flow — a visible, deliberate write, never a guess.
              effects.push({ type: 'mode_toggle', mode: (roster.mode ?? 'hobby') === 'hobby' ? 'work' : 'hobby' });
              return { ui: { ...ui, cursor, notice: undefined }, effects };
            }
            if (cursor === sysKeys.length + 4) {
              // handoff files row: an immediate flip. An invalid value flips to
              // off, the default — a visible, deliberate write, never a guess.
              effects.push({ type: 'handoff_toggle', enabled: (roster.handoff ?? false) === false });
              return { ui: { ...ui, cursor, notice: undefined }, effects };
            }
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
        case 'STATE_FILTER': {
          if (ui.tab !== KNOWLEDGE_TAB) return { ui, effects };
          const at = ARTICLE_STATE_FILTERS.indexOf((ui.stateFilter ?? 'all') as (typeof ARTICLE_STATE_FILTERS)[number]);
          const next = ARTICLE_STATE_FILTERS[(at + 1) % ARTICLE_STATE_FILTERS.length]!;
          return { ui: { ...ui, stateFilter: next === 'all' ? undefined : next, cursor: 0, scroll: 0 }, effects };
        }
        case 'BACKSPACE':
          if (ui.tab === KNOWLEDGE_TAB) {
            return { ui: { ...ui, searchQuery: ui.searchQuery.slice(0, -1), cursor: 0, scroll: 0 }, effects };
          }
          return { ui, effects };
        case 'LEFT':
          return { ui: switchTab(stepTab(-1)), effects };
        case 'RIGHT':
        case 'TAB':
          return { ui: switchTab(stepTab(1)), effects };
        case 'UP':
        case 'DOWN': {
          // the GitHub tab has nothing to select: the arrows scroll its lines
          if (ui.tab === GITHUB_TAB && viewport.github) {
            const st = drawn ? drawn.state : buildSelf(ui);
            const total = st.rows[0]?.lines.length ?? 0;
            const max = Number.isFinite(maxBodyLines) ? Math.max(0, total - maxBodyLines) : 0;
            const scroll = Math.max(0, Math.min((ui.scroll ?? 0) + (event.name === 'UP' ? -1 : 1), max));
            return { ui: scroll === (ui.scroll ?? 0) ? ui : { ...ui, scroll }, effects };
          }
          return { ui: moveCursor(event.name === 'UP' ? -1 : 1), effects };
        }
        case 'ENTER':
          return { ui: activate(clamp(ui.cursor)), effects };
        case 'SPACE':
          return { ui: activate(clamp(ui.cursor)), effects };
      }
      break;
    case 'char': {
      const ch = event.ch;
      if (ch.length !== 1) return { ui, effects };
      // System tab, sparring-partner model row: while the free-text edit is
      // open EVERY printable key (space, digits, 'q' included) feeds the
      // buffer — mirrors the Knowledge tab's always-visible search field.
      // Checked FIRST so the space→ENTER routing below never fires mid-edit.
      if (ui.tab === SYSTEM_TAB && ui.sparringModelEdit !== undefined) {
        return { ui: { ...ui, sparringModelEdit: ui.sparringModelEdit + ch }, effects };
      }
      // Tasks tab board-item edit: same always-capture idiom as the two edit
      // buffers above — every printable key ('e' included) feeds the buffer
      // while it is open, so typing the letter 'e' into an edit never
      // re-triggers the open-editor hotkey below.
      if (ui.tab === TASKS_TAB && ui.boardEdit) {
        return { ui: { ...ui, boardEdit: { ...ui.boardEdit, text: ui.boardEdit.text + ch } }, effects };
      }
      // the Knowledge tab is an always-visible search field: EVERY printable key
      // feeds the query — 'q' and digits included (they are not hotkeys here).
      if (ui.tab === KNOWLEDGE_TAB) {
        return { ui: { ...ui, searchQuery: ui.searchQuery + ch, cursor: 0, scroll: 0 }, effects };
      }
      if (ch === 'q') {
        effects.push({ type: 'quit' });
        return { ui, effects };
      }
      // 'r' polls GitHub now, on a host that runs the poller; the edit buffers
      // and the Knowledge search field above keep the letter as text
      if (ch === 'r' && viewport.github) {
        effects.push({ type: 'github_refresh' });
        return { ui, effects };
      }
      // A real space key arrives as a CHAR (terminal-kit names printable keys by
      // their character, so a 'SPACE' key-name never reaches the reducer from a
      // real terminal). On the System tab, activate() no-ops (no card nodes), so
      // route space to the same selector logic as ENTER — otherwise the picker's
      // SPACE handling was reachable only by tests (audit finding 39/43).
      if (ch === ' ' && ui.tab === SYSTEM_TAB) {
        return reduceNodes(store, ui, { kind: 'key', name: 'ENTER' }, viewport, knowledge, roster, resolveHeadSha, nodes, drawn);
      }
      if (ch === ' ') return { ui: activate(clamp(ui.cursor)), effects };
      // Tasks tab board-item edit (user-ruled 2026-09-28, board f25e5547 lane
      // J): 'e' on a selected todo card opens it for editing, prefilled with
      // its full text (card.body — the raw todo text, not the derived
      // label). An objective group header has nothing durable to edit (it is
      // navigation, not a record), so 'e' there is a no-op, matching how
      // activate() treats it as fold/unfold rather than a selection.
      if (ch === 'e' && ui.tab === TASKS_TAB) {
        const node = nodes[clamp(ui.cursor)];
        if (node && node.kind === 'card' && node.card.type !== 'objective') {
          // Fix 2 (Opus review of 71c1f41): read the CURRENT version fresh
          // via store.get — the projected Card carries no version field, and
          // a snapshot taken anywhere earlier than this keypress would widen
          // the lost-update guard's blind spot. The TEXT comes from the same
          // read: the node can come from the drawn frame, whose body may
          // predate another connection's change, and saving that body at the
          // new version would pass the guard and overwrite the change.
          const rec = store.get(node.card.id) as { version?: number; text?: unknown } | undefined;
          if (!rec || typeof rec.text !== 'string') return { ui: { ...ui, notice: 'board item no longer exists — nothing to edit' }, effects };
          const version = typeof rec.version === 'number' ? rec.version : 0;
          return { ui: { ...ui, boardEdit: { id: node.card.id, text: rec.text, version }, notice: undefined }, effects };
        }
        return { ui, effects };
      }
      if (/^[1-9]$/.test(ch)) {
        const index = Number(ch) - 1;
        if (index < reachable.length) return { ui: switchTab(reachable[index]!), effects };
      }
      return { ui, effects };
    }
    case 'tab':
      if (!reachable.includes(event.index)) return { ui, effects };
      return { ui: switchTab(event.index), effects };
    case 'wheel': {
      // wheel scrolls the viewport by lines (so you can read a tall expanded
      // record). On the Queue tab it scrolls the list under the pointer: the
      // history list below the divider, else the pending list.
      const step = event.dy > 0 ? 3 : -3;
      // the clamp needs only the drawn content height, which a scroll does not change
      const st = drawn && ui.tab !== SYSTEM_TAB ? drawn.state : buildSelf(ui);
      const qc = st.queueCompleted;
      // Queue: each list takes the wheel only over its own drawn lines (body
      // offsets 0..startRow-1 for pending with its overflow note, startRow..
      // maxBodyLines-1 for history); over the tabs, notice or footer it is a no-op
      const off = qc && event.y !== undefined ? event.y - 1 - st.bodyTop : undefined;
      if (off !== undefined && (off < 0 || off >= maxBodyLines)) return { ui, effects };
      if (qc && off !== undefined && off >= qc.startRow) {
        const historyTotal = qc.lines.length + (st.queueActivity ? 1 + st.queueActivity.lines.length : 0);
        const historyLines = Math.max(0, maxBodyLines - qc.startRow - 1);
        const max = Number.isFinite(maxBodyLines) ? Math.max(0, historyTotal - historyLines) : 0;
        return { ui: { ...ui, historyScroll: Math.max(0, Math.min((ui.historyScroll ?? 0) + step, max)) }, effects };
      }
      const rows = st.rows;
      const total = rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
      const max = Number.isFinite(maxBodyLines) ? Math.max(0, total - bodyWindow(st, maxBodyLines)) : 0;
      return { ui: { ...ui, scroll: Math.max(0, Math.min((ui.scroll ?? 0) + step, max)) }, effects };
    }
    case 'click': {
      // hit-test the frame on screen when the host passed it; otherwise build
      // the same geometry the renderer drew with — wrapped heights, the
      // queue tab's pending truncation, AND the banner-driven bodyTop must all
      // match the screen, so the tab-bar row and body hit-test track the banner
      const state = drawn ? drawn.state : buildSelf(ui);
      // tab bar sits one line above the body block (its own header row is just
      // above the body); terminal line = bodyTop - 1. Pick the tab by x extent.
      if (event.y === state.bodyTop - 1) {
        let x = 1;
        // Measure the labels THE RENDERER ACTUALLY DREW (state.tabs), never the
        // bare TABS constant: the Tasks tab carries a count ("Tasks (13)"), so a
        // width taken from the constant would be short by the count's width and
        // every click past the first tab would land on the wrong one — and it
        // would drift again with each digit the count gains.
        for (let i = 0; i < state.tabs.length; i++) {
          const width = state.tabs[i].label.length + 2; // ' label '
          if (event.x >= x && event.x < x + width) return { ui: switchTab(state.tabs[i].index), effects };
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
      return { ui: { ...ui, expanded: [], scroll: 0, historyScroll: undefined }, effects };
  }
  return { ui, effects };
}

export function runEffects(store: SterlingStore, effects: Effect[], now: () => string = () => new Date().toISOString()): boolean {
  let quit = false;
  for (const e of effects) {
    if (e.type === 'select') store.writeSelection(e.recordType, e.id, now());
    if (e.type === 'quit') quit = true;
    if (e.type === 'board_edit') {
      // Same store write path board_update uses (SterlingStore.updateTodo):
      // the merged candidate carries the old record's id/slug/every other
      // field unchanged, only `text`/`updated_at` (and, when resolved,
      // `measured_at_head` — fix 1) replaced — updateTodo pins
      // id/type/created_at itself and bumps version, so this is exactly an
      // in-place edit, never a new record (user-ruled 2026-09-28, board
      // f25e5547 lane J).
      //
      // reduce() already re-read the live record at commit time and refused
      // to push this effect at all if it had vanished, gone non-live, or its
      // version had moved (fixes 2+3) — so in the ordinary single-TUI-process
      // case `e.version` is exactly the version this write is about to
      // replace. `expected_version` is passed anyway as a belt-and-suspenders
      // backstop against the (vanishingly small, but real for a store shared
      // by another process) window between that check and this write: the
      // store's own optimistic-concurrency guard (applyInPlace) then throws
      // rather than silently applying a stale-based write. The controller's
      // flush() turns that throw into a visible notice, as it does for every
      // store write (P5): loud, never swallowed, and never an exit.
      const old = store.get(e.id);
      const candidate: Record<string, unknown> = { ...(old as unknown as Record<string, unknown>), text: e.text, updated_at: now() };
      if (e.measuredAtHead) candidate.measured_at_head = e.measuredAtHead;
      store.updateTodo(e.id, candidate, { expected_version: e.version });
    }
  }
  return quit;
}
