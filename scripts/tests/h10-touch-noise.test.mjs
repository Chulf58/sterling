// H10 touch-noise precision (board 05e298f0).
//
// SPEC UNDER TEST (NOT YET IMPLEMENTED — every AC-numbered test below is
// expected to be RED, or at minimum unproven, against today's h10 code):
//
// Defect (retro 08-14, retro 08-15-1520): H10's capture/article demands key on
// raw file touches with no filtering. Reading a PNG or other binary/image file
// is inspection, not knowledge-producing work, yet it counts identically to a
// source edit and has fired ~8 false capture demands in one session. This
// slice narrows the CAPTURE lane's touch set: touched paths whose extension is
// one of .png/.jpg/.jpeg/.gif/.webp/.pdf are excluded from "was anything
// touched" before the capture duty is evaluated.
//
// Per the dispatching brief: agent-in-flight subagent-edit miscounting and
// diff-size weighting are OUT of this file's scope (separate ACs on the same
// board item) — only the image/binary-read exclusion (AC1/AC2) plus its
// regression guard (AC3) are covered here.
//
//   AC1 — a session whose only touches are images/binaries (no other files,
//         no capture) raises NO capture duty at Stop: release is immediate
//         (exit 0), no nag text, no capture_owed item minted.
//   AC2 — the same image touch ALONGSIDE one real source-file touch, still
//         nothing captured: the duty still fires exactly as it would with the
//         real file alone — the image neither adds to nor shields the duty.
//   AC3 (regression) — an ordinary session of only real source-file touches,
//         nothing captured, nags then mints capture_owed exactly as today —
//         proving the image filter does not over-match and swallow real work.
//
// AC4 (subagent-attributed touches) is DROPPED from this file. Every existing
// fixture that drives touches.json across scripts/tests/gitignore-frontier
// .test.mjs, scripts/tests/system-mint-idempotency.test.mjs and
// scripts/tests/h10-delegation-watch.test.mjs writes register entries as
// plain {path, at} — no per-entry attribution field (e.g. agent_id) appears
// anywhere in the register shape these tests drive. Inventing one here would
// violate the "never invent an interface" boundary. If touches.json gains
// per-entry attribution as part of this slice's implementation, AC4 belongs
// in a follow-up test added against that declared shape, not guessed here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH10Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-touch-noise-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

/** Simulates a session's file-touch register — files that exist, at a given time. */
function touchRegister(dir, paths) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at: '2026-08-20T12:00:00.000Z' }))));
}

const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);
const captureOwedItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'capture_owed');

// =========================================================================
// AC1 — image/binary-only touches raise no capture duty at all
// =========================================================================

test('AC1: a session whose only touches are reads of image/binary files raises NO capture duty — Stop releases clean on the first call', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    touchRegister(dir, [
      'assets/logo.png',
      'assets/photo.jpg',
      'assets/portrait.jpeg',
      'assets/anim.gif',
      'assets/icon.webp',
      'docs/spec.pdf',
    ]);
    const r = stop(dir);
    assert.equal(r.code, 0, 'image/binary-only touches must never soft-block — inspecting an image is not knowledge-producing work');
    assert.doesNotMatch(r.stderr, /nothing was captured/, 'no capture nag text at all for an image/binary-only session');
    assert.equal(captureOwedItems(store).length, 0, 'no capture_owed item is ever minted for an image/binary-only session');
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC2 — an image touch alongside a real source touch still drives the duty
// =========================================================================

test('AC2: one image read PLUS one real source-file touch still raises the capture duty — the image neither adds to nor shields it', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    touchRegister(dir, ['assets/logo.png', 'src/real.mjs']);
    const first = stop(dir);
    assert.equal(first.code, 2, 'the real source touch alone is enough to nag, exactly as if the image were never touched');
    assert.match(first.stderr, /nothing was captured/, 'capture duty nag present');

    const second = stop(dir);
    assert.equal(second.code, 0, 'second Stop releases and mints the durable item (P1)');

    const items = captureOwedItems(store);
    assert.equal(items.length, 1, 'exactly one capture_owed item — the image touch did not create a second, unrelated demand');
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC3 (regression) — ordinary source-only touches nag then mint, unchanged
// =========================================================================

test('AC3 (regression): a session of ordinary source-file touches with no capture nags then mints capture_owed exactly as today', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs']);
    const first = stop(dir);
    assert.equal(first.code, 2, 'ordinary unmet capture duty still nags exactly as before this slice');
    assert.match(first.stderr, /nothing was captured/);

    const second = stop(dir);
    assert.equal(second.code, 0, 'release mints the durable item');

    const items = captureOwedItems(store);
    assert.equal(items.length, 1, 'exactly one capture_owed item — the image/binary filter must never swallow real source touches');
  } finally {
    cleanup();
  }
});
