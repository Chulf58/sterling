// H26 EXTRACTION FIX — "a path named as a thing to RUN is not a path the lane
// will WRITE". SPEC ONLY, authored blind to the implementation.
//
// SOURCES (all knowledge-base / board records — spec, never implementation):
//   board 8f43e6b5 (JUST DO, extraction half) — the measured defect and the
//     sanctioned fix shape; feature_article d33e186a (parallel-lanes) — H26's
//     semantics, warn-only posture and existing ACs; research_finding
//     289cd172 — the extraction asymmetry corpus and the standing constraint
//     that the SHARED extractor (scripts/hooks/lib/dispatch-prompt.mjs) must
//     not change, because h19-dispatch-staging deliberately wants
//     over-capture; decision 41a28e1d — the advisory-never-denies posture.
//   Harness idiom, fixture shapes and assertion style are copied from
//     scripts/tests/h26-dispatch-overlap.test.mjs and
//     scripts/tests/h25-h26-advisory-precision.test.mjs (TESTS, never their
//     subjects' source). scripts/hooks/h26-dispatch-overlap.mjs was NOT read.
//
// THE DEFECT (board 8f43e6b5, measured across two consumer sessions at ~100%
// false-positive): H26 infers write territory by path-regex over the brief,
// so it classifies TOOL BINARIES and GATE-RUNNER paths as contended write
// territory. Real firings named `...Godot_v4.6.3-stable_win64_console.exe`
// and `addons/gdUnit4/bin/GdUnitCmdTool.gd` — tools every lane INVOKES, not
// territory any lane WRITES. Structural cause: briefs must spell gate
// commands out verbatim because H14 matches literal command prefixes, so
// every brief names the binaries and every concurrent pair "overlaps". The
// cost is not the noise but the MISS — a genuine overlap on a real source
// file was nearly buried, and one consumer stopped reading H26 entirely.
//
// SCOPE PINNED HERE — EXTRACTION ONLY. Executables are excluded from
// extracted territory, and paths appearing as COMMANDS rather than as edit
// targets are excluded. The larger redesign toward an explicit
// `declared_territory` on the dispatch is OUT OF SCOPE and no test here
// touches it.
//
// ANTI-SUPPRESSION IS THE POINT. An extraction filter that under-reports is
// worse than one that over-reports, so the CONTROL arms come first and are
// pinned at least as hard as the exclusions: a genuine overlap on a real
// source path must still fire — including a source path named in the same
// brief as an excluded binary, a source file under a tools/bin-adjacent
// directory, and a path whose name merely contains "exe". Every suppression
// test below is additionally SELF-CONTROLLING: the same brief also names a
// genuinely-intended overlapping source file under a second live entry, so a
// green result can never mean "nothing matched" — the advisory must name the
// genuine overlap in the same emission in which it stays silent about the
// tool path.
//
// EXPECTED FAILURE SHAPE, per test, is stated in each test's header block
// alongside the ONE-LINE SABOTAGE that must turn it red.
//
// JUDGMENT CALLS where the records were silent (flagged, not silently
// decided — see the final report):
//   (1) EXECUTABLE FAMILY — RE-CUT 2026-08-29 by user ruling (sanctioned
//       repair, scripts/test-repair.mjs). Board 8f43e6b5 says ".exe and
//       friends" without enumerating. This suite ORIGINALLY pinned the
//       unconditional family as .exe .bat .cmd .dll .so .dylib, keeping only
//       `.sh` out. Independent review found that asymmetry to be a DEFECT:
//       `.bat` and `.cmd` are editable repo source on WINDOWS exactly as `.sh`
//       is on Linux, so the old R5 forced the hook to drop a genuinely-written
//       `.bat` from overlap warnings SILENTLY on Windows while warning
//       correctly for the same file role on Linux — a 1:1 Windows/Linux parity
//       violation, in the silent-under-warn direction this board item calls
//       worse than the noise it replaces.
//       PINNED NOW: the UNCONDITIONAL family is .exe .dll .so .dylib only —
//       artifacts that are invoked or linked, never hand-edited source.
//       `.bat`, `.cmd` and `.sh` are ORDINARY EDITABLE SOURCE: they are
//       suppressed by the COMMAND-CONTEXT rule when they are invoked (R5a),
//       and they REMAIN territory when a lane genuinely rewrites them
//       (R5b `.sh` = the Linux baseline; R5c `.bat`/`.cmd` = the parity arm).
//   (2) EXECUTABLES ARE EXCLUDED UNCONDITIONALLY, not only inside a command
//       line (test R2 pins the prose form). Rationale: no lane contends over
//       a binary as write territory, and the measured briefs name the binary
//       in both shapes.
//   (3) THE UNIT OF EXCLUSION FOR NON-EXECUTABLES IS THE MENTION, NOT THE
//       PATH (test C4). If any mention of a path in the brief is an
//       edit-target mention, the path stays in territory even when another
//       mention of the same path is a command. Under-reporting is the
//       expensive failure; this is where that principle bites hardest.
//   (4) Fixtures use UNQUOTED repo-relative executable paths so extraction is
//       unambiguous on both Windows and Linux (the measured firing quoted an
//       absolute Windows path; quoting/absolutization is a separate concern
//       and is not pinned here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H26_PATH = join(root, 'scripts', 'hooks', 'h26-dispatch-overlap.mjs');

