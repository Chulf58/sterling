// The pure, fully-tested state layer (revised §2.1: testability lives HERE,
// never the renderer). buildDashboardState derives everything the renderer
// prints; reduce maps input events (keys AND mouse) to new UI state plus
// effects. The renderer stays thin enough to be boring.
import { execFileSync } from 'node:child_process';
import type { SterlingStore, MountedStores } from '@sterling/store';
import { MAX_RANK_TERMS, rankTermDedupeKey } from '@sterling/store';
import { isCustomAgentKey, type AgentHost, MAINTENANCE_WORKER_ROLE, AGY_MODEL_IDS, AGY_MODEL_NAMESPACE, CLAUDE_PROVIDER, CONDUCTOR_MODEL_KEY, PLAN_MODEL_KEY, MIN_REVIEWERS, MAX_REVIEWERS, OVERPASS_EFFORTS, OVERPASS_MODEL_NAMESPACE, OVERPASS_PROVIDER_RE, OVERPASS_TIERS, twoModelsReason, unsupportedAgents } from '@sterling/schemas';
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
  /** System tab, adoption confirm: the plan the controller computed for the not-yet-adopted agent `id`,
   *  its lines, and whether it can go ahead. ENTER confirms an ok plan, ESCAPE or any move cancels. */
  adoptConfirm?: { id: string; ok: boolean; lines: string[] };
  /** System tab, Overpass provider row: the edit buffer for config.overpass.provider,
   *  the same always-capture idiom as the board edit. ENTER commits only a
   *  valid provider id (OVERPASS_PROVIDER_RE) and otherwise keeps the buffer open
   *  with a notice; ESCAPE cancels. */
  overpassProviderEdit?: string;
  /** Tasks tab, board item edit-in-progress (user-ruled 2026-09-28, board
   *  f25e5547 lane J: "Add TUI edit"). Absent → the plain card is shown;
   *  present → 'e' has opened the selected todo's text for editing — every
   *  printable key/BACKSPACE feeds `text`, ENTER commits (through the same
   *  store write path board_update uses), ESCAPE cancels. Mirrors
   *  the always-capture idiom, scoped to one card.
   *  `version` (fix round, Opus review of 71c1f41) is the record's version
   *  as read the moment 'e' was pressed — read fresh via store.get, never
   *  from the projected Card, which carries no version field. ENTER re-reads
   *  the live record and refuses the commit (visible notice, buffer KEPT) if
   *  the stored version has moved — the lost-update guard. */
  boardEdit?: { id: string; text: string; version: number };
  /** The key help overlay (`?` or F1), drawn over the body of any tab with its
   *  own scroll offset. Absent → closed. Any key but the scroll keys and
   *  Ctrl-C closes it. */
  help?: { scroll: number };
  /** `q` was pressed once and the notice asks for a second `q`. The next `q`
   *  quits; any other event clears it (reduce()). */
  quitConfirm?: boolean;
}

/** The System-tab picker (decision one-model-per-agent-an-agent-has-a-single-model-not-a-claude): `key` is the
 *  config.models key under edit; step 1 picks the model, step 2 its effort or variant; `highlight` is the
 *  current option index; `model` holds the model confirmed at step 1. */
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

/** A custom agent found in a project agent folder and not adopted yet: shown with its host-qualified
 *  identity and an Adopt action (GitHub #312). */
export interface CustomAgentView {
  name: string;
  source: 'claude' | 'opencode' | 'agy';
  model?: string;
  error?: string;
  /** the project-relative file, for the adoption plan */
  file?: string;
}
/** An adopted custom agent (agent-sources/<key>.md plus config.models.<key>): a full editable row. */
export interface AdoptedAgentView {
  key: string;
  /** the agent's own name (its source's frontmatter name, or the key's slug) */
  name: string;
  /** the hosts it is rendered into: every host installed in this project */
  hosts: AgentHost[];
  /** what planCustomAgents refused for it: a host and the reason, shown on the row */
  refusals: Array<{ host: string; reason: string }>;
}
/** A models-catalog entry (reference_material.catalog.entries[]). */
export interface CatalogEntry {
  id: string;
  label: string;
  tier: string;
  status: string;
  /** 'anthropic', 'openai', ... Absent on a catalog written before vendors
   *  existed; such an entry is an anthropic one. */
  vendor?: string;
}
/** The catalog-status view computed at activation (present/stale/staleDate) plus
 *  the entries the picker offers. Precomputed so the projection has no clock. */
export interface CatalogStatusView {
  present: boolean;
  stale: boolean;
  staleDate: string | null;
  entries: CatalogEntry[];
}
/** One agent's canonical entry (config.models.<key>): its one model as <provider>/<id>, and its effort. */
export interface AgentModelView {
  model?: string;
  effort?: string;
}
/** The workflow settings as the System tab reads them (config.workflow, through the canonical transform). */
export interface WorkflowView {
  merge: 'direct' | 'pr';
  reviewers: number;
  copilot_loop: boolean;
  auto_merge_on_clean: boolean;
}
/** The System tab's view of the project, read at tab activation (never the 1 Hz loop, decision
 *  foreign_98064d77) through parseCanonicalConfig, so it never depends on parseConfig's shape. */
export interface AgentRosterSnapshot {
  /** config.models, canonical: one model per agent key. */
  models: Record<string, AgentModelView>;
  /** The hosts the hosts column judges: Claude Code and OpenCode always, agy when it is installed. */
  hosts: AgentHost[];
  /** Roles whose legacy entry still names two models (the transform's conflicts): their hosts cell says to run /sterling:update. */
  twoModels?: string[];
  /** Set when the config cannot be read as canonical: the agent and workflow rows then say so, never a default. */
  configError?: string;
  /** Custom agents from the project's agent folders that are not adopted yet: an Adopt row each. */
  customAgents?: CustomAgentView[];
  /** Adopted custom agents (config.models.custom-*): full editable rows. */
  adoptedAgents?: AdoptedAgentView[];
  catalog: CatalogStatusView;
  /** config.workflow; absent → the schema defaults (direct, 1 reviewer, no loop, auto-merge on). */
  workflow?: WorkflowView;
  /** config.overpass.provider (the logical overpass/<tier> models run through it); absent → 'overpass'. */
  overpassProvider?: string;
  /** config.tdd: absent → on. */
  tdd?: { enabled: boolean };
  /** The handoff setting (decision
   *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
   *  true or false is the EFFECTIVE setting as the writers read it. A string is a raw value that is
   *  not a boolean (INVALID). Absent → off; null → the setting could not be determined (UNKNOWN). */
  handoff?: boolean | string | null;
  /** Why the handoff row reads as it does, shown in brackets after the value. */
  handoffDetail?: string;
  /** config.storage, read-only: the RAW config value. Absent → SQLite; null → the config could not be read. */
  storage?: string | null;
  /** Which host opened the dashboard. */
  host?: string;
}
/** A projected System-tab line (renderer prints text verbatim; kind styles it). */
export interface SystemLine {
  text: string;
  kind?: string;
  selected?: boolean;
}
/** A System-tab row — one per agent key (id 'sys:<key>') or setting. */
export interface SystemRow {
  id: string;
  key?: string;
  agents?: string[];
  lines: SystemLine[];
}
/** Which block of the tab an entry belongs to (decision system-tab-layout-one-screen-with-three-sections-agents-one). */
export type SystemSection = 'agents' | 'workflow' | 'project';
/** What ENTER or SPACE does on an entry, as data (no callbacks, no IO): the reducer applies it.
 *  agent: the role's two-step model and effort picker; toggle: push `effect`;
 *  edit: open a text field by patching the UI state. */
