// The dashboard controller: the store and config code paths behind the
// dashboard, independent of the surface that draws it. The terminal TUI
// (main.ts) and the OpenCode plugin (packages/opencode-plugin/src/tui.tsx)
// both drive it, so a board edit or a config toggle runs the same code in
// either host. Nothing here touches a terminal.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MountedStores, resolveDomainMounts, catalogStatus, type DomainMount, type SterlingStore } from '@sterling/store';
import { parseConfig, AGENT_MODEL_KEY } from '@sterling/schemas';
import { buildDashboardState, initialUi, reduce, runEffects, SYSTEM_TAB, type UiState, type UiEvent, type Effect, type DashboardState, type Viewport, type AgentRosterSnapshot, type RosterAgent, type CatalogStatusView, type ModelSwapEffect, type SparringToggleEffect, type SparringModelEffect, type TddToggleEffect, type ModeToggleEffect } from './state.js';
import { applyModeToggle, applySparringToggle, applyTddToggle } from './config-writeback.js';
// Static, so esbuild inlines both into the bundles: an installed copy has no
// node_modules and no packages/*/dist, so a run-time import of the scripts/lib
// SOURCE (which imports @sterling/schemas) cannot load there.
import { parseInstalledHeader, setInstalledModelEffort } from '../../../scripts/lib/agent-distribution.mjs';
import { userScopeCodexServer } from '../../../scripts/lib/codex-mcp.mjs';
import { sterlingRootFrom, swapFullAgentModel } from '../../../scripts/lib/opencode-install.mjs';

/** Effect types a host may decline to execute. A string value is the notice
 *  shown when the effect is dropped; null drops it without a notice (for an
 *  effect that fires on every card activation, where a notice would be noise
 *  and the host labels the state instead). */
export type DisableableEffect = 'model_swap' | 'select';

export interface DashboardOptions {
  disabledEffects?: Partial<Record<DisableableEffect, string | null>>;
}

/** The viewport a host passes: every field is required except the optional Agents tab. */
export type ControllerViewport = Required<Omit<Viewport, 'agents'>> & Pick<Viewport, 'agents'>;

export interface DashboardController {
  readonly stores: MountedStores;
  readonly store: SterlingStore;
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

