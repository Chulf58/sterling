// Host-neutral avatar sprites: pure data and functions, no terminal library.
// Each avatar is 6x6 pixels, drawn natively at that size, in 4 frames (0 rest, 1 blink, 2 bob,
// 3 tilt). Two pixel rows pack into one terminal row with half blocks, so a sprite is 3 rows of 6
// cells, the height of the three text lines beside it.
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

// A transparent pixel yields no fg or bg, so the host background shows through.
export interface Cell {
  ch: '▀' | '▄' | ' ';
  fg?: string;
  bg?: string;
}

const palette: Readonly<Record<string, string>> = pool.palette;

function colourAt(rows: readonly string[], r: number, c: number): string | undefined {
  const ch = rows[r]?.[c];
  return ch === undefined || ch === '.' ? undefined : palette[ch];
}

// avatarIndex wraps into the pool and frame wraps into the 4 frames, so any integer is safe.
export function cells(avatarIndex: number, frame: number): Cell[][] {
  const av = pool.avatars[((avatarIndex % POOL_SIZE) + POOL_SIZE) % POOL_SIZE]!;
  const rows = av.frames[((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT]!;
  const out: Cell[][] = [];
  for (let r = 0; r < SPRITE_ROWS; r++) {
    const line: Cell[] = [];
    for (let c = 0; c < SPRITE_COLS; c++) {
      const top = colourAt(rows, r * 2, c);
      const bottom = colourAt(rows, r * 2 + 1, c);
      if (top && bottom) line.push({ ch: '▀', fg: top, bg: bottom });
      else if (top) line.push({ ch: '▀', fg: top });
      else if (bottom) line.push({ ch: '▄', fg: bottom });
      else line.push({ ch: ' ' });
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

// Animation sequence while running: rest, rest, blink, rest, bob, rest, tilt, rest.
export const SEQUENCE: readonly number[] = [0, 0, 1, 0, 2, 0, 3, 0];

// Per-avatar offset into SEQUENCE so a row of avatars does not blink in unison.
export function phaseFor(avatarIndex: number): number {
  return (((avatarIndex * 3) % SEQUENCE.length) + SEQUENCE.length) % SEQUENCE.length;
}

export function frameAt(tick: number, phase: number, running: boolean): number {
  if (!running) return 0;
  const n = SEQUENCE.length;
  return SEQUENCE[(((Math.trunc(tick) + Math.trunc(phase)) % n) + n) % n]!;
}
