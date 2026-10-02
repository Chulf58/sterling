import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, mulberry32, cells, tileCells, frameAt, phaseFor, POOL_SIZE, SPRITE_ROWS, SPRITE_COLS, TILE_BG, TILE_COLS } from '../avatars/index.js';
import pool from '../avatars/pool.json' with { type: 'json' };

const ids = (n: number, p = 's'): string[] => Array.from({ length: n }, (_, i) => `${p}${i}`);
const empty = (): Map<string, number> => new Map<string, number>();

test('uniqueness: every live id gets a distinct in-range index', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { current } = assign(ids(30), empty(), mulberry32(seed), { poolSize: 48 });
    const vals = [...current.values()];
    assert.equal(current.size, 30);
    assert.equal(new Set(vals).size, 30);
    assert.ok(vals.every((v) => Number.isInteger(v) && v >= 0 && v < 48));
  }
});

test('uniqueness: a full pool hands out every index exactly once', () => {
  const { current } = assign(ids(48), empty(), mulberry32(7), { poolSize: 48 });
  assert.deepEqual([...current.values()].sort((a, b) => a - b), Array.from({ length: 48 }, (_, i) => i));
});

test('stickiness: ids already in current keep their avatar, new ids avoid them', () => {
  const rng = mulberry32(3);
  const first = assign(['a', 'b'], empty(), rng, { poolSize: 6 });
  const second = assign(['a', 'b', 'c', 'd'], first.current, rng, { poolSize: 6, freed: first.freed });
  assert.equal(second.current.get('a'), first.current.get('a'));
  assert.equal(second.current.get('b'), first.current.get('b'));
  assert.equal(new Set(second.current.values()).size, 4);
});

test('stickiness: repeating the same live set changes nothing', () => {
  const rng = mulberry32(9);
  const a = assign(ids(5), empty(), rng, { poolSize: 48 });
  const b = assign(ids(5), a.current, rng, { poolSize: 48, freed: a.freed });
  assert.deepEqual([...b.current], [...a.current]);
  assert.deepEqual(b.freed, a.freed);
});

test('freeing: a departed id leaves current, its index is recorded and can be reused', () => {
  const rng = mulberry32(5);
  const a = assign(['a', 'b', 'c'], empty(), rng, { poolSize: 3 });
  const freedIdx = a.current.get('b');
  const b = assign(['a', 'c'], a.current, rng, { poolSize: 3, freed: a.freed });
  assert.equal(b.current.has('b'), false);
  assert.deepEqual(b.freed, [freedIdx]);
  const c = assign(['a', 'c', 'd'], b.current, rng, { poolSize: 3, freed: b.freed });
  assert.equal(c.current.get('d'), freedIdx);
});

test('freeing: the input map and freed list are not mutated', () => {
  const cur = new Map<string, number>([['a', 1], ['b', 2]]);
  const freed: number[] = [0];
  assign(['a'], cur, mulberry32(1), { poolSize: 4, freed });
  assert.deepEqual([...cur], [['a', 1], ['b', 2]]);
  assert.deepEqual(freed, [0]);
});

test('exhaustion: more live ids than avatars still assigns every id, in range', () => {
  const { current } = assign(ids(7), empty(), mulberry32(2), { poolSize: 3 });
  assert.equal(current.size, 7);
  assert.ok([...current.values()].every((v) => v >= 0 && v < 3));
  assert.equal(new Set([...current.values()].slice(0, 3)).size, 3);
});

