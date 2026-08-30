// reviewer-selection --base: the REVIEW ARTIFACT (board f24d42b2, ruling 4977a96c).
//
// WHY THIS FILE EXISTS. Roster reviewers hold no Bash grant (Read/Grep/Glob/
// ToolSearch/knowledge_*/handoff_*/agent_exit) and that grant is CORRECT — a checker
// must not be able to modify what it checks. So a brief saying "run `git diff`" is
// unsatisfiable, and the conductor hand-materializes the diff instead. Decision
// 4977a96c REJECTED exactly that shape ("a two-step remembered procedure with a temp
// file"), and records that hand-building the diff had already failed twice: untracked
// files under-counted, and line NUMBERS passed where CONTENT was required — which
// silenced the security reviewer and let real HIGH findings through a first review.
//
// The fix is the same fold-it-into-the-existing-command move `--base` itself was: the
// SAME invocation that selects reviewers also publishes the patch they read, so
// selection and materialization cannot come apart.
//
// EVERY test below carries an inline SABOTAGE line: the ONE-LINE implementation change
// that must turn it red. A pin whose sabotage leaves it green is hollow and worthless.
// Where a verdict has more than one possible cause, the CONTROL ARM comes FIRST so a
// green always carries its own evidence.
//
// These tests are RED until the producer lands. That is the point.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
  symlinkSync, lstatSync, realpathSync, chmodSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function gitTry(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

// A repo whose base commit ('main') carries a MULTI-LINE tracked file and a file that
// later gets DELETED — both shapes buildDiffJson's added-lines view cannot express.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-revart-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nexport const removeMe = 2;\nexport const keep = 3;\n');
  writeFileSync(join(dir, 'src', 'gone.mjs'), 'export const gone = 1;\nexport const alsoGone = 2;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function runSelection(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'reviewer-selection.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The artifact path may be absolute or repo-relative POSIX (path invariant); accept both.
const artifactPath = (dir, out) => {
  const p = out?.review_artifact?.path;
  assert.equal(typeof p, 'string', 'review_artifact.path is a string');
  assert.notEqual(p.trim(), '', 'review_artifact.path is not empty');
  return isAbsolute(p) ? p : resolve(dir, p);
};

const readArtifact = (dir, out) => {
  const p = artifactPath(dir, out);
  assert.ok(existsSync(p), `the published artifact exists on disk at ${p} — a brief naming a path that does not exist is worse than no brief line`);
  return readFileSync(p);
};

// `+` lines of a unified patch, excluding the `+++ b/…` file header.
const addedLineCount = (patch) =>
  patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;

const selectionOk = (r) => {
  assert.equal(r.status, 0, `selection exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

// ---------------------------------------------------------------------------
// PIN 1 — the artifact rides INSIDE the single JSON document on stdout.
// stdout is machine-parsed by callers (scripts/tests/pipeline.test.mjs:241 does
// `JSON.parse(r.stdout)`), so a prose "REVIEW ARTIFACT: <path>" line appended after the
// document breaks every existing caller. JSON.parse over the WHOLE of stdout is the
// pin: trailing non-whitespace is a SyntaxError, so a green here means one document.
// ---------------------------------------------------------------------------
test('review artifact: stdout stays ONE JSON document and carries review_artifact {path, sha256, base}', () => {
  const { dir, cleanup } = makeRepo();
  try {
    // base ('main') deliberately != HEAD ('work'), so a `base` field reporting the wrong
    // ref is distinguishable from one reporting the right one.
    git(dir, ['checkout', '-b', 'work']);
    writeFileSync(join(dir, 'src', 'committed.mjs'), 'export const c = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'work commit']);
    // NOTE: every test in this file gives its snapshot a UNIQUE marker. The artifact is
    // content-addressed, so two tests with identical patch bytes would target the SAME
    // published path — and the fail-closed test deliberately leaves a directory there.
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 1001;\n');

    const r = runSelection(dir, ['--base', 'main']);

    // CONTROL ARM FIRST: the pre-existing selection contract still holds. Without this,
    // a green below could mean "the command now prints a bare artifact object" rather
    // than "the selection document gained a field".
    const out = selectionOk(r);
    assert.ok(Array.isArray(out.dispatch), 'the parsed document is still the SELECTION document (dispatch present)');
    assert.ok(Array.isArray(out.skipped), 'the parsed document is still the SELECTION document (skipped present)');

    assert.equal(r.stdout.trim().endsWith('}'), true, 'stdout ends with the JSON document — nothing appended after it');
    assert.ok(out.review_artifact && typeof out.review_artifact === 'object', 'review_artifact is a member of the selection JSON, not a prose line beside it');
    assert.equal(typeof out.review_artifact.path, 'string');
    assert.match(out.review_artifact.sha256, /^[0-9a-f]{64}$/, 'sha256 is a full hex digest');

    // `base` identifies the base the patch was taken against: the literal ref or its
    // resolved sha — but NEVER the HEAD sha, which is the classic off-by-one-ref bug.
    const mainSha = git(dir, ['rev-parse', 'main']);
    const headSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(mainSha, headSha, 'fixture precondition: base and HEAD are different commits');
    assert.ok(
      out.review_artifact.base === 'main' || out.review_artifact.base === mainSha,
      `review_artifact.base names the requested base, got '${out.review_artifact.base}'`,
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: `console.log(JSON.stringify(sel)); console.log('REVIEW ARTIFACT: ' + p);`
//   → JSON.parse over the whole stdout throws SyntaxError ("Unexpected non-whitespace
//   character after JSON") and the test dies on selectionOk. Second sabotage: emit
//   `base: 'HEAD'` → the base assertion fires with the HEAD sha.

// ---------------------------------------------------------------------------
// PIN 2 — CONTENT-ADDRESSED path, never a shared mutable slot (P4).
// Two arms, and NEITHER ALONE PINS ANYTHING:
//   arm A (stability) alone is satisfied by a fixed filename `review.patch`;
//   arm B (divergence) alone is satisfied by a random/timestamped filename.
// Only both together say "the name is a function of the bytes". Arm A runs first as
// the control: it proves the command is deterministic at all, so a divergence in arm B
// is attributable to the changed snapshot rather than to per-run noise.
// ---------------------------------------------------------------------------
test('review artifact: content-addressed — same snapshot same path (arm A), changed snapshot different path (arm B), earlier artifact survives', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 2001;\n');

    // ARM A (control): identical snapshot, twice.
    const out1 = selectionOk(runSelection(dir, ['--base', 'main']));
    const p1 = artifactPath(dir, out1);
    const bytes1 = readArtifact(dir, out1);

    const out2 = selectionOk(runSelection(dir, ['--base', 'main']));
    const p2 = artifactPath(dir, out2);
    assert.equal(p2, p1, 'ARM A: the same snapshot publishes to the SAME path — the name is derived from content, not from a clock or a uuid');
    assert.equal(out2.review_artifact.sha256, out1.review_artifact.sha256, 'ARM A: same snapshot, same digest');
    assert.deepEqual(readFileSync(p2), bytes1, 'ARM A: the republished bytes are identical');

    // ARM B: a different snapshot must not land in the same slot.
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 2001;\nexport const v = 2002;\n');
    const out3 = selectionOk(runSelection(dir, ['--base', 'main']));
    const p3 = artifactPath(dir, out3);
    assert.notEqual(p3, p1, 'ARM B: a DIFFERENT snapshot publishes to a DIFFERENT path — a shared mutable slot is forbidden (P4)');
    assert.notEqual(out3.review_artifact.sha256, out1.review_artifact.sha256, 'ARM B: different content, different digest');

    // The P4 consequence that actually bites: a reviewer still reading the first patch
    // must not have it rewritten under them by a second selection.
    assert.ok(existsSync(p1), 'the earlier artifact still exists after a later selection');
    assert.deepEqual(readFileSync(p1), bytes1, 'the earlier artifact was NOT overwritten by the later snapshot');
  } finally {
    cleanup();
  }
});
// SABOTAGE (arm A): name the file `review-${Date.now()}.patch` → p2 !== p1, arm A fires.
// SABOTAGE (arm B): name the file `review.patch` (a fixed slot) → p3 === p1, arm B fires
//   AND the survival assertion fires on the mutated bytes. Both sabotages are needed
//   because each arm alone is green under the other's bug.

// ---------------------------------------------------------------------------
// PIN 2b — the advertised digest is the digest of the EXACT bytes at the path.
// Separate test so a digest defect is attributable on its own, rather than hiding
// behind the addressing assertions above.
// ---------------------------------------------------------------------------
test('review artifact: review_artifact.sha256 is the sha256 of the exact bytes at review_artifact.path', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 2101;\n');
    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const bytes = readArtifact(dir, out);
    assert.equal(sha256(bytes), out.review_artifact.sha256, 'the digest names the bytes actually on disk — a reviewer can verify what it was handed');
  } finally {
    cleanup();
  }
});
// SABOTAGE: hash the diff-json structure (or the utf8 string with normalized newlines)
//   instead of the written buffer → the equality fires with two different hex digests.

// ---------------------------------------------------------------------------
// PIN 3a — a file DELETED vs the base MUST appear.
// This is the pin that catches "render buildDiffJson into something patch-shaped":
// that structure carries added content ONLY, drops removed lines and headers, and
// omits pure deletions entirely, so a rendering of it cannot show this file at all.
// ---------------------------------------------------------------------------
test('review artifact: a file DELETED vs the base appears in the patch with its removed lines (buildDiffJson cannot express this)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    rmSync(join(dir, 'src', 'gone.mjs')); // pure deletion, unstaged
    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    assert.match(patch, /src\/gone\.mjs/, 'the deleted path is named in the patch');
    assert.match(patch, /^-export const gone = 1;$/m, 'the removed line appears with its `-` marker');
    assert.match(patch, /^-export const alsoGone = 2;$/m, 'every removed line appears, not just the first');
  } finally {
    cleanup();
  }
});
// SABOTAGE: produce the artifact by rendering buildDiffJson's [{path, added_lines}]
//   (e.g. `files.map(f => '+++ b/'+f.path+'\n'+f.added_lines.map(l=>'+'+l).join('\n'))`)
//   → src/gone.mjs is absent entirely; the first assert.match fires on the missing path.

// ---------------------------------------------------------------------------
// PIN 3b — an UNTRACKED new file MUST appear as a NEW-FILE patch.
// This is the documented r-1417 failure: bare `git diff <base>` never sees untracked
// files, so the reviewer reads a patch missing the whole new file.
// ---------------------------------------------------------------------------
test('review artifact: an UNTRACKED new file appears as a new-file patch (bare `git diff <base>` omits it — the r-1417 failure)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 3;\nconst more = 4;\n');
    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    assert.match(patch, /^\+\+\+ b\/src\/untracked\.mjs$/m, 'the untracked file has a proper `+++ b/…` header');
    assert.match(patch, /^new file mode /m, 'it is presented as a NEW FILE, not as a context-free fragment');
    assert.match(patch, /^\+export const u = 3;$/m, 'its first line is present as added content');
    assert.match(patch, /^\+const more = 4;$/m, 'its remaining lines are present too');
  } finally {
    cleanup();
  }
});
// SABOTAGE: `execFileSync('git', ['diff', '--end-of-options', base])` as the whole
//   producer (drop the untracked union) → src/untracked.mjs is absent; the `+++ b/…`
//   assertion fires. This is the exact regression 4977a96c was written about.

// ---------------------------------------------------------------------------
// PIN 3c — REMOVED lines on a MODIFIED tracked file MUST appear with `-` markers.
// diff-json is structurally incapable of representing these; if they are present, the
// producer is not a diff-json rendering.
// ---------------------------------------------------------------------------
test('review artifact: removed lines on a modified tracked file appear with `-` markers alongside the additions', () => {
  const { dir, cleanup } = makeRepo();
  try {
    // drop `removeMe`, add two lines
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nexport const keep = 3;\nexport const added1 = 4;\nexport const added2 = 5;\n');
    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    // CONTROL ARM FIRST: the additions are present. Without it, a green on the removal
    // assertion could mean "the patch is complete" or "the patch is some other file's".
    assert.match(patch, /^\+export const added1 = 4;$/m, 'CONTROL: added lines are present, so this really is the patch for this change');
    assert.match(patch, /^-export const removeMe = 2;$/m, 'the REMOVED line is present with its `-` marker');
    assert.match(patch, /^@@ /m, 'the patch carries hunk headers — a reviewer can locate the change');
  } finally {
    cleanup();
  }
});
// SABOTAGE: render from buildDiffJson (added_lines only) → the `-export const removeMe`
//   assertion fires (and `@@` is absent). A patch without removals hides exactly the
//   half of a change where regressions live.

// ---------------------------------------------------------------------------
// PIN 3d — COMPLETENESS, end to end: the artifact APPLIES to a clean checkout of the
// base and reproduces the working state. This is the strongest available oracle for
// "a complete unified patch" — it cannot be satisfied by a lossy rendering, because
// `git apply` refuses malformed or partial patches outright.
// ---------------------------------------------------------------------------
test('review artifact: the patch applies cleanly to a fresh checkout of the base and reproduces the reviewed state', () => {
  const { dir, cleanup } = makeRepo();
  const cloneRoot = mkdtempSync(join(tmpdir(), 'sterling-revart-clone-'));
  try {
    rmSync(join(dir, 'src', 'gone.mjs'));                                            // deletion
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nexport const keep = 3;\nexport const added1 = 4;\n'); // modification
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 3;\n');       // untracked addition

    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patchFile = artifactPath(dir, out);

    const clone = join(cloneRoot, 'c');
    git(cloneRoot, ['clone', '--quiet', dir, clone]);
    git(clone, ['checkout', '--quiet', 'main']);

    // CONTROL ARM FIRST: the clone is at the BASE state, so a successful apply below is
    // evidence the patch carried the change — not evidence that the change was already
    // there and the patch was empty.
    assert.ok(existsSync(join(clone, 'src', 'gone.mjs')), 'CONTROL: the clone starts at base — the to-be-deleted file is present');
    assert.ok(!existsSync(join(clone, 'src', 'untracked.mjs')), 'CONTROL: the clone starts at base — the new file is absent');
    assert.match(readFileSync(join(clone, 'src', 'base.mjs'), 'utf8'), /removeMe/, 'CONTROL: the clone starts at base — the pre-change content is present');

    const check = gitTry(clone, ['apply', '--check', patchFile]);
    assert.equal(check.status, 0, `the artifact is a well-formed, complete patch against the base: ${check.stderr}`);
    const applied = gitTry(clone, ['apply', patchFile]);
    assert.equal(applied.status, 0, `the artifact applies: ${applied.stderr}`);

    assert.ok(!existsSync(join(clone, 'src', 'gone.mjs')), 'the deletion travelled in the patch');
    assert.equal(readFileSync(join(clone, 'src', 'untracked.mjs'), 'utf8'), 'export const u = 3;\n', 'the untracked addition travelled in the patch');
    assert.equal(
      readFileSync(join(clone, 'src', 'base.mjs'), 'utf8'),
      readFileSync(join(dir, 'src', 'base.mjs'), 'utf8'),
      'the modified file reproduces the reviewed working-tree content byte for byte',
    );
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanup();
  }
});
// SABOTAGE: emit `+`-only lines with no `diff --git`/`index`/`@@` headers (the
//   diff-json rendering) → `git apply --check` exits nonzero with "unrecognized input"
//   and the check assertion fires. Second sabotage: drop the untracked union → apply
//   succeeds but the untracked.mjs content assertion fires with ENOENT.

// ---------------------------------------------------------------------------
// PIN 4 — ONE SNAPSHOT, TWO VIEWS.
// The best observable shadow of "both views derive from the same captured state": the
// number of added lines the SELECTION counted (reported in the skeptic's `why`) must
// equal the number of `+` lines in the ARTIFACT. Two producers reading the tree at two
// different moments, or two producers with different inclusion rules, disagree here.
// SCOPE, stated plainly: this is the END-TO-END arm — it observes the shipped command
// through its public surface and cannot, by itself, prove that the two views derive from
// ONE capture rather than from two well-behaved ones. The DIRECT proof of that property
// now exists and lives in PIN 16 below: `captureDiffSnapshot` is exported, so a test can
// hold a snapshot, mutate the tree, and re-derive. (An earlier revision of this comment
// said no such seam was declared. That is no longer true — read PIN 16, not this note,
// for the tree-independence verdict; this arm is kept because a seam-level pin cannot
// see a shipped command that ignores the seam.)
// ---------------------------------------------------------------------------
test('review artifact: the artifact and the selection agree on the added-line count — one snapshot, two views', () => {
  const { dir, cleanup } = makeRepo();
  try {
    // 401 untracked lines + 2 added tracked lines - 1 removed tracked line
    const big = Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`).join('\n');
    writeFileSync(join(dir, 'src', 'big.mjs'), big + '\n');
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nexport const keep = 3;\nexport const added1 = 4;\nexport const added2 = 5;\n');

    const out = selectionOk(runSelection(dir, ['--base', 'main']));

    // CONTROL ARM FIRST: the selection view is the one 4977a96c already fixed — it must
    // have counted the untracked file. If the skeptic is missing, the disagreement below
    // would be unattributable (broken artifact vs. regressed selection).
    const skeptic = out.dispatch.find((d) => d.reviewer === 'skeptic');
    assert.ok(skeptic, 'CONTROL: the selection view counted the untracked lines and dispatched the skeptic');
    const m = /(\d+) added lines/.exec(skeptic.why);
    assert.ok(m, `CONTROL: the skeptic reason reports the counted lines, got '${skeptic.why}'`);
    const selectionCount = Number(m[1]);
    assert.equal(selectionCount, 403, 'CONTROL: the selection view sees 401 untracked + 2 tracked added lines');

    const patch = readArtifact(dir, out).toString('utf8');
    assert.equal(
      addedLineCount(patch),
      selectionCount,
      'the artifact carries exactly the added lines the selection was computed from — both views come from one captured state',
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: produce the artifact from `git diff <base>` alone while the selection keeps
//   its untracked union → the artifact holds 2 `+` lines against a selection count of
//   403; the equality fires with 2 !== 403. Second sabotage: capture the untracked file
//   list twice (once per view) rather than once — undetectable HERE by construction; that
//   one is carried by PIN 16, which holds a snapshot across a tree mutation.

// ---------------------------------------------------------------------------
// PIN 5 — FAIL-CLOSED PUBLICATION ORDER.
// If write/hash/publish fails, the command exits NONZERO and emits NO usable selection
// JSON. A brief line naming a path that does not exist is worse than no brief line: the
// reviewer reads nothing and reports no findings, which is indistinguishable from a
// clean review.
// The block is a DIRECTORY squatting on the content-addressed path — robust regardless
// of uid (unlike chmod, which root ignores) and fatal to both write() and rename().
// ---------------------------------------------------------------------------
test('review artifact: a publication failure exits NONZERO and emits no usable selection JSON (fail-closed)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 5001;\n');

    // CONTROL ARM FIRST: this exact invocation SUCCEEDS when publication can succeed.
    // Without it, the nonzero below could just mean "the command fails in this fixture".
    const ok = selectionOk(runSelection(dir, ['--base', 'main']));
    const p = artifactPath(dir, ok);
    assert.ok(existsSync(p), 'CONTROL: publication succeeded on the unblocked run');

    // Block the exact content-addressed path the same snapshot must resolve to.
    rmSync(p, { force: true });
    mkdirSync(p, { recursive: true });

    const blocked = runSelection(dir, ['--base', 'main']);
    assert.notEqual(blocked.status, 0, 'a failed publication exits NONZERO — never a success naming an unreadable path');
    assert.notEqual(blocked.stderr.trim(), '', 'the failure is LOUD on stderr (P5)');

    let parsed = null;
    try { parsed = JSON.parse(blocked.stdout); } catch { parsed = null; }
    const usable = parsed !== null && Array.isArray(parsed.dispatch);
    assert.equal(usable, false, 'NO usable selection JSON is emitted on artifact failure — publication precedes publication of the selection');
  } finally {
    cleanup();
  }
});
// SABOTAGE: print the selection JSON first, then try to write the artifact inside a
//   try/catch that warns and continues → status is 0 and stdout parses with a dispatch
//   array; both the nonzero assertion and the `usable === false` assertion fire.

// ---------------------------------------------------------------------------
// PIN 6 — IDEMPOTENT PUBLISH: an existing content-addressed path is VERIFIED, not
// blindly trusted and not blindly overwritten. The forbidden outcome is narrow and
// exact: exit 0 while the named path holds bytes that are not the patch.
// ---------------------------------------------------------------------------
test('review artifact: re-publishing over an existing path verifies the bytes — never a green run naming corrupted content', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 6001;\n');

    const out1 = selectionOk(runSelection(dir, ['--base', 'main']));
    const p1 = artifactPath(dir, out1);
    const bytes1 = readFileSync(p1);

    // CONTROL ARM FIRST: an unchanged re-publish is a clean no-op, exit 0, bytes intact.
    const out2 = selectionOk(runSelection(dir, ['--base', 'main']));
    assert.equal(artifactPath(dir, out2), p1, 'CONTROL: the second run targets the same path');
    assert.deepEqual(readFileSync(p1), bytes1, 'CONTROL: an already-correct artifact is left byte-identical');

    // Now corrupt the published bytes and re-run the same snapshot.
    writeFileSync(p1, 'CORRUPTED — NOT THE PATCH\n');
    const r3 = runSelection(dir, ['--base', 'main']);

    if (r3.status === 0) {
      // Repair is an acceptable answer; silence is not.
      const out3 = JSON.parse(r3.stdout);
      const p3 = artifactPath(dir, out3);
      const bytes3 = readFileSync(p3);
      assert.equal(sha256(bytes3), out3.review_artifact.sha256, 'a successful run names bytes that hash to the digest it advertised');
      assert.notEqual(bytes3.toString('utf8'), 'CORRUPTED — NOT THE PATCH\n', 'a successful run never hands a reviewer stale/corrupt content under a content-addressed name');
    } else {
      assert.notEqual(r3.stderr.trim(), '', 'refusing on a content-address collision is loud (P5)');
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: `if (existsSync(p)) return { path: p, sha256: expected, base };` — trust the
//   path without reading it → status 0, and the corrupted-bytes assertion fires
//   (sha256('CORRUPTED…') !== the advertised digest).

// ---------------------------------------------------------------------------
// PIN 7 — UNTRACKED SYMLINKS are represented AS SYMLINKS.
// buildDiffJson reads untracked files with readFileSync(join(cwd, rel)), which FOLLOWS
// symlinks. A patch producer copying that habit persists the TARGET's bytes as though
// they were repository content: an untracked link to ~/.ssh/id_rsa or an env file would
// be written verbatim into a world-readable artifact and shipped to a reviewer.
// ---------------------------------------------------------------------------
test('review artifact: an untracked SYMLINK is represented as a link — the target bytes are never persisted into the patch', (t) => {
  const { dir, cleanup } = makeRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-revart-secret-'));
  const SECRET = 'SECRET_TARGET_BYTES_MUST_NOT_BE_PERSISTED\n';
  try {
    const secretFile = join(outsideDir, 'secret.txt');
    writeFileSync(secretFile, SECRET);
    const link = join(dir, 'src', 'link.mjs');
    try {
      symlinkSync(secretFile, link);
    } catch (err) {
      t.skip(`symlinks unsupported on this filesystem: ${err.code ?? err.message}`);
      return;
    }

    // CONTROL ARM FIRST: prove the leak is REACHABLE here. If the link did not resolve,
    // a clean patch would prove nothing about symlink handling.
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'CONTROL: the fixture really is a symlink');
    assert.equal(readFileSync(link, 'utf8'), SECRET, 'CONTROL: a symlink-following read WOULD capture the target bytes');

    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    assert.ok(!patch.includes('SECRET_TARGET_BYTES_MUST_NOT_BE_PERSISTED'), 'the target CONTENT is absent from the patch — the producer did not follow the link');
    assert.match(patch, /src\/link\.mjs/, 'the link itself is still reported — it is part of the change under review');
    assert.match(patch, /120000/, 'it is represented with the symlink mode, i.e. as a LINK whose content is its target path');
  } finally {
    rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanup();
  }
});
// SABOTAGE: build the untracked half with `readFileSync(join(cwd, rel), 'utf8')` and
//   emit those lines as a new-file patch → the SECRET string lands in the artifact and
//   the `!patch.includes(...)` assertion fires. Note both later assertions are ALSO
//   load-bearing: dropping symlinks entirely would pass the secret check while hiding a
//   real change from the reviewer, and the `src/link.mjs` assertion catches that.

// ---------------------------------------------------------------------------
// PIN 8 — `--diff-json` MODE CANNOT PRODUCE A COMPLETE PATCH.
// A pre-built added-lines JSON lacks removals, headers and deletions by construction.
// WHICH BEHAVIOUR IS PINNED: the DISJUNCTION — refuse loudly, OR succeed with no
// review_artifact at all. The spec leaves the choice to the implementation, so pinning
// one arm would be inventing a ruling. What is FORBIDDEN is the silent middle: exit 0
// with a review_artifact naming a lossy patch, which is the state that would let a
// reviewer believe it had read the change.
// ---------------------------------------------------------------------------
test('review artifact: --diff-json never silently publishes a lossy artifact (refuses, or omits review_artifact entirely)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    const diffPath = join(dir, 'diff.json');
    writeFileSync(diffPath, JSON.stringify([{ path: 'src/plain.mjs', added_lines: ['const x = 1;'] }]));

    const r = runSelection(dir, ['--diff-json', diffPath]);

    if (r.status === 0) {
      const out = JSON.parse(r.stdout);
      // CONTROL: this is still the selection document, so `review_artifact == null` means
      // "deliberately omitted", not "the command printed something else entirely".
      assert.ok(Array.isArray(out.dispatch), 'CONTROL: --diff-json still produces a selection document');
      assert.equal(out.review_artifact ?? null, null, 'a pre-built added-lines JSON cannot yield a complete patch, so no artifact is advertised at all');
    } else {
      assert.notEqual(r.stderr.trim(), '', 'refusing --diff-json is loud, naming the reason (P5)');
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: render the supplied diff-json into a `+`-lines file and attach it as
//   review_artifact → status 0 with a non-null review_artifact; the `?? null` assertion
//   fires. That is precisely the failure 4977a96c is about: a reviewer handed an
//   added-lines-only view believes it saw the change.

// ---------------------------------------------------------------------------
// PIN 2c — the artifact must not contaminate the diff it describes.
// If the published patch lands inside the reviewed working set un-ignored, it becomes
// an untracked file in the NEXT selection: the reviewer reads a patch containing the
// previous patch, and content-addressing never converges. Either outside the repo, or
// ignored by git.
// ---------------------------------------------------------------------------
test('review artifact: the published patch is outside the reviewed working set (outside the repo, or git-ignored)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 7001;\n');
    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const p = realpathSync(artifactPath(dir, out));
    const repo = realpathSync(dir);

    if (p.startsWith(repo + sep)) {
      const ignored = gitTry(dir, ['check-ignore', '-q', p]);
      assert.equal(ignored.status, 0, `an in-repo artifact must be git-ignored, else it contaminates the next selection: ${p}`);
    }

    // The consequence, checked directly: a second selection over an UNCHANGED source
    // tree still sees the same change and publishes the same digest.
    const out2 = selectionOk(runSelection(dir, ['--base', 'main']));
    assert.equal(out2.review_artifact.sha256, out.review_artifact.sha256, 'publishing the artifact did not change what the next selection sees');
    const basename = p.slice(p.lastIndexOf(sep) + 1);
    assert.ok(!readArtifact(dir, out2).toString('utf8').includes(basename), 'the patch does not report a previously published patch as part of the change under review');
  } finally {
    cleanup();
  }
});
// SABOTAGE: write the artifact to `<repo>/review.patch` (un-ignored) → check-ignore
//   exits 1 and the assertion fires; the digest-stability assertion fires too, because
//   the second selection now sees the first patch as an untracked added file.

// ===========================================================================
// PINS 9–15 — FILENAME HEADER INJECTION (the forged-attribution class).
//
// WHY THIS FAMILY EXISTS. The artifact's ONLY purpose is to be trusted as an accurate
// account of what changed. Every CONTENT line is `+`/`-` prefixed, so file content
// cannot forge patch structure — the FILENAME is the sole escape hatch, and it is
// attacker-supplied: a contributor names an untracked file with an embedded newline
// plus a fabricated stanza, the producer interpolates that name into `diff --git …`,
// `+++ …` and `Binary files …`, and the literal newlines break out of the header at
// column 0. A reviewer then reads a stanza attributing a change to a file the
// contributor never touched (say `scripts/hooks/h6.mjs`), the real change can be buried
// behind the forgery, and the reviewer reports CLEAN. That is the worst possible defect
// for THIS artifact, because the artifact IS the evidence.
//
// WHAT IS PINNED, and deliberately NOT pinned. These tests do NOT assert "the name is
// quoted" — quoting is a mechanism, and a test on the mechanism is satisfied by any
// implementation that quotes badly. They assert the STRUCTURAL property a reader
// actually relies on: the number of `diff --git` stanzas at column 0 equals the number
// of REAL changed files (counted independently, by `git status`), and no PATCH HEADER
// line carries a raw control character. git's own C-quoting satisfies both for every
// legal filename; the current escaping (backslash + quote only) satisfies neither.
//
// WHICH GUARD CARRIES THE VERDICT differs by character, and is stated per test:
//   \n, \r → BOTH the stanza count and the control-char scan fire (JS multiline `^`
//            breaks on \r as well as \n, and so do most human and machine readers).
//   \t, \u0001, \u007f → ONLY the control-char scan fires; these cannot open a column-0
//            stanza, so the count assertion is defense in depth, not the verdict.
// Saying so matters: a comment naming a guard that is not load-bearing is exactly how a
// hollow pin escapes notice.
//
// HOST LIMIT, stated loudly rather than skipped quietly: a newline/tab/DEL in a
// filename is legal on ext4 and illegal on Windows. Every test below FAILS ITS FIXTURE
// LOUDLY (t.skip with a message saying NOTHING WAS PINNED) rather than passing
// vacuously, so a green run on a filesystem that refuses the name can never be mistaken
// for a verified guard.
// ===========================================================================

// The file the forged stanza tries to attribute a change to. It is never touched by any
// fixture below, so ANY stanza naming it at column 0 is a forgery by construction.
const FORGED_TARGET = 'scripts/hooks/h6.mjs';

// The attack payload, parameterised by the control character used to break out.
// The `/` characters are load-bearing: they become DIRECTORY BOUNDARIES on disk, which is
// exactly what makes a forged `diff --git a/… b/…` header constructible out of a filename
// even though `/` is the path separator. The forged content line carries NO `//` AT ALL —
// not `+// benign`, and not `+ // benign` either: ANY `//` is an EMPTY path component that
// POSIX collapses, so the file lands at a path no assertion here talks about — a fixture
// defect that reads exactly like a failing guard. A `//` comment marker is itself the trap;
// both earlier attempts at this line tripped on it, which is why the self-check below
// rejects `//` outright rather than trusting the payload to be written correctly.
const forgedName = (marker, sep) =>
  `x${marker}${sep}diff --git a/${FORGED_TARGET} b/${FORGED_TARGET}${sep}new file mode 100644` +
  `${sep}--- /dev/null${sep}+++ b/${FORGED_TARGET}${sep}@@ -0,0 +1,1 @@${sep}+ benign`;

// Lines a patch READER treats as structure rather than content. `@@` is deliberately
// EXCLUDED: a hunk header may legitimately carry a tab in its trailing function context.
const HEADER_PREFIXES = [
  'diff --git ', 'index ', '--- ', '+++ ', 'new file mode ', 'deleted file mode ',
  'old mode ', 'new mode ', 'rename from ', 'rename to ', 'similarity index ',
  'Binary files ', 'GIT binary patch',
];

const headerLinesWithControls = (patch) =>
  patch.split('\n').filter((l) => HEADER_PREFIXES.some((p) => l.startsWith(p)) && /[\u0000-\u001f\u007f]/.test(l));

const stanzaCount = (patch) => (patch.match(/^diff --git /gm) || []).length;

// The changed-file set, counted INDEPENDENTLY of the producer. `-z` means git hands back
// the literal name with no quoting of its own, so hostile names survive the round trip.
function changedPaths(dir) {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: dir, timeout: 30_000 });
  assert.equal(r.status, 0, `git status: ${r.stderr}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean).map((s) => s.slice(3));
}

function untrackedNames(dir) {
  const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir, timeout: 30_000 });
  assert.equal(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

function tryCreateHostile(dir, relName, content) {
  const full = `${dir}/${relName}`;
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { ok: true, full };
  } catch (err) {
    return { ok: false, reason: `${err.code ?? ''} ${err.message}`.trim() };
  }
}

// Fixture: one ORDINARY changed file (the control — a real change that must survive) plus
// one file with a hostile name. Skips LOUDLY if the filesystem refuses the name.
function withHostileFixture(t, { marker, label, name, content }, body) {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'legit.mjs'), `export const legit = ${marker};\n`);
    const rel = name;

    // FIXTURE SELF-CHECK, before anything touches the disk. A `//`, a trailing `/`, or a
    // `.`/`..` component does not survive path resolution, so the file would land SOMEWHERE
    // ELSE than the path every assertion below names — and the failure would surface much
    // later, as a control arm complaining about git. Diagnose it here, in one read.
    for (const [bad, why] of [
      ['//', 'an empty path component; POSIX collapses it'],
      ['/./', 'a `.` component; path resolution removes it'],
      ['/../', 'a `..` component; path resolution walks up out of the intended path'],
    ]) {
      assert.equal(rel.includes(bad), false, `FIXTURE DEFECT (${label}): the hostile name contains ${JSON.stringify(bad)} — ${why}, so the file cannot land at the path this test asserts about`);
    }
    assert.equal(rel.startsWith('/') || rel.endsWith('/'), false, `FIXTURE DEFECT (${label}): the hostile name must be a relative path with no trailing separator`);

    const made = tryCreateHostile(dir, rel, content ?? `export const hostileContent = ${marker};\n`);
    if (!made.ok) {
      t.skip(
        `FIXTURE REFUSED by the filesystem under ${tmpdir()}: cannot create a file named with ${label} (${made.reason}). ` +
        `NOTHING WAS PINNED by this test on this host — the header-injection guard is UNVERIFIED here, not verified-clean.`,
      );
      return;
    }
    // CONTROL ARM FIRST: the attack surface is REACHABLE on this host. `-z` hands the
    // producer the literal bytes; if git had quoted or refused the name, a clean patch
    // below would prove nothing about the guard.
    // TWO DISTINCT CAUSES if this fires, and the message must separate them: (1) the file
    // did not land at the intended path — a FIXTURE defect, caught by the self-check above
    // and by the existsSync here; (2) git did not report the name verbatim — a HOST/git
    // fact that makes the attack unreachable. Neither is a verdict about the guard.
    assert.ok(
      existsSync(made.full),
      `FIXTURE DEFECT (${label}): the file did not land at the exact intended path — a component was normalized away, so nothing below is measuring the guard`,
    );
    assert.ok(
      untrackedNames(dir).includes(rel),
      `CONTROL (${label}): \`git ls-files --others -z\` reports the hostile name VERBATIM, so the producer really does receive the raw control characters. If this fires while the file exists on disk, git is not handing the name through and the attack is unreachable on this host — report that, do not soften the pins`,
    );

    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');
    body({ dir, out, patch, rel });
  } finally {
    cleanup();
  }
}

