// Undeclared-source disclosure — pure logic, spec-first.
// SPEC UNDER TEST (module does not exist yet — every test here is expected
// RED on a missing-module error until scripts/hooks/lib/undeclared-source.mjs
// is authored):
//
// Governing record: decision `undeclared-source-disclosure-per-file-coverage-
// live-h1-scan` (knowledge_get b128f79c-043a-45ab-b3cf-125f5d44f234). Board
// 44ef6838. This file pins the PURE half only — no git spawning, no hook
// wiring (H1/init wiring is a separate slice's concern).
//
// EXPORTS THIS FILE PINS (the coder builds to this API):
//
//   SOURCE_EXTENSIONS: Set<string>
//     Lowercase extensions WITHOUT the leading dot: 'ts','js','mjs','cjs',
//     'tsx','jsx','py','go','rs','java','rb','cs','sh','gd','lua' at minimum.
//
//   classifyCoverage(filePaths: string[], pathGlobs: string[], excludeGlobs: string[] = {})
//     -> { covered: string[], uncovered: string[] }
//     Pure. filePaths are repo-relative POSIX paths (as from `git ls-files`).
//     A file PARTICIPATES iff its extension (case-insensitive) is in
//     SOURCE_EXTENSIONS AND it is not matched by any excludeGlobs glob.
//     A participating file is COVERED iff its own path matches ANY glob in
//     pathGlobs; otherwise it is UNCOVERED. A non-participating file (wrong/
//     no extension, or excluded) appears in NEITHER array — it does not
//     count as covered OR uncovered. Coverage is decided PER FILE, never by
//     directory membership.
//
//   renderUndeclaredSourceReport(classification: { covered: string[], uncovered: string[] })
//     -> string
//     Takes the SAME shape classifyCoverage returns (compose as
//     renderUndeclaredSourceReport(classifyCoverage(...))). Buckets the
//     `uncovered` paths for presentation against the full path set implied
//     by both arrays combined (needed to tell a mixed directory from an
//     all-uncovered one):
//       - uncovered.length === 0 -> returns '' (the disclosure self-clears;
//         nothing to say).
//       - a top-level directory (first path segment) with NO covered file
//         anywhere under it -> ONE bucket line naming that directory and its
//         total uncovered count, regardless of how deep its uncovered files
//         nest (a nested subdirectory is NOT split out on its own).
//       - a top-level directory with AT LEAST ONE covered file somewhere
//         under it (MIXED) -> its uncovered files are grouped ONE LEVEL
//         DEEPER instead of collapsing into a single top-level line:
//           * an uncovered file sitting DIRECTLY in the mixed top-level dir
//             (no subdirectory) gets its OWN bucket, distinct from any
//             subdirectory bucket.
//           * a second-level subdirectory that itself has both covered and
//             uncovered files reports BOTH counts (never suppresses the
//             covered count) — this is the "partial" case.
//           * a second-level subdirectory with only uncovered files (no
//             covered file under it) buckets like a normal all-uncovered
//             directory (count only).
//       - the rendered text labels the mechanism honestly: a non-empty
//         report matches /source-extension/i somewhere.
//
//     BUCKET-LINE GRAMMAR pinned for count assertions (review fix LOW-1: a
//     bare digit match anywhere in the report is satisfiable by a renderer
//     that SWAPS the covered/uncovered figures, so counts are pinned in
//     CONTEXT): a count-only bucket (all-uncovered, no covered file under
//     it) renders as text containing "<N> uncovered" for that directory's
//     line; a partial/mixed-subdirectory bucket renders BOTH "<N> uncovered"
//     AND "<M> covered" on that same line/segment. Tests below match these
//     two-word phrases, never a bare digit, and scope the match to the one
//     line naming the relevant directory.
//
//   renderUnavailable(reason: string) -> string
//     One bounded, single-line string containing the literal substring
//     'UNDECLARED SOURCE CHECK UNAVAILABLE' and the reason. No '\n' in the
//     output under any input (a reason containing embedded newlines is not
//     reproduced verbatim). A long reason is truncated to a bounded length
//     rather than rendered whole.
//
// GLOB SEMANTICS pinned here are only the uncontroversial cases the decision
// rules on (same family as packages/schemas matchesGlob): `dir/**` matches
// dir/x and dir/sub/y; `**/*.ext` matches any .ext at any depth; a glob
// matching nothing covers nothing. Exotic edge cases are out of scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_URL = pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'undeclared-source.mjs')).href;