  // Open the project store PLUS its mounted domain stores so the Knowledge tab
  // can fan across them. skipMissing → a domain whose db does not yet exist is
  // skipped, never created. Any failure to read/parse the config DEGRADES
  // LOUD: project-only + a header indicator, never a crash.
  let mounts: DomainMount[] = [];
  let domainsAvailable = true;
  try {
    const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    mounts = resolveDomainMounts(config);
  } catch {
    mounts = [];
    domainsAvailable = false;
  }
  const stores = new MountedStores(storePath, mounts, { skipMissing: true });
  const store = stores.project;
  const projectName = basename(projectRoot) + (domainsAvailable ? '' : ' — domains unavailable (project-only)');
  let ui: UiState = initialUi;

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
      models?: Record<string, { model: string; effort: string }>;
      models_catalog?: { staleness_days?: number };
      sparring_partner?: { enabled?: boolean; model?: string };
      tdd?: { enabled?: boolean };
    };
    const configModels = cfg.models ?? {};
    const sparringPartner = { enabled: cfg.sparring_partner?.enabled ?? true, model: cfg.sparring_partner?.model };
    const tdd = { enabled: cfg.tdd?.enabled ?? true };
    const mode = readRawMode();
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
    return { agents, configModels, catalog, sparringPartner, codexWired, tdd, mode };
  }

  /** Execute a sparring_model effect: config.sparring_partner.model write. An
   *  empty committed value CLEARS the field (unset = Codex CLI default). */
  function applySparringModel(e: SparringModelEffect): void {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { sparring_partner?: { enabled?: boolean; model?: string } };
      const sp: { enabled?: boolean; model?: string } = { ...raw.sparring_partner };
      if (e.model) sp.model = e.model;
      else delete sp.model;
      raw.sparring_partner = sp;
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
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { models?: Record<string, unknown> };
      raw.models = raw.models ?? {};
      raw.models[e.key] = { model: e.to.model, effort: e.to.effort };
      writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');

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
        const oc = swapFullAgentModel({ projectDir: projectRoot, pluginRoot: sterlingRootFrom(), agents: e.agents, model: e.to.model });
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
      });
    } catch (err) {
      // P5: never silent. The next activation's drift marker still backstops a
      // partial write.
      ui = { ...ui, notice: `model swap for '${e.key}' failed partway — ${(err as Error).message}` };
    }
  }

  async function applyEffects(all: Effect[]): Promise<boolean> {
    // the host's effect switch: a declined effect never reaches its writer
    const effects = all.filter((e) => {
      if (e.type !== 'model_swap' && e.type !== 'select') return true;
      const off = disabled[e.type];
      if (off === undefined) return true;
      if (off !== null) ui = { ...ui, notice: off };
      return false;
    });
    const swaps = effects.filter((e): e is ModelSwapEffect => e.type === 'model_swap');
    for (const e of swaps) await applySwap(e);
    const notice = (msg: string) => { ui = { ...ui, notice: msg }; };
    const sparringModels = effects.filter((e): e is SparringModelEffect => e.type === 'sparring_model');
    for (const e of sparringModels) applySparringModel(e);
    // sparring/tdd/mode toggle writes (board a0714d0b, decision foreign_752caf98):
    // run every applier, then compose ONE notice from their {ok} outcomes — a
    // failure wins over a success (review fix, board 09f05fca half 2), so a
    // later success in this same batch can never clobber an earlier failure.
    const sparringToggles = effects.filter((e): e is SparringToggleEffect => e.type === 'sparring_toggle');
    const tddToggles = effects.filter((e): e is TddToggleEffect => e.type === 'tdd_toggle');
    const modeToggles = effects.filter((e): e is ModeToggleEffect => e.type === 'mode_toggle');
    let toggleWrote = false;
    let toggleFailure: string | undefined;
    const collectFailure = (msg: string) => { toggleFailure = msg; };
    for (const e of sparringToggles) { if (applySparringToggle(e, collectFailure, configPath)) toggleWrote = true; }
    for (const e of tddToggles) { if (applyTddToggle(e, collectFailure, configPath)) toggleWrote = true; }
    let modeWritten: ModeToggleEffect['mode'] | undefined;
    for (const e of modeToggles) { if (applyModeToggle(e, collectFailure, configPath)) { toggleWrote = true; modeWritten = e.mode; } }
    if (toggleFailure !== undefined) {
      notice(toggleFailure);
    } else if (modeWritten !== undefined) {
      // what the switch does to the files, said at the moment it is made
      notice(modeWritten === 'work'
        ? 'project mode set to work — run /sterling:update (or init) to write the OpenCode agents and handoff files; sync-agents refreshes only the OpenCode agents.'
        : 'project mode set to hobby — OpenCode agents and handoff files are no longer maintained; existing files were NOT deleted.');
    } else if (toggleWrote) {
      // Hooks re-read config.json from disk on every invocation, so they see
      // this write immediately; the MCP server is the one long-lived reader
      // that does not — restart the session to pick the new value up there.
      notice('config.json updated — hooks pick this up on their next invocation; restart the session to reload the MCP server.');
    }
    if (swaps.length || sparringToggles.length || sparringModels.length || tddToggles.length || modeToggles.length) roster = loadRoster();
    return runEffects(store, effects);
  }

  return {
    stores,
    store,
    projectName,
    configPath,
    ui: () => ui,
    roster: () => roster,
    state: (vp) => buildDashboardState(store, ui, vp.width, vp.maxBodyLines, projectName, vp.showBanner, stores, roster, vp.agents),
    async handle(event, vp) {
      const prevTab = ui.tab;
      const result = reduce(store, ui, event, vp, stores, roster, resolveProjectHeadSha);
      ui = result.ui;
      // System tab: (re)load the roster ONLY on activation (never the redraw loop)
      if (ui.tab === SYSTEM_TAB && (prevTab !== SYSTEM_TAB || !roster)) roster = loadRoster();
      return applyEffects(result.effects);
    },
    applyEffects,
    close: () => stores.close(),
  };
}
