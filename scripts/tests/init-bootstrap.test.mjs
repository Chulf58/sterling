// Fresh-clone bootstrap preflight (boards 5634444c / 2a6b45c2).
//
// SPEC-ONLY: written from the CONTRACT handed to the test-writer, not from
// scripts/init.mjs or scripts/init-impl.mjs — a coder is building the
// implementation in parallel. Follows the harness style of
// scripts/tests/init-ensure.test.mjs (node:test, spawnSync of
// `node scripts/init.mjs`).
//
// CONTRACT UNDER TEST:
//   scripts/init.mjs is now a builtins-only bootstrap that PREFLIGHTS the
//   plugin clone before importing the implementation. Seam:
//   STERLING_INIT_PRECHECK_ROOT overrides the root it inspects (empty string
//   '' behaves as unset — the same falsy convention as
//   STERLING_PLUGIN_ROOT_MATCH). Under the precheck root it requires:
//   node_modules/, packages/schemas/dist/index.js, packages/store/dist/index.js.
//   Missing node_modules -> exit 2, stderr names `npm ci`. node_modules
//   present but a required dist file missing -> exit 2, stderr names
//   `npm run build`. Preflight passing -> the real implementation runs in the
//   same process with argv intact, its own refusals unchanged. package.json
//   carries scripts.prepare === "npm run build && npm run build:tui" and an
//   engines.node field.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// fake Windows node path so the native launcher generates deterministically
// without a real Windows node on PATH (mirrors init-ensure.test.mjs).
const WIN_NODE_FAKE = 'C:\\TestNode\\node-v24-win-x64\\node.exe';

const scratchDirs = new Set();
function scratchDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.add(d);
  return d;
}
after(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Spawns `node scripts/init.mjs --target <targetDir> ...args`. Every call
// gets the SAME containment defaults as init-ensure.test.mjs
// (STERLING_PLUGIN_ROOT_MATCH pinned to a disposable scratch dir, registry
// isolated, win-node/codex probes forced absent) so a spawn that reaches the
// real implementation (the control test) never writes into or reads THIS
// repo's own live .claude-plugin config or fires a real codex/WSL probe — a
// suite run is not a deployment (anti_pattern
// a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree).
function spawnInit(targetDir, args = [], extraEnv = {}) {
  const pluginRootMatch = extraEnv.STERLING_PLUGIN_ROOT_MATCH ?? scratchDir('sterling-pluginroot-');
  const registryDir = scratchDir('sterling-registry-');
  const r = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'init.mjs'), '--target', targetDir, ...args],
    {
      encoding: 'utf8',
      cwd: targetDir,
      timeout: 180_000,
      env: {
        ...process.env,
        STERLING_REGISTRY_DB: join(registryDir, 'registry.db'),
        STERLING_WIN_NODE: WIN_NODE_FAKE,
        STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch,
        STERLING_CODEX_PROBE: 'absent',
        STERLING_CODEX_PROBE_WIN: 'absent',
        ...extraEnv,
      },
    }
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// =============================================================================
// T3 — CONTROL, placed FIRST. A verdict with two possible causes (the
// preflight refusing vs. the real implementation refusing) needs a control
// arm that must pass for the OPPOSITE reason: this proves the seam-unset path
// reaches and runs the REAL implementation at all, before T1/T2 below are
// trusted to mean "the preflight fired" rather than "the process crashed" or
// "nothing runs and every spawn exits 2 no matter what".
// =============================================================================
test('T3 CONTROL (seam UNSET via STERLING_INIT_PRECHECK_ROOT: "" — pins the falsy convention) against the real repo, --target a fresh dir, NO other flags: preflight passes and the REAL implementation runs, refusing via its OWN first-init check — not the bootstrap remedies', () => {
  const targetDir = scratchDir('sterling-bootstrap-target-');
  const r = spawnInit(targetDir, [], { STERLING_INIT_PRECHECK_ROOT: '' });
  assert.equal(r.code, 2, `expected the implementation's own first-init refusal (exit 2): ${r.stderr}`);
  assert.ok(!/npm ci/.test(r.stderr), 'CONTROL: preflight passed against the real repo — no bootstrap remedy for missing node_modules');
  assert.ok(!/npm run build\b/.test(r.stderr), 'CONTROL: preflight passed against the real repo — no bootstrap remedy for missing dist');
  assert.match(
    r.stderr,
    /backup|--backup-opt-out|toolchain|stack-tags/i,
    'the implementation itself ran and refused for a reason of ITS OWN (missing declarations on a fresh --target) — proving the preflight passed and real code was reached, not a crash before the preflight and not the preflight\'s own refusal'
  );
});
// SABOTAGE: make the preflight ALWAYS refuse (e.g. hardcode exit 2 + the
// bootstrap message regardless of what STERLING_INIT_PRECHECK_ROOT resolves
// to) — this CONTROL goes red first (stderr would contain 'npm ci' or
// 'npm run build', or the backup/toolchain/stack-tags match would fail
// because the process never reaches the implementation), which is exactly
// what stops T1/T2 below from passing vacuously for the wrong reason.
// SABOTAGE (empty-string convention): treat '' as a REAL (non-unset) root
// value instead of falling back to the default — the resolved root becomes an
// empty path, the node_modules/dist checks fail against it, and this test
// goes red with 'npm ci' present in stderr instead of the backup/toolchain
// refusal.

