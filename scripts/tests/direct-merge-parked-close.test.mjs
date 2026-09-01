// PARKED-ITEM DELETION-SHAPED CLOSURE — scripts/lib/parked-close.mjs (board 1ab3c2bf).
//
// SPEC UNDER TEST (dispatch brief, NOT read from any in-flight implementation —
// scripts/direct-merge.mjs and scripts/lib/parked-close.mjs were not read; the
// module under test does not exist yet):
//
//   deletedBetween(cwd, fromSha, toSha) -> Set<string> | null
//     Repo-relative POSIX paths deleted between two commits, computed via the
//     endpoint diff `git diff --name-only --diff-filter=D --no-renames -z
//     <fromSha> <toSha>` semantics (deletions that happened somewhere in
//     history between the two shas but are absent at BOTH endpoints do not
//     count — this is an endpoint diff, never a history walk). On ANY git
//     failure (non-zero exit, spawn error, unparseable output) it returns
//     `null`, never an empty Set, because "could not measure" must stay
//     distinguishable from "nothing deleted" (fail-loud, P5). NUL-delimited
//     parsing: the trailing empty segment produced by -z's trailing NUL is
//     ignored; paths containing spaces are preserved exactly.
//
//   parkedItemResolved(paths, deletedSet, existsFn) -> boolean
//     Pure. `paths` empty or not an array => false (item stays open). Per
//     path, resolved(path) = existsFn(path) || (deletedSet !== null &&
//     deletedSet.has(path)) — when deletedSet is null, a path resolves ONLY
//     via existsFn (deletion evidence unavailable must never close a
//     deletion-shaped item). The item is resolved iff EVERY path resolves.
//
// This file authors tests from THAT SPEC alone. Fixture/harness idiom
// (mkdtempSync in os scratch + git init, a flattening oneLine() helper per
// anti-pattern ee89c3fd for any child-process stream that might land in a
// failing assertion message) cribbed from the conventions in sibling suites
// such as scripts/tests/direct-merge-board-nudge.test.mjs, which was read
// ONLY for harness conventions, never for behavior.
//
// Purpose/context, not tested here: direct-merge's parked-file sweep
// currently closes file_parked board items only when the parked file
// RETURNS at merge time; when the merged branch instead DELETES the parked
// file, the item lingers forever. This module supplies the two primitives
// (git-backed deletion evidence + pure resolution predicate) that a future
// direct-merge wiring will use to close deletion-shaped parked items too.
//
// Each test names its SABOTAGE in the title (documented intent — sabotages
// are never applied in this file). Where a verdict ("true" / "a path is in
// the Set") has more than one possible cause, a CONTROL arm proving the
// opposite for the opposite reason is placed immediately before it.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { deletedBetween, parkedItemResolved } from '../lib/parked-close.mjs';

/** Flatten any child-process stream before it goes into an assertion message
 * that might fail — anti-pattern ee89c3fd. */
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function headSha(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makeGitRepo(prefix = 'sterling-parked-close-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// =========================================================================
// deletedBetween
// =========================================================================

test('1 [control: basic detection + trailing-NUL segment ignored]: a file present at the base commit and deleted in the next commit appears exactly once in the returned Set — sabotage: returning an empty Set unconditionally (or never invoking git at all), which must flip this red (size 0, missing path) — and separately pins that the trailing empty segment produced by -z\'s terminating NUL is not turned into a spurious extra Set entry (size would be 2, not 1, under a naive split-and-keep-all-segments parse)', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'gone.mjs'), 'export const gone = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add gone.mjs']);
    const base = headSha(dir);

    git(dir, ['rm', 'gone.mjs']);
    git(dir, ['commit', '-m', 'delete gone.mjs']);
    const tip = headSha(dir);

    const result = deletedBetween(dir, base, tip);
    assert.ok(result instanceof Set, `expected a Set, got ${String(result)}`);
    assert.equal(result.size, 1, 'exactly one deletion — no spurious empty-segment entry from the trailing NUL');
    assert.ok(result.has('gone.mjs'), 'the deleted file must be present in the Set');
  } finally {
    cleanup();
  }
});

