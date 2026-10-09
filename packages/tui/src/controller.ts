// The dashboard controller: the store and config code paths behind the
// dashboard, independent of the surface that draws it. The terminal TUI
// (main.ts) and the OpenCode plugin (packages/opencode-plugin/src/tui.tsx)
// both drive it, so a board edit or a config toggle runs the same code in
// either host. Nothing here touches a terminal.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MountedStores, SterlingStore, resolveDomainMounts, catalogStatus, type DomainMount } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { parseConfig, AGENT_MODEL_KEY, OPENCODE_MODEL_REF_RE } from '@sterling/schemas';
import { buildDashboardFrame, initialUi, reduce, runEffects, SYSTEM_TAB, type DashboardFrame, type BoardEditEffect, type SelectEffect, type UiState, type UiEvent, type Effect, type DashboardState, type Viewport, type AgentRosterSnapshot, type RosterAgent, type CatalogStatusView, type ModelSwapEffect, type OpenCodeModelEffect, type SparringToggleEffect, type SparringModelEffect, type TddToggleEffect, type ModeToggleEffect, type HandoffToggleEffect } from './state.js';
import { applyHandoffToggle, applyModeToggle, applySparringToggle, applyTddToggle } from './config-writeback.js';
import { openDataVersionProbe, type DataVersionProbe } from './data-version.js';
// Static, so esbuild inlines both into the bundles: an installed copy has no
// node_modules and no packages/*/dist, so a run-time import of the scripts/lib
// SOURCE (which imports @sterling/schemas) cannot load there.
import { parseInstalledHeader, setInstalledModelEffort } from '../../../scripts/lib/agent-distribution.mjs';
import { userScopeCodexServer } from '../../../scripts/lib/codex-mcp.mjs';
import { handoffSettingOf, HandoffGitError, HandoffSettingError } from '../../../scripts/lib/handoff-projection.mjs';
import { sterlingRootFrom, swapFullAgentModel, stageFullAgentModel, writeFileAtomic, writeFullAgentFiles, restoreFullAgentFiles, type AtomicWriteFs, type StagedWrite } from '../../../scripts/lib/opencode-install.mjs';
import { storeBackend } from '../../../scripts/hooks/lib/store-backend.mjs';
import { writeSelectionFile } from '../../../scripts/hooks/lib/selection-file.mjs';

/** Effect types a host may decline to execute. A string value is the notice
 *  shown when the effect is dropped; null drops it without a notice (for an
 *  effect that fires on every card activation, where a notice would be noise
 *  and the host labels the state instead). */
export type DisableableEffect = 'model_swap' | 'opencode_model' | 'select';

export interface DashboardOptions {
  disabledEffects?: Partial<Record<DisableableEffect, string | null>>;
  /** Hold store writes (the selection, a board edit) until the host calls
   *  flush(), so they run after the frame is drawn. Default false: handle()
   *  runs them before it returns. */
  deferWrites?: boolean;
  /** Count the project store's method calls for stats() (STERLING_TUI_PROFILE). */
  profile?: boolean;
  /** Replaces the data_version probe; tests use it to make a read fail. */
  dataVersionProbe?: (paths: string[]) => DataVersionProbe;
  /** the `r` key (a github_refresh effect): the host's GitHub poller polls now */
  onGithubRefresh?: () => void;
  /** The file operations the OpenCode-override config.json write uses; tests
   *  use it to make that write fail part-way. */
  configWriteFs?: AtomicWriteFs;
}

/** How long the held selection and board-edit writes wait for another
 *  connection's write lock before giving up (SQLite's busy timeout; the
 *  store's default is 5000 ms). Short, because they run on the terminal's
 *  event loop. Only their own connection (writeStore) uses it. With
 *  deferWrites a write that times out stays queued for the next flush. */
export const DASHBOARD_BUSY_TIMEOUT_MS = 250;

/** Counters for the profile log; cumulative since openDashboard. */
export interface DashboardStats {
  /** dashboard frames built from the store */
  builds: number;
  /** project-store method calls, internal ones included; 0 unless options.profile */
  storeCalls: number;
  /** how the state cache detects store changes: 'data_version', or why it cannot (it then rebuilds on every call) */
  changeDetection: string;
}

/** The viewport a host passes: every field is required except the optional
 *  Agents tab, the pane height (a host without the banner has no use for it)
 *  and the GitHub snapshot (a host without a GitHub poller). */
export type ControllerViewport = Required<Omit<Viewport, 'agents' | 'height' | 'github'>> & Pick<Viewport, 'agents' | 'height' | 'github'>;