test('exhaustion: a shared avatar is the least recently freed one', () => {
  const rng = mulberry32(4);
  let st = assign(['a', 'b', 'c'], empty(), rng, { poolSize: 3 });
  const idxA = st.current.get('a');
  const idxC = st.current.get('c');
  st = assign(['b', 'c'], st.current, rng, { poolSize: 3, freed: st.freed }); // a freed first
  st = assign(['b'], st.current, rng, { poolSize: 3, freed: st.freed }); // c freed second
  assert.deepEqual(st.freed, [idxA, idxC]);
  const idxB = st.current.get('b');
  const open = [0, 1, 2].filter((i) => i !== idxB);
  st = assign(['b', 'x', 'y', 'z'], st.current, rng, { poolSize: 3, freed: st.freed });
  assert.deepEqual([st.current.get('x')!, st.current.get('y')!].sort((p, q) => p - q), open); // free indices first
  assert.equal(st.current.get('z'), idxA); // pool exhausted: least recently freed is shared
});

test('sprite: every avatar and frame is 3 rows of 6 cells', () => {
  assert.equal(POOL_SIZE, 48);
  assert.equal(SPRITE_ROWS, 3);
  assert.equal(SPRITE_COLS, 6);
  for (let a = 0; a < POOL_SIZE; a++) {
    for (let f = 0; f < 4; f++) {
      const g = cells(a, f);
      assert.equal(g.length, SPRITE_ROWS);
      for (const row of g) {
        assert.equal(row.length, SPRITE_COLS);
        for (const cell of row) assert.ok(cell.ch === '▀' || cell.ch === '▄' || cell.ch === ' ');
      }
    }
  }
});

test('sprite: transparent pixels carry no fg or bg, opaque ones carry hex colours', () => {
  const hex = /^#[0-9a-f]{6}$/;
  let blanks = 0;
  let single = 0;
  let both = 0;
  for (let a = 0; a < POOL_SIZE; a++) {
    for (const cell of cells(a, 0).flat()) {
      if (cell.ch === ' ') {
        blanks++;
        assert.equal(cell.fg, undefined);
        assert.equal(cell.bg, undefined);
      } else if (cell.bg === undefined) {
        single++;
        assert.match(cell.fg ?? '', hex);
      } else {
        both++;
        assert.equal(cell.ch, '▀');
        assert.match(cell.fg ?? '', hex);
        assert.match(cell.bg, hex);
      }
    }
  }
  assert.ok(blanks > 0 && single > 0 && both > 0);
  // the first pixel row of every avatar is empty at the left edge, so that cell is fully transparent
  assert.deepEqual(cells(0, 0)[0]![0], { ch: ' ' });
});

test('sprite: a cell packs the top pixel into fg and the bottom pixel into bg', () => {
  const pal: Record<string, string> = pool.palette;
  for (const a of [0, 17, 47]) {
    const rows = pool.avatars[a]!.frames[0]!;
    const g = cells(a, 0);
    for (let r = 0; r < SPRITE_ROWS; r++) {
      for (let c = 0; c < SPRITE_COLS; c++) {
        const top = rows[r * 2]![c]!;
        const bottom = rows[r * 2 + 1]![c]!;
        const cell = g[r]![c]!;
        if (top !== '.' && bottom !== '.') assert.deepEqual(cell, { ch: '▀', fg: pal[top], bg: pal[bottom] });
        else if (top !== '.') assert.deepEqual(cell, { ch: '▀', fg: pal[top] });
        else if (bottom !== '.') assert.deepEqual(cell, { ch: '▄', fg: pal[bottom] });
        else assert.deepEqual(cell, { ch: ' ' });
      }
    }
  }
});

test('pool: 48 portraits of 4 frames, each 6 strings of 6 pixels, native to that size', () => {
  assert.equal(pool.avatars.length, 48);
  const pal: Record<string, string> = pool.palette;
  for (const a of pool.avatars) {
    assert.equal(a.frames.length, 4);
    for (const f of a.frames) {
      assert.equal(f.length, 6);
      for (const row of f) {
        assert.equal(row.length, 6);
        for (const ch of row) assert.ok(ch === '.' || pal[ch] !== undefined, `unknown palette key ${ch}`);
      }
    }
  }
  assert.equal(new Set(pool.avatars.map((a) => a.frames[0]!.join('/'))).size, 48, 'every portrait differs at rest');
});

