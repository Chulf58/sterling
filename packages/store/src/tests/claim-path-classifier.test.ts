// ---------------------------------------------------------------------------
// FROZEN PINS — classifyClaimPath, the ONE exported store classifier decision
// `path-claims-are-leaf-or-absent-directory-claims-refused-at-the-tool-write-
// boundary` (knowledge_get 7933e3a8-2c50-40bb-a6f6-0e37c788a43b) names as the
// shared oracle between the MCP tool write boundary and scripts/delivery-
// oracle.mjs — "the store exports the classifier, the TOOL layer decides that
// 'real_directory' refuses a write". This file pins ONLY the classifier's
// pure behaviour, never the refusal decision (that lives in
// directory-claims.test.ts, at the tool layer).
//
// SIGNATURE PINNED (from the decision's own words): a single synchronous
// function `classifyClaimPath(repoRoot, path) -> 'leaf' | 'absent' |
// 'real_directory' | {kind:'unverifiable', errno}`.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE, EVERY TEST BELOW: `classifyClaimPath`
// does not exist as an export of @sterling/store today (no production caller
// exists yet per the decision's own migration-order clause — this is new
// surface, not a rewire of an existing one). Two possible RED shapes,
// disclosed rather than guessed at:
//   (a) if the package build (tsc) refuses to compile this file at all
//       because `@sterling/store` declares no such named export
//       (TS2305/TS2724-class error) — the whole file (and possibly the whole
//       package's test run) fails at the BUILD step, before any test runs;
//   (b) if the build is lenient (e.g. the .d.ts is stale/loose) and only the
//       JS module has no such binding, every `classifyClaimPath(...)` call
//       below throws `TypeError: classifyClaimPath is not a function` at
//       runtime — each test fails on that TypeError rather than on its
//       named assertion.
// Either shape is the correct RED for a wholly new export — same precedent
// knowledge-extract.test.ts documents for `knowledgeExtract` not existing yet.
// Once the export lands, each test discriminates on its own assertion.
//
// EXECUTION DISCLOSURE: this agent holds no shell and cannot run these tests;
// the conductor's red/mutation gate executes them.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The PUBLIC package entry point — this is the import the decision requires
// the tool layer and the delivery oracle to BOTH use, "so the census and the
// gate cannot disagree". Cast through `unknown` so this file compiles under
// any TS strictness while the runtime call still hits the real (currently
// absent) export honestly — same precedent as knowledge-extract.test.ts's
// `ExtractCapable` cast and mount-affinity.test.ts's `MountAffinityCapable`
// cast for wholly-new primitives.
import * as sterlingStorePkg from '@sterling/store';
// The INTERNAL relative import — used ONLY for the identity pin (arm 7) that
// proves the package entry re-exports the SAME function object the store's
// own modules would use internally, not a second, divergent copy.
import * as sterlingStoreInternal from '../index.js';

type Classify = (repoRoot: string, path: string) => 'leaf' | 'absent' | 'real_directory' | { kind: 'unverifiable'; errno: string };

function classifierFrom(mod: unknown): Classify | undefined {
  return (mod as { classifyClaimPath?: Classify }).classifyClaimPath;
}

const isRoot = typeof process.getuid === 'function' && process.getuid!() === 0;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-claim-classifier-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

// ---------------------------------------------------------------------------
// CONTROL, FIRST: the two "nothing wrong here" shapes — absent and a plain
// leaf file — must classify distinctly from the refusal shape (real_directory)
// pinned below. Without this pair, a classifier that always returns
// 'real_directory' (or always 'absent') would be indistinguishable from a
// correct one by the directory-only arms alone.
// ---------------------------------------------------------------------------

test('CONTROL: classifyClaimPath("leaf") for a regular file, and "absent" for a path that does not exist — the two non-refusing verdicts, established before the refusing one is pinned', () => {
  const { dir, cleanup } = harness();
  try {
    const classify = classifierFrom(sterlingStorePkg);
    assert.equal(typeof classify, 'function', 'EXPECTED FAILURE (red): @sterling/store exports no classifyClaimPath yet');
    writeFileSync(join(dir, 'leaf.txt'), 'hello');
    assert.equal(classify!(dir, 'leaf.txt'), 'leaf', 'a regular file is a leaf');
    assert.equal(classify!(dir, 'never-written.txt'), 'absent', 'ENOENT classifies as absent, not as an error');
  } finally {
    cleanup();
  }
});
// SABOTAGE: hardcode the function to always return 'real_directory' -> both
// assertions above go red while every directory-refusal arm below stays
// green for the wrong reason — this control is what makes those arms mean
// anything.

