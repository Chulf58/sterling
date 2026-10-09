// Thin terminal-kit render layer (revised §2.1): prints what the state layer
// derived; owns NOTHING testable. Mouse + key events are translated to the
// state layer's UiEvent vocabulary and fed to reduce().
import { FOOTER_SEPARATOR, type DashboardState, type UiEvent } from './state.js';
import type { BlockPixel, SubagentBlock } from './subagents.js';
import { horizonLabel, sceneLayout, sceneText } from './banner.js';
import { PLAIN_THEME, type Theme } from './theme.js';

// minimal structural types for the slice of terminal-kit we use
export interface AttrLike {
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
  /** a named palette color ('yellow') or a 0–255 256-palette index. A regular
   *  ScreenBuffer is 256-palette only: truecolour goes through the pixel overlay. */
  color?: string | number;
  bgColor?: string | number;
}
export interface ScreenLike {
  width: number;
  height: number;
  fill(options: { attr: AttrLike }): void;
  put(options: { x: number; y: number; attr: AttrLike }, str: string): void;
  draw(options: { delta: boolean }): void;
}

export interface DrawOptions {
  /** the Agents tab's cards, drawn from the top of the body; their portrait
   *  pixels are painted afterwards by paintPixels (truecolour) */
  block?: SubagentBlock;
  /** the colour theme (theme.ts); without one, the plain look */
  theme?: Theme;
}

/** The banner scene as text through the ScreenBuffer (the 16-colour and plain
 *  levels), the project name on the horizon. */
function drawSceneText(screen: ScreenLike, t: Theme, rows: number, projectName: string): void {
  const { horizon } = sceneLayout(rows);
  sceneText(screen.width, rows, '').forEach((text, y) => {
    if (!text) return;
    const attr = y === horizon ? t.sceneHorizon : y > horizon ? t.sceneGrid : t.sceneArt;
    screen.put({ x: 0, y, attr }, text);
  });
  const label = horizonLabel(screen.width, projectName);
  if (label.text) screen.put({ x: label.x, y: horizon, attr: t.name }, label.text);
}

