// SLICE S0 of the hollow-test mutation arm — BUILD ISOLATION pins (AC1-AC3).
// SPEC ONLY, red-first. Written blind (H4 read wall): the author never read
// scripts/build-hooks.mjs.
//
// Governing records — read these before changing anything here:
//   decision  1dab2a9f [hollow-test-mutation-arm-design-accepted-sequenced-enablement]
//   anti_pat  37b3cb0a [a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree] (severity BLOCK)
//   decision  23afbc83 [conductor-executes-test-writer-sabotage-clean-room]
//   board     5402a024 (slice list; Codex preconditions P1/P3)
//
// WHY S0 EXISTS. The arm mutates a named enforcement guard and asserts a named
// test goes red. 37b3cb0a is severity BLOCK because a suite that builds the
// shipped artifact IN PLACE makes mutation an act of SABOTAGE: sabotaged source
// compiled into hooks/ is broken enforcement on disk for every subsequent agent
// call. scripts/build-hooks.mjs today has --out-dir but NO --src-dir, so a build
// always READS the live sources — mutating a copy changes nothing. --src-dir is
// therefore the containment prerequisite, not a convenience, and nothing above
// S0 may be built until these pins hold.
//
// MUTATION DISCIPLINE (23afbc83): this file DESIGNS the sabotage for every pin
// and names it in the pin's own comment; it never EXECUTES one. The conductor
// applies each named one-liner to a clean-room COPY, confirms the named pin
// flips red while the named control stays green, and deletes the copy.
//
// EXPECTED FAILURE SHAPE TODAY (before --src-dir exists), per test, all plain
// assertion_fail — never a runner crash, because every assertion compares a
// CAPTURED spawnSync result and never throws inside the test body:
//   CONTROL (default build)      GREEN today  (--out-dir already ships).
//   AC1 marker-in-output         RED at `assert.equal(build.status, 0, ...)`
//                                (unknown flag) or, if the flag is accepted and
//                                ignored, at the marker assertion.
//   AC2 (four arms)              RED at `assert.equal(r.status, 1, ...)` and/or
//                                at the empty-out-dir assertion (a fall-through
//                                implementation exits 0 AND emits bundles).
//   AC3 live-tree invariance     GREEN-BY-VACUITY RISK is closed by the
//                                non-empty-snapshot assertion; today it goes RED
//                                at the build's `assert.equal(status, 0)` guard
//                                that precedes the identity comparison.
//
// SCOPE NOTE / FLAGGED, NOT FIXED: hook sources import workspace packages
// (@sterling/schemas at scripts/hooks/h3-contract-gate.mjs:10). A clean room in
// the OS tmpdir cannot reach the repo's node_modules by ordinary node
// resolution, so S0 must SOLVE workspace resolution for an out-of-repo --src-dir
// (esbuild nodePaths/alias/absWorkingDir — implementer's choice). These pins
// deliberately place the clean room in os.tmpdir() because the accepted design's
// clean room is `mkdtemp` and the git-worktree alternative was REJECTED
// (anti_pattern e2a1fee8). If the build cannot be made to work from tmpdir, that
// is a DESIGN escalation — do not relocate the clean room into the repo tree to
// make these pins pass: a clean room inside the repo re-opens the very blast
// radius 37b3cb0a is about.
//
// HARNESS NOTE: BUILD is resolved through the STERLING_BUILD_HOOKS env seam
// (default: the live scripts/build-hooks.mjs) so a clean-room COPY of the build
// script itself can be exercised by these same pins without a matching copy of
// this test file living beside it (H5 / leave-nothing-behind forbid that, and
// H14 denies running `node --test` outside the repo root). The seam exists for
// clean-room mutation per 23afbc83, not as test-only convenience — see
// research_finding 01cab59b.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Path seam mirroring the routing file's SEAM constant
// (mutation-arm-s0-hooks-dir-routing.test.mjs): unset, BUILD resolves to the
// exact same hardcoded path as before this seam existed. Set, it lets a
// clean-room COPY of build-hooks.mjs be mutated and exercised by these pins
// in place — the containment the mutation protocol (23afbc83) requires.
const BUILD_SEAM = 'STERLING_BUILD_HOOKS';
const BUILD = process.env[BUILD_SEAM] || join(root, 'scripts', 'build-hooks.mjs');
const LIVE_HOOKS = join(root, 'hooks');

// The hook whose COPY carries the deliberate marker. Any shipped hook would do;
// this one is picked because it is dependency-light and also the routing target
// in the sibling file (mutation-arm-s0-hooks-dir-routing.test.mjs).
const MARK_HOOK = 'h24-gate-exit-lint.mjs';

