// H25 citation-staleness advisory (board c1945057) — SPEC pins.
// A dispatch prompt's `path:line` citations are checked against the
// conductor-reads ledger: warn ONLY when a hashed ledger entry exists for the
// cited path and the file's current bytes differ (Codex thread 01a05bbe B1 —
// reads-ledger hash, never mtime; no entry / hashless entry = unverified,
// never stale). Content authored by the implementing coder dispatch,
// probe-verified (incl. mutation: flipping the hash comparison turned the
// WARN and fresh-CONTROL pins red) before application by the conductor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = join(root, 'scripts', 'hooks', 'h25-dispatch-capability.mjs');

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-cite-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function writeAgentDef(dir, type, tools = 'Read, Write, Edit, MultiEdit, Grep, Glob, Bash') {
  writeFileSync(join(dir, '.claude', 'agents', `${type}.md`), `---\nname: ${type}\ntools: ${tools}\n---\nBody.\n`);
}
function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function ctxOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  return JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? '';
}
function sha256(s) {
  return createHash('sha256').update(Buffer.from(s)).digest('hex');
}
function writeLedger(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'conductor-reads.json'), JSON.stringify(entries));
}

test('citation-staleness WARN: cited file changed since the recorded ledger hash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const f = join(dir, 'src', 'thing.mjs');
    writeFileSync(f, 'line1\nline2\nline3\n');
    writeLedger(dir, [{ path: 'src/thing.mjs', sha256: sha256('line1\nline2\nline3\n') }]);
    writeFileSync(f, 'line1\nline2 CHANGED\nline3\n');
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix the bug at src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.match(ctxOf(r), /file changed since your last Read; remeasure these line citations/i);
    assert.match(ctxOf(r), /src\/thing\.mjs/);
  } finally {
    cleanup();
  }
});

test('citation-staleness CONTROL (fresh): hash still matches — never fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const bytes = 'line1\nline2\nline3\n';
    writeFileSync(join(dir, 'src', 'thing.mjs'), bytes);
    writeLedger(dir, [{ path: 'src/thing.mjs', sha256: sha256(bytes) }]);
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix the bug at src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(ctxOf(r), /CITATION-STALENESS/);
  } finally {
    cleanup();
  }
});

test('citation-staleness CONTROL (no entry): unverified is not stale — never fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.mjs'), 'line1\nline2\nline3\n');
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix the bug at src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(ctxOf(r), /CITATION-STALENESS/);
  } finally {
    cleanup();
  }
});

test('citation-staleness CONTROL (legacy hashless entry): never fires even if the file changed', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const f = join(dir, 'src', 'thing.mjs');
    writeFileSync(f, 'line1\nline2\nline3\n');
    writeLedger(dir, [{ path: 'src/thing.mjs' }]);
    writeFileSync(f, 'line1\nline2 CHANGED\nline3\n');
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix the bug at src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.doesNotMatch(ctxOf(r), /CITATION-STALENESS/);
  } finally {
    cleanup();
  }
});

test('citation-staleness posture: never denies, even with a corrupt ledger', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'conductor-reads.json'), 'not valid json {{{');
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.notEqual(r.code, 2);
  } finally {
    cleanup();
  }
});

test('citation-staleness M3 pin: TWO entries for the same path, OLDER matches current bytes, NEWER does not — advisory FIRES (latest wins, never .some())', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const f = join(dir, 'src', 'thing.mjs');
    const currentBytes = 'line1\nline2\nline3\n';
    writeFileSync(f, currentBytes);
    writeLedger(dir, [
      { path: 'src/thing.mjs', sha256: sha256(currentBytes) },                    // OLDER, matches current bytes
      { path: 'src/thing.mjs', sha256: sha256('line1\nline2 STALE\nline3\n') },   // NEWER, does not match
    ]);
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'Fix the bug at src/thing.mjs:2 per the plan.' }, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.match(ctxOf(r), /file changed since your last Read; remeasure these line citations/i);
    assert.match(ctxOf(r), /src\/thing\.mjs/);
  } finally {
    cleanup();
  }
});
