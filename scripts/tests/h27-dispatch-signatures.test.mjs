// H27 dispatch-time SIGNATURES verifier (board a06e4a1c) — SPEC ONLY,
// red-first.
//
// Governing decision: knowledge_get 7a4c3fb6-dc23-4c2f-9369-d2592132f408
// (slug frozen-test-repair-signatures-plus-visible-repair) is the authority
// on semantics — PREVENTION half of the ruling. Summary pinned here for the
// reader, not a re-derivation: a new hook, scripts/hooks/h27-dispatch-
// signatures.mjs, joins the PreToolUse Task|Agent matcher. A conductor
// dispatching a test-writer (or any agent) can append a structured
// `STERLING-SIGNATURES` section to the outgoing prompt naming repo-relative
// source files plus the exact signature text the blind test author is
// expected to rely on. Before the spawn proceeds, the hook re-reads each
// named file from disk and confirms the declared signature text appears
// VERBATIM (substring, trimmed) in it — closing the H4 composition where a
// blind test-writer must guess entry points, a guess that has twice produced
// a project-wide scan error only the conductor could repair (retro
// 2026-08-17 §2.1). The channel is OPT-IN: no marker, no ceremony (P1).
//
// scripts/hooks/h27-dispatch-signatures.mjs DOES NOT EXIST YET (confirmed via
// Glob before writing this file: zero matches). EVERY test below is RED
// against today's tree for the same structural reason: spawnSync launches
// `node <missing-path>`, node exits nonzero with a "Cannot find module"
// stderr and EMPTY stdout. Concretely, per assertion helper:
//   - assertSilentNoOutput / assertVerifiedAdvisory: the FIRST assertion is
//     `assert.equal(r.code, 0, ...)`, which fails because today's r.code is
//     node's module-not-found exit, not 0.
//   - assertDeny: the FIRST assertion is `assert.equal(r.code, 2, ...)`,
//     which fails for the same reason (today's exit is not 2).
//   - the internal-failure test asserts `r.code === 1` directly, which also
//     fails today (module-not-found is typically 1 on some platforms and NOT
//     on others — the point pinned here is behavioral: exit 1 specifically
//     for unparseable stdin, distinct from every other case in this file
//     which allows (0) or denies (2). That is a meaningful red assertion
//     once the hook exists, not an accident of the module loader).
// This is the correct and expected shape for this spec-only phase.
//
// Harness idiom mirrors scripts/tests/h26-dispatch-overlap.test.mjs and
// h25-dispatch-capability.test.mjs: spawnSync runHook idiom (process.execPath
// + hook path, JSON stdin, {code,stdout,stderr} return), a temp Sterling
// project marked by .sterling/sterling.db (marker only — H27 never touches
// the store), PreToolUse Task/Agent tool_input {subagent_type, prompt}, cwd.
// Deny-message assertions target stderr, per the established convention
// across the write-gate hooks (h24-gate-exit-lint.test.mjs's assertDeny).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Mutation seam (slice S1, board 5402a024) — mirrors h24-gate-exit-lint.test.mjs:48.
// STERLING_HOOKS_DIR lets a clean-room mutation run point this suite at a mutant
// bundle. Unset falls back to today's hard-coded scripts/hooks — byte-identical
// behavior to before this seam existed.
const HOOKS = process.env.STERLING_HOOKS_DIR || join(root, 'scripts', 'hooks');
const HOOK_PATH = join(HOOKS, 'h27-dispatch-signatures.mjs');

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

// A Sterling project: .sterling/sterling.db is a MARKER ONLY (H27 never
// touches the store — it only ever reads source files named in the
// SIGNATURES section from disk).
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h27-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A bare, non-Sterling directory: no .sterling/ at all.
function makeBareDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h27-bare-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Writes a real fixture source file at a repo-relative path inside the temp
// project, so signature verification runs against genuine file content.
function writeSourceFile(dir, relPath, lines) {
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join('\n') + '\n');
}

// Builds a `STERLING-SIGNATURES` section body from {path, sig} entries.
function signaturesSection(entries) {
  const lines = ['STERLING-SIGNATURES'];
  for (const e of entries) lines.push(`- ${e.path} :: ${e.sig}`);
  return lines.join('\n');
}