// The structural verdict, shared by every member of the family.
function assertNoForgedAttribution(dir, patch, { marker, label }) {
  const changed = changedPaths(dir);
  assert.equal(
    changed.length, 2,
    `CONTROL: the fixture has exactly two changed files (src/legit.mjs + the ${label} file); got ${changed.length} — a different count means the fixture, not the guard, is what this test is measuring`,
  );
  assert.equal(
    stanzaCount(patch), changed.length,
    `the patch opens EXACTLY one \`diff --git\` stanza per real changed file — an extra stanza is a change attributed to a file nobody touched (${label})`,
  );
  assert.equal(
    /^diff --git a\/scripts\/hooks\/h6\.mjs/m.test(patch), false,
    `no \`diff --git\` stanza at column 0 names ${FORGED_TARGET} — that file was never touched by this fixture (${label})`,
  );
  assert.equal(
    /^\+\+\+ b\/scripts\/hooks\/h6\.mjs/m.test(patch), false,
    `no \`+++\` header at column 0 names ${FORGED_TARGET} (${label})`,
  );
  assert.deepEqual(
    headerLinesWithControls(patch), [],
    `no patch HEADER line carries a raw control character — git C-quotes them, and a raw one is precisely what lets a filename escape its own header (${label})`,
  );
  // The real change must not be buried, dropped, or duplicated behind the forgery.
  assert.equal(
    (patch.match(/^diff --git a\/src\/legit\.mjs /gm) || []).length, 1,
    `CONTROL: the genuinely changed file has exactly one stanza (${label})`,
  );
  assert.match(
    patch, new RegExp(`^\\+export const legit = ${marker};$`, 'm'),
    `CONTROL: the genuine change is present in the patch, so this really is the artifact for this snapshot (${label})`,
  );
}

