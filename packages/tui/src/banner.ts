// The §11 banner: a synthwave sunset scene (decision
// tui-synthwave-theme-sunset-banner-project-name-on-horizon). A striped sun
// (yellow to orange to hot pink, dark bands across its lower half) behind the
// chrome STERLING wordmark, a cyan horizon line carrying the project name, and
// a magenta perspective grid below it. 8 rows; 4 rows (the compact sunset)
// when the pane is shorter than COMPACT_BELOW_HEIGHT or narrower than the art.
//
// The wordmark art is the one the H1 SessionStart hook prints
// (scripts/hooks/h1-session-start.mjs BANNER_ROWS), duplicated rather than
// imported: the hook is a standalone bundled .mjs with no workspace imports
// (invariant 4). If the wordmark changes, change both.
//
// Geometry: state.ts derives bodyTop = bannerLines(...).length + 3, counting
// one row below the banner as the project-name header. The scene covers that
// header row too, so a scene is bannerLines(...).length + 1 rows tall and the
// name is written on its horizon instead of on a row of its own. With the
// banner suppressed or no room for it, the header row is a plain name row as
// before. Everything here is pure; colour levels are theme.ts's concern.

/** Full 3-row block-letter wordmark (fixed-width; fits the 35% split pane). */
export const BANNER_ROWS = [
  '▄▀▀ ▀█▀ █▀▀ █▀▄ █   ▀█▀ █▄ █ ▄▀▀▄',
  '▀▀▄  █  █▀▀ █▀▄ █    █  █ ▀█ █ ▄▄',
  '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀',
] as const;

/** 1-line wordmark for the compact scene. */
export const WORDMARK = 'STERLING';
/** the compact scene's wordmark when the pane has room for it */
export const SPACED_WORDMARK = 'S T E R L I N G';

/** Columns the full art needs (≈33); a narrower pane gets the compact scene. */
export const ART_WIDTH = Math.max(...BANNER_ROWS.map((r) => r.length));

export const FULL_SCENE_ROWS = 8;
export const COMPACT_SCENE_ROWS = 4;
/** panes shorter than this get the compact scene, so the lists keep their room */
export const COMPACT_BELOW_HEIGHT = 24;

/** The scene's rows for a pane: 0 (no room even for the 1-line wordmark),
 *  COMPACT_SCENE_ROWS or FULL_SCENE_ROWS. */
export function sceneRows(width: number, height = Infinity): number {
  if (!(width >= WORDMARK.length)) return 0;
  if (width < ART_WIDTH || height < COMPACT_BELOW_HEIGHT) return COMPACT_SCENE_ROWS;
  return FULL_SCENE_ROWS;
}

/** Where the scene's parts sit: sun rows from 0, the horizon row, grid rows after it. */
export function sceneLayout(rows: number): { sunRows: number; horizon: number; gridRows: number } {
  return rows >= FULL_SCENE_ROWS ? { sunRows: 4, horizon: 4, gridRows: 3 } : { sunRows: 2, horizon: 2, gridRows: 1 };
}

const textWidth = (width: number): number => (Number.isFinite(width) ? Math.floor(width) : ART_WIDTH);

/**
 * The banner rows above the header row, as monochrome text (the scene minus
 * its last row, see Geometry above):
 *   show=false                 → []  (suppressed; layout = no banner)
 *   width < WORDMARK.length    → []  (no room)
 *   else                       → sceneRows(width, height) - 1 rows
 * state.ts derives bodyTop from .length; the renderer draws the scene.
 */
export function bannerLines(width: number, show: boolean, height = Infinity): string[] {
  if (!show) return [];
  const rows = sceneRows(width, height);
  if (rows === 0) return [];
  return sceneText(textWidth(width), rows, '').slice(0, rows - 1);
}

/** The project name's place on the horizon: centred between line segments,
 *  or clipped from the left edge when the pane is too narrow for that. */
export function horizonLabel(width: number, name: string): { x: number; text: string } {
  if (!name) return { x: 0, text: '' };
  const label = ` ${name} `;
  if ([...label].length >= width) return { x: 0, text: [...name].slice(0, Math.max(0, width)).join('') };
  return { x: Math.floor((width - [...label].length) / 2), text: label };
}