export function draw(screen: ScreenLike, state: DashboardState, opts: DrawOptions = {}): void {
  const t = opts.theme ?? PLAIN_THEME;
  const blockHeight = opts.block?.height ?? 0;
  // The frame is composed off-screen into a ScreenBuffer and delta-drawn:
  // only cells that changed since the previous frame reach the terminal, so
  // an unchanged dashboard writes nothing — no flicker. put() coordinates
  // are 0-based and clip at the buffer edge (no wrap), so a long line can
  // never push the pane into a real scroll.
  screen.fill({ attr: t.fill });
  // rows 0..top: the banner scene over the banner rows and the header row
  // below them, the project folder name written on its horizon, so a glance
  // tells you which project's session this pane observes. With the overlay
  // these cells stay blank and main.ts paints the scene's pixels over them.
  // Suppressed or no room → row 0 is the plain name row and the layout is
  // the one from before the banner. Tabs sit on the next row, the
  // spacer/search bar below that (in sync with bodyTop = top + 3).
  const top = state.banner.length;
  if (top === 0) screen.put({ x: 0, y: 0, attr: t.name }, state.projectName);
  else if (!t.bannerOverlay) drawSceneText(screen, t, top + 1, state.projectName);
  let x = 0;
  for (const tab of state.tabs) {
    const label = ` ${tab.label} `; // x extents must stay in sync with the click mapping in state.ts
    screen.put({ x, y: top + 1, attr: tab.active ? t.tabActive : t.tab }, label);
    x += label.length;
  }
  if (state.searchLine) {
    // the spacer line (row top+2) doubles as the search bar while a query/input is live
    screen.put({ x: 0, y: top + 2, attr: t.search }, state.searchLine);
  }
  // reserve the notice row + footer, and the GitHub strip row while it shows
  // (visibleBodyLines takes the same stripRows, so clicks match)
  const stripRows = state.strip ? 1 : 0;
  const lastBodyLine = screen.height - 3 - stripRows;
  // the Queue tab's pending list stops at its window above the divider;
  // screenLineToRow stops at the same line
  const qc = state.queueCompleted;
  const lastRowLine = qc ? Math.min(lastBodyLine, state.bodyTop + (qc.pendingLines ?? qc.startRow) - 1) : lastBodyLine;
  let y = state.bodyTop; // 0-based rows: header 0, tab bar 1, blank/search 2, body from bodyTop
  if (state.emptyMessage && y <= lastBodyLine) {
    screen.put({ x: 0, y, attr: t.muted }, state.emptyMessage);
    y += 1;
  }
  // draw the body window: skip the first state.scroll body lines (scrolled
  // past), then print until the viewport fills. screenLineToRow inverts the
  // same offset, so the screen and the click hit-test agree by construction.
  let bodyIdx = 0;
  for (const row of state.rows) {
    if (y > lastRowLine) break;
    for (const line of row.lines) {
      if (bodyIdx++ < state.scroll) continue;
      if (y > lastRowLine) break;
      const base = line.kind === 'title' ? t.title(row.selected, row.expanded) : line.kind === 'meta' ? t.muted : t.text;
      // '⚠ ' is the state layer's warning convention (notices, degraded sources)
      const attr = line.text.startsWith('⚠') ? t.warn(base) : base;
      // a selected title is a full-width bar where the theme has one
      const text = line.kind === 'title' && row.selected && t.fullWidthSelection ? line.text.padEnd(screen.width) : line.text;
      screen.put({ x: 0, y, attr }, text);
      y += 1;
    }
  }
  if (qc) {
    // lower-half history (§11): the completed header stays put, and below it
    // the drain-log lines then the ACTIVITY section (board 39d6462d) scroll as
    // one list by qc.scroll. Log lines: dim, never selectable.
    if (qc.overflow) screen.put({ x: 0, y: state.bodyTop + qc.startRow - 1, attr: t.muted }, qc.overflow);
    let cy = state.bodyTop + qc.startRow;
    if (cy <= lastBodyLine) {
      screen.put({ x: 0, y: cy, attr: t.heading }, qc.header);
      cy += 1;
    }
    const history: { text: string; attr: AttrLike }[] = qc.lines.map((text) => ({ text, attr: t.muted }));
    if (state.queueActivity) {
      history.push({ text: state.queueActivity.header, attr: t.heading });
      for (const text of state.queueActivity.lines) history.push({ text, attr: t.muted });
    }
    for (const line of history.slice(qc.scroll ?? 0)) {
      if (cy > lastBodyLine) break;
      screen.put({ x: 0, y: cy, attr: line.attr }, line.text);
      cy += 1;
    }
  }
  if (opts.block && blockHeight > 0) {
    const top = state.bodyTop;
    for (const p of opts.block.puts) screen.put({ x: p.x, y: top + p.y, attr: t.map(p.attr) }, p.text);
  }
  // the notice, the GitHub strip and the footer are pinned to the last rows,
  // below every list: notice, then strip, then footer
  if (state.notice) screen.put({ x: 0, y: screen.height - 2 - stripRows, attr: t.warn({ ...t.text, bold: true }) }, state.notice);
  if (state.strip) {
    const base = state.strip.dim ? t.muted : t.text;
    screen.put({ x: 0, y: screen.height - 2, attr: state.strip.text.startsWith('⚠') ? t.warn(base) : base }, state.strip.text);
  }
  drawFooter(screen, t, state);
  screen.draw({ delta: true });
}

/** The footer in the Now playing app's style: each key in footerKey, each
 *  description and the ' · ' separators in footerDesc. The text is always
 *  state.footer (already clipped to the pane, an ellipsis included); the
 *  segments only say where one attr ends and the next begins. Runs that share
 *  an attr object (16 colours, plain) are one put. */
function drawFooter(screen: ScreenLike, t: Theme, state: DashboardState): void {
  const runs: { len: number; attr: AttrLike }[] = [];
  const add = (len: number, attr: AttrLike): void => {
    const last = runs[runs.length - 1];
    if (last && last.attr === attr) last.len += len;
    else runs.push({ len, attr });
  };
  state.footerSegments.forEach((seg, i) => {
    if (i > 0) add(FOOTER_SEPARATOR.length, t.footerDesc);
    if (seg.key) add(seg.key.length, t.footerKey);
    if (seg.desc) add(seg.desc.length + (seg.key ? 1 : 0), t.footerDesc);
  });
  const y = screen.height - 1;
  let x = 0;
  for (const run of runs) {
    const text = state.footer.slice(x, x + run.len);
    if (text === '') break;
    screen.put({ x, y, attr: run.attr }, text);
    x += text.length;
  }
  // an ellipsis the clip added past the last run keeps the description colour
  if (x < state.footer.length) screen.put({ x, y, attr: t.footerDesc }, state.footer.slice(x));
}

/** The slice of terminal-kit's Terminal that paints a truecolour cell. */
export interface PixelTerm {
  moveTo(x: number, y: number): unknown;
  colorRgbHex(hex: string): unknown;
  bgColorRgbHex(hex: string): unknown;
  styleReset(): unknown;
  noFormat(str: string): unknown;
}

