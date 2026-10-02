// Undeclared-source disclosure — PURE logic only (decision
// undeclared-source-disclosure-per-file-coverage-live-h1-scan, board 44ef6838;
// spec pinned by scripts/tests/undeclared-source.test.mjs). No git spawning, no
// hook/init wiring here — that lives in scripts/hooks/h1-session-start.mjs and
// scripts/init-impl.mjs, both of which import this module.
//
// GLOB MATCHER REUSE (CONSTRAINT, invariant 4): hook code is dependency-light
// and esbuild-bundled with NO workspace imports at runtime — but scripts/hooks/
// sources ALREADY import workspace packages at AUTHOR time and get bundled at
// ship time (build-hooks.mjs; every existing hook — h3/h4/h5/h17/h18/h25,
// scripts/hooks/lib/contract.mjs — imports matchesGlob this exact way). REUSED
// here rather than reimplemented: packages/schemas' matchesGlob (paths.ts:47)
// is THE one glob matcher this codebase already uses everywhere else, including
// from scripts/init-impl.mjs (unbundled, resolved via the npm workspace link).
import { matchesGlob } from '@sterling/schemas';

/** Lowercase extensions, no leading dot. */
export const SOURCE_EXTENSIONS = new Set([
  'ts', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'cs', 'sh', 'gd', 'lua',
]);

/** basename's extension, lowercased, or null for no-extension/dotfile-only names (never participates, v1: no shebang sniff). */
function extensionOf(path) {
  const base = String(path).split('/').pop() ?? '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return null; // no '.', or a dotfile whose whole name is the "extension" (idx===0)
  return base.slice(idx + 1).toLowerCase();
}

/**
 * LOW-2 (roster review, fix-round item 4; ASYMMETRY refined in the final-pass
 * review — this fallback applies to pathGlobs ONLY, never to excludeGlobs,
 * see classifyCoverage below): the extension check above is case-insensitive
 * (Foo.TS participates), but glob matching is inherently case-SENSITIVE —
 * matchesGlob compiles the glob to a regex with no `i` flag. On a
 * case-insensitive filesystem (Windows/WSL-mounted drives) a file whose
 * ON-DISK name differs in case from its glob (`Foo.TS` vs a `.ts` glob) would
 * otherwise read UNCOVERED even though the same filesystem treats them as the
 * same path. Tested BOTH the raw path and its lowercased form (against the
 * glob lowercased too, for the second attempt) — a false 'covered' verdict on
 * a genuinely case-sensitive filesystem (ext4) is strictly less costly than a
 * false 'uncovered' finding on a case-insensitive one, and for COVERAGE this
 * is a disclosure surface (no gate, no enforcement) where over-covering is
 * the safe direction (decision undeclared-source-disclosure-per-file-
 * coverage-live-h1-scan: "disclosure only"). Matches raw-path-first so the
 * common, already-consistent-casing case pays no extra work.
 *
 * WHY THIS NEVER APPLIES TO EXCLUDE GLOBS: exclusion is the opposite
 * direction — over-matching an exclude SILENCES a file entirely (it
 * participates in neither covered nor uncovered), which is a FALSE NEGATIVE
 * on the very thing this feature exists to surface. `Vendor/**` case-
 * insensitively swallowing `vendor/**.ts` on a genuinely case-sensitive
 * filesystem would hide real uncovered source with no disclosure at all —
 * strictly worse than the false-'covered' cost above, because a covered file
 * still gets a (wrong) mention in `covered`, while an excluded file leaves no
 * trace anywhere. So excludeGlobs is matched with plain, case-sensitive
 * matchesGlob only; the safe-direction asymmetry is per-field, not global.
 * RE-ADJUDICATED (Codex outside-family review 2026-08-31, thread 01a05861):
 * Codex raised a WSL-convenience objection (case-insensitive exclude matches
 * Windows/WSL casefold habits); the silence-vs-noise argument above won and
 * the asymmetry stands as written — adjudicated by conductor.
 */
function globMatchesEither(path, glob) {
  if (matchesGlob(path, glob)) return true;
  return matchesGlob(path.toLowerCase(), glob.toLowerCase());
}

/**
 * Pure per-file classification. A file PARTICIPATES iff its extension is in
 * SOURCE_EXTENSIONS and it is not excluded; a participating file is COVERED
 * iff its own path matches any pathGlobs entry, else UNCOVERED. Coverage is a
 * PER-FILE fact — never inferred from directory membership (the round-2 fatal
 * correction: an all-or-nothing directory predicate would hide 21 uncovered
 * importers beside 1 covered sibling, the exact measured incident shape).
 *
 * DEDUPES filePaths (Codex review 2026-08-31, docblock corrected in final
 * polish): the SAME path listed twice counts ONCE — a DEFENSIVE TOLERANCE
 * for direct callers of this pure function, not a uniqueness GUARANTEE
 * equivalent to the scan layer's. It dedupes on the DECODED string, which is
 * strictly WEAKER for non-UTF-8 input: two distinct invalid byte sequences
 * can decode to the same string (both to U+FFFD) and collapse into one
 * entry here. The BYTE-EXACT uniqueness guarantee — including the
 * unmerged-index case — lives in scanFilePaths
 * (scripts/hooks/lib/undeclared-source-scan.mjs), which dedupes on the raw
 * bytes BEFORE any UTF-8 decoding ever happens.
 */
