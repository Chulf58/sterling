import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Board bc96e89f DONE-WHEN (user-ruled): no shipped agent template may teach an
// executable probe in the session scratchpad, and no template may contain a
// command H14 denies (scratchpad execution).
//
// AUTHORED FROM THE SPEC, NOT FROM CURRENT TEMPLATE CONTENT: a coder is
// concurrently rewording agent-templates/*.md on a file-disjoint branch. This
// suite was written without reading agent-templates/*.md (H4 read wall — that
// tree is implementation under active edit) and must hold for the CORRECTED
// templates.
//
// HARDENING PASS (outside-family review found the original pins evadable):
// P1's detector is now bidirectional, case-insensitive, wider-vocabulary, and
// carries NO negation exemption — polarity discipline is the template's duty,
// not the regex's. P2 pins one canonical corridor sentence verbatim instead of
// three scattered keyword matches. P3 (the old "no unguarded mandate" check)
// is FOLDED INTO P1: P1 now sweeps every template with no negation carve-out,
// which is a strict superset of what P3 checked, so P3 as a separate test
// would be redundant — removing it, not weakening it.
// -----------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, '..', '..', 'agent-templates');

function listTemplateFiles() {
  // Dynamic on every call (not module-scope cached) so a future template
  // dropped into agent-templates/ is covered automatically, with no test
  // file edit required.
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

function readTemplate(file) {
  return readFileSync(join(TEMPLATES_DIR, file), 'utf8');
}

test('P1 sanity: agent-templates/*.md is read via readdirSync and covers at least the known trio', () => {
  const files = listTemplateFiles();
  // Guard against an empty/broken directory read silently greening the
  // per-file loop below by iterating zero files.
  assert.ok(files.length > 0, 'agent-templates directory listing must not be empty');
  for (const must of ['coder.md', 'debugger.md', 'test-writer.md']) {
    assert.ok(
      files.includes(must),
      `expected ${must} in the dynamic agent-templates/*.md listing, got: ${JSON.stringify(files)}`
    );
  }
});

// -----------------------------------------------------------------------------
// P1 detector: EXEC and SCRATCH co-occurring within 160 chars, EITHER order,
// case-insensitive, no negation exemption at all. Safe prose is the
// template's job to write (never pair an execution verb/command with a
// scratchpad reference on one line); the regex does not carve out excuses.
// -----------------------------------------------------------------------------

const SCRATCH_SRC = String.raw`(?:scratch\s*pad|\$\{?\w*scratchpad\}?|\/(?:var\/)?tmp\/)`;
const EXEC_SRC = String.raw`(?:\b(?:node|bun|deno|python\d*)\b|\b(?:run|execute|invoke)\b)`;
const COOCCUR_WINDOW = 160;

function lineHasScratchpadExecCooccurrence(line, windowChars = COOCCUR_WINDOW) {
  const execIdx = [...line.matchAll(new RegExp(EXEC_SRC, 'gi'))].map((m) => m.index);
  const scratchIdx = [...line.matchAll(new RegExp(SCRATCH_SRC, 'gi'))].map((m) => m.index);
  for (const e of execIdx) {
    for (const s of scratchIdx) {
      if (Math.abs(e - s) <= windowChars) return true;
    }
  }
  return false;
}

test('P1: no shipped agent template pairs an execution verb/command with a scratchpad reference on one line (bidirectional, no negation exemption — folds the former P3 sweep)', () => {
  const files = listTemplateFiles();
  assert.ok(files.length > 0, 'precondition: at least one template file to scan');
  for (const file of files) {
    const content = readTemplate(file);
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      assert.equal(
        lineHasScratchpadExecCooccurrence(line),
        false,
        `${file}:${idx + 1} pairs an execution verb/command with a scratchpad reference within ${COOCCUR_WINDOW} chars (no negation exemption): ${JSON.stringify(line.trim())}`
      );
    });
  }
});

test('P1 detector unit: known evasion strings must trip the co-occurrence check; verbatim safe prose must not', () => {
  const MUST_MATCH = [
    'Write ${CLAUDE_SCRATCHPAD}/repro.mjs and execute it through the declared command.',
    'Do not pause: cd "$SCRATCHPAD" && node probe.mjs',
    'node --test /tmp/session-probes/repro.mjs',
    'in the session scratchpad run node --test probe.mjs',
  ];
  for (const s of MUST_MATCH) {
    assert.equal(lineHasScratchpadExecCooccurrence(s), true, `detector must flag: ${JSON.stringify(s)}`);
  }

  const MUST_NOT_MATCH = [
    'the scratchpad holds notes only',
    'Probe corridor: IN-REPO; NOT *.test.{mjs,js,ts}; NOT under .sterling/.',
    'record findings in the scratchpad',
  ];
  for (const s of MUST_NOT_MATCH) {
    assert.equal(lineHasScratchpadExecCooccurrence(s), false, `detector must not flag safe prose: ${JSON.stringify(s)}`);
  }
});

test('P1 detector residual (DISCLOSED, not claimed as covered): a cross-line evasion escapes per-line detection', () => {
  // "Put repro.mjs in your scratch pad directory." / "Run node --test
  // repro.mjs" split across two lines evades a per-line window entirely.
  // This is a KNOWN, DISCLOSED gap in the per-line detector — the assertion
  // below documents the residual rather than pretending to cover it. Closing
  // it would need a sliding multi-line window, which is out of scope for
  // this pass (do not fake coverage by silently dropping this case).
  const twoLine = 'Put repro.mjs in your scratch pad directory.\nRun node --test repro.mjs';
  const anyLineFlags = twoLine.split(/\r?\n/).some((l) => lineHasScratchpadExecCooccurrence(l));
  assert.equal(
    anyLineFlags,
    false,
    'documents the residual: per-line detection does not see this cross-line pairing (disclosed gap, not a claimed pin)'
  );
});

// -----------------------------------------------------------------------------
// P2: canonical statement pin. Both coder.md and debugger.md must contain the
// corridor sentence verbatim (case-insensitive, flexible whitespace) rather
// than three independently-satisfiable scattered keyword matches.
// -----------------------------------------------------------------------------

const CANONICAL_CORRIDOR_LINE = /probe corridor:\s*in-repo;\s*not \*\.test\.\{mjs,js,ts\};\s*not under \.sterling\//i;

test('P2: coder.md and debugger.md state the canonical probe-corridor line verbatim (case-insensitive, flexible whitespace)', () => {
  for (const file of ['coder.md', 'debugger.md']) {
    const content = readTemplate(file);
    assert.ok(content.length > 0, `${file} must be non-empty (a wiped file would vacuously fail)`);
    assert.match(
      content,
      CANONICAL_CORRIDOR_LINE,
      `${file} must contain the canonical line: "Probe corridor: IN-REPO; NOT *.test.{mjs,js,ts}; NOT under .sterling/."`
    );
  }
});