// ===========================================================================
// Harness (mirrors scripts/tests/h25-h26-advisory-precision.test.mjs)
// ===========================================================================

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h26-runterr-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// attribution:'block' is required for H26 to consider an entry at all
// (decision h22-per-block-attribution); every fixture here exercises
// EXTRACTION, not attribution, so all entries carry the precise shape.
function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0 } = {}) {
  return { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo), attribution: 'block' };
}

function writeRegister(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
}

function taskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1' }) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', session_id, cwd: dir, tool_input: { subagent_type, prompt } };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [H26_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

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

function pathRe(p) {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

// The positive half: the advisory fires and names this path + this entry.
function assertWarnsOn(r, path, [agentType, agentId], label) {
  assert.notEqual(r.code, 2, `H26 must never deny (${label}); stderr: ${r.stderr}`);
  assert.equal(r.code, 0, `expected exit 0 (${label}), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, `expected a non-empty overlap advisory (${label}); got empty additionalContext`);
  assert.match(ctx, pathRe(path), `advisory must name the genuinely contended path '${path}' (${label})`);
  assert.ok(ctx.includes(`${agentType}:${agentId}`), `advisory must name '${agentType}:${agentId}' (${label}); got: ${ctx}`);
  return ctx;
}

// The suppression half: this tool/command path is not territory.
function assertNotTerritory(ctx, path, [agentType, agentId], label) {
  assert.doesNotMatch(ctx, pathRe(path), `'${path}' is invoked, not written — it must not be reported as contended territory (${label}); got: ${ctx}`);
  assert.ok(!ctx.includes(`${agentType}:${agentId}`), `must not name the tool-path-only entry '${agentType}:${agentId}' (${label}); got: ${ctx}`);
}

// Realistic Sterling/consumer brief shapes.
const GODOT_EXE = 'tools/godot/Godot_v4.6.3-stable_win64_console.exe';
const GDUNIT_RUNNER = 'addons/gdUnit4/bin/GdUnitCmdTool.gd';
const SOURCE = 'game/ui/garage.gd';

// ===========================================================================
// CONTROL ARMS — placed first. Each must pass for the OPPOSITE reason from
// the suppression tests: they prove the extractor still FINDS real territory,
// so a green suppression result cannot be explained by "extraction stopped
// working". All five are expected GREEN today (plain overlap detection is
// shipped behavior, article d33e186a AC1) and must STAY green.
// ===========================================================================

// C1 — the floor. If this ever goes red the mechanism is dead, not tuned.
// TODAY: GREEN.
// SABOTAGE: force the file-intersection result to `[]` before the warn branch
// (one line) — C1 goes red immediately, and so does every other control.
test('H26 C1 CONTROL: a plain genuine overlap on a real source path still fires (no tool text anywhere in the brief)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE])]);
    const r = runHook(taskInput(dir, { prompt: `Implement the garage rebuild in ${SOURCE}.` }), dir);
    assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'C1 plain overlap');
  } finally {
    cleanup();
  }
});

// C2 — THE ANTI-SUPPRESSION ANCHOR, and the exact shape the measured miss
// took: the real source overlap sits in the SAME brief as the verbatim gate
// command naming the binaries. The fix must not take the source path down
// with the tools. Asserted positively here, in isolation from any suppression
// assertion, so its verdict has exactly one cause.
// TODAY: GREEN (it fires — buried among the false positives, but it fires).
// SABOTAGE: widen the new exclusion from "the mention is a command" to "the
// brief contains a command line" (one line: return [] from the outgoing
// extraction when /--headless|--test|\.exe\b/ matches the prompt) — C2 goes
// red while every suppression test below stays green. This is the precise
// over-correction the board warns against, and C2 is what catches it.
test('H26 C2 CONTROL: a genuine source overlap still fires when the same brief spells out a verbatim gate command naming an excluded binary', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE])]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: garage rebuild.',
          '',
          'Gate (run verbatim — H14 matches literal command prefixes):',
          `${GODOT_EXE} --headless --path . -s ${GDUNIT_RUNNER} -a game/tests/ui`,
          '',
          `Implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'C2 source overlap beside a gate command');
  } finally {
    cleanup();
  }
});