function withFreshBaseClone(dir, body) {
  const cloneRoot = mkdtempSync(join(tmpdir(), 'sterling-revart-clone-'));
  try {
    const clone = join(cloneRoot, 'c');
    git(cloneRoot, ['clone', '--quiet', dir, clone]);
    git(clone, ['checkout', '--quiet', 'main']);
    body(clone);
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------------------
// PIN 9 — CONTROL ARM FOR THE WHOLE FAMILY, and it must be GREEN TODAY.
// A filename with a SPACE already takes the quoted branch legitimately. It carries no
// control characters, so nothing in the fix should change it. If this test is RED, the
// fixture or the harness is broken — NOT the guard — and every verdict in pins 10–15
// is unattributable until it is green again.
// ---------------------------------------------------------------------------
test('review artifact: PIN 9 (control, green today) — an ordinary filename with a SPACE round-trips and appears exactly once', (t) => {
  const marker = 9001;
  withHostileFixture(t, { marker, label: 'a space', name: `src/with space ${marker}.mjs` }, ({ dir, out, patch, rel }) => {
    assertNoForgedAttribution(dir, patch, { marker, label: 'a space' });

    // The header names the file. Quoted or unquoted are BOTH legal here (git itself
    // leaves spaces unquoted); pinning one form would be inventing a ruling.
    assert.ok(
      new RegExp(`^\\+\\+\\+ (b/src/with space ${marker}\\.mjs|"b/src/with space ${marker}\\.mjs")$`, 'm').test(patch),
      'the `+++` header names the spaced path with its `b/` side prefix intact',
    );
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'its content travels in the patch');

    // The round-trip oracle: whatever quoting form was chosen, git must read it back.
    withFreshBaseClone(dir, (clone) => {
      assert.ok(!existsSync(join(clone, rel)), 'CONTROL: the clone starts at base — the spaced file is absent');
      const applied = gitTry(clone, ['apply', artifactPath(dir, out)]);
      assert.equal(applied.status, 0, `the artifact applies into a fresh base checkout: ${applied.stderr}`);
      assert.equal(readFileSync(join(clone, rel), 'utf8'), `export const hostileContent = ${marker};\n`, 'the spaced filename round-trips through the patch byte for byte');
    });
  });
});
// SABOTAGE: drop the side prefix inside the quoted branch — `return \`"${path}"\`` instead
//   of `return \`"${side}/${path}"\`` → the `+++` header assertion fires (no `b/`) and
//   `git apply` exits nonzero ("unable to find file"). LOAD-BEARING GUARD: the apply
//   round-trip; the `+++` regex is the attributing detail that says WHY it failed.

// ---------------------------------------------------------------------------
// PIN 10 — THE ATTACK ITSELF: a NEWLINE in an untracked filename must not forge a stanza.
// The control-character test in the producer only SELECTS the quoted branch; the quoted
// branch then escapes backslash and quote but NOT control characters, so the literal
// newlines survive into the header and open stanzas at column 0.
// ---------------------------------------------------------------------------
test('review artifact: PIN 10 — a NEWLINE in an untracked filename forges no stanza (the attack, reproduced)', (t) => {
  const marker = 10001;
  const label = 'an embedded newline + a fabricated diff stanza';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\n') }, ({ dir, patch }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });

    // The file is still REPORTED — a fix that silently DROPS hostile names would pass
    // every forgery assertion above while hiding a real change from the reviewer, which
    // is the same failure wearing the opposite mask.
    assert.match(
      patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'),
      'the hostile-named file is still reported with its content — closing the forgery must not hide the change',
    );
  });
});
// SABOTAGE (the brief's): revert the quoted branch to escape only backslash and quote —
//   `\`"${side}/${path.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"\`` → the raw newlines
//   land in the header, `stanzaCount` reads 5 against 2 real changed files, the
//   `^diff --git a/scripts/hooks/h6.mjs` assertion matches, and the header control-char
//   scan reports the broken lines. BOTH guards carry this verdict independently.

