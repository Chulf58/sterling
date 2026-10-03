// Host-neutral avatar sprites: pure data and functions, no terminal library.
// Each avatar is 12x6 pixels in 4 frames (0 rest, 1 blink, 2 bob, 3 tilt). A terminal cell shows a
// 2x2 block of pixels with one Unicode quadrant character and two colours, so a sprite is 3 rows of
// 6 cells, the height of the three text lines beside it. The pool holds at most 2 colours per block.
import pool from './pool.json' with { type: 'json' };

export const POOL_SIZE: number = pool.avatars.length;
export const SPRITE_ROWS = 3;
export const SPRITE_COLS = 6;
/** The portrait sits on a tinted square tile: one padding column each side, so 8 cols by 3 rows. */
export const TILE_PAD = 1;
export const TILE_COLS = SPRITE_COLS + 2 * TILE_PAD;
/** Slightly lighter than a dark panel, so the portrait reads as a tile without a drawn frame. */
export const TILE_BG = '#2a2e37';
export const FRAME_COUNT = 4;

/** One terminal cell: a quadrant block character (or space) drawn in fg over bg. A transparent
 *  pixel yields no colour, so an unset bg shows the host (or the tile) behind it. */
export interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
}

/** The quadrant character for a 4-bit mask of lit pixels: bit 0 upper left, 1 upper right, 2 lower left, 3 lower right. */
export const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';

const palette: Readonly<Record<string, string>> = pool.palette;

function colourAt(rows: readonly string[], r: number, c: number): string | undefined {
  const ch = rows[r]?.[c];
  return ch === undefined || ch === '.' ? undefined : palette[ch];
}

/** One cell from a 2x2 block of pixel colours (upper left, upper right, lower left, lower right;
 *  undefined is transparent). At most 2 distinct values may appear; a third is a pool defect and throws.
 *  A transparent pixel is never painted: it is left to the bg behind the cell. Otherwise the more
 *  common colour is the bg (a tie goes to the first seen) and the other is the fg. */
export function quadrantCell(px: readonly (string | undefined)[]): Cell {
  const keys: (string | undefined)[] = [];
  for (const c of px) if (!keys.includes(c)) keys.push(c);
  if (keys.length > 2) throw new Error(`a 2x2 block holds ${keys.length} colours, at most 2 fit one cell`);
  if (keys.length === 1) return keys[0] === undefined ? { ch: ' ' } : { ch: '█', fg: keys[0] };
  const count = (k: string | undefined): number => px.filter((c) => c === k).length;
  let bg: string | undefined;
  let fg: string | undefined;
  if (keys[0] === undefined || keys[1] === undefined) {
    bg = undefined;
    fg = keys[0] === undefined ? keys[1] : keys[0];
  } else {
    [bg, fg] = count(keys[1]) > count(keys[0]) ? [keys[1], keys[0]] : [keys[0], keys[1]];
  }
  const mask = px.reduce<number>((m, c, i) => (c === fg ? m | (1 << i) : m), 0);
  return bg === undefined ? { ch: QUADRANTS[mask]!, fg } : { ch: QUADRANTS[mask]!, fg, bg };
}

// avatarIndex wraps into the pool and frame wraps into the 4 frames, so any integer is safe.
export function cells(avatarIndex: number, frame: number): Cell[][] {
  const av = pool.avatars[((avatarIndex % POOL_SIZE) + POOL_SIZE) % POOL_SIZE]!;
  const rows = av.frames[((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT]!;
  const out: Cell[][] = [];
  for (let r = 0; r < SPRITE_ROWS; r++) {
    const line: Cell[] = [];
    for (let c = 0; c < SPRITE_COLS; c++) {
      line.push(
        quadrantCell([colourAt(rows, r * 2, c * 2), colourAt(rows, r * 2, c * 2 + 1), colourAt(rows, r * 2 + 1, c * 2), colourAt(rows, r * 2 + 1, c * 2 + 1)]),
      );
    }
    out.push(line);
  }
  return out;
}

/** The sprite on its tile: TILE_COLS cells per row, every cell with a bg (transparent pixels and the
 *  padding show the tile colour). The fg stays unset only on cells that draw no pixel. */
export function tileCells(avatarIndex: number, frame: number): Cell[][] {
  return cells(avatarIndex, frame).map((row) => {
    const pad: Cell = { ch: ' ', bg: TILE_BG };
    return [pad, ...row.map((c): Cell => ({ ...c, bg: c.bg ?? TILE_BG })), pad];
  });
}

// Milliseconds per animation tick, while a subagent is running. The Agents tab redraws on this beat.
export const ANIMATION_MS = 333;

// Animation sequence while running, one entry per tick: blink, bob and tilt each held for one tick
// and followed by a long rest. 6 frame changes per 24 ticks (about 8 s) is 0.75 per second; the
// earlier 8-tick cycle changed frame 2.25 times a second, which read as distracting (issue #9).
export const SEQUENCE: readonly number[] = [
  0, 0, 0, 0, 1, 0, 0, 0,
  0, 0, 0, 0, 2, 0, 0, 0,
  0, 0, 0, 0, 3, 0, 0, 0,
];

// Per-avatar offset into SEQUENCE so a row of avatars does not blink in unison. The step of 5 is
// coprime with the sequence length (24) and not a multiple of its 8-tick pose spacing, so
// neighbouring avatars never pose on the same tick.
export function phaseFor(avatarIndex: number): number {
  return (((avatarIndex * 5) % SEQUENCE.length) + SEQUENCE.length) % SEQUENCE.length;
}

export function frameAt(tick: number, phase: number, running: boolean): number {
  if (!running) return 0;
  const n = SEQUENCE.length;
  return SEQUENCE[(((Math.trunc(tick) + Math.trunc(phase)) % n) + n) % n]!;
}
