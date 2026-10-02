// allocateShares (board 675daf9d part (b), decision projects-mount-domains-and-sibling-projects,
// READ SHARE ruling): source 0 is the project; the project gets up to ceil(0.6 x cap) when a
// domain has matches, the rest is split evenly across domains, and unused share spills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateShares } from '../shares.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('allocateShares: only the project matches → the project takes the whole cap (unchanged behaviour)', () => {
  assert.deepEqual(allocateShares([50], 20), [20]);
  assert.deepEqual(allocateShares([50, 0, 0], 20), [20, 0, 0]);
  assert.deepEqual(allocateShares([7, 0], 20), [7, 0]);
});

test('allocateShares: project and domains all have plenty → ceil(0.6 x cap) to the project, the rest split evenly', () => {
  assert.deepEqual(allocateShares([50, 50], 20), [12, 8]);
  assert.deepEqual(allocateShares([50, 50, 50], 20), [12, 4, 4]);
  // ceil: 0.6 x 7 = 4.2 → 5; the remaining 2 go one each to two domains
  assert.deepEqual(allocateShares([50, 50, 50], 7), [5, 1, 1]);
  // an uneven split gives the odd unit to the earlier domain (manifest order)
  assert.deepEqual(allocateShares([50, 50, 50, 50], 10), [6, 2, 1, 1]);
});

test('allocateShares: a domain that under-uses its share spills to the others', () => {
  // domain 1 has only 1 match; its unused 3 spill to the project and domain 2
  const got = allocateShares([50, 1, 50], 20);
  assert.equal(sum(got), 20);
  assert.equal(got[1], 1);
  assert.ok(got[0] >= 12 && got[2] >= 4, `both others gain from the spill: ${got}`);
  assert.deepEqual(got, [14, 1, 5]);
});

test('allocateShares: a project that under-uses its share spills to the domains', () => {
  assert.deepEqual(allocateShares([3, 50], 20), [3, 17]);
  assert.deepEqual(allocateShares([0, 50, 50], 20), [0, 10, 10]);
});

test('allocateShares: fewer total matches than the cap → every match is returned', () => {
  assert.deepEqual(allocateShares([2, 3, 1], 20), [2, 3, 1]);
  assert.deepEqual(allocateShares([0, 0], 20), [0, 0]);
});

test('allocateShares: never exceeds a source count nor the cap', () => {
  for (const counts of [[5, 9, 0, 2], [100, 1, 1], [0, 0, 40], [13, 13]]) {
    for (const cap of [1, 2, 3, 5, 20, 50]) {
      const got = allocateShares(counts, cap);
      assert.equal(got.length, counts.length);
      got.forEach((g, i) => assert.ok(g >= 0 && g <= counts[i], `counts ${counts} cap ${cap} → ${got}`));
      assert.equal(sum(got), Math.min(cap, sum(counts)), `fills to min(cap, total): counts ${counts} cap ${cap} → ${got}`);
    }
  }
});

test('allocateShares: cap 1 with domain matches goes to the project when it has a match', () => {
  assert.deepEqual(allocateShares([5, 5], 1), [1, 0]);
  assert.deepEqual(allocateShares([0, 5], 1), [0, 1]);
});

test('allocateShares: projectShare is honoured', () => {
  assert.deepEqual(allocateShares([50, 50], 10, 0.5), [5, 5]);
  assert.deepEqual(allocateShares([50, 50], 10, 1), [10, 0]);
});

test('allocateShares: invalid input is refused', () => {
  assert.throws(() => allocateShares([], 20), /project/);
  assert.throws(() => allocateShares([1], 0), /cap/);
  assert.throws(() => allocateShares([1], 2.5), /cap/);
  assert.throws(() => allocateShares([-1], 20), /count/);
  assert.throws(() => allocateShares([1.5], 20), /count/);
  assert.throws(() => allocateShares([1, 1], 20, 1.5), /projectShare/);
  assert.throws(() => allocateShares([1, 1], 20, -0.1), /projectShare/);
});
