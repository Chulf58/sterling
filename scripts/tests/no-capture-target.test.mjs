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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
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

// ###########################################################################
// R5 ADDITIONS (slice R5 of objective rebuild-2026-09; boards a416e276 +
// a506e9a7). Pins 4 and 5 below are LIFTED from the frozen-pin input at
// /mnt/c/Users/cuj/.claude/plans/rebuild-2026-09-inputs/frozen-pins-R5-no-capture-target.patch
// (parked when the per-script fix built on 2026-09-06 was reverted), adjusted
// only where the governing record changed. Pins 6 and 7 are NEW under that
// record.
//
// GOVERNING SPEC: decision
// `sanctioned-script-store-writes-one-containment-helper-one-arg-parser`
// (knowledge_get d0cdd940-aa4c-40fb-9fd1-5359d5bfb41c). Its two relevant
// clauses, quoted:
//   (A) CONTAINMENT — scripts/lib/store-path.mjs exports
//       resolveStoreWritePath(projectRoot, ...segments): "(1) LEXICAL
//       containment first …; (2) walk the EXISTING components with lstat — any
//       symlink component beneath the project root on the way to the target
//       REFUSES (an in-root file symlink could redirect session-events.json
//       onto config.json or sterling.db, so realpath-containment alone is not
//       enough) …; (4) return the absolute path or throw
//       StorePathContainmentError naming both resolved paths." Every sanctioned
//       script that WRITES under `.sterling/` derives its path through it —
//       no-capture.mjs is one of the simple writers R5 converts.
//   (B) FLAGS — "`--name=` (empty) is a bad VALUE refused by the caller, never
//       read as bare"; no-capture.mjs's laneGiven/laneValue derive from
//       hasFlag/arg.
//
// WHAT CHANGED vs the parked patch: the refusal is now expected to come from
// the SHARED helper rather than from a per-script realpath check, and the
// record adds the in-root FILE symlink case (pin 6) that the parked patch
// predates. The parked patch's own assertions are otherwise carried over
// verbatim in substance, including its control-arm-first structure.
//
// EXECUTION DISCLOSURE (unchanged from this file's header): never run; written
// without reading scripts/no-capture.mjs, scripts/lib/store-path.mjs or
// scripts/lib/project.mjs (H4 read wall).
// ###########################################################################

// ===========================================================================
// PIN 4 — PHYSICAL CONTAINMENT (board a416e276): a pre-positioned symlink at
// .sterling/transient pointing outside the invoking cwd is refused, before
// any write, and the refusal names both paths involved (either spelling —
// see the note on those two assertions).
//
// WHAT CARRIES THE VERDICT: the non-zero exit and the whole-directory
// untouched assertions. The two message assertions are a loudness check on
// top of that verdict, deliberately spelled loosely so they cannot fail for a
// platform or refusal-stage reason.
// ===========================================================================
//
// MEASURED DEFECT this pin closes (record rationale): "no-capture.mjs:75-76
// joins cwd lexically and mkdir/read/writes through whatever a pre-positioned
// symlink points at (reproduced 2026-09-06: exit 0, the event written into a
// sibling temp dir)".
//
// SABOTAGE that must turn this red: replace the helper's lstat/realpath walk
// with a lexical check alone (path.join/startsWith on the UNRESOLVED path) —
// the symlink's own path string (<project>/.sterling/transient) still
// lexically "starts with" the project directory even though it physically
// resolves elsewhere, so a lexical check never notices the escape and the
// write goes through at the symlink's real target instead of being refused.
// (This is a MULTI-LAYER guard by design — the record's steps 2 and 3 both
// catch this case independently. Removing step 2's lstat walk alone leaves
// step 3's realpath re-check standing and this test STAYS GREEN; that is
// defense in depth, not hollowness. The guard that carries THIS verdict is
// whichever of the two survives — strip BOTH to see it go red, and see pin 6
// for the case where step 2 is the sole load-bearing guard.)

// PLATFORM GUARD (review finding): symlinkSync throws EPERM/EACCES on native
// Windows without Developer Mode (or an elevated shell), which would make this
// pin — and pin 6 — fail for an environment reason indistinguishable from a
// real defect. Exactly those two errnos convert to a LOUD skip; every other
// errno still fails, because a symlink that cannot be created for any OTHER
// reason is a finding, not a platform fact. The skip is deliberately noisy:
// on a host that skips, these two pins prove NOTHING and the runner says so.
function trySymlink(t, target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`symlink creation unavailable: ${err.code} creating ${linkPath} -> ${target} (native Windows without Developer Mode?). This pin asserted NOTHING on this host.`);
      return false;
    }
    throw err;
  }
}