export interface DashboardController {
  readonly stores: MountedStores;
  readonly store: SterlingStore;
  /** the connection the held selection and board-edit writes run on, with
   *  DASHBOARD_BUSY_TIMEOUT_MS (the same handle as `store` on Postgres storage) */
  readonly writeStore: SterlingStore;
  /** the project's folder name, plus a loud suffix when domains could not load */
  readonly projectName: string;
  readonly configPath: string;
  ui(): UiState;
  roster(): AgentRosterSnapshot | undefined;
  state(vp: ControllerViewport): DashboardState;
  /** reduce one event and execute its effects; true when the event asked to quit */
  handle(event: UiEvent, vp: ControllerViewport): Promise<boolean>;
  /** execute effects (the impure seam); true when one of them is a quit */
  applyEffects(effects: Effect[]): Promise<boolean>;
  /** run the held store writes; a failure becomes ui.notice, never a throw.
   *  A write that met a busy lock stays queued for the next flush.
   *  True when a write failed, so the host redraws to show the notice. */
  flush(): boolean;
  /** how many store writes are still queued */
  pending(): number;
  /** Run the held writes before a quit. True when the host may exit: every
   *  write was saved, or the user already saw the failure and asked again.
   *  False holds the quit once and says why in ui.notice; the next quit
   *  discards, any other event disarms. */
  requestQuit(): boolean;
  stats(): DashboardStats;
  close(): void;
}