// C3 — a source file the lane genuinely WRITES that happens to live under a
// tools/bin-adjacent directory. The exclusion must key on how the path is
// USED, never on a `bin/`-segment or a `tools/` prefix.
// TODAY: GREEN.
// SABOTAGE: implement the exclusion as a path-shape blanket instead of a
// usage test (one line: drop any candidate matching /(^|\/)(bin|tools)\//) —
// C3 goes red while R3 still passes, proving the blanket is the wrong shape.
test('H26 C3 CONTROL: a source file under a tools/bin-adjacent directory that the lane genuinely writes still fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-tools', 'coder', ['tools/bin/report_writer.gd'])]);
    const r = runHook(
      taskInput(dir, { prompt: 'Rewrite tools/bin/report_writer.gd so it emits JSON instead of the current table.' }),
      dir
    );
    assertWarnsOn(r, 'tools/bin/report_writer.gd', ['coder', 'sub-tools'], 'C3 genuine write under tools/bin');
  } finally {
    cleanup();
  }
});

// C4 — MENTION-LEVEL, NOT PATH-LEVEL. The same path appears twice: once as a
// thing to run, once as a thing to rewrite. The edit-target mention wins;
// under-reporting is the expensive failure.
// TODAY: GREEN.
// SABOTAGE: make the exclusion path-level rather than mention-level (one
// line: if any mention of a path is command-shaped, drop the path from the
// candidate set) — C4 goes red; every suppression test below stays green,
// which is exactly what makes this hollow-looking mutation invisible without
// C4.
test('H26 C4 CONTROL: a path named BOTH as a command and as an edit target stays territory — the edit-target mention wins', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-tools', 'coder', ['tools/bin/report_writer.gd'])]);
    const r = runHook(
      taskInput(dir, {
        prompt:
          'First run tools/bin/report_writer.gd to capture the current output, then rewrite tools/bin/report_writer.gd so it emits JSON.',
      }),
      dir
    );
    assertWarnsOn(r, 'tools/bin/report_writer.gd', ['coder', 'sub-tools'], 'C4 dual mention, edit target wins');
  } finally {
    cleanup();
  }
});

// C5 — the executable-family filter must match the EXTENSION, not a substring
// of the filename.
// TODAY: GREEN.
// SABOTAGE: implement the executable test as a substring check (one line:
// `if (/exe/i.test(candidate)) continue;` instead of an extension match) —
// C5 goes red while R1/R2/R5 stay green.
test('H26 C5 CONTROL: a source file whose NAME merely contains "exe" (scripts/executor.mjs) still fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-exec', 'coder', ['scripts/executor.mjs'])]);
    const r = runHook(taskInput(dir, { prompt: 'Add the retry branch to scripts/executor.mjs.' }), dir);
    assertWarnsOn(r, 'scripts/executor.mjs', ['coder', 'sub-exec'], 'C5 "exe" substring is not an executable');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// EXCLUSIONS — RED today (this is the defect). Every one is self-controlling:
// the positive assertion runs FIRST and must pass for the opposite reason.
// ===========================================================================

// R1 — the measured firing: the gate binary, named inside the verbatim gate
// command a brief is REQUIRED to spell out because H14 matches literal
// command prefixes.
// TODAY: RED — the binary is extracted as candidate territory and overlaps
// the live entry that registered it the same way, so the advisory names
// GODOT_EXE and coder:sub-exe.
// SABOTAGE: delete the executable-extension exclusion from the outgoing
// candidate filter (one line) — the exe leaks back in and R1's suppression
// half goes red while its control half stays green.
test('H26 R1: an executable named inside a verbatim gate command is not extracted as write territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-exe', 'coder', [GODOT_EXE])]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          `Gate, run verbatim: ${GODOT_EXE} --headless --path . -a game/tests/ui`,
          '',
          `Then implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R1 control half');
    assertNotTerritory(ctx, GODOT_EXE, ['coder', 'sub-exe'], 'R1 gate binary in a command');
  } finally {
    cleanup();
  }
});

// R2 — the same binary named in PROSE rather than on a command line. Pins
// judgment call (2): executables are excluded unconditionally, because no
// lane contends over a binary as write territory.
// TODAY: RED, same mechanism as R1.
// SABOTAGE: gate the executable exclusion on command context (one line:
// only drop an executable when its mention is command-shaped) — R2's
// suppression half goes red while R1 stays green.
test('H26 R2: an executable named in prose (not on a command line) is still not extracted as write territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-exe', 'coder', [GODOT_EXE])]);
    const r = runHook(
      taskInput(dir, {
        prompt: `The gate for this lane uses ${GODOT_EXE}, which is already installed on the machine. Implement the rebuild in ${SOURCE}.`,
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R2 control half');
    assertNotTerritory(ctx, GODOT_EXE, ['coder', 'sub-exe'], 'R2 gate binary in prose');
  } finally {
    cleanup();
  }
});

// R3 — the second measured firing, and the one an extension filter alone
// cannot reach: a NON-executable gate-runner (`.gd` source, under `bin/`)
// passed as an argument of the run command. It is invoked, not written.
// C3 and C4 are this test's paired controls: the same directory shape, and
// the same path in an edit-target mention, must both still fire.
// TODAY: RED — the runner path is extracted and overlaps its live entry.
// SABOTAGE: delete the command-context exclusion from the outgoing candidate
// filter (one line) — R3's suppression half goes red; C3/C4 are unaffected,
// which is what proves the exclusion is usage-scoped rather than a blanket.
test('H26 R3: a gate-runner path passed as an argument of a run command (addons/gdUnit4/bin/GdUnitCmdTool.gd) is not extracted as write territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-runner', 'coder', [GDUNIT_RUNNER])]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          `Gate, run verbatim: ${GODOT_EXE} --headless --path . -s ${GDUNIT_RUNNER} -a game/tests/ui`,
          '',
          `Then implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R3 control half');
    assertNotTerritory(ctx, GDUNIT_RUNNER, ['coder', 'sub-runner'], 'R3 gate runner as a command argument');
  } finally {
    cleanup();
  }
});

