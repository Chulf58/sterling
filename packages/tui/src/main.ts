// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11). terminal-kit loads only after the
// guard. STERLING_TUI_SMOKE=1 initializes the terminal stack and exits —
// the bundle test uses it to prove runtime resolution works.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDashboard } from './controller.js';
import { visibleBodyLines, AGENTS_TAB, type DashboardState } from './state.js';
import { bannerLines } from './banner.js';
import { clearPixels, draw, keyToEvent, mouseToEvent, paintPixels } from './render.js';
import { composeSubagentBlock, createSubagentTracker, type BlockPixel, type SubagentBlock, type SubagentView } from './subagents.js';
import { acquireTuiLock, releaseTuiLock } from './lock.js';
import { ANIMATION_MS } from './avatars/sprite.js';

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

// The store, config and effect code paths live in controller.ts, shared with
// the OpenCode plugin; this file owns the terminal: the lock, the screen, the
// key and mouse translation, and the redraw loop.
// STERLING_TUI_PROFILE=<file> (or =1 for .sterling/transient/tui-profile.log)
// appends one JSON line per input event, deferred write and tick: timings,
// dashboard builds and project-store method calls.
const profileEnv = process.env.STERLING_TUI_PROFILE;
const profilePath = !profileEnv ? undefined : profileEnv === '1' ? join(dirname(storePath), 'transient', 'tui-profile.log') : profileEnv;
// Store writes are deferred: the frame is drawn first, then the write runs.
const ctl = openDashboard(storePath, { deferWrites: true, profile: profilePath !== undefined });
if (profilePath) {
  mkdirSync(dirname(profilePath), { recursive: true });
  appendFileSync(profilePath, JSON.stringify({ at: new Date().toISOString(), start: true, pid: process.pid, changeDetection: ctl.stats().changeDetection }) + '\n');
}
/** Time one unit of work and, when profiling, log it with the builds and store calls it cost. */
function profiled<T>(kind: string, work: () => T, extra: () => Record<string, unknown> = () => ({})): T {
  if (!profilePath) return work();
  const s0 = ctl.stats();
  const t0 = performance.now();
  const out = work();
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  const s1 = ctl.stats();
  appendFileSync(profilePath, JSON.stringify({ at: new Date().toISOString(), kind, ms, builds: s1.builds - s0.builds, storeCalls: s1.storeCalls - s0.storeCalls, ...extra() }) + '\n');
  return out;
}
// the §11 banner is on by default; STERLING_NO_BANNER=1 suppresses it (the same
// env var the H1 SessionStart hook honors). It is a pure flag from here down —
// the state layer stays env-free.
const showBanner = process.env.STERLING_NO_BANNER !== '1';

// One ScreenBuffer for the process lifetime: draw({delta:true}) diffs each
// frame against the previous one and writes only the changed cells.
let screen = new termkit.default.ScreenBuffer({ dst: term });

// Agents tab: live subagents from H22's dispatch register, one card each with
// an animated portrait. The tracker holds the portrait assignment for
// the TUI's lifetime and reads the register at most once a second.
const subagents = createSubagentTracker(dirname(dirname(storePath)));
// the view the last redraw drew; the hit-test and the animation reuse it, so
// they always agree with what is on screen
let shownView: SubagentView = { availability: 'absent', active: 0, agents: [] };
// the screen row the body starts on, taken from the last drawn state: the cards start there
let bodyTop = 0;

function fullBodyLines(): number {
  return visibleBodyLines(term.height, bannerLines(term.width, showBanner).length);
}

function subagentBlock(tick: number): SubagentBlock {
  if (ctl.ui().tab !== AGENTS_TAB) return { height: 0, puts: [], pixels: [] };
  return composeSubagentBlock(shownView, term.width, term.height - bodyTop - 2, tick);
}

// One viewport snapshot for both the draw and the click hit-test (the sync
// constraint: reduce must see the same width/visibleBodyLines the renderer drew
// with). bodyTop follows the banner height, so it is threaded as showBanner.
// The Agents tab is enabled here, and its label carries the running count.
function viewport() {
  return { width: term.width, maxBodyLines: fullBodyLines(), showBanner, agents: { running: shownView.active } };
}

// Portrait pixels are painted outside the ScreenBuffer (truecolour): when
// their positions change, the old ones are blanked and all are repainted.
let painted: Map<string, string> | undefined;
let pixelLayout = '';
let forceFull = true;
let animation: ReturnType<typeof setInterval> | undefined;
// terminal-kit takes its colour support from TERM_PROGRAM first and maps tmux
// to 16 colours, yet tmux itself accepts 24-bit SGR and converts it for the
// outer terminal; so inside tmux (the dashboard's home) the pixels carry RGB.
const trueColor =
  /^(truecolor|24bits?)$/.test(process.env.COLORTERM ?? '') || process.env.TERM_PROGRAM === 'tmux' || term.support?.trueColor === true;

function layoutKey(block: SubagentBlock): string {
  return `${term.width}x${term.height}|` + block.pixels.map((p) => `${p.x},${p.y}`).join(';');
}

function screenPixels(block: SubagentBlock): BlockPixel[] {
  return block.pixels.map((p) => ({ ...p, y: p.y + bodyTop }));
}

function animate(): void {
  const block = subagentBlock(Math.floor(Date.now() / ANIMATION_MS));
  // the layout moved since the last redraw: that redraw's successor repaints it
  if (layoutKey(block) !== pixelLayout) return;
  painted = paintPixels(term, screenPixels(block), painted, trueColor);
}

// what the last redraw drew: the 1 Hz tick skips a redraw that would draw the same
let drawnState: DashboardState | undefined;
let drawnView = '';

