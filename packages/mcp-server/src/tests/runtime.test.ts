import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeMarkerPath } from '@sterling/schemas';
import { recordRuntimeMarker } from '../runtime.js';

test('recordRuntimeMarker: reads .build-id beside the server entry and writes the project transient marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-runtime-'));
  try {
    const serverDir = join(dir, 'dist');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, '.build-id'), 'BUILD_X\n'); // trailing whitespace is trimmed
    const storePath = join(dir, 'proj', '.sterling', 'sterling.db');

    const marker = recordRuntimeMarker(storePath, serverDir, () => '2026-06-17T12:00:00.000Z');
    assert.ok(marker);
    assert.equal(marker.build_id, 'BUILD_X');
    assert.equal(marker.pid, process.pid);
    assert.equal(marker.booted_at, '2026-06-17T12:00:00.000Z');

    const written = JSON.parse(readFileSync(runtimeMarkerPath(storePath), 'utf8'));
    assert.equal(written.build_id, 'BUILD_X');
    assert.equal(written.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRuntimeMarker: missing .build-id → build_id "unknown" (fail-open, transient dir still created)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-runtime-'));
  try {
    const serverDir = join(dir, 'dist');
    mkdirSync(serverDir, { recursive: true }); // no .build-id written
    const storePath = join(dir, 'proj', '.sterling', 'sterling.db');
    const marker = recordRuntimeMarker(storePath, serverDir, () => 'x');
    assert.ok(marker);
    assert.equal(marker.build_id, 'unknown');
    assert.ok(existsSync(runtimeMarkerPath(storePath)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