// R4 — the same shape in Sterling's own native toolchain form: a test path
// named only as the argument of `node --test`. The lane runs it; it does not
// author it. (C4 is the paired control: a brief that ALSO says "author" that
// same path keeps it as territory.)
// TODAY: RED.
// SABOTAGE: restrict the command-context exclusion to lines whose first token
// ends in an executable extension (one line) — `node --test …` is no longer
// recognized as a command line, R4's suppression half goes red, R3 stays
// green.
test('H26 R4: a path named only as the argument of `node --test` is not extracted as write territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-src', 'coder', ['scripts/hooks/h26-dispatch-overlap.mjs']),
      liveEntry('sub-test', 'test-writer', ['scripts/tests/h26-dispatch-overlap.test.mjs']),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'Fix the extraction defect in scripts/hooks/h26-dispatch-overlap.mjs.',
          'Gate: run `node --test scripts/tests/h26-dispatch-overlap.test.mjs` and report the summary.',
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, 'scripts/hooks/h26-dispatch-overlap.mjs', ['coder', 'sub-src'], 'R4 control half');
    assertNotTerritory(ctx, 'scripts/tests/h26-dispatch-overlap.test.mjs', ['test-writer', 'sub-test'], 'R4 node --test argument');
  } finally {
    cleanup();
  }
});