// Input shape per the task: PreToolUse, tool_name Task|Agent,
// tool_input {subagent_type, prompt}, session_id, cwd.
function taskInput(dir, { subagent_type = 'test-writer', prompt, session_id = 's1', tool_name = 'Task', tool_input } = {}) {
  const base = { hook_event_name: 'PreToolUse', tool_name, session_id, cwd: dir };
  if (tool_input !== undefined) return { ...base, tool_input };
  return { ...base, tool_input: { subagent_type, prompt } };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runHookRaw(rawStdin, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: rawStdin,
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Parses the hookSpecificOutput envelope from stdout, tolerating empty
// stdout (today: always empty pre-implementation). Invalid-but-present JSON
// is a distinct, explicit assertion failure rather than a test-runner crash.
function parseAdditionalContext(r) {
  if (!r.stdout || !r.stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed;
}

// ==========================================================================
// Item 1 — no marker at all: silent allow, exit 0, and LITERALLY NO OUTPUT
// (the spec's own wording: "silent allow (exit 0, no output)" — the channel
// is opt-in, no ceremony for ordinary dispatches).
// ==========================================================================

function assertSilentNoOutput(r) {
  assert.equal(r.code, 0, `expected exit 0 (no marker present), got ${r.code}; stderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), '', `expected NO output at all for a promptless-of-marker dispatch; got stdout: ${JSON.stringify(r.stdout)}`);
}

test('H27 item1: no STERLING-SIGNATURES marker anywhere in the prompt — silent allow, zero output', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
      '  return store.get(id, opts);',
      '}',
    ]);
    const r = runHook(
      taskInput(dir, { prompt: 'please write tests for the export path; call knowledgeGet as needed' }),
      dir
    );
    assertSilentNoOutput(r);
  } finally {
    cleanup();
  }
});

test('H27 item1: an ordinary dispatch prompt that never mentions the marker word at all — silent allow, zero output', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(taskInput(dir, { prompt: 'summarize the architecture of the store for the reviewer' }), dir);
    assertSilentNoOutput(r);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 7 — non-Sterling cwd: silent allow regardless of prompt content, even
// with a marker + entries present.
// ==========================================================================

test('H27 item7: non-Sterling cwd (no .sterling/sterling.db) allows silently even with a full SIGNATURES section present', () => {
  const { dir, cleanup } = makeBareDir();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
    ]);
    const prompt = [
      'dispatch brief follows',
      signaturesSection([{ path: 'packages/mcp-server/src/tools.ts', sig: 'knowledgeGet(id: string, opts?: { field?: string })' }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertSilentNoOutput(r);
  } finally {
    cleanup();
  }
});

test('H27 item7: non-Sterling cwd allows silently even when an entry would otherwise DENY (missing file)', () => {
  const { dir, cleanup } = makeBareDir();
  try {
    const prompt = [
      'dispatch brief follows',
      signaturesSection([{ path: 'no/such/file.mjs', sig: 'export function ghost()' }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertSilentNoOutput(r);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 2 / item 10 — verified section: allow + advisory naming N verified.
// ==========================================================================

function assertVerifiedAdvisory(r, { count, hookEventName = 'PreToolUse' }) {
  assert.equal(r.code, 0, `expected exit 0 (all signatures verified), got ${r.code}; stderr: ${r.stderr}`);
  const parsed = parseAdditionalContext(r);
  assert.ok(parsed, `expected a non-empty hookSpecificOutput envelope on stdout; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(
    parsed?.hookSpecificOutput?.hookEventName,
    hookEventName,
    `advisory hookSpecificOutput.hookEventName must echo the input's hook_event_name ('${hookEventName}')`
  );
  const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(ctx.length > 0, 'expected non-empty additionalContext confirming verification');
  assert.match(ctx, /verifi/i, 'advisory must confirm verification occurred');
  assert.match(
    ctx,
    new RegExp(`\\b${count}\\b`),
    `advisory must state the count of verified signatures (${count}); got: ${ctx}`
  );
}

test('H27 item2: one entry, signature appears verbatim as a substring of the named file — allow + advisory confirms 1 verified', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
      '  return store.get(id, opts);',
      '}',
    ]);
    const prompt = [
      'You are a blind test-writer. Do not guess entry points.',
      signaturesSection([{ path: 'packages/mcp-server/src/tools.ts', sig: 'knowledgeGet(id: string, opts?: { field?: string })' }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertVerifiedAdvisory(r, { count: 1 });
  } finally {
    cleanup();
  }
});

test('H27 item10: two entries across two different files, both valid — allow + advisory counts both (2)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
      '  return store.get(id, opts);',
      '}',
    ]);
    writeSourceFile(dir, 'scripts/lib/dispatch-register.mjs', [
      'export function liveDispatches(root) {',
      '  return readRegister(root).filter(isLive);',
      '}',
    ]);
    const prompt = [
      'Blind test-writer brief.',
      signaturesSection([
        { path: 'packages/mcp-server/src/tools.ts', sig: 'knowledgeGet(id: string, opts?: { field?: string })' },
        { path: 'scripts/lib/dispatch-register.mjs', sig: 'export function liveDispatches(root)' },
      ]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertVerifiedAdvisory(r, { count: 2 });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 3 — a declared signature that does NOT appear in the named file: DENY
// naming the path, quoting the failed signature, and stating the remedy.
// ==========================================================================

function assertDeny(r, { mustInclude }) {
  assert.equal(r.code, 2, `expected DENY (exit 2), got ${r.code}; stdout: ${JSON.stringify(r.stdout)}; stderr: ${r.stderr}`);
  for (const needle of mustInclude) {
    if (needle instanceof RegExp) {
      assert.match(r.stderr, needle, `denial message must match ${needle}; got stderr: ${r.stderr}`);
    } else {
      assert.ok(r.stderr.includes(needle), `denial message must include ${JSON.stringify(needle)}; got stderr: ${r.stderr}`);
    }
  }
}

test('H27 item3: signature entirely absent from the named file — DENY naming the path, quoting the failed signature, and stating the remedy', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
      '  return store.get(id, opts);',
      '}',
    ]);
    const badSig = 'knowledgeFetch(id: string, mode: "strict")'; // never appears in the file
    const prompt = [
      'Blind test-writer brief.',
      signaturesSection([{ path: 'packages/mcp-server/src/tools.ts', sig: badSig }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, {
      mustInclude: [
        'packages/mcp-server/src/tools.ts',
        badSig,
        /re-read|paste|drop/i,
      ],
    });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 9 — a near-miss (one-character difference) is STILL a DENY, because
// matching is exact-substring, never fuzzy.
// ==========================================================================

test('H27 item9: near-miss signature (one character different from the actual file content) — DENY, exact-substring only', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'scripts/lib/dispatch-register.mjs', [
      'export function liveDispatches(root) {',
      '  return readRegister(root).filter(isLive);',
      '}',
    ]);
    // One character different from the real line: 'liveDispatches' -> 'liveDispatchs' (missing 'e').
    const nearMissSig = 'export function liveDispatchs(root)';
    const prompt = [
      'Blind test-writer brief.',
      signaturesSection([{ path: 'scripts/lib/dispatch-register.mjs', sig: nearMissSig }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, {
      mustInclude: ['scripts/lib/dispatch-register.mjs', nearMissSig],
    });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 4 — an entry names a file that does not exist: DENY naming the
// missing path.
// ==========================================================================

test('H27 item4: entry names a file that does not exist on disk (repo-relative to the project root) — DENY naming the missing path', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Blind test-writer brief.',
      signaturesSection([{ path: 'packages/mcp-server/src/does-not-exist.ts', sig: 'export function ghost()' }]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, { mustInclude: ['packages/mcp-server/src/does-not-exist.ts'] });
  } finally {
    cleanup();
  }
});

test('H27 item4: one valid entry plus one entry naming a missing file — the missing-file entry alone is enough to DENY, naming that path', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
    ]);
    const prompt = [
      'Blind test-writer brief.',
      signaturesSection([
        { path: 'packages/mcp-server/src/tools.ts', sig: 'knowledgeGet(id: string, opts?: { field?: string })' },
        { path: 'packages/mcp-server/src/ghost.ts', sig: 'export function ghost()' },
      ]),
    ].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, { mustInclude: ['packages/mcp-server/src/ghost.ts'] });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 5 — marker present but ZERO parseable entry lines follow it: DENY (a
// declared-but-empty section is a half-wired extension), message shows the
// expected entry format.
// ==========================================================================

test('H27 item5: marker present, immediately followed by unrelated prose (zero entry lines) — DENY showing the expected format', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Blind test-writer brief.', 'STERLING-SIGNATURES', 'Please proceed as usual, thanks.'].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, {
      mustInclude: [/::/, /-\s*<.*>/],
    });
  } finally {
    cleanup();
  }
});