export type SystemAction =
  | { kind: 'agent'; key: string }
  | { kind: 'toggle'; effect: Effect }
  | { kind: 'edit'; uiPatch: Partial<UiState> }
  /** a not-yet-adopted custom agent: ENTER asks the controller for the adoption plan */
  | { kind: 'adopt'; id: string };
/** One entry of the System tab's single ordered list. Cursor, clamp, draw order and the
 *  click hit-test all derive from this list: a cursorable entry takes the next cursor index
 *  in list order, a read-only one takes none. Adding a row means adding one entry. */
export interface SystemEntry {
  id: string;
  section: SystemSection;
  cursorable: boolean;
  /** the rendered lines (and the row's key, for agent rows) */
  row: SystemRow;
  /** ENTER/SPACE; absent on a read-only entry */
  action?: SystemAction;
  /** Set on a setting that does not apply right now: the row is shown dimmed with this reason,
   *  holds no cursor index and emits no effect. */
  disabled?: string;
}
export interface SystemTabView {
  /** every visible entry, in draw and cursor order */
  entries: SystemEntry[];
  banner: string[];
  /** The agent rows, derived from `entries` (never maintained apart from it). */
  rows: SystemRow[];
  workflowRows: SystemRow[];
  projectRows: SystemRow[];
  /** the not-yet-adopted custom agents (Adopt rows) */
  customRows: SystemRow[];
}

const EMPTY_ROSTER: AgentRosterSnapshot = {
  models: {},
  hosts: ['claude', 'opencode'],
  catalog: { present: false, stale: false, staleDate: null, entries: [] },
  tdd: { enabled: true },
  handoff: false,
  storage: undefined,
};

/** The agents the table always lists, in order; adopted custom agents follow. */
export const SYSTEM_AGENT_KEYS = [CONDUCTOR_MODEL_KEY, PLAN_MODEL_KEY, 'implementor', 'implementor-hard', 'reviewer', 'sparring', 'researcher', 'scout', 'librarian', 'preflight', MAINTENANCE_WORKER_ROLE] as const;

const HOST_NAME: Record<AgentHost, string> = { claude: 'Claude Code', opencode: 'OpenCode', agy: 'agy' };
const DEFAULT_WORKFLOW: WorkflowView = { merge: 'direct', reviewers: MIN_REVIEWERS, copilot_loop: false, auto_merge_on_clean: true };

/** The provider of a canonical model reference (<provider>/<id>). */
const providerOf = (ref: string): string => ref.slice(0, ref.indexOf('/'));

/** The effort options of step 2 for a model (decision
 *  one-model-per-agent-an-agent-has-a-single-model-not-a-claude, two-step picker). 'unset' removes the
 *  effort. An agy model carries its variant in its id (agy/flash, agy/pro), so it has only 'unset'; 'max'
 *  is allowed only on an Overpass tier (canonicalModelsSchema), and no other model offers xhigh or max. */
export function effortOptions(model: string | undefined): string[] {
  if (model === undefined) return ['unset'];
  const provider = providerOf(model);
  if (provider === AGY_MODEL_NAMESPACE) return ['unset'];
  if (provider === OVERPASS_MODEL_NAMESPACE) return ['unset', ...OVERPASS_EFFORTS];
  return ['unset', 'low', 'medium', 'high'];
}

/** One line of the open picker; `option` is the index the highlight and a click address, absent on a group header. */
export interface PickerSpec {
  text: string;
  option?: number;
}
const AGY_MODEL_LABELS: Record<(typeof AGY_MODEL_IDS)[number], string> = {
  inherit: 'agy session model (your agy default, e.g. Neon)',
  flash_lite: 'agy flash-lite tier',
  flash: 'agy flash tier',
  pro: 'agy pro tier',
};
/** What a model-step option commits: a canonical model reference, or (custom agents only) no model. */
export type ModelChoice = { ref: string } | { inherit: true };

/** The model step's options and their group headers, in draw order: anthropic and the other catalog
 *  vendors, then agy's own ids, then overpass/<tier>; an adopted custom agent also offers inherit. A model the
 *  agent already holds that no list carries is added under its own provider, so the picker never hides it. */
export function modelChoices(snap: AgentRosterSnapshot, key: string): Array<{ group: string; choice: ModelChoice; label: string }> {
  const out: Array<{ group: string; choice: ModelChoice; label: string }> = [];
  const seen = new Set<string>();
  const add = (group: string, ref: string, label: string): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push({ group, choice: { ref }, label });
  };
  if (isCustomAgentKey(key)) out.push({ group: 'default', choice: { inherit: true }, label: "inherit: the host's own model and effort" });
  const vendors: string[] = [CLAUDE_PROVIDER];
  for (const e of snap.catalog.entries) if (!vendors.includes(e.vendor ?? CLAUDE_PROVIDER)) vendors.push(e.vendor ?? CLAUDE_PROVIDER);
  for (const v of vendors) for (const e of snap.catalog.entries) if ((e.vendor ?? CLAUDE_PROVIDER) === v) add(v, `${v}/${e.id}`, e.label);
  for (const id of AGY_MODEL_IDS) add(AGY_MODEL_NAMESPACE, `${AGY_MODEL_NAMESPACE}/${id}`, AGY_MODEL_LABELS[id]);
  for (const tier of OVERPASS_TIERS) add(OVERPASS_MODEL_NAMESPACE, `${OVERPASS_MODEL_NAMESPACE}/${tier}`, '');
  const current = snap.models[key]?.model;
  if (current !== undefined) add(providerOf(current), current, '(current)');
  // keep the provider groups together once a current model was appended
  const order: string[] = [];
  for (const o of out) if (!order.includes(o.group)) order.push(o.group);
  return order.flatMap((g) => out.filter((o) => o.group === g));
}

/** The picker's lines for the open selector: the model step (grouped by provider) or the effort step. */
export function pickerSpecs(snap: AgentRosterSnapshot, sel: SystemSelector): PickerSpec[] {
  if (sel.stage === 'effort') return effortOptions(sel.model).map((eff, i) => ({ text: `effort ${eff}`, option: i }));
  const specs: PickerSpec[] = [];
  let group: string | undefined;
  let index = 0;
  for (const o of modelChoices(snap, sel.key)) {
    if (o.group !== group) {
      group = o.group;
      specs.push({ text: `${o.group}` });
    }
    specs.push({ text: `${'ref' in o.choice ? o.choice.ref : 'inherit'}${o.label ? `  ${o.label}` : ''}`, option: index++ });
  }
  return specs;
}
const pickerCount = (snap: AgentRosterSnapshot, sel: SystemSelector): number => pickerSpecs(snap, sel).filter((s) => s.option !== undefined).length;

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
/** Enables the Agents tab; its label shows `running` and, when there are any, `quiet`
 *  (listed agents with no handback whose transcript has been silent past the
 *  alive window: maybe live, so counted apart rather than hidden). */
export interface AgentsTab {
  running: number;
  /** unset reads as 0 */
  quiet?: number;
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
  /** the Agents tab's card block height in lines, composed by the host
   *  (main.ts) at full height; it bounds the Agents tab's scroll. Absent → 0. */
  agentsLines?: number;
}

