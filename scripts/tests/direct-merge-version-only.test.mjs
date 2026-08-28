// DIRECT-MERGE VERSION-ONLY POLICY EXCEPTION (spec-only pins).
//
// GOVERNING RULING (read via knowledge_get, NOT via any in-flight
// implementation diff): decision 5f330fbe-3a66-486d-adc4-baea65da0a17,
// slug h7-co-owner-trap-verification-discharge-and-version-only-exception,
// arm A2 (version-only manifest exception) + the corrected remedy text
// (both discharges named, "auto-drains" retracted).
//
// SPEC UNDER TEST, restated from the dispatch brief (this file was authored
// against that spec + the decision record, never against
// scripts/direct-merge.mjs, which was not read):
//
//   (1) For EXACTLY .claude-plugin/plugin.json and package.json: when the
//       branch's change to that path is PROVEN version-only by a blob-level
//       compare (mergeBase vs branchTip: both regular blobs, both valid
//       JSON, exactly one standalone version-field line each, the parsed
//       versions differ, and replacing that complete line with a sentinel
//       makes the remaining bytes identical — ANY other difference fails
//       closed) — open reconcile_needed debt on that path no longer
//       refuses the merge and is not minted fresh by the gate's own
//       settlement pass. Instead a distinct stderr block headed
//       "VERSION-ONLY NONBLOCKING" names each STILL-OPEN item (full id),
//       its article, the path, and the sentence "still open; not verified
//       clean; nothing closed by this exception." The item SURVIVES.
//   (2) The reconcile-refusal remedy text now names BOTH sanctioned
//       discharges — a real reconcile with `resolves`, and the
//       verification-history append (`knowledge_append(... resolves:
//       [...])`, event text containing "VERIFIED UNAFFECTED") — and warns
//       per-item when the item's file_keys extend beyond this branch's
//       diff (whole-item discharge scope, decision 5f330fbe arm A1). The
//       old "the update auto-drains its item" sentence is retracted and
//       must not appear.
//
// FIXTURE/HARNESS IDIOM cribbed from scripts/tests/direct-merge-board-nudge
// .test.mjs (makeGitProjectNoRun / runDirectMerge / envelope /
// articleWithBaseline / git helpers, duplicated here rather than imported —
// that file exports nothing and test files are not designed as modules).
// Lessons carried over: initialize the store even when a fixture does not
// need board items of its own (openStore().close() creates the sqlite file
// the gate requires to recognize an initialized project); an owning
// feature_article whose stored baseline mismatches a branch-changed owned
// file is the gate's own trigger for co-owner reconcile debt — used here
// for the ORDINARY (non-manifest) refusals in P1/P3/P4.
//
// MANIFEST CONTENT SHAPE: every manifest fixture below is hand-templated
// (never JSON.stringify(...).trim() on one line) so the "version" field
// always sits on its OWN standalone line — the byte-level proof the ruling
// describes is only satisfiable against a file shaped that way. A clean
// version bump changes exactly that one line and nothing else.
//
// VERSION-MOVE GATE (the pre-existing, separate check from decision
// ab39eca7): once a repo has both manifests, ANY branch whose diff goes
// beyond the generated projections (architecture.md, rulings.md) must move
// BOTH version fields together to the SAME new value, or the gate refuses
// for THAT reason ("did not move" / "DIVERGED") before ever reaching the
// reconcile logic under test here. Every fixture below bumps both fields
// together to isolate the reconcile-refusal / version-only-exception
// behavior from this unrelated, already-covered gate.
//
// CAUTION (anti-pattern ee89c3fd): raw child-process stderr is never
// interpolated directly into an assertion message expected to fail —
// always flattened via oneLine() first.
//
// INTERPRETIVE NOTE ON P5: the ruling states the refusal "warns when the
// item's file_keys extend beyond the branch diff" but (unlike the
// version-only block, whose header/sentence are given verbatim in the
// brief) does not hand down a literal warning string for this case. P5
// pins the two facts the spec text DOES commit to unambiguously — the
// out-of-diff path is named, and the warning is textually distinguishable
// (a scope/breadth-flavored token) from a plain per-item listing — via a
// deliberately-constructed pre-existing grouped item (feature-linked
// article owning two files, only one touched by the branch), which is a
// reliable, non-implementation-anchored way to reach that shape without
// depending on the gate's own minting/grouping to produce it. See the
// test body for the exact assertion and its named uncertainty.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-08-28T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function sha256hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Flatten any child-process stream before it goes into an assertion message
 * that might fail — anti-pattern ee89c3fd. */
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

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