// R5 — the executable FAMILY beyond `.exe` (judgment call (1), RE-CUT
// 2026-08-29): compiled/linked artifacts only — `.dll .so .dylib` beside
// `.exe`. These are never hand-edited source on any platform, so the
// exclusion is unconditional (prose or command line alike, per R2).
// `.bat`, `.cmd` and `.sh` are NOT in this family — see R5a/R5b/R5c.
// TODAY: RED for every member (the extraction fix is not landed).
// SABOTAGE: narrow the executable-extension set to `.exe` only (one line) —
// R5's suppression half goes red per member while R1/R2 stay green.
test('H26 R5: the unconditional executable family (.dll .so .dylib) is excluded from extracted territory, not just .exe', () => {
  const { dir, cleanup } = makeProject();
  const binaries = ['tools/lib/native.dll', 'tools/lib/native.so', 'tools/lib/native.dylib'];
  try {
    writeRegister(dir, [
      liveEntry('sub-src', 'coder', [SOURCE]),
      ...binaries.map((b, i) => liveEntry(`sub-bin-${i}`, 'coder', [b])),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          `Gate, run verbatim: ${GODOT_EXE} --headless --path .`,
          `The runner links tools/lib/native.dll, tools/lib/native.so and tools/lib/native.dylib depending on platform.`,
          '',
          `Implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R5 control half');
    binaries.forEach((b, i) => assertNotTerritory(ctx, b, ['coder', `sub-bin-${i}`], `R5 executable family member ${b}`));
  } finally {
    cleanup();
  }
});

// R5a — the FALSE POSITIVE THIS FIX EXISTS TO KILL, for the three editable
// script extensions. A `.bat`, a `.cmd` and a `.sh` named as a GATE COMMAND
// are invoked, not written: the COMMAND-CONTEXT rule (R3/R4) suppresses all
// three identically. This is the arm that must stay green when R5c lands —
// removing `.bat`/`.cmd` from the unconditional family must NOT reintroduce
// the gate-command noise.
// TODAY: GREEN for `.bat`/`.cmd` (they are currently dropped unconditionally,
// so they are suppressed here for the WRONG reason — R5c is what separates
// the two causes) and GREEN for `.sh` via command context.
// SABOTAGE: delete the command-context exclusion from the outgoing candidate
// filter (one line) — R5a's `.sh` suppression goes red immediately, and after
// R5c lands the `.bat`/`.cmd` suppressions go red with it; R5's compiled-family
// suppression stays green, which is what proves the two rules are distinct.
test('H26 R5a: a .bat, a .cmd and a .sh named as a GATE COMMAND are suppressed by the command-context rule (identically on Windows and Linux)', () => {
  const { dir, cleanup } = makeProject();
  const scripts = ['tools/bin/gate.bat', 'tools/bin/gate.cmd', 'tools/bin/gate.sh'];
  try {
    writeRegister(dir, [
      liveEntry('sub-src', 'coder', [SOURCE]),
      ...scripts.map((s, i) => liveEntry(`sub-script-${i}`, 'coder', [s])),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'Gate (run verbatim — H14 matches literal command prefixes):',
          `${scripts[0]} --headless`,
          `${scripts[1]} --headless`,
          `${scripts[2]} --headless`,
          '',
          `Implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R5a control half');
    scripts.forEach((s, i) => assertNotTerritory(ctx, s, ['coder', `sub-script-${i}`], `R5a invoked script ${s}`));
  } finally {
    cleanup();
  }
});

// R5b — THE LINUX BASELINE the parity arm is measured against: a `.sh` a lane
// genuinely REWRITES is ordinary editable repo source and IS write territory.
// Nothing about a shell script's extension makes it un-authorable. R5c must
// produce exactly this verdict for `.bat`/`.cmd`; the two tests are
// deliberately the same shape so the asymmetry is visible if it returns.
// TODAY: GREEN (nothing excludes `.sh`, and no mention here is command-shaped).
// SABOTAGE: add `.sh` to the unconditional executable-extension set (one
// line) — R5b goes red while R5a stays green, which is precisely the silent
// under-warn this suite now forbids.
test('H26 R5b PARITY BASELINE (Linux): a .sh named as an EDIT TARGET is genuine write territory and DOES fire', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-sh', 'coder', ['tools/bin/gate.sh'])]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: gate script rewrite.',
          'Rewrite tools/bin/gate.sh so it forwards the --headless flag and exits nonzero on a failed assertion.',
          '',
          `A second lane is implementing the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R5b control half');
    assertWarnsOn(r, 'tools/bin/gate.sh', ['coder', 'sub-sh'], 'R5b .sh edit target is territory');
  } finally {
    cleanup();
  }
});

// R5c — THE PARITY ARM, and the REASON FOR THE 2026-08-29 RE-CUT. A `.bat`
// and a `.cmd` are editable repo source on WINDOWS exactly as `.sh` is on
// Linux. The original R5 dropped them unconditionally, which forced the hook
// to stay SILENT about a lane genuinely rewriting a `.bat` — on Windows only,
// while warning correctly for the same file role on Linux. That is a 1:1
// Windows/Linux parity violation AND a silent under-warn, the failure
// direction board 8f43e6b5 calls worse than the noise it replaces.
// Same fixture shape as R5b on purpose: if these two ever disagree, the
// asymmetry is back.
// TODAY: RED — the current implementation still excludes `.bat`/`.cmd`
// unconditionally, so the advisory names neither and both assertWarnsOn calls
// fail on their `advisory must name the genuinely contended path` assertion.
// SABOTAGE: put `.bat` (or `.cmd`) back into the unconditional
// executable-extension set (one line) — R5c goes red on that member while
// R5a stays green, because R5a's mentions are command-shaped and would be
// suppressed either way. R5a therefore CANNOT catch this regression; R5c is
// the only pin on it.
test('H26 R5c WINDOWS/LINUX PARITY: a .bat and a .cmd named as an EDIT TARGET are genuine write territory and DO fire, exactly as .sh does', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-src', 'coder', [SOURCE]),
      liveEntry('sub-bat', 'coder', ['tools/bin/gate.bat']),
      liveEntry('sub-cmd', 'coder', ['tools/bin/gate.cmd']),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: gate script rewrite (Windows).',
          'Rewrite tools/bin/gate.bat so it forwards the --headless flag and exits nonzero on a failed assertion.',
          'Rewrite tools/bin/gate.cmd the same way.',
          '',
          `A second lane is implementing the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R5c control half');
    assertWarnsOn(r, 'tools/bin/gate.bat', ['coder', 'sub-bat'], 'R5c .bat edit target is territory (parity with .sh)');
    assertWarnsOn(r, 'tools/bin/gate.cmd', ['coder', 'sub-cmd'], 'R5c .cmd edit target is territory (parity with .sh)');
  } finally {
    cleanup();
  }
});

