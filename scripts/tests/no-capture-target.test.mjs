// SPEC-ONLY pins for the REMOVED `--target` flag on scripts/no-capture.mjs
// (dispatch brief REVIEW-TERRITORY: ["scripts/tests/no-capture-target.test.mjs"]).
//
// scripts/no-capture.mjs is a sanctioned CLI that records a "no capture owed"
// session event. It writes to <cwd>/.sterling/transient/session-events.json —
// the INVOKING PROJECT only. It used to accept a `--target <dir>` flag that
// let the caller redirect that write to an arbitrary directory with no
// project-containment check; that flag has been REMOVED. This file pins
// the following behaviours:
//   1. `--target <dir>` (split form) is refused loudly (exit 1, a specific
//      removal message, and NO file created anywhere — neither at the named
//      target nor in the invoking cwd).
//   2. The bare invocation (no `--target`) writes the session event to
//      exactly <cwd>/.sterling/transient/session-events.json, where <cwd>
//      is the spawned process's working directory — the write actually
//      appended the passed-in reason (not an emptied array), and nothing
//      was also written to a sibling/parent location.
//   3. `--target=<dir>` (equals form) is refused just as loudly as the
//      split form above — added after review found this spelling entirely
//      unpinned.
// Pin 2's tightening and pin 3 were added in a follow-up extension after
// two independent reviews found gaps that stayed green under a real
// regression (see the comments on each assertion for the named sabotage).
//
// EXECUTION DISCLOSURE: the test-writer role holds no Bash by design (H4
// read wall) — this file was never run. Per the conductor's mid-task
// correction, the "verify before reporting" step is skipped entirely; the
// conductor runs the gate. This file was also written WITHOUT reading
// scripts/no-capture.mjs or scripts/lib/store-remediation.mjs at all — H4
// denied every attempted read of scripts/no-capture.mjs (including a
// 1-line-limited read aimed only at its header usage comment; the wall
// keys on the path, not the byte range read). The CLI's ordinary required
// argument (`--reason <text>`) and its optional `--lane <research|capture|
// all>` argument were instead derived from OTHER test files in this
// directory that already invoke the script as a black box — specifically
// scripts/tests/h10-no-capture-lane-scope.test.mjs (L9's `spawnSync(...,
// ['--reason', ..., '--lane', 'bogus'], ...)`) and scripts/tests/
// h10-lane-scope-leak-and-owed-truncation.test.mjs's `declareNoCapture`
// helper (`['--reason', reason]`, no `--lane`, accepted with status 0 and
// exactly one bare no_capture event landing in the register). Those are
// test files, not the implementation under test, and the brief explicitly
// sanctions reading siblings for harness conventions — this reuses that
// same permission to also recover the CLI's argument shape, since the
// header comment route was blocked by the wall in practice.
//
// Each test below states its own EXPECTED FAILURE SHAPE and the ONE-LINE
// SABOTAGE that must turn it red, per this role's output contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'no-capture.mjs');

// Matches the toolchain/caps/context_watch shape every sibling H10/no-capture
// suite seeds before invoking a sanctioned script against a fresh project dir
// (scripts/tests/h10-no-capture-lane-scope.test.mjs's CONFIG constant,
// scripts/tests/h10-lane-scope-leak-and-owed-truncation.test.mjs's
// H10_CONFIG). Reused verbatim in shape so a config-shape assumption is not
// invented fresh here.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  return dir;
}

function runNoCapture(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
}

const eventsPathIn = (projectDir) => join(projectDir, '.sterling', 'transient', 'session-events.json');

// ===========================================================================
// PIN 1 — `--target` is refused loudly and writes nothing, anywhere.
// ===========================================================================

