// H1 SessionStart — the MACHINE-ACTIVATION guard degrades LOUD (board 4fa477f2).
//
// SPEC ONLY. `scripts/hooks/h1-session-start.mjs` was NOT read to author this file
// (H4 read wall; content-mode Grep over scripts/ was denied too, and deliberately
// not routed around). That matters MORE than usual here: the fix under test and
// the probe this file was derived from were written by the SAME coder dispatch, so
// an oracle anchored to the implementation would certify whatever the fix happens
// to do. The contract below comes from spec surfaces only —
//   * board 4fa477f2 (the defect, measured at HEAD 80fa755, quoting file:line, the
//     required fix shape, the degrade wording, and the silence-control demand),
//   * decision 946125ff (c) — H1 session-start warns BOTH surfaces, fail-open,
//     Sterling projects only, foreign files never judged,
//   * anti_pattern 02a1ed39 — the incident: a machine-context flip left EVERY
//     agent-guarding hook dead while sync-agents said `up_to_date` NINE TIMES,
//   * scripts/tests/agent-currency-h1.test.mjs and scripts/tests/h1-accuracy.test.mjs
//     (prior tests; harness, idiom and the sibling block's contract).
//
// THE DEFECT (board 4fa477f2, ~:1066-1093): the machine-activation guard gated
// enumeration on `existsSync(agentsDir)` and wrapped `readdirSync` PLUS every
// per-file `readFileSync` in ONE outer `catch {}`. Consequences:
//   * a subdirectory named `x.md` (EISDIR), one EACCES file, or a race deletion
//     (ENOENT on a file readdir had just listed) threw out of the loop, the outer
//     catch discarded EVERYTHING, and the dead-hooks warning never rendered — for
//     ANY agent, including the perfectly readable ones. A PARTIAL failure reported
//     as a TOTAL absence.
//   * `existsSync` answers `false` on EACCES, so an UNREADABLE agents directory
//     read as "no agents installed". Absence and inaccessibility were
//     indistinguishable — the subtlest half of the defect, and the easiest for a
//     later tidy-up to undo.
// Both are P5 violations (fail loud, never silent) in the one mechanism whose
// entire purpose is to refuse to be silent about absent enforcement.
//
// THE CONTRACT PINNED HERE is the shape board 4fa477f2 names, already applied to
// the agent-currency block ~20 lines below in the same file (review findings F2
// and F8) — NOT a second invention:
//   (1) enumeration is guarded so ENOENT/ENOTDIR mean ABSENCE while every other
//       errno (EACCES/ELOOP/EIO) is REPORTED;
//   (2) each per-file read is guarded INDIVIDUALLY, so one bad entry cannot
//       suppress the good ones;
//   (3) a file carrying the `sterling-generated` marker but damaged or zero-byte
//       is reported UNKNOWN, never silently reclassified as a foreign hand-made
//       agent;
//   (4) the degrade wording matches /(cannot|could not|can't|unable|unreadable|
//       unknown|missing)/i and NEVER says "up to date" (board 4fa477f2, verbatim);
//   (5) it never blocks — exit 0, parseable JSON, the rest of the banner intact.
//
// ---------------------------------------------------------------------------
// WHY EVERY SILENCE ARM CARRIES A LIVENESS ASSERTION.
//
// `section === ''` is a verdict with MORE THAN ONE possible cause: the guard was
// genuinely silent, OR H1 crashed, OR it emitted no parseable JSON, OR the fixture
// never reached the guard at all. A control that cannot tell those apart is not a
// control — it is a green with no evidence, and it reads exactly like a passing
// test. So every arm asserting silence ALSO asserts that H1's ordinary
// task-count banner clause rendered (2 seeded user todos => /\b2 task/, the
// h1-accuracy.test.mjs idiom). The pair "this specific notice is absent WHILE the
// hook demonstrably ran to completion" has one cause. A bare `assert.equal(section,
// '')` has four.
//
// CONTROL PLACEMENT: each group below opens with an arm that must pass for the
// OPPOSITE reason to the pins beneath it. The silence controls are load-bearing in
// their own right — a guard that shouts every session passes every positive arm in
// this file and then gets ignored, which is precisely how the original
// nine-times-silent incident became invisible.
//
// ---------------------------------------------------------------------------
// RED-BEFORE-THE-FIX IS NOT THE TEST OF WORTH — THE NAMED SABOTAGE IS.
// 5 of the 11 arms here (A1, B1, C0, D0, E0) would ALSO pass against the old
// broken code. They are not filler: each is a control or the positive liveness
// pin, each goes RED under its OWN named sabotage, and without them the six
// red-before arms are satisfiable by an implementation that simply warns about
// everything it sees. Each arm states its status explicitly beneath it.
//
// NO RED OUTPUT IS CLAIMED FROM THIS AUTHOR: the test-writer holds no Bash. These
// were never executed here.
// Run with:  node --test scripts/tests/machine-activation-h1.test.mjs
//
// SOURCE, NOT BUNDLE: like every sibling h1 test, the harness spawns
// scripts/hooks/h1-session-start.mjs directly. It never touches hooks/*.mjs, so
// this file gates the landed SOURCE fix with or without `npm run build:hooks`.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installAgents, renderInstalledAgent } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks'); // the SOURCE hook, not the bundle
const T_INSTALL = '2026-01-01T00:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// --------------------------- harness (h1-accuracy.test.mjs shape) ---------------------------

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type, at = T_INSTALL) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

