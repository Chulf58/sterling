// H21 PRECISION FIX (spec-only, red-first — scripts/hooks/h21-delegation-live.mjs
// NOT read while authoring these tests; behavior below is the specified target,
// not observed current behavior). Feedback measured 10-11 firings/session with
// ~zero true positives: the hook "counts CALLS, not sizes", and its hand-work
// streak arm flags duties that structurally cannot be delegated (a conductor
// opening rendered plates for visual verdicts). This file specifies the fix:
//
//   AC1 (article arm, size-weighting) — config.delegation_watch.write_bytes_advise
//       (default 2000) gates a SINGLE hand-run store write; config.delegation_watch.
//       session_bytes_advise (default 8000) gates the CUMULATIVE size of a
//       session's hand-run store writes. Several small writes that never cross
//       either threshold stay silent; one write over the per-write threshold
//       advises immediately; several sub-threshold writes whose running total
//       crosses the session threshold advise on the write that crosses it.
//       The section is optional in config — its absence falls back to the
//       documented defaults, never a crash.
//   AC2 (streak arm, exemption) — Read calls on binary/image extensions
//       (.png/.jpg/.jpeg/.gif/.webp) never count toward the hand-work streak,
//       so a plate-inspection run of 20 image Reads fires nothing even though
//       20 > the default streak_threshold of 10. The exemption is scoped to
//       those exact extensions, not "anything image-shaped" — a run of .svg
//       reads (an image format NOT on the declared list) still counts.
//   AC3 (regression) — a genuine burst of several large hand-run store writes
//       in a row, no dispatch between them, still advises on each one: the
//       precision tuning narrows false positives, it does not neuter the arm.
//   AC4 (advisory-only) — every case above exits 0 (or, per the existing
//       contract, non-2 with an advisory) — NEVER exit 2 (blocking).
//
// FIXTURE ASSUMPTION (documented, not read from source): the only byte-
// denominated signal available to a PreToolUse hook for a knowledge_update /
// knowledge_append / knowledge_edit call is the serialized size of its
// tool_input. Payloads below are padded via a `content` string field so
// JSON.stringify(tool_input).length lands comfortably clear of every
// threshold boundary (wide margins, never edge-exact), so minor serialization
// overhead cannot flip a pass/fail. If the real implementation measures a
// narrower field, the AC-level semantics asserted here (silent under both
// thresholds / loud over either) still hold; only the byte totals below would
// need retuning, not the assertions themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

function runHook(input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h21-delegation-live.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function makeProject(config = BASE_CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h21-precision-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config) writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', ...over };
}

function additionalContextOf(r) {
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.additionalContext ?? null;
}

// Pads a tool_input to (at least) `bytes` serialized characters via a single
// `content` field, keeping wide margins from thresholds so JSON overhead
// (~13 chars for `{"content":""}`) never matters.
function payloadOfSize(bytes) {
  const overhead = 13;
  const padLen = Math.max(0, bytes - overhead);
  return { content: 'x'.repeat(padLen) };
}

const sizedCall = (toolName, bytes, prefix = 'mcp__sterling__') => ({
  tool_name: `${prefix}${toolName}`,
  tool_input: payloadOfSize(bytes),
});
const sizedUpdate = (bytes) => sizedCall('knowledge_update', bytes);
const sizedEdit = (bytes) => sizedCall('knowledge_edit', bytes);

const readOf = (dir, file) => ({ tool_name: 'Read', tool_input: { file_path: join(dir, file) } });

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// --------------------------- AC1: article arm, size-weighting ---------------------------

test('AC1a: several small hand-run writes whose cumulative size stays under the default session_bytes_advise (8000) fire no advisory at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    // 5 writes @ ~300 bytes each = ~1500 cumulative; each is also far under the
    // default per-write threshold (2000).
    for (let i = 0; i < 5; i++) {
      const r = runHook(sizedUpdate(300), dir);
      assert.equal(r.code, 0);
      assert.equal(
        additionalContextOf(r),
        null,
        `write #${i + 1} (300B, cumulative ~${300 * (i + 1)}B) must stay silent — under the old call-counting behavior every call advised regardless of size`
      );
    }
  } finally {
    cleanup();
  }
});

test('AC1b: a single hand-run write over the default write_bytes_advise (2000) advises immediately, as the very first call of the session, and the advisory is framed by size (not just a call count)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(sizedUpdate(2500), dir);
    assert.equal(r.code, 0);
    const ctx = additionalContextOf(r);
    assert.ok(ctx, 'a 2500B single write must advise even as call #1 (2500 > default write_bytes_advise 2000)');
    assert.match(ctx, /byte/i, 'the advisory names size/bytes as the reason — this text does not exist in the old call-counting message');
  } finally {
    cleanup();
  }
});

