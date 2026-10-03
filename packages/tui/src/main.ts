// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11). terminal-kit loads only after the
// guard. STERLING_TUI_SMOKE=1 initializes the terminal stack and exits —
// the bundle test uses it to prove runtime resolution works.
import { dirname, join } from 'node:path';
import { openDashboard } from './controller.js';
import { visibleBodyLines, AGENTS_TAB } from './state.js';
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
const ctl = openDashboard(storePath);
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

function redraw(): void {
  const now = Date.now();
  shownView = subagents.view(now);
  const state = ctl.state(viewport());
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
}

async function handle(event: ReturnType<typeof keyToEvent>): Promise<void> {
  if (!event) return;
  if (await ctl.handle(event, viewport())) {
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
  try { ctl.close(); } catch { /* best effort */ }
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
  forceFull = true;
  redraw();
});
setInterval(redraw, 1000); // live view over the durable store
redraw();