/** Every fixture project seeds EXACTLY two user todos. That count is the liveness
 *  probe (`assertHookRan` below) — it is what makes a silent notice distinguishable
 *  from a hook that never produced output at all. No system/maintenance items are
 *  seeded, so nothing else can perturb the task-count clause. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-machact-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.create({ ...envelope('todo'), text: 'a standalone task', source: 'user' });
  store.create({ ...envelope('todo'), text: 'another standalone task', source: 'user' });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup, agentsDir: join(dir, '.claude', 'agents') };
}

function h1(dir, pluginRoot, envOverride = {}) {
  const r = runHook(
    'h1-session-start.mjs',
    { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' },
    dir,
    { NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: pluginRoot, ...envOverride }
  );
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts via assertHookRan
  }
  return { ...r, out };
}

const contextOf = (res) => (res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext ?? '' : '');
const messageOf = (res) => (res.out && typeof res.out.systemMessage === 'string' ? res.out.systemMessage : '');

/**
 * THE LIVENESS PROBE — the thing that gives an empty `section` exactly one cause.
 *
 * Asserts H1 ran to completion and produced its ORDINARY output: exit 0, parseable
 * JSON, an advisory (never blocking) envelope, and the normal task-count clause for
 * the two seeded todos. Called by EVERY arm, but load-bearing in the silence arms:
 * "the machine-activation notice is absent" only means something once "the hook
 * reached the end of its banner" is separately established.
 *
 * It doubles as the NEVER-BLOCKS pin of contract item (5): a guard that degrades
 * loud by aborting SessionStart has traded one P5 violation for a worse one.
 */
function assertHookRan(r) {
  assert.equal(r.code, 0, `H1 is a soft hook and must exit 0: ${r.stderr}`);
  assert.ok(r.out, `H1 must emit parseable JSON: ${r.stdout}${r.stderr}`);
  assert.notEqual(r.out.continue, false, 'the machine-activation guard warns; it never halts the session');
  assert.doesNotMatch(JSON.stringify(r.out), /"(decision|permissionDecision)"\s*:\s*"(block|deny)"/, 'advisory only — it never denies');
  assert.match(
    messageOf(r),
    /\b2 task/,
    'LIVENESS: H1 reached its normal task-count clause. Without this, an empty machine-activation section is indistinguishable from a hook that crashed, emitted no JSON, or short-circuited before the guard ever ran.'
  );
}

/** The machine-activation notice: one blank-line-delimited block. The marker token
 *  is the pre-existing surface of decision 946125ff (c) — this file LOCATES the
 *  notice by it and asserts nothing about the prose around it beyond the contract's
 *  degrade wording, so a reword of the notice does not break these pins. */
function driftSection(text) {
  if (!text) return '';
  const i = text.search(/MACHINE-CONTEXT DRIFT/i);
  if (i === -1) return '';
  const rest = text.slice(i);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}
const lineFor = (section, name) => section.split('\n').find((l) => l.includes(name)) ?? '';

/** Board 4fa477f2, verbatim: "reuse its degrade wording, which must match
 *  /(cannot|could not|can't|unable|unreadable|unknown|missing)/i and must never say
 *  'up to date'". This regex is SPEC, not a transcription of the implementation. */