function wordmarkFor(width: number, rows: number): { row: number; x: number; lines: readonly string[] } {
  if (rows >= FULL_SCENE_ROWS) return { row: 1, x: Math.floor((width - ART_WIDTH) / 2), lines: BANNER_ROWS };
  const text = width >= SPACED_WORDMARK.length ? SPACED_WORDMARK : WORDMARK;
  return { row: 1, x: Math.floor((width - text.length) / 2), lines: [text] };
}

// ---------------------------------------------------------------------------
// Pixels. The sun and the grid are drawn in half-cell pixels: a cell is two
// pixels stacked, shown as '▀' with the upper pixel as fg and the lower as bg.
// A pixel is about as wide as it is tall, so circles stay round.
// ---------------------------------------------------------------------------

const SUN_STOPS = ['#ffd319', '#ff901f', '#ff2975'] as const;
const SKY_STOPS = ['#00005f', '#3a0a6e', '#a0207e'] as const;
/** the chrome wordmark, one colour per pixel row of the 3-row art (6 pixel rows) */
export const CHROME = ['#ffffff', '#c8f4ff', '#6fd3ff', '#2a3fbf', '#9ee6ff', '#f0fbff'] as const;
const GROUND_STOPS = ['#2b0057', '#00005f'] as const;
const GRID = '#ff2bd6';
/** a letter's colour over the sun */
const SUN_INK = '#2b0057';
const HORIZON_LINE = '#00e5ff';
const NAME_FG = '#ffffff';

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A colour at t ∈ [0,1] along evenly spaced stops. */
export function lerpStops(stops: readonly string[], t: number): string {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const pos = u * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const [a, b] = [rgbOf(stops[i]!), rgbOf(stops[i + 1]!)];
  return `#${a.map((v, k) => Math.round(v + (b[k]! - v) * f).toString(16).padStart(2, '0')).join('')}`;
}

const frac = (y: number, n: number): number => (n <= 1 ? 0 : y / (n - 1));

/** The sun's colour at pixel (x, y), or undefined where the sky shows. n is the
 *  sun area's pixel rows; the sun's centre sits one row below the horizon, and
 *  it is half again as wide as it is tall so more of it shows around the wordmark. */
function sunPixel(x: number, y: number, n: number, cx: number): string | undefined {
  const r = n + 1;
  const dy = y + 0.5 - r;
  const dx = (x - cx) / 1.5;
  if (dx * dx + dy * dy > r * r) return undefined;
  // the dark bands: every other pixel row of the lower half
  if (y >= n / 2 && (y - n / 2) % 2 === 1) return undefined;
  return lerpStops(SUN_STOPS, frac(y, n));
}

/** The gap between neighbouring grid rays at pixel row y below the horizon:
 *  6 cells at the horizon, widening with depth. The vanishing point sits above
 *  the scene, so a ray leans a few cells per row instead of lying almost flat. */
function raySpacing(y: number, g: number): number {
  return 6 + (y * 6) / g;
}

/** Whether grid pixel (x, y) is on a line; y counts down from the horizon. The
 *  vertical lines are rays from the horizon's centre: their spacing grows with
 *  the distance below it. The horizontal lines spread out toward the viewer. */
function gridLine(x: number, y: number, g: number, cx: number): { h: boolean; v: boolean } {
  const h = g >= 6 ? y === 2 || y === 5 : y === g - 1;
  // one pixel per ray per row: a filled span would turn the outer, flatter
  // rays into solid bars in a grid this shallow
  const s = raySpacing(y, g);
  return { h, v: Math.round(cx + Math.round((x - cx) / s) * s) === x };
}

/** One overlay cell of the scene, in 0-based scene coordinates. */
export interface ScenePixel {
  x: number;
  y: number;
  ch: string;
  fg?: string;
  bg?: string;
}

function pairCell(x: number, y: number, top: string, bottom: string): ScenePixel {
  return top === bottom ? { x, y, ch: ' ', bg: top } : { x, y, ch: '▀', fg: top, bg: bottom };
}

/** The coloured scene: every cell of `rows` x `width`, each with a bg, for the
 *  pixel overlay. The project name is written on the horizon row. */
