// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11). terminal-kit loads only after the
// guard. STERLING_TUI_SMOKE=1 initializes the terminal stack and exits —
// the bundle test uses it to prove runtime resolution works.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MountedStores, resolveDomainMounts, catalogStatus, type DomainMount } from '@sterling/store';
import { parseConfig, AGENT_MODEL_KEY } from '@sterling/schemas';
import { acquireTuiLock, releaseTuiLock } from './lock.js';
import { buildDashboardState, initialUi, reduce, runEffects, visibleBodyLines, SYSTEM_TAB, type UiState, type AgentRosterSnapshot, type RosterAgent, type CatalogStatusView, type ModelSwapEffect, type SparringToggleEffect, type SparringModelEffect, type TddToggleEffect, type MutationToggleEffect } from './state.js';
import { applySparringToggle, applyTddToggle, applyMutationToggle } from './config-writeback.js';
import { bannerLines } from './banner.js';
import { draw, keyToEvent, mouseToEvent } from './render.js';

const smoke = process.env.STERLING_TUI_SMOKE === '1';
if (!process.stdout.isTTY && !smoke) {
  console.error('sterling-tui: stdout is not a TTY — exiting politely (§11)');
  process.exit(0);
}

const args = process.argv.slice(2);
const storeIdx = args.indexOf('--store');
if (storeIdx === -1 || !args[storeIdx + 1]) {
  console.error('usage: sterling-tui --store <path-to-sterling.db>');
  process.exit(2);
}
const storePath = args[storeIdx + 1];
// System tab (run r-f9a7): the project config + installed agent dir. The store
// lives at <project>/.sterling/sterling.db, so the config sits beside it and the
// installed agents under <project>/.claude/agents/.
const configPath = join(dirname(storePath), 'config.json');
const agentsDir = join(dirname(dirname(storePath)), '.claude', 'agents');

const termkit = await import('terminal-kit');
const term = termkit.default.terminal;

if (smoke) {
  // prove the bundled terminal stack resolves (termconfig etc.) without a TTY
  console.error(`sterling-tui smoke: terminal stack loaded (${term.width}x${term.height})`);
  process.exit(0);
}

// single instance per store (§11): a live owner turns this launch away politely
const lockPath = join(dirname(storePath), 'transient', 'tui.lock');
const owner = acquireTuiLock(lockPath, process.pid);
if (owner !== null) {
  console.error(`sterling-tui: already running (pid ${owner}) for this store — exiting politely (§11)`);
  process.exit(0);
}

// Open the project store PLUS its mounted domain stores so the Knowledge tab
// can fan across them. The config lives next to the project store
// (<.sterling>/config.json); resolveDomainMounts turns its stack_tags into the
// per-domain db paths. skipMissing → a domain whose db does not yet exist is
// skipped, never created (the observer is read-only). Any failure to read/parse
// the config DEGRADES LOUD: project-only + a one-line header indicator, never a
// crash.
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
// the project's folder name (…/<project>/.sterling/sterling.db) — shown bold on
// the TUI's top row so a glance tells you which project's session this pane is.
// When domains could not be loaded the header says so (loud, not buried).
const projectName = basename(dirname(dirname(storePath))) + (domainsAvailable ? '' : ' — domains unavailable (project-only)');
// the §11 banner is on by default; STERLING_NO_BANNER=1 suppresses it (the same
// env var the H1 SessionStart hook honors). It is a pure flag from here down —
// the state layer stays env-free.
const showBanner = process.env.STERLING_NO_BANNER !== '1';
let ui: UiState = initialUi;

// System tab (run r-f9a7): the agent roster snapshot, read ON TAB ACTIVATION
// only (never the 1 Hz redraw loop, per decision 98064d77 — perf). Undefined
// until the tab is first activated; recomputed after a swap so drift markers and
// the new values reflect the write.
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

