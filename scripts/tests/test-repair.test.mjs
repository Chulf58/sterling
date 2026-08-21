// scripts/test-repair.mjs — VISIBLE REPAIR half of decision
// frozen-test-repair-signatures-plus-visible-repair (knowledge_get
// 7a4c3fb6-dc23-4c2f-9369-d2592132f408; board a06e4a1c).
//
// The conductor stays sanctioned to hand-repair a demonstrably buggy frozen
// test (H5 rides coder/debugger frontmatter only; the conductor is exempt by
// construction) but the repair must stop being invisible: it records a
// test_repair session event — the repaired test path + the evidence for why
// the TEST, not the code, was wrong — mirroring scripts/no-capture.mjs's
// writer-script shape (a CLI, not a hook, appending to the same
// .sterling/transient/session-events.json register H10 reads).
//
// This file follows the no-capture.mjs coverage in hooks-full.test.mjs
// (search 'no-capture declaration' there) test-for-test: same spawnSync
// invocation shape, same register file, same refuse-on-blank convention —
// plus the ONE thing no_capture never needed: a target-glob check, because
// this register specifically claims a FROZEN-TEST repair, not an arbitrary
// edit, so an out-of-test-glob path must refuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'test-repair.mjs');
const REGISTER = ['.sterling', 'transient', 'session-events.json'];

// Same toolchain shape used throughout scripts/tests/hooks-full.test.mjs —
// test_globs is the ONE definition of "what is a test file" (H5/H4 consume
// the same declaration); test-repair.mjs must consume it too, not a
// private notion of "looks like a test".
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeProject(config = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-test-repair-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config !== null) {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function readEvents(dir) {
  const p = join(dir, ...REGISTER);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}

function writeEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, ...REGISTER), JSON.stringify(events));
}

function run(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('test-repair.mjs: --path and --evidence are both required and refused when blank; nothing is written on refusal', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.notEqual(run(dir, []).status, 0, 'no --path and no --evidence at all is refused');
    assert.notEqual(
      run(dir, ['--evidence', 'the assertion pinned a stale export name']).status,
      0,
      '--path missing entirely is refused'
    );
    assert.notEqual(
      run(dir, ['--path', 'tests/feature.spec.ts']).status,
      0,
      '--evidence missing entirely is refused'
    );
    assert.notEqual(
      run(dir, ['--path', '   ', '--evidence', 'why the test was wrong']).status,
      0,
      'a blank/whitespace-only --path is refused'
    );
    assert.notEqual(
      run(dir, ['--path', 'tests/feature.spec.ts', '--evidence', '   ']).status,
      0,
      'a blank/whitespace-only --evidence is refused'
    );
    assert.equal(readEvents(dir).length, 0, 'every refused invocation above wrote nothing to the register');
  } finally {
    cleanup();
  }
});

test('test-repair.mjs: a path outside every configured toolchain test glob is refused — this register is FROZEN-TEST repairs only', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = run(dir, ['--path', 'src/feature.mjs', '--evidence', 'the source file, not a test, was edited']);
    assert.notEqual(r.status, 0, 'src/feature.mjs matches neither tests/** nor **/*.test.mjs — refused');
    assert.equal(readEvents(dir).length, 0, 'a refused declaration writes nothing');
  } finally {
    cleanup();
  }
});

test('test-repair.mjs: a path matching a configured test glob appends a test_repair event carrying the path and the evidence', () => {
  const { dir, cleanup } = makeProject();
  try {
    const evidence = 'the assertion pinned the OLD export name from before the rename, not a behavior of the code';
    const r = run(dir, ['--path', 'tests/feature.spec.ts', '--evidence', evidence]);
    assert.equal(r.status, 0, r.stderr);
    const events = readEvents(dir).filter((e) => e.kind === 'test_repair');
    assert.equal(events.length, 1, 'exactly one test_repair event is appended');
    assert.match(events[0].detail, /tests\/feature\.spec\.ts/, 'detail names the repaired path');
    assert.match(events[0].detail, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'detail carries the evidence summary');
    assert.ok(typeof events[0].at === 'string' && events[0].at.length > 0, 'at is stamped');
  } finally {
    cleanup();
  }
});

test('test-repair.mjs: a path matching the OTHER configured glob shape (**/*.test.mjs, not under tests/**) is accepted too', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = run(dir, ['--path', 'src/feature.test.mjs', '--evidence', 'the fixture built a stale directory layout the code no longer produces']);
    assert.equal(r.status, 0, r.stderr);
    const events = readEvents(dir).filter((e) => e.kind === 'test_repair');
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /src\/feature\.test\.mjs/);
  } finally {
    cleanup();
  }
});

test('test-repair.mjs: a valid declaration APPENDS — pre-existing register entries survive untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    const NOW = '2026-06-10T12:00:00.000Z';
    writeEvents(dir, [{ kind: 'research_tool', detail: 'WebSearch: prior work', at: NOW }]);
    const r = run(dir, ['--path', 'tests/feature.spec.ts', '--evidence', 'the test asserted the old signature']);
    assert.equal(r.status, 0, r.stderr);
    const events = readEvents(dir);
    assert.equal(events.length, 2, 'the pre-existing event survives; the new one is appended, not a replace');
    assert.equal(events[0].kind, 'research_tool');
    assert.equal(events[1].kind, 'test_repair');
  } finally {
    cleanup();
  }
});

test('test-repair.mjs: fails closed (nonzero) when no toolchain config exists to check the path against', () => {
  const { dir, cleanup } = makeProject(null);
  try {
    const r = run(dir, ['--path', 'tests/feature.spec.ts', '--evidence', 'a genuine test bug']);
    assert.notEqual(r.status, 0, 'with no configured test_globs to verify against, the script must not silently accept the path');
    assert.equal(readEvents(dir).length, 0);
  } finally {
    cleanup();
  }
});


// ---------------------------------------------------------------------------
// STRENGTHENING (review 2026-08-21): the path invariant at the register
// boundary — backslash forms normalize, absolute/escaping forms are refused.
// ---------------------------------------------------------------------------
test('test-repair.mjs: a backslash path normalizes to repo-relative POSIX in the stored detail; absolute and parent-escaping paths are refused', () => {
  const { dir, cleanup } = makeProject();
  try {
    const ok = run(dir, ['--path', 'tests\\feature.spec.ts', '--evidence', 'backslash form from a Windows shell']);
    assert.equal(ok.status, 0, ok.stderr);
    const ev = readEvents(dir).filter((e) => e.kind === 'test_repair');
    assert.equal(ev.length, 1);
    assert.ok(ev[0].detail.startsWith('tests/feature.spec.ts — '), `stored detail leads with the NORMALIZED path: ${ev[0].detail}`);

    assert.notEqual(run(dir, ['--path', '/abs/tests/feature.spec.ts', '--evidence', 'x']).status, 0, 'absolute path refused');
    assert.notEqual(run(dir, ['--path', '../tests/feature.spec.ts', '--evidence', 'x']).status, 0, 'parent-escaping path refused');
    assert.equal(readEvents(dir).filter((e) => e.kind === 'test_repair').length, 1, 'refusals wrote nothing further');
  } finally {
    cleanup();
  }
});