export interface DashboardState {
  /** `index` is the tab's TABS index: the tab bar can skip a tab, so a position is not an index */
  tabs: { label: string; active: boolean; index: number }[];
  rows: Row[];
  emptyMessage?: string;
  /** the mode's key help, at most 48 columns and clipped to the pane; the
   *  renderer pins it to the last row */
  footer: string;
  /** the same help as key/description pairs, for the renderer to colour; the
   *  renderer cuts them to `footer`'s length, so the text is only `footer` */
  footerSegments: FooterSegment[];
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
/** System tab agent row, step 2 committed: writes config.models.<key> as the one model (<provider>/<id>)
 *  and its effort. `model` null (a custom agent's inherit) removes both. The entry is replaced whole, so no
 *  per-host field survives (decision one-model-per-agent-an-agent-has-a-single-model-not-a-claude). */
export interface AgentModelEffect {
  type: 'agent_model';
  key: string;
  model: string | null;
  effort?: string;
}
/** System tab, Workflow rows: writes one field of config.workflow (decision
 *  settings-that-replace-project-mode-merge-path-reviewer-count). Carries the NEW value. */
export interface WorkflowEffect {
  type: 'workflow_set';
  field: 'merge' | 'reviewers' | 'copilot_loop' | 'auto_merge_on_clean';
  value: string | number | boolean;
}
/** System tab, tdd toggle row (decision foreign_752caf98): flips config.tdd.enabled.
 *  OFF silences the automatic default posture only — H5/H18 test protection
 *  is untouched, and an explicit user ask still fires TDD. */
export interface TddToggleEffect {
  type: 'tdd_toggle';
  enabled: boolean;
}
/** System tab, handoff files row (decision
 *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
 *  writes config.handoff.enabled. Carries the NEW value. */
export interface HandoffToggleEffect {
  type: 'handoff_toggle';
  enabled: boolean;
}
/** System tab, Overpass provider row: writes config.overpass.provider and nothing else. */
export interface OverpassProviderEffect {
  type: 'overpass_provider';
  provider: string;
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
/** Compute the adoption plan for a not-yet-adopted agent (the controller does the IO and sets ui.adoptConfirm). */
export interface AdoptPlanEffect {
  type: 'adopt_plan';
  id: string;
}
/** Carry out the plan the user confirmed: adopt, create config.models.<key>, render. */
export interface AdoptRunEffect {
  type: 'adopt_run';
  id: string;
}
export type Effect =
  | AdoptPlanEffect
  | AdoptRunEffect
  | SelectEffect
  | QuitEffect
  | AgentModelEffect
  | WorkflowEffect
  | TddToggleEffect
  | HandoffToggleEffect
  | OverpassProviderEffect
  | BoardEditEffect
  | GithubRefreshEffect;

export type UiEvent =
  | { kind: 'key'; name: 'LEFT' | 'RIGHT' | 'TAB' | 'UP' | 'DOWN' | 'ENTER' | 'SPACE' | 'QUIT' | 'ESCAPE' | 'BACKSPACE' | 'STATE_FILTER' | 'PAGE_UP' | 'PAGE_DOWN' | 'HOME' | 'END' | 'HELP' }
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

export const clipEllipsis = (s: string, width: number): string =>
  Number.isFinite(width) && s.length > width ? `${s.slice(0, Math.max(1, width) - 1)}…` : s;

const clipTo = (s: string, width: number): string => clipEllipsis(s, width);
/** The hosts cell of an agent row: which hosts cannot run its one model ("can't run on Claude Code"), from
 *  unsupportedAgents (decision one-model-per-agent-an-agent-has-a-single-model-not-a-claude, point 5: no
 *  silent copy where a host cannot run the model). */
function hostsCell(snap: AgentRosterSnapshot, key: string): string {
  if ((snap.twoModels ?? []).includes(key)) return `⚠ ${twoModelsReason(key)}`;
  const entry = snap.models[key];
  if (entry?.model === undefined) return 'host default';
  const cannot = unsupportedAgents({ models: { [key]: { model: entry.model } } }, snap.hosts)
    .filter((u) => u.agent === key && u.host !== '*')
    .map((u) => HOST_NAME[u.host as AgentHost]);
  return cannot.length === 0 ? 'all hosts' : `can't run on ${cannot.join(', ')}`;
}

const COL_AGENT = 20;
const COL_MODEL = 30;
const COL_EFFORT = 8;
const cell = (s: string, w: number): string => (s.length >= w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

function systemEntries(snapshot: AgentRosterSnapshot, ui: UiState, width: number): { entries: SystemEntry[]; banner: string[] } {
  const snap = snapshot ?? EMPTY_ROSTER;
  const selector = ui.selector;
  const clip = (s: string): string => clipTo(s, width);
  const entries: SystemEntry[] = [];
  const next = (): number => entries.filter((e) => e.cursorable).length;
  const label = (id: string, section: SystemSection, text: string, kind: 'title' | 'meta'): void => {
    entries.push({ id, section, cursorable: false, row: { id, lines: [{ text: clip(text), kind }] } });
  };
  const catBanner = catalogBanner(snap.catalog, width);
  const banner = ui.notice ? [clip(`⚠ ${ui.notice}`), ...catBanner] : catBanner;

  // ── AGENTS: one row per agent, agent | model | effort | hosts that can run it
  label('sys:heading:agents', 'agents', 'Agents', 'title');
  label('sys:agents:columns', 'agents', `  ${cell('agent', COL_AGENT)}${cell('model', COL_MODEL)}${cell('effort', COL_EFFORT)}hosts`, 'meta');
  const adopted = (snap.adoptedAgents ?? []).filter((a) => snap.models[a.key] !== undefined);
  const agentKeys: string[] = [...SYSTEM_AGENT_KEYS, ...adopted.map((a) => a.key)];
  for (const key of agentKeys) {
    const cursor = next();
    const selected = cursor === ui.cursor;
    const adoptedView = adopted.find((a) => a.key === key);
    const entry = snap.models[key];
    const name = adoptedView ? `${adoptedView.name} (custom)` : key;
    const unreadable = snap.configError !== undefined;
    const model = unreadable ? 'UNKNOWN' : (entry?.model ?? '(unset)');
    const effort = unreadable ? '-' : (entry?.effort ?? '-');
    const hosts = unreadable ? `config unreadable: ${snap.configError}` : hostsCell(snap, key);
    const lines: SystemLine[] = [{ text: clip(`${selected ? '› ' : '  '}${cell(name, COL_AGENT)}${cell(model, COL_MODEL)}${cell(effort, COL_EFFORT)}${hosts}`), kind: 'title', selected }];
    for (const r of adoptedView?.refusals ?? []) lines.push({ text: clip(`    ⚠ ${r.host}: ${r.reason}`), kind: 'meta' });
    if (selector && selector.key === key) {
      lines.push({ text: clip(selector.stage === 'model' ? `  step 1 of 2: model` : `  step 2 of 2: effort for ${selector.model ?? 'no model'}`), kind: 'meta' });
      for (const spec of pickerSpecs(snap, selector)) {
        const on = spec.option !== undefined && spec.option === selector.highlight;
        lines.push(spec.option === undefined ? { text: clip(`    ${spec.text}`), kind: 'meta' } : { text: clip(`  ${on ? '› ' : '  '}  ${spec.text}`), kind: 'option', selected: on });
      }
    }
    const row: SystemRow = { id: `sys:${key}`, key, agents: [key], lines };
    entries.push(unreadable ? { id: row.id, section: 'agents', cursorable: false, row, disabled: 'config unreadable' } : { id: row.id, section: 'agents', cursorable: true, row, action: { kind: 'agent', key } });
  }
  // Custom agents that are not adopted yet: host-qualified identity and the file's own model, with an Adopt
  // action; one the file could not be read for stays read-only with its error.
  (snap.customAgents ?? []).forEach((a, i) => {
    const id = `sys:custom:${a.source}:${i}`;
    const adoptId = `${a.source}:${a.name}`;
    const ok = a.error === undefined;
    const selected = ok && ui.cursor === next();
    const text = ok ? `${selected ? '› ' : '  '}${adoptId} (not adopted): ${a.model ?? 'inherit/default'} — ENTER to adopt` : `  ${adoptId}: ⚠ ${a.error} (read-only)`;
    const lines: SystemLine[] = [{ text: clip(text), kind: ok ? 'title' : 'meta', ...(ok ? { selected } : {}) }];
    if (ui.adoptConfirm?.id === adoptId) for (const l of ui.adoptConfirm.lines) lines.push({ text: clip(`    ${l}`), kind: 'body' });
    const row: SystemRow = { id, key: `custom:${a.source}:${a.name}`, agents: [a.name], lines };
    entries.push({ id, section: 'agents', cursorable: ok, row, ...(ok ? { action: { kind: 'adopt', id: adoptId } as SystemAction } : {}) });
  });

  // A setting that does not apply now stays on screen: dimmed, with the reason, no cursor index, no effect.
  const setting = (section: SystemSection, id: string, text: (marker: string) => string, action: SystemAction): void => {
    const selected = ui.cursor === next();
    entries.push({ id, section, cursorable: true, row: { id, lines: [{ text: clip(text(selected ? '› ' : '  ')), kind: 'title', selected }] }, action });
  };
  const disabled = (section: SystemSection, id: string, text: string, reason: string): void => {
    entries.push({ id, section, cursorable: false, row: { id, lines: [{ text: clip(`  ${text}  (${reason})`), kind: 'meta' }] }, disabled: reason });
  };

  // ── WORKFLOW: merge path, reviewers, Copilot loop, auto-merge, TDD
  label('sys:heading:workflow', 'workflow', 'Workflow', 'title');
  const wf = snap.workflow;
  if (snap.configError !== undefined) {
    for (const [id, name] of [['sys:merge_path', 'Merge path'], ['sys:reviewers', 'Reviewers'], ['sys:copilot_loop', 'Copilot loop'], ['sys:pr_auto_merge', 'Auto-merge']] as const) {
      disabled('workflow', id, `${name}: UNKNOWN`, `config unreadable: ${snap.configError}`);
    }
  } else {
    const w = wf ?? DEFAULT_WORKFLOW;
    const onOff = (b: boolean): string => (b ? 'ON' : 'OFF');
    setting('workflow', 'sys:merge_path', (m) => `${m}Merge path: ${w.merge === 'pr' ? 'pull request' : 'direct'}`, { kind: 'toggle', effect: { type: 'workflow_set', field: 'merge', value: w.merge === 'pr' ? 'direct' : 'pr' } });
    setting('workflow', 'sys:reviewers', (m) => `${m}Reviewers: ${w.reviewers}  (${MIN_REVIEWERS}-${MAX_REVIEWERS}; ENTER steps up, past ${MAX_REVIEWERS} back to ${MIN_REVIEWERS})`, {
      kind: 'toggle',
      effect: { type: 'workflow_set', field: 'reviewers', value: w.reviewers >= MAX_REVIEWERS || w.reviewers < MIN_REVIEWERS ? MIN_REVIEWERS : w.reviewers + 1 },
    });
    const noPr = 'needs the pull-request merge path';
    if (w.merge !== 'pr') disabled('workflow', 'sys:copilot_loop', `Copilot loop: ${onOff(w.copilot_loop)}`, noPr);
    else setting('workflow', 'sys:copilot_loop', (m) => `${m}Copilot loop: ${onOff(w.copilot_loop)}`, { kind: 'toggle', effect: { type: 'workflow_set', field: 'copilot_loop', value: !w.copilot_loop } });
    if (w.merge !== 'pr') disabled('workflow', 'sys:pr_auto_merge', `Auto-merge: ${onOff(w.auto_merge_on_clean)}`, noPr);
    else if (!w.copilot_loop) disabled('workflow', 'sys:pr_auto_merge', `Auto-merge: ${onOff(w.auto_merge_on_clean)}`, 'needs the Copilot loop on');
    else setting('workflow', 'sys:pr_auto_merge', (m) => `${m}Auto-merge: ${onOff(w.auto_merge_on_clean)}`, { kind: 'toggle', effect: { type: 'workflow_set', field: 'auto_merge_on_clean', value: !w.auto_merge_on_clean } });
  }
  setting('workflow', 'sys:tdd_enabled', (m) => `${m}TDD: ${(snap.tdd ?? { enabled: true }).enabled ? 'ON' : 'OFF'}`, { kind: 'toggle', effect: { type: 'tdd_toggle', enabled: flipTo(snap.tdd?.enabled, true) } });

  // ── PROJECT: Overpass provider, handoff files, storage (read-only)
  label('sys:heading:project', 'project', 'Project', 'title');
  const provider = snap.overpassProvider ?? 'overpass';
  const editing = ui.overpassProviderEdit !== undefined;
  setting('project', 'sys:overpass_provider', (m) => `${m}Overpass provider: ${editing && m === '› ' ? `${ui.overpassProviderEdit}▌` : provider}`, { kind: 'edit', uiPatch: { overpassProviderEdit: provider } });
  setting('project', 'sys:handoff_files', (m) => handoffText(snap, m), { kind: 'toggle', effect: { type: 'handoff_toggle', enabled: flipTo(snap.handoff, false) } });
  entries.push({ id: 'sys:storage', section: 'project', cursorable: false, row: storageRow(snap, width) });
  return { entries, banner };
}

/** The one rule for an on/off setting: unset flips from the setting's default; exactly ON turns OFF;
 *  exactly OFF turns ON; anything else (an invalid value, an unreadable config) turns OFF, never ON on a guess. */
function flipTo(value: unknown, defaultOn: boolean): boolean {
  if (value === undefined) return !defaultOn;
  return value === false;
}

/** The entries that hold a cursor index, in cursor order (the reducer's and the reveal's view of the list). */
function cursorEntries(snap: AgentRosterSnapshot, ui: UiState): SystemEntry[] {
  return systemEntries(snap, ui, Infinity).entries.filter((e) => e.cursorable);
}

/** The cursor index of the entry with this id, or -1: for navigation by id rather than by hand-counted offset. */
export function systemCursorOf(snapshot: AgentRosterSnapshot, ui: UiState, id: string): number {
  return cursorEntries(snapshot ?? EMPTY_ROSTER, ui).findIndex((e) => e.id === id);
}

export function buildSystemTab(snapshot: AgentRosterSnapshot, ui: UiState, width = Infinity): SystemTabView {
  const { entries: all, banner } = systemEntries(snapshot, ui, width);
  const selector = ui.selector;
  // While a picker is open the view FOCUSES on the key under edit: the other rows are hidden so the
  // picker's options are the only model text on screen.
  const entries = selector ? all.filter((e) => e.action?.kind === 'agent' && e.row.key === selector.key) : all;
  const inSection = (s: SystemSection): SystemRow[] => entries.filter((e) => e.section === s && e.id.startsWith('sys:') && !e.id.startsWith('sys:heading:')).map((e) => e.row);
  return {
    entries,
    banner,
    rows: entries.filter((e) => e.action?.kind === 'agent').map((e) => e.row),
    workflowRows: inSection('workflow'),
    projectRows: inSection('project'),
    customRows: entries.filter((e) => e.id.startsWith('sys:custom:')).map((e) => e.row),
  };
}

/** The catalog-status banner: absent / current(fresh) / stale-with-date. */
function catalogBanner(catalog: CatalogStatusView, width: number): string[] {
  const clip = (s: string): string => clipEllipsis(s, width);
  if (!catalog.present) return [clip('catalog: none found')];
  if (catalog.stale) return [clip(`catalog stale (as of ${catalog.staleDate ?? '?'})`)];
  return [clip('catalog: current')];
}

/** handoff files row (decision
 *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting): ON or
 *  OFF from the effective setting (absent → OFF), UNKNOWN for an unreadable
 *  config or a git failure, and INVALID for a raw value that is not a boolean. */
function handoffText(snap: AgentRosterSnapshot, marker: string): string {
  const handoff = snap.handoff === undefined ? false : snap.handoff;
  const why = snap.handoffDetail === undefined ? '' : ` (${snap.handoffDetail})`;
  const shown = handoff === null ? `UNKNOWN (${snap.handoffDetail ?? 'config unreadable'})` : handoff === true ? `ON${why}` : handoff === false ? `OFF${why}` : `INVALID (${handoff})`;
  return `${marker}Handoff files: ${shown}`;
}

/** storage row (board 6ca1a3c5), READ-ONLY and never selected: SERVED POSTGRES for
 *  'postgres', SQLITE for 'sqlite' or an absent key, UNKNOWN for an unreadable config,
 *  and UNRECOGNIZED with the raw value for anything else. */
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
      label: label === 'Tasks' && taskCount !== null ? `${label} (${taskCount})` : label === 'Agents' && agents ? `${label} (${agents.running} running${agents.quiet ? ` · ${agents.quiet} quiet` : ''})` : label,
      active: i === activeTab,
      index: i,
    };
  });
}