// ---------------------------------------------------------------------------
// PIN 11a — TAB. Same class, same requirement: a raw control character in a header line.
// LOAD-BEARING GUARD: the control-char scan ALONE. A tab opens no new line, so the
// stanza count stays correct under the defect — a test relying on the count here would
// be hollow, and saying which guard decides is the only way to know that.
// ---------------------------------------------------------------------------
test('review artifact: PIN 11a — a TAB in an untracked filename never reaches a patch header raw', (t) => {
  const marker = 11001;
  const label = 'an embedded tab';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\t') }, ({ dir, patch }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'the file is still reported');
  });
});
// SABOTAGE: same revert as PIN 10 (escape only backslash and quote) → the `diff --git`
//   and `+++` header lines carry raw \t and `headerLinesWithControls` returns them; the
//   deepEqual against [] fires printing the offending header lines.

// ---------------------------------------------------------------------------
// PIN 11b — CARRIAGE RETURN. A bare \r is a line terminator to JS regex `^`, to most
// pagers and to a reviewer's terminal, so it forges a column-0 stanza just as \n does.
// BOTH guards carry this verdict.
// ---------------------------------------------------------------------------
test('review artifact: PIN 11b — a CARRIAGE RETURN in an untracked filename forges no stanza', (t) => {
  const marker = 11002;
  const label = 'an embedded carriage return';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\r') }, ({ dir, patch }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'the file is still reported');
  });
});
// SABOTAGE: same revert as PIN 10 → the raw \r reaches the header; `stanzaCount` inflates
//   (JS multiline `^` matches after \r) AND the control-char scan reports the line.

