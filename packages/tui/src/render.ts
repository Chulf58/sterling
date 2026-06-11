// Thin terminal-kit render layer (revised §2.1): prints what the state layer
// derived; owns NOTHING testable. Mouse + key events are translated to the
// state layer's UiEvent vocabulary and fed to reduce().
import type { DashboardState, UiEvent } from './state.js';

// minimal structural type for the slice of terminal-kit we use
export interface TermLike {
  width: number;
  height: number;
  moveTo(x: number, y: number): TermLike;
  (s: string): TermLike;
  inverse(s: string): TermLike;
  bold(s: string): TermLike;
  dim(s: string): TermLike;
  yellow(s: string): TermLike;
  eraseLineAfter(): TermLike;
  eraseDisplayBelow(): TermLike;
}

export function draw(term: TermLike, state: DashboardState): void {
  // No full-screen clear: ESC[2J scrolls the viewport into scrollback on
  // Windows Terminal and blanks the frame mid-redraw (flicker). Instead each
  // line is overwritten in place + eraseLineAfter, and the remainder of the
  // screen is erased once at the end. Text is clipped to the pane width — a
  // wrapped line on the bottom row would force a real scroll.
  const fit = (s: string, used = 0): string => s.slice(0, Math.max(0, term.width - used));
  const lastBodyLine = term.height - 2; // reserve the blank line + footer
  term.moveTo(1, 1);
  let x = 0;
  for (const tab of state.tabs) {
    const label = ` ${tab.label} `; // x extents must stay in sync with the click mapping in state.ts
    const clipped = fit(label, x);
    if (tab.active) term.inverse(clipped);
    else term(clipped);
    x += label.length;
  }
  term.eraseLineAfter();
  let line = state.bodyTop + 1; // 1-based terminal lines
  if (state.emptyMessage && line <= lastBodyLine) {
    term.moveTo(1, line).dim(fit(state.emptyMessage)).eraseLineAfter();
    line += 1;
  }
  for (const row of state.rows) {
    if (line > lastBodyLine) break;
    term.moveTo(1, line);
    const text = `${row.selected ? '› ' : '  '}${row.text}`;
    if (row.selected) term.inverse(fit(text));
    else term(fit(text));
    term.eraseLineAfter();
    line += 1;
    if (row.detail && line <= lastBodyLine) {
      term.moveTo(1, line).dim(fit(`    ${row.detail}`)).eraseLineAfter();
      line += 1;
    }
  }
  if (state.run && line <= lastBodyLine) {
    term.moveTo(1, line);
    const head = `run ${state.run.id} — `;
    term(fit(head)).bold(fit(state.run.machine_state, head.length));
    term(fit(` · ${state.run.phaseLabel}`, head.length + state.run.machine_state.length)).eraseLineAfter();
    line += 1;
    if (line <= lastBodyLine) {
      term.moveTo(1, line)(fit(`last signal: ${state.run.lastSignal} · context warns: ${state.run.warnFlags}`)).eraseLineAfter();
      line += 1;
    }
    if (state.run.pendingJudgment && line <= lastBodyLine) {
      term.moveTo(1, line).yellow(fit(`pending judgment: ${state.run.pendingJudgment}`)).eraseLineAfter();
      line += 1;
    }
  }
  term.moveTo(1, line).eraseDisplayBelow();
  term.moveTo(1, Math.min(line + 1, term.height)).dim(fit(state.footer));
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