// R6 — THE MEASURED COMPOSITE (board 8f43e6b5, session 2026-08-28-2101): the
// exact three-entry firing, with the real overlap on a source file sitting
// inside it. The whole point of the fix is that the advisory reports ONE
// path, not three. Also pins the count: no extra dispatch identities.
// TODAY: RED — all three entries are named, which is the burial the board
// describes.
// SABOTAGE: either exclusion removed (executable-extension OR command-context,
// one line each) turns this red; its control half (garage.gd + coder:sub-src)
// is what proves the advisory is still alive rather than silenced.
test('H26 R6 MEASURED COMPOSITE: the real firing reports ONLY the genuine source overlap, not the binary and not the gate runner', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-exe', 'coder', [GODOT_EXE]),
      liveEntry('sub-runner', 'coder', [GDUNIT_RUNNER]),
      liveEntry('sub-src', 'coder', [SOURCE]),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: garage rebuild.',
          '',
          'Gate (run verbatim — H14 matches literal command prefixes):',
          `${GODOT_EXE} --headless --path . -s ${GDUNIT_RUNNER} -a game/tests/ui`,
          '',
          `Implement the rebuild in ${SOURCE}. Report the gate summary when done.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'R6 control half — the buried true positive');
    assertNotTerritory(ctx, GODOT_EXE, ['coder', 'sub-exe'], 'R6 gate binary');
    assertNotTerritory(ctx, GDUNIT_RUNNER, ['coder', 'sub-runner'], 'R6 gate runner');
  } finally {
    cleanup();
  }
});

// R7 — the posture invariant (article d33e186a AC1, decision 41a28e1d): the
// new extraction filter is still advisory. No new shape may deny, and none
// may crash the hook into the internal-failure exit either.
// TODAY: GREEN (H26 has never exited 2) — pinned so the fix cannot introduce
// a throwing filter on an odd command line.
// SABOTAGE: make the new filter throw on a path with no extension (one line:
// `candidate.split('.').pop().toLowerCase()` on a value the filter assumed
// non-null) — the hook exits nonzero and R7 goes red.
test('H26 R7 posture: none of the new tool/command shapes ever denies (exit 2) or fails internally (exit 1)', () => {
  const projects = [];
  try {
    const prompts = [
      `${GODOT_EXE} --headless -s ${GDUNIT_RUNNER}`,
      'run `node --test` with no path at all',
      `weird command line: ./ --  -s  ${GODOT_EXE}`,
      `${SOURCE}`,
      'tools/bin/no_extension_here && tools/bin/gate.bat',
    ];
    for (const prompt of prompts) {
      const p = makeProject();
      projects.push(p);
      writeRegister(p.dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-exe', 'coder', [GODOT_EXE])]);
      const r = runHook(taskInput(p.dir, { prompt }), p.dir);
      assert.equal(r.code, 0, `advisory hook must exit 0 for prompt ${JSON.stringify(prompt)}; got ${r.code}, stderr: ${r.stderr}`);
    }
  } finally {
    for (const p of projects) p.cleanup();
  }
});

// ===========================================================================
// APPENDED 2026-08-29 — THE ENGLISH-VERB RUNNER HEADS (`make`, `go`).
//
// WHY THIS BLOCK EXISTS. The command-context rule (R3/R4) recognises a
// command line by walking back from a candidate path to a RUNNER HEAD token.
// The head list (`RUNNER_HEAD_RE` in the hook) was authored by hand and only
// `node` was ever test-required. Two of its members — `make` and `go` — are
// ORDINARY ENGLISH VERBS that routinely precede a path in a dispatch brief:
//
//     - make src/parser.mjs handle CRLF line endings
//     go through src/loader.mjs and hoist the dynamic imports
//
// In both lines the path is the lane's WRITE TARGET and, in the measured
// case, its ONLY mention in the brief. Treating the verb as a command head
// deleted the path from extracted territory, so a genuine live-lane overlap
// was SILENTLY NOT WARNED. That is the under-report direction — the direction
// board 8f43e6b5 exists because of, and the one it calls strictly worse than
// the noise it replaces. `make` and `go` have since been removed from the
// head list; the mutation check showed that removal turned NOTHING red across
// the whole H26 suite, i.e. the fix shipped completely unpinned. This block is
// that pin.
//
// DIRECTION OF THESE ARMS IS THE REVERSE OF THE BLOCK ABOVE. R1–R6 were
// authored RED against an unfixed implementation. Everything below is
// expected GREEN TODAY against the already-fixed implementation, and RED ONLY
// under its named sabotage. A green run of this block is therefore NOT a
// no-op — it is the pin holding. Each arm names the one-line sabotage that
// must flip it.
//
// CONTROL FIRST (C6). The opposite over-correction to the defect is "simplify
// the head list by emptying it", which would make every one of P1/P1a/P2/P2a
// pass while destroying R3/R4's suppression. C6 is a REAL runner head that
// must STAY suppressed, so the emptying cannot pass. `node --test <path>` is
// already covered by R4 and is NOT duplicated here; C6 adds the non-node head.
//
// `make <target>` — DELIBERATELY NOT PINNED (judgment call, stated not
// silently taken). A real `make` gate invocation names a TARGET, not a path
// (`make test`), and a bare target is not path-shaped, so nothing is extracted
// either way and there is no verdict to pin. The only shapes where `make`
// precedes a real path are `make -C packages/store test` / `make -f
// build/ci.mk`, where a FLAG sits between the head and the path. Under the
// current fix those directories/paths stay in extracted territory — an
// OVER-report, the cheap direction, and no stored record specifies a
// flag-adjacency discriminator. Pinning "make + path suppresses" would freeze
// an invented rule and re-open the exact silent-drop this block closes, so it
// is skipped on purpose; the residual over-report is an accepted, reported
// cost rather than an unnoticed one.
// ===========================================================================

// Appended fixture paths, kept distinct from the block above so a failure
// message names its own arm unambiguously.
const NPX_TOOL = 'scripts/tools/screenshot.mjs';
const MAKE_TARGET_PATH = 'src/parser.mjs';
const MAKE_SURE_PATH = 'scripts/lib/crlf-reader.mjs';
const GO_THROUGH_PATH = 'src/loader.mjs';
const GO_ADJACENT_PATH = 'src/registry.mjs';
// Registered by a live lane but never mentioned in any prompt below. Every
// FIRING arm asserts this stays unnamed, so a green can never be explained by
// "the advisory names every live entry" — the pin's verdict has one cause.
const NEVER_MENTIONED = 'src/never_mentioned_in_the_brief.mjs';

// C6 CONTROL — placed first in this block, and it carries the same weight as
// the pins. A genuine non-node runner head must STAY suppressed: `npx` with
// the script path directly after it, which is the one shape whose suppression
// has a single possible cause (no other token on the line is head-shaped).
// TODAY: GREEN — conditional on `npx` being a live member of RUNNER_HEAD_RE.
// I could not read the regex (read wall), and the head was taken from the
// dispatch brief. If C6 comes back RED, that is not a defect in the pin: it
// means `npx` is not a member — swap the head token for a confirmed
// non-node member, the fixture is otherwise head-agnostic.
// SABOTAGE: remove `npx` from RUNNER_HEAD_RE (or empty the head list to
// `node` only) — C6's suppression half goes red on the `is invoked, not
// written` assertion, while P1/P1a/P2/P2a below all STAY green. That
// asymmetry is the entire point of C6: the head list may be trimmed of
// English verbs, never emptied of real runners.
test('H26 C6 CONTROL: a real non-node runner head (`npx <path>`) still suppresses its script argument — trimming the head list must not empty it', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry('sub-src', 'coder', [SOURCE]), liveEntry('sub-npx', 'coder', [NPX_TOOL])]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: garage rebuild.',
          '',
          'Gate (run verbatim — H14 matches literal command prefixes):',
          `npx ${NPX_TOOL} --out tmp/shots`,
          '',
          `Implement the rebuild in ${SOURCE}.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, SOURCE, ['coder', 'sub-src'], 'C6 control half');
    assertNotTerritory(ctx, NPX_TOOL, ['coder', 'sub-npx'], 'C6 npx script argument stays suppressed');
  } finally {
    cleanup();
  }
});

// P1 — THE MEASURED DEFECT LINE. `make` used as the English verb it is, with
// the write target directly after it, and that line is the path's ONLY
// mention in the brief. The path IS territory and the advisory MUST fire.
// TODAY: GREEN (`make` was removed from RUNNER_HEAD_RE).
// SABOTAGE: re-add `make` to RUNNER_HEAD_RE (one token) — the walk classifies
// `make` as a command head, `src/parser.mjs` is dropped from extracted
// territory, the ONLY overlap disappears and the advisory is emitted empty:
// P1 goes red on `expected a non-empty overlap advisory (P1 make as an
// English verb)`. C6 stays green under this same sabotage.
test('H26 P1: `make <path> handle …` — the English verb `make` must not swallow the write target; the advisory FIRES', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-parser', 'coder', [MAKE_TARGET_PATH]),
      liveEntry('sub-quiet', 'coder', [NEVER_MENTIONED]),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: CRLF handling.',
          '',
          'Scope for this slice:',
          `- make ${MAKE_TARGET_PATH} handle CRLF line endings the way the reader already handles LF`,
          '- leave the tokenizer alone; a separate lane owns it',
          '',
          'Gate: run `node --test scripts/tests/parser.test.mjs` and report the summary.',
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, MAKE_TARGET_PATH, ['coder', 'sub-parser'], 'P1 make as an English verb');
    // Selectivity control: a green above must mean "this path was extracted",
    // never "every live entry gets named".
    assertNotTerritory(ctx, NEVER_MENTIONED, ['coder', 'sub-quiet'], 'P1 selectivity — an unmentioned live path is not named');
  } finally {
    cleanup();
  }
});