type TabCell = { label: string; active: boolean; index: number };

/**
 * Fit the tab bar into `width` columns (each cell is ' label '). Steps, first
 * fit wins: full labels; inactive counts shrink to the number alone
 * ('Agents (2 running · 3 quiet)' becomes 'Agents (2)'); the active tab's too;
 * tabs with no count shorten to 3 letters, then 1, while the counted tabs
 * keep their number; only then inactive tabs drop their '(…)' count, the
 * active tab drops its count too, and inactive tabs shorten to 3 letters, then 1; the
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
  // the count alone: 'Agents (2 running · 3 quiet)' -> 'Agents (2)'. A tab with no count is unchanged.
  const compact = (l: string): string => l.replace(/ \((\d+)[^)]*\)$/, ' ($1)');
  // names shorten before a count is dropped, so Tasks and Agents keep theirs on a narrow pane
  const keepCount = (n: number) => (l: string): string => (l === bare(l) ? l.slice(0, n) : compact(l));
  const steps: [(l: string) => string, (l: string) => string][] = [
    [(l) => l, (l) => l],
    [(l) => l, compact],
    [compact, compact],
    [compact, keepCount(3)],
    [compact, keepCount(1)],
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

/** One footer hint: a key name and what it does. Either may be empty (a bare
 *  label like 'editing' is a desc with no key, 'wheel' a key with no desc). */
