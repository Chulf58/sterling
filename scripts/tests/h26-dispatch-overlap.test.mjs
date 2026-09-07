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
//
// ===========================================================================
// R1 PIN RE-CUT (contract sheet §1.1 consumer policies, §6 A1/A2/A6/A9).
// H26's liveness notion is replaced by the TRI-STATE dispatchStatus:
//   presumed-active    -> warn (as today).
//   unknown            -> ALSO warn, disclosing [dispatch_status_unknown], the
//                         entry's measured age, that the overlap is RECORDED IN
//                         THE REGISTER rather than observed running, and the
//                         killed-dispatch caveat. It never asserts liveness.
//   inactive-confirmed -> skipped.
//   register unreadable-> one [register_unavailable] line, never an all-clear
//                         and never a per-agent enumeration.
//
// RETIRE/RE-CUT ledger for this file:
//   RETIRED: 'H26 SILENT: an overlapping entry that is STALE under the default 60-minute TTL never warns'
//     — an expired lease is now unknown, not dead; suppressing the warning is the
//       measured harm (board 0d1cfbc2). Re-cut as R1-A81/A82.
//   RETIRED: 'H26 SILENT: an overlapping entry from a FOREIGN session never warns'
//     — A2 removes other-session pruning; those entries classify unknown/other-session
//       and warn like any other unknown. Re-cut as R1-A83.
//   RETIRED: 'H26 SILENT: corrupt register JSON degrades to no advisory' and
//            'H26 SILENT: register JSON that parses but is not an array — no advisory'
//     — silence on an unreadable register is the all-clear the decision forbids.
//       Re-cut as R1-A85/A86; the never-deny half is kept intact.
//   RETIRED: 'H26 config: a small configured stale_minutes makes an entry stale that
//            would be live under the default 60'
//     — the lease no longer decides WHETHER to warn, only WHICH STATUS is claimed.
//       Re-cut as R1-A84.
//   CONVERTED: assertOverlapWarning's /warn.?only/i prose assertion -> exit 0 plus
//     the advisory's [code] token (§4). The remedy assertion is KEPT as a required
//     fact: an advisory with no remedy is the noise P1 forbids.
//
// ABSENT REGISTER, RESOLVED AMBIGUITY (stated, not silently taken): a MISSING
// register file stays SILENT here. H26 does not render a statement about the
// in-flight set — it acts on overlaps — so its silence is not an all-clear,
// whereas inFlightAdvisory's and rotation-note's silence would be (those two
// pin absent -> unavailable). What must never be silent is a register that
// EXISTS and cannot be read: a real anomaly, not the normal post-SessionStart
// state.
// ===========================================================================

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

// §4: a refusal/disclosure is asserted by its [code] token, never by sentence text.
const code = (c) => new RegExp('\\[' + c + '\\]');
const ANY_CODE = /\[[a-z][a-z0-9_]*\]/;

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
  // CONVERTED (§4): warn-only is pinned by the exit code above, and the
  // advisory's identity by its [code] token — never by a prose sentence.
  assert.match(ctx, ANY_CODE, `every advisory line must carry its code token; got: ${ctx}`);
  assert.match(ctx, /await|re-scope|disjoint/i, 'advisory must suggest the remedy (await the in-flight agent or re-scope)');
  assert.doesNotMatch(ctx, /NaN/, 'no fabricated age ever reaches the reader');
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

