// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11). terminal-kit loads only after the
// guard. STERLING_TUI_SMOKE=1 initializes the terminal stack and exits —
// the bundle test uses it to prove runtime resolution works.
import { SterlingStore } from '@sterling/store';
import { buildDashboardState, initialUi, reduce, runEffects, type UiState } from './state.js';
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

const termkit = await import('terminal-kit');
const term = termkit.default.terminal;

if (smoke) {
  // prove the bundled terminal stack resolves (termconfig etc.) without a TTY
  console.error(`sterling-tui smoke: terminal stack loaded (${term.width}x${term.height})`);
  process.exit(0);
}

const store = new SterlingStore(args[storeIdx + 1]);
let ui: UiState = initialUi;

function redraw(): void {
  draw(term as never, buildDashboardState(store, ui));
}

function handle(event: ReturnType<typeof keyToEvent>): void {
  if (!event) return;
  const result = reduce(store, ui, event);
  ui = result.ui;
  if (runEffects(store, result.effects)) {
    term.grabInput(false);
    term.clear();
    store.close();
    process.exit(0);
  }
  redraw();
}

term.grabInput({ mouse: 'button' });
term.on('key', (name: string) => handle(keyToEvent(name)));
term.on('mouse', (name: string, data: { x: number; y: number }) => handle(mouseToEvent(name, data)));
setInterval(redraw, 1000); // live view over the durable store
redraw();