// ---------------------------------------------------------------------------
// PIN 12a — DEL (\u007f). The producer's SELECTION test already covers \u007f, which is
// exactly why it is worth pinning: selection is not escaping, and today the quoted
// branch it selects passes DEL straight through.
// LOAD-BEARING GUARD: the control-char scan alone.
// ---------------------------------------------------------------------------
test('review artifact: PIN 12a — DEL (\\u007f) in an untracked filename never reaches a patch header raw', (t) => {
  const marker = 12001;
  const label = 'an embedded DEL (\\u007f)';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\u007f') }, ({ dir, patch }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'the file is still reported');
  });
});
// SABOTAGE: same revert as PIN 10 → raw \u007f in the `diff --git`/`+++` lines; the
//   control-char deepEqual fires.

// ---------------------------------------------------------------------------
// PIN 12b — a LOW control character (\u0001).
// LOAD-BEARING GUARD: the control-char scan alone.
// ---------------------------------------------------------------------------
test('review artifact: PIN 12b — a low control character (\\u0001) in an untracked filename never reaches a patch header raw', (t) => {
  const marker = 12002;
  const label = 'an embedded \\u0001';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\u0001') }, ({ dir, patch }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'the file is still reported');
  });
});
// SABOTAGE: same revert as PIN 10 → raw \u0001 in the header lines; the control-char
//   deepEqual fires.

