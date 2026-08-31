// THE ALL-TOOL LATCH GATE — S4r PART A.
//
// Spec: board `13d5f6e3-ca1d-431d-8c11-7ebd37bf6780` ("S4r — THE GLOBAL LATCH
// GATE + THE SEPARATE RECONCILIATION CLEARER"), PART A specifically, and
// decision `b-surface-adoption-point-closes-with-an-incident-bound-taint-latch-not-a-persisted-manifest`
// (bcd2cc09) RULING 6 (enforcement covers ALL agent tools, not just Bash),
// RULING 7 (the latch is a file; NO FIELD INSIDE IT MAY REDUCE ENFORCEMENT),
// and RULING 11 (fail-closed read, decided by SHAPE before contents).
//
// AND — the ruling that makes this gate part of the clearer's slice rather
// than a later one — decision
// `the-clearer-is-a-tripwire-not-a-boundary-and-the-all-tool-latch-gate-is-what-makes-its-precondition-true`
// (0ac7be95): "THE ALL-TOOL GATE IS EXACTLY WHAT MAKES THE PRECONDITION TRUE:
// while the latch exists, every spawned-agent tool call is denied, so the
// quiescence the clearer needs is ENFORCED rather than assumed." The clearer
// (scripts/enforcement-reconcile.mjs, pinned by
// scripts/tests/enforcement-reconcile.test.mjs) is a fail-closed TRIPWIRE, not
// an atomic boundary — no sequence of userspace observations establishes an
// immutable instant — so its honest guarantee rests on the quiescence THIS
// gate supplies. That is why the two ship together and why a failure in this
// file is not a local defect: it removes the precondition of the other suite.
//
// WHY THIS GATE EXISTS. `.sterling/enforcement-taint.json` is H17's taint
// latch: its PRESENCE is the verdict. Today the latch gates ONLY Bash
// (scripts/hooks/h17-bash-write-sweep.mjs ~:2677 states in terms that it does
// NOT block agent Edit, Write or Task), so an agent can still mutate the
// protected (B) surface — `.claude/agents/**`, `.claude/settings.local.json`,
// `.sterling/config.json` — WHILE an operator is reconciling. The clearer's
// honest guarantee needs the precondition this gate supplies: while the latch
// exists, no process capable of modifying the protected surface runs
// concurrently with reconciliation.
//
// Authored BLIND to any implementation of the gate (there is none yet) and to
// scripts/hooks/h17-bash-write-sweep.mjs, per H4 — no hook source was read to
// write these pins. Every expectation comes from the board item and the
// decision records above (spec, not implementation).
//
// ===========================================================================
// THE INTERFACE — UNDECIDED IN THE BRIEF, SO THIS FILE DECIDES IT AND THE
// IMPLEMENTER BINDS TO IT. If the gate ships under a different script name,
// change GATE_HOOK (one line) — nothing else in this file depends on the name.
//
//   scripts/hooks/h31-latch-tool-gate.mjs
//     A PreToolUse hook. Reads the hook payload as JSON on stdin.
//     DENY  = exit 2 with a message on stderr (the blocking convention;
//             `deny()` in scripts/hooks/lib/common.mjs is process.exit(2) —
//             decision b3cfdbc5 R1 cites it at :108).
//     ALLOW = exit 0.
//     The denial message NAMES THE TAINT LATCH, so a denial is attributable to
//     THIS gate rather than to any other hook that also exits 2. That is not
//     cosmetic: every assertion below that reads only an exit code would
//     otherwise be satisfiable by an unrelated refusal, which is precisely the
//     hollowness class the sibling clearer suite was repaired for.
//
// REGISTRATION. This gate rides EXISTING per-agent frontmatter — every agent
// template already declares `PreToolUse` with matcher `"*"` for
// h6-context-watch — NOT a global `hooks/hooks.json` entry. No fixture in this
// file assumes global registration, and no test here asserts anything about
// registration; that is a roster/registry concern (invariant 3) and is
// reported separately rather than pinned from the wrong side.
//
// ===========================================================================
// NAMED LIMIT — PINNED AS A COMMENT, DELIBERATELY NOT AS A TEST (bcd2cc09
// Ruling 11, verbatim in substance): "a wholly ABSENT `.sterling/` cannot be
// mechanically distinguished from a genuine non-Sterling project, because
// project discovery itself defines non-Sterling as 'no ancestor containing
// .sterling/sterling.db' (scripts/hooks/lib/common.mjs:62) — for H17's
// per-agent invocation, fail closed; for a new global PreToolUse "*" hook an
// explicit project-recognition rule is required, and THE LATCH READER ALONE
// MUST NOT BE CLAIMED TO SOLVE IT." This suite therefore never constructs a
// fixture with `.sterling/` deleted and never asserts what the gate does
// there. Do not read that absence as an untested branch nobody noticed: it is
// an OPEN design question that a test written today would falsely settle.
// Every fixture below has a real `.sterling/sterling.db`, so "is this a
// Sterling project" is never the variable under test.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/latch-tool-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  lstatSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