test('H27 item5: marker present at the very end of the prompt with nothing after it (zero entries) — DENY showing the expected format', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Blind test-writer brief.', 'STERLING-SIGNATURES'].join('\n\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, {
      mustInclude: [/::/],
    });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 6 — a malformed entry line under the marker (no ` :: ` separator):
// DENY naming the bad line.
// ==========================================================================

test('H27 item6: a bulleted line under the marker missing the " :: " separator — DENY naming the bad line', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
    ]);
    const badLine = '- packages/mcp-server/src/tools.ts knowledgeGet(id: string, opts?: { field?: string })'; // no " :: "
    // NOTE: the marker and the bad line are joined with a SINGLE '\n' (not a
    // blank-line-separated '\n\n' like the prose above it) so the bad line is
    // directly, contiguously under the marker — otherwise an intervening
    // blank line would end the section per the "first non-entry line ends
    // it" rule before the bad line is ever reached, collapsing this into the
    // item5 (zero-entries) case rather than exercising the distinct item6
    // (malformed-entry-line) path.
    const prompt = ['Blind test-writer brief.', '', 'STERLING-SIGNATURES', badLine].join('\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, { mustInclude: [badLine] });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Item 8 — unparseable stdin: exit 1 (internal-failure posture, distinct
// from every allow(0)/deny(2) case above), never exit 2.
// ==========================================================================

test('H27 item8: unparseable (non-JSON) stdin — exit 1, not 0 and not 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHookRaw('this is not { json at all', dir);
    assert.equal(r.code, 1, `expected exit 1 for unparseable stdin, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Boundary — section termination: a non-entry line ends the section, so
// content after it (even a decoy line shaped like an entry, naming a file
// that would DENY if evaluated) is never parsed as part of the SIGNATURES
// section. This pins the "ends at the first line that is not an entry line"
// rule from the spec against an implementation that might over-eagerly scan
// the whole prompt for bullet lines instead of only the contiguous run
// following the marker.
// ==========================================================================

test('H27 boundary: a blank-line-terminated section stops parsing — a decoy bullet line after the blank line (naming a nonexistent file) is never evaluated', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
    ]);
    const prompt = [
      'Blind test-writer brief.',
      'STERLING-SIGNATURES',
      '- packages/mcp-server/src/tools.ts :: knowledgeGet(id: string, opts?: { field?: string })',
      '',
      'Some further prose about the task, not part of the section.',
      '- packages/mcp-server/src/nonexistent-decoy.ts :: export function neverReal()',
    ].join('\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    // If the decoy line were wrongly treated as part of the section, this
    // would DENY (missing file, item 4). Correct behavior: only the one
    // real entry before the blank line is parsed and verified.
    assertVerifiedAdvisory(r, { count: 1 });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Robustness — a leading "./" or extra internal whitespace around the " :: "
// separator does not defeat matching. Signature text is trimmed per spec;
// the path is used as given (repo-relative), matching the H26/H22 convention
// of resolving paths against the project root.
// ==========================================================================

test('H27 robustness: extra whitespace around " :: " and the signature text is trimmed before matching', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'packages/mcp-server/src/tools.ts', [
      'export function knowledgeGet(id: string, opts?: { field?: string }) {',
    ]);
    const prompt = [
      'Blind test-writer brief.',
      'STERLING-SIGNATURES',
      '- packages/mcp-server/src/tools.ts  ::   knowledgeGet(id: string, opts?: { field?: string })   ',
    ].join('\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertVerifiedAdvisory(r, { count: 1 });
  } finally {
    cleanup();
  }
});


// ---------------------------------------------------------------------------
// STRENGTHENING (review 2026-08-21): fail-closed on an unreadable entry, repo
// containment, and marker selection when the marker is also MENTIONED inline.
// ---------------------------------------------------------------------------
test('H27 review: an entry naming a DIRECTORY (unreadable as a file) DENIES — the gate never shrugs past what it cannot verify', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'src/lib/inner.mjs', ['export function x() {}']); // makes src/lib a real directory
    const prompt = `Do the work.\nSTERLING-SIGNATURES\n- src/lib :: export function x() {}\n`;
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, { mustInclude: ['src/lib'] });
  } finally {
    cleanup();
  }
});

test('H27 review: an entry path escaping the project root (../) DENIES without reading outside the repo', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = `STERLING-SIGNATURES\n- ../../etc/hosts :: localhost\n`;
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertDeny(r, { mustInclude: ['../../etc/hosts'] });
  } finally {
    cleanup();
  }
});

test('H27 review: a prompt MENTIONING the marker on its own line before a REAL section verifies the real section', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSourceFile(dir, 'src/real.mjs', ['export function real(a, b) {}']);
    const prompt =
      `The hook keys on a marker line:\nSTERLING-SIGNATURES\nThat marker starts a section when entries follow.\n\n` +
      `Now the actual channel:\nSTERLING-SIGNATURES\n- src/real.mjs :: export function real(a, b) {}\n`;
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertVerifiedAdvisory(r, { count: 1 });
  } finally {
    cleanup();
  }
});