export interface FooterSegment {
  key: string;
  desc: string;
}

/** The footer segments as the plain text the OpenCode host shows: 'key desc'
 *  pairs joined by ' · '. The renderer draws these in two colours. */
export const FOOTER_SEPARATOR = ' · ';
export const footerText = (segments: readonly FooterSegment[]): string =>
  segments.map((s) => (s.key && s.desc ? `${s.key} ${s.desc}` : s.key || s.desc)).join(FOOTER_SEPARATOR);

/** The key help for the tab and mode on screen: at most 48 columns (the
 *  launcher's 35% pane), then clipped to the pane. `footer` is the clipped
 *  plain text; `footerSegments` are the unclipped pairs the renderer colours,
 *  cut to the same length. */
function footerFor(ui: UiState, tabCount: number, width: number): { footer: string; footerSegments: FooterSegment[] } {
  const k = (key: string, desc = ''): FooterSegment => ({ key, desc });
  const tabs = k(`1-${tabCount}`, 'tabs');
  let segments: FooterSegment[];
  if (ui.help) segments = [k('↑↓ PgUp PgDn', 'scroll'), k('any other key', 'closes')];
  else if (ui.tab === TASKS_TAB) segments = ui.boardEdit ? [k('', 'editing'), k('enter', 'save'), k('esc', 'cancel')] : [tabs, k('enter', 'open'), k('e', 'edit'), k('?', 'help'), k('q', 'quit')];
  // '?' types into the search here, so the footer offers F1
  else if (ui.tab === KNOWLEDGE_TAB) segments = [k('type', 'to search'), k('esc', 'clear'), k('^f', 'state'), k('F1', 'help')];
  else if (ui.tab === QUEUE_TAB) segments = [tabs, k('↑↓', 'pending'), k('wheel'), k('?', 'help'), k('q', 'quit')];
  else if (ui.tab === AGENTS_TAB) segments = [k(`←/→ or ${tabs.key}`, 'tabs'), k('↑↓', 'scroll'), k('?', 'help'), k('q', 'quit')];
  else if (ui.tab === GITHUB_TAB) segments = [tabs, k('↑↓'), k('r', 'refresh'), k('?', 'help'), k('q', 'quit')];
  else segments = [tabs, k('enter', 'change'), k('esc'), k('?', 'help'), k('q', 'quit')];
  return { footer: clipEllipsis(footerText(segments), width), footerSegments: segments };
}

/** The key help overlay's lines (`?` or F1), each at most 48 columns before
 *  the pane clips it. The first line is the heading. */
export const HELP_LINES: readonly string[] = [
  'Keys',
  '←/→ or tab   previous / next tab',
  '1-9          go to that tab (not on Knowledge)',
  '↑/↓          move the selection, or scroll',
  'PgUp/PgDn    move or scroll a page',
  'Home/End     first / last row, top / bottom',
  'enter/space  open, fold, select or change',
  'click        the same as enter on that row',
  'wheel        scroll; right-click folds all',
  'e            edit the task (Tasks)',
  'type, esc    search, clear it (Knowledge)',
  '^f           article state filter (Knowledge)',
  'r            refresh GitHub now',
  'esc          cancel a picker or an edit',
  '? or F1      this help (F1 on Knowledge)',
  'q            quit; asks first, q again quits',
  'ctrl-c       quit at once, from anywhere',
];

/** The text `q` shows: the first press asks, the second quits. */
export const QUIT_PROMPT = 'quit? q again quits, any other key stays';

/** Clamp a scroll offset for `total` content lines in a `window`-line body;
 *  an unbounded window never scrolls. */
function clampScroll(scroll: number, total: number, window: number): number {
  const max = Number.isFinite(window) ? Math.max(0, total - window) : 0;
  return Math.max(0, Math.min(scroll, max));
}

/** The help overlay's state: HELP_LINES as one display-only row over the
 *  body, scrolled by ui.help.scroll. The tab bar, notice and strip stay. */