test('2 [endpoint diff, not a history walk]: a file added and then deleted BETWEEN the two endpoints — absent at both the base and the tip — is NOT reported as deleted, because deletedBetween computes an endpoint diff of the two commits\' trees, never a walk of every commit in between — sabotage: replacing the two-argument endpoint diff with a union of per-commit deletions across the whole range (a history walk), which must flip this red (the transient path incorrectly appears in the Set)', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'stay.mjs'), 'export const stay = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base, without p']);
    const base = headSha(dir);

    writeFileSync(join(dir, 'p.mjs'), 'export const p = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add p']);

    git(dir, ['rm', 'p.mjs']);
    git(dir, ['commit', '-m', 'delete p']);
    const tip = headSha(dir);

    const result = deletedBetween(dir, base, tip);
    assert.ok(result instanceof Set, `expected a Set, got ${String(result)}`);
    assert.ok(!result.has('p.mjs'), 'p is absent at BOTH endpoints (base never had it, tip no longer has it) — the endpoint diff must not report it as deleted');
  } finally {
    cleanup();
  }
});

test('3 [rename counts as deletion, --no-renames]: a file renamed between the two endpoints has its ORIGINAL path reported as deleted — sabotage: omitting --no-renames from the underlying git diff invocation, letting git\'s default rename detection collapse the pair into a single R-status line that --diff-filter=D never matches, which must flip this red (the Set lacks the original path entirely)', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'p.mjs'), 'export const p = 1;\nexport const filler = 2;\nexport const more = 3;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add p']);
    const base = headSha(dir);

    git(dir, ['mv', 'p.mjs', 'q.mjs']);
    git(dir, ['commit', '-m', 'rename p to q']);
    const tip = headSha(dir);

    const result = deletedBetween(dir, base, tip);
    assert.ok(result instanceof Set, `expected a Set, got ${String(result)}`);
    assert.ok(result.has('p.mjs'), 'the rename source path must be reported as deleted under --no-renames semantics');
  } finally {
    cleanup();
  }
});

test('4 [NUL-delimited parsing preserves spaces exactly]: a deleted file whose name contains a space is preserved verbatim in the Set, alongside a normal deletion, with no extra or fragmented entries — sabotage: splitting the -z output on generic whitespace/newlines instead of the NUL byte, which must flip this red (the spaced path is missing, fragmented into two entries, or the Set size is wrong)', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'a b.mjs'), 'export const ab = 1;\n');
    writeFileSync(join(dir, 'normal.mjs'), 'export const normal = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add both']);
    const base = headSha(dir);

    git(dir, ['rm', 'a b.mjs', 'normal.mjs']);
    git(dir, ['commit', '-m', 'delete both']);
    const tip = headSha(dir);

    const result = deletedBetween(dir, base, tip);
    assert.ok(result instanceof Set, `expected a Set, got ${String(result)}`);
    assert.equal(result.size, 2, 'exactly two deletions, no fragmentation of the spaced path');
    assert.ok(result.has('a b.mjs'), 'the space-containing path must be preserved exactly, not split or truncated');
    assert.ok(result.has('normal.mjs'), 'the ordinary path must still be present alongside it');
  } finally {
    cleanup();
  }
});

test('5 [git failure: bogus sha -> null, never an empty Set]: an unresolvable sha causes deletedBetween to return null rather than an empty Set, so "could not measure" stays distinguishable from "nothing deleted" — sabotage: catching the non-zero git exit and returning new Set() instead of null, which must flip this red (result is an empty Set, indistinguishable from a real no-deletions answer)', () => {
  const { dir, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'x.mjs'), 'export const x = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x']);
    const tip = headSha(dir);

    const result = deletedBetween(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', tip);
    assert.strictEqual(result, null, 'an unresolvable sha must produce null, never an empty Set');
  } finally {
    cleanup();
  }
});

