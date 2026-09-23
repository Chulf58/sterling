// Test-run lock-root isolation — scripts/tests/lib/lock-root-isolation.mjs.
//
// The dispatch-register lock database is never unlinked (decision
// `dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own`),
// so every temp project root a test locks leaves one <hash>.db behind in the
// lock root. `npm test` preloads lib/lock-root-isolation.mjs, which points
// XDG_RUNTIME_DIR at a per-run temp directory and removes it when the run
// exits. These pins prove the suite never writes into the real per-user lock
// root, that spawned hooks inherit the isolated root, and that teardown
// removes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerLockPath } from '../lib/dispatch-register.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, 'lib', 'lock-root-isolation.mjs');
const REGISTER = pathToFileURL(join(HERE, '..', 'lib', 'dispatch-register.mjs')).href;
const MARKER = 'STERLING_TEST_LOCK_ROOT';
const REAL_RUNTIME = `/run/user/${process.getuid()}`;

function project() {
  return mkdtempSync(join(tmpdir(), 'sterling-lockiso-'));
}

test('LRI-1: under the test harness the register lock root is the per-run temp root, never the real XDG runtime lock dir', () => {
  const root = process.env[MARKER];
  assert.ok(root, `${MARKER} is set — the suite must run with --import ./scripts/tests/lib/lock-root-isolation.mjs (npm test)`);
  assert.equal(process.env.XDG_RUNTIME_DIR, root, 'XDG_RUNTIME_DIR points at the per-run temp root');
  assert.ok(!root.startsWith(REAL_RUNTIME + sep) && root !== REAL_RUNTIME, `per-run root ${root} is not under ${REAL_RUNTIME}`);
  const dir = project();
  try {
    const lock = registerLockPath(dir);
    assert.equal(dirname(lock), join(root, 'sterling-locks'), `lock db ${lock} lives under the per-run root`);
    assert.ok(!lock.startsWith(REAL_RUNTIME + sep), `lock db ${lock} is not in the real runtime dir`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LRI-2: a spawned child process (a hook) inherits the isolated lock root', () => {
  const dir = project();
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { registerLockPath } = await import(${JSON.stringify(REGISTER)}); process.stdout.write(registerLockPath(${JSON.stringify(dir)}));`,
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(dirname(r.stdout), join(process.env[MARKER], 'sterling-locks'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LRI-3: a fresh run creates its own temp root and removes it — lock dbs included — when the run exits', () => {
  const dir = project();
  try {
    const env = { ...process.env };
    delete env[MARKER];
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(SETUP).href, '--input-type=module', '-e',
      `const { withRegisterLock, registerLockPath } = await import(${JSON.stringify(REGISTER)});
       const lock = registerLockPath(${JSON.stringify(dir)});
       await withRegisterLock(${JSON.stringify(dir)}, () => {});
       const { existsSync } = await import('node:fs');
       process.stdout.write(JSON.stringify({ root: process.env.${MARKER}, xdg: process.env.XDG_RUNTIME_DIR, lock, existed: existsSync(lock) }));`,
    ], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.root, 'the preload set the marker');
    assert.notEqual(out.root, process.env[MARKER], 'a fresh run gets its own root, not the parent run\'s');
    assert.equal(out.xdg, out.root);
    assert.equal(dirname(out.lock), join(out.root, 'sterling-locks'));
    assert.ok(out.existed, 'the lock db was created inside the per-run root');
    assert.ok(!existsSync(out.root), `teardown removed ${out.root}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
