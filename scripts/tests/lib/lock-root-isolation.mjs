// Test-run lock-root isolation — preloaded by `npm test` via
// `node --import ./scripts/tests/lib/lock-root-isolation.mjs --test ...`.
//
// The dispatch-register lock database is never unlinked (decision
// `dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own`),
// and its root is $XDG_RUNTIME_DIR/sterling-locks — so without this preload
// every temp project root a test locks leaves one <hash>.db in the real
// per-user runtime dir, forever.
//
// The FIRST process of a run (the test runner) creates a private temp
// directory, points XDG_RUNTIME_DIR at it and marks it in
// STERLING_TEST_LOCK_ROOT; every test-file subprocess and every hook those
// tests spawn inherits both through process.env. Processes that see the
// marker already set leave it alone. Only the process that created the root
// removes it, when it exits.
//
// Does NOT guarantee: isolation for a test file run without this preload, a
// test that spawns a child with an env built from scratch (it falls back to
// /tmp/sterling-locks-<uid>), or cleanup when the runner is killed by a
// signal it cannot handle (SIGKILL) — the leftover is then a temp dir.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'STERLING_TEST_LOCK_ROOT';

if (!process.env[MARKER]) {
  const root = mkdtempSync(join(tmpdir(), 'sterling-test-runtime-'));
  process.env[MARKER] = root;
  process.env.XDG_RUNTIME_DIR = root;
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      rmSync(root, { recursive: true, force: true });
      process.kill(process.pid, signal);
    });
  }
}