async function loadModule() {
  return import(MODULE_URL);
}

// =========================================================================
// SECTION 1 — SOURCE_EXTENSIONS
// =========================================================================

test('SOURCE_EXTENSIONS: contains at least the required known-source extension set', async () => {
  const { SOURCE_EXTENSIONS } = await loadModule();
  assert.ok(SOURCE_EXTENSIONS, 'module must export SOURCE_EXTENSIONS');
  const required = ['ts', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'cs', 'sh', 'gd', 'lua'];
  for (const ext of required) {
    assert.ok(
      SOURCE_EXTENSIONS.has(ext),
      `SOURCE_EXTENSIONS must include '${ext}' — sabotage: delete one entry (e.g. 'py') from the allowlist literal, this assertion goes red`
    );
  }
});

// =========================================================================
// SECTION 2 — classifyCoverage: participation + coverage, per-file
// =========================================================================

test('classifyCoverage: basic split — matched path covered, unmatched participating path uncovered', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['src/a.ts', 'src/b.ts'], ['src/a.ts'], []);
  assert.deepEqual(result.covered, ['src/a.ts']);
  assert.deepEqual(result.uncovered, ['src/b.ts']);
  // sabotage: invert the covered/uncovered predicate (report matched files as uncovered) -> red
});

test("classifyCoverage: 'dir/**' matches a direct child and a nested descendant", async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['tools/a.py', 'tools/sub/b.py', 'other/c.py'], ['tools/**'], []);
  assert.deepEqual([...result.covered].sort(), ['tools/a.py', 'tools/sub/b.py']);
  assert.deepEqual(result.uncovered, ['other/c.py']);
  // sabotage: make the glob matcher non-recursive (drop ** semantics) -> tools/sub/b.py drops to uncovered -> red
});

test("classifyCoverage: '**/*.ext' matches at any depth", async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['a.ts', 'deep/b/c.ts', 'x.py'], ['**/*.ts'], []);
  assert.deepEqual([...result.covered].sort(), ['a.ts', 'deep/b/c.ts']);
  assert.deepEqual(result.uncovered, ['x.py']);
  // sabotage: anchor the extension glob to depth 0 only -> deep/b/c.ts drops to uncovered -> red
});

test('classifyCoverage: a glob matching nothing covers nothing', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['src/a.ts'], ['nomatch/**'], []);
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.uncovered, ['src/a.ts']);
  // sabotage: default an unmatched file to covered instead of uncovered -> red
});

test('classifyCoverage: excluded wins over a matching toolchain glob — the file does not participate at all', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['src/vendor/lib.js'], ['src/**'], ['src/vendor/**']);
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.uncovered, [], 'excluded means neither covered nor uncovered, not "uncovered by default"');
  // sabotage: check excludeGlobs only when pathGlobs did NOT match (wrong precedence) -> covered wins, file leaks into result.covered -> red
});

