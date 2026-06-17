// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11). terminal-kit loads only after the
// guard. STERLING_TUI_SMOKE=1 initializes the terminal stack and exits —
// the bundle test uses it to prove runtime resolution works.
import { basename, dirname, join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { acquireTuiLock, releaseTuiLock } from './lock.js';
import { buildDashboardState, initialUi, reduce, runEffects, visibleBodyLines, type UiState } from './state.js';
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

const store = new SterlingStore(storePath);
// the project's folder name (…/<project>/.sterling/sterling.db) — shown bold on
// the TUI's top row so a glance tells you which project's session this pane is.
const projectName = basename(dirname(dirname(storePath)));
let ui: UiState = initialUi;

// One ScreenBuffer for the process lifetime: draw({delta:true}) diffs each
// frame against the previous one and writes only the changed cells.
let screen = new termkit.default.ScreenBuffer({ dst: term });

function redraw(): void {
  draw(screen, buildDashboardState(store, ui, term.width, visibleBodyLines(term.height), projectName));
}

function handle(event: ReturnType<typeof keyToEvent>): void {
  if (!event) return;
  const result = reduce(store, ui, event, { width: term.width, maxBodyLines: visibleBodyLines(term.height) });
  ui = result.ui;
  if (runEffects(store, result.effects)) {
    term.grabInput(false);
    term.hideCursor(false);
    term.fullscreen(false); // leave the alternate screen buffer, restoring the shell
    store.close();
    releaseTuiLock(lockPath, process.pid);
    process.exit(0);
  }
  redraw();
}

// Alternate screen buffer (§11 dashboard): no scrollback, so the 1 Hz redraw
// can never grow the scrollbar or push the view down. The cursor stays hidden
// while the dashboard runs — a visible cursor hopping between cells flickers.
term.fullscreen(true);
term.hideCursor();
term.grabInput({ mouse: 'button' });
term.on('key', (name: string) => handle(keyToEvent(name)));
term.on('mouse', (name: string, data: { x: number; y: number }) => handle(mouseToEvent(name, data)));
term.on('resize', () => {
  // fresh buffer at the new size; its empty delta state forces a full repaint
  screen = new termkit.default.ScreenBuffer({ dst: term });
  redraw();
});
setInterval(redraw, 1000); // live view over the durable store
redraw();