// Sparring partner (board a0714d0b, article sparring-partner interaction h):
// this repo's own plugin manifest, resolved relative to THIS file's own
// location — same technique as the setInstalledModelEffort dynamic import
// below, and for the same reason: src/main.ts, dist/main.js, and the esbuild
// bundle all sit at the same depth under packages/tui/, so one relative
// offset resolves from any of the three layouts. Presence of a `codex` key
// under mcpServers = wired on THIS MACHINE (a per-clone fact, not per-project
// — the manifest lives in the Sterling clone that ships the TUI bundle,
// regardless of which project's store it is observing).
function probeCodexWired(): boolean {
  try {
    const url = new URL('../../../.claude-plugin/sterling-mcp.json', import.meta.url);
    const raw = JSON.parse(readFileSync(url, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Boolean(raw.mcpServers && Object.prototype.hasOwnProperty.call(raw.mcpServers, 'codex'));
  } catch {
    // missing/unparsable manifest reads as "not wired" — never a thrown probe
    // failure that would crash tab activation (P5: degrade loud via the row
    // marker itself, not a notice — the absence IS the visible state here).
    return false;
  }
}

/** Build the AgentRosterSnapshot at tab activation: installed frontmatter +
 *  config.models + a bootstrapped catalog with its precomputed status. Enqueues
 *  a deduped refresh when the catalog is stale (decision 98064d77). */
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
    mutation_verification?: { enabled?: boolean };
  };
  const configModels = cfg.models ?? {};
  const sparringPartner = { enabled: cfg.sparring_partner?.enabled ?? true, model: cfg.sparring_partner?.model };
  const tdd = { enabled: cfg.tdd?.enabled ?? true };
  const mutationVerification = { enabled: cfg.mutation_verification?.enabled ?? true };
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
    // console.error here would paint into the alternate screen and be discarded
    // (audit finding 41/43) — surface it as a visible System-tab notice instead.
    ui = { ...ui, notice: `catalog unavailable — ${(err as Error).message}` };
  }
  return { agents, configModels, catalog, sparringPartner, codexWired, tdd, mutationVerification };
}

/** Execute a sparring_model effect: config.sparring_partner.model write. An
 *  empty committed value CLEARS the field (unset = Codex CLI default) rather
 *  than writing an empty string, so the System-tab '(CLI default)' rendering
 *  and the schema's optional-field absence stay the same thing. */
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

/** Execute a model_swap effect (the impure seam): config.models write
 *  (authoritative) → surgical setInstalledModelEffort on each governed installed
 *  file (machine vars untouched, d53dc92c) → a durable swap decision (AC5). A
 *  partial projection is not silent — it surfaces as the next activation's drift
 *  marker (P5). setInstalledModelEffort/parseInstalledHeader are loaded at
 *  runtime from scripts/lib (outside the tui tsc rootDir). */
async function applySwap(e: ModelSwapEffect): Promise<void> {
  const nowISO = new Date().toISOString();
  try {
    // 1. config.models write — the authoritative per-project declaration
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { models?: Record<string, unknown> };
    raw.models = raw.models ?? {};
    raw.models[e.key] = { model: e.to.model, effort: e.to.effort };
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');

    // 2. surgical installed-frontmatter projection on each governed agent file
    const distUrl = new URL('../../../scripts/lib/agent-distribution.mjs', import.meta.url).href;
    const dist = await import(distUrl);
    for (const name of e.agents) {
      const p = join(agentsDir, `${name}.md`);
      if (!existsSync(p)) continue;
      const content = readFileSync(p, 'utf8');
      const hdr = dist.parseInstalledHeader(content);
      writeFileSync(
        p,
        dist.setInstalledModelEffort(content, {
          model: e.to.model,
          effort: e.to.effort,
          pluginVersion: hdr?.pluginVersion ?? '0.0.0',
          now: nowISO,
        })
      );
    }

    // 3. durable swap decision (AC5) — reuse the decision type (decision 98064d77)
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
        'Model/effort pin changed from the TUI System tab (decision 98064d77 — config.models is authoritative; a swap re-stamps the installed frontmatter surgically without crossing the WSL↔Windows machine boundary, d53dc92c).',
      alternatives_rejected: [],
    });
  } catch (err) {
    // P5: never silent. A console.error into the alternate screen is lost (audit
    // finding 41/43); surface a visible notice. The next activation's drift marker
    // still backstops a partial write.
    ui = { ...ui, notice: `model swap for '${e.key}' failed partway — ${(err as Error).message}` };
  }
}

// One ScreenBuffer for the process lifetime: draw({delta:true}) diffs each
// frame against the previous one and writes only the changed cells.
let screen = new termkit.default.ScreenBuffer({ dst: term });

// One viewport snapshot for both the draw and the click hit-test (the sync
// constraint: reduce must see the same width/visibleBodyLines the renderer drew
// with). bodyTop follows the banner height, so it is threaded as showBanner.
function viewport() {
  const bannerHeight = bannerLines(term.width, showBanner).length;
  return { width: term.width, maxBodyLines: visibleBodyLines(term.height, bannerHeight), showBanner };
}