export function classifyCoverage(filePaths, pathGlobs, excludeGlobs = []) {
  const covered = [];
  const uncovered = [];
  const seen = new Set();
  for (const path of filePaths ?? []) {
    if (seen.has(path)) continue; // duplicate input — count once
    seen.add(path);
    const ext = extensionOf(path);
    if (!ext || !SOURCE_EXTENSIONS.has(ext)) continue; // does not participate
    // excludeGlobs: case-SENSITIVE only (see globMatchesEither's docblock) —
    // over-matching here silences a file with no trace anywhere, the
    // false-negative direction this feature exists to prevent.
    if ((excludeGlobs ?? []).some((g) => matchesGlob(path, g))) continue; // excluded — does not participate
    if ((pathGlobs ?? []).some((g) => globMatchesEither(path, g))) covered.push(path);
    else uncovered.push(path);
  }
  return { covered, uncovered };
}

const topSegment = (path) => {
  const idx = path.indexOf('/');
  return idx === -1 ? path : path.slice(0, idx);
};
// second path segment (relative to the top-level dir), or null when the file
// sits DIRECTLY in the top-level dir with no subdirectory.
const secondSegment = (path) => {
  const idx = path.indexOf('/');
  if (idx === -1) return null;
  const rest = path.slice(idx + 1);
  const restIdx = rest.indexOf('/');
  return restIdx === -1 ? null : rest.slice(0, restIdx);
};
const isRootLevel = (path) => !path.includes('/');

/**
 * CONTROL-CHARACTER SANITIZATION (Codex outside-family review 2026-08-31,
 * thread 01a05861 — "this one matters most, the report is injected into the
 * conductor's context"). Every directory/file NAME interpolated into the
 * rendered text goes through this at the RENDER BOUNDARY (never inside
 * classifyCoverage — that stays pure/raw, since a caller may need the exact
 * path). A raw newline/carriage-return in a git-tracked path could otherwise
 * fork the report into an extra PHYSICAL line, and a crafted name could open
 * that new line with text indistinguishable from the UNAVAILABLE marker or
 * another bucket line, spoofing content that never came from this module —
 * a report whose physical line count no longer equals its bucket count is
 * itself the tell.
 *
 * CODE-POINT FILTER, not a regex character class (mirrors
 * scripts/hooks/h1-session-start.mjs's safeReceiptField): the ranges are
 * stated as NUMBERS, so there is no escape-sequence literal in the source to
 * get subtly mistyped/mistransported into a raw control byte — the exact
 * failure mode a hex-range regex risks. Covers C0 (0x00-0x1F, newline and
 * carriage-return included — the whole point, a newline is what forges a
 * line), DEL (0x7F) and the C1 block (0x80-0x9F) some terminals still act
 * on. Nothing here ever emits a literal control character, so no sanitized
 * string can contain a raw newline under any input.
 */
function sanitizeForDisplay(name) {
  return [...String(name)]
    .map((ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '\\r';
      if (ch === '\t') return '\\t';
      const c = ch.codePointAt(0);
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
        return '\\x' + c.toString(16).padStart(2, '0');
      }
      return ch;
    })
    .join('');
}

/**
 * Presentation only — buckets classifyCoverage's own return shape. Empty
 * uncovered self-clears to '' (nothing to disclose). Otherwise groups by
 * top-level directory (first path segment): an ALL-UNCOVERED top-level dir
 * (no covered file anywhere under it) renders as ONE line naming the total
 * uncovered count, however deep its files nest (never split by subdirectory —
 * that only happens once the directory is MIXED). A MIXED top-level dir (at
 * least one covered file under it) groups its uncovered files ONE LEVEL
 * DEEPER instead: files sitting directly in the top dir get their own bucket
 * distinct from any subdirectory bucket, and each second-level subdirectory
 * bucket reports its uncovered count plus its covered count when it has one
 * (never suppressed) — a subdirectory with only uncovered files buckets like
 * a normal all-uncovered directory (count only).
 *
 * ROOT-LEVEL FILES (Codex review 2026-08-31): a file with no '/' at all is
 * NEVER folded into the topSegment/directory machinery above (which would
 * otherwise treat its own filename as a "directory" — misleading, and the
 * exact defect this fix closes). It gets its own line, named explicitly and
 * labeled as a root-level file — never claimed to be a directory, never
 * given the "directly in this directory" phrasing directory buckets use.
 *
 * Every rendered NAME (directory segment or root filename) goes through
 * sanitizeForDisplay at the point of interpolation — the report itself is a
 * single string with '\n' joining PHYSICAL lines; nothing upstream of this
 * function may be trusted to be newline-free (spoof defense, see
 * sanitizeForDisplay's own docblock). No standalone header line: each bucket
 * line already carries the "source-extension" honesty phrase, so a
 * single-bucket report is exactly one physical line — the property the
 * spoof-defense pin measures directly (line count == bucket count).
 */
