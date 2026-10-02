// Pure pieces of the OpenCode dashboard: the sidebar summary, the key
// translation into the terminal TUI's UiEvent vocabulary, and store discovery. tui.tsx draws them; nothing here
// touches OpenCode or the screen, so node --test covers it.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boardDisplayLabel } from '@sterling/schemas';
import type { SterlingStore } from '@sterling/store';
import { KNOWLEDGE_TAB, type UiEvent, type UiState } from '@sterling/tui/dist/state.js';

/** OpenCode 2.0.21's sidebar content width, measured: a session title wraps at 34 columns. */
export const SIDEBAR_WIDTH = 34;
const TOP_TASKS = 5;
const QUEUE_CAP = 1000;

export type Guarded<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run one store or config access; a throw becomes an error value the panel
 *  prints as a line instead of crashing (the panel shares OpenCode's process). */
export function guarded<T>(what: string, read: () => T): Guarded<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    return { ok: false, error: `${what} unavailable — ${(err as Error)?.message ?? String(err)}` };
  }
}

export interface SidebarSummary {
  open: number;
  high: number;
  blocked: number;
  top: { label: string; id: string }[];
  queue: number;
  /** a count of QUEUE_CAP or more is shown with a '+' */
  queueCapped?: boolean;
  notices: string[];
}

export function readSidebarSummary(store: SterlingStore): SidebarSummary {
  const todos = store.query({ types: ['todo'], source: 'user', cap: 500 }) as unknown as { id: string; text: string; slug?: string; priority?: string; blocked_by?: string[] }[];
  // a blocker is open while a live board item still carries its slug (viewmodel.ts todoCards)
  const isBlocked = (t: { blocked_by?: string[] }) => (t.blocked_by ?? []).some((slug) => store.recordsBySlug(slug).some((r) => r.type === 'todo'));
  const ranked = [...todos].sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high'));
  const queue = store.query({ types: ['todo'], source: 'system', cap: QUEUE_CAP }).length;
  return {
    open: todos.length,
    high: todos.filter((t) => t.priority === 'high').length,
    blocked: todos.filter(isBlocked).length,
    top: ranked.slice(0, TOP_TASKS).map((t) => ({ label: boardDisplayLabel(t.text, t.slug), id: t.id })),
    queue,
    queueCapped: queue >= QUEUE_CAP,
    notices: [],
  };
}

function clip(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

/** `label (id8)`: the label clips, the id8 never does (names clip, ids never do). */
function handle(label: string, id: string, width: number): string {
  const suffix = ` (${id.slice(0, 8)})`;
  return clip(label, width - suffix.length) + suffix;
}

export function sidebarLines(s: SidebarSummary, width = SIDEBAR_WIDTH): string[] {
  const lines: string[] = [];
  if (s.open === 0) lines.push('No open tasks');
  else lines.push(clip(`Tasks: ${s.open} open · ${s.high} high · ${s.blocked} blocked`, width));
  for (const t of s.top) lines.push(handle(`  ${t.label}`, t.id, width));
  lines.push(clip(`Queue ${s.queue}${s.queueCapped ? '+' : ''} waiting`, width));
  for (const n of s.notices) lines.push(clip(`! ${n}`, width));
  return lines;
}

/** The slice of OpenTUI's KeyEvent the dashboard reads. */
export interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Translate an OpenTUI key event into the terminal TUI's UiEvent vocabulary,
 *  so reduce() handles OpenCode keys exactly as it handles terminal-kit keys.
 *  Ctrl and meta chords are left to OpenCode (its palette, its quit). */
export function keyToUiEvent(key: KeyLike): UiEvent | undefined {
  if (key.ctrl || key.meta) return undefined;
  switch (key.name) {
    case 'up': return { kind: 'key', name: 'UP' };
    case 'down': return { kind: 'key', name: 'DOWN' };
    case 'left': return { kind: 'key', name: 'LEFT' };
    case 'right': return { kind: 'key', name: 'RIGHT' };
    case 'tab': return { kind: 'key', name: key.shift ? 'LEFT' : 'TAB' };
    case 'return':
    case 'enter': return { kind: 'key', name: 'ENTER' };
    case 'escape': return { kind: 'key', name: 'ESCAPE' };
    case 'backspace': return { kind: 'key', name: 'BACKSPACE' };
  }
  const ch = key.sequence ?? '';
  if (ch.length === 1 && ch >= ' ' && ch !== '\x7f') return { kind: 'char', ch };
  return undefined;
}

/** Esc leaves the full view only when it has nothing of its own to cancel:
 *  an open board edit, model picker, sparring-model edit, or Knowledge query
 *  takes the Esc first, as it does in the terminal TUI. */
export function escapeLeavesView(ui: UiState): boolean {
  if (ui.boardEdit || ui.selector || ui.sparringModelEdit !== undefined) return false;
  if (ui.tab === KNOWLEDGE_TAB && ui.searchQuery) return false;
  return true;
}

/** STERLING_STORE when set; otherwise the nearest <dir>/.sterling/sterling.db
 *  walking up from `start`. Undefined when there is none. */
export function findStorePath(start: string, env: Record<string, string | undefined>): string | undefined {
  if (env.STERLING_STORE) return env.STERLING_STORE;
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.sterling', 'sterling.db');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