test('6 [git failure: non-repo cwd -> null]: calling deletedBetween against a directory that is not a git repository returns null — sabotage: same as above, swallowing the "not a git repository" failure into an empty Set, which must flip this red (result is an empty Set instead of null)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-parked-close-norepo-'));
  try {
    const result = deletedBetween(dir, 'HEAD~1', 'HEAD');
    assert.strictEqual(result, null, 'a non-repo cwd must produce null, never an empty Set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// parkedItemResolved
// =========================================================================

test('7 [guard: empty paths array -> false]: an item with a zero-length paths array is reported unresolved (stays open) — sabotage: using Array.prototype.every over an empty paths array without an explicit length guard, which vacuously returns true for an empty array and must flip this red (result is true for a paths-less item)', () => {
  assert.strictEqual(parkedItemResolved([], new Set(), () => true), false);
});

test('8 [guard: non-array paths -> false]: a non-array paths value (null) is reported unresolved rather than throwing or being coerced into a truthy pass — sabotage: removing the Array.isArray guard so a non-array paths value is treated as satisfying resolution (or throws uncaught), which must flip this red (result is not strictly false, or the test errors)', () => {
  assert.strictEqual(parkedItemResolved(null, new Set(), () => true), false);
});

test('9 [control: a genuinely unresolved single path -> false]: a single path that neither exists on disk nor appears in the deleted set is reported unresolved — placed before the affirmative pins below so a green suite cannot be explained by an implementation that simply always returns true', () => {
  const deletedSet = new Set(['other/file.mjs']);
  const existsFn = () => false;
  assert.strictEqual(parkedItemResolved(['gone/nowhere.mjs'], deletedSet, existsFn), false);
});

test('10 [all paths present]: every path in the item exists on disk -> resolved true — sabotage: requiring deletion evidence even when the file plainly exists (ANDing existsFn with a deletedSet membership check instead of ORing), which must flip this red (a present, non-deleted path reports unresolved)', () => {
  const deletedSet = new Set();
  const existsFn = () => true;
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], deletedSet, existsFn), true);
});

test('11 [all paths deleted]: every path in the item is absent on disk but present in the deleted set -> resolved true — sabotage: ignoring deletedSet entirely and resolving only via existsFn, which must flip this red (a deleted-and-absent path reports unresolved despite deletion evidence)', () => {
  const deletedSet = new Set(['a.mjs', 'b.mjs']);
  const existsFn = () => false;
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], deletedSet, existsFn), true);
});

test('12 [mixed present + deleted]: one path exists on disk, the other is absent but recorded as deleted -> resolved true — sabotage: requiring a single uniform resolution reason across all paths (e.g. treating a mixed item as unresolved unless every path is either all-present or all-deleted), which must flip this red (a legitimately mixed item reports unresolved)', () => {
  const deletedSet = new Set(['b.mjs']);
  const existsFn = (p) => p === 'a.mjs';
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], deletedSet, existsFn), true);
});

test('13 [every path must resolve, not just some]: one path resolves (exists) but a second path neither exists nor is deleted -> resolved false — sabotage: using Array.prototype.some instead of every across paths, which must flip this red (an item with one genuinely unresolved path incorrectly reports resolved)', () => {
  const deletedSet = new Set();
  const existsFn = (p) => p === 'a.mjs';
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], deletedSet, existsFn), false);
});

test('14 [deletedSet null, all present -> true]: with deletion evidence unavailable (deletedSet null), a path still resolves via existsFn alone -> resolved true — sabotage: treating a null deletedSet as a reason to short-circuit the whole item to false regardless of existsFn, which must flip this red (a fully-present item under null deletedSet reports unresolved)', () => {
  const existsFn = () => true;
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], null, existsFn), true);
});