// P1a — the same verb with an intervening word, which is how `make` most often
// reaches a path in real brief prose ("make sure <path> still …"). Realistic
// input, and it also MEASURES how far the backwards walk skips.
// TODAY: GREEN.
// SABOTAGE: re-add `make` to RUNNER_HEAD_RE. EXPECTED RED — but conditionally:
// this arm flips only if the backwards walk skips intervening non-flag words
// (`sure`) to reach the head. If P1a stays GREEN under the sabotage while P1
// goes red, the arm is not hollow-by-accident — it has MEASURED that the walk
// stops at the first non-flag token, which is real information about the
// hook's reach and should be reported, not papered over. P1 is the
// unconditional pin; P1a is the reach probe.
test('H26 P1a: `make sure <path> still …` — an intervening word must not turn the verb into a command head; the advisory FIRES', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-crlf', 'coder', [MAKE_SURE_PATH]),
      liveEntry('sub-quiet', 'coder', [NEVER_MENTIONED]),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: reader hardening.',
          '',
          `make sure ${MAKE_SURE_PATH} still strips the trailing \\r before it splits, and add the regression case for a file with mixed endings.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, MAKE_SURE_PATH, ['coder', 'sub-crlf'], 'P1a make sure <path>');
    assertNotTerritory(ctx, NEVER_MENTIONED, ['coder', 'sub-quiet'], 'P1a selectivity — an unmentioned live path is not named');
  } finally {
    cleanup();
  }
});

// P2 — the `go` half of the defect, in the exact prose shape the fix report
// named: `go through <path> and …`, the path's only mention.
// TODAY: GREEN (`go` was removed from RUNNER_HEAD_RE).
// SABOTAGE: re-add `go` to RUNNER_HEAD_RE (one token) — the path is dropped,
// the sole overlap disappears, and P2 goes red on `expected a non-empty
// overlap advisory (P2 go through <path>)`. Same conditionality as P1a: this
// arm flips only if the walk skips `through` to reach `go`. P2a below is the
// unconditional `go` pin, so the pair cannot both be hollow.
test('H26 P2: `go through <path> and …` — the English verb `go` must not swallow the write target; the advisory FIRES', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-loader', 'coder', [GO_THROUGH_PATH]),
      liveEntry('sub-quiet', 'coder', [NEVER_MENTIONED]),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: cold-start regression.',
          '',
          `go through ${GO_THROUGH_PATH} and hoist the dynamic imports out of the request path — the lazy requires are what make the first render slow.`,
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, GO_THROUGH_PATH, ['coder', 'sub-loader'], 'P2 go through <path>');
    assertNotTerritory(ctx, NEVER_MENTIONED, ['coder', 'sub-quiet'], 'P2 selectivity — an unmentioned live path is not named');
  } finally {
    cleanup();
  }
});