test('AC1c: several writes individually under write_bytes_advise (2000) whose running total crosses session_bytes_advise (8000) advise on the write that crosses it, not before', () => {
  const { dir, cleanup } = makeProject();
  try {
    // 1700B x 5 = running totals 1700, 3400, 5100, 6800, 8500 — crosses 8000 on write #5.
    // Every individual write (1700B) stays under the 2000B per-write threshold.
    for (let i = 0; i < 4; i++) {
      const r = runHook(sizedUpdate(1700), dir);
      assert.equal(
        additionalContextOf(r),
        null,
        `write #${i + 1} (running total ${1700 * (i + 1)}B) must stay silent — under 2000B per-write and under 8000B cumulative`
      );
    }
    const fifth = runHook(sizedUpdate(1700), dir);
    const ctx = additionalContextOf(fifth);
    assert.ok(ctx, 'write #5 (running total 8500B) crosses session_bytes_advise (8000) even though it is individually under write_bytes_advise (2000)');
    assert.match(ctx, /byte/i, 'the crossing advisory is framed by cumulative size, not a raw call count');
  } finally {
    cleanup();
  }
});

test('AC1d: config.delegation_watch.{write_bytes_advise,session_bytes_advise} are read from config, not hardcoded — a tightened config fires far earlier than the documented defaults would', () => {
  const { dir, cleanup } = makeProject({ ...BASE_CONFIG, delegation_watch: { write_bytes_advise: 100, session_bytes_advise: 300 } });
  try {
    // 90B each stays under the tightened 100B per-write threshold; totals
    // 90, 180, 270, 360 cross the tightened 300B session threshold on write #4.
    for (let i = 0; i < 3; i++) {
      const r = runHook(sizedUpdate(90), dir);
      assert.equal(additionalContextOf(r), null, `write #${i + 1} (running total ${90 * (i + 1)}B) stays under the tightened 300B session threshold`);
    }
    const fourth = runHook(sizedUpdate(90), dir);
    assert.ok(additionalContextOf(fourth), 'write #4 (running total 360B) crosses the tightened session_bytes_advise (300) — these bytes would never cross the 8000 default');
  } finally {
    cleanup();
  }
});

test('AC1e: config.delegation_watch section absent from config.json is tolerated — no crash, and the documented defaults (2000/8000) apply', () => {
  const { dir, cleanup } = makeProject(BASE_CONFIG); // BASE_CONFIG carries no delegation_watch key at all
  try {
    const small = runHook(sizedUpdate(300), dir);
    assert.equal(small.code, 0);
    assert.equal(additionalContextOf(small), null, 'a 300B write stays silent under the fallback default (2000) with no delegation_watch section present');

    const large = runHook(sizedUpdate(2500), dir);
    assert.equal(large.code, 0);
    assert.ok(additionalContextOf(large), 'a 2500B write still advises under the fallback default (2000) with no delegation_watch section present');
  } finally {
    cleanup();
  }
});

// --------------------------- AC2: streak arm, exemptions ---------------------------

test('AC2a: a plate-inspection run of 20 image Reads (.png/.jpg/.jpeg/.gif/.webp) fires no hand-work-streak advisory, even though 20 > the default streak_threshold (10)', () => {
  const { dir, cleanup } = makeProject();
  try {
    let call = 0;
    for (let i = 0; i < 20; i++) {
      const ext = IMAGE_EXTS[i % IMAGE_EXTS.length];
      const r = runHook(readOf(dir, `plates/frame-${i}.${ext}`), dir);
      call += 1;
      assert.equal(r.code, 0);
      assert.equal(
        additionalContextOf(r),
        null,
        `image read #${call} (.${ext}) must never count toward the hand-work streak — under today's unconditional counting, 20 distinct reads crosses the default threshold (10) at read #10`
      );
    }
  } finally {
    cleanup();
  }
});