function redraw(): void {
  const vp = viewport();
  // roster is the cached activation snapshot — the 1 Hz redraw never re-reads it
  draw(screen, buildDashboardState(store, ui, vp.width, vp.maxBodyLines, projectName, vp.showBanner, stores, roster));
}

async function handle(event: ReturnType<typeof keyToEvent>): Promise<void> {
  if (!event) return;
  const prevTab = ui.tab;
  const result = reduce(store, ui, event, viewport(), stores, roster);
  ui = result.ui;
  // System tab: (re)load the roster ONLY on activation (never the 1 Hz loop)
  if (ui.tab === SYSTEM_TAB && (prevTab !== SYSTEM_TAB || !roster)) roster = loadRoster();
  // execute any model_swap effect (the TUI's write surface), then refresh the
  // roster so the swap's new values + any residual drift are reflected
  const swaps = result.effects.filter((e): e is ModelSwapEffect => e.type === 'model_swap');
  for (const e of swaps) await applySwap(e);
  // sparring-partner toggle/model writes (board a0714d0b) — same activation
  // refresh pattern as a model swap, so the row reflects the new value and
  // (for the toggle) the unchanged codexWired probe.
  const notice = (msg: string) => { ui = { ...ui, notice: msg }; };
  const sparringToggles = result.effects.filter((e): e is SparringToggleEffect => e.type === 'sparring_toggle');
  for (const e of sparringToggles) applySparringToggle(e, notice, configPath);
  const sparringModels = result.effects.filter((e): e is SparringModelEffect => e.type === 'sparring_model');
  for (const e of sparringModels) applySparringModel(e);
  // tdd/mutation_verification toggle writes (decision 752caf98) — same
  // activation-refresh pattern as the sparring-partner toggle.
  const tddToggles = result.effects.filter((e): e is TddToggleEffect => e.type === 'tdd_toggle');
  for (const e of tddToggles) applyTddToggle(e, notice, configPath);
  const mutationToggles = result.effects.filter((e): e is MutationToggleEffect => e.type === 'mutation_toggle');
  for (const e of mutationToggles) applyMutationToggle(e, notice, configPath);
  if (swaps.length || sparringToggles.length || sparringModels.length || tddToggles.length || mutationToggles.length) roster = loadRoster();
  if (runEffects(store, result.effects)) {
    restoreTerminal();
    process.exit(0);
  }
  redraw();
}

// Idempotent terminal + resource restore (audit finding 23/43): the ONLY prior
// teardown lived in the quit path, so any throw during the 1 Hz redraw or an
// event handler killed the process mid-fullscreen — grabInput on, alternate
// screen active, TUI lock held — corrupting the user's shell. Every exit path
// now routes through here; each step is best-effort so one failure can't strand
// the rest.
let terminalRestored = false;
function restoreTerminal(): void {
  if (terminalRestored) return;
  terminalRestored = true;
  try { term.grabInput(false); } catch { /* best effort */ }
  try { term.hideCursor(false); } catch { /* best effort */ }
  try { term.fullscreen(false); } catch { /* best effort */ } // leave the alternate screen, restoring the shell
  try { stores.close(); } catch { /* best effort */ }
  try { releaseTuiLock(lockPath, process.pid); } catch { /* best effort */ }
}

// Any uncaught throw (a store read error mid-redraw, a rejected handler) must
// restore the terminal and report LOUD on the restored shell — never a silent
// corrupt exit (P5). Both handlers, since handle() runs as a floating promise.
process.on('uncaughtException', (err) => {
  restoreTerminal();
  console.error(`sterling-tui: fatal — ${(err as Error)?.stack ?? err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  restoreTerminal();
  console.error(`sterling-tui: fatal (unhandled rejection) — ${(err as Error)?.stack ?? err}`);
  process.exit(1);
});

// Alternate screen buffer (§11 dashboard): no scrollback, so the 1 Hz redraw
// can never grow the scrollbar or push the view down. The cursor stays hidden
// while the dashboard runs — a visible cursor hopping between cells flickers.
term.fullscreen(true);
term.hideCursor();
term.grabInput({ mouse: 'button' });
term.on('key', (name: string) => void handle(keyToEvent(name)));
term.on('mouse', (name: string, data: { x: number; y: number }) => void handle(mouseToEvent(name, data)));
term.on('resize', () => {
  // fresh buffer at the new size; its empty delta state forces a full repaint
  screen = new termkit.default.ScreenBuffer({ dst: term });
  redraw();
});
setInterval(redraw, 1000); // live view over the durable store
redraw();
