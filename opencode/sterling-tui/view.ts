// Pure pieces of the OpenCode dashboard: the sidebar summary, the key
// translation into the terminal TUI's UiEvent vocabulary, and store discovery. tui.tsx draws them; nothing here
// touches OpenCode or the screen, so node --test covers it.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boardDisplayLabel } from '@sterling/schemas';
import type { SterlingStore } from '@sterling/store';
import { KNOWLEDGE_TAB, type UiEvent, type UiState } from '@sterling/tui/dist/state.js';
import { assign, frameAt, phaseFor, tileCells, POOL_SIZE, SPRITE_ROWS, TILE_COLS, DONE_FADE, fadeToTile, type AssignState } from '@sterling/tui/dist/avatars/index.js';
import { storeBackend } from '../../scripts/hooks/lib/store-backend.mjs';

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
  return tagged(label, id.slice(0, 8), width);
}

function tagged(label: string, tag: string, width: number): string {
  const suffix = ` (${tag})`;
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

export interface ModelRefLike {
  id: string;
  providerID: string;
}

export interface TokenUsageLike {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** The slice of OpenCode 2's SessionInfo the sub-agent rows read. */
export interface SubagentSession {
  id: string;
  parentID?: string;
  title?: string;
  model?: ModelRefLike;
}

/** What readSubagents needs from OpenCode's data layer, as plain callbacks. */
export interface SubagentSource {
  sessions: readonly SubagentSession[];
  /** the root session whose descendants are the sub-agents */
  rootID: string;
  isRunning(id: string): boolean;
  /** the session's latest assistant turn, when it has one */
  lastTurn(id: string): { tokens?: TokenUsageLike; model?: ModelRefLike } | undefined;
  /** the model's context window in tokens */
  contextLimit(model: ModelRefLike): number | undefined;
}

export interface SubagentRow {
  id: string;
  title: string;
  status: 'active' | 'idle';
  /** '42%' of the model's context window, or '?' when either side is unknown */
  context: string;
  model: string;
  /** a one-line description of the task, shown on the third line when the host supplies one */
  description?: string;
}

/** The distinguishing end of an OpenCode session id: ids are time-ordered, so
 *  the leading characters repeat across sessions created close together. */
function shortId(id: string): string {
  return id.slice(-8);
}

/** Every session under `rootID` by parentID, nested sub-agents included.
 *  Verified live: a child's SessionInfo carries parentID (finding 8f10e0be), so
 *  this needs no per-session request. `seen` also stops a parent cycle. */
function descendants(sessions: readonly SubagentSession[], rootID: string): SubagentSession[] {
  const out: SubagentSession[] = [];
  const seen = new Set<string>([rootID]);
  let frontier = [rootID];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of sessions) {
      if (s.parentID && frontier.includes(s.parentID) && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
        next.push(s.id);
      }
    }
    frontier = next;
  }
  return out;
}

/** Sub-agent rows for the session tree under `rootID`, running ones first. */
export function readSubagents(src: SubagentSource): SubagentRow[] {
  const rows = descendants(src.sessions, src.rootID).map((s) => {
    const turn = src.lastTurn(s.id);
    const model = turn?.model ?? s.model;
    const t = turn?.tokens;
    const limit = model ? src.contextLimit(model) : undefined;
    const used = t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : undefined;
    const title = s.title?.trim();
    return {
      id: s.id,
      title: title ? title : shortId(s.id),
      status: src.isRunning(s.id) ? ('active' as const) : ('idle' as const),
      context: used !== undefined && limit && limit > 0 ? `${Math.round((used / limit) * 100)}%` : '?',
      model: model?.id ?? '-',
    };
  });
  // Array.prototype.sort is stable, so each group keeps the session list's order
  return rows.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
}

/** One run of text in one style. `dim` asks for the host's muted colour; `fg`
 *  and `bg` are hex colours, unset meaning the host's own (transparent). */
export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  dim?: boolean;
}
/** One screen line as styled runs; the host draws them left to right. */
export type SpanLine = Span[];

/** A portrait's size: the 6x3 half-block sprite on its tile, one padding column each side. */
export const PORTRAIT_WIDTH = TILE_COLS;
export const PORTRAIT_HEIGHT = SPRITE_ROWS;
/** Columns the text beside a portrait needs (the model name is the long one); narrower puts the text underneath. */
const SIDE_TEXT_MIN = 16;
const GAP = 1;

/** Board rows the full view's Tasks body may show. Above the body sit the
 *  header, tab bar and spacer; below it the sub-agent block (`extraLines`),
 *  the blank, footer and Esc hint. The controller scrolls its window by this
 *  number, so it must be as short as the body really is or the cursor falls
 *  below the visible rows. */