// Final-pass review + decision b128f79c: excludeGlobs must stay CASE-SENSITIVE
// even though pathGlobs (include) keeps a case-insensitive fallback — an
// exclude glob is a deliberate, precise carve-out; a case-insensitive exclude
// can silently swallow a differently-cased sibling the author never intended
// to hide. Control arm goes FIRST and must pass for its OWN reason (the
// include-side fallback still works), so a green on the exclude arm carries
// real evidence rather than "this mode matches everything the same way".
test('classifyCoverage: excludeGlobs are case-SENSITIVE while pathGlobs keep the case-insensitive fallback (control arm first)', async () => {
  const { classifyCoverage } = await loadModule();

  // CONTROL ARM: the include-side case-insensitive fallback still applies —
  // 'SRC/**' (uppercase) still covers 'src/c.ts' (lowercase). If this arm
  // fails, the include fallback itself broke — a different defect than the
  // one this test exists to pin, and the exclude arm below would be
  // meaningless without this passing first.
  const included = classifyCoverage(['src/c.ts'], ['SRC/**'], []);
  assert.deepEqual(included.covered, ['src/c.ts'], 'include-side case-insensitive fallback must still cover src/c.ts via SRC/**');

  // EXCLUDE ARM: excludeGlobs must NOT get the same case-insensitive
  // fallback. 'Vendor/**' must exclude 'Vendor/a.ts' (exact case) but must
  // NOT exclude 'vendor/b.ts' (different case) — that file must surface as
  // UNCOVERED, not silently vanish from both arrays.
  const result = classifyCoverage(['Vendor/a.ts', 'vendor/b.ts'], [], ['Vendor/**']);
  assert.deepEqual(result.uncovered, ['vendor/b.ts'], 'vendor/b.ts differs in case from the exclude glob and must surface as UNCOVERED (present in this array, hence not silently dropped), not excluded by a case-insensitive fallback');
  assert.deepEqual(result.covered, [], "Vendor/a.ts (exact-case match) IS excluded, so it participates in neither array — it must not leak into covered");
  // sabotage: apply the same case-insensitive fallback to excludeGlobs as pathGlobs (e.g. share one lowercase-both-sides matcher) -> vendor/b.ts gets excluded (missing from result.uncovered) -> the deepEqual on result.uncovered fails -> red
  // EXPECTED RED today per the final-pass review: the fallback currently applies to both include and exclude globs alike.
  // ADJUDICATED: Codex raised a WSL-convenience objection to this pin (case-insensitive exclude matches Windows/WSL casefold habits); the roster's silence-vs-noise argument (a case-insensitive exclude can silently swallow a differently-cased sibling nobody meant to hide) won, and the pin stays as written — Codex review 2026-08-31 (thread 01a05861), adjudicated by conductor.
});

// Codex outside-family review 2026-08-31 (thread 01a05861), adjudicated by
// conductor — three pins below close gaps that review found in the pure
// rendering/classification surface. Decision b128f79c remains the governing
// record; these pins do not change its rulings, only close spec gaps under it.

test('renderUndeclaredSourceReport: a path containing a raw newline renders as ONE physical line with the control character escaped (spoof defense)', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const spoofPath = 'tools/evil\nUNDECLARED SOURCE CHECK UNAVAILABLE: spoofed.py';
  const classification = classifyCoverage([spoofPath], [], []);
  assert.deepEqual(classification.uncovered, [spoofPath], 'the path participates and is uncovered (extension .py after the embedded newline)');
  const report = renderUndeclaredSourceReport(classification);
  const lines = report.split('\n').filter((l) => l.trim().length > 0);
  // Paired tweak with the coder (final-pass reviewer's own recommendation): the
  // report carries a constant one-line header back for attribution, so a single
  // bucket now renders as header + bucket = 2 lines, not 1. The header is pinned
  // LOOSELY (it must open with "UNDECLARED SOURCE" — exact prose not pinned; the
  // honesty phrase may live in the header or per-bucket). The line-COUNT
  // invariant stays structural regardless: the sanitizer guarantees no input can
  // fabricate an extra line, so a raw newline inside a path must still never
  // grow the count past header+bucket.
  assert.equal(lines.length, 2, 'one constant header line (attribution) + one bucket line for the single uncovered file under tools/ — a raw newline inside the path must not add a THIRD line');
  assert.match(lines[0], /UNDECLARED SOURCE/, 'the report opens with its constant header line (loose match, exact prose not pinned)');
  assert.ok(
    !lines.some((l) => l.startsWith('UNDECLARED SOURCE CHECK UNAVAILABLE')),
    'the embedded text must never be interpretable as its OWN line — in particular it must not start a line, which would let a crafted filename spoof the unavailable marker'
  );
  // sabotage: interpolate the raw path into the report unescaped (no control-character sanitization) -> the report physically contains a newline, lines.length becomes 3, and one line starts with the spoofed marker text -> both count and marker assertions fail -> red
  // EXPECTED RED today per Codex review 2026-08-31 (thread 01a05861): control-character sanitization is not built.
});