test('pool: the 3 skin tones are balanced and the ruled-out looks are absent', () => {
  const tones = pool.avatars.map((a) => a.parts.skin);
  for (const t of [0, 1, 2]) assert.equal(tones.filter((x) => x === t).length, 16);
  const banned = ['monocle', 'glasses', 'headphones'];
  assert.ok(!pool.avatars.some((a) => Object.values(a.parts).some((v) => banned.includes(String(v)))));
});

test('pool: two dark eyes on row 2, a blink turns them to skin, bob moves only the top row, tilt only rows 0-1, no pixel lost', () => {
  const pal: Record<string, string> = pool.palette;
  const count = (row: string): number => row.replace(/\./g, '').length;
  const darkIn = (rows: readonly string[]): number => rows.join('').split('').filter((ch) => pal[ch] === '#1d1e1c').length;
  for (const a of pool.avatars) {
    const [rest, blink, bob, tilt] = a.frames as [string[], string[], string[], string[]];
    assert.equal(darkIn(rest), 2);
    assert.equal(darkIn([rest[2]!]), 2, 'the eyes are on row 2');
    assert.equal(darkIn(blink), 0);
    assert.equal(count(blink.join('')), count(rest.join('')));
    const top = rest.findIndex((r) => /[^.]/.test(r));
    assert.deepEqual(bob.filter((_, i) => i !== top), rest.filter((_, i) => i !== top));
    assert.notEqual(bob[top], rest[top]);
    assert.equal(count(bob[top]!), count(rest[top]!));
    assert.deepEqual(tilt.slice(2), rest.slice(2));
    for (const r of [0, 1]) assert.equal(count(tilt[r]!), count(rest[r]!));
  }
});

test('tile: 8 cols by 3 rows, padded one col each side, every cell on the tile colour, no frame glyphs', () => {
  assert.equal(TILE_COLS, 8);
  for (let a = 0; a < POOL_SIZE; a++) {
    const t = tileCells(a, 0);
    assert.equal(t.length, 3);
    for (const row of t) {
      assert.equal(row.length, TILE_COLS);
      assert.deepEqual(row[0], { ch: ' ', bg: TILE_BG });
      assert.deepEqual(row[TILE_COLS - 1], { ch: ' ', bg: TILE_BG });
      for (const cell of row) {
        assert.match(cell.bg ?? '', /^#[0-9a-f]{6}$/, 'a bg on every cell');
        assert.ok(cell.ch === '▀' || cell.ch === '▄' || cell.ch === ' ');
      }
    }
    // inside the padding the sprite is unchanged; only a missing bg is filled with the tile colour
    cells(a, 0).forEach((row, r) => row.forEach((c, i) => assert.deepEqual(t[r]![i + 1], { ...c, bg: c.bg ?? TILE_BG })));
  }
});

test('sprite: out-of-range avatar and frame indices wrap instead of throwing', () => {
  assert.deepEqual(cells(48, 4), cells(0, 0));
  assert.deepEqual(cells(-1, -1), cells(47, 3));
});

test('frameAt: idle is always frame 0', () => {
  for (let tick = 0; tick < 32; tick++) for (const phase of [0, 1, 5]) assert.equal(frameAt(tick, phase, false), 0);
});

test('frameAt: running walks 0,0,1,0,2,0,3,0 and repeats', () => {
  const seq = Array.from({ length: 16 }, (_, t) => frameAt(t, 0, true));
  assert.deepEqual(seq, [0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
  assert.equal(frameAt(-1, 0, true), 0);
});

test('frameAt: per-avatar phase offsets differ so avatars do not blink in unison', () => {
  const phases = Array.from({ length: 8 }, (_, a) => phaseFor(a));
  assert.equal(new Set(phases).size, 8);
  const at = (a: number) => Array.from({ length: 8 }, (_, t) => frameAt(t, phaseFor(a), true));
  assert.notDeepEqual(at(0), at(1));
  assert.notDeepEqual(at(1), at(2));
});
