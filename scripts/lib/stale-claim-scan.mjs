// Stale-claim scan (board fd8d081c): file A's comment says symbol X is unwired;
// file B now calls X. Detects the CROSS-FILE contradiction at DIFF time — the
// direction the reporter identified as the only one that stops the pattern
// rather than catching it later, because the cost lands when a work order is
// written FROM the stale header (a near-miss double-charged players per trade
// signal; the safety net was a coder doubting its brief, not a mechanism).
//
// WHY NOT AN EXTENSION OF wiring-check.mjs, which the board item proposed:
// runWiringCheck reaches the repo only through completeness-check.mjs, which
// hard-requires a live run AND a linked brief (requireRun/requireBrief both
// fail()) and runs the wiring arm only under --final. The reported failures
// happened in conductor-direct mode, which has neither. What IS reused: the
// capability-gated adapter pattern (§9.1 — all three adapters declare
// static_wiring explicitly, so absence is declared and skipped loudly, never a
// crash), diff-json's {path, added_lines[]} shape, and the opt-out-marker
// convention from check-record-citations.
//
// FALSE POSITIVES ARE THE WHOLE BALLGAME. A checker that trips on ordinary TODOs
// gets ignored within a week, and an ignored checker is worse than none because
// it launders the belief that the class is covered. Hence: the marker and the
// symbol must appear on the SAME comment line, markers are a closed tight set
// rather than general prose, only COMMENT lines are considered, and callers added
// in TEST files do not count as wiring landing.
export const ABSENCE_MARKERS = [
  'not yet',
  'not wired',
  'unwired',
  'not implemented',
  'not built',
  'never built',
  'no consumer',
  'aspirational',
  'stubbed',
  'placeholder',
];

/** A line carrying this marker is never reported (mirrors CITATION_OPT_OUT). */
export const STALE_CLAIM_OPT_OUT = 'stale-claim-ok';

/** Default comment lead-ins. An adapter may override via commentPrefixes. */
export const DEFAULT_COMMENT_PREFIXES = ['//', '*', '/*', '#', '<!--'];

/**
 * Symbols that the added lines CALL. Deliberately conservative: an identifier
 * immediately followed by '(' — a call or a definition-with-body, not a bare
 * mention in prose, which is what makes the diff side cheap and quiet.
 * Keywords are excluded so `if (`, `for (` etc. never become symbols.
 */
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const NOT_SYMBOLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'await', 'throw', 'case', 'do', 'else', 'in', 'of', 'delete', 'void', 'yield',
  'require', 'import', 'super', 'this', 'constructor', 'set', 'get',
]);

/**
 * MEASURED 2026-08-03, and the reason the two filters below exist: the first
 * version of this scan had precision 0/16 over five real diffs of this repo.
 * Every false positive was one of exactly two kinds, so both are now excluded by
 * construction rather than by a longer stopword list:
 *
 * (1) EVERYDAY WORDS THAT ARE ALSO FUNCTION NAMES — `test(` (node:test), plus
 *     write / source / refuse. The symbol matched, then any comment containing
 *     that ordinary English word matched too. Fix: a symbol must LOOK like code,
 *     i.e. carry snake_case or an internal capital (staticWiring,
 *     broadcast_trade_signal — the motivating example's own shape). A
 *     single lowercase dictionary word is never accepted as a symbol.
 * (2) IDENTIFIERS INSIDE STRING LITERALS — a test title like
 *     '… skipped loudly (P5)' yielded the "symbol" `loudly`. Fix: strip string
 *     literals before scanning for calls.
 *
 * The remaining precision lever is the caller's: intersect these candidates with
 * symbols actually DECLARED in the repo (see declaredSymbolsIn), so an imported
 * third-party name can never raise a finding about this codebase's own comments.
 */
export function looksLikeSymbol(name) {
  return /[_$]/.test(name) || /[a-z][A-Z]/.test(name);
}

const STRING_LIT_RE = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;

export function stripStringLiterals(line) {
  return String(line).replace(STRING_LIT_RE, '""');
}

