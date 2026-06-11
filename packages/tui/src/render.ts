// Thin terminal-kit render layer (revised §2.1): prints what the state layer
// derived; owns NOTHING testable. Mouse + key events are translated to the
// state layer's UiEvent vocabulary and fed to reduce().
import type { DashboardState, UiEvent } from './state.js';

// minimal structural types for the slice of terminal-kit we use
export interface AttrLike {
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  color?: string;
}
export interface ScreenLike {
  width: number;
  height: number;
  fill(options: { attr: AttrLike }): void;
  put(options: { x: number; y: number; attr: AttrLike }, str: string): void;
  draw(options: { delta: boolean }): void;
}

export function draw(screen: ScreenLike, state: DashboardState): void {
  // The frame is composed off-screen into a ScreenBuffer and delta-drawn:
  // only cells that changed since the previous frame reach the terminal, so
  // an unchanged dashboard writes nothing — no flicker. put() coordinates
  // are 0-based and clip at the buffer edge (no wrap), so a long line can
  // never push the pane into a real scroll.
  screen.fill({ attr: {} });
  let x = 0;
  for (const tab of state.tabs) {
    const label = ` ${tab.label} `; // x extents must stay in sync with the click mapping in state.ts
    screen.put({ x, y: 0, attr: tab.active ? { inverse: true } : {} }, label);
    x += label.length;
  }
  const lastBodyLine = screen.height - 3; // reserve the blank spacer + footer
  let y = state.bodyTop; // 0-based rows: tab bar 0, blank 1, body from bodyTop
  if (state.emptyMessage && y <= lastBodyLine) {
    screen.put({ x: 0, y, attr: { dim: true } }, state.emptyMessage);
    y += 1;
  }
  for (const row of state.rows) {
    if (y > lastBodyLine) break;
    const text = `${row.selected ? '› ' : '  '}${row.text}`;
    screen.put({ x: 0, y, attr: row.selected ? { inverse: true } : {} }, text);
    y += 1;
    if (row.detail && y <= lastBodyLine) {
      screen.put({ x: 0, y, attr: { dim: true } }, `    ${row.detail}`);
      y += 1;
    }
  }
  if (state.run && y <= lastBodyLine) {
    const head = `run ${state.run.id} — `;
    screen.put({ x: 0, y, attr: {} }, head);
    screen.put({ x: head.length, y, attr: { bold: true } }, state.run.machine_state);
    screen.put({ x: head.length + state.run.machine_state.length, y, attr: {} }, ` · ${state.run.phaseLabel}`);
    y += 1;
    if (y <= lastBodyLine) {
      screen.put({ x: 0, y, attr: {} }, `last signal: ${state.run.lastSignal} · context warns: ${state.run.warnFlags}`);
      y += 1;
    }
    if (state.run.pendingJudgment && y <= lastBodyLine) {
      screen.put({ x: 0, y, attr: { color: 'yellow' } }, `pending judgment: ${state.run.pendingJudgment}`);
      y += 1;
    }
  }
  screen.put({ x: 0, y: Math.min(y + 1, screen.height - 1), attr: { dim: true } }, state.footer);
  screen.draw({ delta: true });
}

/** Translate terminal-kit key names to state-layer events. */
export function keyToEvent(name: string): UiEvent | undefined {
  switch (name) {
    case 'LEFT':
      return { kind: 'key', name: 'LEFT' };
    case 'RIGHT':
      return { kind: 'key', name: 'RIGHT' };
    case 'TAB':
      return { kind: 'key', name: 'TAB' };
    case 'UP':
      return { kind: 'key', name: 'UP' };
    case 'DOWN':
      return { kind: 'key', name: 'DOWN' };
    case 'ENTER':
    case 'KP_ENTER':
      return { kind: 'key', name: 'ENTER' };
    case ' ':
      return { kind: 'key', name: 'SPACE' };
    case 'q':
    case 'CTRL_C':
      return { kind: 'key', name: 'QUIT' };
    default:
      // digit hotkeys: '1'..'9' select a tab directly; reduce() ignores
      // indexes past the registered tab count, so this scales with TABS
      if (/^[1-9]$/.test(name)) return { kind: 'tab', index: Number(name) - 1 };
      return undefined;
  }
}

/** Translate terminal-kit mouse events (name + data) to state-layer events. */
export function mouseToEvent(name: string, data: { x: number; y: number }): UiEvent | undefined {
  switch (name) {
    case 'MOUSE_LEFT_BUTTON_PRESSED':
      return { kind: 'click', x: data.x, y: data.y };
    case 'MOUSE_RIGHT_BUTTON_PRESSED':
      return { kind: 'rightclick' };
    case 'MOUSE_WHEEL_UP':
      return { kind: 'wheel', dy: -1 };
    case 'MOUSE_WHEEL_DOWN':
      return { kind: 'wheel', dy: 1 };
    default:
      return undefined;
  }
}