/** Blank the cells of a previous paint that the next one no longer covers.
 *  Run it BEFORE the buffer's delta draw: those cells are blank in the buffer
 *  on both frames, so the delta draw would leave the old pixels on screen,
 *  while a cell that now holds text differs from the buffer's last frame and
 *  is rewritten by the delta draw. (A full, non-delta draw is no substitute:
 *  terminal-kit repaints every line again on the delta draw after it, which
 *  wipes portraits the animation only patches.) blankSgr is the theme's page
 *  background ('' leaves the terminal's own). */
export function clearPixels(term: PixelTerm, prev: ReadonlyMap<string, string>, next: readonly BlockPixel[], blankSgr = ''): void {
  const keep = new Set(next.map((p) => `${p.x},${p.y}`));
  let wrote = false;
  for (const key of prev.keys()) {
    if (keep.has(key)) continue;
    const [x, y] = key.split(',').map(Number) as [number, number];
    if (!wrote) {
      term.styleReset();
      if (blankSgr) term.noFormat(blankSgr);
    }
    term.moveTo(x + 1, y + 1);
    term.noFormat(' ');
    wrote = true;
  }
}

function sgr24(hex: string, background: boolean): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[${background ? 48 : 38};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Paint portrait pixels (0-based screen coordinates) straight to the
 *  terminal with 24-bit colour: the ScreenBuffer is 256-palette only. Those
 *  cells hold blank spaces in the buffer, so its delta draw leaves them alone.
 *  With `prev` (the map this function returned last time) only changed cells
 *  are written; without it every pixel is. A pixel with no bg is written on
 *  blankSgr, the theme's page background ('' is the terminal's default), so
 *  transparency shows the page behind it.
 *  trueColor writes the 24-bit SGR itself; otherwise terminal-kit's
 *  colorRgbHex picks the nearest colour its terminal detection allows. */
export function paintPixels(term: PixelTerm, pixels: readonly BlockPixel[], prev?: ReadonlyMap<string, string>, trueColor = false, blankSgr = ''): Map<string, string> {
  const next = new Map<string, string>();
  let wrote = false;
  for (const p of pixels) {
    const key = `${p.x},${p.y}`;
    const sig = `${p.ch}|${p.fg ?? ''}|${p.bg ?? ''}`;
    next.set(key, sig);
    if (prev?.get(key) === sig) continue;
    term.styleReset();
    term.moveTo(p.x + 1, p.y + 1);
    if (p.bg === undefined && blankSgr) term.noFormat(blankSgr);
    if (p.fg !== undefined) {
      if (trueColor) term.noFormat(sgr24(p.fg, false));
      else term.colorRgbHex(p.fg);
    }
    if (p.bg !== undefined) {
      if (trueColor) term.noFormat(sgr24(p.bg, true));
      else term.bgColorRgbHex(p.bg);
    }
    term.noFormat(p.ch);
    wrote = true;
  }
  if (wrote) term.styleReset();
  return next;
}

/** The rows `scroll .. scroll + height - 1` of a card block composed at full
 *  height, moved up to row 0: the Agents tab's scroll window. Text and pixels
 *  outside the window are dropped, so nothing is drawn over the notice or
 *  the footer. */
export function windowBlock(block: SubagentBlock, scroll: number, height: number): SubagentBlock {
  const inside = (y: number): boolean => y >= scroll && y < scroll + height;
  return {
    height: Math.max(0, Math.min(height, block.height - scroll)),
    puts: block.puts.filter((p) => inside(p.y)).map((p) => ({ ...p, y: p.y - scroll })),
    pixels: block.pixels.filter((p) => inside(p.y)).map((p) => ({ ...p, y: p.y - scroll })),
  };
}

/** Translate terminal-kit key names to state-layer events. Printable keys
 *  travel as chars — the state layer decides per mode (search input vs 'q'
 *  quit vs digit hotkeys vs '/'); named keys cover navigation/control. */
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
    case 'ESCAPE':
      return { kind: 'key', name: 'ESCAPE' };
    case 'BACKSPACE':
      return { kind: 'key', name: 'BACKSPACE' };
    case 'CTRL_C':
      return { kind: 'key', name: 'QUIT' };
    case 'CTRL_F':
      return { kind: 'key', name: 'STATE_FILTER' };
    case 'PAGE_UP':
    case 'PAGE_DOWN':
    case 'HOME':
    case 'END':
      return { kind: 'key', name };
    case 'F1':
      return { kind: 'key', name: 'HELP' };
    default:
      if (name.length === 1 && name >= ' ') return { kind: 'char', ch: name };
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
      return { kind: 'wheel', dy: -1, y: data.y };
    case 'MOUSE_WHEEL_DOWN':
      return { kind: 'wheel', dy: 1, y: data.y };
    default:
      return undefined;
  }
}
