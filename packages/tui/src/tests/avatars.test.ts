import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, mulberry32, cells, quadrantCell, QUADRANTS, tileCells, frameAt, phaseFor, POOL_SIZE, SPRITE_ROWS, SPRITE_COLS, TILE_BG, TILE_COLS, DONE_FADE, fadeToTile } from '../avatars/index.js';
import { ANIMATION_MS, SEQUENCE } from '../avatars/sprite.js';
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

const pal: Record<string, string> = pool.palette;
const EYE = '#1d1e1c';
const hexRe = /^#[0-9a-f]{6}$/;

test('sprite: every avatar and frame is 3 rows of 6 quadrant cells', () => {
  assert.equal(POOL_SIZE, 48);
  assert.equal(SPRITE_ROWS, 3);
  assert.equal(SPRITE_COLS, 6);
  for (let a = 0; a < POOL_SIZE; a++) {
    for (let f = 0; f < 4; f++) {
      const g = cells(a, f);
      assert.equal(g.length, SPRITE_ROWS);
      for (const row of g) {
        assert.equal(row.length, SPRITE_COLS);
        for (const cell of row) assert.ok([...QUADRANTS].includes(cell.ch), `unexpected cell character ${cell.ch}`);
      }
    }
  }
});

test('quadrant mapping: all 16 masks of lit pixels give the right character, fg lit over bg', () => {
  const expected = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
  assert.deepEqual([...QUADRANTS], expected);
  const FG = '#ff0000';
  const BG = '#0000ff';
  for (let mask = 1; mask < 15; mask++) {
    // both colours opaque: bg is the more common colour, the lit pixels are fg (tie: the first seen is bg)
    const px = [0, 1, 2, 3].map((i) => ((mask >> i) & 1 ? FG : BG));
    const lit = px.filter((c) => c === FG).length;
    const cell = quadrantCell(px);
    const fgIsMinority = lit < 2 || (lit === 2 && px[0] === BG);
    if (fgIsMinority) assert.deepEqual(cell, { ch: expected[mask], fg: FG, bg: BG }, `mask ${mask}`);
    else assert.deepEqual(cell, { ch: expected[15 - mask], fg: BG, bg: FG }, `mask ${mask} swapped`);
    // transparent against one colour: the transparent pixels are never painted, so no bg
    const t = [0, 1, 2, 3].map((i) => ((mask >> i) & 1 ? FG : undefined));
    assert.deepEqual(quadrantCell(t), { ch: expected[mask], fg: FG }, `mask ${mask} on transparent`);
  }
  assert.deepEqual(quadrantCell([undefined, undefined, undefined, undefined]), { ch: ' ' });
  assert.deepEqual(quadrantCell([FG, FG, FG, FG]), { ch: '█', fg: FG });
  assert.throws(() => quadrantCell([FG, BG, '#00ff00', FG]), /at most 2/);
});

test('sprite: every cell draws at most 2 colours; transparent pixels carry no colour', () => {
  let blanks = 0;
  let solid = 0;
  let two = 0;
  for (let a = 0; a < POOL_SIZE; a++) {
    for (let f = 0; f < 4; f++) {
      const rows = pool.avatars[a]!.frames[f]!;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          const block = [rows[r * 2]![c * 2]!, rows[r * 2]![c * 2 + 1]!, rows[r * 2 + 1]![c * 2]!, rows[r * 2 + 1]![c * 2 + 1]!];
          assert.ok(new Set(block).size <= 2, `avatar ${a} frame ${f} cell ${r},${c} holds ${new Set(block).size} colours`);
        }
      }
    }
    for (const cell of cells(a, 0).flat()) {
      if (cell.ch === ' ') {
        blanks++;
        assert.equal(cell.fg, undefined);
        assert.equal(cell.bg, undefined);
      } else {
        assert.match(cell.fg ?? '', hexRe);
        if (cell.bg === undefined) solid++;
        else {
          two++;
          assert.match(cell.bg, hexRe);
        }
      }
    }
  }
  assert.ok(blanks > 0 && solid > 0 && two > 0);
  // the first pixel row of every avatar is empty at the left edge, so that cell is fully transparent
  assert.deepEqual(cells(0, 0)[0]![0], { ch: ' ' });
});

test('sprite: a cell is the quadrant mapping of its 2x2 block of the pool pixels', () => {
  for (const a of [0, 17, 47]) {
    const rows = pool.avatars[a]!.frames[0]!;
    const colour = (r: number, c: number): string | undefined => (rows[r]![c] === '.' ? undefined : pal[rows[r]![c]!]);
    cells(a, 0).forEach((row, r) => row.forEach((cell, c) => assert.deepEqual(cell, quadrantCell([colour(r * 2, c * 2), colour(r * 2, c * 2 + 1), colour(r * 2 + 1, c * 2), colour(r * 2 + 1, c * 2 + 1)]))));
  }
});

test('pool: 48 portraits of 4 frames, each 6 strings of 12 pixels', () => {
  assert.equal(pool.avatars.length, 48);
  for (const a of pool.avatars) {
    assert.equal(a.frames.length, 4);
    for (const f of a.frames) {
      assert.equal(f.length, 6);
      for (const row of f) {
        assert.equal(row.length, 12);
        for (const ch of row) assert.ok(ch === '.' || pal[ch] !== undefined, `unknown palette key ${ch}`);
      }
    }
    assert.equal(new Set(a.frames.map((f) => f.join('/'))).size, 4, 'rest, blink, bob and tilt all look different');
  }
  assert.equal(new Set(pool.avatars.map((a) => a.frames[0]!.join('/'))).size, 48, 'every portrait differs at rest');
});

