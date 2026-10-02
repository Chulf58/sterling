import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, mulberry32, cells, frameAt, phaseFor, POOL_SIZE, SPRITE_ROWS, SPRITE_COLS } from '../avatars/index.js';
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

test('sprite: every avatar and frame is 6 rows of 12 cells', () => {
  assert.equal(POOL_SIZE, 48);
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
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 12; c++) {
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