function articleWithBaseline(store, slug, files, at = NOW) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(
      files.map((f) => [f.path, f.baseline !== undefined ? f.baseline : sha256hex(f.content)])
    ),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

/** A pre-existing OPEN reconcile_needed system-source item, the shape a
 * settlement pass (H10 Stop, or an earlier gate run) would have minted.
 * Manually created here — the gate's version-only exception is defined to
 * skip ITS OWN minting for a proven-version-only path, so the report can
 * only ever be naming debt that already exists in the store. */
function reconcileItem(store, { text, file_keys, article }) {
  return store.create({
    ...envelope('todo'),
    text,
    source: 'system',
    file_keys,
    feature_link: article.id,
    system_reason: 'reconcile_needed',
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function makeGitProjectNoRun(prefix = 'sterling-dm-vo-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

function openStore(dir) {
  return new SterlingStore(join(dir, '.sterling', 'sterling.db'));
}

/** Hand-templated manifest text: "version" always sits on its own standalone
 * line, matching the byte-level version-only proof's precondition. extraLine,
 * when given, is inserted as an additional standalone line — this is what
 * makes a diff NOT version-only (more than one line changed/added). */
function manifestContent(version, extraLine) {
  const lines = ['{', '  "name": "fixture",'];
  lines.push(extraLine ? `  "version": "${version}",` : `  "version": "${version}"`);
  if (extraLine) lines.push(`  ${extraLine}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

function crlf(s) {
  return s.replace(/\n/g, '\r\n');
}

function writeManifests(dir, pluginContent, pkgContent) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), pluginContent);
  writeFileSync(join(dir, 'package.json'), pkgContent);
}

// =========================================================================
// P1 [control, placed first] — fail-closed when package.json's change is
// version PLUS an unrelated added line (not version-only).
// =========================================================================

test('P1 [control]: branch bumps both manifest versions AND adds an npm script line to package.json; an article owns package.json with a stale baseline — the gate still REFUSES with the reconcile message, proving the version-only proof does not pass on a diff wider than the version line — sabotage: a version-only proof that only checks the version VALUES differ (never the surrounding bytes), which must flip this red (merge succeeds, no reconcile refusal, despite the added scripts line)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    writeManifests(dir, basePlugin, basePkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base']);

    const store = openStore(dir);
    articleWithBaseline(store, 'feat-p1-owns-pkg', [{ path: 'package.json', content: basePkg }]);
    store.close();

    git(dir, ['checkout', '-b', 'feat/p1-nonversion-change']);
    const newPkg = manifestContent('0.1.1', '"scripts": { "build": "true" }');
    const newPlugin = manifestContent('0.1.1');
    writeManifests(dir, newPlugin, newPkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump both + add a script line to package.json']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a non-version-only package.json change with a co-owning stale-baseline article must refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile before merging/, 'the refusal is attributed to the ordinary reconcile-debt path, not the version-move gate');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P2 [positive] — a version-only manifest change is nonblocking, loud, and
// the pre-existing item survives.
// =========================================================================

test('P2 [positive]: branch changes both manifests version-only; an article owns package.json and a pre-existing OPEN reconcile_needed item already names it — merge SUCCEEDS, stderr carries "VERSION-ONLY NONBLOCKING", the item\'s full id, and "nothing closed by this exception", and after the merge the item is still open in the store — sabotage: silently dropping the debt or closing the item as part of the exception, which must flip this red (the post-merge store.get(item.id) lookup returns nothing, or its system_reason no longer reads reconcile_needed)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    writeManifests(dir, basePlugin, basePkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base']);

    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-p2-owns-pkg', [{ path: 'package.json', content: basePkg }]);
    const item = reconcileItem(store, {
      text: 'package.json reconcile owed against feat-p2-owns-pkg',
      file_keys: ['package.json'],
      article,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/p2-version-only']);
    const newPkg = manifestContent('0.1.1');
    const newPlugin = manifestContent('0.1.1');
    writeManifests(dir, newPlugin, newPkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump both manifests, version-only']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a version-only manifest change must not block the merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /VERSION-ONLY NONBLOCKING/, 'the distinct nonblocking report header must appear');
    assert.ok(r.stderr.includes(item.id), 'the report names the item by its FULL id');
    assert.ok(r.stderr.includes('package.json'), 'the report names the path');
    assert.ok(r.stderr.includes('feat-p2-owns-pkg'), 'the report names the owning article');
    assert.match(r.stderr, /still open; not verified clean; nothing closed by this exception/, 'the exact disclosure sentence must appear');

    const reopened = openStore(dir);
    const survived = reopened.get(item.id);
    reopened.close();
    assert.ok(survived, 'the reconcile_needed item must survive the merge — nothing closed it');
    assert.equal(survived.system_reason, 'reconcile_needed', 'the surviving item is still an open reconcile_needed item, not silently repurposed');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P3 [fail-closed on masquerade] — wholesale LF->CRLF conversion is not
// version-only even though the version line itself also moved.
// =========================================================================

test('P3 [masquerade]: branch bumps both manifest versions AND converts package.json wholesale from LF to CRLF line endings; an article owns package.json with a stale baseline — the gate REFUSES, proving the proof is exact-byte, not whitespace/line-ending-insensitive — sabotage: a whitespace-insensitive or JSON-value-level comparison (parsing both sides and comparing structured values, or normalizing line endings before the byte compare), which must flip this red (merge succeeds despite every line in the file having changed bytes)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    writeManifests(dir, basePlugin, basePkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base']);

    const store = openStore(dir);
    articleWithBaseline(store, 'feat-p3-owns-pkg', [{ path: 'package.json', content: basePkg }]);
    store.close();

    git(dir, ['checkout', '-b', 'feat/p3-crlf-masquerade']);
    const bumpedLf = manifestContent('0.1.1');
    writeManifests(dir, manifestContent('0.1.1'), crlf(bumpedLf));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump both + convert package.json to CRLF wholesale']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a wholesale CRLF conversion alongside a version bump must still refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile before merging/, 'the refusal is attributed to the ordinary reconcile-debt path, not the version-move gate');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P4 [remedy names both discharges] — a plain co-owner refusal (non-manifest
// file) prints both sanctioned discharge routes and never the old sentence.
// =========================================================================

test('P4 [remedy]: manifests are bumped version-only (excluded, non-blocking) but a non-manifest owned file (src/thing.mjs) is genuinely changed with a stale baseline — the refusal names BOTH discharges ("resolves" and a verification-append mention matching /VERIFIED UNAFFECTED/ and /knowledge_append/) and never contains "auto-drains" — sabotage: reverting to the old one-route remedy text, which must flip this red (the verification-discharge mention or "resolves" text is absent, or "auto-drains" reappears)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    const baseThing = 'export const thing = 1;\n';
    writeManifests(dir, basePlugin, basePkg);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.mjs'), baseThing);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base + src/thing.mjs']);

    const store = openStore(dir);
    articleWithBaseline(store, 'feat-p4-owns-thing', [{ path: 'src/thing.mjs', content: baseThing }]);
    store.close();

    git(dir, ['checkout', '-b', 'feat/p4-real-co-owner']);
    writeManifests(dir, manifestContent('0.1.1'), manifestContent('0.1.1'));
    writeFileSync(join(dir, 'src', 'thing.mjs'), 'export const thing = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump manifests version-only + change the real co-owned file']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a genuine co-owner drift on a non-manifest file must still refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes('resolves'), 'the remedy names the real-reconcile discharge (resolves: [...])');
    assert.match(r.stderr, /VERIFIED UNAFFECTED/, 'the remedy names the verification-discharge event text');
    assert.match(r.stderr, /knowledge_append/, 'the remedy names the verification-discharge call shape');
    assert.doesNotMatch(r.stderr, /auto-drains/, 'the retracted false claim ("the update auto-drains its item") must not reappear');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P5 [whole-item warning] — a grouped item whose file_keys extend beyond
// this branch's diff is warned about, not silently discharged.
// =========================================================================

test("P5 [whole-item warning]: a pre-existing reconcile_needed item groups two files owned by one article — only src/thing.mjs is touched by this branch, src/other-unwatched.mjs is not — the refusal names the item and the out-of-diff path (whole-item discharge scope) — sabotage: computing the remedy from only the immediately-blocking path and never inspecting the item's full file_keys set, which must flip this red (the out-of-diff path never appears in stderr at all)", () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    const baseThing = 'export const thing = 1;\n';
    const baseOther = 'export const other = 1;\n';
    writeManifests(dir, basePlugin, basePkg);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.mjs'), baseThing);
    writeFileSync(join(dir, 'src', 'other-unwatched.mjs'), baseOther);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base + two article-owned files']);

    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-p5-owns-two', [
      { path: 'src/thing.mjs', content: baseThing },
      { path: 'src/other-unwatched.mjs', content: baseOther },
    ]);
    const item = reconcileItem(store, {
      text: 'grouped reconcile across src/thing.mjs and src/other-unwatched.mjs',
      file_keys: ['src/thing.mjs', 'src/other-unwatched.mjs'],
      article,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/p5-partial-diff']);
    writeManifests(dir, manifestContent('0.1.1'), manifestContent('0.1.1'));
    writeFileSync(join(dir, 'src', 'thing.mjs'), 'export const thing = 2;\n');
    // src/other-unwatched.mjs is deliberately left untouched by this branch.
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump manifests version-only + change only src/thing.mjs']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `live drift on src/thing.mjs must refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(item.id), 'the refusal names the grouped item by its FULL id');
    // Reviewer-tightened (round 1 note 5): a bare includes() on the path was
    // HOLLOW — the per-item listing already prints every file_key, so the
    // named sabotage (never inspecting the full file_keys set) left it green.
    // Bind the NOTE line to the item id AND the out-of-diff path on ONE line,
    // so only the whole-item warning itself can satisfy this pin.
    assert.match(
      r.stderr,
      new RegExp(`NOTE \\(${item.id}\\)[^\\n]*src/other-unwatched\\.mjs`),
      'the whole-item NOTE itself (not the plain listing) must name the out-of-diff path the item also covers',
    );
    assert.match(r.stderr, /beyond|whole-item|unscoped|extend/i, 'the remedy must textually distinguish the unscoped file_keys from a plain per-item listing');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P6 [fail-closed on mode masquerade] — an executable-bit flip is not
// version-only even though the content-level diff is a clean version bump.
// =========================================================================
//
// Added at outside-family round-2 review: newly-fixed fail-closed hole in
// the version-only proof. `git update-index --chmod=+x` sets the mode in
// the INDEX directly (committed as blob mode 100755 vs the base's 100644)
// regardless of whether the host filesystem honors chmod, so this pin is
// filesystem-independent.

test('P6 [mode masquerade]: branch bumps both manifest versions AND flips package.json\'s executable bit via `git update-index --chmod=+x` before committing; an article owns package.json with a stale baseline — the gate REFUSES, proving the proof requires IDENTICAL modes at both endpoints, not just identical content bytes outside the version line — sabotage: a proof that accepts any mix of 100644/100755 without requiring mode equality, which must flip this red (merge succeeds despite the mode change)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    // fileMode=false: git ignores working-tree mode bits (so the tree stays
    // clean after `update-index --chmod` below, instead of tripping the
    // gate's dirty-tree check before the version-only proof ever runs),
    // while `git ls-tree` still reports the COMMITTED blob mode per commit —
    // exactly the mismatch this pin needs the proof to see and refuse on.
    git(dir, ['config', 'core.fileMode', 'false']);
    const basePkg = manifestContent('0.1.0');
    const basePlugin = manifestContent('0.1.0');
    writeManifests(dir, basePlugin, basePkg);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base']);

    const store = openStore(dir);
    articleWithBaseline(store, 'feat-p6-owns-pkg', [{ path: 'package.json', content: basePkg }]);
    store.close();

    git(dir, ['checkout', '-b', 'feat/p6-mode-masquerade']);
    writeManifests(dir, manifestContent('0.1.1'), manifestContent('0.1.1'));
    git(dir, ['add', '-A']);
    git(dir, ['update-index', '--chmod=+x', 'package.json']);
    git(dir, ['commit', '-m', 'bump both manifests version-only + flip package.json executable bit']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a mode-only change alongside a clean version bump must still refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile before merging/, 'the refusal is attributed to the ordinary reconcile-debt path, not the version-move gate');
  } finally {
    cleanup();
  }
});

// =========================================================================
// P7 [fail-closed on invalid-UTF-8 masquerade] — two DIFFERENT invalid byte
// sequences that lossy-decode to the same replacement character must not
// be treated as identical bytes.
// =========================================================================
//
// Added at outside-family round-2 review: newly-fixed fail-closed hole.
// Base package.json embeds the raw, standalone-invalid UTF-8 byte 0xC3
// (a lead byte for a 2-byte sequence with no continuation byte) inside a
// string value; the branch tip swaps it for a DIFFERENT invalid byte, 0xE2
// (a lead byte for a 3-byte sequence, also missing its continuation), and
// bumps both manifest versions. Both bytes decode, under LOSSY UTF-8
// decoding, to the same U+FFFD replacement character — a proof built on
// Buffer#toString('utf8') would see identical text and wrongly call this
// version-only. Written via Buffer, never a JS string literal, so the
// invalid byte is exact and not re-encoded by the write path. Per the
// brief: git may classify this file as binary rather than text — either
// refusal path (binary-blob check or fatal-decode check) satisfies this
// pin, so only the refusal + reconcile message are asserted.

test('P7 [invalid-UTF-8 masquerade]: branch bumps both manifest versions AND swaps one non-version byte in package.json for a DIFFERENT invalid-UTF-8 byte that lossy-decodes to the same replacement character; an article owns package.json with a stale baseline — the gate REFUSES, proving the proof does not rely on lossy UTF-8 decoding — sabotage: lossy Buffer.toString(\'utf8\') decoding that collapses the two distinct invalid bytes into the same U+FFFD text, which must flip this red (merge succeeds despite the bytes genuinely differing)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const basePkgBytes = Buffer.concat([
      Buffer.from('{\n  "name": "fixture",\n  "version": "0.1.0",\n  "note": "', 'utf8'),
      Buffer.from([0xc3]),
      Buffer.from('"\n}\n', 'utf8'),
    ]);
    const basePlugin = manifestContent('0.1.0');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), basePlugin);
    writeFileSync(join(dir, 'package.json'), basePkgBytes);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base with an invalid-UTF-8 byte in package.json']);

    const store = openStore(dir);
    articleWithBaseline(store, 'feat-p7-owns-pkg', [{ path: 'package.json', content: basePkgBytes }]);
    store.close();

    git(dir, ['checkout', '-b', 'feat/p7-utf8-masquerade']);
    const branchPkgBytes = Buffer.concat([
      Buffer.from('{\n  "name": "fixture",\n  "version": "0.1.1",\n  "note": "', 'utf8'),
      Buffer.from([0xe2]),
      Buffer.from('"\n}\n', 'utf8'),
    ]);
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), manifestContent('0.1.1'));
    writeFileSync(join(dir, 'package.json'), branchPkgBytes);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump both manifests version-only + swap one invalid UTF-8 byte for another']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `two distinct invalid-UTF-8 bytes that lossy-decode identically must still refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile before merging/, 'the refusal is attributed to the ordinary reconcile-debt path, not the version-move gate');
  } finally {
    cleanup();
  }
});