// P2a — `go` DIRECTLY before the path, the terse checklist form ("go <path>
// and add …"). Deliberately head-adjacent: this is the arm that must flip
// under the `go` sabotage NO MATTER how far the backwards walk skips, so the
// `go` pin cannot be hollow the way the shipped fix was.
// TODAY: GREEN.
// SABOTAGE: re-add `go` to RUNNER_HEAD_RE — `go` sits immediately before
// `src/registry.mjs`, the path is dropped from territory, the sole overlap
// disappears and P2a goes red on `expected a non-empty overlap advisory (P2a
// go <path> head-adjacent)`. C6 stays green, which proves the head list is
// still doing its real job.
test('H26 P2a: `go <path>, add …` head-adjacent — the unconditional `go` pin; the advisory FIRES', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [
      liveEntry('sub-registry', 'coder', [GO_ADJACENT_PATH]),
      liveEntry('sub-quiet', 'coder', [NEVER_MENTIONED]),
    ]);
    const r = runHook(
      taskInput(dir, {
        prompt: [
          'LANE: adapter registration.',
          '',
          'Scope for this slice:',
          `- go ${GO_ADJACENT_PATH} and add the new adapter entry beside the node one`,
          '- keep the consistency check passing',
        ].join('\n'),
      }),
      dir
    );
    const ctx = assertWarnsOn(r, GO_ADJACENT_PATH, ['coder', 'sub-registry'], 'P2a go <path> head-adjacent');
    assertNotTerritory(ctx, NEVER_MENTIONED, ['coder', 'sub-quiet'], 'P2a selectivity — an unmentioned live path is not named');
  } finally {
    cleanup();
  }
});