test('a pre-positioned symlink at .sterling/transient pointing outside cwd is refused before any write: physical containment (board a416e276)', (t) => {
  // CONTROL ARM FIRST — an ordinary, non-symlinked project must succeed, so
  // a refusal seen in the attack arm below is attributable to the symlink
  // specifically, not to a broken harness/environment. Without this arm, a
  // universally-refusing (or crashing) script would pass the attack
  // assertions for the wrong reason.
  const controlDir = makeProject('sterling-no-capture-containment-control-');
  try {
    const rc = runNoCapture(['--reason', 'containment control arm — real directory, must succeed'], controlDir);
    assert.equal(
      rc.status,
      0,
      `CONTROL-ARM-BROKEN SHAPE if this is not 0: the ordinary (non-symlinked) case must succeed, or the attack arm's refusal below proves nothing about containment specifically. status=${rc.status} stdout=${rc.stdout} stderr=${rc.stderr}`,
    );
    assert.equal(
      existsSync(eventsPathIn(controlDir)),
      true,
      'CONTROL-ARM-BROKEN SHAPE: the ordinary case must actually write the event file',
    );
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
  }

  // ATTACK ARM — .sterling/transient is a symlink pointing at a sibling
  // directory OUTSIDE the project's cwd.
  const projectDir = makeProject('sterling-no-capture-containment-attack-');
  const outside = mkdtempSync(join(tmpdir(), 'sterling-no-capture-containment-outside-'));
  try {
    // Resolve BEFORE creating the symlink, so these are trustworthy oracle
    // values independent of how mkdtemp's own path resolves on this OS
    // (e.g. a platform where the temp root itself is a symlink).
    const resolvedOutside = realpathSync(outside);
    const resolvedProjectDir = realpathSync(projectDir);

    if (!trySymlink(t, outside, join(projectDir, '.sterling', 'transient'), 'dir')) return;

    const r = runNoCapture(['--reason', 'containment attack arm — must be refused'], projectDir);

    // EXPECTED FAILURE SHAPE if this goes red: exit code is 0, meaning the
    // symlinked transient directory was silently followed and written
    // through instead of being refused.
    assert.notEqual(
      r.status,
      0,
      `SILENT-FOLLOW SHAPE if this is 0: a symlinked .sterling/transient pointing outside cwd must be refused, not silently followed. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // The refusal must name the two paths involved, so an operator can audit
    // WHICH directory the symlink escaped to rather than seeing a generic
    // parse failure. (Record (A) step 4: "throw StorePathContainmentError
    // naming both resolved paths".)
    //
    // EITHER SPELLING IS ACCEPTED (review finding — the parked patch
    // over-pinned this by demanding the REALPATH spelling only), for two
    // independent reasons:
    //   (a) the record's containment throw promises both RESOLVED paths at
    //       step 4, but a step-2 SYMLINK-COMPONENT refusal fires EARLIER —
    //       before the realpath reconstruction — and may legitimately name the
    //       unresolved paths it has in hand at that point;
    //   (b) on a host whose temp root is itself a symlink (macOS /tmp ->
    //       /private/tmp), realpathSync(outside) !== outside, so demanding the
    //       resolved spelling would fail for a platform reason.
    // The pin therefore asserts the PATH IS NAMED, not which spelling of it —
    // still enough to catch a generic/opaque refusal, which is the defect.
    //
    // EXPECTED FAILURE SHAPE if either of these two goes red: the refusal
    // fired (exit != 0 above) but the message names neither spelling of that
    // path at all.
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.ok(
      combined.includes(resolvedOutside) || combined.includes(outside),
      `LEXICAL-CHECK SHAPE (escape target unnamed) if this fails: stderr/stdout must name the OUTSIDE path the symlink resolves to, in either spelling (resolved=${resolvedOutside} | as-created=${outside}). combined=${combined}`,
    );
    assert.ok(
      combined.includes(resolvedProjectDir) || combined.includes(projectDir),
      `LEXICAL-CHECK SHAPE (project cwd unnamed) if this fails: stderr/stdout must also name the project cwd the write was supposed to stay inside, in either spelling (resolved=${resolvedProjectDir} | as-created=${projectDir}). combined=${combined}`,
    );

    // EXPECTED FAILURE SHAPE if this goes red: a file exists at the
    // symlink's real target, meaning the refusal happened after a write (or
    // the write went through despite the refusal being reported).
    assert.equal(
      existsSync(join(outside, 'session-events.json')),
      false,
      'NOTHING-WRITTEN-AT-TARGET SHAPE: nothing was written at the symlinked target directory',
    );
    // The escape directory is entirely untouched — not merely missing the one
    // filename this test guessed at. A write under a different name (or a
    // stray mkdir) is the same escape and must not pass.
    assert.deepEqual(
      readdirSync(outside),
      [],
      'NOTHING-WRITTEN-AT-TARGET SHAPE (whole-directory): the symlink target directory must be completely untouched, under any filename',
    );
  } finally {
    // Remove the symlink itself first (not recursively) rather than relying
    // on recursive-delete's symlink handling, so cleanup can never be
    // mistaken for having reached into `outside` through the link.
    try {
      rmSync(join(projectDir, '.sterling', 'transient'), { force: true });
    } catch {
      // ignore — best-effort cleanup
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 5 — `--lane=<value>` EQUALS FORM (board a506e9a7): the equals-form
// spelling of --lane must behave EXACTLY like the split form, both when
// ACCEPTED (the written event carries the declared lane) and when REFUSED
// (an invalid value is refused loudly, naming "lane", nothing written) —
// each asserted beside its split-form twin so the pin proves equivalence
// rather than assuming it.
// ===========================================================================
//
// SABOTAGE that must turn BOTH tests below red: detect the --lane flag's
// presence via `argv.includes('--lane')` only (the measured defect: record
// rationale, "presence is `argv.includes('--lane')` and the shared arg() in
// project.mjs:8-11 parses the split form only"). `--lane=research` and
// `--lane=bogus` are single array elements that never equal the literal
// string '--lane', so `includes('--lane')` is false for both — the equals
// form then falls through as an unrecognized bare argument: the ACCEPT test
// fails because the written event carries no lane (or the wrong one) since
// its value was never extracted, and the REFUSE test fails because
// `--lane=bogus` is silently ignored (exit 0) rather than refused.
//
// FIELD-NAME ASSUMPTION, stated so a red is diagnosed in one line: the written
// event is assumed to carry the declared lane on a `lane` property. If it does
// not, the SPLIT-FORM TWIN assertion — not the equals-form one — goes red
// first, and that is the signature of a wrong field name rather than of a
// parser defect.

test('--lane=research (equals form) writes an event with lane: "research", identically to --lane research (split form)', () => {
  const SPLIT_REASON = 'PIN5-SPLIT-LANE-EQ-TWIN-9c41f0-do-not-genericize';
  const EQ_REASON = 'PIN5-EQUALS-LANE-EQ-TWIN-9c41f0-do-not-genericize';
  const splitDir = makeProject('sterling-no-capture-lane-eq-split-');
  const eqDir = makeProject('sterling-no-capture-lane-eq-equals-');
  try {
    // SPLIT-FORM TWIN — the baseline this pin holds the equals form to.
    const rSplit = runNoCapture(['--reason', SPLIT_REASON, '--lane', 'research'], splitDir);
    assert.equal(
      rSplit.status,
      0,
      `SPLIT-FORM-BROKEN SHAPE if this is not 0: the split form (--lane research) is the baseline this pin compares against, and must itself succeed. status=${rSplit.status} stdout=${rSplit.stdout} stderr=${rSplit.stderr}`,
    );
    const splitEvents = JSON.parse(readFileSync(eventsPathIn(splitDir), 'utf8'));
    const splitEntry = splitEvents.find((e) => JSON.stringify(e).includes(SPLIT_REASON));
    assert.ok(splitEntry, `SPLIT-FORM-BROKEN SHAPE: no entry carries the split-form reason text. events=${JSON.stringify(splitEvents)}`);
    assert.equal(
      splitEntry.lane,
      'research',
      `SPLIT-FORM-BROKEN SHAPE: the split form's own written event must carry lane: 'research'. entry=${JSON.stringify(splitEntry)}`,
    );

    // EQUALS-FORM under test.
    const rEq = runNoCapture(['--reason', EQ_REASON, '--lane=research'], eqDir);
    // EXPECTED FAILURE SHAPE if this goes red: the equals form is refused
    // or silently ignored (falls through as an unrecognized bare argument)
    // — exit code is not 0.
    assert.equal(
      rEq.status,
      0,
      `EQUALS-FORM-REJECTED SHAPE if this is not 0: --lane=research must be accepted exactly like --lane research. status=${rEq.status} stdout=${rEq.stdout} stderr=${rEq.stderr}`,
    );
    const eqEvents = JSON.parse(readFileSync(eventsPathIn(eqDir), 'utf8'));
    const eqEntry = eqEvents.find((e) => JSON.stringify(e).includes(EQ_REASON));
    assert.ok(eqEntry, `EQUALS-FORM SHAPE: no entry carries the equals-form reason text. events=${JSON.stringify(eqEvents)}`);
    // EXPECTED FAILURE SHAPE if this goes red: the event was written but
    // WITHOUT the declared lane (or with a different one) — the equals-form
    // token's presence was detected well enough not to be refused, but its
    // VALUE was never extracted, so the event landed as a bare (lane-less)
    // declaration instead of a research-lane one. That bare declaration
    // discharges a WIDER duty than the caller asked for, which is the
    // knowledge-loss path this pin exists to close.
    assert.equal(
      eqEntry.lane,
      'research',
      `EQUALS-FORM SHAPE: --lane=research's own written event must carry lane: 'research', identically to the split form. entry=${JSON.stringify(eqEntry)}`,
    );
  } finally {
    rmSync(splitDir, { recursive: true, force: true });
    rmSync(eqDir, { recursive: true, force: true });
  }
});