const rooms = [];

// Anti-pattern ee89c3fd: raw multi-line child stderr interpolated into a message
// that is EXPECTED to fail poisons the TAP crash/assertion classifier, and a red
// gate then cannot tell "the pin caught the sabotage" from "the harness fell
// over" — which is the entire currency of a mutation battery. Flatten only,
// NEVER truncate.
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function runBuild(args) {
  const r = spawnSync(process.execPath, [BUILD, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : '' };
}

function outDir() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-s0-out-'));
  rooms.push(d);
  return d;
}

// A clean room holding a COPY of scripts/ (minus scripts/tests, which is bulk we
// never build) so that every `../lib/...` relative import inside a hook source
// still resolves inside the room. The marker is appended to ONE hook COPY.
function cleanRoomWithMarker(marker) {
  const room = mkdtempSync(join(tmpdir(), 'sterling-s0-src-'));
  rooms.push(room);
  const scripts = join(room, 'scripts');
  cpSync(join(root, 'scripts'), scripts, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(root.length + 1).split(sep).join('/');
      return !rel.startsWith('scripts/tests') && !rel.includes('node_modules');
    },
  });
  if (marker) {
    // A side-effectful top-level statement with a STRING LITERAL payload: esbuild
    // preserves both (entry points are never tree-shaken away, and the literal
    // survives identifier renaming), so its presence in the emitted bundle is
    // attributable to the SOURCE the build read — nothing else.
    appendFileSync(
      join(scripts, 'hooks', MARK_HOOK),
      `\nglobalThis.__STERLING_S0_SRC_DIR_MARKER__ = ${JSON.stringify(marker)};\n`,
    );
  }
  return { room, srcDir: join(scripts, 'hooks') };
}

// CONTENT identity, not mtime+size. Codex's review (board 5402a024 precondition
// P3): mtime+size is DEFEATABLE — a same-size content change plus a utimes
// restore, or a timestamp-resolution collapse, both slip through, and this repo's
// own tests demonstrate that class deliberately
// (scripts/tests/h17-pre-state-snapshot.test.mjs:1998,2040,2154).
// BUT the mtime layer is kept BESIDE it, not replaced by it: 37b3cb0a's guidance
// is that on a clean tree an in-place rebuild emits BYTE-IDENTICAL output, so a
// content-only comparison passes while the live surface was in fact rewritten.
// Neither layer subsumes the other; the comparison below reports WHICH one fired.
function snapshotTree(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const rel = String(entry).split(sep).join('/');
    const abs = join(dir, String(entry));
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      out.set(rel + '/', { type: 'dir' });
      continue;
    }
    const bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
    out.set(rel, {
      type: st.isSymbolicLink() ? 'symlink' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return out;
}

function assertTreeIdentical(before_, after_, when) {
  assert.deepEqual(
    [...after_.keys()].sort(),
    [...before_.keys()].sort(),
    `${when}: the file SET under hooks/ changed — a build wrote into the live enforcement surface (anti_pattern 37b3cb0a)`,
  );
  for (const [rel, b] of before_) {
    const a = after_.get(rel);
    assert.equal(a.type, b.type, `${when}: hooks/${rel} changed TYPE`);
    // CONTENT layer — catches a same-size rewrite even with the timestamp restored.
    assert.equal(a.sha256, b.sha256, `${when}: hooks/${rel} CONTENT changed (sha256) — the live bundle was rewritten`);
    // MTIME layer — catches a byte-identical in-place rebuild, which the content
    // layer cannot see (37b3cb0a right_way; decision cf863d84's hollow-pin class).
    assert.equal(a.mtimeMs, b.mtimeMs, `${when}: hooks/${rel} MTIME moved — the live bundle was REWRITTEN even though its bytes are identical`);
  }
}

function gitPorcelain() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: (r.stdout ?? '').split('\n').filter(Boolean).sort().join('\n'), err: oneLine(r.stderr) };
}

let BASELINE;

before(() => {
  BASELINE = snapshotTree(LIVE_HOOKS);
  // VACUITY GUARD: an empty snapshot would make every identity assertion below
  // trivially true. On an unbuilt clone this fails LOUDLY instead of certifying
  // nothing (P5) — run `npm run build:hooks` first.
  assert.ok(BASELINE.size > 0, 'hooks/ is empty or missing — the live-tree pins would be vacuous; build the bundles first');
  assert.ok(BASELINE.has('hooks.json'), 'hooks/hooks.json is missing — the live-tree pins would not cover the registration file');
});

