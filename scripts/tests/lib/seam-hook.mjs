// H15 SEAM HARNESS — spawn a hook from a location whose walk-up finds NO
// plugin tree, so the STERLING_PLUGIN_ROOT test seam is actually consulted.
//
// WHY THIS EXISTS (decision 95c2c109 F2, user-ruled 2026-09-05): the active
// plugin root PREFERS the running hook's own import.meta.url walk-up, and the
// seam is consulted ONLY when that walk-up finds no plugin layout above the
// hook. A pin that spawns the SOURCE hook (scripts/hooks/h15-store-guard.mjs)
// therefore always resolves the REAL repo as the root and its seam value is
// ignored — every seam-based fixture would then test the ambient clone instead
// of the fixture. So the seam suites build a FRESH bundle of the hook from the
// live sources into a marker-free temp dir and spawn THAT: the walk-up fails
// by construction, the seam is honoured, and the bundle can never be stale
// relative to the source under test (it is built here, not copied from
// hooks/). Building into a temp target is also the ONLY sanctioned way for a
// test to obtain a bundle — an in-place build deploys to the live enforcement
// surface (anti_pattern 37b3cb0a, severity BLOCK).
//
// The three layout markers are hand-rolled here rather than imported from the
// module under test, so the harness precondition does not depend on the code
// it exists to exercise.

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHooks } from '../../lib/bundled-artifacts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The walk-up bound in scripts/hooks/lib/sanctioned-provenance.mjs is 6; probe
// a little further so a tighter bound there can never silently invalidate this
// precondition.
const PROBE_LEVELS = 8;

function carriesPluginLayout(dir) {
  try {
    return existsSync(join(dir, '.claude-plugin', 'plugin.json')) && statSync(join(dir, 'hooks')).isDirectory() && existsSync(join(dir, 'hooks', 'hooks.json'));
  } catch {
    return false;
  }
}

/**
 * Build `entry` (a scripts/hooks/h*.mjs basename) from the LIVE sources into a
 * fresh marker-free temp dir. Returns the spawnable bundle path and a cleanup.
 * Throws — loudly, never degrading — if any ancestor of the temp dir carries a
 * plugin layout, because then the walk-up would succeed and every pin spawned
 * from here would silently test the wrong root.
 */
export async function buildSeamHook(entry = 'h15-store-guard.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-seam-hook-'));
  let probe = dir;
  for (let i = 0; i < PROBE_LEVELS; i++) {
    if (carriesPluginLayout(probe)) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `seam harness precondition FAILED: ${probe} (an ancestor of the temp dir ${dir}) carries a plugin layout, so a hook spawned from there would resolve it by walk-up and ignore STERLING_PLUGIN_ROOT — pick a different TMPDIR`
      );
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const emitted = await buildHooks({ root, srcDir: join(root, 'scripts', 'hooks'), outDir: dir, only: [entry] });
  if (emitted.length !== 1) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`seam harness: expected exactly one bundle for ${entry}, got ${emitted.length}`);
  }
  return {
    hookPath: emitted[0],
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}