export function openDashboard(storePath: string, options: DashboardOptions = {}): DashboardController {
  const disabled = options.disabledEffects ?? {};
  // The store lives at <project>/.sterling/sterling.db, so the config sits
  // beside it and the installed agents under <project>/.claude/agents/.
  const configPath = join(dirname(storePath), 'config.json');
  // Also the root the board_edit HEAD restamp resolves against: state.ts's own
  // default resolver falls back to process.cwd(), which is only correct when
  // the dashboard happens to be launched from the project directory.
  const projectRoot = dirname(dirname(storePath));
  const agentsDir = join(projectRoot, '.claude', 'agents');

  /** `git rev-parse HEAD` rooted at the project that owns THIS store. Never
   *  throws; undefined on any failure, so a missing git binary or a non-repo
   *  project degrades to a notice, not a crash. */
  function resolveProjectHeadSha(): string | undefined {
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  // Postgres storage (scripts/hooks/lib/store-backend.mjs says 'routed'): the
  // project and every mounted domain open through @sterling/store/routing.
  // Nothing is skipped or created, and any failure (an unreachable server,
  // missing credentials or identity, a missing domain) throws its named error
  // out of openDashboard; the host reports it. `storePath` then only names the
  // project: <root>/.sterling/sterling.db need not exist.
  const routed = storeBackend(projectRoot) === 'routed';
  // Open the project store PLUS its mounted domain stores so the Knowledge tab
  // can fan across them. skipMissing → a domain whose db does not yet exist is
  // skipped, never created. Any failure to read/parse the config DEGRADES
  // LOUD: project-only + a header indicator, never a crash.
  let mounts: DomainMount[] = [];
  let domainsAvailable = true;
  if (!routed) {
    try {
      const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
      mounts = resolveDomainMounts(config);
    } catch {
      mounts = [];
      domainsAvailable = false;
    }
  }
  const stores = routed ? openRoutedStores(projectRoot, { mount: true }).stores : new MountedStores(storePath, mounts, { skipMissing: true });
  const store = stores.project;
  // The held writes get their own connection with the short busy timeout.
  // Every other connection keeps the store's default, so opening the store,
  // the catalog bootstrap and a model swap's decision record still wait out
  // an ordinary MCP write lock instead of failing after 250 ms.
  let writeStore: SterlingStore;
  try {
    writeStore = routed ? store : new SterlingStore(storePath, { busyTimeoutMs: DASHBOARD_BUSY_TIMEOUT_MS });
  } catch (err) {
    stores.close();
    throw err;
  }
  const projectName = basename(projectRoot) + (domainsAvailable ? '' : ' — domains unavailable (project-only)');
  let ui: UiState = initialUi;

  // The state cache (GitHub #35): the last built frame is reused until the
  // UiState, the roster, the viewport, the day (today's queue log stamps drop
  // the date) or a store's PRAGMA data_version moves, so the 1 Hz redraw over
  // an unchanged store reads nothing. Postgres storage has no data_version:
  // there every call rebuilds, as before, and stats() says so.
  let probe: DataVersionProbe | undefined;
  let changeDetection = 'data_version';
  let degradeSaid = false;
  /** Change detection failed: rebuild on every call (correct, only slower),
   *  record why in stats(), and say it once on screen. */
  function degrade(reason: string): void {
    changeDetection = `degraded: ${reason}`;
    if (degradeSaid) return;
    degradeSaid = true;
    ui = { ...ui, notice: `change detection degraded: ${reason}; the dashboard rebuilds on every redraw` };
  }
  if (routed) changeDetection = 'none: Postgres storage has no data_version';
  else {
    try {
      probe = (options.dataVersionProbe ?? openDataVersionProbe)([storePath, ...mounts.map((m) => m.dbPath)]);
    } catch (err) {
      degrade(`data_version probe failed to open — ${(err as Error).message}`);
    }
  }
  let frame: { vp: string; viewport: ControllerViewport; day: string; ui: UiState; roster: AgentRosterSnapshot | undefined; dataVersion: string | undefined; built: DashboardFrame } | undefined;
  let builds = 0;
  // the GitHub snapshot's version moves only when its content does, so an unchanged poll rebuilds nothing
  const vpKey = (vp: ControllerViewport): string => JSON.stringify([vp.width, vp.maxBodyLines, vp.showBanner, vp.agents ? vp.agents.running : null, vp.height ?? null, vp.github ? vp.github.version : null]);
  const today = (): string => new Date().toDateString();
  function currentFrame(vp: ControllerViewport): DashboardFrame {
    let dataVersion: string | undefined;
    if (probe) {
      try {
        dataVersion = probe.read();
      } catch (err) {
        degrade(`data_version read failed — ${(err as Error).message}`);
      }
    }
    const key = vpKey(vp);
    const day = today();
    if (frame && dataVersion !== undefined && frame.dataVersion === dataVersion && frame.ui === ui && frame.roster === roster && frame.vp === key && frame.day === day) return frame.built;
    builds++;
    const built = buildDashboardFrame(store, ui, vp.width, vp.maxBodyLines, projectName, vp.showBanner, stores, roster, vp.agents, vp.height, vp.github);
    frame = { vp: key, viewport: vp, day, ui, roster, dataVersion, built };
    return built;
  }

  // Profile counters: every project-store method call (both connections),
  // wrapped on these instances only when the host asks (STERLING_TUI_PROFILE).
  let storeCalls = 0;
  const countCalls = (target: SterlingStore): void => {
    const proto = Object.getPrototypeOf(target) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = Object.getOwnPropertyDescriptor(proto, name)?.value as unknown;
      if (name === 'constructor' || typeof fn !== 'function') continue;
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          storeCalls++;
          return (fn as (...a: unknown[]) => unknown).apply(target, args);
        },
      });
    }
  };
  if (options.profile) {
    countCalls(store);
    if (writeStore !== store) countCalls(writeStore);
  }

  // Store writes wait here until flush(). A click's selection write used to
  // run on the input path, before the redraw, through SQLite's 5000 ms busy
  // timeout, and an exhausted timeout reached the TUI's fatal handler. Only
  // the latest selection is kept: a burst of clicks ends in one write.
  // A write that meets another connection's lock gives up after
  // DASHBOARD_BUSY_TIMEOUT_MS. With deferWrites it stays queued, the host
  // retries it (main.ts does on each tick) and the notice it sets is cleared
  // once the retry succeeds. Without deferWrites no host flushes again (the
  // OpenCode dashboard), so it is dropped with a notice like any other failure.
  let pending: (SelectEffect | BoardEditEffect)[] = [];
  let retryNotice: string | undefined;
  const isBusy = (err: unknown): boolean => {
    const code = (err as { errcode?: unknown } | null)?.errcode;
    return code === 5 || code === 6 || /database is (locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test((err as Error | null)?.message ?? '');
  };
  function flush(): boolean {
    if (!pending.length) return false;
    const batch = pending;
    pending = [];
    let failed = false;
    for (const e of batch) {
      try {
        // Postgres storage keeps the selection slot local to this checkout and
        // host (decision postgres-store-backend-design-sync-bridge-schema-per-store,
        // point 9): the shared store's selection row would hand it to another machine's prompt.
        if (e.type === 'select' && routed) writeSelectionFile(projectRoot, e.recordType, e.id, new Date().toISOString());
        else runEffects(writeStore, [e]);
      } catch (err) {
        failed = true;
        const msg = (err as Error).message;
        if (isBusy(err) && options.deferWrites) {
          pending.push(e);
          retryNotice = `${e.type === 'select' ? 'selection' : 'board edit'} not saved yet: the store is busy (${msg}); retrying`;
          ui = { ...ui, notice: retryNotice };
        } else {
          ui = { ...ui, notice: e.type === 'select' ? `selection not handed to the next prompt — ${msg}` : `board edit not saved — ${msg}` };
        }
      }
    }
    if (!failed && retryNotice !== undefined) {
      if (ui.notice === retryNotice) {
        const { notice: _saved, ...rest } = ui;
        ui = rest;
      }
      retryNotice = undefined;
    }
    return failed;
  }

  let quitArmed = false;
  function requestQuit(): boolean {
    if (quitArmed) return true;
    const failed = flush();
    if (!failed && !pending.length) return true;
    quitArmed = true;
    const notice = `${ui.notice ?? 'writes not saved'} — press q again to quit and discard them`;
    ui = { ...ui, notice };
    if (pending.length) retryNotice = notice;
    return false;
  }

  // System tab: the agent roster snapshot, read ON TAB ACTIVATION only (never
  // the redraw loop, per decision foreign_98064d77 — perf). Undefined until the
  // tab is first activated; recomputed after a write so drift markers and the
  // new values reflect it.
  let roster: AgentRosterSnapshot | undefined;

  /** Read a governed agent's INSTALLED model:/effort: from its frontmatter (the
   *  copy that governs dispatch). Missing/unparsable → blanks (surfaces as drift). */
  function readInstalledModelEffort(name: string): { model: string; effort: string } {
    try {
      const content = readFileSync(join(agentsDir, `${name}.md`), 'utf8');
      const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
      const block = fm ? fm[1] : '';
      return {
        model: block.match(/^model:\s*(\S+)/m)?.[1] ?? '',
        effort: block.match(/^effort:\s*(\S+)/m)?.[1] ?? '',
      };
    } catch {
      return { model: '', effort: '' };
    }
  }

  // Sparring partner (board a0714d0b): the codex MCP server is registered at
  // USER scope, in <CLAUDE_CONFIG_DIR or home>/.claude.json. init's own check
  // (scripts/lib/codex-mcp.mjs userScopeCodexServer) is the one reader; a
  // missing or unreadable file reads as "not wired" — never a thrown probe that
  // would crash tab activation (P5: the row marker itself is the visible state).
  function probeCodexWired(): boolean {
    return userScopeCodexServer().found;
  }

  /** config.mode as written on disk (decision project-mode-hobby-work-toggle-decides-flow).
   *  Read RAW, not through parseConfig: the schema refuses an invalid mode, and
   *  the row must show that value as INVALID rather than lose it. Absent →
   *  undefined (hobby); an unreadable config → null, which the row shows as
   *  UNKNOWN (never the hobby default) with the read error as a notice. */
  function readRawMode(): string | null | undefined {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { mode?: unknown };
      return raw.mode === undefined ? undefined : typeof raw.mode === 'string' ? raw.mode : JSON.stringify(raw.mode);
    } catch (err) {
      ui = { ...ui, notice: `project mode unknown — config unreadable: ${(err as Error).message}` };
      return null;
    }
  }

  /** config.storage, RAW and read-only (board 6ca1a3c5). Absent → undefined
   *  (SQLite, the routing default); a config that cannot be read, or parses to
   *  something that is not an object, → null (the row shows UNKNOWN, never the
   *  default); any value that is not a string comes back as its JSON text, which
   *  the row shows as UNRECOGNIZED. readRawMode already states the read error. */
  function readRawStorage(): string | null | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const storage = (raw as { storage?: unknown }).storage;
    return storage === undefined ? undefined : typeof storage === 'string' ? storage : JSON.stringify(storage);
  }

  /** The handoff setting (decision
   *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting),
   *  resolved from the RAW config by the same function the writers use, so the
   *  row shows what init and /sterling:update will act on: config.handoff.enabled,
   *  or on when the key is absent and handoff files are tracked in git. `detail`
   *  says why when the key is absent. A value that is not a boolean comes back as
   *  its JSON text, which the row shows as INVALID. null is UNKNOWN: an unreadable
   *  config (no detail; readRawMode states the error), or an absent key with a
   *  git failure (detail is the git error), never the off default. */
  function readHandoff(): { handoff: boolean | string | null; handoffDetail?: string } {
    let raw: { handoff?: unknown } | null;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8')) as { handoff?: unknown } | null;
    } catch {
      return { handoff: null };
    }
    try {
      const setting = handoffSettingOf(raw, projectRoot);
      if (setting.source === 'config') return { handoff: setting.enabled };
      return { handoff: setting.enabled, handoffDetail: setting.source === 'tracked' ? 'not set; handoff files are tracked in git' : 'not set' };
    } catch (err) {
      if (err instanceof HandoffGitError) return { handoff: null, handoffDetail: err.reason };
      if (!(err instanceof HandoffSettingError)) throw err;
      const block = raw?.handoff;
      return { handoff: JSON.stringify(block !== null && typeof block === 'object' && !Array.isArray(block) ? (block as { enabled?: unknown }).enabled : block) };
    }
  }

  /** Build the AgentRosterSnapshot at tab activation: installed frontmatter +
   *  config.models + a bootstrapped catalog with its precomputed status. Enqueues
   *  a deduped refresh when the catalog is stale (decision foreign_98064d77). */
  function loadRoster(): AgentRosterSnapshot {
    const nowISO = new Date().toISOString();
    let config: unknown;
    try {
      config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    } catch {
      config = { models: {}, models_catalog: { staleness_days: 45 } };
    }
    const cfg = config as {
      models?: Record<string, { model: string; effort: string; opencode_model?: string }>;
      models_catalog?: { staleness_days?: number };
      sparring_partner?: { enabled?: boolean; models?: { openai?: { model?: string } } };
      tdd?: { enabled?: boolean };
    };
    const configModels = cfg.models ?? {};
    // parseConfig converts the old sparring_partner.model into models.openai.
    const sparringPartner = { enabled: cfg.sparring_partner?.enabled ?? true, model: cfg.sparring_partner?.models?.openai?.model };
    const tdd = { enabled: cfg.tdd?.enabled ?? true };
    const mode = readRawMode();
    const handoff = readHandoff();
    const codexWired = probeCodexWired();
    const agents: RosterAgent[] = Object.keys(AGENT_MODEL_KEY)
      .filter((name) => existsSync(join(agentsDir, `${name}.md`)))
      .map((name) => {
        const v = readInstalledModelEffort(name);
        return { name, installedModel: v.model, installedEffort: v.effort };
      });

    let catalog: CatalogStatusView = { present: false, stale: false, staleDate: null, entries: [] };
    try {
      store.bootstrapCatalogIfAbsent(config, nowISO);
      const rec = store.query({ types: ['reference_material'], cap: 200 }).find((r) => (r as { catalog?: unknown }).catalog);
      const days = cfg.models_catalog?.staleness_days ?? 45;
      const status = catalogStatus(rec ?? null, nowISO, days);
      if (status.stale) store.enqueueRefreshReferenceOnce(nowISO);
      catalog = {
        present: status.present,
        stale: status.stale,
        staleDate: status.staleDate ? status.staleDate.slice(0, 10) : null,
        entries: ((rec as { catalog?: { entries?: CatalogStatusView['entries'] } })?.catalog?.entries ?? []),
      };
    } catch (err) {
      // a console.error would paint into the host's screen and be lost (audit
      // finding 41/43) — surface it as a visible System-tab notice instead.
      ui = { ...ui, notice: `catalog unavailable — ${(err as Error).message}` };
    }
    return { agents, configModels, catalog, sparringPartner, codexWired, tdd, mode, storage: readRawStorage(), ...handoff };
  }

  /** Execute a sparring_model effect: config.sparring_partner.models.openai
   *  write (the old sparring_partner.model is dropped, so a new key cannot be
   *  shadowed by a stale one). An empty committed value CLEARS the model
   *  (unset = Codex CLI default) by removing the pin; a set keeps the effort. */
  function applySparringModel(e: SparringModelEffect): void {
    try {
      type Pin = { model?: string; effort?: string };
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { sparring_partner?: { enabled?: boolean; model?: string; models?: { openai?: Pin } } };
      const { model: _legacy, ...sp } = { ...raw.sparring_partner };
      const { model: _previous, ...rest } = { ...sp.models?.openai };
      const models = { ...sp.models };
      if (e.model) models.openai = { ...rest, model: e.model };
      else delete models.openai;
      raw.sparring_partner = { ...sp, models };
      writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    } catch (err) {
      ui = { ...ui, notice: `sparring partner model update failed — ${(err as Error).message}` };
    }
  }

  /** Execute a model_swap effect: config.models write (authoritative) →
   *  surgical setInstalledModelEffort on each governed installed file (machine
   *  vars untouched, d53dc92c) → a durable swap decision (AC5). A partial
   *  projection is not silent — it surfaces as the next activation's drift
   *  marker (P5). */
  async function applySwap(e: ModelSwapEffect): Promise<void> {
    const nowISO = new Date().toISOString();
    try {
      // 1. config.models write — the authoritative per-project declaration
      // The entry's other fields (hard_task, the OpenCode override) are kept.
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { models?: Record<string, Record<string, unknown> | undefined> };
      raw.models = raw.models ?? {};
      const prev = raw.models[e.key] ?? {};
      raw.models[e.key] = { ...prev, model: e.to.model, effort: e.to.effort };
      writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
      const opencodeModel = typeof prev.opencode_model === 'string' ? prev.opencode_model : undefined;

      // 2. surgical installed-frontmatter projection on each governed agent file
      for (const name of e.agents) {
        const p = join(agentsDir, `${name}.md`);
        if (!existsSync(p)) continue;
        const content = readFileSync(p, 'utf8');
        const hdr = parseInstalledHeader(content);
        writeFileSync(
          p,
          setInstalledModelEffort(content, {
            model: e.to.model,
            effort: e.to.effort,
            pluginVersion: hdr?.pluginVersion ?? '0.0.0',
            now: nowISO,
          })
        );
      }

      // 2b. the Sterling-full OpenCode conductor and roster, re-rendered with the
      // matching OpenCode model (decision 48903a6f, DASHBOARD FUNCTIONS (a)). A
      // project that never installed them is skipped; a refused file is said.
      // Its own try: an OpenCode failure is reported, and the decision below
      // is still written for the Claude swap that already happened.
      try {
        // A role with an OpenCode override keeps it: only its Claude model changed.
        const oc = swapFullAgentModel({ projectDir: projectRoot, pluginRoot: sterlingRootFrom(), agents: e.agents, model: e.to.model, opencodeModel });
        const refused = (oc.rows ?? []).filter((r) => r.status === 'refused');
        if (refused.length) ui = { ...ui, notice: `model swap for '${e.key}': OpenCode agent file(s) not updated — ${refused.map((r) => r.detail).join('; ')}` };
      } catch (ocErr) {
        ui = { ...ui, notice: `model swap for '${e.key}': config.models and the Claude agents were updated, but the OpenCode agent re-render failed — ${(ocErr as Error).message}` };
      }

      // 3. durable swap decision (AC5) — reuse the decision type (decision foreign_98064d77)
      store.create({
        id: randomUUID(),
        type: 'decision',
        created_at: nowISO,
        updated_at: nowISO,
        author: 'conductor',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        title: e.decisionTitle,
        statement: `config.models['${e.key}'] set to ${e.to.model} / ${e.to.effort} (was ${e.from.model} / ${e.from.effort}); ${e.agents.length} installed agent file(s) re-stamped via the System tab.`,
        rationale:
          'Model/effort pin changed from the TUI System tab (config.models is authoritative; a swap re-stamps the installed frontmatter surgically without crossing the WSL↔Windows machine boundary, d53dc92c).',
        alternatives_rejected: [],
      }, { operation_id: randomUUID() });
    } catch (err) {
      // P5: never silent. The next activation's drift marker still backstops a
      // partial write.
      ui = { ...ui, notice: `model swap for '${e.key}' failed partway — ${(err as Error).message}` };
    }
  }

  /** Execute an opencode_model effect (decision
   *  opencode-only-model-override-per-role-for-openai-picks): set or clear
   *  config.models[key].opencode_model and re-render the key's Sterling-full
   *  OpenCode agents, all or nothing. Every agent render and refusal check runs
   *  first, with nothing written; then the agent files and config.json are
   *  written, and a failure puts every written file back, so config.json stays
   *  byte-identical. The decision is recorded only once both have converged.
   *  The Claude agent files under .claude/agents are never written here. */
  function applyOpenCodeModel(e: OpenCodeModelEffect): void {
    const nowISO = new Date().toISOString();
    const fail = (msg: string) => { ui = { ...ui, notice: `OpenCode model for '${e.key}' not changed — ${msg}; config.json and the OpenCode agents are as they were` }; };
    let configBefore: string;
    let configAfter: string;
    let claudeModel: string;
    try {
      if (e.to !== undefined && !OPENCODE_MODEL_REF_RE.test(e.to)) throw new Error(`'${e.to}' is not a <provider>/<model> id`);
      configBefore = readFileSync(configPath, 'utf8');
      const raw = JSON.parse(configBefore) as { models?: Record<string, Record<string, unknown> | undefined> };
      raw.models = raw.models ?? {};
      // a key the file does not carry yet takes its current (default) Claude values
      const { opencode_model: _previous, ...rest } = raw.models[e.key] ?? { model: e.model, effort: e.effort };
      raw.models[e.key] = e.to === undefined ? rest : { ...rest, opencode_model: e.to };
      configAfter = JSON.stringify(raw, null, 2) + '\n';
      claudeModel = typeof rest.model === 'string' ? rest.model : e.model;
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    // 1. stage: render every target agent; a refusal stops the change before any write
    let writes: StagedWrite[];
    try {
      const staged = stageFullAgentModel({ projectDir: projectRoot, pluginRoot: sterlingRootFrom(), agents: e.agents, model: claudeModel, opencodeModel: e.to });
      const refused = (staged.rows ?? []).filter((r) => r.status === 'refused');
      if (refused.length) {
        fail(`OpenCode agent file(s) refused: ${refused.map((r) => r.detail).join('; ')}`);
        return;
      }
      writes = staged.writes ?? [];
    } catch (err) {
      fail(`the OpenCode agent render failed: ${(err as Error).message}`);
      return;
    }
    // 2. commit: the agent files, then config.json; a failure restores what was written
    try {
      writeFullAgentFiles(writes);
    } catch (err) {
      fail(`writing the OpenCode agents failed: ${(err as Error).message}`);
      return;
    }
    // config.json is replaced atomically (temp file, then rename), so a failed
    // write never leaves it truncated
    try {
      writeFileAtomic(configPath, configAfter, options.configWriteFs);
    } catch (err) {
      // the two restores run independently, so one failing never skips the other
      const rollback: string[] = [];
      try { writeFileAtomic(configPath, configBefore, options.configWriteFs); } catch (restoreErr) { rollback.push(`config.json not restored: ${(restoreErr as Error).message}`); }
      try { restoreFullAgentFiles(writes); } catch (restoreErr) { rollback.push(`OpenCode agents not restored: ${(restoreErr as Error).message}`); }
      if (rollback.length) {
        ui = { ...ui, notice: `OpenCode model for '${e.key}': writing config.json failed (${(err as Error).message}) and the rollback failed — ${rollback.join('; ')}` };
        return;
      }
      fail(`writing config.json failed: ${(err as Error).message}`);
      return;
    }
    // 3. converged: record the change
    const shown = (v?: string) => v ?? `anthropic/${claudeModel}`;
    try {
      store.create({
        id: randomUUID(),
        type: 'decision',
        created_at: nowISO,
        updated_at: nowISO,
        author: 'conductor',
        status: 'active',
        superseded_by: null,
        links: [],
        scope: 'project',
        stack_tags: [],
        title: `OpenCode model: ${e.key} ${shown(e.from)}→${shown(e.to)} (System tab)`,
        statement: `config.models['${e.key}'].opencode_model ${e.to === undefined ? 'cleared' : `set to ${e.to}`} (was ${e.from ?? 'unset'}); the OpenCode agents for this role now run ${shown(e.to)}, and Claude Code keeps ${claudeModel}.`,
        rationale:
          'OpenCode model override changed from the TUI System tab (decision opencode-only-model-override-per-role-for-openai-picks: the Claude model stays for Claude Code, and only the OpenCode agent files are re-rendered).',
        alternatives_rejected: [],
      }, { operation_id: randomUUID() });
    } catch (err) {
      ui = { ...ui, notice: `OpenCode model for '${e.key}' set to ${shown(e.to)}, but recording the decision failed — ${(err as Error).message}` };
      return;
    }
    ui = { ...ui, notice: `OpenCode model for '${e.key}' set to ${shown(e.to)}; Claude Code keeps ${claudeModel}.` };
  }

  async function applyEffects(all: Effect[]): Promise<boolean> {
    // the host's effect switch: a declined effect never reaches its writer
    const effects = all.filter((e) => {
      if (e.type !== 'model_swap' && e.type !== 'opencode_model' && e.type !== 'select') return true;
      const off = disabled[e.type];
      if (off === undefined) return true;
      if (off !== null) ui = { ...ui, notice: off };
      return false;
    });
    const swaps = effects.filter((e): e is ModelSwapEffect => e.type === 'model_swap');
    for (const e of swaps) await applySwap(e);
    const overrides = effects.filter((e): e is OpenCodeModelEffect => e.type === 'opencode_model');
    for (const e of overrides) applyOpenCodeModel(e);
    const notice = (msg: string) => { ui = { ...ui, notice: msg }; };
    const sparringModels = effects.filter((e): e is SparringModelEffect => e.type === 'sparring_model');
    for (const e of sparringModels) applySparringModel(e);
    // sparring/tdd/mode/handoff toggle writes (board a0714d0b, decision foreign_752caf98):
    // run every applier, then compose ONE notice from their {ok} outcomes — a
    // failure wins over a success (review fix, board 09f05fca half 2), so a
    // later success in this same batch can never clobber an earlier failure.
    const sparringToggles = effects.filter((e): e is SparringToggleEffect => e.type === 'sparring_toggle');
    const tddToggles = effects.filter((e): e is TddToggleEffect => e.type === 'tdd_toggle');
    const modeToggles = effects.filter((e): e is ModeToggleEffect => e.type === 'mode_toggle');
    const handoffToggles = effects.filter((e): e is HandoffToggleEffect => e.type === 'handoff_toggle');
    let toggleWrote = false;
    let toggleFailure: string | undefined;
    const collectFailure = (msg: string) => { toggleFailure = msg; };
    for (const e of sparringToggles) { if (applySparringToggle(e, collectFailure, configPath)) toggleWrote = true; }
    for (const e of tddToggles) { if (applyTddToggle(e, collectFailure, configPath)) toggleWrote = true; }
    let modeWritten: ModeToggleEffect['mode'] | undefined;
    for (const e of modeToggles) { if (applyModeToggle(e, collectFailure, configPath)) { toggleWrote = true; modeWritten = e.mode; } }
    let handoffWritten: boolean | undefined;
    for (const e of handoffToggles) { if (applyHandoffToggle(e, collectFailure, configPath)) { toggleWrote = true; handoffWritten = e.enabled; } }
    if (toggleFailure !== undefined) {
      notice(toggleFailure);
    } else if (modeWritten !== undefined) {
      // what the switch changes, said at the moment it is made: only how work ships
      notice(modeWritten === 'work'
        ? 'project mode set to work — /sterling:merge now opens a pull request and the review loop follows; nothing is merged directly.'
        : 'project mode set to hobby — /sterling:merge now merges directly into the base branch.');
    } else if (handoffWritten !== undefined) {
      // what the switch does to the files, said at the moment it is made
      notice(handoffWritten
        ? 'handoff files turned on — run /sterling:update (or init) to write the portable OpenCode agents and the handoff projection; sync-agents refreshes only the portable agents.'
        : 'handoff files turned off — the portable OpenCode agents and the handoff projection are no longer maintained; existing files were NOT deleted.');
    } else if (toggleWrote) {
      // Hooks re-read config.json from disk on every invocation, so they see
      // this write immediately; the MCP server is the one long-lived reader
      // that does not — restart the session to pick the new value up there.
      notice('config.json updated — hooks pick this up on their next invocation; restart the session to reload the MCP server.');
    }
    if (swaps.length || overrides.length || sparringToggles.length || sparringModels.length || tddToggles.length || modeToggles.length || handoffToggles.length) roster = loadRoster();
    for (const e of effects) {
      if (e.type === 'select') pending = [...pending.filter((p) => p.type !== 'select'), e];
      else if (e.type === 'board_edit') pending.push(e);
      else if (e.type === 'github_refresh') options.onGithubRefresh?.();
    }
    if (!options.deferWrites) flush();
    return effects.some((e) => e.type === 'quit');
  }

  return {
    stores,
    store,
    writeStore,
    projectName,
    configPath,
    ui: () => ui,
    roster: () => roster,
    state: (vp) => currentFrame(vp).state,
    async handle(event, vp) {
      const prevTab = ui.tab;
      // A click or a wheel acts on the frame on screen, at the viewport it was
      // drawn with: the host's viewport can already differ (a finished GitHub
      // poll adds or removes the strip row), and that layout is not drawn
      // until the next redraw.
      const pointer = event.kind === 'click' || event.kind === 'wheel';
      const hitVp = pointer && frame && frame.ui === ui && frame.roster === roster ? frame.viewport : vp;
      // the frame on screen, when it was drawn from this ui and roster at this
      // viewport: the reducer hit-tests it instead of reading the store again
      const drawn = frame && frame.ui === ui && frame.roster === roster && frame.vp === vpKey(hitVp) ? frame.built : undefined;
      const result = reduce(store, ui, event, hitVp, stores, roster, resolveProjectHeadSha, drawn);
      ui = result.ui;
      // a held quit is discarded by the next quit only; any other event disarms it
      if (!result.effects.some((e) => e.type === 'quit')) quitArmed = false;
      // System tab: (re)load the roster ONLY on activation (never the redraw loop)
      if (ui.tab === SYSTEM_TAB && (prevTab !== SYSTEM_TAB || !roster)) roster = loadRoster();
      return applyEffects(result.effects);
    },
    applyEffects,
    flush,
    pending: () => pending.length,
    requestQuit,
    stats: () => ({ builds, storeCalls, changeDetection }),
    close: () => {
      // the probe's read-only connections close first, so the store's own
      // close is the last one on each file
      try {
        probe?.close();
        if (writeStore !== store) writeStore.close();
      } finally {
        stores.close();
      }
    },
  };
}