after(() => {
  // WHOLE-FILE invariance: the design requires a tree-identity check at BOTH ENDS
  // of every clean-room build, not only around the one test that names it.
  assertTreeIdentical(BASELINE, snapshotTree(LIVE_HOOKS), 'end of file');
  for (const d of rooms) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CONTROL ARM — PLACED FIRST. It must pass for the OPPOSITE reason to AC1: with
// NO --src-dir, a default build emits a bundle that does NOT contain the marker.
// Without this arm, AC1's verdict has more than one possible cause (the marker
// could be ambient in the tree, or every build could emit it), and a green would
// carry no evidence. This arm is GREEN TODAY — --out-dir already ships.
// SABOTAGE: make build-hooks always emit the string
// 'STERLING-S0-SRC-DIR-MARKER' into every bundle -> CONTROL red (marker present
// in a default build), which is precisely the ambient-marker cause AC1 must rule out.
// ---------------------------------------------------------------------------
test('CONTROL: a DEFAULT build (no --src-dir) emits a bundle with no clean-room marker', () => {
  const out = outDir();
  const build = runBuild(['--out-dir', out]);
  assert.equal(build.status, 0, `default build must still work: ${oneLine(build.stderr || build.error)}`);
  const bundle = join(out, MARK_HOOK);
  assert.ok(existsSync(bundle), `default build did not emit ${MARK_HOOK} into --out-dir`);
  assert.ok(
    !readFileSync(bundle, 'utf8').includes('STERLING-S0-SRC-DIR-MARKER'),
    'a default build already contains the clean-room marker — AC1 could not attribute the marker to --src-dir',
  );
});

// ---------------------------------------------------------------------------
// AC1 — --src-dir changes the OUTPUT, not merely the exit code.
// The pin is the MARKER, never `status === 0`: a build that accepts the flag and
// ignores it exits 0 while compiling the LIVE sources, which is exactly the
// silent no-op this whole slice exists to make impossible.
// SABOTAGE: make --src-dir parse-and-ignore (keep reading scripts/hooks) -> AC1 red
// at the marker assertion. The `status === 0` assertion alone would SURVIVE that
// mutation — it is a precondition guard, not the verdict-carrying assertion.
// CARRIES THE VERDICT: the `includes(marker)` assertion.
// ---------------------------------------------------------------------------
test('AC1: a bundle built with --src-dir contains a marker that exists ONLY in the relocated source', () => {
  const marker = `STERLING-S0-SRC-DIR-MARKER-${randomUUID()}`;
  const { srcDir } = cleanRoomWithMarker(marker);
  const out = outDir();

  const build = runBuild(['--src-dir', srcDir, '--out-dir', out]);
  assert.equal(build.status, 0, `--src-dir build failed: ${oneLine(build.stderr || build.error)}`);

  const bundle = join(out, MARK_HOOK);
  assert.ok(existsSync(bundle), `--src-dir build emitted no ${MARK_HOOK}: ${oneLine(build.stderr)}`);
  assert.ok(
    readFileSync(bundle, 'utf8').includes(marker),
    'the emitted bundle does NOT contain the relocated source\'s marker — --src-dir did not change what the build READ (a silent no-op: exit 0 while compiling the live tree)',
  );
  // And the live shipped bundle never gained it — the marker lived only in the copy.
  assert.ok(
    !readFileSync(join(LIVE_HOOKS, MARK_HOOK), 'utf8').includes('STERLING-S0-SRC-DIR-MARKER'),
    'the LIVE bundle contains a clean-room marker — mutation would be sabotage of the shipped enforcement surface (anti_pattern 37b3cb0a)',
  );
});

// ---------------------------------------------------------------------------
// AC2 — STRICT PARSING. Fail loud, never silent (P5). Each arm pins TWO things:
// the non-zero exit AND the absence of any emitted bundle, because "exits 1" on
// its own is satisfiable by an implementation that ALSO fell through and built
// from the default source dir first. The empty --out-dir is what actually pins
// "never falls through".
// SABOTAGE (the named one): make --src-dir fall back to the default source dir
// when the directory is missing/malformed -> AC2 red (status is 0 and the out-dir
// is full of bundles). Both layers fire; the OUT-DIR-EMPTY layer is the one that
// carries the fall-through verdict.
// ---------------------------------------------------------------------------
for (const arm of [
  {
    name: 'missing value (flag is the last argument)',
    args: (ctx) => ['--out-dir', ctx.out, '--src-dir'],
    expect: 1,
  },
  {
    name: 'directory does not exist',
    args: (ctx) => ['--src-dir', join(ctx.room, 'no-such-source-dir'), '--out-dir', ctx.out],
    expect: 1,
  },
  {
    name: 'value is a FILE, not a directory',
    args: (ctx) => ['--src-dir', ctx.file, '--out-dir', ctx.out],
    expect: 1,
  },
  {
    name: 'unrecognized near-miss flag (--src-dirs)',
    args: (ctx) => ['--src-dirs', ctx.srcDir, '--out-dir', ctx.out],
    expect: 'nonzero', // pre-existing unknown-arg shape; pinned as non-zero, not as a specific code
  },
]) {
  test(`AC2: --src-dir strict parsing — ${arm.name} exits non-zero and NEVER falls through to the default source`, () => {
    const { room, srcDir } = cleanRoomWithMarker(null);
    const out = outDir();
    const file = join(room, 'not-a-directory.txt');
    writeFileSync(file, 'not a directory');

    const r = runBuild(arm.args({ room, srcDir, out, file }));

    if (arm.expect === 'nonzero') {
      assert.notEqual(r.status, 0, `a malformed argument must exit non-zero: ${oneLine(r.stdout)}`);
    } else {
      assert.equal(r.status, arm.expect, `expected exit ${arm.expect}: ${oneLine(r.stderr || r.stdout || r.error)}`);
    }
    assert.ok(oneLine(r.stderr).length > 0, 'a refusal must SAY something on stderr — a silent non-zero exit is not fail-loud (P5)');
    assert.deepEqual(
      readdirSync(out),
      [],
      'the build EMITTED bundles despite a malformed --src-dir — it fell through to the default source dir, which is exactly the in-place read the flag exists to prevent',
    );
  });
}

// ---------------------------------------------------------------------------
// AC3 — LIVE-TREE INVARIANCE. The safety pin, and the reason 37b3cb0a is severity
// BLOCK. Two independent layers plus a git arm; the message names which one fired:
//   CONTENT (sha256) — catches a same-size rewrite with the timestamp restored.
//   MTIME           — catches a byte-identical in-place rebuild, invisible to content.
//   git porcelain   — catches NEW dirt anywhere in the repo, including files no
//                     hooks/ snapshot would cover.
// This is DEFENCE IN DEPTH, not redundancy: neither of the first two is
// load-bearing alone, and a mutation that strips only one may legitimately survive.
// SABOTAGE A: make --out-dir default to hooks/ when --src-dir is given -> AC3 red;
//   on a clean tree the MTIME layer carries the verdict, and the CONTENT layer
//   fires too here because the relocated source's marker changes the bytes.
// SABOTAGE B: have the build write hooks/hooks.json unconditionally -> AC3 red at
//   the CONTENT layer for hooks.json (and at the git arm).
// SABOTAGE C (hollowness probe): strip BOTH the content and mtime layers, leaving
//   only git -> must STILL go red for A and B, since both dirty the tree.
// ---------------------------------------------------------------------------
test('AC3: a --src-dir/--out-dir build leaves every byte under hooks/ (and hooks/hooks.json) untouched', () => {
  const marker = `STERLING-S0-SRC-DIR-MARKER-${randomUUID()}`;
  const { srcDir } = cleanRoomWithMarker(marker);
  const out = outDir();

  const beforeTree = snapshotTree(LIVE_HOOKS);
  assert.ok(beforeTree.size > 0 && beforeTree.has('hooks.json'), 'live bundle snapshot is empty — this pin would be vacuous');
  const beforeGit = gitPorcelain();
  assert.equal(beforeGit.status, 0, `git status must be runnable for this pin to mean anything: ${beforeGit.err}`);

  const build = runBuild(['--src-dir', srcDir, '--out-dir', out]);
  // Tree identity is checked at BOTH ends regardless of the build's own verdict,
  // so a FAILED build that still dirtied the live tree cannot hide behind its
  // own non-zero exit. Identity first, build status second.
  assertTreeIdentical(beforeTree, snapshotTree(LIVE_HOOKS), 'after a --src-dir build');

  const afterGit = gitPorcelain();
  assert.equal(afterGit.status, 0, `git status failed after the build: ${afterGit.err}`);
  assert.equal(
    afterGit.out,
    beforeGit.out,
    'the build introduced NEW dirt into the working tree — a clean-room build must touch nothing tracked or untracked in the repo',
  );

  assert.equal(build.status, 0, `--src-dir build failed: ${oneLine(build.stderr || build.error)}`);
  assert.ok(
    readFileSync(join(out, MARK_HOOK), 'utf8').includes(marker),
    'the build produced no relocated output to be invariant ABOUT — invariance over a build that did nothing is vacuous',
  );
});