// ---------------------------------------------------------------------------
// PIN 13 — REGRESSION FENCE on the escaping that ALREADY works.
// A filename holding both a literal backslash and a double quote is handled correctly
// today. Adding control-character escaping must not disturb it — and the ORDER matters:
// escape the backslash first or the escapes introduced for `"` and `\n` get re-escaped.
// The `\n` in `\name` is the trap: a producer that emits it unescaped, or a reader that
// unquotes it wrongly, turns a literal backslash-n into a real newline.
// ---------------------------------------------------------------------------
test('review artifact: PIN 13 — a filename with a literal BACKSLASH and QUOTE stays correctly escaped (no regression)', (t) => {
  const marker = 13001;
  const label = 'a backslash and a quote';
  const name = `src/we"ird\\name${marker}.mjs`;                 // src/we"ird\name13001.mjs
  const expectedQuoted = `"b/src/we\\"ird\\\\name${marker}.mjs"`; // "b/src/we\"ird\\name13001.mjs"
  withHostileFixture(t, { marker, label, name }, ({ dir, out, patch, rel }) => {
    assertNoForgedAttribution(dir, patch, { marker, label });

    assert.ok(
      patch.includes(expectedQuoted),
      `the backslash and the quote stay C-escaped exactly once each — expected the header to contain ${JSON.stringify(expectedQuoted)}`,
    );
    assert.match(patch, new RegExp(`^\\+export const hostileContent = ${marker};$`, 'm'), 'its content travels in the patch');

    // Round-trip oracle: git must read the escaping back to the ORIGINAL name. A
    // double-escaped or under-escaped name applies to the wrong path, or not at all.
    withFreshBaseClone(dir, (clone) => {
      assert.ok(!existsSync(join(clone, rel)), 'CONTROL: the clone starts at base — the file is absent');
      const applied = gitTry(clone, ['apply', artifactPath(dir, out)]);
      assert.equal(applied.status, 0, `the artifact applies into a fresh base checkout: ${applied.stderr}`);
      assert.equal(readFileSync(join(clone, rel), 'utf8'), `export const hostileContent = ${marker};\n`, 'the name round-trips to the EXACT original path — not a double-escaped neighbour');
    });
  });
});
// SABOTAGE: drop `.replace(/\\/g, '\\\\')` from the quoted branch while keeping the rest
//   → the header reads `"b/src/we"ird\name13001.mjs"`, the `expectedQuoted` assertion
//   fires, and `git apply` either refuses or writes a differently-named file so the
//   round-trip equality fires. LOAD-BEARING GUARD: both — the includes() pins the exact
//   escaping, the apply proves the escaping is the one git actually reads back.

// ---------------------------------------------------------------------------
// PIN 14 — THE SHARPEST ORACLE: apply the forged-name patch into a fresh clone at base
// and prove the forged file never materialises. `git apply` is the reader whose
// interpretation actually matters; assertions about text are a proxy for this.
// The security verdict is asserted BEFORE the completeness verdict so a broken apply
// still reports the forgery result — but the two must be read TOGETHER: a forged file
// that is absent because the patch did not apply at all is not evidence of a guard,
// which is exactly what the completeness assertions immediately below it establish.
// ---------------------------------------------------------------------------
test('review artifact: PIN 14 — applying a forged-name patch into a fresh base clone never creates the forged file', (t) => {
  const marker = 14001;
  const label = 'an embedded newline + a fabricated diff stanza (apply oracle)';
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\n') }, ({ dir, out, rel }) => {
    withFreshBaseClone(dir, (clone) => {
      // CONTROL ARM FIRST: the clone is at base, so a missing forged file after the apply
      // is attributable to the patch and not to the starting state.
      assert.ok(!existsSync(join(clone, 'scripts', 'hooks', 'h6.mjs')), 'CONTROL: the clone starts at base — the forged target does not exist');
      assert.ok(!existsSync(join(clone, 'src', 'legit.mjs')), 'CONTROL: the clone starts at base — the real new file does not exist');

      const applied = gitTry(clone, ['apply', artifactPath(dir, out)]);

      // SECURITY VERDICT.
      assert.ok(
        !existsSync(join(clone, 'scripts', 'hooks', 'h6.mjs')),
        'the forged stanza did NOT materialise a file the contributor never touched — the filename could not escape its header',
      );
      // COMPLETENESS VERDICT — what makes the security verdict mean something.
      assert.equal(applied.status, 0, `the artifact is a well-formed patch git can read back: ${applied.stderr}`);
      assert.ok(existsSync(join(clone, 'src', 'legit.mjs')), 'the real change applied, so the patch was not merely inert');
      assert.ok(existsSync(join(clone, rel)), 'the hostile-named file itself round-trips to its real, un-forged path');
    });
  });
});
// SABOTAGE: same revert as PIN 10 → git apply reads the injected stanza as a genuine
//   new-file stanza and creates `scripts/hooks/h6.mjs` in the clone; the security
//   assertion fires. LOAD-BEARING GUARD: the existsSync on the forged target; the
//   status/round-trip assertions are what keep a green from being vacuous.

