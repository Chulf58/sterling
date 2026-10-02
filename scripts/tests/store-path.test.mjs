// SPEC-ONLY pins for the CONTAINMENT HELPER, scripts/lib/store-path.mjs
// (slice R5 of objective rebuild-2026-09; boards a416e276 + a506e9a7).
//
// WHY THIS FILE EXISTS (review finding): nothing pinned the helper's STEP 1.
// Every other R5 suite exercises the helper only through a CLI, and the CLI
// pins are satisfied by steps 2–3 alone — so deleting the lexical containment
// check left the entire suite GREEN. Step 1 is the step that closes the
// FRESH-PROJECT case, where no `.sterling` exists yet and there is nothing for
// an lstat walk or a realpath to catch.
//
// SPEC (decision `sanctioned-script-store-writes-one-containment-helper-one-arg-parser`,
// knowledge_get d0cdd940-aa4c-40fb-9fd1-5359d5bfb41c, part (A), quoted so each
// pin below can be read against the clause it answers to):
//
//   "a new dependency-free module scripts/lib/store-path.mjs (node builtins
//    only …) exports resolveStoreWritePath(projectRoot, ...segments) →
//    absolute path, in this order: (1) LEXICAL containment first — resolve(root,
//    ...segments) must stay inside root (a `..` or absolute segment refuses
//    before any fs call, which closes the fresh-project case where no
//    `.sterling` exists yet); (2) walk the EXISTING components with lstat — any
//    symlink component beneath the project root on the way to the target
//    REFUSES (an in-root file symlink could redirect session-events.json onto
//    config.json or sterling.db, so realpath-containment alone is not enough);
//    only ENOENT counts as absent — a dangling link or a permission error
//    refuses; (3) realpath the root and the deepest existing ancestor,
//    reconstruct the suffix, re-check containment; (4) return the absolute path
//    or throw StorePathContainmentError naming both resolved paths."
//
// WHAT IS DELIBERATELY NOT PINNED HERE, stated rather than left as a silent gap:
//   · EACCES ON THE ROOT (the record's "a … permission error refuses"). It
//     cannot be simulated portably — chmod is a no-op for root, is ignored on
//     Windows, and CI commonly runs as a user for whom no directory is
//     unreadable. UNPINNED, and knowingly so: the ENOENT-vs-other-errno rule is
//     pinned only on its dangling-symlink side (pin E).
//   · The TOCTOU residual the record itself scopes and accepts
//     ("check-then-mkdirSync remains a TOCTOU window; the helper provides
//     single-user local containment, not adversarial concurrent safety").
//   · Whether a CALLER actually writes to the returned path — that is what the
//     manifest pin in scripts/tests/store-remediation.test.mjs is for.
//
// EXECUTION DISCLOSURE: the test-writer role holds no Bash and no read access
// to scripts/lib/store-path.mjs (H4 read wall) — this file was NEVER RUN and
// was written from the decision record above. The conductor runs the gate.
// Every test states its EXPECTED FAILURE SHAPE and a ONE-LINE SABOTAGE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { resolveStoreWritePath, StorePathContainmentError } from '../lib/store-path.mjs';

const mkroot = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// A path under the temp root that DOES NOT EXIST. Used wherever a pin must
// prove the refusal came from the LEXICAL check (step 1) and not from an fs
// walk: with no root on disk, any lstat/realpath path would ENOENT instead.
function absentRoot(prefix) {
  const p = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(existsSync(p), false, 'HARNESS SHAPE: the absent-root fixture must genuinely not exist');
  return p;
}

// Same platform guard as scripts/tests/no-capture-target.test.mjs: symlinkSync
// throws EPERM/EACCES on native Windows without Developer Mode. Exactly those
// two errnos become a LOUD skip — the test then asserts NOTHING and says so;
// any other errno still fails, because it is a finding, not a platform fact.
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

const isContainment = (err) => err instanceof StorePathContainmentError;