const DEGRADED = /(cannot|could not|can't|unable|unreadable|unknown|missing)/i;
const CLAIMS_CURRENT = /up[-_ ]to[-_ ]date/i;

/** The human surface. Deliberately BROAD: decision 946125ff (c) fixes that both
 *  surfaces are warned, not the sentence either one uses. The positive arm's match
 *  and the control arms' doesNotMatch use the SAME regex, so the pair is symmetric
 *  and a reword moves both together instead of producing a one-sided false red. */
const HUMAN_NOTICE = /machine[ -]context/i;

// --------------------------- synthetic clone ---------------------------

const TPL = (name, body) => `---
name: ${name}
description: Fixture agent for the machine-activation tests.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '{{NODE}} "{{HOOKS_DIR}}/h.mjs"'
---

${body}
`;

function makeClone(names) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-clone-'));
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  const agents = [];
  for (const name of names) {
    writeFileSync(join(templatesDir, `${name}.md`), TPL(name, `Fixture body for ${name}.`));
    agents.push({ name, file: `${name}.md` });
  }
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents }, null, 2));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sterling-fixture-clone', version: '0.0.0-fixture' }));
  const hooksDir = join(dir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'h.mjs'), '// resolvable hook fixture\n');
  return {
    dir,
    templatesDir,
    registryPath,
    // RESOLVABLE machine vars: this machine's real node + a real hook file, so the
    // guard under test has nothing to report unless the fixture makes it so.
    vars: { NODE: `"${process.execPath.replace(/\\/g, '/')}"`, HOOKS_DIR: hooksDir.replace(/\\/g, '/') },
    // A machine-context flip: neither path exists here (anti_pattern 02a1ed39).
    deadVars: { NODE: '"/other-context/bin/node"', HOOKS_DIR: '/other-context/hooks' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const installInto = (clone, agentsDir) =>
  installAgents({
    templatesDir: clone.templatesDir,
    registryPath: clone.registryPath,
    targetAgentsDir: agentsDir,
    pluginVersion: '0.1.0',
    now: T_INSTALL,
    vars: clone.vars,
  });

/** Re-bakes one already-installed agent for ANOTHER machine context. The header
 *  stays self-consistent (template_hash current, content_hash matching its own
 *  body), so the neighbouring AGENT CURRENCY check stays silent about it and can
 *  never be mistaken for the notice under test. */
function flipToOtherMachine(clone, agentsDir, name) {
  const template = readFileSync(join(clone.templatesDir, `${name}.md`), 'utf8');
  const flipped = renderInstalledAgent(template, `${name}.md`, {
    pluginVersion: '0.1.0',
    now: T_INSTALL,
    vars: clone.deadVars,
  }).installedContent;
  writeFileSync(join(agentsDir, `${name}.md`), flipped);
}

/** chmod is advisory-to-absent as root and on some mounts. Probe rather than let a
 *  permission arm pass vacuously — a green that proves nothing is the exact failure
 *  this whole file exists to prevent. */
function chmodDenialWorks() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-chmod-probe-'));
  const f = join(d, 'probe.txt');
  try {
    writeFileSync(f, 'probe');
    chmodSync(f, 0o000);
    try {
      readFileSync(f, 'utf8');
      return false; // read succeeded despite mode 000 — probably root
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(f, 0o644);
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
}

/** Dangling symlinks need no privilege on POSIX and need Developer Mode on
 *  Windows. Probe and skip LOUDLY rather than pass vacuously. */
function symlinkWorks() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-symlink-probe-'));
  try {
    symlinkSync(join(d, 'absent-target'), join(d, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** A truncated sterling-generated install: the MARKER says the file is OURS, but
 *  nothing can be parsed out of the header. "Damaged" and "not ours" are different
 *  verdicts, and collapsing them retires the file from this check forever. */
const DAMAGED_INSTALL = `---
name: test-writer
description: Fixture agent for the machine-activation tests.
---
<!-- sterling-generated v=0.11.4 template=test-writer template_hash=deadbe

Body was truncated by a bad copy.
`;

// =============================================================================
// GROUP A — THE SILENCE CONTROL. PLACED FIRST IN THE FILE, and required by every
// positive arm below it.
//
// This arm must pass for the OPPOSITE reason to every "the notice fires" pin:
// identical harness, identical invocation, a fully readable and correctly-baked
// agent set, and NOTHING reported. Strip it and every remaining arm in this file
// is satisfied by an implementation that emits the notice unconditionally — which
// is worse than the bug, because a banner that fires every session is a banner
// nobody reads (P1), and that is how the nine-times-silent incident of
// anti_pattern 02a1ed39 stayed invisible.
// =============================================================================

test('A1 CONTROL: a fully readable, correctly-baked agent set produces NO machine-activation output on either surface', () => {
  const clone = makeClone(['coder', 'test-writer', 'librarian']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    assert.equal(driftSection(contextOf(r)), '', 'a healthy machine gets NO conductor notice — and the liveness assertion above proves the hook ran to say so');
    assert.doesNotMatch(messageOf(r), HUMAN_NOTICE, 'and nothing for the human either');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: GREEN before the fix AND after. That is correct and expected — this arm
// pins the direction the fix must NOT break, not the fix itself.
// SABOTAGE (one line): drop the `if (dead.length || unknown.length)` emit guard so
// the notice renders unconditionally — both assertions flip, caught. This is the
// ONLY arm in the file that catches a warn-on-everything implementation; every
// other arm here stays green under it.

// =============================================================================
// GROUP B — THE POSITIVE ARM. Pairs with A1: neither carries the verdict alone.
// A1 green + B1 green together mean "the check runs AND discriminates". A1 alone
// is satisfied by a check that was deleted.
// =============================================================================

test('B1 POSITIVE: an agent baked for ANOTHER machine context is reported on BOTH surfaces, naming only the offender', () => {
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    flipToOtherMachine(clone, agentsDir, 'coder');

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'a dead-baked agent is reported to the conductor (decision 946125ff (c))');
    assert.notEqual(lineFor(section, 'coder'), '', 'the offending agent is NAMED — "some agents are dead" is not actionable');
    assert.equal(lineFor(section, 'test-writer'), '', 'the healthy agent is NOT listed — the notice reports exceptions, not the roster');
    assert.match(messageOf(r), HUMAN_NOTICE, 'the human is warned too — 946125ff (c) fixes BOTH surfaces');
    assert.doesNotMatch(section, CLAIMS_CURRENT, 'nothing here is claimed up to date');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: GREEN before the fix AND after — it pins the pre-existing guard the fix
// must preserve, and it is what makes A1's silence meaningful.
// SABOTAGE (one line): `const dead = [];` — never populate the dead list. The
// notice vanishes and the first notEqual fires, caught. Narrower sabotage: print
// only a count with no names — lineFor('coder') returns '' and the second
// assertion fires. Narrower still: emit to additionalContext only — the
// HUMAN_NOTICE match fires.

// =============================================================================
// GROUP C — ENUMERATION: ABSENCE vs INACCESSIBILITY.
//
// This is the subtlest half of board 4fa477f2 and the easiest for a later refactor
// to undo, because the wrong behaviour LOOKS like the right one at the surface the
// human reads: `existsSync` answers `false` on EACCES, so an unreadable directory
// reported as "no agents installed". The two arms below are ONE PAIR and must be
// read together — C0 says ENOENT is absence and stays silent; C1 says EACCES is
// NOT absence and must speak. Either arm alone is satisfiable by a constant:
// keep only C0 and "never report anything" passes; keep only C1 and "report every
// enumeration error" passes. Only the pair pins the DISCRIMINATION.
// =============================================================================

test('C0 CONTROL: no .claude/agents directory at all is ABSENCE (ENOENT), not a degraded probe — H1 stays silent', () => {
  const clone = makeClone(['coder']);
  const { dir, cleanup } = makeProject(); // agentsDir is never created
  try {
    const r = h1(dir, clone.dir);
    assertHookRan(r);

    assert.equal(driftSection(contextOf(r)), '', 'a project with no installed agents has nothing to report — ENOENT is absence, and the liveness assertion proves the hook ran');
    assert.doesNotMatch(messageOf(r), HUMAN_NOTICE, 'and the human is not warned about a directory that was never supposed to exist');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: GREEN before the fix AND after.
// SABOTAGE (one line): report EVERY enumeration error as UNKNOWN — i.e. delete the
// `code === 'ENOENT' || code === 'ENOTDIR'` arm and fall through to the report
// branch. Every agent-less project then gets a warning, both assertions flip,
// caught. This arm is what stops C1 below being satisfied by "always warn".

test('C1: the agents directory itself cannot be ENUMERATED (EACCES) — activation is UNKNOWN, never silence', (t) => {
  if (!chmodDenialWorks()) {
    t.skip('mode 000 does not deny reads on this host (root, or a mount without POSIX modes) — the EACCES branch is unreachable here');
    return;
  }
  const clone = makeClone(['coder']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    chmodSync(agentsDir, 0o000); // readdirSync -> EACCES; existsSync() answered `false` to exactly this

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'COULD NOT LOOK is not the same as NOTHING TO SEE — the whole point of board 4fa477f2');
    assert.match(section, DEGRADED, 'the notice states the degraded condition in the contract wording');
    assert.match(section, /\.claude[\\/]agents/, 'and NAMES what could not be enumerated — a degrade message that does not say what failed is not actionable');
    assert.doesNotMatch(section, CLAIMS_CURRENT, 'a check that could not run never certifies anything up to date (02a1ed39: nine consecutive up_to_date lies)');
  } finally {
    try {
      chmodSync(agentsDir, 0o755);
    } catch {
      /* best effort — the rmSync below needs this to succeed */
    }
    cleanup();
    clone.cleanup();
  }
});
// STATUS: RED before the fix (all four assertions unreachable — `section` was '',
// the first notEqual fired), GREEN after.
// SABOTAGE (one line): put `if (!existsSync(agentsDir)) return;` back ahead of the
// enumeration — the ORIGINAL shape. existsSync answers false on EACCES, the guard
// returns silently, `section` becomes '' and the first notEqual fires, caught.
// Alternative one-liner, same red: widen the absence arm to `catch { return; }`.

// =============================================================================
// GROUP D — THE PER-FILE GUARD: one bad entry must not silence the whole sweep.
//
// D0 is the control and it closes a hole the other three cannot: D1-D3 all assert
// that an unreadable ENTRY is REPORTED, and that assertion is satisfied by an
// implementation that simply lists every directory entry it does not recognise.
// D0 puts a perfectly READABLE non-agent file in the same directory while the
// notice IS firing, and requires it to be left alone — so a green across the group
// means "unreadable entries are reported BECAUSE they could not be read", not
// "everything in the directory gets listed".
// =============================================================================

test('D0 CONTROL: a READABLE non-agent file in .claude/agents is not swept into a firing notice', () => {
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    flipToOtherMachine(clone, agentsDir, 'coder'); // guarantees the notice fires
    writeFileSync(join(agentsDir, 'NOTES.md'), '# scratch notes kept next to the agents\n');

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'the notice fires for the dead-baked agent');
    assert.notEqual(lineFor(section, 'coder'), '', 'and names it');
    assert.equal(
      lineFor(section, 'NOTES.md'),
      '',
      'a file that WAS read and simply is not ours is not listed — otherwise D1/D2/D3 below are satisfied by an implementation that reports every directory entry, and "reported because unreadable" becomes unprovable'
    );
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: GREEN before the fix AND after (nothing throws in this fixture).
// SABOTAGE (one line): report every enumerated entry whose header did not parse as
// UNKNOWN, instead of only those that could not be READ or that carry the
// sterling-generated marker — NOTES.md appears in the section and the third
// assertion flips, caught.

test('D1: an EISDIR entry (a subdirectory named x.md) does NOT silence the report for the agents that WERE readable', () => {
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    flipToOtherMachine(clone, agentsDir, 'coder');
    flipToOtherMachine(clone, agentsDir, 'test-writer');
    mkdirSync(join(agentsDir, 'broken.md'), { recursive: true }); // readFileSync -> EISDIR

    const r = h1(dir, clone.dir);
    assertHookRan(r); // also pins that an EISDIR never aborts SessionStart

    const section = driftSection(contextOf(r));

    // HALF ONE — the swallow. This is the finding.
    assert.notEqual(section, '', 'ONE unreadable entry must not swallow the whole notice — that is the 02a1ed39 shape exactly');
    assert.notEqual(lineFor(section, 'coder'), '', 'the first dead-baked agent is STILL named');
    assert.notEqual(lineFor(section, 'test-writer'), '', 'and so is the second');

    // HALF TWO — the classification. An entry that could not be READ is not the
    // same as an entry that was read and found foreign (D0 proves the difference
    // is observable), so it cannot be silently dropped.
    const badLine = lineFor(section, 'broken.md');
    assert.notEqual(badLine, '', 'the unreadable entry is REPORTED, not dropped — a failed read is not a healthy agent');
    assert.match(badLine, DEGRADED, 'and its activation is stated as UNKNOWN');
    assert.doesNotMatch(section, CLAIMS_CURRENT, 'nothing here is claimed up to date');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: RED before the fix (`section` was '', both halves fired), GREEN after.
// SABOTAGE (one line, and it is the defect itself): put the enumeration and the
// per-file reads back under a SINGLE outer `try { ... } catch {}` — the EISDIR
// escapes the per-file guard, the whole block is abandoned, `section` becomes ''
// and BOTH halves fire, caught twice.
// THE TWO HALVES ARE DELIBERATELY SEPARATE, and which one goes red is the
// diagnosis: a red confined to `badLine` means the per-file guard survives but
// mis-classifies; a red on the two agent lines means one bad entry still costs the
// whole report, i.e. the finding regressed.

test('D2: an EACCES agent file is reported UNKNOWN while the readable dead-baked agent is still named', (t) => {
  if (!chmodDenialWorks()) {
    t.skip('mode 000 does not deny reads on this host (root, or a mount without POSIX modes) — the EACCES branch is unreachable here');
    return;
  }
  const clone = makeClone(['coder', 'librarian']);
  const { dir, cleanup, agentsDir } = makeProject();
  const locked = join(agentsDir, 'librarian.md');
  try {
    installInto(clone, agentsDir);
    flipToOtherMachine(clone, agentsDir, 'coder');
    chmodSync(locked, 0o000); // EACCES on the FILE, not the directory — distinct from C1

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'the notice survives an unreadable sibling');
    assert.notEqual(lineFor(section, 'coder'), '', 'the readable dead-baked agent is STILL named');
    assert.match(lineFor(section, 'librarian'), DEGRADED, 'the locked file is reported with UNKNOWN activation — EACCES is not absence');
    assert.doesNotMatch(section, CLAIMS_CURRENT, 'nothing here is claimed up to date');
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* best effort — rmSync force follows */
    }
    cleanup();
    clone.cleanup();
  }
});
// STATUS: RED before the fix (`section` was ''), GREEN after.
// SABOTAGE (one line): the same single-outer-catch restoration — `section` becomes
// '', caught. NOT redundant with C1: that arm's EACCES is on the DIRECTORY and its
// guard is the enumeration try/catch; this one's is on a FILE and its guard is the
// per-read try/catch. Board 4fa477f2 names them as two separate properties of the
// fix, and a partial repair fixing only one is a real and likely outcome — if only
// one of C1/D2 goes red under a mutation, exactly one of the two guards is live.

test('D3: a RACE DELETION (ENOENT on a file readdir just listed) does not silence the sweep', (t) => {
  if (!symlinkWorks()) {
    t.skip('symlink creation is unavailable on this host (Windows without Developer Mode) — the dangling-entry fixture is unbuildable here');
    return;
  }
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    flipToOtherMachine(clone, agentsDir, 'coder');
    flipToOtherMachine(clone, agentsDir, 'test-writer');
    // A dangling symlink is a deterministic stand-in for the race board 4fa477f2
    // names: readdirSync lists `ghost.md`, readFileSync on it throws ENOENT.
    symlinkSync(join(agentsDir, 'target-that-was-deleted.md'), join(agentsDir, 'ghost.md'));

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'a file that vanished mid-sweep must not cost the entire report');
    assert.notEqual(lineFor(section, 'coder'), '', 'the first dead-baked agent is STILL named');
    assert.notEqual(lineFor(section, 'test-writer'), '', 'and so is the second');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: RED before the fix (the ENOENT escaped the outer catch and `section` was
// ''), GREEN after.
// SABOTAGE (one line): the same single-outer-catch restoration — caught.
// DELIBERATELY NOT ASSERTED: how `ghost.md` itself is classified. A file that was
// listed and then found gone is defensibly ABSENCE (it is genuinely no longer
// there) and defensibly UNKNOWN (we never read it) — board 4fa477f2 does not
// settle it, and asserting either would pin my guess rather than the contract. The
// half that IS contract, unambiguously, is that the survivors are still reported.
// An implementation that skips a `withFileTypes` non-regular entry before ever
// reading it also passes this arm, and correctly so.

// =============================================================================
// GROUP E — DAMAGED vs FOREIGN: unparseable is not the same as not-ours.
//
// E0 is the control and must pass for the OPPOSITE reason to E1/E2: a genuinely
// hand-written agent, READ successfully, carrying no sterling-generated marker, is
// none of Sterling's business and produces silence. Without it, E1/E2 are
// satisfied by "warn about anything unrecognised" — the same warn-on-everything
// failure A1 exists to prevent, arriving through a different door.
// =============================================================================

test('E0 CONTROL: a genuinely FOREIGN hand-made agent is not Sterling\'s to judge — H1 stays silent', () => {
  const clone = makeClone(['coder']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    // A hand-written agent whose hook command points at a dead path: if the guard
    // judged files it does not own, THIS is what it would shout about.
    writeFileSync(join(agentsDir, 'hand-made.md'), "---\nname: hand-made\n---\ncommand: '\"/other-context/bin/node\" \"/x/h.mjs\"'\n");

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    assert.equal(driftSection(contextOf(r)), '', 'a hand-written agent with no generated marker is never judged (decision 946125ff (c): foreign files never judged)');
    assert.doesNotMatch(messageOf(r), HUMAN_NOTICE, 'and nothing for the human either');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: GREEN before the fix AND after.
// SABOTAGE (one line): report every file whose header does not parse as UNKNOWN
// (drop the marker test) — the foreign file is reported, both assertions flip,
// caught. The dead-path hook command in the fixture is deliberate: it makes this
// arm ALSO catch a guard that judges foreign files on their content rather than on
// ownership.

test('E1: a file carrying the sterling-generated marker but DAMAGED is UNKNOWN, never silently foreign', () => {
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    writeFileSync(join(agentsDir, 'test-writer.md'), DAMAGED_INSTALL); // marker present, header truncated

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'a damaged OURS file is reported — reclassifying it as foreign retires it from this check forever, silently and permanently');
    assert.match(lineFor(section, 'test-writer'), DEGRADED, 'its activation is UNKNOWN — not "fine", and not "someone else\'s"');
    assert.doesNotMatch(section, CLAIMS_CURRENT, 'never up-to-date from a header that could not be parsed');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: RED before the fix (`section` was ''), GREEN after.
// SABOTAGE (one line): restore the bare `if (!parseInstalledHeader(content)) continue;`
// ahead of the classification — the damaged file drops out of the set entirely,
// `section` becomes '' and the first notEqual fires, caught. E0 above is the
// control that keeps this pin from being satisfied by warn-on-everything.

test('E2: a ZERO-BYTE file at a roster agent path is UNKNOWN, not silently foreign', () => {
  const clone = makeClone(['coder', 'test-writer']);
  const { dir, cleanup, agentsDir } = makeProject();
  try {
    installInto(clone, agentsDir);
    writeFileSync(join(agentsDir, 'test-writer.md'), ''); // truncated to nothing by a failed write

    const r = h1(dir, clone.dir);
    assertHookRan(r);

    const section = driftSection(contextOf(r));
    assert.notEqual(section, '', 'a zero-byte file at a ROSTER path is a damaged install, not a user\'s hand-written agent');
    assert.match(lineFor(section, 'test-writer'), DEGRADED, 'reported with its activation UNKNOWN');
  } finally {
    cleanup();
    clone.cleanup();
  }
});
// STATUS: expected RED before the fix, GREEN after — but FLAGGED to the conductor
// as the one arm here whose greenness is least certain, and pinned SEPARATELY from
// E1 for exactly that reason. A zero-byte file CANNOT carry the sterling-generated
// marker, so classifying it as ours requires the roster (or the filename) as the
// authority rather than the marker, and an implementation could defensibly route it
// down the foreign path instead. If E2 alone goes red, the disagreement is about
// the zero-byte classification and NOT about E1's damaged-marker property or the
// swallow finding — treat it as a spec question for the conductor, not a bug.
// SABOTAGE (one line): the same `if (!parseInstalledHeader(content)) continue;`
// restoration — the empty file disappears from the set, `section` becomes '',
// caught.
