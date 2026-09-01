// H26 dispatch-time overlap advisory — SPEC ONLY, red-first.
//
// Governing decision: knowledge_get 6de73875-75b5-4182-8c1c-ca4841c993fa
// (slug lane-concept-first-slice-scope) is the authority on semantics; board
// b6a355f4-e5a6-4819-8e3f-a3ed8a175fc3 tracks the slice.
//
// Spec (given by the launching agent, NOT inferred from any implementation —
// scripts/hooks/h26-dispatch-overlap.mjs DOES NOT EXIST YET, confirmed via
// Glob before writing this file: zero matches):
//
// A new PreToolUse hook on the Task|Agent matcher, WARN-ONLY (H25's shared
// posture: no code path may exit 2; internal failures exit 1; advisories are
// emitted as `{"hookSpecificOutput":{"hookEventName":<input.hook_event_name>,
// "additionalContext":<string>}}` on stdout followed by exit 0). It never
// blocks a dispatch.
//
// When the outgoing dispatch's prompt names files that OVERLAP the declared
// `files` of a LIVE in-flight entry in H22's register
// (.sterling/transient/dispatch-register.json), it emits an advisory naming
// the overlapping repo-relative path(s), each overlapping live dispatch as
// `agent_type:agent_id`, stating the advisory is warn-only, and suggesting
// the remedy (keep lanes file-disjoint: await the in-flight agent or
// re-scope the new dispatch's territory).
//
// Candidate files come from `input.tool_input.prompt` via the same
// extraction H22 uses (path-like tokens, slash-separated with an extension),
// normalized repo-relative POSIX, with the same exclusions as H22: paths
// under .git/, .sterling/, sterling/, git/ never participate — on EITHER
// side of the comparison, since an excluded path is never in the outgoing
// candidate set to begin with.
//
// Liveness mirrors H22/H10: an entry counts only if its session_id matches
// AND its age (now - `at`) is under config.dispatch_register.stale_minutes
// (default 60). A stale or foreign-session entry never contributes to an
// advisory, even if its files literally overlap.
//
// EXPECTED FAILURE SHAPE (today, hook missing): spawnSync launches
// `node <missing-path>`; node exits nonzero ("Cannot find module") with
// empty stdout. Every SILENT-case test asserts `r.code === 0` first, which
// fails against that nonzero exit. Every WARNING-case test's
// assertOverlapWarning() asserts `r.code === 0` first, same failure. The one
// internal-failure test asserts `r.code === 1`, which also fails against
// today's "Cannot find module" exit (typically 1 on some platforms and NOT
// on others — the point pinned here is behavioral, not an accident of the
// module loader, so it is still a meaningful red assertion once the file
// exists). This is the correct and expected shape for this spec-only phase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const HOOK_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

// A Sterling project: .sterling/sterling.db is a MARKER ONLY (H26 never
// touches the store — it only ever reads register/config JSON files), plus
// .sterling/transient/ for the register.
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h26-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A bare, non-Sterling directory: no .sterling/ at all.
function makeBareDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h26-bare-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function writeConfig(dir, overrides) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(overrides));
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// Per decision h22-per-block-attribution (5d3747c1): H26 now warns only on
// entries provably matched to their starting agent's own dispatch block
// (attribution:'block'); imprecise unions and legacy pre-attribution entries
// are suppressed. Every fixture in THIS file exercises overlap detection
// itself (liveness, staleness, path exclusion, path normalization, malformed
// entries) rather than the attribution mechanism (which is pinned exclusively
// in scripts/tests/h22-attribution.test.mjs) — so the default here is the
// precise 'block' shape, overridable per-call for a test that needs to
// exercise a specific attribution value.
function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0, attribution = 'block' } = {}) {
  return { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo), attribution };
}

// Input shape per the task: PreToolUse, tool_name Task|Agent,
// tool_input {subagent_type, prompt}, session_id, cwd.
function taskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1', tool_name = 'Task', tool_input } = {}) {
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