// ===========================================================================
// PIN A — HAPPY PATH: an ordinary call returns the absolute lexical path.
// ===========================================================================
//
// This is the control arm for the whole file: every refusal pin below is only
// meaningful if the helper returns a path at all. Placed first for that reason.
//
// SABOTAGE that must turn this red: have the helper return a path relative to
// cwd (drop the `resolve` / return `join(...segments)` without the root) — the
// equality assertion goes red, and so does the isAbsolute one.

test('A: an ordinary call returns the absolute path under the root, segment for segment', () => {
  const root = mkroot('sterling-store-path-happy-');
  try {
    const p = resolveStoreWritePath(root, '.sterling', 'transient', 'session-events.json');
    assert.equal(p, join(root, '.sterling', 'transient', 'session-events.json'), 'WRONG-PATH SHAPE: the returned path must be the root joined with the segments, in order');
    assert.equal(isAbsolute(p), true, 'RELATIVE-PATH SHAPE: the contract says absolute');
    // The helper RESOLVES a path; it must not create anything. A helper that
    // mkdir'd as a side effect would make every containment refusal a
    // half-completed operation.
    // EXPECTED FAILURE SHAPE if this goes red: the directory now exists, so the
    // helper wrote to disk during a pure resolution.
    assert.equal(existsSync(join(root, '.sterling')), false, 'SIDE-EFFECT SHAPE: resolving a path must not create it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN B — STEP 1, the pin the whole file exists for: a `..` segment refuses
// BEFORE any fs access.
// ===========================================================================
//
// The root does NOT exist, deliberately. If the implementation deleted step 1
// and relied on the lstat walk or the realpath re-check, those would hit ENOENT
// on a missing root and — per pin G — DEGRADE to returning the lexical path.
// So a green here proves the refusal came from the lexical check specifically:
// no other step in the record can produce it under these conditions.
//
// SABOTAGE that must turn this red: delete the step-1 lexical containment
// check and keep steps 2–4 — with a non-existent root there is nothing to lstat
// and nothing to realpath, so the escape resolves cleanly and the helper
// RETURNS `<parent>/x` instead of throwing. assert.throws then reports
// "Missing expected exception".

test('B: a `..` segment refuses BEFORE any fs access (step 1), even when the root does not exist', () => {
  const root = absentRoot('sterling-store-path-absent-');

  // CONTROL ARM FIRST (must pass for the OPPOSITE reason): with the SAME
  // non-existent root and clean segments, the helper RETURNS the lexical path.
  // Without this arm, a helper that threw on every missing root would satisfy
  // all three attack assertions below while pinning nothing about `..`.
  assert.equal(
    resolveStoreWritePath(root, '.sterling', 'x.json'),
    join(root, '.sterling', 'x.json'),
    'CONTROL-ARM-BROKEN SHAPE: a non-existent root with clean segments must resolve, or the refusals below are not attributable to the `..`',
  );

  for (const segments of [
    ['..', 'x'], //                    escape as its own segment
    ['.sterling', '..', '..', 'x'], // escape after descending
    ['a/../..', 'x'], //               escape INSIDE one segment — a helper that
    //                                 only inspects `seg === '..'` misses this
    ['.sterling/../../x'], //          the same, in a single path-shaped segment
  ]) {
    assert.throws(
      () => resolveStoreWritePath(root, ...segments),
      isContainment,
      `ESCAPE-ALLOWED SHAPE: segments ${JSON.stringify(segments)} resolve outside the root and must throw StorePathContainmentError`,
    );
  }

  // The refusal NAMES BOTH PATHS (record step 4), so an operator can see what
  // escaped and what it was supposed to stay inside. With a non-existent root
  // there is nothing to realpath, so the lexical spellings are the only ones
  // available and are what the message must carry.
  // EXPECTED FAILURE SHAPE if either goes red: the error is thrown but is
  // generic ("path escapes project"), leaving the operator to guess.
  let caught;
  try {
    resolveStoreWritePath(root, '..', 'x');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'ESCAPE-ALLOWED SHAPE: the escape must throw');
  assert.ok(caught.message.includes(root), `UNNAMED-ROOT SHAPE: the refusal must name the root it was containing to (${root}). message=${caught.message}`);
  assert.ok(
    caught.message.includes(resolve(root, '..', 'x')),
    `UNNAMED-TARGET SHAPE: the refusal must name the resolved path that escaped (${resolve(root, '..', 'x')}). message=${caught.message}`,
  );
});

// ===========================================================================
// PIN C — STEP 1: an ABSOLUTE segment refuses.
// ===========================================================================
//
// `resolve()` treats an absolute segment as a RESET — every earlier segment,
// including the root, is discarded. So an absolute segment is not merely an
// escape, it is a total redirect, and it is the shape a caller reaches by
// passing user input straight through.
//
// SABOTAGE that must turn this red: containment-check with
// `target.startsWith(root)` on a path built by `join(root, ...segments)`
// instead of `resolve(...)` — join treats '/etc/x' as an ordinary relative
// segment, so the check passes and the helper returns `<root>/etc/x`, a path
// that looks contained while the caller's intent was absolute. No throw, and
// assert.throws reports "Missing expected exception".

test('C: an ABSOLUTE segment refuses (it would reset the resolve and discard the root)', () => {
  const root = absentRoot('sterling-store-path-abs-');

  assert.throws(() => resolveStoreWritePath(root, '/etc/x'), isContainment, 'ABSOLUTE-SEGMENT-ALLOWED SHAPE: a POSIX absolute segment must refuse');
  assert.throws(() => resolveStoreWritePath(root, '.sterling', '/etc/passwd'), isContainment, 'ABSOLUTE-SEGMENT-ALLOWED SHAPE: also when it follows a legitimate segment');

  // Windows-only spellings. Guarded because on POSIX `C:/x` is a perfectly
  // ordinary RELATIVE segment (a directory literally named `C:`), and asserting
  // a throw there would pin the wrong behaviour on the wrong platform.
  if (process.platform === 'win32') {
    assert.throws(() => resolveStoreWritePath(root, 'C:/x'), isContainment, 'ABSOLUTE-SEGMENT-ALLOWED SHAPE (win32 drive-absolute)');
    assert.throws(() => resolveStoreWritePath(root, 'C:\\x'), isContainment, 'ABSOLUTE-SEGMENT-ALLOWED SHAPE (win32 drive-absolute, backslash)');
  }
});

// ===========================================================================
// PIN D — bad SEGMENT INPUT is refused loudly, not coerced.
// ===========================================================================
//
// A silently-coerced segment is how a path quietly becomes something else:
// `String(null)` is the directory `"null"`, `String(undefined)` is `"undefined"`,
// and an empty segment vanishes without trace — so `resolveStoreWritePath(root,
// '.sterling', '', 'x.json')` and `(root, '.sterling', 'x.json')` would return
// the same path while meaning different things.
//
// NOT PINNED, deliberately: the ERROR CLASS. The record names
// StorePathContainmentError for the CONTAINMENT verdict only; a bad-input
// rejection is a different kind of failure and the record does not choose a
// class for it. These assertions require an Error, not a particular one.
//
// SABOTAGE that must turn this red: coerce with `String(seg)` (or filter out
// empties with `.filter(Boolean)`) before resolving — no throw, and every
// assert.throws below reports "Missing expected exception".

test('D: an empty or non-string segment is refused, never coerced into a directory name', () => {
  const root = absentRoot('sterling-store-path-badseg-');
  const isError = (err) => err instanceof Error;

  for (const bad of [[''], ['.sterling', ''], [null], [undefined], [42], [{}], [[]], [Symbol('x')]]) {
    assert.throws(
      () => resolveStoreWritePath(root, ...bad),
      isError,
      `SEGMENT-COERCED SHAPE: segments ${String(bad.map((b) => typeof b))} must be refused, not coerced`,
    );
  }

  // CONTROL (must pass for the OPPOSITE reason): ordinary string segments are
  // untouched by the guard — including ones with dots in them, which a
  // heavy-handed validator would reject.
  assert.equal(resolveStoreWritePath(root, '.sterling', 'sterling.db'), join(root, '.sterling', 'sterling.db'), 'OVER-VALIDATION SHAPE: a dotted filename is a valid segment');
});

// ===========================================================================
// PIN E — STEP 2: a DANGLING SYMLINK at the target refuses. Only ENOENT counts
// as absent.
// ===========================================================================
//
// This is the sharp edge of the record's "only ENOENT counts as absent" rule.
// A dangling link is the one case where the two plausible implementations
// diverge: `lstat` SUCCEEDS on it (the link itself exists), while `stat` and
// `existsSync` both report it as missing — so a helper that probes with
// `existsSync` concludes "nothing here, safe to write" and then writes THROUGH
// the link to wherever it points, which is a path nobody checked.
//
// SABOTAGE that must turn this red: probe with `existsSync`/`stat` instead of
// `lstat` — the dangling link reads as absent, the helper returns the path, and
// assert.throws reports "Missing expected exception".

test('E: a DANGLING symlink at the target path refuses — lstat succeeds on it, so it is not "absent"', (t) => {
  const root = mkroot('sterling-store-path-dangling-');
  try {
    mkdirSync(join(root, '.sterling', 'transient'), { recursive: true });

    // CONTROL ARM FIRST (must pass for the OPPOSITE reason): a REAL regular
    // file at the target resolves fine. An existing target is not an error —
    // the helper is asked for a WRITE path, and writers append. Without this
    // arm, a helper that refused any existing target would pass the attack arm
    // for the wrong reason.
    writeFileSync(join(root, '.sterling', 'transient', 'real.json'), '[]');
    assert.equal(
      resolveStoreWritePath(root, '.sterling', 'transient', 'real.json'),
      join(root, '.sterling', 'transient', 'real.json'),
      'CONTROL-ARM-BROKEN SHAPE: an existing REGULAR file at the target must resolve, not refuse',
    );

    // ATTACK ARM: a link pointing at something that does not exist.
    const link = join(root, '.sterling', 'transient', 'session-events.json');
    if (!trySymlink(t, join(root, '.sterling', 'transient', 'no-such-file.json'), link, 'file')) return;
    assert.equal(existsSync(link), false, 'HARNESS SHAPE: a dangling link must read as absent to existsSync — that is the trap this pin describes');

    assert.throws(
      () => resolveStoreWritePath(root, '.sterling', 'transient', 'session-events.json'),
      (err) => err instanceof Error && /symlink/i.test(err.message),
      'DANGLING-LINK-FOLLOWED SHAPE: a dangling symlink at the target must refuse with an error naming its symlink nature, not be treated as an absent file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN F — STEP 2: a SYMLINK DIRECTORY COMPONENT beneath the root refuses, even
// when it resolves back inside the root.
// ===========================================================================
//
// Two arms, because they fail for different reasons and a single arm would let
// one implementation half pass:
//   · escaping link  — also caught by steps 1/3 (defense in depth)
//   · IN-ROOT link   — caught by step 2 ALONE, since containment is satisfied.
// The in-root arm is the load-bearing one; it is the record's own stated
// motivation ("an in-root file symlink could redirect session-events.json onto
// config.json or sterling.db, so realpath-containment alone is not enough").
//
// SABOTAGE that must turn the IN-ROOT arm red: delete the step-2 lstat
// component walk and keep lexical + realpath containment — the link resolves
// inside the root, containment passes, the helper returns the path, and a
// caller then writes through it onto config.json. The escaping arm STAYS GREEN
// under that same sabotage (step 3 still catches it), which is exactly why both
// arms are here.

test('F: a symlinked DIRECTORY COMPONENT beneath the root refuses — including one that resolves back inside the root', (t) => {
  const root = mkroot('sterling-store-path-component-');
  const outside = mkroot('sterling-store-path-outside-');
  try {
    mkdirSync(join(root, '.sterling'), { recursive: true });
    mkdirSync(join(root, 'real-dir'), { recursive: true });

    // CONTROL ARM FIRST: an ordinary REAL directory component resolves.
    assert.equal(
      resolveStoreWritePath(root, '.sterling', 'x.json'),
      join(root, '.sterling', 'x.json'),
      'CONTROL-ARM-BROKEN SHAPE: a real directory component must resolve',
    );

    // ARM 1 — the link ESCAPES the root.
    if (!trySymlink(t, outside, join(root, '.sterling', 'transient'), 'dir')) return;
    assert.throws(
      () => resolveStoreWritePath(root, '.sterling', 'transient', 'session-events.json'),
      (err) => err instanceof Error,
      'ESCAPING-COMPONENT SHAPE: a symlinked component pointing outside the root must refuse',
    );

    // ARM 2 — the link stays INSIDE the root. Containment cannot see this one.
    if (!trySymlink(t, join(root, 'real-dir'), join(root, '.sterling', 'inner'), 'dir')) return;
    assert.throws(
      () => resolveStoreWritePath(root, '.sterling', 'inner', 'session-events.json'),
      (err) => err instanceof Error && /symlink/i.test(err.message),
      'IN-ROOT-COMPONENT SHAPE: a symlinked component must refuse even when it resolves INSIDE the root — this is the case realpath containment cannot catch, and the refusal must name its symlink nature',
    );
  } finally {
    for (const p of [join(root, '.sterling', 'transient'), join(root, '.sterling', 'inner')]) {
      try {
        rmSync(p, { force: true }); // remove the LINK, never follow it
      } catch {
        // best-effort
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN G — a NON-EXISTENT root returns the lexical path (the record's accepted
// degrade), and the fresh-project path is the ordinary case, not an error.
// ===========================================================================
//
// The record makes lexical containment run FIRST precisely so this case is
// safe: "a `..` or absolute segment refuses before any fs call, which closes
// the fresh-project case where no `.sterling` exists yet". A brand-new project
// has no `.sterling` and may have no root on disk at the moment of resolution;
// refusing there would break `init` and every first-run writer.
//
// SABOTAGE that must turn this red: make a missing root or a missing ancestor
// FAIL CLOSED (throw instead of degrading) — this test goes red while every
// refusal pin above stays green, which is the signature of a helper that is
// safe but unusable on a fresh project.

test('G: a non-existent root (and a not-yet-created .sterling) resolve to the lexical path — the fresh-project case', () => {
  const absent = absentRoot('sterling-store-path-fresh-');
  assert.equal(
    resolveStoreWritePath(absent, '.sterling', 'transient', 'session-events.json'),
    join(absent, '.sterling', 'transient', 'session-events.json'),
    'FRESH-PROJECT-REFUSED SHAPE: a root that does not exist yet must still resolve — the containment guarantee is lexical here',
  );

  // The commoner half: the root EXISTS but `.sterling` does not yet.
  const root = mkroot('sterling-store-path-fresh-real-');
  try {
    assert.equal(
      resolveStoreWritePath(root, '.sterling', 'transient', 'session-events.json'),
      join(root, '.sterling', 'transient', 'session-events.json'),
      'FRESH-PROJECT-REFUSED SHAPE: an existing root whose .sterling is not created yet must resolve',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN H — the exported error CLASS is a real, catchable Error subclass.
// ===========================================================================
//
// Callers are expected to distinguish a containment refusal from any other
// failure (no-capture's CLI pin requires a message naming both paths). That is
// only possible if the export is an Error subclass rather than, say, a plain
// object or a string thrown directly.
//
// SABOTAGE that must turn this red: `throw new Error(...)` in place of the
// class, or export a plain-object factory — the instanceof assertion goes red
// while a message-only assertion elsewhere would still pass.

test('H: StorePathContainmentError is an Error subclass and is what a containment refusal throws', () => {
  assert.equal(typeof StorePathContainmentError, 'function', 'MISSING-CLASS SHAPE: the error class must be exported');
  assert.ok(StorePathContainmentError.prototype instanceof Error, 'NOT-AN-ERROR SHAPE: StorePathContainmentError must extend Error');

  const root = absentRoot('sterling-store-path-class-');
  let caught;
  try {
    resolveStoreWritePath(root, '..', 'escape');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof StorePathContainmentError, `WRONG-CLASS SHAPE: a containment escape must throw StorePathContainmentError, got ${caught && caught.constructor && caught.constructor.name}`);
  assert.ok(caught instanceof Error, 'NOT-AN-ERROR SHAPE: and it must still be a catchable Error');
  assert.ok(typeof caught.message === 'string' && caught.message.length > 0, 'EMPTY-MESSAGE SHAPE: the refusal must carry a message');
});