function helpDashboardState(ui: UiState, width: number, banner: string[], projectName: string, bodyTop: number, tabs: TabCell[], maxBodyLines: number, agents?: AgentsTab, github?: GithubSnapshot): DashboardState {
  const lines: RowLine[] = HELP_LINES.map((text, i) => ({ text: clipEllipsis(text, width), kind: i === 0 ? 'title' : 'body' }));
  return {
    tabs,
    rows: [{ id: 'help', type: 'help', selected: false, expanded: false, lines, screenRow: 0 }],
    ...footerFor(ui, visibleTabs(agents, github).length, width),
    notice: noticeFor(ui, width),
    strip: githubStrip(github, width),
    banner,
    projectName,
    bodyTop,
    scroll: clampScroll(ui.help?.scroll ?? 0, lines.length, maxBodyLines),
  };
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
    ...footerFor(ui, visibleTabs(agents, github).length, width),
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
  // every entry of the one ordered list, in draw order (roster, settings, then the read-only rows)
  for (const { row: sr } of view.entries) {
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
    ...footerFor(ui, visibleTabs(agents, github).length, width),
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

export function buildDashboardState(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false, knowledge?: MountedStores, roster?: AgentRosterSnapshot, agents?: AgentsTab, height = Infinity, github?: GithubSnapshot, agentsLines = 0): DashboardState {
  return buildDashboardFrame(store, ui, width, maxBodyLines, projectName, showBanner, knowledge, roster, agents, height, github, agentsLines).state;
}

export function buildDashboardFrame(store: SterlingStore, ui: UiState, width = Infinity, maxBodyLines = Infinity, projectName = '', showBanner = false, knowledge?: MountedStores, roster?: AgentRosterSnapshot, agents?: AgentsTab, height = Infinity, github?: GithubSnapshot, agentsLines = 0): DashboardFrame {
  // the pane height picks the compact scene under COMPACT_BELOW_HEIGHT rows;
  // the host passes the same height to visibleBodyLines, so draw and clicks agree
  const banner = bannerLines(width, showBanner, height);
  const bodyTop = banner.length + CHROME_BELOW_BANNER;
  // Computed ONCE here and threaded into every projection, so the Tasks count
  // and the widths the hit-test measures can never come from two places.
  const tabs = fitTabs(tabsFor(store, ui.tab, agents, github), width);
  // the key help overlay covers the body of whichever tab is open
  if (ui.help) return { ui, state: helpDashboardState(ui, width, banner, projectName, bodyTop, tabs, maxBodyLines, agents, github), nodes: [], cursor: ui.cursor };
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
    // (maxBodyLines = Infinity, e.g. tests) yields maxScroll 0 → scroll 0.
    // The Agents tab has no rows: the host's card block height bounds it.
    scroll = clampScroll(ui.scroll ?? 0, ui.tab === AGENTS_TAB ? agentsLines : totalBodyLines, maxBodyLines);
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
    ...footerFor(ui, visibleTabs(agents, github).length, width),
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
  // a pending `q` confirmation lasts one event: only a second `q` uses it
  const start = ui.quitConfirm && !(event.kind === 'char' && event.ch === 'q') ? withoutQuitConfirm(ui) : ui;
  if (start.help) return reduceHelp(start, event, viewport);
  const nodes = drawn ? drawn.nodes : nodesFor(store, start, knowledge);
  const cursor = drawn ? drawn.cursor : start.tab === SYSTEM_TAB ? start.cursor : resolveCursor(start, nodes);
  const base = cursor === start.cursor ? start : { ...start, cursor };
  const out = reduceNodes(store, base, event, viewport, knowledge, roster, resolveHeadSha, nodes, drawn);
  // a no-op event hands back the caller's own UiState, so its frame stays current
  if (out.ui === base) return { ui: start, effects: out.effects };
  return { ui: holdSelection(base, out.ui, nodes), effects: out.effects };
}

/** Drop the `q` confirmation, and its prompt when that is the notice showing. */
function withoutQuitConfirm(ui: UiState): UiState {
  const { quitConfirm: _armed, ...rest } = ui;
  if (rest.notice !== QUIT_PROMPT) return rest;
  const { notice: _prompt, ...clean } = rest;
  return clean;
}

/** The help overlay owns input while open: the scroll keys and the wheel
 *  scroll it, Ctrl-C quits, and every other key, char or click closes it
 *  without acting on the tab below. */
function reduceHelp(ui: UiState, event: UiEvent, viewport: Viewport): { ui: UiState; effects: Effect[] } {
  const window = viewport.maxBodyLines ?? Infinity;
  const at = ui.help?.scroll ?? 0;
  const scrollTo = (n: number): { ui: UiState; effects: Effect[] } => {
    const scroll = clampScroll(n, HELP_LINES.length, window);
    return { ui: scroll === at ? ui : { ...ui, help: { scroll } }, effects: [] };
  };
  const page = Number.isFinite(window) ? Math.max(1, window - 1) : HELP_LINES.length;
  if (event.kind === 'wheel') return scrollTo(at + (event.dy > 0 ? 3 : -3));
  if (event.kind === 'key') {
    switch (event.name) {
      case 'QUIT':
        return { ui, effects: [{ type: 'quit' }] };
      case 'UP':
        return scrollTo(at - 1);
      case 'DOWN':
        return scrollTo(at + 1);
      case 'PAGE_UP':
        return scrollTo(at - page);
      case 'PAGE_DOWN':
        return scrollTo(at + page);
      case 'HOME':
        return scrollTo(0);
      case 'END':
        return scrollTo(HELP_LINES.length);
    }
  }
  const { help: _closed, ...rest } = ui;
  return { ui: rest, effects: [] };
}

/** The row a page key moves to from row `from`: the last row starting at most
 *  a page below it (PgDn) or the first row starting at most a page above it
 *  (PgUp), always at least one row on. A page is the window less one line, so
 *  one line of context stays; an unbounded window jumps to the end. */
function pageTarget(rows: readonly Row[], from: number, dir: 1 | -1, window: number): number {
  if (!rows.length) return 0;
  const at = Math.max(0, Math.min(from, rows.length - 1));
  const step = Number.isFinite(window) ? Math.max(1, window - 1) : Infinity;
  const target = rows[at]!.screenRow + dir * step;
  let i = at;
  if (dir > 0) while (i + 1 < rows.length && rows[i + 1]!.screenRow <= target) i++;
  else while (i - 1 >= 0 && rows[i - 1]!.screenRow >= target) i--;
  return i === at ? Math.max(0, Math.min(at + dir, rows.length - 1)) : i;
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
  const switchTab = (index: number): UiState => ({ ...ui, tab: index, cursor: 0, scroll: 0, historyScroll: undefined, selector: undefined, notice: undefined, overpassProviderEdit: undefined, boardEdit: undefined, adoptConfirm: undefined });

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
    // On the System tab the row under the cursor is found by the id of the cursor's entry.
    const sysCursorId = ui.tab === SYSTEM_TAB && roster ? cursorEntries(roster, ui)[cursor]?.id : undefined;
    const bannerOffset = ui.tab === SYSTEM_TAB ? st.rows.filter((r) => r.type === 'system-banner').length : 0;
    const row = ui.tab === SYSTEM_TAB ? st.rows.find((r) => r.id === sysCursorId) : st.rows[cursor + bannerOffset];
    if (row) {
      const top = row.screenRow;
      const bottom = row.screenRow + row.lines.length;
      if (top < scroll) scroll = top; // selection above the window → scroll up to its top
      else if (bottom > scroll + window) scroll = Math.min(top, bottom - window); // below → reveal it
    }
    return { ...ui, cursor, scroll: Math.max(0, Math.min(scroll, max)) };
  };
  const moveCursor = (delta: number): UiState => revealAt(clamp(ui.cursor + delta));

  /** The open picker's lines (group headers included) and how many of them are options. */
  const pickerOptions = (sel: NonNullable<UiState['selector']>): number => pickerCount(roster!, sel);

  /** The open System picker with its highlight scrolled into view: the
   *  highlighted option line, and the row's title too when both fit. */
  const revealPicker = (next: UiState): UiState => {
    const sel = next.selector;
    if (!sel || !roster || !Number.isFinite(maxBodyLines)) return next;
    const st = buildSelf(next);
    const row = st.rows.find((r) => r.id === `sys:${sel.key}`);
    if (!row) return next;
    const specs = pickerSpecs(roster, sel);
    const line = row.screenRow + row.lines.length - specs.length + Math.max(0, specs.findIndex((x) => x.option === sel.highlight));
    let scroll = st.scroll;
    if (line < scroll) scroll = line + 1 - row.screenRow <= maxBodyLines ? row.screenRow : line;
    else if (line + 1 > scroll + maxBodyLines) scroll = line + 1 - maxBodyLines;
    const total = st.rows.length ? st.rows[st.rows.length - 1]!.screenRow + st.rows[st.rows.length - 1]!.lines.length : 0;
    return { ...next, scroll: clampScroll(scroll, total, maxBodyLines) };
  };

  /** The tabs with nothing to select (GitHub, Agents): the keys scroll the
   *  body by lines instead. Returns undefined on every other tab. */
  const scrollOnly = (name: string): UiState | undefined => {
    const github = ui.tab === GITHUB_TAB && viewport.github !== undefined;
    if (!github && ui.tab !== AGENTS_TAB) return undefined;
    const total = github ? ((drawn ? drawn.state : buildSelf(ui)).rows[0]?.lines.length ?? 0) : viewport.agentsLines ?? 0;
    // from the offset on screen: a stored one past a block that has since shrunk is clamped first
    const at = clampScroll(ui.scroll ?? 0, total, maxBodyLines);
    const page = Number.isFinite(maxBodyLines) ? Math.max(1, maxBodyLines - 1) : total;
    const to = name === 'UP' ? at - 1 : name === 'DOWN' ? at + 1 : name === 'PAGE_UP' ? at - page : name === 'PAGE_DOWN' ? at + page : name === 'HOME' ? 0 : total;
    const scroll = clampScroll(to, total, maxBodyLines);
    return scroll === (ui.scroll ?? 0) ? ui : { ...ui, scroll };
  };

  /** A click on the System tab does what the keyboard does: on a row it moves
   *  the cursor there and presses ENTER; on an open picker's option it
   *  highlights that option and presses ENTER. The catalog banner, the
   *  read-only storage row, the picker's own title and a click while the
   *  model field is being typed do nothing. */
  const clickSystem = (state: DashboardState, index: number, line1: number): { ui: UiState; effects: Effect[] } => {
    const row = state.rows[index]!;
    // a read-only row (storage, custom agents) holds no cursor index, so a click on it does nothing
    const clickable = roster ? cursorEntries(roster, ui) : [];
    // an open adoption confirm belongs to its own row: a click anywhere else only closes it
    if (ui.adoptConfirm) {
      const confirmRow = clickable.find((e) => e.action?.kind === 'adopt' && e.action.id === ui.adoptConfirm!.id)?.id;
      if (row.id !== confirmRow) return { ui: { ...ui, adoptConfirm: undefined }, effects };
    }
    if (row.type !== 'system' || !clickable.some((e) => e.id === row.id) || ui.overpassProviderEdit !== undefined || !roster) return { ui, effects };
    const enter: UiEvent = { kind: 'key', name: 'ENTER' };
    const sel = ui.selector;
    if (sel) {
      const specs = pickerSpecs(roster, sel);
      const at = line1 - 1 - state.bodyTop + state.scroll - row.screenRow - (row.lines.length - specs.length);
      const k = specs[at]?.option;
      if (row.id !== `sys:${sel.key}` || k === undefined) return { ui, effects };
      return reduceNodes(store, { ...ui, selector: { ...sel, highlight: k } }, enter, viewport, knowledge, roster, resolveHeadSha, nodes, drawn);
    }
    const cursor = clickable.findIndex((e) => e.id === row.id);
    return reduceNodes(store, { ...ui, cursor }, enter, viewport, knowledge, roster, resolveHeadSha, nodes, drawn);
  };

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
      // Ctrl-C quits the same way on every tab and in every mode, an open
      // editor or picker included (the held writes still flush first)
      if (event.name === 'QUIT') {
        effects.push({ type: 'quit' });
        return { ui, effects };
      }
      // F1 opens the key help from anywhere; an open editor keeps its buffer
      if (event.name === 'HELP') return { ui: { ...ui, help: { scroll: 0 } }, effects };
      // Tasks tab board-item edit (user-ruled 2026-09-28, board f25e5547 lane
      // J): while ui.boardEdit is open, ENTER commits, BACKSPACE deletes, and
      // ESCAPE cancels — every other named key is swallowed (no cursor
      // movement; Ctrl-C and F1 were handled above) so the editor owns input the same way the System
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
        // The cursor addresses the cursorable entries of the one ordered list buildSystemTab draws
        // (systemEntries), so draw, cursor and clamp cannot drift apart.
        const sysEntries = cursorEntries(roster, ui);
        const sysClamp = (c: number) => Math.max(0, Math.min(c, Math.max(0, sysEntries.length - 1)));
        const sel = ui.selector;
        const providerEditing = ui.overpassProviderEdit !== undefined;
        const editing = providerEditing;
        switch (event.name) {
          case 'UP':
          case 'DOWN':
          case 'PAGE_UP':
          case 'PAGE_DOWN':
          case 'HOME':
          case 'END': {
            const name = event.name;
            if (sel) {
              // the picker's highlight moves and the body scrolls to keep it on screen
              const n = pickerOptions(sel);
              const page = Number.isFinite(maxBodyLines) ? Math.max(1, maxBodyLines - 1) : n;
              const to = name === 'UP' ? sel.highlight - 1 : name === 'DOWN' ? sel.highlight + 1 : name === 'PAGE_UP' ? sel.highlight - page : name === 'PAGE_DOWN' ? sel.highlight + page : name === 'HOME' ? 0 : n - 1;
              return { ui: revealPicker({ ...ui, selector: { ...sel, highlight: Math.max(0, Math.min(to, n - 1)) } }), effects };
            }
            if (editing) return { ui, effects }; // navigation keys are no-ops while typing the model field
            // moving the cursor closes an open adoption confirm
            const dropConfirm = (u: UiState): UiState => (u.adoptConfirm ? { ...u, adoptConfirm: undefined } : u);
            if (name === 'UP' || name === 'DOWN') return { ui: dropConfirm(revealAt(sysClamp(ui.cursor + (name === 'UP' ? -1 : 1)))), effects };
            if (name === 'HOME' || name === 'END') return { ui: dropConfirm(revealAt(sysClamp(name === 'HOME' ? 0 : Infinity))), effects };
            // a page: over the cursorable rows (the catalog banner and the read-only rows hold no cursor)
            const cursorIds = new Set(sysEntries.map((e) => e.id));
            const selectable = buildSelf(ui).rows.filter((r) => r.type === 'system' && cursorIds.has(r.id));
            return { ui: dropConfirm(revealAt(sysClamp(pageTarget(selectable, ui.cursor, name === 'PAGE_UP' ? -1 : 1, maxBodyLines)))), effects };
          }
          case 'ESCAPE':
            if (ui.adoptConfirm) return { ui: { ...ui, adoptConfirm: undefined }, effects };
            if (sel) return { ui: { ...ui, selector: undefined }, effects };
            if (providerEditing) return { ui: { ...ui, overpassProviderEdit: undefined, notice: undefined }, effects };
            return { ui, effects };
          case 'BACKSPACE':
            if (providerEditing) return { ui: { ...ui, overpassProviderEdit: (ui.overpassProviderEdit ?? '').slice(0, -1) }, effects };
            return { ui, effects };
          case 'ENTER':
          case 'SPACE': {
            const cursor = sysClamp(ui.cursor);
            if (providerEditing) {
              // commit the provider id: only a valid id is written; an invalid one
              // is refused in view and the buffer stays open to be corrected
              const provider = (ui.overpassProviderEdit ?? '').trim();
              if (!OVERPASS_PROVIDER_RE.test(provider)) {
                return { ui: { ...ui, notice: `Overpass provider refused: '${provider}' is not a provider id — use letters, digits, '-', '_' and '.', with no '/' or '#'` }, effects };
              }
              effects.push({ type: 'overpass_provider', provider });
              return { ui: { ...ui, overpassProviderEdit: undefined, notice: undefined }, effects };
            }
            const entry = sysEntries[cursor];
            if (ui.adoptConfirm) {
              // the confirm is open: ENTER on the adoption row it was opened from runs an ok plan (a refused
              // one just closes); ENTER anywhere else only closes it
              const onRow = entry?.action?.kind === 'adopt' && entry.action.id === ui.adoptConfirm.id;
              if (onRow && ui.adoptConfirm.ok) effects.push({ type: 'adopt_run', id: ui.adoptConfirm.id });
              return { ui: { ...ui, adoptConfirm: undefined, notice: undefined }, effects };
            }
            if (entry?.action?.kind === 'adopt') {
              effects.push({ type: 'adopt_plan', id: entry.action.id });
              return { ui: { ...ui, cursor, notice: undefined }, effects };
            }
            if (entry?.action && entry.action.kind !== 'agent') {
              // a setting: an immediate flip (effect) or the opening of a text field (uiPatch), all data from the entry
              if (entry.action.kind === 'toggle') effects.push(entry.action.effect);
              return { ui: { ...ui, cursor, notice: undefined, ...(entry.action.kind === 'edit' ? entry.action.uiPatch : {}) }, effects };
            }
            const key = entry?.action?.kind === 'agent' ? entry.action.key : undefined;
            if (!key) return { ui, effects };
            if (!sel) {
              // step 1: open the model picker on the key under the cursor, the highlight on its current model
              const open: SystemSelector = { key, stage: 'model', highlight: 0 };
              const current = roster.models[key]?.model;
              const at = pickerSpecs(roster, open).find((x) => x.option !== undefined && x.text.split(/\s/)[0] === current)?.option;
              return { ui: revealPicker({ ...ui, cursor, selector: { ...open, highlight: at ?? 0 }, notice: undefined }), effects };
            }
            const specs = pickerSpecs(roster, sel).filter((x) => x.option !== undefined);
            if (sel.stage === 'model') {
              const choice = modelChoices(roster, sel.key)[sel.highlight]?.choice;
              if (!choice) return { ui: { ...ui, selector: undefined }, effects };
              if ('inherit' in choice) {
                // an adopted custom agent drops its model and effort: the host's own default
                effects.push({ type: 'agent_model', key: sel.key, model: null });
                return { ui: { ...ui, selector: undefined, notice: undefined }, effects };
              }
              // step 2: the effort or variant of the chosen model
              const held = roster.models[sel.key];
              const options = effortOptions(choice.ref);
              const at = held?.model === choice.ref && held.effort !== undefined ? options.indexOf(held.effort) : -1;
              return { ui: revealPicker({ ...ui, selector: { key: sel.key, stage: 'effort', highlight: Math.max(0, at), model: choice.ref } }), effects };
            }
            // step 2 → commit the model and its effort ('unset' writes none)
            const efforts = effortOptions(sel.model);
            const effort = efforts[sel.highlight] ?? efforts[0];
            if (sel.model === undefined || specs.length === 0) return { ui: { ...ui, selector: undefined }, effects };
            effects.push({ type: 'agent_model', key: sel.key, model: sel.model, ...(effort === 'unset' ? {} : { effort }) });
            return { ui: { ...ui, selector: undefined, notice: undefined }, effects };
          }
        }
      }
      switch (event.name) {
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
          // the GitHub and Agents tabs have nothing to select: the arrows scroll their lines
          const scrolled = scrollOnly(event.name);
          if (scrolled) return { ui: scrolled, effects };
          return { ui: moveCursor(event.name === 'UP' ? -1 : 1), effects };
        }
        case 'PAGE_UP':
        case 'PAGE_DOWN':
        case 'HOME':
        case 'END': {
          const scrolled = scrollOnly(event.name);
          if (scrolled) return { ui: scrolled, effects };
          if (event.name === 'HOME') return { ui: revealAt(0), effects };
          if (event.name === 'END') return { ui: revealAt(clamp(nodes.length - 1)), effects };
          // a page of the list on screen; on the Queue tab, of the pending window
          const st = drawn ? drawn.state : buildSelf(ui);
          return { ui: revealAt(clamp(pageTarget(st.rows, ui.cursor, event.name === 'PAGE_UP' ? -1 : 1, bodyWindow(st, maxBodyLines)))), effects };
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
      // the Overpass provider row's edit buffer takes the same always-capture path
      if (ui.tab === SYSTEM_TAB && ui.overpassProviderEdit !== undefined) {
        return { ui: { ...ui, overpassProviderEdit: ui.overpassProviderEdit + ch }, effects };
      }
      // Tasks tab board-item edit: same always-capture idiom as the two edit
      // buffers above — every printable key ('e' included) feeds the buffer
      // while it is open, so typing the letter 'e' into an edit never
      // re-triggers the open-editor hotkey below.
      if (ui.tab === TASKS_TAB && ui.boardEdit) {
        return { ui: { ...ui, boardEdit: { ...ui.boardEdit, text: ui.boardEdit.text + ch } }, effects };
      }
      // '?' opens the key help; on Knowledge it is search text like every
      // printable key, and F1 opens the help there
      if (ch === '?' && ui.tab !== KNOWLEDGE_TAB) return { ui: { ...ui, help: { scroll: 0 } }, effects };
      // the Knowledge tab is an always-visible search field: EVERY printable key
      // feeds the query — 'q' and digits included (they are not hotkeys here).
      if (ui.tab === KNOWLEDGE_TAB) {
        return { ui: { ...ui, searchQuery: ui.searchQuery + ch, cursor: 0, scroll: 0 }, effects };
      }
      // q asks first: the notice says so, a second q quits and any other
      // event clears the question (reduce()). Ctrl-C quits at once.
      if (ch === 'q') {
        if (ui.quitConfirm) {
          effects.push({ type: 'quit' });
          return { ui, effects };
        }
        return { ui: { ...ui, quitConfirm: true, notice: QUIT_PROMPT }, effects };
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
      // the Agents tab draws the host's card block, not rows
      const total = ui.tab === AGENTS_TAB ? viewport.agentsLines ?? 0 : rows.length ? rows[rows.length - 1].screenRow + rows[rows.length - 1].lines.length : 0;
      const max = Number.isFinite(maxBodyLines) ? Math.max(0, total - bodyWindow(st, maxBodyLines)) : 0;
      // from the offset on screen, clamped, so the first turn after the content shrank moves it
      const at = Math.min(ui.scroll ?? 0, max);
      return { ui: { ...ui, scroll: Math.max(0, Math.min(at + step, max)) }, effects };
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
      if (row !== -1 && ui.tab === SYSTEM_TAB) return roster ? clickSystem(state, row, event.y) : { ui, effects };
      if (row !== -1) return { ui: activate(row), effects };
      return { ui, effects };
    }
    case 'rightclick':
      // collapse everything — the quick "back to overview" gesture
      return { ui: { ...ui, expanded: [], scroll: 0, historyScroll: undefined, adoptConfirm: undefined }, effects };
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