export function bodyLinesFor(terminalHeight: number, extraLines: number): number {
  return Math.max(3, terminalHeight - 8 - extraLines);
}

/** The avatar assignment kept for one session tree for the plugin's lifetime. */
export type AvatarState = AssignState;
export const emptyAvatars = (): AvatarState => ({ current: new Map(), freed: [] });

/** Next assignment for the sub-agents under a root: a child that is still in
 *  the family (running, warm or idle) keeps its portrait; one that left frees
 *  its portrait for later arrivals. Pure; the caller stores the result. */
export function stepAvatars(prev: AvatarState, familyIds: readonly string[], rng: () => number): AvatarState {
  return assign(familyIds, prev.current, rng, { poolSize: POOL_SIZE, freed: prev.freed });
}

/** A portrait on its tinted tile, no drawn frame: the sprite as half blocks
 *  with a fg and bg span per colour run. Every span carries a bg (the tile
 *  colour wherever a pixel is transparent), so nothing is left unset. An idle
 *  agent's portrait is faded toward the tile colour, the same fade the Claude
 *  Code dashboard gives a done agent; only a running one keeps its full colour. */
export function portraitLines(avatar: number, frame: number, status: SubagentRow['status'] = 'active'): SpanLine[] {
  const shade = (hex: string | undefined) => (hex !== undefined && status === 'idle' ? fadeToTile(hex, DONE_FADE) : hex);
  return tileCells(avatar, frame).map((row) => {
    const line: SpanLine = [];
    for (const c of row) {
      const fg = shade(c.fg);
      const bg = shade(c.bg);
      const last = line[line.length - 1];
      if (last && last.fg === fg && last.bg === bg) last.text += c.ch;
      else line.push({ text: c.ch, fg, bg });
    }
    return line;
  });
}

/** The text of a row: title, `status · N% ctx · model`, description, each clipped to `width`. */
function rowText(r: SubagentRow, width: number): SpanLine[] {
  return [
    [{ text: clip(r.title, width) }],
    [{ text: clip(`${r.status} · ${r.context} ctx · ${r.model}`, width), dim: true }],
    [{ text: clip(r.description ?? '', width), dim: true }],
  ];
}

/** One sub-agent row: the tile on the left with the three text lines beside it,
 *  or the text under the tile when `width` cannot hold both. No avatar number is shown. */
export function subagentRowLines(r: SubagentRow, avatar: number, tick: number, width: number): SpanLine[] {
  const portrait = portraitLines(avatar, frameAt(tick, phaseFor(avatar), r.status === 'active'), r.status);
  const sideWidth = width - PORTRAIT_WIDTH - GAP;
  if (sideWidth < SIDE_TEXT_MIN) return [...portrait, ...rowText(r, width)];
  const text = rowText(r, sideWidth);
  return portrait.map((line, i) => [...line, { text: ' '.repeat(GAP) }, ...text[i]!]);
}

/** The sub-agent block: a heading with the active count, then a portrait row
 *  per sub-agent, a blank line between rows so the tiles do not run together. `avatars` maps session id to pool index; a row without one
 *  (it should not happen) falls back to index 0 rather than dropping the row. */
export function subagentSpanLines(rows: readonly SubagentRow[], avatars: ReadonlyMap<string, number>, tick: number, width = SIDEBAR_WIDTH): SpanLine[] {
  const active = rows.filter((r) => r.status === 'active').length;
  const lines: SpanLine[] = [[{ text: `Sub-agents (${active} active)` }]];
  if (rows.length === 0) return [...lines, [{ text: 'no sub-agents', dim: true }]];
  rows.forEach((r, i) => {
    if (i > 0) lines.push([]);
    lines.push(...subagentRowLines(r, avatars.get(r.id) ?? 0, tick, width));
  });
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
 *  walking up from `start`, where <dir> holds that file or is a Postgres-storage
 *  project. Undefined when there is none. */
export function findStorePath(start: string, env: Record<string, string | undefined>): string | undefined {
  if (env.STERLING_STORE) return env.STERLING_STORE;
  let dir = start;
  for (;;) {
    // A Postgres-storage project has a config and no SQLite file. The returned
    // path then only names the project for openDashboard, which opens it
    // through the router. A SQLite project is found by its file, as before.
    const candidate = join(dir, '.sterling', 'sterling.db');
    if (existsSync(candidate) || (existsSync(join(dir, '.sterling', 'config.json')) && storeBackend(dir) === 'routed')) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