// ---------------------------------------------------------------------------
// PIN 15 — THE THIRD INTERPOLATION SITE: the BINARY header.
// A hostile filename reaches `diff --git`, `+++ …` AND `Binary files …`. A fix applied
// to the first two but not the third leaves the same forgery reachable through any
// untracked binary file, and no text-content assertion would ever see it.
// ---------------------------------------------------------------------------
test('review artifact: PIN 15 — a forged filename on an untracked BINARY file forges no stanza either', (t) => {
  const marker = 15001;
  const label = 'an embedded newline on a BINARY file';
  const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f, 0x10, 0x00]);
  withHostileFixture(t, { marker, label, name: forgedName(marker, '\n'), content }, ({ dir, patch }) => {
    // CONTROL ARM FIRST: this really is being handled on a binary path, so a clean result
    // is evidence about the binary header and not about the text one.
    assert.ok(
      /^(Binary files |GIT binary patch)/m.test(patch),
      'CONTROL: the producer took a BINARY path for this file — otherwise this test says nothing about the binary header',
    );
    assertNoForgedAttribution(dir, patch, { marker, label });
  });
});
// SABOTAGE: same revert as PIN 10, or leave the quoted branch fixed and hand the RAW name
//   to the `Binary files …` line only → the raw newlines land in that header, the
//   control-char scan returns it and `stanzaCount` inflates past the real changed-file
//   count. The second, narrower sabotage is the one that proves this pin is not merely a
//   duplicate of PIN 10: it is green under PIN 10's guard and red only under this one.

