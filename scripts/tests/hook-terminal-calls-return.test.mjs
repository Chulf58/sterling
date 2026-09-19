// R0 (objective rebuild-2026-09, board 6654707f) — pin (m), STATIC: every
// migrated hook wraps its top-level body in `function main(input) { ... }`
// called at module bottom, and EVERY call to a terminal helper
// (finish(/emit(/emitEnvelope(/allow(/deny(/warnNonBlocking() — wherever on
// the line it sits, including the dominant migrated shape
// `if (!outgoing) return finish();` — is immediately preceded by `return`, so
// nothing falls through into work a hard exit used to prevent (Codex round-1
// FATAL #1: a helper that RETURNS while a write is pending turns every early
// `if (x) finish();` into fall-through).
//
// Spec: decision hook-stdout-exit-after-write-callback-bound-exit-deny-stays-
// synchronous (knowledge_get fa147ba4-c7fe-4a15-8ff6-0b08e2a203fa), MIGRATION
// paragraph. This is a source-text structural pin — it reads the hook files
// as text (permitted: locating/structural facts about the migration shape,
// not behavioral implementation detail) and asserts a syntactic invariant a
// hardcoded literal cannot satisfy, since it is computed from the files'
// actual current content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

// h25-dispatch-capability.mjs row deleted with the hook (scale-down decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1).
const MIGRATED_HOOKS = ['h20-mechanism-axis.mjs', 'h19-knowledge-delivery.mjs', 'h19-bash-delivery.mjs', 'h19-dispatch-staging.mjs'];

// ---------------------------------------------------------------------------
// Source scrubbing.
//
// The offender scan must look at CODE, not at prose: a helper name inside a
// comment or inside a message string is not a call. scrubSource blanks line
// comments, block comments, string/template literals and regex literals with
// spaces, preserving every line and column position so `file:line` and the
// "what precedes the call" test both stay exact.
//
// It is a character scanner, not a parser. Its one deliberate bound: an
// unterminated single/double-quoted string bails at end of line, so the worst
// a mis-scan can do is blank the remainder of ONE line rather than swallow the
// rest of the file.
// ---------------------------------------------------------------------------

const REGEX_PREV_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const REGEX_PREV_KEYWORD = /\b(return|typeof|case|in|of|do|else|void|delete|new|yield|await)$/;

function scrubSource(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // last significant (non-whitespace) character seen in code position
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (c !== '`' && src[j] === '\n') break; // unterminated: bounded to this line
        j++;
      }
      j = Math.min(j, n);
      blank(i, j);
      i = j;
      prev = c;
      continue;
    }
    if (c === '/' && (REGEX_PREV_CHARS.has(prev) || REGEX_PREV_KEYWORD.test(src.slice(Math.max(0, i - 12), i).trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') {
          j += 2;
          continue;
        }
        if (e === '\n') break;
        if (inClass) {
          if (e === ']') inClass = false;
        } else if (e === '[') {
          inClass = true;
        } else if (e === '/') {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i, j);
        i = j;
        prev = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// EVERY call occurrence of a terminal helper, anywhere on a line — an anchored
// `^\s*` match would stay green on `if (!outgoing) return finish();` AND on its
// regression `if (!outgoing) finish();`, which is exactly the shape this pin
// exists for. `emitEnvelope` precedes `emit` in the alternation so
// `emitEnvelope(` matches once as itself and is never counted twice; the
// lookbehind rejects a name preceded by an identifier character or `.`, so
// `environmentDefectDenial(`, `foo.deny(` and `xEmit(` are not terminal calls.
const TERMINAL_NAMES = ['finish', 'emitEnvelope', 'emit', 'allow', 'deny', 'warnNonBlocking'];
const TERMINAL_CALL_RE = new RegExp(String.raw`(?<![A-Za-z0-9_$.])(${TERMINAL_NAMES.join('|')})\s*\(`, 'g');

// The text immediately before the call must end with the `return` keyword —
// any spacing, but on the SAME line (a newline between `return` and the call
// is ASI, i.e. a bare `return;` followed by an unreachable call).
const RETURN_PREFIX_RE = /(^|[^A-Za-z0-9_$.])return$/;

// A helper's own DEFINITION is not a call; `function main(` is excluded for the
// same reason (and so the header line can never be read as a call site).
const DEF_LINE_RE = new RegExp(String.raw`(^|[^A-Za-z0-9_$.])(export\s+)?(async\s+)?function\s*\*?\s*(${TERMINAL_NAMES.join('|')}|main)\s*\(`);

const MAIN_DEF_RE = /^\s*(export\s+)?(async\s+)?function\s+main\s*\(/m;
// The module-bottom invocation: exactly `main(input);` at column 0. A comment
// or a string mentioning main( no longer counts (the source is scrubbed), and
// neither does a nested/conditional call.
const TOP_LEVEL_MAIN_CALL_RE = /^main\(input\);[ \t]*$/;

for (const file of MIGRATED_HOOKS) {
  test(`(m) ${file}: every call to finish(/emit(/emitEnvelope(/allow(/deny(/warnNonBlocking( — anywhere on the line, including a same-line guard — is immediately preceded by \`return\``, () => {
    const path = join(HOOKS, file);
    const src = readFileSync(path, 'utf8');
    const rawLines = src.split('\n');
    const codeLines = scrubSource(src).split('\n');
    const offenders = [];
    codeLines.forEach((line, idx) => {
      if (DEF_LINE_RE.test(line)) return; // a definition header is not a call
      TERMINAL_CALL_RE.lastIndex = 0;
      let m;
      while ((m = TERMINAL_CALL_RE.exec(line)) !== null) {
        const before = line.slice(0, m.index).trimEnd();
        if (!RETURN_PREFIX_RE.test(before)) {
          offenders.push(`${file}:${idx + 1}: ${rawLines[idx].trim()}`);
        }
      }
    });
    assert.deepEqual(
      offenders,
      [],
      `every terminal-helper call must be \`return\`ed so nothing falls through into work a hard exit used to prevent (decision fa147ba4). Offending lines:\n${offenders.join('\n')}`,
    );
  });
  // SABOTAGE: delete the `return ` from ONE same-line guard in this file —
  // `if (!outgoing) return finish();` becomes `if (!outgoing) finish();` —
  // offenders gains that one `file:line: text` entry and the deepEqual([])
  // assertion goes red naming the exact offending line. (The pre-fix anchored
  // `^\s*` matcher stayed GREEN under precisely this sabotage, which is why the
  // scan is now occurrence-based rather than line-anchored.)

  test(`(m) ${file}: declares function main( and calls it as a bare top-level \`main(input);\``, () => {
    const path = join(HOOKS, file);
    const src = readFileSync(path, 'utf8');
    const code = scrubSource(src);
    assert.match(code, MAIN_DEF_RE, `${file} must wrap its top-level body in function main(input) { ... }`);
    const callLines = code.split('\n').filter((l) => TOP_LEVEL_MAIN_CALL_RE.test(l));
    assert.equal(
      callLines.length,
      1,
      `${file} must contain exactly one module-bottom invocation written as \`main(input);\` at column 0 — found ${callLines.length}. A commented-out or quoted mention does not count (the source is comment/string-scrubbed before this check).`,
    );
  });
  // SABOTAGE: delete the `function main(input) { ... }` wrapper and inline the
  // hook's body back at module top level (MAIN_DEF_RE goes red), or comment out
  // the trailing `main(input);` while keeping the definition (callLines.length
  // becomes 0 — the pre-fix version stayed green on the commented-out text).
}