test('--target is refused loudly: exit 1, the exact removal message, and NO file created at either the named target or the invoking cwd', () => {
  const dir = makeProject('sterling-no-capture-target-invoker-');
  const targetDir = mkdtempSync(join(tmpdir(), 'sterling-no-capture-target-elsewhere-'));
  try {
    const r = runNoCapture(
      ['--reason', 'read-only follow-up; nothing durable learned', '--target', targetDir],
      dir,
    );

    // EXPECTED FAILURE SHAPE if this assertion goes red: exit code is 0 (or
    // anything other than 1), meaning the removed --target flag was silently
    // accepted or silently ignored rather than refused.
    // SABOTAGE: change the CLI's exit code on an unrecognized/removed
    // --target from `process.exit(1)` to `process.exit(0)` — this assertion
    // alone goes red while the message/file assertions below may still pass,
    // which is exactly why they are pinned separately rather than folded
    // into one combined check.
    assert.equal(
      r.status,
      1,
      `SILENT-ACCEPT/IGNORE SHAPE if this is not 1: --target must be refused loudly, not silently accepted or silently ignored as an unknown flag. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EXPECTED FAILURE SHAPE if this goes red: the exit code is 1 but the
    // message is generic/opaque (e.g. "invalid arguments") or missing
    // entirely, so a caller cannot tell --target specifically was removed
    // from any other CLI parse failure.
    // SABOTAGE: change the refusal message text to something generic like
    // "invalid arguments" while keeping exit code 1 — this assertion goes
    // red even though PIN 1's exit-code assertion stays green, proving the
    // message is a distinct, load-bearing check and not redundant with it.
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /--target was removed: the event is written to the invoking project only/,
      `GENERIC-OR-MISSING-MESSAGE SHAPE: the refusal must name the specific removed flag and the reason. stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EXPECTED FAILURE SHAPE if either of these three assertions goes red:
    // a file exists somewhere, meaning the refusal happened AFTER a write
    // (or the redirect partially still worked) rather than before any write
    // at all.
    // SABOTAGE: move the --target refusal check to AFTER the session-event
    // write instead of before it (or leave the old redirect-to-target write
    // path in place alongside the new refusal) — any of these three
    // existsSync assertions goes red, proving a file was written despite the
    // loud refusal.
    assert.equal(
      existsSync(eventsPathIn(targetDir)),
      false,
      'REDIRECT-STILL-WORKS SHAPE: no file was written at the old target-directory redirect path',
    );
    assert.equal(
      existsSync(join(targetDir, 'session-events.json')),
      false,
      'REDIRECT-STILL-WORKS SHAPE (bare path variant): no file was written directly at the named target directory either',
    );
    assert.equal(
      existsSync(eventsPathIn(dir)),
      false,
      'REFUSE-AFTER-WRITE SHAPE: no file was written in the invoking cwd either — the refusal happens before any write, matching the existing honesty-surface precedent (a refusal never leaves a write behind)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 2 — the bare invocation (no --target) writes to the invoking project.
// ===========================================================================

test('bare invocation (no --target) writes the session event to exactly <cwd>/.sterling/transient/session-events.json, where <cwd> is the invoking project, and nowhere else', () => {
  // Tightened per two independent-review findings that stayed GREEN under the
  // original (looser) pin 2:
  //   (a) an EMPTIED WRITE — the file exists but the append never actually
  //       happened, so an empty array (or an array missing the passed-in
  //       reason) would still satisfy a bare existsSync check;
  //   (b) a DOUBLE WRITE — "exactly <cwd>/..." was asserted only by checking
  //       that the cwd path exists, never that no OTHER path also received a
  //       write, so a write to cwd AND some other location stayed green.
  // Both are now pinned below. To exercise (b) the invoking project and an
  // untouched sibling directory are created as siblings under one parent
  // temp dir, so any write that escapes the project directory lands
  // somewhere this test can see.
  const REASON = 'PIN2-TIGHTEN-REASON-7f3a2b19-do-not-genericize-this-string';
  const parent = mkdtempSync(join(tmpdir(), 'sterling-no-capture-target-bare-'));
  const dir = join(parent, 'project');
  const sibling = join(parent, 'sibling');
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
    mkdirSync(sibling, { recursive: true });

    const r = runNoCapture(['--reason', REASON], dir);

    // EXPECTED FAILURE SHAPE if this goes red: the bare invocation (the
    // ordinary, documented shape) is itself refused or crashes, which would
    // mean removing --target broke the normal path rather than only the
    // redirect.
    // SABOTAGE: make the --target-removal refusal check fire unconditionally
    // (e.g. drop the guard so it always exits 1 regardless of whether
    // --target was actually passed) — this assertion goes red even though
    // no --target argument is present in this invocation at all.
    assert.equal(
      r.status,
      0,
      `BARE-INVOCATION-BROKEN SHAPE if this is not 0: the ordinary invocation with no --target must succeed. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EXPECTED FAILURE SHAPE if this goes red: no file exists at the exact
    // invoking-project path, meaning either nothing was written at all, or
    // it was written somewhere else (e.g. a leftover redirect default, or a
    // path outside .sterling/transient).
    // SABOTAGE: change the write path from `join(cwd, '.sterling',
    // 'transient', 'session-events.json')` to any other location (a
    // hardcoded absolute path, a different subdirectory, or the removed
    // --target default) — this assertion goes red because the exact
    // expected path no longer exists.
    const expected = eventsPathIn(dir);
    assert.equal(
      existsSync(expected),
      true,
      `NO-WRITE-OR-WRONG-LOCATION SHAPE: the session event must land at exactly ${expected}. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EMPTIED-WRITE pin: the file existing is not enough — it must parse to
    // an array holding at least the one event just declared, and that event
    // must actually carry the reason text this invocation passed in.
    // EXPECTED FAILURE SHAPE if this goes red: the file is valid JSON but is
    // `[]`, or contains an entry that has lost/mangled the reason text.
    // SABOTAGE: change the append logic to serialize an empty array
    // regardless of input (e.g. write `[]` instead of pushing the new event
    // before serializing), OR construct the written event object without its
    // reason/detail field — either sabotage leaves the file present (the
    // existsSync assertion above stays green) while this assertion goes red.
    const parsed = JSON.parse(readFileSync(expected, 'utf8'));
    assert.equal(
      Array.isArray(parsed),
      true,
      `EMPTIED-WRITE SHAPE: session-events.json must parse to an array. content=${JSON.stringify(parsed)}`,
    );
    assert.ok(
      parsed.length >= 1,
      `EMPTIED-WRITE SHAPE: session-events.json must contain at least one entry after a bare invocation, got length ${parsed.length}`,
    );
    assert.ok(
      parsed.some((entry) => JSON.stringify(entry).includes(REASON)),
      `EMPTIED-WRITE SHAPE: no entry in session-events.json carries the passed-in --reason text (${REASON}). content=${JSON.stringify(parsed)}`,
    );

    // DOUBLE-WRITE pin: "exactly" the cwd path — nothing was also written to
    // the untouched sibling directory, and nothing extra was dropped
    // directly under the shared parent (outside the project directory).
    // EXPECTED FAILURE SHAPE if either assertion goes red: a file or
    // .sterling tree appears under the sibling directory, or an extra entry
    // (beyond the `project` and `sibling` dirs this test created) appears
    // directly under the parent — either means the write is not scoped to
    // the invoking cwd alone.
    // SABOTAGE: in addition to (or instead of) writing to cwd, also write
    // the same event to a second fixed/derived location (e.g. a parent
    // directory walk, or a second hardcoded path) — either of these
    // assertions goes red while the existsSync(expected) assertion above
    // stays green, proving "exactly" was previously unproven.
    assert.equal(
      existsSync(join(sibling, '.sterling')),
      false,
      'DOUBLE-WRITE SHAPE: the untouched sibling directory must receive nothing at all',
    );
    assert.deepEqual(
      readdirSync(parent).sort(),
      ['project', 'sibling'],
      'DOUBLE-WRITE SHAPE: nothing extra was written directly under the shared parent directory',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 3 — the `--target=<dir>` EQUALS form is refused just as loudly as the
// split `--target <dir>` form pinned above (added: reviews found this word
// form entirely unpinned, and it is the only place a caller writing
// `--target=/some/dir` would ever notice the removal happened).
// ===========================================================================
//
// RATIONALE (per the brief, preserved as a comment so this is never
// "simplified away" later): the original argument parser only ever
// recognized the split `--target <dir>` form. The equals form
// `--target=<dir>` was therefore never a live redirect route in the first
// place — it is pinned here purely for the LOUDNESS of the refusal (exit 1 +
// the removal message + no file anywhere), not because a redirect via this
// spelling ever worked. A silent accept of this spelling — falling through
// as an unrecognized bare argument instead of being refused — is the
// specified failure this pin exists to catch.

test('--target=<dir> (equals form) is refused just as loudly as --target <dir>: exit 1, the exact removal message, and NO file created at either the named target or the invoking cwd', () => {
  const dir = makeProject('sterling-no-capture-target-eq-invoker-');
  const targetDir = mkdtempSync(join(tmpdir(), 'sterling-no-capture-target-eq-elsewhere-'));
  try {
    const r = runNoCapture(
      ['--reason', 'read-only follow-up; nothing durable learned', `--target=${targetDir}`],
      dir,
    );

    // EXPECTED FAILURE SHAPE if this assertion goes red: exit code is 0 (or
    // anything other than 1), meaning the equals-form spelling of the
    // removed --target flag slipped past the refusal that the split form
    // already catches (e.g. the refusal checks `arg === '--target'` only
    // and never `arg.startsWith('--target=')`, so this form falls through
    // as an ordinary unrecognized/ignored argument).
    // SABOTAGE: narrow the --target refusal check from matching both
    // `--target` and `--target=...` down to matching only the exact literal
    // `--target` — this assertion goes red for the equals form alone while
    // pin 1's split-form assertion stays green, proving the two spellings
    // are checked independently rather than by one shared guard.
    assert.equal(
      r.status,
      1,
      `SILENT-ACCEPT/IGNORE SHAPE if this is not 1 (equals form): --target=<dir> must be refused loudly, exactly like --target <dir>. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EXPECTED FAILURE SHAPE if this goes red: exit code is 1 but the
    // message is generic/opaque or missing, so the equals form's refusal is
    // distinguishable from an ordinary parse failure only by luck.
    // SABOTAGE: have the equals-form path fall through to a generic
    // "unrecognized argument" message instead of the specific removal
    // message used by the split form — this assertion goes red while the
    // exit-code assertion above may still pass.
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /--target was removed: the event is written to the invoking project only/,
      `GENERIC-OR-MISSING-MESSAGE SHAPE (equals form): stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // EXPECTED FAILURE SHAPE if any of these three assertions goes red: a
    // file exists somewhere, meaning the equals-form refusal happened after
    // a write, or the equals-form spelling still redirects the write despite
    // being nominally refused.
    // SABOTAGE: parse `--target=<dir>` far enough to extract <dir> and use
    // it as a write destination before (or despite) refusing the flag — any
    // of these three existsSync assertions goes red, proving a file was
    // written for the equals spelling specifically.
    assert.equal(
      existsSync(eventsPathIn(targetDir)),
      false,
      'REDIRECT-STILL-WORKS SHAPE (equals form): no file was written at the old target-directory redirect path',
    );
    assert.equal(
      existsSync(join(targetDir, 'session-events.json')),
      false,
      'REDIRECT-STILL-WORKS SHAPE (equals form, bare path variant): no file was written directly at the named target directory either',
    );
    assert.equal(
      existsSync(eventsPathIn(dir)),
      false,
      'REFUSE-AFTER-WRITE SHAPE (equals form): no file was written in the invoking cwd either — the refusal happens before any write',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