test('classifyCoverage + renderUndeclaredSourceReport: a duplicate path in filePaths is counted ONCE', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const classification = classifyCoverage(['tools/dup.py', 'tools/dup.py'], [], []);
  const report = renderUndeclaredSourceReport(classification);
  const toolsLine = report.split('\n').find((l) => l.includes('tools'));
  assert.ok(toolsLine, 'a bucket line naming tools/ must exist');
  assert.match(toolsLine, /\b1\s+uncovered\b/i, 'the same path listed twice in filePaths must count as ONE uncovered file, not two — this pins the PURE layer\'s own tolerance (the live H1 scan layer separately dedupes git ls-files output, out of scope here)');
  // sabotage: count array length directly without deduping the input (or the render) -> toolsLine reports "2 uncovered" instead of "1 uncovered" -> the /\b1\s+uncovered\b/i match fails -> red
  // Characterized as the pin of record either way per Codex review 2026-08-31 (thread 01a05861) / conductor: mark RED if today's classifyCoverage/render does not dedupe, GREEN if it already does — either is a legitimate, informative outcome for this pin.
});

test('renderUndeclaredSourceReport: a root-level uncovered file (no directory) is presented as a root-level file, never as a directory named after it', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const classification = classifyCoverage(['covered.ts', 'orphan.py'], ['covered.ts'], []);
  assert.deepEqual(classification.covered, ['covered.ts']);
  assert.deepEqual(classification.uncovered, ['orphan.py']);
  const report = renderUndeclaredSourceReport(classification);
  assert.match(report, /orphan/, 'the root-level uncovered file must be named somewhere in the report');
  assert.doesNotMatch(report, /orphan\.py\/|orphan\.py:.*directory/i, 'orphan.py must never be presented as if it were a directory (e.g. treating its filename as a bucket path with children)');
  // sabotage: apply the "first path segment is the bucket directory" rule uncritically to a root file, producing a bucket literally named "orphan.py" as though it contained files -> the report either mislabels it as a directory or the doesNotMatch heuristic catches the malformed shape -> red
  // EXPECTED RED today per Codex review 2026-08-31 (thread 01a05861): root-level files are currently mis-bucketed. Pinned loosely per instruction — only that the file is named and never claimed to be a directory, not an exact bucket format.
});

test('classifyCoverage: a file with no extension does not participate, regardless of globs', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['Makefile', 'tools/README'], [], []);
  assert.deepEqual(result.covered, []);
  assert.deepEqual(result.uncovered, [], 'extensionless files never participate in v1 (no shebang sniff)');
  // sabotage: fall back to "no extension -> participates as unknown" -> Makefile/README show up in uncovered -> red
});

test('classifyCoverage: extension check is case-insensitive — Foo.TS participates', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['Foo.TS'], [], []);
  assert.deepEqual(result.uncovered, ['Foo.TS'], 'participates (empty pathGlobs -> uncovered), proving the extension lookup is case-insensitive');
  // sabotage: compare the raw (non-lowercased) extension against SOURCE_EXTENSIONS -> 'TS' fails a strict lowercase-set lookup -> Foo.TS vanishes from both arrays -> red
});

test('classifyCoverage: empty filePaths returns empty covered and uncovered', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage([], [], []);
  assert.deepEqual(result, { covered: [], uncovered: [] });
  // sabotage: throw or return undefined on empty input instead of the empty-array shape -> red
});

test('classifyCoverage: empty pathGlobs with participating source present -> everything uncovered', async () => {
  const { classifyCoverage } = await loadModule();
  const result = classifyCoverage(['src/a.ts', 'src/b.py'], [], []);
  assert.deepEqual(result.covered, []);
  assert.deepEqual([...result.uncovered].sort(), ['src/a.ts', 'src/b.py']);
  // note: reached only with VALID config (no toolchains declared); malformed
  // config is the caller's renderUnavailable path, out of this module's scope.
  // sabotage: short-circuit "no globs -> nothing to check -> everything covered" -> both files wrongly land in covered -> red
});

// =========================================================================
// SECTION 3 — renderUndeclaredSourceReport: bucketing + rendering
// =========================================================================