export function symbolsCalledIn(addedLines, { minLength = 4 } = {}) {
  const out = new Set();
  for (const raw of addedLines ?? []) {
    const line = String(raw);
    // A call appearing inside a comment is not wiring landing.
    if (isCommentLine(line)) continue;
    for (const m of stripStringLiterals(line).matchAll(CALL_RE)) {
      const name = m[1];
      if (name.length < minLength) continue;
      if (NOT_SYMBOLS.has(name)) continue;
      if (!looksLikeSymbol(name)) continue;
      out.add(name);
    }
  }
  return out;
}

/**
 * Names this repo DECLARES (function/const/let/class/export). Used to reject a
 * candidate that is merely imported from elsewhere: a stale claim is about THIS
 * codebase's own wiring, so a symbol it never declares cannot be the subject.
 */
const DECL_RE = /(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}/g;

export function declaredSymbolsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(DECL_RE)) {
    if (m[1]) out.add(m[1]);
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) out.add(name);
      }
    }
  }
  return out;
}

/** Does this line read as a comment? Prefix-based; adapters may widen it. */
export function isCommentLine(line, prefixes = DEFAULT_COMMENT_PREFIXES) {
  const t = String(line).trim();
  return prefixes.some((p) => t.startsWith(p));
}

/**
 * Comment lines in `fileText` that claim one of `symbols` is absent.
 * Requires the marker AND the symbol on the SAME line — the tight-window rule
 * that keeps this quiet. Returns [{ line, symbol, marker, text }] (1-indexed).
 */
export function absenceClaimsIn(fileText, symbols, { prefixes = DEFAULT_COMMENT_PREFIXES } = {}) {
  const claims = [];
  if (!fileText || symbols.size === 0) return claims;
  const lines = String(fileText).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isCommentLine(line, prefixes)) continue;
    if (line.includes(STALE_CLAIM_OPT_OUT)) continue;
    const lower = line.toLowerCase();
    const marker = ABSENCE_MARKERS.find((m) => lower.includes(m));
    if (!marker) continue;
    for (const symbol of symbols) {
      if (new RegExp(`\\b${escapeRe(symbol)}\\b`).test(line)) {
        claims.push({ line: i + 1, symbol, marker, text: line.trim() });
      }
    }
  }
  return claims;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The whole scan. Pure over its inputs so both a CLI and (later) a hook can
 * consume it without a second traversal.
 *
 *   diff       [{ path, added_lines: string[] }] from lib/diff-json.mjs
 *   readFile   (repoRelPath) => string|null — caller owns IO
 *   candidates repo-relative paths to scan for absence claims
 *   isTest     (path) => boolean — adapter testPathGlobs; a caller added in a
 *              test file is NOT wiring landing, so its symbols are ignored
 *
 * Returns { findings, symbols_added, skipped } — skipped is set (never thrown)
 * when the adapter cannot supply a symbol notion, so absence degrades LOUDLY.
 */
export function scanStaleClaims({ diff = [], readFile, candidates = [], isTest = () => false, capability = true }) {
  if (!capability) {
    return { findings: [], symbols_added: [], skipped: { check: 'stale-claim-scan', reason: 'capability_absent:stale_claim_scan' } };
  }
  const symbols = new Set();
  const candidateTexts = new Map();
  for (const path of candidates) {
    const text = readFile(path);
    if (text != null) candidateTexts.set(path, text);
  }
  // A stale claim is about THIS codebase's own wiring, so the subject must be a
  // symbol the repo DECLARES. Without this intersection an imported name like
  // node:test's `test` raises findings against every comment containing the word.
  const declared = new Set();
  for (const text of candidateTexts.values()) {
    for (const name of declaredSymbolsIn(text)) declared.add(name);
  }
  for (const entry of diff) {
    if (!entry?.path || isTest(entry.path)) continue;
    for (const s of symbolsCalledIn(entry.added_lines)) if (declared.has(s)) symbols.add(s);
  }
  const changed = new Set(diff.map((d) => d?.path).filter(Boolean));
  const findings = [];
  for (const [path, text] of candidateTexts) {
    for (const claim of absenceClaimsIn(text, symbols)) {
      findings.push({ ...claim, path, caller_added_in_same_file: changed.has(path) });
    }
  }
  return { findings, symbols_added: [...symbols], skipped: null };
}