// ---- THE ONE LINE TO CHANGE IF THE GATE SHIPS UNDER ANOTHER NAME. ---------
// ===========================================================================
// HELD — THIS SUITE DOES NOT RUN, AND ITS AC-G4 IS KNOWN WRONG.
//
// Decision `ship-the-taint-clearer-alone-the-all-tool-gate-is-admission-
// control-not-quiescence` (knowledge_get 4b3183b8), user-decided 2026-08-30,
// SUPERSEDES the ship-both-together half of 0ac7be95 that this file's header
// above still argues from. Read 4b3183b8 before touching anything here.
//
//   R1 — the gate is ADMISSION CONTROL, not quiescence. It never made the
//        clearer's precondition true: a PreToolUse hook cannot revoke an
//        already-approved call, stop a surviving child, constrain another
//        session, or freeze an external editor. The header above states the
//        refuted rationale; it is left intact deliberately, because erasing it
//        would erase the fact that a ruling was made on a premise that failed.
//   R2 — per-agent frontmatter registration is CIRCULAR and fatal as designed:
//        the gate would live inside `.claude/agents/**`, exactly the surface
//        the tamper modifies. Tamper-resistant registration must sit outside
//        it, which needs the live subagent-delivery probe (b3cfdbc5 R4) that
//        HAS NOT BEEN RUN.
//   R5 — the gate is HELD pending that probe, and THIS FILE "PINS THE UNSAFE
//        IDENTITY INTERPRETATION (absent agent_id treated as conductor,
//        requiring allow) and MUST BE INVERTED, not adopted, whenever the gate
//        is built." AC-G4 below is that pin. Do NOT implement against it.
//
// The suite is skipped rather than deleted: the other seven ACs are sound spec
// for the mechanism if it is ever built, and a deleted file cannot carry the
// inversion instruction to whoever builds it. Skipped rather than left red
// because a permanently-red suite trains everyone to ignore a red suite.
// TO REVIVE: run the probe, invert AC-G4 to deny on absent/malformed identity,
// move registration out of agent frontmatter, then drop the skip flag below.
// ===========================================================================

const GATE_HOOK = 'h31-latch-tool-gate.mjs';
const GATE_HOOK_PATH = join(HOOKS, GATE_HOOK);

function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Host-capability probes. Copied in shape from
// scripts/tests/enforcement-reconcile.test.mjs (itself copied from
// h17-b-taint-latch.test.mjs / h17-baseline-symlink.test.mjs). A fixture this
// host cannot construct honestly is SKIPPED, never faked.
// ---------------------------------------------------------------------------
const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-latchgate-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