test('--lane=bogus (equals form) is refused loudly, naming "lane", with nothing written — identically to --lane bogus (split form)', () => {
  const splitDir = makeProject('sterling-no-capture-lane-eq-bad-split-');
  const eqDir = makeProject('sterling-no-capture-lane-eq-bad-equals-');
  try {
    // SPLIT-FORM TWIN — the baseline refusal this pin holds the equals form
    // to (already covered standalone by L9 in
    // scripts/tests/h10-no-capture-lane-scope.test.mjs; re-asserted here
    // beside its equals-form twin so this single pin proves equivalence
    // directly, rather than relying on two files staying in sync).
    const rSplit = runNoCapture(['--reason', 'split-form bogus lane', '--lane', 'bogus'], splitDir);
    assert.notEqual(
      rSplit.status,
      0,
      `SPLIT-FORM-BROKEN SHAPE if this is 0: the split form's own refusal of an invalid lane is the baseline this pin compares against. status=${rSplit.status} stdout=${rSplit.stdout} stderr=${rSplit.stderr}`,
    );
    assert.match(`${rSplit.stdout}\n${rSplit.stderr}`, /lane/i, 'SPLIT-FORM-BROKEN SHAPE: the split form refusal must name "lane"');
    assert.equal(existsSync(eventsPathIn(splitDir)), false, 'SPLIT-FORM-BROKEN SHAPE: nothing written on the split-form refusal');

    // EQUALS-FORM under test.
    const rEq = runNoCapture(['--reason', 'equals-form bogus lane', '--lane=bogus'], eqDir);
    // EXPECTED FAILURE SHAPE if this goes red: exit code is 0, meaning
    // `--lane=bogus` was silently accepted (or silently ignored as an
    // unrecognized bare argument, falling through to a bare/lane-less
    // declaration) instead of being refused like its split-form twin.
    assert.notEqual(
      rEq.status,
      0,
      `EQUALS-FORM-SILENTLY-ACCEPTED SHAPE if this is 0: --lane=bogus must be refused exactly like --lane bogus. status=${rEq.status} stdout=${rEq.stdout} stderr=${rEq.stderr}`,
    );
    // EXPECTED FAILURE SHAPE if this goes red: exit code is nonzero but the
    // refusal message is generic/opaque and does not name "lane" — the
    // caller cannot tell an equals-form invalid-lane refusal from any other
    // parse failure.
    assert.match(
      `${rEq.stdout}\n${rEq.stderr}`,
      /lane/i,
      `EQUALS-FORM-GENERIC-MESSAGE SHAPE: the equals-form refusal must name "lane". stdout=${rEq.stdout} stderr=${rEq.stderr}`,
    );
    // EXPECTED FAILURE SHAPE if this goes red: a file was written despite
    // the refusal being reported.
    assert.equal(
      existsSync(eventsPathIn(eqDir)),
      false,
      'EQUALS-FORM-REFUSE-AFTER-WRITE SHAPE: nothing was written on the equals-form refusal either',
    );
  } finally {
    rmSync(splitDir, { recursive: true, force: true });
    rmSync(eqDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 6 — IN-ROOT FILE SYMLINK on the write target itself (record (A) step 2,
// which exists precisely for this case: "an in-root file symlink could
// redirect session-events.json onto config.json or sterling.db, so
// realpath-containment alone is not enough").
// ===========================================================================
//
// This is the case realpath-containment CANNOT catch: the symlink resolves to
// a path that is genuinely INSIDE the project, so every containment check in
// the record's steps 1 and 3 is satisfied — and the write still lands on
// config.json, destroying the project's configuration. The lstat component
// walk (step 2) is the SOLE load-bearing guard for this verdict; unlike pin 4,
// removing it alone must turn this test red.
//
// SABOTAGE that must turn this red: delete step 2's lstat symlink-component
// walk and keep only lexical + realpath containment — the link resolves inside
// the project, containment passes, the script appends its session event
// THROUGH the link onto config.json, exit is 0, and all three assertions below
// go red (nonzero-exit, config-preserved, and the message check).

test('an IN-ROOT file symlink at the write target (session-events.json -> ../config.json) is refused: containment alone does not save config.json', (t) => {
  // CONTROL ARM FIRST — the identical project shape WITHOUT the symlink (a
  // real, pre-created .sterling/transient directory) must succeed and must
  // leave config.json intact. Without it, the attack arm's refusal could
  // equally be explained by "a pre-existing transient directory breaks the
  // script", which would prove nothing about symlinks.
  const controlDir = makeProject('sterling-no-capture-inroot-control-');
  try {
    mkdirSync(join(controlDir, '.sterling', 'transient'), { recursive: true });
    const rc = runNoCapture(['--reason', 'in-root control arm — real file, must succeed'], controlDir);
    assert.equal(
      rc.status,
      0,
      `CONTROL-ARM-BROKEN SHAPE if this is not 0: a pre-created real .sterling/transient directory must still succeed. status=${rc.status} stdout=${rc.stdout} stderr=${rc.stderr}`,
    );
    assert.equal(existsSync(eventsPathIn(controlDir)), true, 'CONTROL-ARM-BROKEN SHAPE: the ordinary case must write the event file');
    assert.deepEqual(
      JSON.parse(readFileSync(join(controlDir, '.sterling', 'config.json'), 'utf8')),
      CONFIG,
      'CONTROL-ARM-BROKEN SHAPE: the ordinary case must leave config.json untouched',
    );
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
  }

  // ATTACK ARM — session-events.json is a symlink pointing at config.json,
  // a sibling INSIDE the project. Every containment check passes; only a
  // symlink-component refusal saves the config.
  const projectDir = makeProject('sterling-no-capture-inroot-attack-');
  try {
    mkdirSync(join(projectDir, '.sterling', 'transient'), { recursive: true });
    // Same platform guard as pin 4 — EPERM/EACCES converts to a loud skip on a
    // host that cannot create symlinks; any other errno still fails.
    if (!trySymlink(t, join('..', 'config.json'), eventsPathIn(projectDir), 'file')) return;

    const r = runNoCapture(['--reason', 'in-root symlink attack arm — must be refused'], projectDir);

    // EXPECTED FAILURE SHAPE if this goes red: exit 0 — the in-root symlink
    // was followed, because containment (which it satisfies) was the only
    // check standing.
    assert.notEqual(
      r.status,
      0,
      `IN-ROOT-SYMLINK-FOLLOWED SHAPE if this is 0: a symlink component on the write path must be refused even when it resolves INSIDE the project. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );

    // THE CONSEQUENCE PIN — the one that actually matters, and the reason this
    // case is in the record at all. config.json must still be the config.
    // EXPECTED FAILURE SHAPE if this goes red: config.json now parses to a
    // session-events array (or fails to parse at all), i.e. the write went
    // through the link and destroyed the project's configuration.
    assert.deepEqual(
      JSON.parse(readFileSync(join(projectDir, '.sterling', 'config.json'), 'utf8')),
      CONFIG,
      'CONFIG-CLOBBERED SHAPE: writing through the in-root symlink overwrote .sterling/config.json with session-event data — exactly the redirect the record names',
    );

    // The refusal must name the SYMLINK NATURE of the problem.
    //
    // TIGHTENED (review finding): the earlier alternation
    // `/symlink|session-events\.json|\.sterling/i` was near-vacuous — almost
    // any refusal this script could emit mentions `.sterling` or the events
    // filename, so it would have passed on a message that told the operator
    // nothing about WHY. The whole diagnostic value here is "your write path
    // is a link", which is the one thing an operator cannot see by looking at
    // the path string. The config.json deepEqual above carries the VERDICT;
    // this is the loudness check, now pinned to the word that earns it.
    //
    // EXPECTED FAILURE SHAPE if this goes red: nonzero exit with a message
    // that never says the target is a symlink (e.g. a bare "refused to write
    // .sterling/transient/session-events.json"), leaving the operator to
    // guess why an ordinary-looking in-root path was refused.
    // SABOTAGE: replace the symlink-component refusal message with a generic
    // "write refused" — this assertion goes red while the exit-code and
    // config-preserved assertions stay green.
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /symlink/i,
      `GENERIC-REFUSAL SHAPE: the refusal must name the symlink nature of the offending path. stdout=${r.stdout} stderr=${r.stderr}`,
    );
  } finally {
    try {
      rmSync(eventsPathIn(projectDir), { force: true });
    } catch {
      // ignore — best-effort cleanup; remove the LINK, never follow it
    }
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN 7 — `--lane=` (EMPTY VALUE) is refused as a BAD VALUE, never read as a
// bare declaration (record (B): "`--name=` (empty) is a bad VALUE refused by
// the caller, never read as bare"; no-capture.mjs's laneGiven/laneValue derive
// from hasFlag/arg).
// ===========================================================================
//
// WHY THIS IS THE DANGEROUS ONE: a bare `no_capture` declaration discharges a
// WIDER duty than a lane-scoped one (decision `no-capture-discharge-is-lane-
// scoped`). So an empty `--lane=` silently degrading into a BARE declaration
// is not a parse nit — it is an over-discharge that hides an open duty, and it
// exits 0, which means nothing anywhere reports it.
//
// SABOTAGE that must turn this red: have arg() collapse an empty equals-value
// to undefined (`return v || undefined;`), or have no-capture.mjs compute
// laneGiven from the VALUE's truthiness rather than from hasFlag — `--lane=`
// then reads as "no lane given", the script exits 0, and both the nonzero-exit
// and the nothing-written assertions go red.

test('--lane= (empty value) is refused as a bad value, naming "lane", with nothing written — it must NOT degrade into a bare declaration', () => {
  // CONTROL ARM FIRST — the genuinely BARE invocation (no --lane token at all)
  // must still succeed. This is what makes the attack arm's refusal mean
  // "empty value refused" rather than "lane handling is broken outright", and
  // it is the exact behaviour `--lane=` must NOT be allowed to imitate.
  const bareDir = makeProject('sterling-no-capture-lane-empty-bare-');
  try {
    const rBare = runNoCapture(['--reason', 'bare control arm — no --lane token at all'], bareDir);
    assert.equal(
      rBare.status,
      0,
      `CONTROL-ARM-BROKEN SHAPE if this is not 0: a genuinely bare declaration (no --lane) must still succeed. status=${rBare.status} stdout=${rBare.stdout} stderr=${rBare.stderr}`,
    );
    assert.equal(existsSync(eventsPathIn(bareDir)), true, 'CONTROL-ARM-BROKEN SHAPE: the bare declaration must write its event');
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }

  const eqDir = makeProject('sterling-no-capture-lane-empty-attack-');
  try {
    const r = runNoCapture(['--reason', 'empty lane value — must be refused', '--lane='], eqDir);

    // EXPECTED FAILURE SHAPE if this goes red: exit 0 — `--lane=` was read as
    // bare (indistinguishable from the control arm above), silently
    // over-discharging the capture duty.
    assert.notEqual(
      r.status,
      0,
      `EMPTY-READ-AS-BARE SHAPE if this is 0: --lane= must be refused as a bad VALUE, never read as a bare declaration. status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );
    // EXPECTED FAILURE SHAPE if this goes red: nonzero exit but a generic
    // message — the operator cannot tell that the LANE value was the problem.
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /lane/i,
      `GENERIC-MESSAGE SHAPE: the empty-value refusal must name "lane". stdout=${r.stdout} stderr=${r.stderr}`,
    );
    // EXPECTED FAILURE SHAPE if this goes red: an event file exists, meaning
    // the refusal happened AFTER the write — so a duty was discharged by an
    // invocation that also reported failure, the worst of both.
    assert.equal(
      existsSync(eventsPathIn(eqDir)),
      false,
      'REFUSE-AFTER-WRITE SHAPE: nothing is written when the empty lane value is refused',
    );
  } finally {
    rmSync(eqDir, { recursive: true, force: true });
  }
});