// R1-A85 (re-cut from 'corrupt register JSON degrades to no advisory'): a
// register that EXISTS and cannot be read may not read as "no overlaps". The
// never-crash / never-deny half of the retired pin is kept verbatim.
// SABOTAGE: degrade a JSON parse failure to an empty entry list (the pre-rebuild
// behaviour) -> the [register_unavailable] assertion goes red while the H26
// SILENT cases with a readable register stay green.
test('R1-A85: a CORRUPT register is disclosed once as [register_unavailable] — never a silent all-clear, never a crash, never a denial', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, '{ this is not valid json at all');
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assert.equal(r.code, 0, `still advisory-only; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    const lines = ctx.split('\n').filter((l) => code('register_unavailable').test(l));
    assert.equal(lines.length, 1, `exactly one unavailability line, found ${lines.length}: ${ctx}`);
    assert.match(lines[0], /corrupt/, 'the line names WHICH unavailability it is');
  } finally {
    cleanup();
  }
});

// R1-A86 (re-cut from 'register JSON that parses but is not an array'): the
// same verdict for a shape that parses but is not a register — and it must not
// mine the object for agent identities it never actually read.
// SABOTAGE: coerce a non-array to [] -> the token assertion goes red.
test('R1-A86: a register that parses but is NOT an array is [register_unavailable] and enumerates no agents', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, { agent_id: 'not-an-array', agent_type: 'coder' });
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assert.equal(r.code, 0);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, code('register_unavailable'));
    assert.ok(!ctx.includes('not-an-array'), `an unreadable register yields no per-agent enumeration; got: ${ctx}`);
    assert.doesNotMatch(ctx, code('dispatch_status_unknown'), 'unavailable is ONE disclosure, never N per-agent unknowns');
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

// R1-A81 (re-cut from 'a STALE entry never warns'): board 0d1cfbc2's measured
// harm ran the other way — the register cannot observe a kill, so an expired
// lease is UNKNOWN and the overlap still matters. What changes is the CLAIM.
// SABOTAGE: restore the TTL filter (drop out-of-lease entries before the
// comparison) -> the advisory is emitted empty and this goes red on its first
// assertion, while every presumed-active WARN case stays green.
test('R1-A81: an out-of-lease overlapping entry STILL warns, disclosed as unknown — an expired lease is not a death certificate', () => {
  const { dir, cleanup } = makeProject();
  try {
    // No config.json written — default lease is 60 minutes; 90 minutes ago is out of lease.
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 90 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'a1']] });
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, code('dispatch_status_unknown'), `the unknown status carries its code; got: ${ctx}`);
    assert.match(ctx, /coder:a1 \(registered 1h30m/, 'the ref carries the MEASURED age of the register entry');
  } finally {
    cleanup();
  }
});

// R1-A82: what the advisory MAY claim on the evidence it actually has (parked
// pin source PINS-h26-dispatch-overlap.txt, converted to the tri-state wording).
// SABOTAGE: restore the old wording ('Overlapping live dispatch(es)', no caveat)
// -> the caveat, the killed-dispatch clause and the doesNotMatch all go red.
test('R1-A82: the unknown overlap says it is RECORDED IN THE REGISTER, names the killed-dispatch case, and never asserts the holder is live', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a172f512961a5a27d', 'test-writer', ['src/parser.mjs'], { minutesAgo: 90 })]);
    const r = runHook(taskInput(dir, { prompt: 'Fix the parser in src/parser.mjs and keep the tests green.' }), dir);
    const ctx = parseAdditionalContext(r);
    assert.equal(r.code, 0, `warn-only, never a block — stderr=${r.stderr}`);
    assert.match(ctx, /H26 DISPATCH OVERLAP ADVISORY/, 'the overlap still warns — this pin is about WHAT it claims');
    assert.match(ctx, /test-writer:a172f512961a5a27d \(registered 1h30m/, `the holder is cited WITH its age — ctx=${ctx}`);
    assert.match(ctx, /RECORDED IN THE REGISTER, not observed running/, `what "in flight" actually means — ctx=${ctx}`);
    assert.match(ctx, /KILLED or\s+interrupted dispatch/, `the killed-dispatch case is named — ctx=${ctx}`);
    assert.doesNotMatch(ctx, /Overlapping live dispatch\(es\)/, `it never ASSERTS liveness it cannot observe — ctx=${ctx}`);
  } finally {
    cleanup();
  }
});

// R1-A82a CONTROL (parked pin, kept): the age is a MEASUREMENT, not a constant
// string that would satisfy A81/A82 forever.
// SABOTAGE: replace the '<1m' branch with the constant 'registered 12m ago' ->
// red here only.
test('R1-A82a CONTROL: a just-registered entry is cited as "<1m" and as presumed-active — the age and the status are both measured', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('freshagent0000001', 'coder', ['src/parser.mjs'], { minutesAgo: 0 })]);
    const r = runHook(taskInput(dir, { prompt: 'Fix the parser in src/parser.mjs and keep the tests green.' }), dir);
    const ctx = parseAdditionalContext(r);
    assert.equal(r.code, 0);
    assert.match(ctx, /coder:freshagent0000001 \(registered <1m/, `ctx=${ctx}`);
    assert.match(ctx, /presumed-active/, 'a fresh same-session entry is presumed active, not unknown');
    assert.doesNotMatch(ctx, code('dispatch_status_unknown'), 'and it carries no uncertainty disclosure');
  } finally {
    cleanup();
  }
});

// R1-A83 (re-cut from 'a FOREIGN session entry never warns'): A2 stops pruning
// other-session entries on write, so H26 now meets them and must warn on them
// as unknown/other-session — one live session per worktree is the contract, and
// a foreign entry is exactly the shape that contract cannot vouch for.
// SABOTAGE: filter entries by session before the comparison -> the advisory is
// emitted empty and this goes red while R1-A82a stays green.
test('R1-A83: a FOREIGN-SESSION overlapping entry warns as unknown — never silently filtered, never claimed live', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('a1', 'coder', ['src/shared/util.mjs'], { sessionId: 's2' })]);
    const r = runHook(taskInput(dir, { session_id: 's1', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'a1']] });
    assert.match(parseAdditionalContext(r), code('dispatch_status_unknown'));
  } finally {
    cleanup();
  }
});

// R1-A87: an ENDED entry is inactive-confirmed and is SKIPPED — the one status
// that legitimately silences an overlap, because a terminal event was observed.
// R1-A82a is its control: the identical fixture without `ended` warns.
// SABOTAGE: treat `ended` as ordinary metadata -> the entry warns again and the
// silence assertion goes red.
test('R1-A87: an ENDED (inactive-confirmed) overlapping entry is skipped — the only status that silences an overlap', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { ...liveEntry('stopped-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 0 }), ended: { at: agoISO(0), event: 'subagent-stop' } },
    ]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// R1-A88: an entry whose `at` cannot be parsed is unknown/clock-unreadable. It
// still warns (it may be a real holder) and it never prints a fabricated age.
// The retired parked pin asserted the opposite (the TTL filter dropped it
// entirely); the tri-state admits it and labels it honestly.
// SABOTAGE: fall back to Date.now() for an unparseable `at` -> the entry reads
// as fresh, 'age unreadable' disappears and this goes red.
test('R1-A88: an entry with an unparseable `at` warns as unknown and prints "age unreadable" — never NaN, never a fabricated age', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      { agent_id: 'badclock00000001', agent_type: 'coder', session_id: 's1', files: ['src/parser.mjs'], at: 'whenever', attribution: 'block' },
    ]);
    const r = runHook(taskInput(dir, { prompt: 'Fix the parser in src/parser.mjs and keep the tests green.' }), dir);
    const ctx = parseAdditionalContext(r);
    assert.equal(r.code, 0);
    assert.doesNotMatch(ctx, /NaN/, `no fabricated age ever reaches the reader — ctx=${ctx}`);
    assert.match(ctx, /coder:badclock00000001/, 'the entry is admitted, not silently dropped');
    assert.match(ctx, /age unreadable/);
    assert.match(ctx, code('dispatch_status_unknown'));
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

// R1-A84 (re-cut from 'a small configured stale_minutes makes an entry stale'):
// the configured lease no longer decides WHETHER to warn — it decides which
// STATUS is claimed. Same fixture, same overlap, two different claims.
// SABOTAGE: hardcode the lease to the 60-minute default (ignore config) -> the
// unknown assertion goes red while the paired default-lease test below stays
// green, which is what proves the lease is configuration rather than a constant.
test('R1-A84: a small configured lease turns the SAME overlap from presumed-active into unknown — it never turns the warning off', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConfig(dir, { dispatch_register: { stale_minutes: 2 } });
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 5 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
    assert.match(parseAdditionalContext(r), code('dispatch_status_unknown'), 'out of the configured lease -> unknown');
  } finally {
    cleanup();
  }
});

test('R1-A84a: with no config.json at all the default 60-minute lease applies — a 30-minute-old entry is presumed-active and carries no uncertainty', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 30 })]);
    const r = runHook(taskInput(dir, { prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /presumed-active/);
    assert.doesNotMatch(ctx, code('dispatch_status_unknown'));
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

// R1-A89 (A6): every H26 advisory line carries a [snake_case] code token, on
// every status it can emit. Asserted as a SHAPE, not against a fixed code list,
// because the closed CODES set the sheet names has no member for the ordinary
// overlap advisory — flagged in the R1 report rather than invented here.
// SABOTAGE: render any one advisory line through a bare template string instead
// of the shared render() -> that line loses its token and this goes red.
test('R1-A89: every emitted H26 advisory line carries its [code] token — no untokened advisory prose', () => {
  const cases = [];
  const mk = (entries, prompt) => {
    const p = makeProject();
    writeRegisterRaw(p.dir, entries);
    cases.push([p, taskInput(p.dir, { prompt })]);
  };
  try {
    mk([liveEntry('fresh-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 0 })], 'please modify src/shared/util.mjs today');
    mk([liveEntry('old-1', 'coder', ['src/shared/util.mjs'], { minutesAgo: 90 })], 'please modify src/shared/util.mjs today');
    mk([liveEntry('foreign-1', 'coder', ['src/shared/util.mjs'], { sessionId: 's2' })], 'please modify src/shared/util.mjs today');
    mk('{not json', 'please modify src/shared/util.mjs today');

    for (const [{ dir }, input] of cases) {
      const ctx = parseAdditionalContext(runHook(input, dir));
      const lines = ctx.split('\n').filter((l) => l.trim().length > 0);
      assert.ok(lines.length > 0, 'each of these shapes must emit something');
      assert.ok(lines.some((l) => ANY_CODE.test(l)), `the advisory must carry a code token; got: ${ctx}`);
    }
  } finally {
    for (const [p] of cases) p.cleanup();
  }
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
