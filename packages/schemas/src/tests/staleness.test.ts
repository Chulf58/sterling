import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BUILD_ID_FILE, buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '../staleness.js';

test('staleness paths: build-id sits beside the server entry; marker in the project transient dir', () => {
  assert.equal(buildIdPath(join('x', 'dist')), join('x', 'dist', BUILD_ID_FILE));
  assert.equal(
    runtimeMarkerPath(join('proj', '.sterling', 'sterling.db')),
    join('proj', '.sterling', 'transient', 'mcp-runtime.json')
  );
});

test('runtimeMarkerSchema is strict: build_id/pid/booted_at required; pid int; no extra keys', () => {
  assert.ok(runtimeMarkerSchema.safeParse({ build_id: 'abc', pid: 123, booted_at: '2026-06-17T00:00:00.000Z' }).success);
  assert.ok(!runtimeMarkerSchema.safeParse({ build_id: 'abc', pid: 1 }).success, 'booted_at required');
  assert.ok(!runtimeMarkerSchema.safeParse({ build_id: 'abc', pid: 1.5, booted_at: 'x' }).success, 'pid must be an integer');
  assert.ok(!runtimeMarkerSchema.safeParse({ build_id: 'abc', pid: 1, booted_at: 'x', extra: 1 }).success, 'extra keys rejected');
});

test('stalenessVerdict: equal ids fresh; differing ids stale; missing build-id or marker is unknown (no false alarm)', () => {
  const marker = { build_id: 'BUILD_A', pid: 1, booted_at: 'x' };
  assert.deepEqual(stalenessVerdict('BUILD_A', marker), { state: 'fresh', running: 'BUILD_A', current: 'BUILD_A' });
  assert.deepEqual(stalenessVerdict('BUILD_B', marker), { state: 'stale', running: 'BUILD_A', current: 'BUILD_B' });
  assert.deepEqual(stalenessVerdict(null, marker), { state: 'unknown' }, 'no current build-id → unknown, never stale');
  assert.deepEqual(stalenessVerdict('BUILD_A', null), { state: 'unknown' }, 'no marker (first boot / pre-guard) → unknown');
});

test('stalenessVerdict: a present marker whose WRITER pid is dead is an orphaned marker → unknown (closes the restart-after-rebuild race), not a false stale', () => {
  const marker = { build_id: 'BUILD_OLD', pid: 1, booted_at: 'x' };
  // mismatch + writer ALIVE → a genuinely stale RUNNING server → warn (the case the guard exists for)
  assert.deepEqual(stalenessVerdict('BUILD_NEW', marker, true), { state: 'stale', running: 'BUILD_OLD', current: 'BUILD_NEW' });
  // mismatch + writer DEAD → marker left by the server we just replaced → unknown, NO false alarm
  assert.deepEqual(stalenessVerdict('BUILD_NEW', marker, false), { state: 'unknown' }, 'dead writer → orphaned marker → unknown');
  // mismatch + liveness INDETERMINATE (null, the default) → still warn (fail loud: a missed real warning is worse)
  assert.deepEqual(stalenessVerdict('BUILD_NEW', marker, null), { state: 'stale', running: 'BUILD_OLD', current: 'BUILD_NEW' });
  assert.deepEqual(stalenessVerdict('BUILD_NEW', marker), { state: 'stale', running: 'BUILD_OLD', current: 'BUILD_NEW' }, 'default arg preserves prior fail-loud behavior');
  // a dead writer for a MATCHING build is unknown too (silent either way)
  assert.deepEqual(stalenessVerdict('BUILD_OLD', marker, false), { state: 'unknown' });
});
