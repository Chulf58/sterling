// The dashboard controller: the store and config code paths behind the
// dashboard, independent of the surface that draws it. The terminal TUI
// (main.ts) and the OpenCode plugin (packages/opencode-plugin/src/tui.tsx)
// both drive it, so a board edit or a config toggle runs the same code in
// either host. Nothing here touches a terminal.
import { readFileSync, writeFileSync, existsSync, rmSync, lstatSync, chmodSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { MountedStores, SterlingStore, StoreBusyError, DEFAULT_BUSY_TIMEOUT_MS, resolveDomainMounts, catalogStatus, type DomainMount } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { parseConfig, parseCanonicalConfig, toCanonicalConfig, isCustomAgentKey, type AgentHost, type CanonicalConfig } from '@sterling/schemas';
import { buildDashboardFrame, clipEllipsis, initialUi, reduce, runEffects, SYSTEM_TAB, type DashboardFrame, type BoardEditEffect, type SelectEffect, type UiState, type UiEvent, type Effect, type DashboardState, type Viewport, type AgentRosterSnapshot, type CatalogStatusView, type AgentModelEffect, type AgentModelView, type AdoptPlanEffect, type AdoptRunEffect, type AdoptedAgentView, type WorkflowEffect, type WorkflowView, type TddToggleEffect, type HandoffToggleEffect, type OverpassProviderEffect } from './state.js';
import { ConfigChangedError, replaceConfigFile, writeConfigKey, type ConfigWriteSeams, applyAgentModel, applyHandoffToggle, applyOverpassProvider, applyTddToggle, applyWorkflow } from './config-writeback.js';
import { AutoMergeSettingError, autoMergeOnCleanOf } from '../../../scripts/lib/work-pr.mjs';
import { openDataVersionProbe, type DataVersionProbe } from './data-version.js';
// Static, so esbuild inlines both into the bundles: an installed copy has no
// node_modules and no packages/*/dist, so a run-time import of the scripts/lib
// SOURCE (which imports @sterling/schemas) cannot load there.
import { parseInstalledHeader, setInstalledModelEffort } from '../../../scripts/lib/agent-distribution.mjs';
import { userScopeCodexServer } from '../../../scripts/lib/codex-mcp.mjs';
import { handoffSettingOf, HandoffGitError, HandoffSettingError } from '../../../scripts/lib/handoff-projection.mjs';
import { sterlingRootFrom, swapFullAgentModel, stageFullAgentModel, writeFullAgentFiles, type StagedWrite } from '../../../scripts/lib/opencode-install.mjs';
import { discoverCustomAgents, installedGovernedAgents, customAgentFile } from './custom-agents.js';
import { AGENT_SOURCE_DIR, adopt, planAdoption, readSourceFiles, sourcePathOf } from '../../../scripts/lib/agent-adoption.mjs';
import { detectInstalledHosts, parseSource, syncCustomAgents } from '../../../scripts/lib/custom-agent-render.mjs';
import { writeFileAtomic } from '../../../scripts/lib/atomic-write.mjs';
import { AGY_AGENTS_DIR, AGY_ROSTER, probeAgy, setupAgy } from '../../../scripts/lib/agy-setup.mjs';
import { storeBackend } from '../../../scripts/hooks/lib/store-backend.mjs';
import { writeSelectionFile } from '../../../scripts/hooks/lib/selection-file.mjs';

/** Effect types a host may decline to execute. A string value is the notice
 *  shown when the effect is dropped; null drops it without a notice (for an
 *  effect that fires on every card activation, where a notice would be noise
 *  and the host labels the state instead). */
export type DisableableEffect = 'agent_model' | 'select';

export interface DashboardOptions {
  /** The git checkout the dashboard serves, when it is a linked worktree of the
   *  store's project: its selection goes to that checkout's file slot
   *  (selection-file.mjs), never the shared store's one selection row. */
  checkoutRoot?: string;
  disabledEffects?: Partial<Record<DisableableEffect, string | null>>;
  /** Hold store writes (the selection, a board edit) until the host calls
   *  flush(), so they run after the frame is drawn. Default false: handle()
   *  runs them before it returns. */
  deferWrites?: boolean;
  /** Count the project store's method calls for stats() (STERLING_TUI_PROFILE). */
  profile?: boolean;
  /** Replaces the data_version probe; tests use it to make a read fail. */
  dataVersionProbe?: (paths: string[]) => DataVersionProbe;
  /** Milliseconds now, for how long the probe has met a held lock; tests use
   *  it to age a lock. Default Date.now. */
  clock?: () => number;
  /** the `r` key (a github_refresh effect): the host's GitHub poller polls now */
  onGithubRefresh?: () => void;
  /** The file operations the OpenCode-override config.json write uses; tests
   *  use it to make that write fail part-way. */
  configWriteFs?: ConfigWriteSeams;
  /** The agy project setup an agy_model effect runs after writing config.json; tests inject a hermetic one. */
  agySetup?: (args: { projectDir: string; pluginRoot: string }) => ReturnType<typeof setupAgy>;
  /** The hosts adopted custom agents are rendered into; default: the hosts installed here (detectInstalledHosts). Tests pin it. */
  customAgentHosts?: Array<'claude' | 'opencode' | 'agy'>;
  /** Which host opened the dashboard. 'opencode' offers the Overpass rows (in
   *  work mode). The in-OpenCode dashboard (opencode/sterling-tui/tui.tsx)
   *  passes 'opencode'; the tmux side pane (main.ts) passes it from
   *  `--host opencode` through launch-args.ts, and leaves it unset otherwise. */
  host?: 'opencode';
}

/** How long the held selection and board-edit writes wait for another
 *  connection's write lock before giving up (SQLite's busy timeout; the
 *  store's default is 5000 ms). Short, because they run on the terminal's
 *  event loop. Only their own connection (writeStore) uses it. With
 *  deferWrites a write that times out stays queued for the next flush. */
export const DASHBOARD_BUSY_TIMEOUT_MS = 250;

/** How long the data_version probe may keep meeting a held lock before the
 *  dashboard says the store is locked. It is the store's own busy timeout:
 *  by then every other Sterling connection waiting on that lock has given up
 *  too, so it is no longer an ordinary commit (GitHub #129). */
export const LOCK_NOTICE_AFTER_MS = DEFAULT_BUSY_TIMEOUT_MS;

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
 *  Agents tab and its card block height, the pane height (a host without the
 *  banner has no use for it) and the GitHub snapshot (a host without a GitHub poller). */
export type ControllerViewport = Required<Omit<Viewport, 'agents' | 'height' | 'github' | 'agentsLines'>> & Pick<Viewport, 'agents' | 'height' | 'github' | 'agentsLines'>;

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
  const selectionCheckout = options.checkoutRoot && options.checkoutRoot !== projectRoot ? options.checkoutRoot : undefined;

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
  /** A SQLITE_BUSY or SQLITE_LOCKED error: another connection holds the lock. */
  const isBusy = (err: unknown): boolean => {
    if (err instanceof StoreBusyError) return true;
    const code = (err as { errcode?: unknown } | null)?.errcode;
    return code === 5 || code === 6 || /database is (locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test((err as Error | null)?.message ?? '');
  };

  const clock = options.clock ?? Date.now;
  /** when the probe first met the lock it is still meeting; undefined after a read succeeds */
  let busySince: number | undefined;
  /** set once that lock has been held for LOCK_NOTICE_AFTER_MS */
  let lockNotice: string | undefined;
  /** The lock notice goes on the notice row of the frame handed out, never
   *  into UiState: a ui change would rebuild through the same lock. The row
   *  is always reserved (render.ts), so the layout and hit-test do not move. */
  const withLockNotice = (built: DashboardFrame, width: number): DashboardFrame =>
    lockNotice === undefined ? built : { ...built, state: { ...built.state, notice: clipEllipsis(`⚠ ${lockNotice}`, width) } };
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
      const paths = [storePath, ...mounts.map((m) => m.dbPath)];
      probe = options.dataVersionProbe ? options.dataVersionProbe(paths) : openDataVersionProbe(paths, { busyTimeoutMs: DASHBOARD_BUSY_TIMEOUT_MS });
    } catch (err) {
      degrade(`data_version probe failed to open — ${(err as Error).message}`);
    }
  }
  let frame: { vp: string; viewport: ControllerViewport; day: string; ui: UiState; roster: AgentRosterSnapshot | undefined; dataVersion: string | undefined; built: DashboardFrame } | undefined;
  let builds = 0;
  // the GitHub snapshot's version moves only when its content does, so an unchanged poll rebuilds nothing
  const vpKey = (vp: ControllerViewport): string => JSON.stringify([vp.width, vp.maxBodyLines, vp.showBanner, vp.agents ? vp.agents.running : null, vp.height ?? null, vp.github ? vp.github.version : null, vp.agentsLines ?? null]);
  const today = (): string => new Date().toDateString();
  function currentFrame(vp: ControllerViewport): DashboardFrame {
    let dataVersion: string | undefined;
    // A store mid-commit (a lock held past the probe's busy timeout) is not
    // degraded detection: the next read after the commit returns a new
    // version and rebuilds then. Until then the last frame stands, so the
    // redraw does not wait on the same lock (GitHub #129). A lock still held
    // after LOCK_NOTICE_AFTER_MS is said on the notice row and in stats(),
    // until a read succeeds.
    let midCommit = false;
    if (probe) {
      try {
        dataVersion = probe.read();
        busySince = undefined;
        lockNotice = undefined;
        if (changeDetection.startsWith('locked: ')) changeDetection = 'data_version';
      } catch (err) {
        if (isBusy(err)) {
          midCommit = true;
          const now = clock();
          busySince ??= now;
          const held = now - busySince;
          if (held >= LOCK_NOTICE_AFTER_MS) {
            lockNotice = `store locked by another connection for ${Math.round(held / 1000)} s (${(err as Error).message}); showing the last frame until it is released`;
            if (changeDetection === 'data_version' || changeDetection.startsWith('locked: ')) changeDetection = `locked: ${lockNotice}`;
          }
        } else degrade(`data_version read failed — ${(err as Error).message}`);
      }
    }
    const key = vpKey(vp);
    const day = today();
    const storeUnchanged = midCommit || (dataVersion !== undefined && frame?.dataVersion === dataVersion);
    if (frame && storeUnchanged && frame.ui === ui && frame.roster === roster && frame.vp === key && frame.day === day) return withLockNotice(frame.built, vp.width);
    builds++;
    const built = buildDashboardFrame(store, ui, vp.width, vp.maxBodyLines, projectName, vp.showBanner, stores, roster, vp.agents, vp.height, vp.github, vp.agentsLines);
    frame = { vp: key, viewport: vp, day, ui, roster, dataVersion, built };
    return withLockNotice(built, vp.width);
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
        // A linked worktree's dashboard keeps its selection in its own checkout's file slot.
        if (e.type === 'select' && (routed || selectionCheckout)) writeSelectionFile(selectionCheckout ?? projectRoot, e.recordType, e.id, new Date().toISOString());
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

  /** Build the AgentRosterSnapshot at tab activation: the canonical config (parseCanonicalConfig, never
   *  parseConfig, so the tab does not depend on parseConfig's shape) plus the catalog and its precomputed
   *  status. Enqueues a deduped refresh when the catalog is stale (decision foreign_98064d77). A config that
   *  cannot be read as canonical sets `configError`: the agent and workflow rows then say so. */
  function loadRoster(): AgentRosterSnapshot {
    const nowISO = new Date().toISOString();
    let raw: unknown;
    let canonical: CanonicalConfig | undefined;
    let configError: string | undefined;
    let twoModels: string[] | undefined;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
      canonical = parseCanonicalConfig(raw);
      twoModels = toCanonicalConfig(raw).conflicts.map((c) => c.role);
    } catch (err) {
      configError = (err as Error).message.split('\n')[0];
      ui = { ...ui, notice: `config unreadable as canonical — ${configError}` };
    }
    const models: Record<string, AgentModelView> = {};
    for (const [k, v] of Object.entries(canonical?.models ?? {})) models[k] = { ...(v as AgentModelView) };
    const handoff = readHandoff();
    const customAgents = discoverCustomAgents(projectRoot).map((a) => ({ ...a, file: customAgentFile(a) }));
    const hosts: AgentHost[] = ['claude', 'opencode', ...(probeAgy({ env: process.env, home: homedir() }).installed ? (['agy'] as AgentHost[]) : [])];
    // Adopted custom agents: config.models.custom-* with its agent-sources/<key>.md, the hosts it is rendered
    // into, and what the render refuses for it (a dry run: nothing is written here).
    const adoptedAgents: AdoptedAgentView[] = [];
    const adoptedKeys = Object.keys(models).filter((k) => isCustomAgentKey(k) && existsSync(join(projectRoot, sourcePathOf(k))));
    if (adoptedKeys.length > 0 && canonical) {
      const renderHosts = customHosts();
      let refused: Array<{ key: string; host: string; reason: string }> = [];
      try {
        refused = syncCustomAgents(projectRoot, canonical as { models?: Record<string, object> }, { hosts: renderHosts, dryRun: true }).refused;
      } catch (err) {
        refused = adoptedKeys.map((key) => ({ key, host: '*', reason: `the render plan failed: ${(err as Error).message}` }));
      }
      for (const key of adoptedKeys) {
        let name = key.slice('custom-'.length);
        try {
          const parsed = parseSource(readFileSync(join(projectRoot, sourcePathOf(key)), 'utf8'));
          if (!('error' in parsed) && typeof parsed.data.name === 'string') name = parsed.data.name;
        } catch {
          // an unreadable source shows under its key; the render plan reports the problem on the row
        }
        adoptedAgents.push({ key, name, hosts: renderHosts, refusals: refused.filter((r) => r.key === key).map((r) => ({ host: r.host, reason: r.reason })) });
      }
    }

    let catalog: CatalogStatusView = { present: false, stale: false, staleDate: null, entries: [] };
    try {
      store.bootstrapCatalogIfAbsent(canonical ?? {}, nowISO);
      store.ensureCatalogPinnedModels(canonical ?? {});
      const rec = store.query({ types: ['reference_material'], cap: 200 }).find((r) => (r as { catalog?: unknown }).catalog);
      const days = (canonical as { models_catalog?: { staleness_days?: number } } | undefined)?.models_catalog?.staleness_days ?? 45;
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
    return {
      models,
      hosts,
      ...(twoModels?.length ? { twoModels } : {}),
      ...(configError !== undefined ? { configError } : {}),
      customAgents,
      adoptedAgents,
      catalog,
      ...(canonical ? { workflow: canonical.workflow as WorkflowView, overpassProvider: canonical.overpass.provider, tdd: { enabled: (canonical as { tdd?: { enabled?: boolean } }).tdd?.enabled ?? true } } : {}),
      storage: readRawStorage(),
      host: options.host,
      ...handoff,
    };
  }

  /** The hosts adopted custom agents are rendered into. */
  function customHosts(): Array<'claude' | 'opencode' | 'agy'> {
    return options.customAgentHosts ?? (detectInstalledHosts(projectRoot) as Array<'claude' | 'opencode' | 'agy'>);
  }

  /** Execute an agent_model effect: write config.models.<key> (canonical, validated: applyAgentModel), then,
   *  for an adopted custom agent, render every installed host's file from the new config. The agent files of
   *  a governed role follow the config on the next sync (/sterling:update or sync-agents). A host that cannot
   *  run the model is not hidden: the row's hosts cell says so. */
  function applyAgentModelEffect(e: AgentModelEffect): void {
    let failure: string | undefined;
    if (!applyAgentModel(e, (msg) => { failure = msg; }, configPath)) {
      ui = { ...ui, notice: failure ?? `model change for '${e.key}' failed` };
      return;
    }
    const what = e.model === null ? 'on its host default' : `${e.model}${e.effort ? ` at ${e.effort}` : ''}`;
    if (!isCustomAgentKey(e.key)) {
      ui = { ...ui, notice: `'${e.key}' set to ${what}; its agent files follow on the next sync (/sterling:update).` };
      return;
    }
    try {
      const canonical = parseCanonicalConfig(JSON.parse(readFileSync(configPath, 'utf8')));
      const report = syncCustomAgents(projectRoot, canonical as { models?: Record<string, object> }, { hosts: customHosts() });
      const wrote = [...new Set([...report.written, ...report.unchanged].filter((w) => w.key === e.key).map((w) => w.host))];
      ui = { ...ui, notice: `Custom agent '${e.key}' set to ${what}; rendered for ${wrote.length ? wrote.join(', ') : 'no host'}.` };
    } catch (err) {
      ui = { ...ui, notice: `Custom agent '${e.key}' set to ${what} in config.json, but the render failed — ${(err as Error).message}` };
    }
  }

  /** The adoption plan for a not-yet-adopted agent, from the files on disk. */
  function planAdoptionFor(id: string): { found: { source: 'claude' | 'opencode' | 'agy'; name: string; file: string; content?: string }; plan: ReturnType<typeof planAdoption> } | undefined {
    const all = (roster?.customAgents ?? []).map((a) => {
      const file = a.file ?? customAgentFile(a);
      let content: string | undefined;
      try {
        content = readFileSync(join(projectRoot, file), 'utf8');
      } catch {
        content = undefined;
      }
      return { source: a.source, name: a.name, file, ...(content !== undefined ? { content } : {}) };
    });
    const found = all.find((a) => `${a.source}:${a.name}` === id);
    if (!found) return undefined;
    let configKeys: string[] = [];
    try {
      configKeys = Object.keys((JSON.parse(readFileSync(configPath, 'utf8')) as { models?: object }).models ?? {});
    } catch {
      configKeys = [];
    }
    const plan = planAdoption(
      { host: found.source, name: found.name, file: found.file, ...(found.content !== undefined ? { content: found.content } : {}) },
      { sourceFiles: readSourceFiles(projectRoot), configKeys, hosts: customHosts(), others: all.filter((a) => a !== found).map((a) => ({ host: a.source, name: a.name, ...(a.content !== undefined ? { content: a.content } : {}) })) },
    );
    return { found, plan };
  }

  /** Execute adopt_plan: compute the plan and leave it in ui.adoptConfirm for the user to confirm or cancel. */
  function applyAdoptPlan(e: AdoptPlanEffect): void {
    const r = planAdoptionFor(e.id);
    if (!r) {
      ui = { ...ui, notice: `Adopt: ${e.id} is no longer listed; nothing changed` };
      return;
    }
    const { plan } = r;
    const lines = plan.ok
      ? [
          `adopt ${e.id}: move ${plan.move!.from} to ${plan.move!.to}`,
          `new key ${plan.key}; no model or effort is written (the host's own default); every installed host gets a generated copy`,
          ...((plan.duplicates ?? []).length ? [`identical copies stay and are replaced by generated ones: ${(plan.duplicates ?? []).map((d) => `${d.host}:${d.name}`).join(', ')}`] : []),
          'ENTER adopts, ESC cancels',
        ]
      : [...plan.refusals.map((x) => `refused (${x.code}): ${x.message}`), 'ENTER or ESC closes'];
    ui = { ...ui, adoptConfirm: { id: e.id, ok: plan.ok, lines } };
  }

  /** Execute adopt_run: adopt (move the file into agent-sources), create config.models.<key> with no model or
   *  effort, render every host. The whole render is planned first, as it will be after the move (a dry run
   *  with the source pending and the original's path vacated): any host refusal for this agent refuses the
   *  adoption before anything moves, naming each host and reason. The real render runs with requireClean, so a
   *  refusal that appears in between throws before any output is written, and syncCustomAgents puts back the
   *  outputs it wrote when a write throws. Any failure after the move puts config.json and the original back. */
  function applyAdoptRun(e: AdoptRunEffect): void {
    const fail = (msg: string) => { ui = { ...ui, notice: `Adopt ${e.id} failed — ${msg}; nothing was changed` }; };
    const r = planAdoptionFor(e.id);
    if (!r || !r.plan.ok) {
      fail(r ? r.plan.refusals.map((x) => x.message).join('; ') : 'the agent is no longer listed');
      return;
    }
    const { found, plan } = r;
    const original = found.content!;
    const key = plan.key!;
    let configBefore: Buffer;
    let configAfter: string;
    let parsed: ReturnType<typeof parseConfig>;
    try {
      configBefore = readFileSync(configPath);
      const raw = JSON.parse(configBefore.toString('utf8')) as { models?: Record<string, unknown> };
      raw.models = { ...(raw.models ?? {}), [key]: {} };
      parsed = parseConfig(raw);
      configAfter = JSON.stringify(raw, null, 2) + '\n';
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    const hosts = customHosts();
    const models = parsed as { models?: Record<string, object> };
    try {
      const dry = syncCustomAgents(projectRoot, models, { hosts, dryRun: true, pending: { key, text: plan.sourceContent! }, vacated: [plan.move!.from] });
      const mine = dry.refused.filter((x) => x.key === key);
      if (mine.length) {
        fail(mine.map((x) => `${x.host}: ${x.reason}`).join('; '));
        return;
      }
    } catch (err) {
      fail(`the render plan failed: ${(err as Error).message}`);
      return;
    }
    let result: { from: string; to: string; key: string };
    try {
      result = adopt(projectRoot, plan);
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    const undo = (): void => {
      const from = join(projectRoot, result.from);
      mkdirSync(dirname(from), { recursive: true });
      writeFileSync(from, original);
      rmSync(join(projectRoot, result.to), { force: true });
    };
    try {
      replaceConfigFile(configPath, configAfter, configBefore, options.configWriteFs);
    } catch (err) {
      undo();
      fail(err instanceof ConfigChangedError ? err.message : `writing config.json failed: ${(err as Error).message}`);
      return;
    }
    try {
      const report = syncCustomAgents(projectRoot, models, { hosts, requireClean: [key] });
      const wrote = [...new Set([...report.written, ...report.unchanged].filter((w) => w.key === key).map((w) => w.host))];
      ui = { ...ui, notice: `Adopted ${e.id} as ${key} (${AGENT_SOURCE_DIR}/${key}.md); rendered for ${wrote.length ? wrote.join(', ') : 'no host'}.` };
    } catch (err) {
      try {
        replaceConfigFile(configPath, configBefore.toString('utf8'), Buffer.from(configAfter), options.configWriteFs);
        undo();
      } catch (restoreErr) {
        ui = { ...ui, notice: `Adopt ${e.id}: the render failed (${(err as Error).message}) and the undo failed: ${(restoreErr as Error).message}` };
        return;
      }
      fail((err as Error).message);
    }
  }

  async function applyEffects(all: Effect[]): Promise<boolean> {
    // the host's effect switch: a declined effect never reaches its writer
    const effects = all.filter((e) => {
      if (e.type !== 'agent_model' && e.type !== 'select') return true;
      const off = disabled[e.type];
      if (off === undefined) return true;
      if (off !== null) ui = { ...ui, notice: off };
      return false;
    });
    const notice = (msg: string) => { ui = { ...ui, notice: msg }; };
    const agentModels = effects.filter((e): e is AgentModelEffect => e.type === 'agent_model');
    for (const e of agentModels) applyAgentModelEffect(e);
    const customEffects = effects.filter((e) => e.type === 'adopt_plan' || e.type === 'adopt_run');
    for (const e of effects) {
      if (e.type === 'adopt_plan') applyAdoptPlan(e);
      else if (e.type === 'adopt_run') applyAdoptRun(e);
    }
    // config writes: run every applier, then compose ONE notice from their outcomes — a failure wins over a
    // success, so a later success in this same batch can never clobber an earlier failure
    const workflows = effects.filter((e): e is WorkflowEffect => e.type === 'workflow_set');
    const tddToggles = effects.filter((e): e is TddToggleEffect => e.type === 'tdd_toggle');
    const handoffToggles = effects.filter((e): e is HandoffToggleEffect => e.type === 'handoff_toggle');
    const overpassProviders = effects.filter((e): e is OverpassProviderEffect => e.type === 'overpass_provider');
    let toggleWrote = false;
    let toggleFailure: string | undefined;
    const collectFailure = (msg: string) => { toggleFailure = msg; };
    for (const e of tddToggles) { if (applyTddToggle(e, collectFailure, configPath)) toggleWrote = true; }
    let workflowNotice: string | undefined;
    for (const e of workflows) {
      if (applyWorkflow(e, collectFailure, configPath)) {
        toggleWrote = true;
        workflowNotice = `workflow.${e.field} set to ${String(e.value)}.`;
      }
    }
    let handoffWritten: boolean | undefined;
    for (const e of handoffToggles) { if (applyHandoffToggle(e, collectFailure, configPath)) { toggleWrote = true; handoffWritten = e.enabled; } }
    let providerNotice: string | undefined;
    for (const e of overpassProviders) {
      if (applyOverpassProvider(e, collectFailure, configPath)) { toggleWrote = true; providerNotice = `Overpass provider set to '${e.provider}' — overpass/<tier> models run through it from the next turn.`; }
    }
    if (toggleFailure !== undefined) {
      notice(toggleFailure);
    } else if (providerNotice !== undefined) {
      notice(providerNotice);
    } else if (workflowNotice !== undefined) {
      notice(workflowNotice);
    } else if (handoffWritten !== undefined) {
      // what the switch does to the files, said at the moment it is made
      notice(handoffWritten
        ? 'handoff files turned on — run /sterling:update (or init) to write the portable OpenCode agents and the handoff projection; sync-agents refreshes only the portable agents.'
        : 'handoff files turned off — the portable OpenCode agents and the handoff projection are no longer maintained; existing files were NOT deleted.');
    } else if (toggleWrote) {
      // Hooks re-read config.json from disk on every invocation, so they see
      // this write immediately; the MCP server is the one long-lived reader
      // that does not — restart the session to pick the new value up there.
      notice('config.json updated — hooks pick this up on their next invocation; restart the session (Claude Code) or run opencode reload (OpenCode) to reload the MCP server.');
    }
    if (customEffects.length || agentModels.length || workflows.length || tddToggles.length || handoffToggles.length || overpassProviders.length) roster = loadRoster();
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
      // a quit held for unsaved writes says "press q again": that q confirms
      // it on any tab and in any mode, before the reducer can read it as text
      // or as its own quit question
      if (quitArmed && event.kind === 'char' && event.ch === 'q') return true;
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