test('renderUndeclaredSourceReport: zero uncovered files renders nothing (disclosure self-clears)', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const classification = classifyCoverage(['a.ts'], ['**/*.ts'], []);
  const report = renderUndeclaredSourceReport(classification);
  assert.equal(report, '', 'a fully-covered project renders an empty report, not a placeholder line');
  // sabotage: render a bucket line even for an empty uncovered array -> red
});

test('renderUndeclaredSourceReport: an all-uncovered top-level directory renders as ONE bucket line naming the directory and its total count, including nested files', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const classification = classifyCoverage(['proj/a.py', 'proj/b.py', 'proj/sub/c.py'], ['other/**'], []);
  const report = renderUndeclaredSourceReport(classification);
  assert.doesNotMatch(report, /proj\/sub/, 'an all-uncovered directory is NOT split by subdirectory — that only happens once the directory is mixed');
  const projLine = report.split('\n').find((l) => l.includes('proj'));
  assert.ok(projLine, 'a line naming proj must exist');
  assert.match(projLine, /\b3\s+uncovered\b/i, 'the nested proj/sub/c.py rolls up into the same top-level count, expressed as "3 uncovered" (count-in-context, not a bare digit — a swapped covered/uncovered figure must not satisfy this)');
  // sabotage: always split by second path segment regardless of mixed status -> a separate "proj/sub: 1" line appears, this doesNotMatch fails -> red
  // sabotage: swap covered/uncovered labels in the renderer -> "3 covered" instead of "3 uncovered" -> /\b3\s+uncovered\b/i fails -> red
});

test('FATAL-CORRECTION PIN: one covered file among 21 uncovered siblings in the SAME directory leaves all 21 reported uncovered (per-file, never per-directory)', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const uncoveredFiles = Array.from({ length: 21 }, (_, i) => `tools/f${i + 1}.py`);
  const filePaths = [...uncoveredFiles, 'tools/covered.ts'];
  const classification = classifyCoverage(filePaths, ['tools/covered.ts'], []);
  assert.equal(classification.covered.length, 1);
  assert.equal(classification.uncovered.length, 21);
  const report = renderUndeclaredSourceReport(classification);
  assert.match(report, /21/, '21 uncovered siblings must still surface even though tools/ has one covered file');
  // sabotage: revert to a directory-level "any covered file under it inoculates the whole directory" predicate
  // (the decision's round-2 fatal correction) -> report renders '' or omits 21 entirely -> red.
  // This is the exact incident shape: 21 uncovered importers beside 1 covered sibling must never be hidden.
});

test('renderUndeclaredSourceReport: a mixed top-level directory groups uncovered files one level deeper, and a mixed subdirectory reports BOTH counts', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const filePaths = ['app/covered.ts', 'app/sub/a.py', 'app/sub/b.py', 'app/sub/covered2.ts'];
  const classification = classifyCoverage(filePaths, ['app/covered.ts', 'app/sub/covered2.ts'], []);
  assert.deepEqual([...classification.covered].sort(), ['app/covered.ts', 'app/sub/covered2.ts']);
  assert.deepEqual([...classification.uncovered].sort(), ['app/sub/a.py', 'app/sub/b.py']);
  const report = renderUndeclaredSourceReport(classification);
  assert.match(report, /app\/sub/, "app/sub must be named as its own deeper bucket, since app's top-level line is not usable (app is mixed)");
  const subLine = report.split('\n').find((l) => l.includes('app/sub'));
  assert.ok(subLine, 'a distinct line/segment must name app/sub');
  assert.match(subLine, /\b2\s+uncovered\b/i, 'the two uncovered files under app/sub, expressed as "2 uncovered" (count-in-context)');
  assert.match(subLine, /\b1\s+covered\b/i, 'the covered count for app/sub (covered2.ts) must NOT be suppressed, expressed as "1 covered"');
  // sabotage: render only the uncovered count for a mixed subdirectory (drop the covered figure) -> the /\b1\s+covered\b/i match on subLine fails -> red
  // sabotage: swap the two figures (render "1 uncovered, 2 covered") -> both context-scoped matches fail -> red
});