export function renderUndeclaredSourceReport(classification) {
  const covered = classification?.covered ?? [];
  const uncovered = classification?.uncovered ?? [];
  if (uncovered.length === 0) return '';

  const rootUncovered = uncovered.filter(isRootLevel);
  const dirCovered = covered.filter((p) => !isRootLevel(p));
  const dirUncovered = uncovered.filter((p) => !isRootLevel(p));

  const coveredByTop = new Map();
  const uncoveredByTop = new Map();
  // QUADRATIC BUCKETING FIX (Codex review 2026-08-31 — measured ~2.8s at 40k
  // distinct roots): order.includes(top) was O(n) per call, O(n^2) overall.
  // A companion Set gives O(1) membership while `order` keeps insertion order
  // for stable output.
  const order = [];
  const orderSeen = new Set();
  const addOrder = (top) => {
    if (!orderSeen.has(top)) {
      orderSeen.add(top);
      order.push(top);
    }
  };
  for (const p of dirCovered) {
    const top = topSegment(p);
    if (!coveredByTop.has(top)) coveredByTop.set(top, []);
    coveredByTop.get(top).push(p);
    addOrder(top);
  }
  for (const p of dirUncovered) {
    const top = topSegment(p);
    if (!uncoveredByTop.has(top)) uncoveredByTop.set(top, []);
    uncoveredByTop.get(top).push(p);
    addOrder(top);
  }

  const lines = [];
  for (const top of order) {
    const topUncovered = uncoveredByTop.get(top) ?? [];
    if (topUncovered.length === 0) continue; // nothing uncovered under this top dir
    const topCovered = coveredByTop.get(top) ?? [];
    const topLabel = sanitizeForDisplay(top);

    if (topCovered.length === 0) {
      // ALL-UNCOVERED: one line, total count including nested files.
      lines.push(`- ${topLabel}: ${topUncovered.length} uncovered source-extension file(s)`);
      continue;
    }

    // MIXED: group uncovered one level deeper. Grouping key is the RAW
    // (top, second) pair via JSON.stringify — safe and unambiguous for any
    // string content, including control characters; sanitization happens
    // only when the label is built for DISPLAY below.
    const direct = [];
    const bySecond = new Map(); // JSON.stringify([top, second]) -> { second, covered, uncovered }
    for (const p of topUncovered) {
      const second = secondSegment(p);
      if (second === null) {
        direct.push(p);
      } else {
        const k = JSON.stringify([top, second]);
        if (!bySecond.has(k)) bySecond.set(k, { second, covered: 0, uncovered: 0 });
        bySecond.get(k).uncovered++;
      }
    }
    for (const p of topCovered) {
      const second = secondSegment(p);
      if (second === null) continue; // covered file directly in top dir — not a subdirectory bucket
      const k = JSON.stringify([top, second]);
      if (bySecond.has(k)) bySecond.get(k).covered++;
    }
    if (direct.length) {
      lines.push(`- ${topLabel}: ${direct.length} uncovered source-extension file(s) directly in this directory`);
    }
    for (const { second, covered: coveredCount, uncovered: uncoveredCount } of bySecond.values()) {
      const label = `${topLabel}/${sanitizeForDisplay(second)}`;
      lines.push(
        coveredCount > 0
          ? `- ${label}: ${uncoveredCount} uncovered, ${coveredCount} covered source-extension file(s)`
          : `- ${label}: ${uncoveredCount} uncovered source-extension file(s)`
      );
    }
  }

  for (const p of rootUncovered) {
    lines.push(`- ${sanitizeForDisplay(p)} (root-level file): 1 uncovered source-extension file(s)`);
  }

  // ONE-LINE CONSTANT HEADER (final-pass reviewer's own recommendation): the
  // normal report was landing unattributed in the H1 banner while the
  // UNAVAILABLE branch carries its own marker — restored for consistency.
  // Constant text, no interpolated data, so it needs no sanitization itself.
  return [`UNDECLARED SOURCE (source-extension scan — extension allowlist only, no import/AST analysis):`, ...lines].join('\n');
}

const UNAVAILABLE_MARKER = 'UNDECLARED SOURCE CHECK UNAVAILABLE';
const UNAVAILABLE_REASON_CAP = 200;

/** One bounded, single-line disclosure for an abnormal shape (git absent, spawn
 *  failure, timeout, output cap, unparseable/malformed config) — never silence
 *  (P5). No newline survives under any input; a long reason is truncated.
 *  Routes through sanitizeForDisplay (final polish — nit): the two renderers
 *  now AGREE on what a control character is (ESC/C1/NEL included, not just
 *  CR/LF), and sanitizing BEFORE the length cap keeps escape-expansion
 *  (e.g. one raw byte becoming '\xNN') inside the bound, never past it. */
export function renderUnavailable(reason) {
  const flat = sanitizeForDisplay(String(reason ?? '')).trim();
  const bounded = flat.length > UNAVAILABLE_REASON_CAP ? `${flat.slice(0, UNAVAILABLE_REASON_CAP)}…(truncated)` : flat;
  return `${UNAVAILABLE_MARKER}: ${bounded}`;
}