const UNREADABLE_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-latchgate-unreadprobe-'));
    const p = join(d, 'f');
    writeFileSync(p, 'x');
    chmodSync(p, 0o000);
    try {
      readFileSync(p);
      return 'this process can read a 0o000 file (likely running as root/uid 0) — the unreadable-latch fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' ? false : `unexpected error probing unreadable-file support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `unreadable-file fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(join(d, 'f'), 0o644);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

// The denial-wording contract. A bare `code === 2` proves only that SOME hook
// refused; these make the refusal attributable to the latch gate.
const DENY = {
  // The gate's own subject. Any denial this suite accepts must name it.
  latch: /taint|latch|enforcement-taint/i,
  // Wording the gate must NOT emit while a latch is present — the sibling
  // clearer suite measured a pin going hollow exactly this way (an unreadable
  // latch silently reported as an absent one).
  absentish: /\bno latch\b|latch (is )?absent|not tainted|nothing to (do|block)|no incident/i,
};

// Copied in shape from the makeGitProject idiom in
// scripts/tests/enforcement-reconcile.test.mjs, minus git: this gate reads the
// latch and the payload, never the repository, so a git working tree would be
// fixture weight with no pin behind it. `.sterling/sterling.db` IS present in
// every fixture on purpose — see the NAMED LIMIT above.
function makeProject() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-latchgate-')));

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');

  const cleanup = () => {
    try {
      chmodSync(latchPath(dir), 0o644);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

function plantLatch(dir, body = { note: 'unattested (B) modify detected by H17 Post', at: '2026-06-10T12:00:00.000Z', incident: [] }) {
  writeFileSync(latchPath(dir), JSON.stringify(body));
}

function runGate(dir, over = {}) {
  const payload = {
    session_id: 's1',
    transcript_path: join(dir, 'transcripts', 's1.jsonl'),
    cwd: dir,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_use_id: 'toolu_test_0001',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    ...over,
  };
  const r = spawnSync(process.execPath, [GATE_HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: dir,
    timeout: 30_000,
  });
  return { code: r.status, stderr: oneLine(r.stderr), stdout: r.stdout ?? '' };
}

const AGENT = { agent_id: 'agent-ae18832bcbaf070cc' };

// THE TOOL TABLE. Read the last entry carefully: it is a tool that does not
// exist and never will. It is here because the RULE is "no agent tool calls
// while latched", NOT "these named tools are blocked" — an implementation that
// enumerates `Edit|Write|Bash|Task` passes every other row here and fails that
// one, which is exactly the discrimination the board asked for.
const AGENT_TOOLS = [
  { tool_name: 'Edit', tool_input: { file_path: 'src/feature.ts', old_string: 'x = 1', new_string: 'x = 2' } },
  { tool_name: 'Write', tool_input: { file_path: 'src/new.ts', content: 'export const y = 2;\n' } },
  { tool_name: 'MultiEdit', tool_input: { file_path: 'src/feature.ts', edits: [] } },
  { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'nb.ipynb', new_source: 'x' } },
  { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
  { tool_name: 'Read', tool_input: { file_path: 'src/feature.ts' } },
  { tool_name: 'Grep', tool_input: { pattern: 'x' } },
  { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
  { tool_name: 'Task', tool_input: { subagent_type: 'coder', prompt: 'implement the thing' } },
  { tool_name: 'Agent', tool_input: { subagent_type: 'coder', prompt: 'implement the thing' } },
  { tool_name: 'WebFetch', tool_input: { url: 'https://example.invalid/' } },
  { tool_name: 'TodoWrite', tool_input: { todos: [] } },
  { tool_name: 'mcp__plugin_sterling_sterling__knowledge_create', tool_input: { type: 'decision' } },
  { tool_name: 'SomeFutureMutatingToolThatDoesNotExistYet', tool_input: { anything: true } },
];

// ===========================================================================
// AC-G0 — THE INTERFACE EXISTS. Placed first so the RED shape of every test
// below is a single named cause rather than fourteen identical spawn failures
// whose message is a bare MODULE_NOT_FOUND.
//
// EXPECTED FAILURE SHAPE (RED): the gate hook does not exist yet, so this
// assertion fires naming the declared path.
//
// SABOTAGE: delete scripts/hooks/h31-latch-tool-gate.mjs — this fires.
// ===========================================================================
test.skip('AC-G0: the latch tool gate hook exists at the declared path', () => {
  assert.equal(
    existsSync(GATE_HOOK_PATH),
    true,
    `THE INTERFACE THIS FILE DECIDES: the all-tool latch gate must live at scripts/hooks/${GATE_HOOK} (a PreToolUse hook, exit 2 = deny, exit 0 = allow, denial text naming the taint latch). If it ships under another name, change GATE_HOOK at the top of this file.`
  );
});

// ===========================================================================
// AC-G1 — THE ANTI-VACUITY CONTROL, PLACED FIRST AMONG THE BEHAVIOURAL PINS.
// With NO latch present, NOTHING is denied — across the whole tool table, for
// a call that carries an agent identity.
//
// WHY IT IS FIRST AND WHY IT IS NOT OPTIONAL: every other test in this file
// asserts a DENIAL, and "a denial happened" has more than one possible cause.
// An unconditional-deny hook — three lines, no latch read at all — passes every
// single one of them identically. This control must pass FOR THE OPPOSITE
// REASON, so a green suite carries its own evidence that the gate is reading
// the latch rather than refusing everything.
//
// EXPECTED FAILURE SHAPE (RED): AC-G0's cause — the hook does not exist, so
// spawnSync returns code 1 (MODULE_NOT_FOUND) and the `code === 0` assertion
// fires naming the tool row.
//
// SABOTAGE: make the gate deny unconditionally (drop the latch-presence read
// and always call deny()) — every row here flips from 0 to 2. This is the one
// sabotage that NO other test in this file can see.
// ===========================================================================
test.skip('AC-G1 CONTROL: with NO latch present, an agent tool call is NOT denied — the gate is not an unconditional deny', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists');

    for (const row of AGENT_TOOLS) {
      const r = runGate(dir, { ...AGENT, ...row });
      assert.equal(
        r.code,
        0,
        `CONTROL: with no latch, ${row.tool_name} from an agent must proceed. A denial here means the gate refuses without reading the latch, which would make every other pin in this file vacuous — stderr: ${r.stderr}`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-G2 — THE RULING: while the latch exists, a SPAWNED AGENT's tool call is
// DENIED. Table-driven across the full surface — Edit, Write, Bash, Read,
// Task/Agent, MCP tools, and a tool that does not exist.
//
// THE LAST ROW IS THE POINT. The board's words: "a future mutating tool would
// silently fall outside any enumerated list", and "a taint latch means 'the
// active enforcement model is not trusted', not 'another write would be bad'".
// An implementation keyed on a tool allow/deny list passes thirteen rows here
// and fails the fourteenth.
//
// EXPECTED FAILURE SHAPE (RED): the hook does not exist — code 1, not 2 — so
// the first row's assertion fires.
//
// SABOTAGE: restrict the gate to an enumerated list
// (`if (!['Edit','Write','Bash','Task'].includes(tool_name)) allow()`) — the
// Read, Grep, Glob, WebFetch, TodoWrite, MCP and future-tool rows flip to 0.
// SECOND SABOTAGE (aimed at the wording, which is what makes a `code === 2`
// attributable): deny with a message that never names the latch — the stderr
// assertion fires while the exit code still reads 2.
// ===========================================================================
test.skip('AC-G2: while the latch exists, EVERY spawned-agent tool call is denied — the rule, not an enumerated tool list', () => {
  const { dir, cleanup } = makeProject();
  try {
    plantLatch(dir);

    for (const row of AGENT_TOOLS) {
      const r = runGate(dir, { ...AGENT, ...row });
      assert.equal(
        r.code,
        2,
        `THE RULING: no agent tool calls while latched — ${row.tool_name} must be DENIED (exit 2). stderr: ${r.stderr}`
      );
      assert.match(
        r.stderr,
        DENY.latch,
        `the denial must NAME the taint latch, so a refusal is attributable to THIS gate and not to some other hook that also exits 2 — ${row.tool_name} stderr: ${r.stderr}`
      );
      assert.doesNotMatch(
        r.stderr,
        DENY.absentish,
        `a latch IS present; wording that reads as "no latch / nothing to block" would mean the denial came from somewhere other than the latch read — ${row.tool_name} stderr: ${r.stderr}`
      );
    }
    assert.equal(existsSync(latchPath(dir)), true, 'the gate never removes the latch — clearing is the reconciler\'s job alone (bcd2cc09 Ruling 5)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-G3 — TASK/AGENT GETS ITS OWN NAMED TEST. It is covered by AC-G2's table,
// and it is repeated here on purpose because it is the case that matters most
// and the one an implementer is most likely to reason past.
//
// bcd2cc09 Ruling 6, in substance: `.claude/agents/**` IS the agent grant
// definitions, and a tampered grant is CONSUMED BY DISPATCH, not merely
// written. `Task`/`Agent` INSTANTIATES a role from those files. A gate that
// blocks Edit and Write while allowing dispatch permits exactly the harm the
// latch exists to prevent — the tamper already happened, and dispatch is how it
// gets executed. Blocking the pen while leaving the trigger is not a gate.
//
// EXPECTED FAILURE SHAPE (RED): hook absent — code 1.
//
// SABOTAGE: exempt dispatch (`if (tool_name === 'Task' || tool_name ===
// 'Agent') allow()`), which is exactly the "let the agent wind down
// gracefully" reflex — AC-G2's table and this test both flip to 0, and nothing
// else in the suite notices.
// ===========================================================================
test.skip('AC-G3: dispatch (Task/Agent) is denied while latched — a tampered grant is CONSUMED by dispatch, not merely written', () => {
  const { dir, cleanup } = makeProject();
  try {
    plantLatch(dir);

    for (const tool of ['Task', 'Agent']) {
      const r = runGate(dir, {
        ...AGENT,
        tool_name: tool,
        tool_input: { subagent_type: 'coder', prompt: 'instantiate a role from .claude/agents/**' },
      });
      assert.equal(
        r.code,
        2,
        `THE RULING: ${tool} must be denied while latched. Allowing dispatch lets an already-tampered .claude/agents/** grant be instantiated, which is the harm the latch exists to prevent. stderr: ${r.stderr}`
      );
      assert.match(r.stderr, DENY.latch, `the ${tool} denial names the taint latch — stderr: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-G4 — THE CONDUCTOR IS EXEMPT (bcd2cc09 Ruling 6: "with CONDUCTOR calls
// exempt (identified by ABSENT `agent_id`)", and Ruling 10: "no deadlock
// results, because the conductor's own calls are exempt from the latch gate
// and can therefore run both the producer and the reconciler; the conductor
// must NEVER be required to hand-edit the latch").
//
// This is the second half of the anti-vacuity evidence and it is a SEPARATE
// discrimination from AC-G1: AC-G1 varies the LATCH and holds identity fixed;
// this varies IDENTITY and holds the latch fixed. Together they prove the gate
// keys on both inputs. Either alone is satisfiable by an implementation that
// ignores the other.
//
// NOT PINNED HERE, DELIBERATELY: what an EMPTY-STRING `agent_id` means. Absent
// is the conductor identity the ruling names; `''` is a shape the ruling does
// not rule on, and a test written today would falsely settle it. Reported as
// unresolved rather than guessed.
//
// EXPECTED FAILURE SHAPE (RED): hook absent — code 1, not 0.
//
// SABOTAGE: deny on latch presence alone, ignoring `agent_id` — every row here
// flips to 2, and the conductor can no longer run the reconciler that is the
// only sanctioned way out of the latch (a self-inflicted deadlock, which is
// the inverted-protection trap Ruling 10 names explicitly).
// ===========================================================================
test.skip('AC-G4: a CONDUCTOR call (absent agent_id) proceeds even while latched — otherwise the only exit from the latch is itself blocked', () => {
  const { dir, cleanup } = makeProject();
  try {
    plantLatch(dir);
    assert.equal(existsSync(latchPath(dir)), true, 'PRECONDITION: the latch is present for every row below');

    for (const row of AGENT_TOOLS) {
      const r = runGate(dir, row); // NOTE: no agent_id — this IS the conductor identity
      assert.equal(
        r.code,
        0,
        `THE RULING: the conductor is exempt. ${row.tool_name} must proceed for a caller with no agent_id, or the conductor cannot run the producer and the reconciler that discharge the incident. stderr: ${r.stderr}`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-G5 — NO FIELD INSIDE THE LATCH MAY REDUCE ENFORCEMENT (bcd2cc09 Ruling 7,
// verbatim in substance: "no `cleared`, no `trusted`, no expiry, no session
// key, no boolean that can make it inactive. Any leaf presence, or any abnormal
// leaf shape, means TAINTED"). PRESENCE IS THE VERDICT; the body is diagnostic
// only.
//
// This is the forgery-economics half of the design: the latch is same-UID
// forgeable like everything else, and that is ACCEPTABLE precisely because
// forging it can only produce a loud denial, never a false allow. A body field
// that switches enforcement off converts the latch into something worth
// forging — the property that makes the stamp dangerous.
//
// EXPECTED FAILURE SHAPE (RED): hook absent — code 1.
//
// SABOTAGE: honour any body field (`if (body.cleared) allow()`, or an
// `expires_at` comparison) — the matching row flips to 0.
// ===========================================================================
test.skip('AC-G5: no field inside the latch body can reduce enforcement — presence is the verdict, the body is diagnostic only', () => {
  const bodies = [
    { label: 'cleared:true', body: { cleared: true, note: 'forged' } },
    { label: 'trusted:true', body: { trusted: true } },
    { label: 'active:false', body: { active: false, tainted: false } },
    { label: 'expired', body: { expires_at: '1970-01-01T00:00:00.000Z' } },
    { label: 'session key', body: { session_id: 's1', discharged_by_session: 's1' } },
    { label: 'empty object', body: {} },
    { label: 'empty array', body: [] },
  ];
  for (const { label, body } of bodies) {
    const { dir, cleanup } = makeProject();
    try {
      plantLatch(dir, body);
      const r = runGate(dir, { ...AGENT, tool_name: 'Edit', tool_input: { file_path: 'src/feature.ts', old_string: 'a', new_string: 'b' } });
      assert.equal(r.code, 2, `THE RULING: a latch body carrying ${label} still DENIES — presence alone is the verdict. stderr: ${r.stderr}`);
      assert.match(r.stderr, DENY.latch, `the ${label} denial names the taint latch — stderr: ${r.stderr}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// AC-G6 — AN ABNORMAL OR UNPARSEABLE LATCH SHAPE DENIES. It is NOT an absent
// latch (bcd2cc09 Ruling 11: classify by SHAPE before contents; "regular file =
// tainted regardless of contents; symlink, directory, FIFO/device, unreadable,
// or classification error = tainted/environment defect"; "malformed content
// changes the explanation, never the denial").
//
// The wording assertion is what keeps this from collapsing into AC-G2: a
// denial whose text reads "no latch / nothing to block" would mean the gate
// took the ABSENT path and denied for some unrelated reason. The sibling
// clearer suite measured that exact inversion (its AC-R15 was HOLLOW because
// an unreadable latch silently became an absent one and both assertions still
// held).
//
// EXPECTED FAILURE SHAPE (RED): hook absent — code 1.
//
// SABOTAGE: wrap the latch read in `try { ... } catch { allow() }` — the
// unparseable, directory, symlink and unreadable arms all flip to 0 while the
// well-formed AC-G2 rows stay green. That is the classic fail-OPEN-on-corrupt
// shape (anti-pattern e13f0fb5), and no other test in this file sees it.
// ===========================================================================
test.skip('AC-G6: an abnormal or unparseable latch DENIES — an abnormal latch is not an absent one', () => {
  const shapes = [
    { label: 'unparseable JSON', skip: false, plant: (dir) => writeFileSync(latchPath(dir), '{ not valid json,,,') },
    { label: 'empty file', skip: false, plant: (dir) => writeFileSync(latchPath(dir), '') },
    { label: 'JSON scalar (not an object)', skip: false, plant: (dir) => writeFileSync(latchPath(dir), '"tainted"') },
    { label: 'oversized body', skip: false, plant: (dir) => writeFileSync(latchPath(dir), JSON.stringify({ pad: 'x'.repeat(9 * 1024 * 1024) })) },
    { label: 'directory at the latch path', skip: false, plant: (dir) => mkdirSync(latchPath(dir), { recursive: true }) },
    {
      label: 'symlink at the latch path',
      skip: SYMLINK_SKIP,
      plant: (dir) => {
        const victim = join(dir, 'VICTIM.txt');
        writeFileSync(victim, 'DO NOT TOUCH\n');
        symlinkSync(victim, latchPath(dir));
      },
    },
    {
      label: 'unreadable regular file',
      skip: UNREADABLE_SKIP,
      plant: (dir) => {
        plantLatch(dir);
        chmodSync(latchPath(dir), 0o000);
      },
    },
  ];

  for (const shape of shapes) {
    if (shape.skip) continue;
    const { dir, cleanup } = makeProject();
    try {
      shape.plant(dir);
      const r = runGate(dir, { ...AGENT, tool_name: 'Write', tool_input: { file_path: 'src/new.ts', content: 'z' } });
      assert.equal(r.code, 2, `THE RULING: ${shape.label} at the latch path DENIES — fail closed on shape, before contents. stderr: ${r.stderr}`);
      assert.match(r.stderr, DENY.latch, `the ${shape.label} denial names the taint latch — stderr: ${r.stderr}`);
      assert.doesNotMatch(
        r.stderr,
        DENY.absentish,
        `AN ABNORMAL LATCH IS NOT AN ABSENT ONE (${shape.label}): wording that reads as "no latch" means the gate took the absent path and the denial came from elsewhere — stderr: ${r.stderr}`
      );
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// AC-G7 — THE EXCEPTION SET IS EMPTY.
//
// The board leaves one door open: "If a graceful agent-exit path must stay
// available, make it a NARROWLY ENUMERATED exception and say so; the simplest
// honest rule is no agent tools while latched." This test pins the DEFAULT: no
// exception is enumerated. Every plausible graceful-wind-down candidate is
// denied.
//
// IF A NARROW EXCEPTION IS EVER DELIBERATELY ADOPTED, this test is the place
// it gets declared: move exactly that tool name into an EXPECTED_EXCEPTIONS
// array with the ruling that authorised it cited beside it, and leave every
// other row denying. What must NOT happen is an exception appearing in the
// implementation while this list quietly stops covering it — an unenumerated
// exception is indistinguishable from a bypass.
//
// EXPECTED FAILURE SHAPE (RED): hook absent — code 1.
//
// SABOTAGE: exempt any one of these names in the gate (the likeliest is
// `agent_exit`, on the reasoning that an agent must be able to report and
// leave) — that row flips to 0 while AC-G2 stays green, because AC-G2's table
// does not contain it.
// ===========================================================================
test.skip('AC-G7: the exception set is EMPTY — no graceful-exit or bookkeeping tool is exempt while latched', () => {
  const EXPECTED_EXCEPTIONS = []; // deliberately empty; populate ONLY with a cited ruling
  const CANDIDATES = [
    'mcp__plugin_sterling_sterling__agent_exit',
    'agent_exit',
    'mcp__plugin_sterling_sterling__handoff_write',
    'mcp__plugin_sterling_sterling__run_signal',
    'ExitPlanMode',
    'KillShell',
    'BashOutput',
    'SlashCommand',
    'TodoWrite',
  ];

  const { dir, cleanup } = makeProject();
  try {
    plantLatch(dir);
    for (const tool of CANDIDATES) {
      const expected = EXPECTED_EXCEPTIONS.includes(tool) ? 0 : 2;
      const r = runGate(dir, { ...AGENT, tool_name: tool, tool_input: {} });
      assert.equal(
        r.code,
        expected,
        expected === 2
          ? `THE RULING: the exception set is EMPTY — ${tool} is denied like everything else. If this tool genuinely needs an exception, add it to EXPECTED_EXCEPTIONS here with the ruling that authorised it, so the exception is enumerated rather than silent. stderr: ${r.stderr}`
          : `${tool} is an ENUMERATED exception and must proceed. stderr: ${r.stderr}`
      );
    }
    assert.deepEqual(
      EXPECTED_EXCEPTIONS,
      [],
      'THE DEFAULT, STATED AS AN ASSERTION so it cannot drift silently: no exception is authorised today. Changing this list is a ruling, not a test repair.'
    );
  } finally {
    cleanup();
  }
});