test('15 [deletedSet null, one absent -> false]: with deletion evidence unavailable (deletedSet null), a path that does not exist cannot be resolved by deletion evidence it does not have -> resolved false — sabotage: treating a null deletedSet as "assume deleted" and returning true unconditionally when existsFn is false, which must flip this red (an absent path under null deletedSet incorrectly reports resolved) — this is the load-bearing pin against closing a deletion-shaped item when deletion evidence could not be measured', () => {
  const existsFn = (p) => p === 'a.mjs';
  assert.strictEqual(parkedItemResolved(['a.mjs', 'b.mjs'], null, existsFn), false);
});

// =========================================================================
// INTEGRATION — direct-merge.mjs's parked-file sweep WIRING (board 1ab3c2bf
// follow-up; outside-family review finding: tests 1-15 above pin only the
// pure helper module scripts/lib/parked-close.mjs — they cannot detect a
// hollow WIRING (deletedBetween never imported/called, the wrong pre/post
// endpoints passed to it, or the sweep never invoked at all). These three
// tests drive scripts/direct-merge.mjs end-to-end through a real git merge
// and a real (temp, per-test) Sterling store, and assert on OBSERVABLE
// outcomes only: process exit code, stdout JSON, and whether the file_parked
// board item is still present in the store's query() results afterward.
//
// SPEC UNDER TEST (dispatch brief, spec-only — scripts/direct-merge.mjs was
// NOT read to write these three tests): after a successful merge,
// direct-merge computes the deletion set between the pre-merge tip of the
// target branch and the post-merge HEAD, then closes each system-source
// file_parked board item whose every file_keys path is present in the tree
// OR in that deletion set. A failure computing the set leaves
// deletion-shaped items OPEN (presence-only closure). The sweep only
// touches source==='system' && system_reason==='file_parked' items.
//
// HARNESS: the git-project-with-.sterling-dir fixture (makeGitProjectForMerge
// / runDirectMerge / openStore), the envelope()/store-record-shape idiom, and
// the oneLine() stderr-flattening discipline (anti-pattern ee89c3fd) are
// cribbed verbatim from scripts/tests/direct-merge-cleared-report.test.mjs,
// which was read ONLY for this harness convention, never for behavior —
// duplicated locally per that file's own stated convention, since test files
// export nothing. Mirrors EXACTLY how that file's fixtures get a plain merge
// past the earlier gate stages (review receipts, build steps): no
// package.json / build toolchain is present in the fixture, so those stages
// do not engage; this was verified by cleared-report's own control test (its
// test 1) succeeding on an equally plain fixture.
//
// ORDERING: the CONTROL (still-parked stays open) is placed FIRST, per the
// house convention in direct-merge-cleared-report.test.mjs's own test 1 —
// the deletion-shaped and return-shaped "closes" verdicts below are each
// satisfiable by a hollow always-close implementation (e.g. "close every
// file_parked item once any merge succeeds"), so a green run on either of
// them alone proves nothing without the control showing that a genuinely
// still-open item is NOT swept up.
// =========================================================================

const NOW = '2026-08-24T12:00:00.000Z';
const integrationRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(integrationRoot, 'packages', 'store', 'dist', 'index.js')).href));
});

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

/** A system-source file_parked board item naming `paths`. */
function parkedItem(store, paths, text) {
  return store.create({
    ...envelope('todo'),
    text: text ?? `parked file(s) — ${paths.join(', ')}`,
    source: 'system',
    system_reason: 'file_parked',
    file_keys: paths,
  });
}

/** Same fixture idiom as direct-merge-cleared-report.test.mjs's
 * makeGitProjectNoRun: a plain repo with a base commit and an empty
 * .sterling/ dir, no package.json/build toolchain, so review-receipt and
 * build gate stages never engage. */
