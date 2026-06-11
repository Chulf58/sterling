// Thin terminal-kit render layer (revised §2.1): prints what the state layer
// derived; owns NOTHING testable. Mouse + key events are translated to the
// state layer's UiEvent vocabulary and fed to reduce().
import type { DashboardState, UiEvent } from './state.js';

// minimal structural type for the slice of terminal-kit we use
export interface TermLike {
  clear(): void;
  moveTo(x: number, y: number): TermLike;
  (s: string): TermLike;
  inverse(s: string): TermLike;
  bold(s: string): TermLike;
  dim(s: string): TermLike;
  yellow(s: string): TermLike;
}

export function draw(term: TermLike, state: DashboardState): void {
  term.clear();
  term.moveTo(1, 1);
  for (const tab of state.tabs) {
    const label = ` ${tab.label} `;
    if (tab.active) term.inverse(label);
    else term(label);
  }
  let line = state.bodyTop + 1; // 1-based terminal lines
  if (state.emptyMessage) {
    term.moveTo(1, line).dim(state.emptyMessage);
    line += 1;
  }
  for (const row of state.rows) {
    term.moveTo(1, line);
    const text = `${row.selected ? '› ' : '  '}${row.text}`;
    if (row.selected) term.inverse(text);
    else term(text);
    line += 1;
    if (row.detail) {
      term.moveTo(1, line).dim(`    ${row.detail}`);
      line += 1;
    }
  }
  if (state.run) {
    term.moveTo(1, line);
    term(`run ${state.run.id} — `).bold(state.run.machine_state)(` · ${state.run.phaseLabel}`);
    line += 1;
    term.moveTo(1, line)(`last signal: ${state.run.lastSignal} · context warns: ${state.run.warnFlags}`);
    line += 1;
    if (state.run.pendingJudgment) {
      term.moveTo(1, line).yellow(`pending judgment: ${state.run.pendingJudgment}`);
      line += 1;
    }
  }
  term.moveTo(1, line + 1).dim(state.footer);
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