// Parses the hookSpecificOutput envelope, tolerating empty stdout (today:
// always empty, since the hook does not exist). Invalid-but-present JSON is
// a distinct, explicit assertion failure rather than a test-runner crash.
function parseAdditionalContext(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

// Asserts the silent-allow shape: exit 0, no advisory content at all.
function assertSilent(r) {
  assert.equal(r.code, 0, `expected exit 0 (silent case), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.equal(ctx, '', `expected no overlap advisory; got: ${JSON.stringify(ctx)}`);
}

// Asserts the overlap-warning shape: exit 0, non-empty additionalContext
// naming every overlapping path and every overlapping entry as
// `agent_type:agent_id`, stating warn-only, and suggesting the remedy.
function assertOverlapWarning(r, { paths, entries }) {
  assert.equal(r.code, 0, `expected exit 0 (advisory only, never a denial), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty overlap advisory in additionalContext');
  for (const p of paths) {
    assert.match(ctx, tokenRe(p), `advisory must name the overlapping path '${p}'`);
  }
  for (const [agentType, agentId] of entries) {
    assert.ok(ctx.includes(`${agentType}:${agentId}`), `advisory must name the overlapping dispatch as '${agentType}:${agentId}'; got: ${ctx}`);
  }
  assert.match(ctx, /warn.?only/i, 'advisory must state it is warn-only');
  assert.match(ctx, /await|re-scope|disjoint/i, 'advisory must suggest the remedy (await the in-flight agent or re-scope)');
}

// ==========================================================================
// SILENT-ALLOW cases (exit 0, NO advisory) — spec item 5
// ==========================================================================

test('H26 SILENT: non-Sterling cwd (no .sterling/sterling.db) never warns, even with a would-be overlapping register present', () => {
  const { dir, cleanup } = makeBareDir();
  try {
    // Deliberately create .sterling/transient/dispatch-register.json WITHOUT
    // .sterling/sterling.db, to pin that the gate checks for the marker
    // specifically, not merely a .sterling/ directory.
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: missing register file entirely — no advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: corrupt register JSON degrades to no advisory (never a crash, never a denial)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, '{ this is not valid json at all');
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: register JSON that parses but is not an array — no advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, { agent_id: 'not-an-array' });
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: prompt with no path-like candidates at all — no advisory, even with a live register present', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please summarize the architecture of the store' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: live entries whose files have zero intersection with the outgoing candidates — no advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/other/thing.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: an overlapping entry that is STALE under the default 60-minute TTL never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    // No config.json written — default stale_minutes is 60; 90 minutes ago is stale.
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 90 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: an overlapping entry from a FOREIGN session never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'], { sessionId: 's2' })]);
    const r = runHook(taskInput(dir, { session_id: 's1', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: missing tool_input entirely — no advisory, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Task', session_id: 's1', cwd: dir }, dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: tool_input present but missing prompt — no advisory, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { tool_input: { subagent_type: 'coder' } }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// WARNING cases — spec item 6
// ==========================================================================

test('H26 WARN: one live overlapping entry — advisory names the path and agent_type:agent_id', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

test('H26 WARN: multiple live overlapping entries — advisory names each entry', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      liveEntry('sub-1', 'coder', ['src/shared/util.mjs']),
      liveEntry('sub-2', 'reviewer', ['src/shared/other.mjs']),
    ]);
    const r = runHook(
      taskInput(dir, { prompt: 'please modify src/shared/util.mjs and also src/shared/other.mjs today' }),
      dir
    );
    assertOverlapWarning(r, {
      paths: ['src/shared/util.mjs', 'src/shared/other.mjs'],
      entries: [
        ['coder', 'sub-1'],
        ['reviewer', 'sub-2'],
      ],
    });
  } finally {
    cleanup();
  }
});

test('H26 WARN: a path mentioned in the prompt with a leading "./" still warns against the bare repo-relative registered form', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please modify ./src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

test('H26 WARN: tool_name "Agent" (not "Task") behaves identically — same matcher, same advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today', tool_name: 'Agent' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

test('H26 SILENT (exclusion wins): a path under .sterling/ appearing in BOTH the prompt and a live register entry never counts as overlap', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['.sterling/transient/touches.json'])]);
    const r = runHook(taskInput(dir, { prompt: 'please inspect .sterling/transient/touches.json today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Config: dispatch_register.stale_minutes — spec item 8
// ==========================================================================

test('H26 config: a small configured stale_minutes makes an entry stale that would be live under the default 60', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConfig(dir, { dispatch_register: { stale_minutes: 2 } });
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 5 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 config: with no config.json at all, the default stale_minutes (60) applies — a 30-minute-old entry is still live and warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 30 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Never-deny invariant — spec item 7 (an AC-level sweep, not just per-case)
// ==========================================================================

test('H26 never-deny invariant: adversarial payloads (corrupt register, non-array register, huge overlap set) never exit 2', () => {
  const cases = [];

  const a = makeProject();
  writeRegisterRaw(a.dir, '{not json');
  cases.push([a, taskInput(a.dir, { prompt: 'please modify src/shared/util.mjs today' })]);

  const b = makeProject();
  writeRegisterRaw(b.dir, { not: 'an array' });
  cases.push([b, taskInput(b.dir, { prompt: 'please modify src/shared/util.mjs today' })]);

  const c = makeProject();
  const manyFiles = Array.from({ length: 50 }, (_, i) => `src/generated/file-${i}.mjs`);
  writeRegisterRaw(c.dir, [liveEntry('sub-1', 'coder', manyFiles)]);
  cases.push([c, taskInput(c.dir, { prompt: `please touch ${manyFiles.join(' and ')} today` })]);

  try {
    for (const [{ dir }, input] of cases) {
      const r = runHook(input, dir);
      assert.notEqual(r.code, 2, `advisory hook must never block; got exit 2 with stderr: ${r.stderr}`);
    }
  } finally {
    for (const [proj] of cases) proj.cleanup();
  }
});

// ==========================================================================
// Robustness: a malformed entry inside an otherwise-valid array never crashes
// and never fabricates a bogus dispatch identity.
// ==========================================================================

test('H26 robustness: a malformed entry (missing `files`) inside the register array never crashes and never appears as "undefined:undefined" in the advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { agent_id: 'broken-1', agent_type: 'coder', session_id: 's1', at: agoISO(0) }, // no `files`
      liveEntry('sub-1', 'reviewer', ['src/shared/other.mjs']),
    ]);
    const r = runHook(
      taskInput(dir, { prompt: 'please modify src/shared/util.mjs and src/shared/other.mjs today' }),
      dir
    );
    assert.notEqual(r.code, 2, `must never deny; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.ok(!ctx.includes('undefined:undefined'), 'a malformed entry must never surface as a bogus dispatch identity');
  } finally {
    cleanup();
  }
});

// A null agent_type is NOT malformed — H22 writes `agent_type ?? null` by
// design, so the entry must still warn, labeled with the same 'agent'
// fallback the script-side reader uses (review finding 2026-08-21). This
// fixture carries attribution:'block' deliberately: the case under test is
// the null-agent_type label fallback, not attribution suppression (that is
// pinned separately in scripts/tests/h22-attribution.test.mjs), so the entry
// must be the precise shape that is eligible to warn at all.
test('H26 robustness: a live entry with agent_type null still warns, labeled with the "agent" fallback — never dropped, never "null:<id>"', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { agent_id: 'sub-1', agent_type: null, session_id: 's1', files: ['src/shared/util.mjs'], at: agoISO(0), attribution: 'block' },
    ]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['agent', 'sub-1']] });
    const ctx = parseAdditionalContext(r);
    assert.ok(!ctx.includes('null:sub-1'), 'a null agent_type must be labeled with the fallback, not stringified null');
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Internal-failure posture: unparseable top-level stdin — exit 1, per the
// preamble ("internal failures exit 1"), distinct from the graceful
// silent-allow degradations enumerated above (which all exit 0).
// ==========================================================================

test('H26 internal failure: unparseable (non-JSON) stdin itself exits 1, not 0 and not 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHookRaw('this is not { json at all', dir);
    assert.equal(r.code, 1, `expected exit 1 for an internal failure on unparseable stdin, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ==========================================================================
// Board 7632586d — 9-for-9 false positives: read-only agent classes and
// prose-scraping of FORBIDDEN blocks. reviewer-class incoming-dispatch
// exemption is already pinned in h25-h26-advisory-precision.test.mjs; the
// pins below close the two gaps that item's triage named: librarian, the
// SYMMETRIC "never contributes" half for a read-only-class LIVE entry, and
// the REVIEW-TERRITORY structured-territory precedence over prose-scraping.
// ==========================================================================

test('H26 SILENT: incoming librarian dispatch (read-only, board 7632586d item 1) never warns despite live overlapping territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { subagent_type: 'librarian', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: a live librarian entry never CONTRIBUTES an overlap warning to an outgoing coder dispatch, even though its declared files overlap', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('lib-1', 'librarian', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { subagent_type: 'coder', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 SILENT: a live explorer entry never CONTRIBUTES an overlap warning either — same read-only write-set-empty class', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('exp-1', 'explorer', ['src/shared/util.mjs'])]);
    const r = runHook(taskInput(dir, { subagent_type: 'coder', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 WARN: a well-formed REVIEW-TERRITORY declaration is used INSTEAD of prose-scraping — a path only present in prose (even inside a FORBIDDEN block) is never compared, only the declared array is', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      liveEntry('sub-1', 'coder', ['src/declared/only.mjs']),
      liveEntry('sub-2', 'coder', ['src/other/prose.mjs']),
    ]);
    const prompt = [
      'REVIEW-TERRITORY: ["src/declared/only.mjs"]',
      '',
      'FORBIDDEN — another lane owns this, do not touch: src/other/prose.mjs',
    ].join('\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertOverlapWarning(r, { paths: ['src/declared/only.mjs'], entries: [['coder', 'sub-1']] });
    const ctx = parseAdditionalContext(r);
    assert.ok(!ctx.includes('src/other/prose.mjs'), `declared territory must win outright — prose-only path must never appear; got: ${ctx}`);
    assert.ok(!ctx.includes('sub-2'), `the prose-only overlapping entry must never be named; got: ${ctx}`);
  } finally {
    cleanup();
  }
});

test('H26 WARN: a malformed REVIEW-TERRITORY declaration falls back to prose-scraping, mirroring H22\'s own fallback', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const prompt = ['REVIEW-TERRITORY: [not valid json', '', 'please modify src/shared/util.mjs today'].join('\n');
    const r = runHook(taskInput(dir, { prompt }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

test('H26 SILENT: a live review-territory entry compares against files ONLY — prose-derived claimed_files/claimed_glob_prefixes must never contribute (Codex review HIGH, board 7632586d, thread 01a05b8c)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      {
        agent_id: 'sub-1',
        agent_type: 'coder',
        session_id: 's1',
        files: ['src/a.mjs'],
        files_source: 'review-territory',
        claimed_files: ['src/a.mjs', 'src/b.mjs'],
        at: agoISO(0),
        attribution: 'block',
      },
    ]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/b.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H26 WARN control: the SAME claimed_files shape with files_source absent (legacy) still warns — proves the exemption is files_source-gated, not a blanket claimed_files bypass', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      {
        agent_id: 'sub-1',
        agent_type: 'coder',
        session_id: 's1',
        files: ['src/a.mjs'],
        claimed_files: ['src/a.mjs', 'src/b.mjs'],
        at: agoISO(0),
        attribution: 'block',
      },
    ]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/b.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/b.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

test('H26 SILENT: a live review-territory entry poisoned with claimed_glob_prefixes:["src"] never contributes a prefix overlap — only files is compared (Codex re-review Medium, thread 01a05b8c)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{
      agent_id: 'sub-1', agent_type: 'coder', session_id: 's1',
      files: ['src/a.mjs'], files_source: 'review-territory',
      claimed_glob_prefixes: ['src'], at: agoISO(0), attribution: 'block',
    }]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/b.mjs today' }), dir);
    assertSilent(r);
  } finally { cleanup(); }
});

test('H26 WARN control: the SAME claimed_glob_prefixes:["src"] with files_source absent (legacy) still warns via the prefix', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{
      agent_id: 'sub-1', agent_type: 'coder', session_id: 's1',
      files: ['src/a.mjs'], claimed_glob_prefixes: ['src'], at: agoISO(0), attribution: 'block',
    }]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/b.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/b.mjs'], entries: [['coder', 'sub-1']] });
  } finally { cleanup(); }
});