export function scenePixels(width: number, rows: number, projectName: string): ScenePixel[] {
  const w = textWidth(width);
  if (rows <= 0 || w < 1) return [];
  const { sunRows, horizon, gridRows } = sceneLayout(rows);
  const cx = Math.floor(w / 2);
  const n = sunRows * 2;
  const mark = wordmarkFor(w, rows);
  const out: ScenePixel[] = [];
  // sky, sun and (full scene) the chrome art, pixel by pixel
  const skyPixel = (x: number, y: number): string => {
    if (rows >= FULL_SCENE_ROWS) {
      const artY = y - mark.row * 2;
      const ch = mark.lines[Math.floor(artY / 2)]?.[x - mark.x];
      if (artY >= 0 && ch !== undefined && (artY % 2 === 0 ? '▀█' : '▄█').includes(ch)) return CHROME[artY]!;
    }
    return sunPixel(x, y, n, cx) ?? lerpStops(SKY_STOPS, frac(y, n));
  };
  for (let row = 0; row < sunRows; row++) {
    for (let x = 0; x < w; x++) out.push(pairCell(x, row, skyPixel(x, row * 2), skyPixel(x, row * 2 + 1)));
  }
  if (rows < FULL_SCENE_ROWS) {
    // the compact wordmark is text: each letter on the cell's upper pixel, dark
    // over the sun and chrome white over the sky
    const line = mark.lines[0]!;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ') continue;
      const x = mark.x + i;
      if (x < 0 || x >= w) continue;
      const bg = skyPixel(x, mark.row * 2);
      const fg = sunPixel(x, mark.row * 2, n, cx) === undefined ? CHROME[0] : SUN_INK;
      out[mark.row * w + x] = { x, y: mark.row, ch: line[i]!, fg, bg };
    }
  }
  // the horizon: a cyan line with the project name on it
  const ground = GROUND_STOPS[0];
  const label = horizonLabel(w, projectName);
  const labelChars = [...label.text];
  for (let x = 0; x < w; x++) {
    const li = x - label.x;
    const ch = li >= 0 && li < labelChars.length ? labelChars[li]! : undefined;
    out.push(ch === undefined ? { x, y: horizon, ch: '━', fg: HORIZON_LINE, bg: ground } : { x, y: horizon, ch, fg: NAME_FG, bg: ground });
  }
  // the grid, fading into the page background at its bottom
  const g = gridRows * 2;
  const gridPixel = (x: number, y: number): string => {
    const { h, v } = gridLine(x, y, g, cx);
    return h || v ? GRID : lerpStops(GROUND_STOPS, frac(y, g));
  };
  for (let row = 0; row < gridRows; row++) {
    for (let x = 0; x < w; x++) out.push(pairCell(x, horizon + 1 + row, gridPixel(x, row * 2), gridPixel(x, row * 2 + 1)));
  }
  return out;
}

/** The scene as monochrome text (no sun: it is a colour, not a shape): the
 *  wordmark, the horizon as '─' with the name on it, and the grid's rays.
 *  Trailing spaces are trimmed. */
export function sceneText(width: number, rows: number, projectName: string): string[] {
  const w = textWidth(width);
  if (rows <= 0 || w < 1) return [];
  const { horizon, gridRows } = sceneLayout(rows);
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(w).fill(' '));
  const mark = wordmarkFor(w, rows);
  mark.lines.forEach((line, i) => [...line].forEach((ch, k) => {
    const x = mark.x + k;
    if (x >= 0 && x < w) grid[mark.row + i]![x] = ch;
  }));
  grid[horizon]!.fill('─');
  const label = horizonLabel(w, projectName);
  [...label.text].forEach((ch, k) => (grid[horizon]![label.x + k] = ch));
  const cx = Math.floor(w / 2);
  const g = gridRows * 2;
  for (let row = 0; row < gridRows; row++) {
    // one character per ray per text row, at the ray's x mid-row
    const s = raySpacing(row * 2 + 1, g);
    for (let k = -Math.ceil(cx / s); k <= Math.ceil((w - cx) / s); k++) {
      const x = Math.round(cx + k * s);
      if (x >= 0 && x < w) grid[horizon + 1 + row]![x] = k < 0 ? '╱' : k > 0 ? '╲' : '│';
    }
  }
  return grid.map((cells) => cells.join('').trimEnd());
}