/** Draw the dashboard. With onlyIfChanged (the tick) nothing is drawn when the
 *  state is the cached one and the agent view is unchanged; true when it drew. */
function redraw(onlyIfChanged = false): boolean {
  const now = Date.now();
  shownView = subagents.view(now);
  const state = ctl.state(viewport());
  const viewKey = ctl.ui().tab === AGENTS_TAB ? JSON.stringify(shownView) : String(shownView.active);
  if (onlyIfChanged && !forceFull && state === drawnState && viewKey === drawnView) return false;
  drawnState = state;
  drawnView = viewKey;
  bodyTop = state.bodyTop;
  const block = subagentBlock(Math.floor(now / ANIMATION_MS));
  const key = layoutKey(block);
  const full = forceFull || key !== pixelLayout;
  pixelLayout = key;
  forceFull = false;
  const pixels = screenPixels(block);
  if (full && painted) clearPixels(term, painted, pixels);
  // the roster is the cached activation snapshot — the 1 Hz redraw never re-reads it
  draw(screen, state, { block });
  painted = paintPixels(term, pixels, full ? undefined : painted, trueColor);
  const running = shownView.active > 0 && block.pixels.length > 0;
  if (running && !animation) animation = setInterval(animate, ANIMATION_MS);
  else if (!running && animation) {
    clearInterval(animation);
    animation = undefined;
  }
  return true;
}

// Events run one at a time: each input event, tick, resize and deferred write
// waits for the one before it, so a key can no longer interleave with an
// effect still awaiting (applySwap). A rejection still reaches the fatal
// handler below, as before.
let queue: Promise<void> = Promise.resolve();
function serial(job: () => void | Promise<void>): void {
  queue = queue.then(job);
}

async function handle(event: ReturnType<typeof keyToEvent>): Promise<void> {
  if (!event) return;
  const s0 = profilePath ? ctl.stats() : undefined;
  const t0 = performance.now();
  if (await ctl.handle(event, viewport())) {
    // the held writes run first; one that fails holds the quit and says so,
    // and q again quits, discarding them explicitly
    if (ctl.requestQuit()) shutdown(0);
    redraw();
    return;
  }
  const t1 = performance.now();
  profiled(`event:${event.kind}`, () => redraw(), () => ({
    handleMs: Math.round((t1 - t0) * 100) / 100,
    builds: ctl.stats().builds - s0!.builds,
    storeCalls: ctl.stats().storeCalls - s0!.storeCalls,
  }));
  scheduleFlush();
}

// The held store writes run after the input already waiting has been handled
// (setImmediate runs after the poll phase), so the frame for every click is
// on screen first and a burst of clicks ends in one selection write. A failed
// write shows as a notice; it never exits.
let flushScheduled = false;
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() =>
    serial(() => {
      flushScheduled = false;
      if (profiled('flush', () => ctl.flush())) redraw();
    })
  );
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
  try { ctl.close(); } catch { /* best effort */ }
  try { releaseTuiLock(lockPath, process.pid); } catch { /* best effort */ }
}

// The one exit path: a last attempt at the held store writes, then the
// terminal restore, then the messages on the restored shell, where they can
// be read. A write that still fails is printed, never dropped silently (P5).
let shuttingDown = false;
function shutdown(code: number, message?: string): never {
  let unsaved: string | undefined;
  if (!shuttingDown) {
    shuttingDown = true;
    try {
      if (ctl.flush() || ctl.pending() > 0) unsaved = ctl.ui().notice ?? `${ctl.pending()} write(s) still queued`;
    } catch (err) {
      unsaved = (err as Error)?.message ?? String(err);
    }
  }
  restoreTerminal();
  if (message) console.error(message);
  if (unsaved) console.error(`sterling-tui: store writes not saved at exit — ${unsaved}`);
  process.exit(code);
}

// Any uncaught throw (a store read error mid-redraw, a rejected handler) must
// restore the terminal and report LOUD on the restored shell — never a silent
// corrupt exit (P5). Both handlers, since the event queue is a promise chain.
process.on('uncaughtException', (err) => shutdown(1, `sterling-tui: fatal — ${(err as Error)?.stack ?? err}`));
process.on('unhandledRejection', (err) => shutdown(1, `sterling-tui: fatal (unhandled rejection) — ${(err as Error)?.stack ?? err}`));
// A signal from outside (the pane closed, kill) takes the same path. Ctrl-C
// itself arrives as a key while input is grabbed, and quits like q.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.on(signal, () => shutdown(code, `sterling-tui: ${signal} — exiting`));
}

// Alternate screen buffer (§11 dashboard): no scrollback, so the 1 Hz redraw
// can never grow the scrollbar or push the view down. The cursor stays hidden
// while the dashboard runs — a visible cursor hopping between cells flickers.
term.fullscreen(true);
term.hideCursor();
term.grabInput({ mouse: 'button' });
term.on('key', (name: string) => serial(() => handle(keyToEvent(name))));
term.on('mouse', (name: string, data: { x: number; y: number }) => serial(() => handle(mouseToEvent(name, data))));
term.on('resize', () =>
  serial(() => {
    // fresh buffer at the new size; its empty delta state forces a full repaint
    screen = new termkit.default.ScreenBuffer({ dst: term });
    forceFull = true;
    redraw();
  })
);
// live view over the durable store: the tick rebuilds only when the store's
// data_version, the ui or the viewport moved, and draws only when that or the agent view changed
// A write still queued (it met a busy lock) is retried on each tick.
setInterval(
  () =>
    serial(() => {
      profiled('tick', () => redraw(true));
      if (ctl.pending() > 0) scheduleFlush();
    }),
  1000
);
redraw();