test('AC2b: the image exemption is scoped exactly to the declared extensions — non-image reads interleaved with image reads still accumulate normally and still cross the default streak_threshold (10) on their own count', () => {
  const { dir, cleanup } = makeProject();
  try {
    // 9 distinct NON-image reads interleaved with 15 image reads: the image
    // reads must contribute nothing, so the streak must still read 9 (not 24)
    // and must NOT have crossed yet.
    for (let i = 0; i < 9; i++) {
      const r = runHook(readOf(dir, `src/module-${i}.mjs`), dir);
      assert.equal(additionalContextOf(r), null, `non-image read #${i + 1} of 9 must stay silent (below threshold 10)`);
    }
    for (let i = 0; i < 15; i++) {
      const ext = IMAGE_EXTS[i % IMAGE_EXTS.length];
      const r = runHook(readOf(dir, `plates/interleaved-${i}.${ext}`), dir);
      assert.equal(
        additionalContextOf(r),
        null,
        `interleaved image read #${i + 1} must never push the non-image count (currently 9) over the threshold (10)`
      );
    }
    // The 10th DISTINCT non-image read crosses the threshold — proving the
    // true streak count is 10 (9 + this one), never inflated by the 15 images.
    const tenthReal = runHook(readOf(dir, 'src/module-9.mjs'), dir);
    const ctx = additionalContextOf(tenthReal);
    assert.ok(ctx, 'the 10th distinct NON-image read crosses the default streak_threshold (10) — under unconditional counting this would already have fired at the very first image read (call #10 overall)');
  } finally {
    cleanup();
  }
});

test('AC2c: the exemption is scoped to the exact declared extensions, not a broad "looks like an image" heuristic — .svg reads (not on the declared list) still count toward the streak normally', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (let i = 0; i < 9; i++) {
      const r = runHook(readOf(dir, `icons/glyph-${i}.svg`), dir);
      assert.equal(additionalContextOf(r), null, `.svg read #${i + 1} of 9 stays under threshold`);
    }
    const tenth = runHook(readOf(dir, 'icons/glyph-9.svg'), dir);
    assert.ok(additionalContextOf(tenth), '.svg is not one of the five declared exempt extensions (.png/.jpg/.jpeg/.gif/.webp) — 10 distinct .svg reads must still cross the default streak_threshold (10)');
  } finally {
    cleanup();
  }
});

// --------------------------- AC3: regression, bulk hand-writes still advise ---------------------------

test('AC3: a burst of several large hand-run store writes in a row, no dispatch between them, still advises on EACH one — precision-tuning narrows false positives, it does not neuter the arm', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (let i = 0; i < 3; i++) {
      const r = runHook(sizedEdit(2500), dir);
      assert.equal(r.code, 0);
      const ctx = additionalContextOf(r);
      assert.ok(ctx, `burst write #${i + 1} (2500B, over write_bytes_advise) must still advise — the fix must not silence genuine bulk hand-writes`);
      assert.match(ctx, /byte/i, `burst write #${i + 1}'s advisory is still framed by size`);
      assert.match(ctx, /dac3d2c6/, `burst write #${i + 1} must still cite decision dac3d2c6 — the fix narrows false positives, it does not drop the underlying ruling`);
    }
  } finally {
    cleanup();
  }
});

// --------------------------- AC4: advisory-only, never exit 2 ---------------------------

test('AC4: every new fixture shape (size-weighted writes, streak bursts, exempt image reads) exits 0 — never exit 2, never blocks', () => {
  const { dir, cleanup } = makeProject();
  try {
    const calls = [
      sizedUpdate(300),
      sizedUpdate(2500),
      sizedEdit(2500),
      readOf(dir, 'plates/x.png'),
      readOf(dir, 'plates/x.jpg'),
      readOf(dir, 'plates/x.gif'),
      readOf(dir, 'plates/x.webp'),
      readOf(dir, 'plates/x.jpeg'),
    ];
    for (const call of calls) {
      const r = runHook(call, dir);
      assert.notEqual(r.code, 2, `${call.tool_name}(${JSON.stringify(call.tool_input).slice(0, 20)}...) must never deny — H21 is advisory-only`);
      assert.equal(r.code, 0, `${call.tool_name} should exit 0 on a well-formed call`);
    }
  } finally {
    cleanup();
  }
});

test('AC4: a corrupt/non-numeric delegation_watch size config fails open — falls back to defaults, never crashes, never exits 2', () => {
  const { dir, cleanup } = makeProject({ ...BASE_CONFIG, delegation_watch: { write_bytes_advise: 'not-a-number', session_bytes_advise: null } });
  try {
    const small = runHook(sizedUpdate(300), dir);
    assert.notEqual(small.code, 2, 'corrupt size config must never cause a deny');
    assert.equal(small.code, 0, `corrupt size config must fail open to a working default, not crash: ${small.stderr}`);

    const large = runHook(sizedUpdate(2500), dir);
    assert.notEqual(large.code, 2, 'corrupt size config must never cause a deny');
    assert.equal(large.code, 0, `corrupt size config must fail open to a working default, not crash: ${large.stderr}`);
  } finally {
    cleanup();
  }
});