test('pool: the 3 skin tones are balanced and the ruled-out looks are absent', () => {
  const tones = pool.avatars.map((a) => a.parts.skin);
  for (const t of [0, 1, 2]) assert.equal(tones.filter((x) => x === t).length, 16);
  const banned = ['monocle', 'glasses', 'headphones'];
  assert.ok(!pool.avatars.some((a) => Object.values(a.parts).some((v) => banned.includes(String(v)))));
});

test('pool: two dark eyes stay visible in rest, bob and tilt, and a blink turns them to skin', () => {
  const dark = (rows: readonly string[]): number => rows.join('').split('').filter((ch) => pal[ch] === EYE).length;
  for (const a of pool.avatars) {
    const [rest, blink, bob, tilt] = a.frames as [string[], string[], string[], string[]];
    for (const f of [rest, bob, tilt]) assert.equal(dark(f), 2, JSON.stringify(a.parts));
    assert.equal(dark([rest[2]!]), 2, 'the eyes are on pixel row 2 of the picked rows');
    assert.equal(dark(blink), 0);
  }
});

test('pool: the face centre is never hair-coloured (issue #30)', () => {
  pool.avatars.forEach((a, i) => {
    // the top of the head, in the rest frame, is the hair (or the hat on it); a bald head shows skin there
    const skin = pal[a.frames[0]![4]![5]!];
    const top = new Set([4, 5, 6, 7].map((c) => pal[a.frames[0]![0]![c]!]).filter((colour) => colour !== skin));
    a.frames.forEach((rows, f) => {
      // the tilt frame leans one pixel to the right, so its face centre is one column over
      const [from, to] = f === 3 ? [5, 8] : [4, 7];
      for (let r = 2; r <= 3; r++) {
        for (let c = from; c <= to; c++) {
          assert.ok(!top.has(pal[rows[r]![c]!]), `avatar ${i} (${a.parts.extra}) frame ${f} pixel ${r},${c} is ${rows[r]![c]}, the hair colour`);
        }
      }
    });
  });
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
        assert.match(cell.bg ?? '', hexRe, 'a bg on every cell');
        assert.ok([...QUADRANTS].includes(cell.ch));
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

test('frameAt: running walks SEQUENCE and repeats, resting on frame 0 between poses', () => {
  const n = SEQUENCE.length;
  const seq = Array.from({ length: 2 * n }, (_, t) => frameAt(t, 0, true));
  assert.deepEqual(seq, [...SEQUENCE, ...SEQUENCE]);
  assert.equal(frameAt(-1, 0, true), SEQUENCE[n - 1]);
  assert.deepEqual([...new Set(SEQUENCE)].sort(), [0, 1, 2, 3], 'every pose still plays');
  assert.equal(SEQUENCE[0], 0, 'the cycle starts at rest');
  assert.ok(SEQUENCE.every((f, i) => f === 0 || SEQUENCE[(i + 1) % n] === 0), 'every move returns to the rest pose');
});

test('motion: a running avatar changes frame under once per second (issue #9)', () => {
  const n = SEQUENCE.length;
  let changes = 0;
  for (let t = 0; t < n; t++) if (frameAt(t, 0, true) !== frameAt(t + 1, 0, true)) changes++;
  const perSecond = changes / ((n * ANIMATION_MS) / 1000);
  assert.ok(changes > 0, 'the avatar still moves');
  assert.ok(perSecond < 1, `${perSecond.toFixed(3)} frame changes per second`);
});

test('frameAt: per-avatar phase offsets differ so avatars do not blink in unison', () => {
  const n = SEQUENCE.length;
  const phases = Array.from({ length: 8 }, (_, a) => phaseFor(a));
  assert.equal(new Set(phases).size, 8);
  const at = (a: number) => Array.from({ length: n }, (_, t) => frameAt(t, phaseFor(a), true));
  assert.notDeepEqual(at(0), at(1));
  assert.notDeepEqual(at(1), at(2));
});

test('frameAt: index-adjacent avatars are never mid-move on the same tick', () => {
  const n = SEQUENCE.length;
  for (let a = 0; a < 7; a++) {
    assert.notEqual(phaseFor(a), phaseFor(a + 1));
    for (let t = 0; t < n; t++) {
      const both = frameAt(t, phaseFor(a), true) !== 0 && frameAt(t, phaseFor(a + 1), true) !== 0;
      assert.equal(both, false, `avatars ${a} and ${a + 1} both pose at tick ${t}`);
    }
  }
});

test('fadeToTile: 0 keeps the colour, 1 is the tile colour, DONE_FADE sits between; the tile colour is a fixed point', () => {
  assert.equal(fadeToTile('#ff8000', 0), '#ff8000');
  assert.equal(fadeToTile('#ff8000', 1), TILE_BG);
  assert.equal(fadeToTile(TILE_BG, DONE_FADE), TILE_BG);
  assert.equal(DONE_FADE, 0.55);
  assert.equal(fadeToTile('#ff0000', DONE_FADE), '#' + [Math.round(255 + (0x2a - 255) * 0.55), Math.round(0x2e * 0.55), Math.round(0x37 * 0.55)].map((v) => v.toString(16).padStart(2, '0')).join(''));
});