test('1: classifyClaimPath returns "leaf" for a SYMLINK TO A FILE — a symlink whose target is not a directory is a leaf, per the decision\'s own correction ("non-directory leaf or absent", not merely "regular file")', () => {
  const { dir, cleanup } = harness();
  try {
    const classify = classifierFrom(sterlingStorePkg);
    writeFileSync(join(dir, 'real.txt'), 'hi');
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link-to-file.txt'));
    assert.equal(classify!(dir, 'link-to-file.txt'), 'leaf', 'a symlink to a file is a leaf, never refused as if it were a directory itself');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError, export absent.
// SABOTAGE (once built): classify by lstat (never following the symlink) and
// treat every symlink as its own opaque leaf-or-not based on the link itself
// rather than statSync's follow-symlinks semantics -> if that alternate
// implementation instead reports symlinks as 'real_directory' unconditionally,
// this goes red; conversely CONTROL 2's directory-symlink pin below dies if a
// broken "always leaf for symlinks" shape is substituted instead. Together the
// two arms pin that the classifier follows the link and classifies the TARGET.

test('2: classifyClaimPath returns "real_directory" for a plain directory, AND for a SYMLINK TO A DIRECTORY — statSync-follows-symlinks semantics, per the decision\'s own wording ("statSync following symlinks -> isDirectory")', () => {
  const { dir, cleanup } = harness();
  try {
    const classify = classifierFrom(sterlingStorePkg);
    mkdirSync(join(dir, 'real-dir'));
    symlinkSync(join(dir, 'real-dir'), join(dir, 'link-to-dir'), 'dir');

    assert.equal(classify!(dir, 'real-dir'), 'real_directory', 'a plain directory is refused-shaped');
    assert.equal(classify!(dir, 'link-to-dir'), 'real_directory', 'a symlink whose target IS a directory is refused-shaped too — the decision is explicit that "leaf" means non-directory, and a directory reached via a symlink is still a directory on disk');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError, export absent.
// SABOTAGE (once built): classify via lstat instead of stat (so a symlink is
// never resolved to its target's type) -> the second assertion goes red
// while the first (plain directory) stays green — that split is exactly the
// discrimination this arm exists to provide, and it is the one place a
// same-mutation could pass CONTROL 1's leaf-symlink pin and still be wrong.

test('3: classifyClaimPath returns {kind:"unverifiable", errno} for a path behind an unreadable ancestor directory (EACCES) — an unclassifiable claim is NOT admitted as absent', { skip: isRoot ? 'running as root: permission bits do not restrict root, EACCES is unreachable' : false }, () => {
  const { dir, cleanup } = harness();
  try {
    mkdirSync(join(dir, 'blocked'));
    writeFileSync(join(dir, 'blocked', 'secret.txt'), 'shh');
    chmodSync(join(dir, 'blocked'), 0o000);
    try {
      const classify = classifierFrom(sterlingStorePkg);
      const verdict = classify!(dir, 'blocked/secret.txt');
      assert.equal(typeof verdict, 'object', 'an unclassifiable claim is an object, never the bare string "absent" or "leaf"');
      assert.equal((verdict as { kind: string }).kind, 'unverifiable', 'the verdict is explicitly unverifiable, not silently treated as one of the two decidable states');
      assert.ok((verdict as { errno?: string }).errno, 'the errno is named — the asymmetry the decision states: an absent capability is disclosed, an unclassifiable claim is not silently admitted either way');
      assert.match(String((verdict as { errno?: string }).errno), /EACCES/, 'names the specific errno, not a generic "cannot verify"');
    } finally {
      chmodSync(join(dir, 'blocked'), 0o700); // restore so rmSync can clean up
    }
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red today): TypeError, export absent.
// SABOTAGE (once built): swallow the stat error and return 'absent' for ANY
// thrown errno (collapsing EACCES into the same bucket as ENOENT) -> the
// `typeof verdict === 'object'` assertion goes red, and CONTROL 1's genuine
// ENOENT-is-absent pin stays green, which is exactly the discrimination this
// arm needs: a mutant that merges the two would still make ENOENT report
// 'absent' correctly while this arm alone catches the merge.

test('4: classifyClaimPath is the SAME function object whether imported from the public package entry ("@sterling/store") or the internal module — the tool layer and the delivery oracle cannot silently diverge onto two copies', () => {
  const pkg = classifierFrom(sterlingStorePkg);
  const internal = classifierFrom(sterlingStoreInternal);
  assert.equal(typeof pkg, 'function', 'EXPECTED FAILURE (red): the public entry exports no classifyClaimPath yet');
  assert.equal(typeof internal, 'function', 'EXPECTED FAILURE (red): the internal module exports no classifyClaimPath yet either');
  assert.equal(pkg, internal, 'one export, re-exported — never two independently-written classifiers that could drift apart');
});
// EXPECTED FAILURE SHAPE (red today): both typeof checks fail (undefined !==
// 'function') before the identity check is ever reached.
// SABOTAGE (once one exists): implement a SECOND, textually-duplicated
// classifyClaimPath directly inside packages/mcp-server/src/tools.ts (or
// scripts/delivery-oracle.mjs) instead of importing the store's export, while
// leaving @sterling/store's own export in place unused -> this specific pin
// cannot see that duplication directly (it only imports @sterling/store), but
// the two `typeof` assertions stay green while the identity assertion is the
// one that would catch a package that re-exports a DIFFERENT function under
// the same name from its two entry surfaces; disclosed as a LIMITATION this
// pin does not reach the tool-layer/oracle call sites themselves — those are
// out of this file's scope (packages/store) and are not re-pinned here.