// =============================================================================
// T1 — missing node_modules entirely under the precheck root.
// =============================================================================
test('T1: empty precheck root (no node_modules) -> exit 2, remedy names `npm ci`, and does NOT (yet) ask for `npm run build`', () => {
  const precheckRoot = scratchDir('sterling-precheck-empty-');
  const targetDir = scratchDir('sterling-bootstrap-target-');
  const r = spawnInit(targetDir, [], { STERLING_INIT_PRECHECK_ROOT: precheckRoot });
  assert.equal(r.code, 2, `expected preflight refusal: ${r.stderr}`);
  assert.match(r.stderr, /npm ci/, 'remedy names npm ci for missing node_modules');
  assert.ok(!/npm run build\b/.test(r.stderr), 'the node_modules check fails first — no premature build remedy while node_modules itself is absent');
});
// SABOTAGE: drop the node_modules existence check (or always report the
// npm-run-build message regardless of which precondition failed) — the
// 'npm ci' match goes red, or the 'does NOT ask for npm run build' arm goes
// red if the message is unconditional.

// =============================================================================
// T2 — node_modules present but the built dist output is missing. Split into
// two INDEPENDENT arms, each leaving ONE required dist file present and the
// OTHER absent, so an implementation that checks only packages/schemas/dist
// OR only packages/store/dist (but not both) cannot pass silently: the
// original single-fixture version removed both dist files at once, which a
// schemas-only or a store-only check would satisfy identically.
// =============================================================================
test('T2a: node_modules present, packages/store/dist/index.js present, ONLY packages/schemas/dist/index.js missing -> exit 2, remedy names `npm run build`', () => {
  const precheckRoot = scratchDir('sterling-precheck-noschemas-');
  mkdirSync(join(precheckRoot, 'node_modules'));
  mkdirSync(join(precheckRoot, 'packages', 'store', 'dist'), { recursive: true });
  writeFileSync(join(precheckRoot, 'packages', 'store', 'dist', 'index.js'), '// built store\n');
  const targetDir = scratchDir('sterling-bootstrap-target-');
  const r = spawnInit(targetDir, [], { STERLING_INIT_PRECHECK_ROOT: precheckRoot });
  assert.equal(r.code, 2, `expected preflight refusal: ${r.stderr}`);
  assert.match(
    r.stderr,
    /npm run build/,
    "remedy names npm run build when only packages/schemas/dist is missing — proves schemas' dist is independently checked, not skipped because store's is present"
  );
  assert.ok(!/npm ci\b/.test(r.stderr), 'node_modules already exists — the remedy must not also ask for npm ci');
});
// SABOTAGE: check only packages/store/dist/index.js and never
// packages/schemas/dist/index.js — this fixture has a present, valid store
// dist and an absent schemas dist, so a schemas-blind implementation exits 0
// and the exit-code assertion goes red.

test('T2b: node_modules present, packages/schemas/dist/index.js present, ONLY packages/store/dist/index.js missing -> exit 2, remedy names `npm run build`', () => {
  const precheckRoot = scratchDir('sterling-precheck-nostore-');
  mkdirSync(join(precheckRoot, 'node_modules'));
  mkdirSync(join(precheckRoot, 'packages', 'schemas', 'dist'), { recursive: true });
  writeFileSync(join(precheckRoot, 'packages', 'schemas', 'dist', 'index.js'), '// built schemas\n');
  const targetDir = scratchDir('sterling-bootstrap-target-');
  const r = spawnInit(targetDir, [], { STERLING_INIT_PRECHECK_ROOT: precheckRoot });
  assert.equal(r.code, 2, `expected preflight refusal: ${r.stderr}`);
  assert.match(
    r.stderr,
    /npm run build/,
    "remedy names npm run build when only packages/store/dist is missing — proves store's dist is independently checked, not skipped because schemas' is present"
  );
  assert.ok(!/npm ci\b/.test(r.stderr), 'node_modules already exists — the remedy must not also ask for npm ci');
});
// SABOTAGE: check only packages/schemas/dist/index.js and never
// packages/store/dist/index.js — this fixture has a present, valid schemas
// dist and an absent store dist, so a store-blind implementation exits 0 and
// the exit-code assertion goes red.

// =============================================================================
// T4 — package.json declares the postclone build step and a node engine.
// =============================================================================
test('T4: package.json declares scripts.prepare = "npm run build && npm run build:tui" (no build:hooks) and pins engines.node to ">=24"', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts?.prepare,
    'npm run build && npm run build:tui',
    'scripts.prepare runs both builds on a fresh clone / npm install (npm lifecycle hook)'
  );
  assert.ok(!String(pkg.scripts?.prepare).includes('build:hooks'), 'prepare does not fold in a build:hooks step');
  assert.equal(pkg.engines?.node, '>=24', 'engines.node is pinned to exactly >=24');
});
// SABOTAGE: change scripts.prepare to just "npm run build" (drop
// build:tui) — the equal() on scripts.prepare goes red. SABOTAGE: widen
// prepare to "npm run build && npm run build:tui && npm run build:hooks" —
// the build:hooks negative assertion goes red. SABOTAGE: change engines.node
// to '>=18', '', or remove the field — the exact-equal assertion goes red
// (a merely-non-empty check would have passed all three).