// ---------------------------------------------------------------------------
// PIN 16 — ONE SNAPSHOT, DIRECTLY: a HELD snapshot is immune to a tree mutation.
// PIN 4 pins the same property END TO END, through a shadow (the two views agree on an
// added-line count). That shadow cannot distinguish "one capture, two derivations" from
// "two captures that happened to agree" — the exact gap this test closes, now that
// `captureDiffSnapshot` is exported and returns a fully-materialized snapshot.
//
// THE METHOD: capture, then mutate the tree in three ways that a re-read would ALL see —
// delete a captured untracked file (a lazily-read snapshot would throw or drop it), add a
// NEW untracked file (a re-listed snapshot would grow), and append to a tracked file (a
// re-run `git diff` would show it) — then derive from the HELD snapshot again and require
// a byte-identical result. A FRESH capture is derived alongside as the control that proves
// the mutation is observable at all; without it, "the held view did not change" could
// equally mean "the mutation never happened".
//
// WHAT THIS DOES NOT COVER, plainly: `buildReviewPatch` is deliberately NOT exported (one
// in-file call site), so the PATCH view's tree-independence is not directly callable here.
// It is covered transitively: this test proves the SNAPSHOT carries materialized bytes and
// a frozen file list, so any consumer taking the snapshot inherits the property; and PIN 4
// keeps the end-to-end arm that would catch a shipped command which bypasses the seam. A
// producer that re-reads the tree while ALSO holding the snapshot stays out of reach.
// ---------------------------------------------------------------------------
test('review artifact: PIN 16 — both views derive from a HELD snapshot; mutating the tree afterwards changes nothing', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const lib = await import(pathToFileURL(join(root, 'scripts', 'lib', 'diff-json.mjs')).href);

    // CONTROL ARM FIRST (part 1): the declared seam EXISTS. A missing export must read as
    // "the seam is not there", never as an unattributable crash mid-test.
    assert.equal(typeof lib.captureDiffSnapshot, 'function', 'captureDiffSnapshot is exported from scripts/lib/diff-json.mjs — the declared seam for holding one capture');
    assert.equal(typeof lib.diffJsonFromSnapshot, 'function', 'diffJsonFromSnapshot is exported — a snapshot can be derived from without touching the tree');

    writeFileSync(join(dir, 'src', 'pre.mjs'), 'export const pre = 16001;\n');

    // The brief declares the RETURN shape ({cwd, base, tracked, untracked}) but not the
    // arity. Probe both plausible conventions rather than guessing one and producing a
    // crash-red that pins nothing; the shape assertion below is what actually binds.
    const capture = (base) => {
      const shaped = (s) => !!s && typeof s === 'object' && 'cwd' in s && 'base' in s && 'untracked' in s;
      let s = null;
      try { s = lib.captureDiffSnapshot(dir, base); } catch { s = null; }
      if (!shaped(s)) { try { s = lib.captureDiffSnapshot({ cwd: dir, base }); } catch { /* reported below */ } }
      return s;
    };

    const snap = capture('main');
    assert.ok(snap && typeof snap === 'object', 'captureDiffSnapshot returned a snapshot object');
    for (const field of ['cwd', 'base', 'tracked', 'untracked']) {
      assert.ok(field in snap, `the snapshot carries the declared field '${field}' — it is a plain captured state, not a lazy handle onto the tree`);
    }

    // CONTROL ARM (part 2): the held snapshot really does describe the pre-mutation tree.
    const before = lib.diffJsonFromSnapshot(snap);
    assert.ok(Array.isArray(before), 'diffJsonFromSnapshot returns the added-lines view');
    assert.ok(before.some((f) => f.path === 'src/pre.mjs'), 'CONTROL: the captured state includes the untracked file that existed at capture time');

    // Three mutations, each of which a RE-READ would see.
    rmSync(join(dir, 'src', 'pre.mjs'));                                    // captured untracked file deleted
    writeFileSync(join(dir, 'src', 'after.mjs'), 'export const after = 16002;\n'); // new untracked file
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nexport const removeMe = 2;\nexport const keep = 3;\nexport const appendedAfterCapture = 16003;\n');

    // CONTROL ARM (part 3): a FRESH capture DOES see all three. This is what makes the
    // held-snapshot result below evidence rather than a tautology.
    const fresh = capture('main');
    const freshJson = lib.diffJsonFromSnapshot(fresh);
    assert.ok(freshJson.some((f) => f.path === 'src/after.mjs'), 'CONTROL: a fresh capture sees the new untracked file — the mutation is observable');
    assert.ok(!freshJson.some((f) => f.path === 'src/pre.mjs'), 'CONTROL: a fresh capture no longer sees the deleted untracked file');
    assert.ok(
      freshJson.some((f) => (f.added_lines ?? []).some((l) => l.includes('appendedAfterCapture'))),
      'CONTROL: a fresh capture sees the tracked-file append',
    );

    // THE VERDICT: re-deriving from the HELD snapshot reproduces the captured state exactly.
    const after = lib.diffJsonFromSnapshot(snap);
    assert.ok(after.some((f) => f.path === 'src/pre.mjs'), 'the deleted untracked file is STILL in the held derivation — its bytes were buffered at capture, not read on demand');
    assert.ok(!after.some((f) => f.path === 'src/after.mjs'), 'the file created after capture is ABSENT — the untracked list is captured once, not re-listed per view');
    assert.ok(
      !after.some((f) => (f.added_lines ?? []).some((l) => l.includes('appendedAfterCapture'))),
      'the post-capture tracked append is ABSENT — the tracked diff is captured once, not re-run per view',
    );
    assert.deepEqual(after, before, 'the held snapshot derives byte-identically before and after the tree changed — one captured state, derived from, never re-read');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make `diffJsonFromSnapshot` re-read instead of using the capture — e.g. replace
//   its untracked branch with `readFileSync(join(snap.cwd, rel), 'utf8')` over a fresh
//   `git ls-files --others` → the `src/pre.mjs` assertion fires (ENOENT or a dropped entry)
//   and the deepEqual fires. Second, narrower sabotage: keep the buffered bytes but re-run
//   the tracked `git diff` inside the derivation → only the `appendedAfterCapture` assertion
//   fires. LOAD-BEARING: all three verdict assertions carry different halves of the
//   property; the deepEqual alone would fire for any of them but names none.

// ---------------------------------------------------------------------------
// PIN 17 — SELF-CONTAMINATION, pinned in a repo the FIXTURE did not pre-ignore.
// PIN 2c checks the same territory but passes for the FIXTURE'S reason: its `makeRepo`
// commits a `.gitignore` containing `.sterling/`, so an artifact published under that
// directory is invisible because the test arranged it, not because the producer
// guarantees it. In a consumer project without that line, the published patch becomes an
// untracked file that the NEXT selection reads as part of the change under review —
// content-addressing never converges and a reviewer is handed a patch containing a patch.
// The `.gitignore` here is EMPTY and committed, so only the producer can make this pass.
// The PROPERTY is pinned, not the mechanism: the coder may drop a `*`-only ignore file in
// the created directory, publish outside the repo, or anything else that works.
// ---------------------------------------------------------------------------
test('review artifact: PIN 17 — the published artifact is invisible to a SUBSEQUENT capture, in a repo whose .gitignore is EMPTY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-revart-noignore-'));
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
    writeFileSync(join(dir, '.gitignore'), '');   // EMPTY — nothing is ignored by the fixture
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();

    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 17001;\n');

    const out1 = selectionOk(runSelection(dir, ['--base', 'main']));
    const p1 = realpathSync(artifactPath(dir, out1));
    const repo = realpathSync(dir);
    const basename1 = p1.slice(p1.lastIndexOf(sep) + 1);

    // CONTROL ARM FIRST: this repo really does report untracked files, and its committed
    // .gitignore really is empty. Without this, "the artifact is not listed" could mean
    // "nothing is listed here" — the exact false-green the fixture is designed to avoid.
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').trim(), '', 'CONTROL: the committed .gitignore is EMPTY — nothing passes for the fixture\'s reason');
    assert.ok(changedPaths(dir).includes('src/untracked.mjs'), 'CONTROL: an ordinary untracked file IS reported here, so an unreported artifact is a property of the artifact');

    if (p1.startsWith(repo + sep)) {
      const rel = p1.slice(repo.length + 1).split(sep).join('/');
      assert.ok(
        !changedPaths(dir).includes(rel),
        `the published artifact is not part of the next capture's changed set: ${rel} — otherwise the reviewer's patch contains the previous patch and the content address never converges`,
      );
    }

    const out2 = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch2 = readArtifact(dir, out2).toString('utf8');
    assert.ok(
      !patch2.includes(basename1),
      'the second selection\'s patch does not report the first published artifact as part of the change under review',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
// SABOTAGE: remove whatever makes the artifact directory invisible (delete the `*` ignore
//   file the producer drops, or publish to `<repo>/review-diffs/<sha>.patch` with no ignore
//   at all) → `changedPaths` lists the artifact and `patch2` contains basename1; both
//   assertions fire. LOAD-BEARING: the `changedPaths` assertion is the direct verdict; the
//   `patch2` assertion is the consequence a reviewer would actually experience, and it is
//   what catches a producer that hides the file from `status` but not from its own capture.

// ---------------------------------------------------------------------------
// PIN 18a — FILE MODE: an untracked, non-executable file renders 100644 when
// `core.filemode` is false. On a DrvFs/NTFS mount every file stats as 0777, so a producer
// that reads the raw stat bit renders `100755` for ordinary source files — the patch then
// tells the reviewer a mode change happened that did not, and applying it flips real bits.
// `core.filemode false` is git's own answer to a filesystem that cannot store the bit, and
// the producer must honour it.
// ---------------------------------------------------------------------------
test('review artifact: PIN 18a — an untracked non-executable file renders `new file mode 100644` when core.filemode is false', () => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ['config', 'core.filemode', 'false']);
    writeFileSync(join(dir, 'src', 'plain18.mjs'), 'export const plain = 18001;\n');

    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    // CONTROL ARM FIRST: the file is in the patch at all, so a mode assertion below is
    // about THIS file's stanza rather than about an empty patch.
    assert.match(patch, /^\+\+\+ b\/src\/plain18\.mjs$/m, 'CONTROL: the untracked file is present in the patch');
    assert.match(patch, /^\+export const plain = 18001;$/m, 'CONTROL: its content is present');

    assert.deepEqual(
      patch.split('\n').filter((l) => l.startsWith('new file mode ')),
      ['new file mode 100644'],
      'the only new-file stanza declares mode 100644 — with core.filemode false the executable bit the filesystem reports is not the repository\'s truth',
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: render the mode from the raw stat bit — `(statSync(f).mode & 0o111) ? '100755'
//   : '100644'` ignoring core.filemode → on a DrvFs mount (and on any file created with an
//   executable bit) the filter returns ['new file mode 100755'] and the deepEqual fires.

// ---------------------------------------------------------------------------
// PIN 18b — THE OTHER DIRECTION, so 18a cannot be satisfied by hardcoding 100644.
// With `core.filemode` true and a genuinely executable file, the stanza must say 100755.
// Skipped LOUDLY (never silently) on a filesystem that cannot hold the executable bit.
// ---------------------------------------------------------------------------
test('review artifact: PIN 18b — an untracked EXECUTABLE file renders `new file mode 100755` when core.filemode is true (18a is not a hardcode)', (t) => {
  const { dir, cleanup } = makeRepo();
  try {
    git(dir, ['config', 'core.filemode', 'true']);
    const exe = join(dir, 'src', 'exec18.mjs');
    writeFileSync(exe, 'export const exe = 18002;\n');
    try { chmodSync(exe, 0o755); } catch { /* reported by the guard below */ }

    if ((statSync(exe).mode & 0o111) === 0) {
      t.skip(`FIXTURE UNAVAILABLE under ${tmpdir()}: the filesystem does not retain an executable bit, so the 100755 direction cannot be exercised here. NOTHING WAS PINNED by this test on this host — PIN 18a is therefore unguarded against a hardcoded 100644.`);
      return;
    }

    const out = selectionOk(runSelection(dir, ['--base', 'main']));
    const patch = readArtifact(dir, out).toString('utf8');

    assert.match(patch, /^\+\+\+ b\/src\/exec18\.mjs$/m, 'CONTROL: the executable file is present in the patch');
    assert.deepEqual(
      patch.split('\n').filter((l) => l.startsWith('new file mode ')),
      ['new file mode 100755'],
      'a genuinely executable file keeps mode 100755 — the filemode fix must not flatten every file to 100644',
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: hardcode `new file mode 100644` for every untracked stanza → this deepEqual
//   fires while PIN 18a stays green. That asymmetry is the whole point of this arm: 18a
//   alone is satisfied by the wrong constant.

// ---------------------------------------------------------------------------
// PIN 19 — WHAT WAS LEFT OUT TRAVELS WITH THE ARTIFACT, ON STDOUT.
// The producer may omit files it cannot represent. An omission reported only on stderr is
// an omission the reviewer never sees: stdout is the machine-read surface the dispatch
// brief is built from, and the artifact's whole claim is to be a COMPLETE account. A
// silently short patch is exactly the r-1417 failure in a new costume.
//
// ASSUMPTION FLAGGED FOR ADJUDICATION: this pins `omitted` as ALWAYS present (empty array
// when nothing was omitted). If the implementation instead omits the key when empty, this
// single assertion is the one to re-rule on — the surface question (does it reach stdout?)
// is settled; the empty-case representation was not stated in the brief.
// ---------------------------------------------------------------------------
test('review artifact: PIN 19 — review_artifact.omitted rides the stdout JSON document (never stderr-only)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 19001;\n');
    const r = runSelection(dir, ['--base', 'main']);
    const out = selectionOk(r);

    // CONTROL ARM FIRST: still one selection document carrying an artifact, so a missing
    // `omitted` below means "the field is not published", not "the command changed shape".
    assert.ok(Array.isArray(out.dispatch), 'CONTROL: stdout is still the selection document');
    assert.ok(out.review_artifact && typeof out.review_artifact === 'object', 'CONTROL: the artifact block is present');

    assert.ok(
      Array.isArray(out.review_artifact.omitted),
      'review_artifact.omitted is published as an array inside the stdout document — a reviewer\'s brief can only state what it was NOT given if the omission list reaches the machine-read surface',
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: keep the internal `omitted[]` but report it with
//   `if (omitted.length) console.error('omitted: ' + omitted.join(','))` and leave it out
//   of the JSON → `Array.isArray(...)` is false and the assertion fires. LOAD-BEARING: this
//   pin covers the SURFACE only; it says nothing about WHEN a file is omitted, and no
//   fixture here forces an omission.