function makeGitProjectForMerge() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-parked-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(integrationRoot, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

function openStore(dir) {
  return new SterlingStore(join(dir, '.sterling', 'sterling.db'));
}

/** True iff a record with this id is still returned by the store's default
 * (non-superseded) query — checked client-side so this helper never depends
 * on which filter parameter names query() accepts internally. NOTE: the
 * STORE layer returns a plain array; the {matched_filter, returned, records}
 * envelope exists only at the MCP tool surface. The original {records}-shaped
 * read here made this helper return false for EVERY item (test 16's control
 * caught it — 17/18 were vacuously green), so it now refuses any shape it
 * does not recognize instead of defaulting to "absent". */
function boardHasItem(store, id) {
  const result = store.query({ cap: 200 });
  const records = Array.isArray(result) ? result : result?.records;
  if (!Array.isArray(records)) throw new Error(`boardHasItem: unrecognized query() return shape: ${typeof result}`);
  return records.some((r) => r.id === id);
}

test('16 [control, placed first]: a file_parked item naming a path that is absent both before and after the merge, and is not part of this merge\'s deletion set (the path never existed anywhere in the repo), remains OPEN after a successful direct-merge — sabotage: closing every file_parked item unconditionally once a merge succeeds (or once the sweep runs at all, regardless of resolution evidence), which must flip this red (the item is gone from the store despite no presence or deletion evidence naming it) — this control is what makes tests 17/18 below meaningful: without it, a hollow always-close wiring would pass them identically', () => {
  const { dir, cleanup } = makeGitProjectForMerge();
  try {
    const store = openStore(dir);
    const item = parkedItem(store, ['src/never-existed.mjs']);
    store.close();

    git(dir, ['checkout', '-b', 'feat/unrelated']);
    writeFileSync(join(dir, 'src', 'other.mjs'), 'export const other = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add an unrelated file']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `expected a clean merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);

    const after = openStore(dir);
    const stillOpen = boardHasItem(after, item.id);
    after.close();
    assert.ok(stillOpen, 'a parked item whose path was never present and never deleted by this merge must remain open');
  } finally {
    cleanup();
  }
});

test('17 [target]: a file_parked item naming a path that the merged branch DELETES is closed after a successful direct-merge — sabotage: never calling deletedBetween from direct-merge (or wiring the wrong pre/post endpoints into it, e.g. two commits that are not the actual pre-merge target tip and post-merge HEAD), so deletion evidence never reaches the closure predicate for this item, which must flip this red (the item survives the merge despite its sole path being gone from the post-merge tree)', () => {
  const { dir, cleanup } = makeGitProjectForMerge();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'old-thing.mjs'), 'export const old = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed old-thing.mjs on main']);

    const store = openStore(dir);
    const item = parkedItem(store, ['src/old-thing.mjs']);
    store.close();

    git(dir, ['checkout', '-b', 'feat/delete-old-thing']);
    git(dir, ['rm', 'src/old-thing.mjs']);
    git(dir, ['commit', '-m', 'delete old-thing.mjs']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `expected a clean merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/delete-old-thing');

    const after = openStore(dir);
    const stillOpen = boardHasItem(after, item.id);
    after.close();
    assert.ok(!stillOpen, 'a parked item whose sole path was deleted by this merge must be closed');
  } finally {
    cleanup();
  }
});

test('18 [regression control]: a file_parked item naming a path that RETURNS (the merged branch adds it back) is closed after a successful direct-merge, confirming the deletion-set wiring addition did not regress the pre-existing presence-based closure path — sabotage: routing the presence check through a stale pre-merge tree/commit instead of the post-merge HEAD (e.g. reusing the pre-merge endpoint the new deletion-set call introduced), which must flip this red (the item survives despite the path now existing in the merged tree)', () => {
  const { dir, cleanup } = makeGitProjectForMerge();
  try {
    const store = openStore(dir);
    const item = parkedItem(store, ['src/returning.mjs']);
    store.close();

    git(dir, ['checkout', '-b', 'feat/return-file']);
    writeFileSync(join(dir, 'src', 'returning.mjs'), 'export const returning = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add back returning.mjs']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `expected a clean merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/return-file');

    const after = openStore(dir);
    const stillOpen = boardHasItem(after, item.id);
    after.close();
    assert.ok(!stillOpen, 'a parked item whose path now exists in the post-merge tree must be closed');
  } finally {
    cleanup();
  }
});