test('renderUndeclaredSourceReport: uncovered files sitting DIRECTLY in a mixed parent get their own bucket, distinct from a deeper subdirectory bucket', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const filePaths = ['app2/covered.ts', 'app2/direct-uncovered.py', 'app2/sub/onlyuncovered.py'];
  const classification = classifyCoverage(filePaths, ['app2/covered.ts'], []);
  assert.deepEqual(classification.covered, ['app2/covered.ts']);
  assert.deepEqual([...classification.uncovered].sort(), ['app2/direct-uncovered.py', 'app2/sub/onlyuncovered.py']);
  const report = renderUndeclaredSourceReport(classification);
  const lines = report.split('\n').filter((l) => l.trim().length > 0);
  const subLines = lines.filter((l) => l.includes('app2/sub'));
  const directLines = lines.filter((l) => l.includes('app2') && !l.includes('app2/sub'));
  assert.equal(subLines.length, 1, 'exactly one line covers the app2/sub bucket');
  assert.match(subLines[0], /\b1\s+uncovered\b/i, 'app2/sub has no covered file under it, so it is a count-only bucket: "1 uncovered" (count-in-context)');
  assert.ok(directLines.length >= 1, 'the directly-uncovered file must get a bucket line naming app2 that is NOT the app2/sub line');
  assert.match(directLines.join(' '), /\b1\s+uncovered\b/i, 'exactly one directly-uncovered file under app2, expressed as "1 uncovered"');
  // sabotage: merge direct-parent uncovered files into the same bucket as a subdirectory (or drop the direct bucket entirely)
  // -> subLines/directLines collapse into one line or directLines.length becomes 0 -> red
  // sabotage: mislabel the direct-parent count as "1 covered" instead of "1 uncovered" -> context-scoped match fails -> red
});

test('renderUndeclaredSourceReport: labels the mechanism honestly as an extension-based scan', async () => {
  const { classifyCoverage, renderUndeclaredSourceReport } = await loadModule();
  const classification = classifyCoverage(['x.py'], [], []);
  const report = renderUndeclaredSourceReport(classification);
  assert.match(report, /source-extension/i, 'a non-empty report must self-identify as an extension-based scan, never implying deeper (e.g. AST/import) analysis');
  // sabotage: delete the honest-labeling token from the rendered text -> red
});

// =========================================================================
// SECTION 4 — renderUnavailable
// =========================================================================

test('renderUnavailable: single bounded line containing the marker and the reason', async () => {
  const { renderUnavailable } = await loadModule();
  const out = renderUnavailable('git not found on PATH');
  assert.equal(typeof out, 'string');
  assert.doesNotMatch(out, /\n/, 'must be a single line');
  assert.match(out, /UNDECLARED SOURCE CHECK UNAVAILABLE/);
  assert.match(out, /git not found on PATH/);
  // sabotage: drop the reason from the rendered string (marker only) -> the reason match fails -> red
});

test('renderUnavailable: a long reason is truncated to a bounded length, not rendered whole', async () => {
  const { renderUnavailable } = await loadModule();
  const longReason = 'x'.repeat(1000);
  const out = renderUnavailable(longReason);
  assert.doesNotMatch(out, /\n/);
  assert.ok(!out.includes(longReason), 'the full 1000-char reason must not appear verbatim in the output');
  assert.ok(out.length < 400, `output must be bounded well below the 1000-char input; got length ${out.length}`);
  // sabotage: interpolate the reason unbounded (no truncation) -> out.length >= 400 and out.includes(longReason) both flip -> red
});

test('renderUnavailable: an embedded newline in the reason is never reproduced verbatim in the single-line output', async () => {
  const { renderUnavailable } = await loadModule();
  const out = renderUnavailable('first line\nsecond line');
  assert.doesNotMatch(out, /\n/, 'no raw newline may survive into the rendered line, regardless of what the reason contains');
  assert.match(out, /UNDECLARED SOURCE CHECK UNAVAILABLE/);
  // sabotage: template the reason in with a raw string interpolation (no newline stripping/escaping) -> doesNotMatch(/\n/) fails -> red
});
